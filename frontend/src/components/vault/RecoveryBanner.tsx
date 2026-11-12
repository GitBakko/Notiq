import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOpenRecovery } from '../../hooks/useOpenRecovery';
import { cancelRecovery, VaultApiError, type OpenRecovery } from '../../lib/vaultApi';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Button } from '../ui/Button';

// 409 = gia' annullata altrove o stato non annullabile, 410 = scaduta: in entrambi i casi la richiesta non e' piu' attiva
const GONE_KEY: Record<number, string> = {
  409: 'errors.vault.recoveryStateConflict',
  410: 'errors.vault.recoveryExpired',
};

const STATE_KEY: Record<OpenRecovery['status'], string> = {
  PENDING_APPROVAL: 'pendingApproval',
  PENDING_CODE: 'pendingCode',
  WAITING: 'waiting',
  RELEASED: 'released',
};

/**
 * Banner non chiudibile: finche' c'e' un recupero vault aperto, ogni sessione lo vede e puo' annullarlo (spec vault v3,
 * difesa contro un recupero non voluto). Si spegne solo quando il server non riporta piu' la richiesta.
 */
export default function RecoveryBanner() {
  const { t, i18n } = useTranslation();
  const { openRecovery, refresh, markCancelled } = useOpenRecovery();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; status: string; key: string } | null>(null);
  const [, setTick] = useState(0);
  const waiting = openRecovery?.status === 'WAITING';

  // il conto alla rovescia si calcola al render: senza un tick resterebbe indietro fino al prossimo refresh (15 min)
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [waiting]);

  if (!openRecovery) return null;

  const key = `vault.recoveryBanner.states.${STATE_KEY[openRecovery.status]}`;
  const args: Record<string, string | number> = { fingerprint: openRecovery.fingerprint };
  let waitDue = false;
  if (openRecovery.status === 'WAITING' && openRecovery.notBefore) {
    const ms = new Date(openRecovery.notBefore).getTime() - Date.now();
    args.date = new Date(openRecovery.notBefore).toLocaleString(i18n.language);
    args.hours = Math.max(1, Math.ceil(ms / 3_600_000));
    waitDue = ms <= 0;
  }

  const { id, status } = openRecovery;
  const errorKey = error?.id === id && error.status === status ? error.key : null; // l'errore vale solo per la richiesta (e lo stato) su cui e' comparso

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await cancelRecovery(id);
      markCancelled(id); // il banner sparisce anche se il refresh di conferma fallisce
      await refresh();
    } catch (e) {
      const gone = e instanceof VaultApiError ? GONE_KEY[e.status] : undefined;
      // 409/410: la richiesta non e' piu' attiva; il refresh toglie il banner (se resta, spiega perche')
      if (gone) await refresh();
      setError({ id, status, key: gone ?? 'vault.recoveryBanner.cancelError' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="flex-shrink-0 z-30 flex flex-col gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center dark:border-amber-800/50 dark:bg-amber-950/40"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-amber-900 dark:text-amber-100">{t(`${key}.title`)}</p>
          <p className="break-words text-amber-800 dark:text-amber-200">{t(waitDue ? `${key}.textDue` : `${key}.text`, args)}</p>
          {errorKey && <p className="mt-1 text-red-700 dark:text-red-400">{t(errorKey)}</p>}
        </div>
      </div>
      <Button variant="secondary" className="min-h-[44px] w-full flex-shrink-0 sm:w-auto" disabled={busy} onClick={() => setConfirming(true)}>
        {t('vault.recoveryBanner.cancel')}
      </Button>
      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={onConfirm}
        title={t('vault.recoveryBanner.confirmTitle')}
        message={t('vault.recoveryBanner.confirmMessage')}
        confirmText={t('vault.recoveryBanner.confirmAction')}
        cancelText={t('vault.recoveryBanner.keep')}
        variant="danger"
      />
    </div>
  );
}
