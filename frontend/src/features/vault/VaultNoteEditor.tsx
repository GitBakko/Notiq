import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bell, LockOpen, Star, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import Editor from '../../components/editor/Editor';
import TagSelector from '../../components/editor/TagSelector';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { permanentlyDeleteNote, updateNote, type Note } from '../notes/noteService';
import { db } from '../../lib/db';
import { queryKeys } from '../../lib/queryKeys';
import { withNoteLock } from '../../lib/vaultNoteLock';
import { hydrateVaultNote } from '../../lib/vaultReconcile';
import { decryptItem, encryptItem, type VaultCodecCtx } from '../../lib/vaultCodec';
import { moveOut, VaultMoveError } from '../../lib/vaultMove';
import { useVaultStore } from '../../store/vaultStore';
import { useAuthStore } from '../../store/authStore';
import { ENVELOPE_RE } from '../../utils/vaultCrypto';
import { stripRemoteImagesFromContent } from '../../components/editor/extensions/remoteImages';
import VaultNotLoaded from './VaultNotLoaded';

// Vault v3 (T18, plan 5.6/5.9): editor delle note vault. Niente noteId/provider/collaboration: per costruzione niente
// condivisione, AI, versioni, allegati. Tiene il lock `shared` della nota finche' e' montato (il reconcile e la pull, che lo
// chiedono exclusive con ifAvailable, non toccano la riga aperta). Dexie e syncQueue ricevono solo envelope.

const SAVE_DEBOUNCE_MS = 1000;
const MAX_ENVELOPE_CHARS = 2 * 1024 * 1024;

type Phase =
  | { k: 'loading' }
  | { k: 'unavailable' }
  | { k: 'gone' }
  | { k: 'ready'; title: string; body: string }
  | { k: 'legacy'; title: string; body: string; docOk: boolean };

const isDoc = (s: string) => {
  try {
    return (JSON.parse(s) as { type?: string } | null)?.type === 'doc';
  } catch {
    return false;
  }
};

interface Props {
  note: Note;
  onBack?: () => void;
  /** Chiamata una volta alla chiusura, dopo l'ultimo salvataggio locale e il rilascio del lock (trigger T-c del reconcile). */
  onReleased?: () => void;
}

export default function VaultNoteEditor({ note, onBack, onReleased }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const id = note.id;
  // `t` fuori dalle dipendenze: un cambio di lingua non deve rilanciare il lock e il caricamento.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const onReleasedRef = useRef(onReleased);
  useEffect(() => { onReleasedRef.current = onReleased; }, [onReleased]);

  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [movingOut, setMovingOut] = useState(false); // PUT di moveOut in volo: editor e titolo non modificabili (il testo digitato ora andrebbe perso)
  const reminderRef = useRef<HTMLInputElement>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // Stato di salvataggio fuori dal render: il flusher pre-lock e il cleanup lo leggono senza chiusure vecchie.
  const latest = useRef({ title: '', body: '' });
  const dirty = useRef(false);
  const moving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const movePromise = useRef<Promise<void> | null>(null); // moveOut in corso (mai rifiuta)

  // Salvataggi serializzati. `ctx` solo dal flusher pre-lock (chiavi catturate: lo store e' gia' azzerato).
  const flush = useCallback((ctx?: VaultCodecCtx): Promise<void> => {
    clearTimeout(timer.current);
    chain.current = chain.current.then(async () => {
      if (!dirty.current || moving.current) return;
      // utente risolto PRIMA di cifrare: un logout durante encryptItem lascerebbe authStore a null e l'item in coda con userId 'current-user'
      const userId = ctx?.userId ?? useAuthStore.getState().user?.id;
      if (!userId) return;
      dirty.current = false;
      const { title: tt, body: c } = latest.current;
      try {
        const env = await encryptItem(id, 'NOTE', { t: tt, c }, ctx);
        if (env.length > MAX_ENVELOPE_CHARS) {
          toast.error(tRef.current('vault.tooLarge'));
          return;
        }
        // locale (Dexie + coda): mai via REST. Col contesto catturato (logout) l'utente della coda e' quello del ctx, non authStore (gia' null).
        await updateNote(id, { content: env }, { userId });
      } catch (e) {
        dirty.current = true; // il prossimo cambio, l'unmount o il flusher ritentano
        console.error('[vault] save failed', e);
        if ((e as Error)?.name !== 'VaultLockedError') toast.error(tRef.current('notes.saveFailed'));
      }
    });
    return chain.current;
  }, [id]);

  const schedule = useCallback(() => {
    dirty.current = true;
    useVaultStore.getState().touchVault();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Dichiarato PRIMA dell'effetto del lock: il suo cleanup gira per primo e distingue smontaggio da re-run (attempt/flush).
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Lock shared per tutto il tempo in cui l'editor e' montato; dentro: idratazione, lettura Dexie, decifratura.
  useEffect(() => {
    let cancelled = false;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const load = async () => {
      if (cancelled) return;
      try {
        await hydrateVaultNote(id).catch(() => false); // offline o errore di rete: si apre la copia locale
        const row = await db.notes.get(id);
        if (cancelled) return;
        if (!row) setPhase({ k: 'gone' });
        else if (!row.content) setPhase({ k: 'unavailable' });
        else if (!ENVELOPE_RE.test(row.content)) {
          // sola lettura: l'editor riceve il contenuto senza immagini remote (render sotto); qui solo l'avviso
          if (stripRemoteImagesFromContent(row.content).removed) toast(tRef.current('vault.remoteImagesHidden'));
          setPhase({ k: 'legacy', title: row.title ?? '', body: row.content, docOk: isDoc(row.content) });
        } else {
          const dec = await decryptItem(id, 'NOTE', row.content);
          if (cancelled) return;
          // F.13: nessuna risorsa remota in una nota vault; le immagini sparite dal salvataggio in poi (o dall'uscita dal vault)
          const { content: c, removed } = stripRemoteImagesFromContent(dec.c);
          const tt = dec.t;
          if (removed) toast(tRef.current('vault.remoteImagesHidden'));
          latest.current = { title: tt, body: c };
          dirty.current = false;
          setTitle(tt);
          setBody(c);
          setPhase({ k: 'ready', title: tt, body: c });
        }
      } catch (e) {
        // errore Dexie/decifratura: senza questo la fase resta 'loading' per sempre e il flusher non si registra
        console.error('[vault] load failed', e);
        if (!cancelled) setPhase({ k: 'unavailable' });
      }
      await held;
    };
    const lockDone = (async () => {
      const r = await withNoteLock(id, load, { mode: 'shared' });
      if (r.status === 'nolocks') await load(); // senza Web Locks si apre comunque (nessuna esclusione fra schede)
    })().catch((e) => console.error('[vault] editor load failed', e));
    return () => {
      cancelled = true;
      // l'ultimo salvataggio pendente parte mentre il lock e' ancora tenuto
      const flushed = flush().finally(release);
      // onReleased solo a salvataggio e lock finiti (anche se la richiesta del lock e' fallita)
      // la chiusura e' lo smontaggio (key={id}): un re-run per Riprova/flush non e' una chiusura
      const fire = () => { if (!mounted.current) onReleasedRef.current?.(); };
      void Promise.all([flushed, lockDone]).then(fire, fire);
    };
  }, [id, attempt, flush]);

  // Prima del lock del vault: l'ultimo envelope va in locale con le chiavi catturate (mai REST: al logout il token non c'e').
  const ready = phase.k === 'ready';
  useEffect(() => {
    if (!ready) return;
    // con uno spostamento in corso flush() non scrive: si aspetta l'esito e, se e' fallito, le modifiche vanno in locale ora
    return useVaultStore.getState().registerPreLock(async (ctx) => { await movePromise.current; await flush(ctx); });
  }, [ready, flush]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const back = () => { if (onBack) onBack(); else window.history.back(); };
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.notes.all });

  const patch = async (data: Partial<Note>): Promise<boolean> => {
    let ok = true;
    try {
      await updateNote(id, data);
    } catch (e) {
      ok = false;
      console.error(e);
      toast.error(t('notes.saveFailed'));
    }
    useVaultStore.getState().touchVault();
    return ok;
  };

  const togglePin = async () => {
    if (await patch({ isPinned: !note.isPinned })) toast.success(!note.isPinned ? t('notes.pinned') : t('notes.unpinned'));
  };

  const confirmDelete = async () => {
    clearTimeout(timer.current);
    dirty.current = false;
    moving.current = true; // nessun salvataggio dopo la cancellazione
    await chain.current;
    try {
      await permanentlyDeleteNote(id);
    } catch (e) {
      console.error(e);
      moving.current = false;
      toast.error(t('notes.saveFailed'));
      return;
    }
    toast.success(t('vault.deletedPermanently'));
    back();
  };

  const confirmExit = async () => {
    // il plaintext viaggia solo in memoria -> PUT diretta. Durante lo spostamento nessun salvataggio locale (riscriverebbe l'envelope).
    clearTimeout(timer.current);
    moving.current = true;
    setMovingOut(true);
    await chain.current;
    const plain = phase.k === 'ready'
      ? { title: latest.current.title, content: latest.current.body }
      : phase.k === 'legacy' && phase.docOk ? { title: phase.title, content: phase.body } : null;
    if (!plain) { moving.current = false; setMovingOut(false); return; }
    const run = moveOut(id, { ...plain, onCommitted: () => { back(); void invalidate(); void queryClient.invalidateQueries({ queryKey: queryKeys.notes.detail(id) }); } });
    movePromise.current = run.then(() => undefined, () => undefined);
    try {
      await run;
      toast.success(t('notes.removedFromVault'));
    } catch (e) {
      moving.current = false;
      setMovingOut(false);
      const code = e instanceof VaultMoveError ? e.code : 'failed';
      if (code === 'conflict') {
        // base locale vecchia: le modifiche vanno in locale (envelope), poi si chiude l'editor; a lock shared rilasciato
        // il reconcile riallinea la base e l'utente ritenta
        await flush();
        back();
        void invalidate();
      } else if (dirty.current) schedule();
      toast.error(t(`vault.moveOut.${code}`));
    }
  };

  if (phase.k === 'loading') return <VaultNotLoaded loading onBack={onBack} />;
  if (phase.k === 'gone') return <VaultNotLoaded gone onBack={onBack} />;
  if (phase.k === 'unavailable') {
    return <VaultNotLoaded onBack={onBack} onRetry={() => { setPhase({ k: 'loading' }); setAttempt((a) => a + 1); }} />;
  }

  const editable = ready && !movingOut;
  const shownTitle = ready ? title : phase.title;
  const canExit = ready || phase.docOk;
  const btn = 'p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full transition-colors';

  return (
    <div
      className="flex flex-col h-full bg-white dark:bg-neutral-900 relative"
      // un file lasciato fuori dall'editor (header, sola lettura) farebbe navigare il browser verso il file
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return;
        // editor modificabile: se ImageDrop ha gia' bloccato il drop ha gia' avvisato. Non modificabile (moveOut, legacy): blocca in silenzio, qui l'avviso
        if (editable && e.defaultPrevented) return;
        e.preventDefault();
        toast.error(t('vault.imagesBlocked'), { id: 'vault.imagesBlocked' });
      }}
    >
      <header className="flex flex-col md:flex-row md:items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-neutral-800/40 bg-white dark:bg-neutral-900 z-20">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <button onClick={back} className={clsx(btn, 'hover:bg-neutral-100 dark:hover:bg-neutral-800 flex-shrink-0')} aria-label={t('common.back')}>
            <ArrowLeft className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
          </button>
          <input
            type="text"
            value={shownTitle}
            onChange={(e) => {
              if (!editable || e.target.value === latest.current.title) return;
              setTitle(e.target.value);
              latest.current.title = e.target.value;
              schedule();
            }}
            readOnly={!editable}
            placeholder={t('notes.titlePlaceholder')}
            aria-label={t('notes.titlePlaceholder')}
            className={clsx('text-xl font-semibold bg-transparent border-none focus:outline-none text-neutral-900 dark:text-white flex-1 min-w-0', !editable && 'cursor-default')}
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap flex-shrink-0">
          {editable && (
            <TagSelector noteId={id} noteTags={note.tags || []} onUpdate={() => void invalidate()} isVault />
          )}
          {editable && (
            <div className="relative">
              <button
                onClick={() => reminderRef.current?.showPicker()}
                title={note.reminderDate ? t('notes.editReminder') : t('notes.addReminder')}
                aria-label={note.reminderDate ? t('notes.editReminder') : t('notes.addReminder')}
                className={clsx(btn, note.reminderDate ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20' : 'text-neutral-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20')}
              >
                <Bell className={clsx('w-5 h-5', note.reminderDate && 'fill-current')} />
              </button>
              {note.reminderDate && (
                <button
                  onClick={() => void patch({ reminderDate: null, isReminderDone: false })}
                  className="group absolute -top-4 -right-4 z-10 min-h-[44px] min-w-[44px] flex items-center justify-center"
                  title={t('notes.removeReminder')}
                  aria-label={t('notes.removeReminder')}
                >
                  <span className="w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center group-hover:bg-red-600 transition-colors">
                    <X size={10} />
                  </span>
                </button>
              )}
              <input
                ref={reminderRef}
                type="datetime-local"
                value={note.reminderDate ? new Date(note.reminderDate).toISOString().slice(0, 16) : ''}
                onChange={(e) => { if (e.target.value) void patch({ reminderDate: new Date(e.target.value).toISOString(), isReminderDone: false }); }}
                className="absolute opacity-0 w-0 h-0 overflow-hidden"
                tabIndex={-1}
                aria-hidden="true"
              />
            </div>
          )}
          {editable && (
            <button
              onClick={() => void togglePin()}
              title={note.isPinned ? t('notes.unpin') : t('notes.pin')}
              aria-label={note.isPinned ? t('notes.unpin') : t('notes.pin')}
              className={clsx(btn, note.isPinned ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20' : 'text-neutral-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20')}
            >
              <Star className={clsx('w-5 h-5', note.isPinned && 'fill-current')} />
            </button>
          )}
          {canExit && (
            <button
              onClick={() => setExitOpen(true)}
              disabled={!online}
              title={online ? t('notes.removeFromVault') : t('vault.moveOut.offline')}
              aria-label={t('notes.removeFromVault')}
              className={clsx(btn, 'text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-neutral-400')}
            >
              <LockOpen className="w-5 h-5" />
            </button>
          )}
          {editable && (
            <button
              onClick={() => setDeleteOpen(true)}
              title={t('common.delete')}
              aria-label={t('common.delete')}
              className={clsx(btn, 'text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20')}
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {!ready && (
        <div role="status" className="px-4 py-2 text-sm bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300 border-b border-amber-200 dark:border-amber-800/40">
          {t(phase.docOk ? 'vault.legacyReadOnly' : 'vault.legacyUnreadable')}
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
        {(ready || phase.docOk) && (
          <Editor
            content={ready ? body : stripRemoteImagesFromContent(phase.body).content}
            onChange={(c) => {
              // l'editor riemette onChange(content) al mount e a ogni setEditable: senza modifica vera niente PUT (difetto 2.1)
              if (!editable || c === latest.current.body) return;
              setBody(c);
              latest.current.body = c;
              schedule();
            }}
            editable={editable}
            isVault
          />
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void confirmDelete()}
        title={t('vault.deletePermanently')}
        message={t('vault.deletePermanentlyConfirm')}
        confirmText={t('common.deleteForever')}
        variant="danger"
      />
      <ConfirmDialog
        isOpen={exitOpen}
        onClose={() => setExitOpen(false)}
        onConfirm={() => void confirmExit()}
        title={t('vault.exitTitle')}
        message={t('vault.exitMessage')}
        confirmText={t('common.confirm')}
        variant="danger"
      />
    </div>
  );
}
