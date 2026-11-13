import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';
import { KeyRound, X } from 'lucide-react';
import api from '../../../lib/api';
import { useAuthStore } from '../../../store/authStore';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';

const BASE = '/admin/vault-recovery';
const OPEN = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'] as const;
const STATUSES = [...OPEN, 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REJECTED'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

type Filter = 'open' | 'all' | (typeof STATUSES)[number];

interface RecoveryView {
  id: string;
  userId: string;
  userEmail?: string;
  status: string;
  fingerprint: string | null;
  reason: string | null;
  requestIp: string | null;
  requestUserAgent: string | null;
  createdAt: string;
  expiresAt: string | null;
  notBefore: string | null;
  attempts: number;
  rejectReason: string | null;
  keyringStatus: string | null;
  rootKeyId: string | null;
  readyForRelease: boolean;
  audit?: { event: string; userId: string | null; createdAt: string }[];
}

const BADGE: Record<string, string> = {
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  PENDING_CODE: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  WAITING: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  RELEASED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
};
const BADGE_DEFAULT = 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300';

const INPUT =
  'w-full min-h-[44px] px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white';

type ApiErr = { response?: { status?: number; data?: { message?: unknown } } };
const errOf = (e: unknown) => ({ status: (e as ApiErr)?.response?.status, msg: (e as ApiErr)?.response?.data?.message });

// Mai il testo del server: solo chiavi nostre (la passphrase non deve poter tornare in nessun messaggio)
function actionErrorKey(e: unknown, release: boolean): string {
  const { status, msg } = errOf(e);
  if (release && status === 403 && msg === 'errors.vault.invalidRootPassphrase') return 'invalidPassphrase';
  if (release && status === 429) return 'rateLimited';
  if (release && status === 503) return 'rootKeyUnavailable';
  if (status === 409 && msg === 'errors.vault.recoveryKeyringChanged') return 'keyringChanged';
  if (status === 409 && msg === 'errors.vault.recoveryStateConflict') return 'stateConflict';
  return 'generic';
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[status] ?? BADGE_DEFAULT}`}>{t(`admin.vaultRecovery.status.${status}`)}</span>;
}

interface DetailProps {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onHistory: (userId: string) => void;
}

function DetailSheet({ id, onClose, onChanged, onHistory }: DetailProps) {
  const { t, i18n } = useTranslation();
  const me = useAuthStore((s) => s.user?.id);
  const ref = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<RecoveryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState<'reject' | 'release' | null>(null);
  useFocusTrap(ref, true);

  const reload = useCallback(async () => {
    try {
      const res = await api.get(`${BASE}/${id}`);
      setDetail(res.data);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [id]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Blocco scroll del body (come Dialog). Senza dipendenze di proposito: il cleanup dei Dialog annidati (ConfirmDialog)
  // imposta overflow='unset' a ogni render, quindi il lock si riapplica a ogni commit; si rilascia solo allo smontaggio.
  useEffect(() => { document.body.style.overflow = 'hidden'; });
  useEffect(() => () => { document.body.style.overflow = 'unset'; }, []);

  useEffect(() => {
    if (confirm) return; // l'Esc del ConfirmDialog chiude solo lui
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirm, busy, onClose]);

  // Dopo ogni azione, riuscita o no, il dettaglio e la lista si rileggono: lo stato lato server puo essere cambiato
  const run = async (fn: () => Promise<unknown>, release: boolean, okKey: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      toast.success(t(okKey));
    } catch (e) {
      setActionError(actionErrorKey(e, release));
    } finally {
      setBusy(false);
    }
    await reload();
    onChanged();
  };

  const approve = () => run(() => api.post(`${BASE}/${id}/approve`), false, 'admin.vaultRecovery.approved');
  const rejectNow = () => {
    const r = reason.trim();
    setReason('');
    return run(() => api.post(`${BASE}/${id}/reject`, { reason: r }), false, 'admin.vaultRecovery.rejected');
  };
  // La passphrase del file root lascia lo stato PRIMA dell'await e passa da api.post: useMutation la terrebbe nella mutation cache.
  const releaseNow = () => {
    const pass = passphrase;
    setPassphrase('');
    return run(() => api.post(`${BASE}/${id}/release`, { passphrase: pass }), true, 'admin.vaultRecovery.releasedOk');
  };

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString(i18n.language) : '-');
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="col-span-2 break-words text-neutral-900 dark:text-white">{value}</dd>
    </div>
  );
  const err = actionError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(`admin.vaultRecovery.errors.${actionError}`)}</p>;

  const d = detail;
  const self = !!d && d.userId === me;
  const notBeforeMs = d?.notBefore ? new Date(d.notBefore).getTime() - Date.now() : 0;
  const reasonOk = reason.trim().length >= 1 && reason.length <= REASON_MAX;

  return (
    <>
    {/* Portal come Dialog: dentro AppLayout (safe-area-top) il fixed non copre l'intero viewport */}
    {createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 dark:bg-black/70" onClick={() => !busy && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vr-detail-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 shadow-xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600 sm:hidden" aria-hidden="true" />
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 id="vr-detail-title" className="text-xl font-bold text-neutral-900 dark:text-white">{t('admin.vaultRecovery.detail.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {loadFailed && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">{t('admin.vaultRecovery.loadFailed')}</p>}
        {!d && !loadFailed && <p role="status" className="text-sm text-neutral-500">{t('common.loading')}</p>}

        {d && (
          <div className="space-y-5">
            <dl className="space-y-2">
              {row(t('admin.vaultRecovery.detail.email'), d.userEmail ?? d.userId)}
              {row(t('admin.vaultRecovery.detail.status'), <StatusBadge status={d.status} />)}
              {row(t('admin.vaultRecovery.detail.created'), fmt(d.createdAt))}
              {row(t('admin.vaultRecovery.detail.expires'), fmt(d.expiresAt))}
              {row(t('admin.vaultRecovery.detail.ip'), d.requestIp ?? '-')}
              {row(t('admin.vaultRecovery.detail.ua'), d.requestUserAgent ?? '-')}
              {row(t('admin.vaultRecovery.detail.fingerprint'), d.fingerprint ?? '-')}
              {row(t('admin.vaultRecovery.detail.reason'), d.reason || t('admin.vaultRecovery.detail.noReason'))}
              {row(t('admin.vaultRecovery.detail.attempts'), d.attempts)}
              {d.notBefore && row(t('admin.vaultRecovery.detail.notBefore'), fmt(d.notBefore))}
              {d.rejectReason && row(t('admin.vaultRecovery.detail.rejectReason'), d.rejectReason)}
              {row(t('admin.vaultRecovery.detail.keyring'), d.keyringStatus ?? '-')}
              {row(t('admin.vaultRecovery.detail.rootKey'), d.rootKeyId ?? '-')}
            </dl>

            <Button type="button" variant="secondary" className="w-full sm:w-auto min-h-[44px]" onClick={() => onHistory(d.userId)}>
              {t('admin.vaultRecovery.detail.history')}
            </Button>

            {d.status === 'PENDING_APPROVAL' && (
              <div className="space-y-4 border-t border-neutral-200 dark:border-neutral-700 pt-4">
                <Button type="button" variant="primary" className="w-full min-h-[44px]" disabled={busy} onClick={approve}>
                  {t('admin.vaultRecovery.approve')}
                </Button>
                <div className="space-y-2">
                  <label htmlFor="vr-reject-reason" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('admin.vaultRecovery.rejectReason')}</label>
                  <textarea
                    id="vr-reject-reason"
                    value={reason}
                    maxLength={REASON_MAX}
                    rows={3}
                    onChange={(e) => setReason(e.target.value)}
                    className={INPUT}
                  />
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('admin.vaultRecovery.rejectHint', { max: REASON_MAX })}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full min-h-[44px] text-red-600 dark:text-red-400"
                    disabled={busy || !reasonOk}
                    onClick={() => setConfirm('reject')}
                  >
                    {t('admin.vaultRecovery.reject')}
                  </Button>
                </div>
              </div>
            )}

            {d.status === 'WAITING' && (
              <div className="space-y-3 border-t border-neutral-200 dark:border-neutral-700 pt-4">
                <h3 className="flex items-center gap-2 font-semibold text-neutral-900 dark:text-white">
                  <KeyRound size={18} aria-hidden="true" />
                  {t('admin.vaultRecovery.releaseTitle')}
                </h3>
                {d.readyForRelease ? (
                  <form onSubmit={(e) => { e.preventDefault(); if (passphrase && !busy) setConfirm('release'); }} className="space-y-3">
                    {self && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">{t('admin.vaultRecovery.selfWarning')}</p>}
                    <label htmlFor="vr-passphrase" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('admin.vaultRecovery.passphrase')}</label>
                    <input
                      id="vr-passphrase"
                      type="password"
                      autoComplete="one-time-code"
                      data-1p-ignore
                      data-lpignore="true"
                      data-bwignore
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      className={INPUT}
                    />
                    <Button type="submit" variant="primary" className="w-full min-h-[44px]" disabled={busy || !passphrase}>
                      {t('admin.vaultRecovery.release')}
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {t('admin.vaultRecovery.availableFrom', { date: fmt(d.notBefore), hours: Math.max(1, Math.ceil(notBeforeMs / 3_600_000)) })}
                  </p>
                )}
              </div>
            )}

            {err}

            <div className="space-y-2 border-t border-neutral-200 dark:border-neutral-700 pt-4">
              <h3 className="font-semibold text-neutral-900 dark:text-white">{t('admin.vaultRecovery.detail.audit')}</h3>
              {d.audit && d.audit.length > 0 ? (
                <ul className="space-y-1 text-sm text-neutral-700 dark:text-neutral-300">
                  {d.audit.map((a, i) => (
                    <li key={`${a.event}-${a.createdAt}-${i}`} className="break-words">
                      <span className="text-neutral-500 dark:text-neutral-400">{fmt(a.createdAt)}</span> {a.event}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-neutral-500">{t('admin.vaultRecovery.detail.noAudit')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
    )}

      <ConfirmDialog
        isOpen={confirm === 'reject'}
        onClose={() => setConfirm(null)}
        onConfirm={() => { void rejectNow(); }}
        title={t('admin.vaultRecovery.rejectConfirmTitle')}
        message={t('admin.vaultRecovery.rejectConfirmMessage')}
        confirmText={t('admin.vaultRecovery.rejectConfirm')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
      <ConfirmDialog
        isOpen={confirm === 'release'}
        onClose={() => setConfirm(null)}
        onConfirm={() => { void releaseNow(); }}
        title={t('admin.vaultRecovery.releaseConfirmTitle')}
        message={t(self ? 'admin.vaultRecovery.releaseConfirmSelf' : 'admin.vaultRecovery.releaseConfirmMessage')}
        confirmText={t('admin.vaultRecovery.releaseConfirm')}
        cancelText={t('common.cancel')}
      />
    </>
  );
}

export default function VaultRecoveryTab() {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<Filter>('open');
  const [userId, setUserId] = useState('');
  const [items, setItems] = useState<RecoveryView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const seq = useRef(0);

  const userIdInvalid = userId !== '' && !UUID_RE.test(userId);
  const activeUser = userId !== '' && !userIdInvalid ? userId : undefined;

  const load = useCallback(async () => {
    const my = ++seq.current;
    const base = { limit: 50, ...(activeUser ? { userId: activeUser } : {}) };
    try {
      // il backend filtra per un solo stato: "aperte" = un GET per stato aperto, unite per data
      const lists = filter === 'open'
        ? await Promise.all(OPEN.map((status) => api.get(BASE, { params: { ...base, status } })))
        : [await api.get(BASE, { params: filter === 'all' ? base : { ...base, status: filter } })];
      if (my !== seq.current) return;
      const merged = lists.flatMap((r) => r.data.items as RecoveryView[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setItems(merged);
      setFailed(false);
    } catch {
      if (my === seq.current) setFailed(true);
    }
  }, [filter, activeUser]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch asincrono: lo stato si imposta dopo l'await
    void load();
  }, [load]);

  const showHistory = (uid: string) => {
    setUserId(uid);
    setFilter('all');
    setOpenId(null);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4 sm:p-6 dark:bg-neutral-800 dark:border-neutral-700/40">
        <h3 className="font-semibold mb-4 text-neutral-900 dark:text-white flex items-center gap-2">
          <KeyRound size={20} aria-hidden="true" /> {t('admin.vaultRecovery.title')}
        </h3>

        <div className="grid gap-3 sm:grid-cols-2 mb-4">
          <div>
            <label htmlFor="vr-filter" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('admin.vaultRecovery.filterLabel')}</label>
            <select id="vr-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className={INPUT}>
              <option value="open">{t('admin.vaultRecovery.filterOpen')}</option>
              <option value="all">{t('admin.vaultRecovery.filterAll')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`admin.vaultRecovery.status.${s}`)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="vr-user" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('admin.vaultRecovery.userIdLabel')}</label>
            <input id="vr-user" type="text" value={userId} onChange={(e) => setUserId(e.target.value.trim())} autoComplete="off" spellCheck={false} className={INPUT} />
            {userIdInvalid && <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">{t('admin.vaultRecovery.userIdInvalid')}</p>}
          </div>
        </div>

        {failed && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">{t('admin.vaultRecovery.loadFailed')}</p>}
        {items && items.length === 0 && <p className="text-sm text-neutral-500">{t('admin.vaultRecovery.empty')}</p>}
        {items && items.length > 0 && (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-700">
            {items.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className="w-full min-h-[44px] py-3 text-left flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
                >
                  <span className="font-medium text-neutral-900 dark:text-white break-all">{r.userEmail ?? r.userId}</span>
                  <StatusBadge status={r.status} />
                  <span className="text-sm text-neutral-500 dark:text-neutral-400">{new Date(r.createdAt).toLocaleString(i18n.language)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {openId && <DetailSheet key={openId} id={openId} onClose={() => setOpenId(null)} onChanged={() => { void load(); }} onHistory={showHistory} />}
    </div>
  );
}
