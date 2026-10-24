import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, Lock, RefreshCw, WifiOff, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useAuthStore } from '../../store/authStore';
import { useVaultStore } from '../../store/vaultStore';
import { changePin, regenerateKit } from '../../lib/vaultSession';
import { vaultReconcile, type ReconcileResult } from '../../lib/vaultReconcile';
import { syncPush } from '../sync/syncService';
import { getActiveRootKey } from '../../utils/vaultRootKeys';
import { checkPin } from './PinPolicy';
import PinInput from './PinInput';
import RecoveryKitSheet from './RecoveryKitSheet';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Esito del controllo: la pagina aggiorna il proprio banner "da aggiornare" prima che il foglio si chiuda. */
  onLegacyLeft?: (n: number) => void;
}

const INPUT =
  'w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white';

const ALERT = 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300';

const errKey = (e: unknown) => {
  const k = (e as { key?: unknown } | null)?.key;
  return typeof k === 'string' && k.startsWith('errors.') ? k : 'errors.common.unknownError';
};

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/**
 * Impostazioni vault (piano 5.4), da sbloccato: cambio PIN, rigenerazione del Kit (entrambi chiedono il PIN attuale) e controllo degli
 * elementi da aggiornare (reconcile, con banner legacyLeft e motivi unresolved).
 * Il Kit esiste solo nello stato di questo componente, e solo dopo il PUT riuscito (lo mostra RecoveryKitSheet).
 */
export default function VaultSettingsSheet({ isOpen, onClose, onLegacyLeft }: Props) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const unlocked = useVaultStore((s) => !!user && s.unlockedUserId === user.id);
  const online = useOnline();
  const ref = useRef<HTMLDivElement>(null);
  const rootKey = getActiveRootKey();

  const [curPin, setCurPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const pinSubmitting = useRef(false); // doppio invio nello stesso tick: `pinBusy` (stato) non fa in tempo, e checkPin e' asincrona (J.4)

  const [kitPin, setKitPin] = useState('');
  const [kitError, setKitError] = useState<string | null>(null);
  const [kitBusy, setKitBusy] = useState(false);
  const [kit, setKit] = useState<Uint8Array | null>(null);

  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  const closeGen = useRef(0); // cambia a ogni chiusura: un controllo partito prima non scrive l'esito dopo
  const busy = pinBusy || kitBusy;
  useFocusTrap(ref, isOpen && !kit);

  useEffect(() => {
    if (isOpen) return;
    closeGen.current++;
    setCurPin(''); setNewPin(''); setNewPin2(''); setKitPin(''); setPinError(null); setKitError(null); setResult(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || kit) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, kit, busy, onClose]);

  // Prima del guard su isOpen: una chiusura del padre durante la cerimonia non smonta RecoveryKitSheet (smontare azzera il buffer del Kit).
  // Il keep-alive dell'auto-lock durante la cerimonia sta dentro RecoveryKitSheet.
  if (kit && user) {
    return (
      <RecoveryKitSheet
        kit={kit}
        userId={user.id}
        onDone={() => {
          setKit(null);
          toast.success(t('vault.settings.kitDone'));
        }}
      />
    );
  }

  if (!isOpen || !user) return null;

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pinSubmitting.current || pinBusy || !unlocked || !online) return;
    pinSubmitting.current = true;
    setPinBusy(true);
    setPinError(null);
    try {
      const check = await checkPin(newPin, { name: user.name, surname: user.surname, email: user.email });
      if (!check.ok) return setPinError(`vault.pinPolicy.${check.reason}`);
      if (newPin !== newPin2) return setPinError('vault.pinMismatch');
      await changePin({ userId: user.id, currentPin: curPin, newPin });
      toast.success(t('vault.settings.pinChanged'));
      setCurPin(''); setNewPin(''); setNewPin2('');
    } catch (err) {
      setPinError(errKey(err));
    } finally {
      pinSubmitting.current = false;
      setPinBusy(false);
    }
  };

  const submitKit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (kitBusy || !unlocked || !online || !rootKey) return;
    setKitError(null);
    setKitBusy(true);
    useVaultStore.getState().touchVault();
    try {
      const res = await regenerateKit({ userId: user.id, pin: kitPin, rootKey });
      useVaultStore.getState().touchVault();
      setKit(res.kit); // PUT riuscito: solo ora esiste un Kit da mostrare
    } catch (err) {
      setKitError(errKey(err));
    } finally {
      setKitBusy(false);
      setKitPin('');
    }
  };

  const check = async () => {
    const gen = closeGen.current;
    setChecking(true);
    try {
      const r = await vaultReconcile();
      if (r.conflictsResolved + r.reactivated > 0) void syncPush().catch(() => false); // T-g, come VaultPage: ACK e REQUEUE non svegliano la push reattiva
      if (gen === closeGen.current) setResult(r);
    } catch { toast.error(t('errors.common.unknownError')); } finally { setChecking(false); }
  };
  const hardUnresolved = result ? Math.max(0, result.unresolved - result.later) : 0; // `unresolved` include le rinviate (`later`)

  const field = (id: string, value: string, set: (v: string) => void, label: string, autoComplete: string, autoFocus = false) => (
    <PinInput id={id} value={value} onChange={set} label={label} autoComplete={autoComplete} className={INPUT} autoFocus={autoFocus} />
  );
  const err = (k: string | null) => k && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(k)}</p>;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 dark:bg-black/70" onClick={() => !busy && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-settings-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 shadow-xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600 sm:hidden" aria-hidden="true" />
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 id="vault-settings-title" className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.settings.title')}</h2>
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

        {!unlocked ? (
          <p role="alert" className="text-sm text-neutral-600 dark:text-neutral-400">{t('errors.vault.locked')}</p>
        ) : (
          <div className="space-y-8">
            {!online && (
              <div role="alert" className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                <WifiOff size={18} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span>{t('vault.settings.offline')}</span>
              </div>
            )}

            <form onSubmit={submitPin} className="space-y-3">
              <h3 className="flex items-center gap-2 font-semibold text-neutral-900 dark:text-white">
                <Lock size={18} aria-hidden="true" />
                {t('vault.settings.changePinTitle')}
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.setup.pinRules')}</p>
              {field('vs-cur-pin', curPin, setCurPin, t('vault.settings.currentPin'), 'current-password', true)}
              {field('vs-new-pin', newPin, setNewPin, t('vault.settings.newPin'), 'new-password')}
              {field('vs-new-pin2', newPin2, setNewPin2, t('vault.confirmPin'), 'new-password')}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('vault.settings.pinOfflineNote')}</p>
              {err(pinError)}
              <Button type="submit" variant="primary" className="w-full min-h-[44px]" isLoading={pinBusy} disabled={!online || !curPin || !newPin || !newPin2}>
                {t('vault.settings.changePinButton')}
              </Button>
            </form>

            <form onSubmit={submitKit} className="space-y-3 border-t border-neutral-200 dark:border-neutral-700 pt-6">
              <h3 className="flex items-center gap-2 font-semibold text-neutral-900 dark:text-white">
                <KeyRound size={18} aria-hidden="true" />
                {t('vault.settings.kitTitle')}
              </h3>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.settings.kitBody')}</p>
              {!rootKey && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{t('errors.vault.setupDisabled')}</p>}
              {field('vs-kit-pin', kitPin, setKitPin, t('vault.settings.kitPin'), 'current-password')}
              {err(kitError)}
              <Button type="submit" variant="secondary" className="w-full min-h-[44px]" isLoading={kitBusy} disabled={!online || !rootKey || !kitPin}>
                {t('vault.settings.kitButton')}
              </Button>
            </form>

            <div className="space-y-3 border-t border-neutral-200 dark:border-neutral-700 pt-6">
              <h3 className="flex items-center gap-2 font-semibold text-neutral-900 dark:text-white">
                <RefreshCw size={18} aria-hidden="true" />
                {t('vault.settings.checkTitle')}
              </h3>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.settings.checkDesc')}</p>
              <Button type="button" variant="secondary" className="w-full min-h-[44px]" isLoading={checking} onClick={check}>
                {t('vault.settings.checkButton')}
              </Button>
              {result?.skipped && <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">{t(`vault.settings.skipped.${result.skipped}`)}</p>}
              {result && !result.skipped && result.legacyLeft === 0 && result.unresolved === 0 && (
                <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{t('vault.settings.allUpToDate')}</p>
              )}
              {result && result.legacyLeft > 0 && (
                <div role="alert" className={ALERT}>
                  <p>{t('vault.settings.legacyLeft', { n: result.legacyLeft })}</p>
                  {/* la migrazione sta nella pagina del vault, gia' dietro questo foglio */}
                  <button
                    type="button"
                    onClick={() => { onLegacyLeft?.(result.legacyLeft); onClose(); }}
                    className="inline-flex items-center min-h-[44px] underline text-emerald-700 dark:text-emerald-400"
                  >
                    {t('vault.settings.legacyLeftAction')}
                  </button>
                </div>
              )}
              {result && result.later > 0 && (
                <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.settings.later', { n: result.later })}</p>
              )}
              {hardUnresolved > 0 && (
                <div role="alert" className={ALERT}>
                  <p className="flex items-start gap-2">
                    <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{t('vault.settings.unresolved', { n: hardUnresolved })}</span>
                  </p>
                  <ul className="mt-2 list-disc pl-6 space-y-1">
                    {(['legacyPin', 'epoch', 'tooLarge', 'unchanged'] as const).map((k) => (
                      <li key={k}>{t(`vault.settings.reason.${k}`)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
