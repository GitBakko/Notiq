import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useAuthStore } from '../../store/authStore';
import { useVaultStore } from '../../store/vaultStore';
import * as vaultApi from '../../lib/vaultApi';
import type { RecoveryDto } from '../../lib/vaultApi';
import { completeRecovery, localRecovery, startRecovery, syncLocalRecovery, type CompleteResult } from '../../lib/vaultRecovery';
import type { KeyringDto } from '../../lib/vaultSession';
import { RECOVERY_CHANGED_EVENT, setCeremonyOpen } from '../../lib/vaultEvents';
import { normalizeKit } from '../../utils/vaultKit';
import { checkPin } from './PinPolicy';
import PinInput from './PinInput';
import RecoveryCodeForm from './RecoveryCodeForm';
import RecoveryKitSheet from './RecoveryKitSheet';
import { appControl, outcomeOf, type Outcome, type OutcomeAction } from './recoveryOutcome';

export type RecoveryNext = 'unlock' | 'regenerate' | 'none';

interface Props {
  userId: string;
  onClose: (next: RecoveryNext) => void;
}

type View =
  | { k: 'loading' }
  | { k: 'loadFailed'; key: string }
  | { k: 'intro' }
  | { k: 'noRequest' }
  | { k: 'foreign'; openId: string; status: string }
  | { k: 'status'; id: string; fp: string; rec: RecoveryDto | null; gone?: boolean; failed?: boolean }
  | { k: 'complete'; id: string; fp: string; n: number }
  | { k: 'outcome'; o: Outcome; id: string | null; fp: string }
  | { k: 'kit'; kit: Uint8Array; escrowHash: string };

type Confirm = { kind: 'cancel' | 'redo'; id: string };

/** Il rilascio e' gia' avvenuto (o non si sa): annullare lo fa perdere. Derivato dalla vista corrente, cosi' un poll che porta a RELEASED aggiorna anche il dialogo aperto. */
const isReleased = (v: View) =>
  v.k === 'complete'
  || (v.k === 'outcome' && v.o.action === 'cancelAndRedo') // releaseInvalid e notThisDevice nascono solo da RELEASED
  || (v.k === 'foreign' && v.status === 'RELEASED')
  || (v.k === 'status' && !v.gone && (v.failed || v.rec === null || v.rec.status === 'RELEASED')); // ultima GET fallita: stato ignoto, si resta prudenti

const INPUT = 'w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white';
const ERR = 'text-sm text-left text-red-600 dark:text-red-400';
const TEXT = 'text-sm text-left text-neutral-700 dark:text-neutral-300';
const POLL_MS = 60_000;
const OPEN = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING'];
const KIT_LEN = 34; // 32 simboli di dati + 2 di controllo

const ACTION_LABEL: Record<OutcomeAction, string> = {
  kitCeremony: 'close', regenerateKit: 'regenerateKit', goUnlock: 'goUnlock', retryFresh: 'retry', retry: 'retry', clearKit: 'retry', newRequest: 'newRequest',
  cancelAndRedo: 'cancelAndRedo', update: 'update', reload: 'reload', backToStatus: 'backToStatus', restart: 'restart',
};
const isNotFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;

/** Form di completamento: Kit + nuovo PIN due volte. Una sola completeRecovery per montaggio utile (sentRef): ogni CompleteResult lo smonta il padre. */
function CompleteForm({ userId, requestId, onResult, onAction, onCancel, onClose }: {
  userId: string; requestId: string; onResult: (r: CompleteResult) => void; onAction: (a: OutcomeAction) => void; onCancel: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [kit, setKit] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Outcome | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const sentRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const ready = normalizeKit(kit).length === KIT_LEN && pin !== '' && again !== '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sentRef.current || !ready) return;
    sentRef.current = true; // sincrono: `busy` non fa in tempo a bloccare un doppio clic
    setBusy(true);
    setError(null);
    setErrorKey(null);
    let done = false; // CompleteResult ricevuto: da qui il form non si riusa
    try {
      const check = await checkPin(pin, { name: user?.name, surname: user?.surname, email: user?.email });
      if (!check.ok) { setErrorKey(`vault.pinPolicy.${check.reason}`); return; }
      if (pin !== again) { setErrorKey('vault.pinMismatch'); return; }
      const res = await completeRecovery({ userId, requestId, kit, newPin: pin });
      done = true;
      setKit('');
      setPin('');
      setAgain('');
      onResult(res); // il form non si riapre: da qui si passa solo da una nuova lettura RELEASED
    } catch (err) {
      if (!alive.current) return;
      const o = outcomeOf(err);
      if (o.action === 'clearKit') setKit('');
      setError(o);
    } finally {
      // validazione fallita o errore lanciato (nessuna POST partita): si puo' reinviare
      if (!done) {
        sentRef.current = false;
        if (alive.current) setBusy(false);
      }
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-left">
      <h3 className="text-base font-semibold text-neutral-900 dark:text-white">{t('vault.recovery.complete.title')}</h3>
      <p className={TEXT}>{t('vault.recovery.complete.help')}</p>
      <input
        type="text"
        value={kit}
        onChange={(e) => setKit(e.target.value)}
        aria-label={t('vault.recovery.complete.kit')}
        placeholder={t('vault.recovery.complete.kit')}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        className={`${INPUT} font-mono uppercase`}
        disabled={busy}
      />
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.recovery.complete.kitHelp')}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.setup.pinRules')}</p>
      <PinInput value={pin} onChange={setPin} label={t('vault.recovery.complete.newPin')} autoComplete="new-password" className={INPUT} />
      <PinInput value={again} onChange={setAgain} label={t('vault.confirmPin')} autoComplete="new-password" className={INPUT} />
      {errorKey && <p role="alert" className={ERR}>{t(errorKey)}</p>}
      {error && <p role="alert" className={ERR}>{t(error.key)}</p>}
      {error && error.action !== 'retry' && error.action !== 'clearKit' && (
        <Button type="button" variant="secondary" className="w-full min-h-[44px]" onClick={() => onAction(error.action)}>
          {t(`vault.recovery.actions.${ACTION_LABEL[error.action]}`)}
        </Button>
      )}
      {busy && <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.recovery.complete.working')}</p>}
      <Button type="submit" variant="primary" className="w-full min-h-[44px]" isLoading={busy} disabled={!ready || busy}>
        {error?.action === 'retry' ? t('vault.recovery.actions.retry') : t('vault.recovery.complete.submit')}
      </Button>
      <Button type="button" variant="ghost" className="w-full min-h-[44px]" onClick={onCancel} disabled={busy}>{t('vault.recovery.actions.cancelRequest')}</Button>
      <Button type="button" variant="ghost" className="w-full min-h-[44px]" onClick={onClose} disabled={busy}>{t('vault.recovery.actions.close')}</Button>
    </form>
  );
}

export default function VaultRecovery({ userId, onClose }: Props) {
  const { t } = useTranslation();
  const [view, setViewState] = useState<View>({ k: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reason, setReason] = useState('');
  const [introError, setIntroError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const viewRef = useRef<View>(view);
  const nav = useRef(0); // ogni cambio di vista lo incrementa: una risposta di rete arrivata dopo si scarta
  const completeN = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // il banner globale sta zitto mentre la cerimonia e' montata (mostra gia' lo stesso stato e l'annullo)
  useEffect(() => { setCeremonyOpen(true); return () => setCeremonyOpen(false); }, []);
  const lastStatus = useRef<string | null>(null);
  /** Dice al banner che la richiesta e' cambiata (o che e' arrivato un esito): rilegge subito invece di restare indietro. */
  const announce = useCallback((status: string) => {
    if (status === lastStatus.current) return;
    lastStatus.current = status;
    window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT));
  }, []);

  const setView = useCallback((v: View) => {
    if (viewRef.current.k === 'kit') return; // dal Kit si esce solo dal foglio (onDone): una risposta tardiva non lo sostituisce
    nav.current++;
    viewRef.current = v;
    setViewState(v);
    setNotice(null);
  }, []);

  /** Legge la richiesta: RELEASED apre il form di completamento (l'unico ingresso), altrimenti la schermata di stato. */
  const read = useCallback(async (id: string, fp: string) => {
    const t0 = nav.current;
    let next: View;
    try {
      const rec = await vaultApi.getRecovery(id);
      if (alive.current) announce(rec.status);
      next = rec.status === 'RELEASED' ? { k: 'complete', id, fp, n: ++completeN.current } : { k: 'status', id, fp, rec };
    } catch (e) {
      const cur = viewRef.current;
      next = isNotFound(e) ? { k: 'status', id, fp, rec: null, gone: true } : { k: 'status', id, fp, rec: cur.k === 'status' ? cur.rec : null, failed: true };
    }
    if (!alive.current || nav.current !== t0) return;
    setView(next);
  }, [setView, announce]);

  const load = useCallback(async () => {
    setView({ k: 'loading' });
    const t0 = nav.current;
    const stale = () => !alive.current || nav.current !== t0;
    try {
      let local = await localRecovery(userId);
      if (local && local.requestId === null) {
        const s = await syncLocalRecovery(userId);
        if (stale()) return;
        if (s === 'unknown') return setView({ k: 'loadFailed', key: 'vault.recovery.errors.retryLater' });
        local = s === 'active' ? await localRecovery(userId) : null;
        if (local && local.requestId === null) return setView({ k: 'loadFailed', key: 'vault.recovery.errors.retryLater' });
      }
      if (stale()) return;
      if (local?.requestId) return void (await read(local.requestId, local.fingerprint));
      const kr = await vaultApi.getKeyring<KeyringDto>();
      if (stale()) return;
      const st = useVaultStore.getState();
      const locked = !(st.unlockedUserId === userId && st.keys);
      // l'intro vale solo da bloccato con keyring READY (piano §1): altrimenti non c'e' nulla da avviare
      setView(kr.openRecovery ? { k: 'foreign', openId: kr.openRecovery.id, status: kr.openRecovery.status } : kr.status === 'READY' && locked ? { k: 'intro' } : { k: 'noRequest' });
    } catch (e) {
      if (!stale()) setView({ k: 'loadFailed', key: outcomeOf(e).key });
    }
  }, [userId, read, setView]);
  useEffect(() => {
    void load();
  }, [load]);

  // Polling della richiesta aperta: 60 s, ritorno in primo piano, visibilita.
  const pollId = view.k === 'status' && !view.gone && (view.rec === null || OPEN.includes(view.rec.status)) ? view.id : null;
  useEffect(() => {
    if (!pollId) return;
    const tick = () => {
      const cur = viewRef.current;
      if (cur.k === 'status' && cur.id === pollId) void read(cur.id, cur.fp);
    };
    const onVis = () => { if (document.visibilityState !== 'hidden') tick(); };
    const iv = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', onVis); };
  }, [pollId, read]);

  const fail = (e: unknown) => { if (alive.current) setNotice(outcomeOf(e).key); };

  /** Annulla la richiesta; 404/409 vogliono dire che lo stato e' gia' cambiato altrove: si rilegge. */
  const cancel = async (id: string) => {
    try {
      await vaultApi.cancelRecovery(id);
    } catch (e) {
      const s = (e as { status?: number } | null)?.status;
      if (s !== 404 && s !== 409) return fail(e);
    }
    await syncLocalRecovery(userId).catch(() => 'unknown');
    if (alive.current) void load();
  };

  const redo = async (id: string) => {
    try {
      await vaultApi.cancelRecovery(id);
    } catch {
      // qualunque errore: lo stato reale e' ignoto (puo' essere gia' completata altrove), si rilegge senza avviarne un'altra
      if (alive.current) void load();
      return;
    }
    try {
      const created = await startRecovery(userId);
      if (alive.current) await read(created.id, created.fingerprint);
    } catch (e) {
      if (outcomeOf(e).action === 'restart') { if (alive.current) void load(); } else fail(e);
    }
  };

  const newRequest = async () => {
    await syncLocalRecovery(userId).catch(() => 'unknown');
    if (alive.current) void load();
  };

  const runAction = (a: OutcomeAction, id: string | null, fp = '') => {
    switch (a) {
      case 'regenerateKit': return onClose('regenerate');
      case 'goUnlock': return onClose('unlock');
      case 'retryFresh': case 'backToStatus': return void (id ? read(id, fp) : load());
      case 'newRequest': return void newRequest();
      case 'cancelAndRedo': return id ? setConfirm({ kind: 'redo', id }) : undefined;
      case 'update': return void appControl.update();
      case 'reload': return appControl.reload();
      case 'restart': return void load();
      default: return undefined;
    }
  };

  const onResult = (r: CompleteResult, id: string, fp: string) => {
    window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT)); // un esito cambia sempre la richiesta lato server
    if (r.verdict === 'applied' && r.kit && r.escrowHash) setView({ k: 'kit', kit: r.kit, escrowHash: r.escrowHash });
    else setView({ k: 'outcome', o: outcomeOf(r), id, fp });
  };

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setIntroError(null);
    try {
      const created = await startRecovery(userId, reason.trim() || undefined);
      if (alive.current) await read(created.id, created.fingerprint);
    } catch (e) {
      const o = outcomeOf(e);
      if (!alive.current) return;
      if (o.action === 'restart') void load();
      else setIntroError(o.key);
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const closeBtn = (
    <Button type="button" variant="ghost" className="w-full min-h-[44px]" onClick={() => onClose('unlock')}>{t('vault.recovery.actions.close')}</Button>
  );
  const cancelBtn = (id: string) => (
    <Button type="button" variant="ghost" className="w-full min-h-[44px]" onClick={() => setConfirm({ kind: 'cancel', id })}>{t('vault.recovery.actions.cancelRequest')}</Button>
  );

  const body = (() => {
    switch (view.k) {
      case 'loading':
        return <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.recovery.loading')}</p>;
      case 'loadFailed':
        return (
          <div className="space-y-4">
            <p role="alert" className={ERR}>{t(view.key)}</p>
            <Button type="button" variant="secondary" className="w-full min-h-[44px]" onClick={() => void load()}>{t('vault.recovery.actions.retry')}</Button>
            {closeBtn}
          </div>
        );
      case 'intro':
        return (
          <form onSubmit={(e) => { e.preventDefault(); void start(); }} className="space-y-4 text-left">
            <h2 className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.recovery.intro.title')}</h2>
            <p className={TEXT}>{t('vault.recovery.intro.body')}</p>
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-sm text-amber-800 dark:text-amber-300">{t('vault.recovery.intro.warning')}</div>
            <label className="block">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.recovery.intro.reasonLabel')}</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                aria-label={t('vault.recovery.intro.reasonLabel')}
                placeholder={t('vault.recovery.intro.reasonPlaceholder')}
                className={`${INPUT} mt-1`}
              />
            </label>
            {introError && <p role="alert" className={ERR}>{t(introError)}</p>}
            <Button type="submit" variant="primary" className="w-full min-h-[44px]" isLoading={starting} disabled={starting}>{t('vault.recovery.intro.start')}</Button>
            {closeBtn}
          </form>
        );
      case 'noRequest':
        return (
          <div className="space-y-4 text-left">
            <p role="status" className={TEXT}>{t('vault.recovery.noOpenRequest')}</p>
            {closeBtn}
          </div>
        );
      case 'foreign':
        return (
          <div className="space-y-4 text-left">
            <h2 className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.recovery.foreign.title')}</h2>
            <p className={TEXT}>{t('vault.recovery.foreign.text')}</p>
            <Button type="button" variant="primary" className="w-full min-h-[44px]" onClick={() => setConfirm({ kind: 'redo', id: view.openId })}>{t('vault.recovery.actions.cancelAndRedo')}</Button>
            {cancelBtn(view.openId)}
            {closeBtn}
          </div>
        );
      case 'status': {
        const rec = view.rec;
        const st = rec?.status;
        const open = !view.gone && (st === undefined || OPEN.includes(st));
        const due = rec?.notBefore ? Date.parse(rec.notBefore) <= Date.now() : false;
        return (
          <div className="space-y-4 text-left">
            <h2 className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.recovery.status.title')}</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.recovery.status.fingerprint', { fingerprint: view.fp })}</p>
            {view.failed && (
              <div className="space-y-2">
                <p role="alert" className={ERR}>{t('vault.recovery.status.loadError')}</p>
                <Button type="button" variant="secondary" className="w-full min-h-[44px]" onClick={() => void read(view.id, view.fp)}>{t('vault.recovery.actions.retry')}</Button>
              </div>
            )}
            {view.gone && <p role="alert" className={ERR}>{t('vault.recovery.errors.requestClosed')}</p>}
            {st === 'PENDING_APPROVAL' && <p role="status" className={TEXT}>{t('vault.recovery.status.pendingApproval')}</p>}
            {st === 'PENDING_CODE' && (
              <>
                <p role="status" className={TEXT}>{t('vault.recovery.status.pendingCode')}</p>
                <RecoveryCodeForm
                  userId={userId}
                  requestId={view.id}
                  fingerprint={view.fp}
                  attemptsLeft={rec?.attemptsLeft}
                  expiresAt={rec?.expiresAt}
                  onChange={() => void read(view.id, view.fp)}
                  onCancelAndRedo={() => setConfirm({ kind: 'redo', id: view.id })}
                />
              </>
            )}
            {st === 'WAITING' && (
              <p role="status" className={TEXT}>
                {due ? t('vault.recovery.status.waitingDue') : t('vault.recovery.status.waiting', { date: rec?.notBefore ? new Date(rec.notBefore).toLocaleString() : '' })}
              </p>
            )}
            {st === 'REJECTED' && (
              <>
                <p role="status" className={TEXT}>{t('vault.recovery.status.rejected')}</p>
                {rec?.rejectReason && <p className={TEXT}>{t('vault.recovery.status.rejectedReason', { reason: rec.rejectReason })}</p>}
              </>
            )}
            {st === 'EXPIRED' && <p role="status" className={TEXT}>{t('vault.recovery.status.expired')}</p>}
            {st === 'CANCELLED' && <p role="status" className={TEXT}>{t('vault.recovery.status.cancelled')}</p>}
            {st === 'COMPLETED' && <p role="status" className={TEXT}>{t('vault.recovery.status.completed')}</p>}
            {open && cancelBtn(view.id)}
            {st === 'COMPLETED' && (
              <Button type="button" variant="primary" className="w-full min-h-[44px]" onClick={() => onClose('unlock')}>{t('vault.recovery.actions.goUnlock')}</Button>
            )}
            {!open && st !== 'COMPLETED' && (
              <Button type="button" variant="primary" className="w-full min-h-[44px]" onClick={() => void newRequest()}>{t('vault.recovery.actions.newRequest')}</Button>
            )}
            {st !== 'COMPLETED' && closeBtn}
          </div>
        );
      }
      case 'complete':
        return (
          <CompleteForm
            key={view.n}
            userId={userId}
            requestId={view.id}
            onResult={(r) => onResult(r, view.id, view.fp)}
            onAction={(a) => runAction(a, view.id, view.fp)}
            onCancel={() => setConfirm({ kind: 'cancel', id: view.id })}
            onClose={() => onClose('unlock')}
          />
        );
      case 'outcome': {
        const { o } = view;
        return (
          <div className="space-y-4 text-left">
            <p role="alert" className={ERR}>{t(o.key)}</p>
            <Button type="button" variant="primary" className="w-full min-h-[44px]" onClick={() => runAction(o.action, view.id, view.fp)}>
              {t(`vault.recovery.actions.${ACTION_LABEL[o.action]}`)}
            </Button>
          </div>
        );
      }
      case 'kit':
        return <p role="status" className={TEXT}>{t('vault.recovery.outcome.applied')}</p>;
    }
  })();

  const released = isReleased(view);

  return (
    <div className="h-full overflow-y-auto p-4 [-webkit-overflow-scrolling:touch]">
      <div className="flex min-h-full flex-col items-center justify-center">
        <div className="bg-white dark:bg-neutral-800 p-5 sm:p-8 rounded-xl shadow-lg max-w-md w-full border border-neutral-200/60 dark:border-neutral-700/40">
          <div className="bg-emerald-100 dark:bg-emerald-900/30 p-4 rounded-full inline-flex mb-4">
            <KeyRound size={32} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          </div>
          {body}
          {notice && <p role="alert" className={`${ERR} mt-4`}>{t(notice)}</p>}
        </div>
      </div>

      {view.k === 'kit' && <RecoveryKitSheet kit={view.kit} userId={userId} escrowHash={view.escrowHash} onDone={() => onClose('none')} />}

      <ConfirmDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          if (!c) return;
          void (c.kind === 'cancel' ? cancel(c.id) : redo(c.id));
        }}
        title={confirm?.kind === 'redo' ? t('vault.recovery.redo.title') : t('vault.recovery.cancel.title')}
        message={released
          ? t(confirm?.kind === 'redo' ? 'vault.recovery.redo.releasedMessage' : 'vault.recovery.cancelReleasedWarning')
          : t(confirm?.kind === 'redo' ? 'vault.recovery.redo.message' : 'vault.recovery.cancel.message')}
        confirmText={confirm?.kind === 'redo' ? t('vault.recovery.redo.confirm') : t('vault.recovery.cancel.confirm')}
        cancelText={t('vault.recovery.cancel.keep')}
        variant="danger"
      />
    </div>
  );
}
