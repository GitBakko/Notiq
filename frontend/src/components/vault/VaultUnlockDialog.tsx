import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Unlock } from 'lucide-react';
import BottomSheet from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { useAuthStore } from '../../store/authStore';
import { unlockOnline, VaultSessionError } from '../../lib/vaultSession';

// Vault v3 (T21, plan 5.9 passo 0): sblocco col PIN dal punto in cui l'utente vuole mettere una nota nel vault.
// Solo online (lo spostamento lo e'). Sta in components/: le feature non si importano fra loro.

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function VaultUnlockDialog({ isOpen, onClose, onUnlocked }: Props) {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false); // `busy` e' stato React: due submit nello stesso tick (Enter + click) passerebbero entrambi
  const [error, setError] = useState<string | null>(null);
  const [lockedMs, setLockedMs] = useState(0); // ponytail: istantanea al momento dell'errore, senza conto alla rovescia (la pagina /vault lo ha)

  useEffect(() => {
    if (!isOpen) { setPin(''); setError(null); setLockedMs(0); }
  }, [isOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId || submitting.current || !pin) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setLockedMs(0);
    try {
      await unlockOnline(userId, pin);
      setPin('');
      onUnlocked();
    } catch (err) {
      if (err instanceof VaultSessionError && err.code === 'pinLocked' && err.lockedUntil) {
        const ms = Date.parse(err.lockedUntil) - Date.now();
        if (ms > 0) setLockedMs(ms);
      }
      const key = err instanceof VaultSessionError && err.code === 'wrongPin'
        ? 'errors.vault.invalidPin'
        : (err as { key?: unknown } | null)?.key;
      setError(typeof key === 'string' && key.startsWith('errors.') ? key : 'errors.common.unknownError');
      setPin('');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={t('vault.moveIn.unlockTitle')}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('vault.moveIn.unlockDescription')}</p>
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
          autoFocus
          className="w-full min-h-[44px] px-4 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white text-neutral-900 dark:bg-neutral-700 dark:border-neutral-600 dark:text-white"
        />
        {lockedMs > 0 && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{t('vault.unlock.lockedFor', { time: fmt(lockedMs) })}</p>
        )}
        {error && lockedMs === 0 && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>
        )}
        <div className="flex justify-end gap-3 pb-[env(safe-area-inset-bottom)]">
          <Button type="button" variant="ghost" className="min-h-[44px]" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" className="min-h-[44px]" isLoading={busy} disabled={!pin}>
            <Unlock size={18} className="mr-2" aria-hidden="true" />
            {t('vault.unlockButton')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
