import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Unlock, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { useAuthStore } from '../../store/authStore';
import { useVaultStore } from '../../store/vaultStore';
import { unlockOffline, unlockOnline, VaultSessionError } from '../../lib/vaultSession';

interface Props {
  onUnlocked?: () => void;
  /** "alreadySetup": il vault esisteva gia' (creato da un altro dispositivo), mostrato sopra il form. */
  notice?: 'alreadySetup';
}

/** Rete assente o server non raggiungibile (VaultApiError status 0 / 503): si puo' ripiegare sullo sblocco offline. */
const isUnreachable = (e: unknown) => {
  const x = e as { name?: string; status?: number } | null;
  return x?.name === 'VaultApiError' && (x.status === 0 || x.status === 503);
};

const errKey = (e: unknown) => {
  if (e instanceof VaultSessionError && e.code === 'wrongPin') return 'errors.vault.invalidPin';
  const k = (e as { key?: unknown } | null)?.key;
  return typeof k === 'string' && k.startsWith('errors.') ? k : 'errors.common.unknownError';
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function VaultUnlock({ onUnlocked, notice }: Props = {}) {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const cache = useVaultStore((s) => (userId ? s.byUser[userId] : undefined));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showForgot, setShowForgot] = useState(false);
  const submitting = useRef(false); // doppio submit nello stesso tick: `busy` (stato) non fa in tempo

  const remaining = lockedUntil ? lockedUntil - now : 0;
  const locked = remaining > 0;

  useEffect(() => {
    if (!lockedUntil) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= lockedUntil) {
        setLockedUntil(null); // lockedUntil <= now = sbloccato
        setError(null); // niente 'locked' stantio quando il blocco scade
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current || !userId || busy || locked || !pin) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const canOffline = !!(cache?.offlineUnlock && cache.wrappedVkPin);
      if (!navigator.onLine) await unlockOffline(userId, pin);
      else {
        try {
          const r = await unlockOnline(userId, pin);
          if (!r.offlineSaved) toast.error(t('vault.setup.offlineNotSaved'));
        } catch (err) {
          if (canOffline && isUnreachable(err)) await unlockOffline(userId, pin);
          else throw err;
        }
      }
      setPin('');
      toast.success(t('vault.unlocked'));
      onUnlocked?.();
    } catch (err) {
      if (err instanceof VaultSessionError && err.code === 'pinLocked' && err.lockedUntil) {
        const until = Date.parse(err.lockedUntil);
        setNow(Date.now());
        setLockedUntil(Number.isFinite(until) ? until : null);
      }
      setError(errKey(err));
      setPin('');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <div className="bg-white dark:bg-neutral-800 p-5 sm:p-8 rounded-xl shadow-lg max-w-md w-full text-center border border-neutral-200/60 dark:border-neutral-700/40">
        <div className="bg-neutral-100 dark:bg-neutral-700 p-4 rounded-full inline-flex mb-4">
          <Lock size={32} className="text-neutral-600 dark:text-neutral-400" aria-hidden="true" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.lockedTitle')}</h2>
        <p className="text-neutral-500 dark:text-neutral-400 mb-6">{t('vault.lockedDescription')}</p>

        {notice === 'alreadySetup' && (
          <div role="status" className="mb-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-lg p-4 text-left text-sm text-emerald-800 dark:text-emerald-300">
            {t('vault.setup.alreadySetup')}
          </div>
        )}

        <form onSubmit={handleUnlock} className="space-y-4">
          <input type="text" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('vault.enterPin')}
            aria-label={t('vault.enterPin')}
            autoComplete="current-password"
            autoCapitalize="off"
            spellCheck={false}
            disabled={locked}
            className="w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white disabled:opacity-50"
            autoFocus
          />

          {locked && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
              {t('vault.unlock.lockedFor', { time: fmt(remaining) })}
            </p>
          )}
          {error && !locked && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>
          )}

          <Button type="submit" variant="primary" className="w-full min-h-[44px]" isLoading={busy} disabled={locked || !pin}>
            <Unlock size={18} className="mr-2" aria-hidden="true" />
            {t('vault.unlockButton')}
          </Button>
        </form>

        {/* D5: in P2 nessun recupero del PIN e nessun reset locale. */}
        <button
          type="button"
          onClick={() => setShowForgot((v) => !v)}
          aria-expanded={showForgot}
          className="mt-4 min-h-[44px] px-2 text-sm text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
        >
          {t('vault.forgotPin')}
        </button>
        {showForgot && (
          <div className="mt-2 flex items-start gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/40 p-4 text-left">
            <Info size={18} className="flex-shrink-0 mt-0.5 text-neutral-500 dark:text-neutral-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1">{t('vault.unlock.forgotTitle')}</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.unlock.forgotBody')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
