import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Search, Menu, Plus, Lock, KeyRound, PanelLeftClose, PanelLeftOpen, ChevronsLeft, Settings, ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import SortDropdown from '../../components/ui/SortDropdown';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useNotebooks } from '../../hooks/useNotebooks';
import { useUIStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { useAuthStore } from '../../store/authStore';
import { db, type LocalNote } from '../../lib/db';
import { queryKeys } from '../../lib/queryKeys';
import { LOCAL_FIRST } from '../../lib/networkMode';
import { getKeyring } from '../../lib/vaultApi';
import { decryptItem, encryptItem, type VaultNoteType } from '../../lib/vaultCodec';
import { hydrateVaultNote, vaultReconcile } from '../../lib/vaultReconcile';
import { checkPendingOnStart, refreshKeyringCache, syncKeyringCache, type KeyringDto } from '../../lib/vaultSession';
import { ENVELOPE_RE } from '../../utils/vaultCrypto';
import { getActiveRootKey } from '../../utils/vaultRootKeys';
import { syncPush } from '../sync/syncService';
import type { Note } from '../notes/noteService';
import TagList from '../tags/TagList';
import CredentialCard from './CredentialCard';
import CredentialForm from './CredentialForm';
import RecoveryKitSheet from './RecoveryKitSheet';
import VaultMigrate from './VaultMigrate';
import VaultNoteEditor from './VaultNoteEditor';
import VaultOfflineNotice from './VaultOfflineNotice';
import VaultSettingsSheet from './VaultSettingsSheet';
import VaultSetup from './VaultSetup';
import VaultUnlock from './VaultUnlock';
import { EMPTY_CREDENTIAL, parseCredential } from './credentialTypes';

type TypeFilter = 'all' | 'note' | 'credential';

// Stato del keyring (piano 5.3) quando il vault e' bloccato. UNLOCKED non e' qui: sono le chiavi dell'utente corrente.
type Gate =
  | { k: 'loading' }
  | { k: 'unknown' } // GET fallita e nessuna copia locale: mai il setup
  | { k: 'unavailable' } // server raggiungibile ma vault non disponibile (503, es. pepper assente): non e' un problema di rete
  | { k: 'none'; legacyCount: number }
  | { k: 'ready' }
  | { k: 'resetPending' }
  | { k: 'setupDisabled'; legacyCount: number };

const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}';
const MAX_ENVELOPE_LEN = 2 * 1024 * 1024; // oltre non passa il limite del server
const LATER_RETRY_MS = [5_000, 20_000]; // T-f: recupero delle note in LATER (spec, Addendum 2 §1)

// Solo in memoria (D8): titolo decifrato e testo di ricerca. Mai in Dexie, coda o storage.
interface Plain { title: string; hay: string }

/**
 * Crea una voce vault: envelope cifrato con l'id definitivo (l'id e' nell'AAD, quindi va deciso PRIMA di cifrare) e `title:''` in Dexie.
 * Scrive Dexie e coda come le copie del reconcile; noteService.createNote genera il proprio id e non puo' servire qui.
 */
async function createVaultItem(args: { noteType: VaultNoteType; notebookId: string; item: { t: string; c: string } }): Promise<string> {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error('vault.create: no user');
  const id = uuidv4();
  const content = await encryptItem(id, args.noteType, args.item);
  if (content.length > MAX_ENVELOPE_LEN) throw new Error('vault.create: envelope too large');
  const now = new Date().toISOString();
  await db.transaction('rw', db.notes, db.syncQueue, async () => {
    await db.notes.add({
      id, title: '', content, notebookId: args.notebookId, userId, isTrashed: false, createdAt: now, updatedAt: now,
      tags: [], attachments: [], isVault: true, isEncrypted: true, noteType: args.noteType, ownership: 'owned',
      sharedPermission: null, sharedByUser: null, syncStatus: 'created',
    } as LocalNote);
    await db.syncQueue.add({
      type: 'CREATE', entity: 'NOTE', entityId: id, userId, createdAt: Date.now(),
      data: { title: '', notebookId: args.notebookId, content, isVault: true, isEncrypted: true, noteType: args.noteType, id },
    });
  });
  return id;
}

export default function VaultPage() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const userId = useAuthStore((s) => s.user?.id);
  const unlocked = useVaultStore((s) => !!userId && s.unlockedUserId === userId && !!s.keys);
  const keys = useVaultStore((s) => s.keys);
  const lockVault = useVaultStore((s) => s.lockVault);
  const touchVault = useVaultStore((s) => s.touchVault);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate>({ k: 'loading' });
  const [retrying, setRetrying] = useState(false);
  const [alreadySetup, setAlreadySetup] = useState(false); // il setup ha scoperto un keyring gia' creato altrove: avviso sullo sblocco
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showResume, setShowResume] = useState(false);
  const [legacyLeft, setLegacyLeft] = useState(0);
  const [legacyPinLeft, setLegacyPinLeft] = useState(0); // note con riga lasciate per un PIN precedente (B.13)
  const [kitBanner, setKitBanner] = useState(false);
  const [plain, setPlain] = useState<Map<string, Plain>>(() => new Map());
  // Solo in memoria, come `plain`: evita di ridecifrare le righe il cui envelope non e' cambiato (la live query scatta a ogni scrittura su db.notes).
  const decryptedRef = useRef<{ keys: unknown; m: Map<string, { content: string; type: VaultNoteType; v: Plain }> }>({ keys: null, m: new Map() });
  const isMobile = useIsMobile();
  const { toggleSidebar, notesSortField, notesSortOrder, setNotesSort, isListCollapsed, toggleListCollapsed, collapseAll } = useUIStore();
  const queryClient = useQueryClient();
  const { notebooks } = useNotebooks();
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedNoteId = searchParams.get('noteId');
  const openNoteRef = useRef(selectedNoteId); // T-f: con un editor aperto i giri di recupero aspettano T-c
  useEffect(() => { openNoteRef.current = selectedNoteId; }, [selectedNoteId]);
  const rootKey = getActiveRootKey();
  // Il wizard (setup o migrazione) resta montato finche' non finisce: il setup sblocca prima della cerimonia del Kit.
  const showWizard = gate.k === 'none';
  const reconcileEnabled = unlocked && !showWizard;

  // --- keyring: UNKNOWN / NONE / READY (piano 5.3) -------------------------------------------------
  const seqRef = useRef(0);
  const loadKeyring = useCallback(async () => {
    if (!userId) return;
    const seq = ++seqRef.current;
    let next: Gate;
    try {
      // setupAllowed (kill switch D2) arriva dal server; assente (backend vecchio) = consentito
      const kr = await getKeyring<KeyringDto & { setupAllowed?: boolean }>();
      if (kr.status === 'READY') syncKeyringCache(userId, kr); // J.6: la cache offline segue il keyring del server (mai indietro)
      next = kr.status === 'NONE' ? (kr.setupAllowed === false ? { k: 'setupDisabled', legacyCount: kr.legacyCount ?? 0 } : { k: 'none', legacyCount: kr.legacyCount ?? 0 })
        : kr.status === 'READY' ? { k: 'ready' }
        : { k: 'resetPending' };
    } catch (err) {
      // Offline, 5xx o 404: con la copia locale si sblocca da li; senza, UNKNOWN. Mai il setup, mai un purge.
      const e = err as { status?: unknown; key?: unknown };
      if (useVaultStore.getState().byUser[userId]?.status === 'READY') next = { k: 'ready' };
      else if (e?.status === 503 && e?.key === 'errors.vault.unavailable') next = { k: 'unavailable' };
      else next = { k: 'unknown' };
    }
    if (seq !== seqRef.current) return;
    setGate(next);
    setRetrying(false);
  }, [userId]);

  useEffect(() => () => { seqRef.current++; }, []);

  // Da bloccato (anche dopo l'auto-lock) si rilegge il keyring; da sbloccato no.
  useEffect(() => {
    if (unlocked) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch asincrono: lo stato si imposta dopo l'await
    void loadKeyring();
  }, [unlocked, loadKeyring]);

  useEffect(() => {
    if (gate.k !== 'unknown' && gate.k !== 'unavailable' && gate.k !== 'setupDisabled') return; // il flag/pepper possono cambiare senza remount
    const on = () => { void loadKeyring(); };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [gate.k, loadKeyring]);

  // J.6: da sbloccato loadKeyring non gira; la cache offline si riallinea comunque, subito e a ogni ritorno online.
  useEffect(() => {
    if (!unlocked || !userId) return;
    const refresh = () => { void refreshKeyringCache(userId); };
    if (navigator.onLine) refresh();
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [unlocked, userId]);

  const retryKeyring = () => { setRetrying(true); void loadKeyring(); };
  const finishWizard = () => setGate({ k: 'ready' }); // setup/migrazione chiusi: il keyring e' READY per costruzione
  const handleAlreadySetup = () => { setAlreadySetup(true); finishWizard(); };

  // --- reconcile: dopo lo sblocco, al ritorno online, alla chiusura di una nota ---------------------
  const aliveRef = useRef(true);
  const laterTry = useRef(0);
  const laterTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const needTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const runRef = useRef<(retry?: boolean) => void>(() => {});
  const seenRef = useRef<{ keys: unknown; ids: Set<string> } | null>(null); // memo di T-d/T-h, per sessione sbloccata
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; clearTimeout(laterTimer.current); clearTimeout(needTimer.current); };
  }, []);
  // `retry` = giro di recupero T-f; ogni altro trigger azzera il contatore dei tentativi.
  const runReconcile = useCallback((retry = false) => {
    clearTimeout(laterTimer.current);
    if (!retry) laterTry.current = 0;
    vaultReconcile()
      .then((r) => {
        if (!aliveRef.current || r.skipped) return;
        setLegacyLeft(r.legacyLeft);
        setLegacyPinLeft(r.legacyPin ?? 0);
        if (r.conflictsResolved + r.reactivated > 0) void syncPush().catch(() => false); // T-g: ACK e REQUEUE non svegliano la push reattiva
        if (!r.later) { laterTry.current = 0; return; }
        if (r.aborted || openNoteRef.current || laterTry.current >= LATER_RETRY_MS.length) return; // T-f
        clearTimeout(laterTimer.current); // single-flight: due .then possono arrivare qui, il primo timer non va perso
        laterTimer.current = setTimeout(() => { if (aliveRef.current && !openNoteRef.current) runRef.current(true); }, LATER_RETRY_MS[laterTry.current++]);
      })
      .catch(() => { /* il prossimo trigger riprova */ });
  }, []);
  useEffect(() => { runRef.current = runReconcile; }, [runReconcile]);

  useEffect(() => {
    if (!reconcileEnabled) return;
    const onOnline = () => runReconcile(); // T-b: l'Event non deve finire in `retry`
    if (navigator.onLine) runReconcile(); // T-a
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [reconcileEnabled, runReconcile]);

  // T-c: l'editor chiama onReleased dopo l'ultimo salvataggio locale e il rilascio del lock; la push porta fuori l'edit, poi il giro
  const onEditorReleased = useCallback(() => {
    if (!aliveRef.current || !navigator.onLine) return;
    void syncPush().catch(() => false).then(() => { if (aliveRef.current) runReconcile(); });
  }, [runReconcile]);

  // T-d: item `vault:conflict` nuovo; T-h: riga vault vuota nuova dopo la pull. Il memo evita i cicli.
  const needIds = useLiveQuery(async () => {
    if (!userId) return [] as string[];
    const q = await db.syncQueue.filter((i) => i.userId === userId && i.entity === 'NOTE' && i.status === 'failed' && i.lastError === 'vault:conflict').toArray();
    const e = (await db.notes.toArray()).filter((n) => n.userId === userId && !!n.isVault && n.ownership !== 'shared' && !n.content);
    return [...q.map((i) => `q${i.id}`), ...e.map((n) => `e${n.id}`)];
  }, [userId]);
  useEffect(() => {
    if (!needIds || !reconcileEnabled) return;
    if (seenRef.current?.keys !== keys) { seenRef.current = { keys, ids: new Set(needIds) }; return; } // primo valore: lo copre T-a
    const seen = seenRef.current.ids;
    const fresh = needIds.filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    if (!fresh.length || !navigator.onLine) return;
    clearTimeout(needTimer.current); // debounce 1 s; il cleanup dell'effetto non lo cancella (un nuovo valore lo perderebbe)
    needTimer.current = setTimeout(() => { if (aliveRef.current) runReconcile(); }, 1_000);
  }, [needIds, reconcileEnabled, keys, runReconcile]);

  // Un file lasciato su /vault fuori dall'editor farebbe navigare la PWA al file (e gli edit nel debounce andrebbero persi)
  useEffect(() => {
    const stop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt && (Array.from(dt.types ?? []).includes('Files') || dt.files?.length)) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  // Marker pendenti di un riavvio (Kit non confermato, cambio PIN): confronto col server.
  useEffect(() => {
    if (!reconcileEnabled || !userId) return;
    let cancelled = false;
    checkPendingOnStart(userId)
      .then((o) => {
        if (cancelled) return;
        if (o === 'kitUnconfirmed') setKitBanner(true);
        else if (o === 'pinApplied') toast.success(tRef.current('vault.pendingPinApplied'));
        else if (o === 'pinNotApplied') toast(tRef.current('vault.pendingPinNotApplied'));
      })
      .catch(() => { /* marker intatti */ });
    return () => { cancelled = true; };
  }, [reconcileEnabled, userId]);

  // Reset vault auto-lock timer on any user interaction while vault is open
  useEffect(() => {
    if (!unlocked) return;
    const resetTimer = () => touchVault();
    document.addEventListener('click', resetTimer);
    document.addEventListener('keydown', resetTimer);
    return () => {
      document.removeEventListener('click', resetTimer);
      document.removeEventListener('keydown', resetTimer);
    };
  }, [unlocked, touchVault]);

  const setSelectedNoteId = (id: string | null) => {
    const newParams = new URLSearchParams(searchParams);
    if (id) {
      newParams.set('noteId', id);
    } else {
      newParams.delete('noteId');
    }
    setSearchParams(newParams);
  };

  // --- creazione ------------------------------------------------------------------------------------
  const creating = useRef(false); // doppio clic nello stesso tick: `isPending` (stato) non fa in tempo (F.23)
  const createMutation = useMutation({
    mutationFn: createVaultItem,
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notes.all });
      setSelectedNoteId(id);
      toast.success(t('notes.created'));
    },
    onError: () => {
      toast.error(t('notes.createFailed'));
    },
    ...LOCAL_FIRST,
  });

  const getDefaultNotebookId = () => {
    return notebooks && notebooks.length > 0 ? notebooks[0].id : null;
  };

  const handleCreate = (noteType: VaultNoteType) => {
    const notebookId = getDefaultNotebookId();
    if (!notebookId) { toast.error(t('notes.noNotebooksFound')); return; }
    setShowCreateMenu(false); // prima della guardia: il menu si chiude anche quando il clic viene scartato
    if (creating.current || createMutation.isPending) return;
    creating.current = true;
    createMutation.mutate({
      noteType,
      notebookId,
      item: noteType === 'NOTE'
        ? { t: t('notes.untitled'), c: EMPTY_DOC }
        : { t: t('vault.credential.untitled'), c: JSON.stringify(EMPTY_CREDENTIAL) },
    }, { onSettled: () => { creating.current = false; } });
  };
  const handleCreateSecureNote = () => handleCreate('NOTE');
  const handleCreateCredential = () => handleCreate('CREDENTIAL');

  // --- lista: righe da Dexie, titoli decifrati solo in memoria ---------------------------------------
  const rows = useLiveQuery(async () => {
    const allNotes = await db.notes.toArray();
    return allNotes
      .filter(note => !!note.isVault && !note.isTrashed && note.userId === userId)
      .filter(note => {
        if (typeFilter === 'note') return note.noteType !== 'CREDENTIAL';
        if (typeFilter === 'credential') return note.noteType === 'CREDENTIAL';
        return true;
      })
      .filter(note => {
        if (!selectedTagId) return true;
        return note.tags?.some((tagEntry: { tag?: { id: string } }) => tagEntry.tag?.id === selectedTagId);
      });
  }, [typeFilter, selectedTagId, userId]);

  useEffect(() => {
    let cancelled = false;
    if (!keys || !rows) {
      decryptedRef.current = { keys: null, m: new Map() };
      queueMicrotask(() => { if (!cancelled) setPlain(new Map()); });
      return () => { cancelled = true; };
    }
    if (decryptedRef.current.keys !== keys) decryptedRef.current = { keys, m: new Map() };
    const cache = decryptedRef.current.m;
    (async () => {
      const m = new Map<string, Plain>();
      for (const r of rows) {
        if (!ENVELOPE_RE.test(r.content ?? '')) continue; // riga legacy o non caricata: il titolo (se c'e') e' quello di Dexie
        const type: VaultNoteType = r.noteType === 'CREDENTIAL' ? 'CREDENTIAL' : 'NOTE';
        const hit = cache.get(r.id);
        if (hit && hit.content === r.content && hit.type === type) { m.set(r.id, hit.v); continue; }
        try {
          const { t: title, c } = await decryptItem(r.id, type, r.content);
          let hay = title;
          if (type === 'CREDENTIAL') {
            const data = parseCredential(c);
            hay = [title, data?.siteUrl, data?.username].filter(Boolean).join('\n');
          }
          const v = { title, hay: hay.toLowerCase() };
          cache.set(r.id, { content: r.content, type, v });
          m.set(r.id, v);
        } catch { /* non decifrabile: resta senza titolo */ }
        if (cancelled) return;
      }
      if (!cancelled) setPlain(m);
    })();
    return () => { cancelled = true; };
  }, [rows, keys]);

  const titleOf = useCallback((n: LocalNote) => plain.get(n.id)?.title ?? (ENVELOPE_RE.test(n.content ?? '') ? '' : n.title ?? ''), [plain]);

  const vaultNotes = useMemo(() => {
    if (!rows) return undefined;
    const q = searchQuery.trim().toLowerCase();
    return rows
      .filter(n => !q || (plain.get(n.id)?.hay ?? (n.title ?? '').toLowerCase()).includes(q))
      .sort((a, b) => {
        if (notesSortField === 'title') {
          const cmp = titleOf(a).localeCompare(titleOf(b));
          return notesSortOrder === 'asc' ? cmp : -cmp;
        }
        const dateA = new Date(a[notesSortField]).getTime();
        const dateB = new Date(b[notesSortField]).getTime();
        return notesSortOrder === 'asc' ? dateA - dateB : dateB - dateA;
      });
  }, [rows, plain, searchQuery, notesSortField, notesSortOrder, titleOf]);

  // La nota aperta si legge a parte: un filtro o la ricerca non devono smontare l'editor. null = non esiste (undefined = in lettura).
  const sel = useLiveQuery(
    async () => (selectedNoteId ? { id: selectedNoteId, row: (await db.notes.get(selectedNoteId)) ?? null } : undefined),
    [selectedNoteId],
  );
  // useLiveQuery restituisce il risultato delle deps precedenti finche' la nuova query non emette: si usa solo se e' della nota nell'URL
  const selectedNote = sel && sel.id === selectedNoteId ? sel.row : undefined;

  // Auto-close se la nota non esiste piu', e' nel cestino o e' uscita dal vault
  useEffect(() => {
    if (selectedNote === undefined) return;
    if (selectedNote === null || !selectedNote.isVault || selectedNote.isTrashed) {
      setSearchParams((params) => {
        const newParams = new URLSearchParams(params);
        newParams.delete('noteId');
        return newParams;
      });
    }
  }, [selectedNote, setSearchParams]);

  // Credenziale mai caricata su questo dispositivo (content ''): si idrata prima di aprirla (la sua form non scrive mai da vuota)
  const hydrateId = unlocked && selectedNote && selectedNote.noteType === 'CREDENTIAL' && !selectedNote.content ? selectedNote.id : null;
  useEffect(() => {
    if (!hydrateId) return;
    const go = () => { hydrateVaultNote(hydrateId).catch(() => false); };
    if (navigator.onLine) go();
    window.addEventListener('online', go);
    return () => window.removeEventListener('online', go);
  }, [hydrateId]);

  // Lock vault on unmount (gli editor salvano via registerPreLock)
  useEffect(() => {
    return () => {
      void lockVault();
    };
  }, [lockVault]);

  // Close create menu on outside click
  useEffect(() => {
    if (!showCreateMenu) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-create-menu]')) setShowCreateMenu(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCreateMenu]);

  // --- schermate da bloccato ----------------------------------------------------------------------------
  const infoScreen = (text: string, withRetry = false) => (
    <div className="flex h-full items-center justify-center p-4 bg-neutral-50 dark:bg-neutral-900">
      <div role="status" className="w-full max-w-sm text-center bg-white dark:bg-neutral-800 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6">
        <Lock size={32} className="mx-auto mb-4 text-neutral-400 dark:text-neutral-500" aria-hidden="true" />
        <p className="text-neutral-700 dark:text-neutral-300">{text}</p>
        {withRetry && (
          <Button onClick={retryKeyring} disabled={retrying} className="w-full min-h-[44px] mt-6">
            {t('vault.offline.retry')}
          </Button>
        )}
      </div>
    </div>
  );

  const renderKit = (kit: Uint8Array, onConfirmed: () => void) => (
    <RecoveryKitSheet kit={kit} userId={userId ?? ''} onDone={onConfirmed} />
  );

  if (!userId) return infoScreen(t('common.loading'));

  if (showWizard) {
    if (gate.k === 'none' && gate.legacyCount > 0) {
      return rootKey
        ? <VaultMigrate userId={userId} rootKey={rootKey} renderKit={renderKit} onDone={finishWizard} />
        : infoScreen(t('vault.setupDisabledLegacy'));
    }
    return <VaultSetup onAlreadySetup={handleAlreadySetup} onDone={finishWizard} />;
  }

  if (!unlocked) {
    switch (gate.k) {
      case 'unknown': return <VaultOfflineNotice onRetry={retryKeyring} retrying={retrying} />;
      case 'unavailable': return infoScreen(t('errors.vault.unavailable'), true);
      case 'setupDisabled': return infoScreen(t(gate.legacyCount > 0 ? 'vault.setupDisabledLegacy' : 'errors.vault.setupDisabled'), true);
      case 'resetPending': return infoScreen(t('vault.resetPending'));
      case 'ready': return <VaultUnlock notice={alreadySetup ? 'alreadySetup' : undefined} onUnlocked={() => setAlreadySetup(false)} />;
      default: return infoScreen(t('common.loading'));
    }
  }

  // --- vault sbloccato ------------------------------------------------------------------------------------
  const filterChips: { key: TypeFilter; label: string }[] = [
    { key: 'all', label: t('vault.filterAll') },
    { key: 'note', label: t('vault.filterNote') },
    { key: 'credential', label: t('vault.filterCredential') },
  ];

  const openLegacyPin = () => { setSelectedNoteId(null); setShowResume(true); };

  const BANNER = 'mx-2 mt-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300 text-sm flex items-center justify-between gap-2';
  const BANNER_ACTION = 'min-h-[44px] px-2 font-medium underline flex-shrink-0';

  const renderBanners = () => (
    <>
      {legacyLeft > 0 && (
        <div role="status" className={BANNER}>
          <span>{t('vault.settings.legacyLeft', { n: legacyLeft })}</span>
          <button type="button" onClick={() => setShowResume(true)} className={BANNER_ACTION}>{t('vault.settings.legacyLeftAction')}</button>
        </div>
      )}
      {legacyPinLeft > 0 && legacyLeft === 0 && (
        <div role="status" className={BANNER}>
          <span>{t('vault.legacyPinLeft', { n: legacyPinLeft })}</span>
          <button type="button" onClick={openLegacyPin} className={BANNER_ACTION}>{t('vault.legacyPinLeftAction')}</button>
        </div>
      )}
      {kitBanner && (
        <div role="status" className={BANNER}>
          <span>{t('vault.kitUnconfirmed')}</span>
          <button type="button" onClick={() => { setKitBanner(false); setSettingsOpen(true); }} className={BANNER_ACTION}>{t('vault.kitUnconfirmedAction')}</button>
        </div>
      )}
    </>
  );

  const ICON_BTN = 'h-11 w-11 md:h-8 md:w-8 rounded-full';

  const renderNoteList = () => (
    <div className={clsx("flex flex-col h-full bg-white dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800", isMobile ? "w-full" : "w-80")}>
      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between min-h-[48px]">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button
              onClick={toggleSidebar}
              aria-label={t('common.menu')}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              <Menu size={24} />
            </button>
          )}
          <Lock size={20} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Create dropdown */}
          <div className="relative" data-create-menu>
            <Button
              onClick={() => setShowCreateMenu(!showCreateMenu)}
              variant="primary"
              size="icon"
              className={ICON_BTN}
              aria-label={t('vault.createSecureNote')}
              aria-expanded={showCreateMenu}
            >
              <Plus size={16} />
            </Button>
            {showCreateMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden min-w-[180px]">
                <button
                  onClick={handleCreateSecureNote}
                  disabled={createMutation.isPending}
                  className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                >
                  <Lock size={14} />
                  {t('vault.createSecureNote')}
                </button>
                <button
                  onClick={handleCreateCredential}
                  disabled={createMutation.isPending}
                  className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                >
                  <KeyRound size={14} />
                  {t('vault.createCredential')}
                </button>
              </div>
            )}
          </div>
          <Button onClick={() => setSettingsOpen(true)} variant="ghost" size="icon" className={ICON_BTN} title={t('vault.settings.title')} aria-label={t('vault.settings.title')}>
            <Settings size={16} />
          </Button>
          <Button onClick={() => { void lockVault(); }} variant="ghost" size="icon" className={ICON_BTN} title={t('vault.lock')} aria-label={t('vault.lock')}>
            <Lock size={16} />
          </Button>
          {!isMobile && (
            <>
              <button
                onClick={collapseAll}
                className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
                title={t('sidebar.collapseAll')}
                aria-label={t('sidebar.collapseAll')}
              >
                <ChevronsLeft size={18} />
              </button>
              <button
                onClick={toggleListCollapsed}
                className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
                title={t('common.collapseList')}
                aria-label={t('common.collapseList')}
              >
                <PanelLeftClose size={18} />
              </button>
            </>
          )}
        </div>
      </div>

      {renderBanners()}

      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
          <input
            type="text"
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full min-h-[44px] pl-9 pr-4 py-2 bg-neutral-100 dark:bg-neutral-800 border-none rounded-lg focus:ring-2 focus:ring-emerald-500 text-sm dark:text-white"
          />
        </div>
        {/* Type filter chips + sort */}
        <div className="flex items-center gap-1 mt-2">
          {filterChips.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTypeFilter(key)}
              className={clsx(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                typeFilter === key
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
              )}
            >
              {label}
            </button>
          ))}
          <SortDropdown sortField={notesSortField} sortOrder={notesSortOrder} onChange={setNotesSort} />
        </div>
      </div>

      <div className="border-b border-neutral-200 dark:border-neutral-800">
        <TagList
          onSelectTag={(tagId) => setSelectedTagId(tagId === selectedTagId ? null : tagId ?? null)}
          selectedTagId={selectedTagId ?? undefined}
          isVault={true}
          isCreatingExternal={false}
          hideHeader={false}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {vaultNotes?.map((note) => (
          note.noteType === 'CREDENTIAL' ? (
            <CredentialCard
              key={note.id}
              note={note}
              isSelected={selectedNoteId === note.id}
              onClick={() => setSelectedNoteId(note.id)}
            />
          ) : (
            <button
              key={note.id}
              onClick={() => setSelectedNoteId(note.id)}
              className={clsx(
                "w-full text-left p-3 rounded-lg transition-colors border",
                selectedNoteId === note.id
                  ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800"
                  : "bg-white dark:bg-neutral-800 border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
              )}
            >
              <h3 className={clsx("font-medium mb-1 truncate", selectedNoteId === note.id ? "text-emerald-700 dark:text-emerald-400" : "text-neutral-900 dark:text-white")}>
                {titleOf(note) || t('notes.untitled')}
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-1">
                {new Date(note.updatedAt).toLocaleDateString()}
              </p>
            </button>
          )
        ))}
        {vaultNotes?.length === 0 && (
          <div className="text-center text-neutral-500 py-8 text-sm">
            {t('vault.noNotes')}
          </div>
        )}
      </div>
    </div>
  );

  const renderEditor = () => (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-neutral-900 relative">
      {selectedNote && selectedNote.isVault ? (
        selectedNote.noteType === 'CREDENTIAL' ? (
          <CredentialForm
            key={selectedNote.id}
            note={selectedNote as unknown as Note}
            onBack={() => setSelectedNoteId(null)}
            onDelete={() => setSelectedNoteId(null)}
            onReleased={onEditorReleased}
            onLegacyPin={openLegacyPin}
          />
        ) : (
          <VaultNoteEditor
            key={selectedNote.id}
            note={selectedNote as unknown as Note}
            onBack={() => setSelectedNoteId(null)}
            onReleased={onEditorReleased}
          />
        )
      ) : (
        <div className="flex h-full items-center justify-center text-neutral-400 flex-col p-4 text-center dark:text-neutral-500">
          <Lock size={48} className="mb-4 opacity-20" />
          <p className="mb-4">{t('notes.selectToView')}</p>
          <div className="flex gap-2">
            <Button onClick={handleCreateSecureNote} disabled={createMutation.isPending} variant="primary" className="min-h-[44px]">
              {t('vault.createSecureNote')}
            </Button>
            <Button onClick={handleCreateCredential} disabled={createMutation.isPending} variant="secondary" className="min-h-[44px]">
              <KeyRound size={16} className="mr-1" />
              {t('vault.createCredential')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  // Aggiornamento dei vecchi item (banner): il wizard in modalita' resume sostituisce la pagina finche' non finisce
  const resume = showResume ? (
    <div className="flex flex-col h-full bg-white dark:bg-neutral-900 overflow-y-auto">
      <div className="p-2">
        <button
          type="button"
          onClick={() => setShowResume(false)}
          className="min-h-[44px] inline-flex items-center gap-2 px-2 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t('common.back')}
        </button>
      </div>
      <VaultMigrate
        resume
        userId={userId}
        rootKey={rootKey ?? undefined}
        renderKit={renderKit}
        onDone={() => { setShowResume(false); runReconcile(); }}
      />
    </div>
  ) : null;

  let body;
  if (resume) {
    body = resume;
  } else if (isMobile) {
    body = (
      <div className="flex h-full bg-white w-full dark:bg-neutral-900">
        {selectedNoteId ? renderEditor() : renderNoteList()}
      </div>
    );
  } else {
    body = (
      <div className="flex h-full bg-white dark:bg-neutral-900">
        {isListCollapsed ? (
          <div className="flex flex-col items-center py-3 px-1 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
            <button
              onClick={toggleListCollapsed}
              className="p-1.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-md transition-colors"
              title={t('common.expandList')}
              aria-label={t('common.expandList')}
            >
              <PanelLeftOpen size={18} />
            </button>
          </div>
        ) : (
          renderNoteList()
        )}
        {renderEditor()}
      </div>
    );
  }

  return (
    <>
      {body}
      <VaultSettingsSheet isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} onLegacyLeft={setLegacyLeft} />
    </>
  );
}
