import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, AlertTriangle, WifiOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { useAuthStore } from '../../store/authStore';
import { setup } from '../../lib/vaultSession';
import { getActiveRootKey } from '../../utils/vaultRootKeys';
import { checkPin } from './PinPolicy';
import PinInput from './PinInput';
import RecoveryKitSheet from './RecoveryKitSheet';

interface Props {
  /** Il vault esisteva gia' (creato da un altro dispositivo): il keyring e' in cache, serve lo sblocco. */
  onAlreadySetup?: () => void;
  /** Kit confermato: il vault e' creato e sbloccato. */
  onDone?: () => void;
}

const INPUT =
  'w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white';

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

export default function VaultSetup({ onAlreadySetup, onDone }: Props = {}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const online = useOnline();
  const rootKey = getActiveRootKey();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [password, setPassword] = useState('');
  const [offlineUnlock, setOfflineUnlock] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySetup, setAlreadySetup] = useState(false);
  // Il Kit esiste solo qui, dopo il 201, e solo in questo stato.
  const [kit, setKit] = useState<Uint8Array | null>(null);

  // Guardia sincrona: due submit nello stesso tick passerebbero entrambi `busy` (lo stato React non e' ancora aggiornato).
  const submitting = useRef(false);

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current || busy || !user || !rootKey || !online) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let attempted = false;
    try {
      const check = await checkPin(pin, { name: user.name, surname: user.surname, email: user.email });
      if (!check.ok) return setError(`vault.pinPolicy.${check.reason}`);
      if (pin !== confirmPin) return setError('vault.pinMismatch');
      attempted = true;
      const res = await setup({ userId: user.id, pin, password, rootKey, offlineUnlock });
      if (!res.ok) {
        setAlreadySetup(true);
        onAlreadySetup?.();
      } else {
        if (!res.offlineSaved) toast.error(t('vault.setup.offlineNotSaved'));
        setKit(res.kit);
      }
    } catch (err) {
      setError(errKey(err));
    } finally {
      submitting.current = false;
      setBusy(false);
      if (attempted) setPassword('');
    }
  };

  const finished = () => {
    setKit(null);
    setPin('');
    setConfirmPin('');
    toast.success(t('vault.setupSuccess'));
    onDone?.();
  };

  const disabled = !rootKey; // T25 riempie utils/vaultRootKeys.ts

  return (
    <div className="h-full overflow-y-auto p-4 [-webkit-overflow-scrolling:touch]">
      <div className="flex min-h-full flex-col items-center justify-center">
        <div className="bg-white dark:bg-neutral-800 p-5 sm:p-8 rounded-xl shadow-lg max-w-md w-full text-center border border-neutral-200/60 dark:border-neutral-700/40">
        <div className="bg-emerald-100 dark:bg-emerald-900/30 p-4 rounded-full inline-flex mb-4">
          <Lock size={32} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.setupTitle')}</h2>
        <p className="text-neutral-500 dark:text-neutral-400 mb-6">{t('vault.setupDescription')}</p>

        {disabled ? (
          <div role="alert" className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 text-left text-sm text-amber-800 dark:text-amber-300">
            {t('errors.vault.setupDisabled')}
          </div>
        ) : alreadySetup ? (
          <div role="status" className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-lg p-4 text-left text-sm text-emerald-800 dark:text-emerald-300">
            {t('vault.setup.alreadySetup')}
          </div>
        ) : (
          <>
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4 mb-6 text-left">
              <div className="flex items-start gap-3">
                <AlertTriangle className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" size={20} aria-hidden="true" />
                <div>
                  <h3 className="font-semibold text-amber-800 dark:text-amber-300 mb-1">{t('vault.setup.riskTitle')}</h3>
                  <p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.setup.riskBody')}</p>
                </div>
              </div>
            </div>

            {!online && (
              <div role="alert" className="flex items-start gap-2 mb-4 text-left text-sm text-neutral-700 dark:text-neutral-300">
                <WifiOff size={18} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
                <span>{t('vault.setup.offline')}</span>
              </div>
            )}

            <form onSubmit={handleSetup} className="space-y-4">
              <p className="text-xs text-left text-neutral-500 dark:text-neutral-400">{t('vault.setup.pinRules')}</p>
              <PinInput value={pin} onChange={setPin} label={t('vault.enterPin')} autoComplete="new-password" className={INPUT} autoFocus />
              <PinInput value={confirmPin} onChange={setConfirmPin} label={t('vault.confirmPin')} autoComplete="new-password" className={INPUT} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('vault.setup.accountPassword')}
                aria-label={t('vault.setup.accountPassword')}
                autoComplete="off"
                className={INPUT}
              />

              <label className="flex items-start gap-3 text-left cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  checked={offlineUnlock}
                  onChange={(e) => setOfflineUnlock(e.target.checked)}
                  className="mt-1 h-5 w-5 rounded border-neutral-300 text-emerald-600 focus:ring-emerald-500 dark:border-neutral-600 dark:bg-neutral-700"
                />
                <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.setup.offlineUnlock')}</span>
              </label>

              <label className="flex items-start gap-3 text-left cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-1 h-5 w-5 rounded border-neutral-300 text-emerald-600 focus:ring-emerald-500 dark:border-neutral-600 dark:bg-neutral-700"
                />
                <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('vault.setup.riskAck')}</span>
              </label>

              {error && (
                <p role="alert" className="text-sm text-left text-red-600 dark:text-red-400">{t(error)}</p>
              )}

              <Button
                type="submit"
                variant="primary"
                className="w-full min-h-[44px]"
                isLoading={busy}
                disabled={!ack || !online || !pin || !confirmPin || !password}
              >
                {t('vault.setupButton')}
              </Button>
            </form>
          </>
        )}
        </div>
      </div>

      {kit && user && <RecoveryKitSheet kit={kit} userId={user.id} onDone={finished} />}
    </div>
  );
}
