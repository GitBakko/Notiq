import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { useCancelReset } from '../../hooks/useCancelReset';
import { useOnline } from '../../hooks/useOnline';
import { formatDateTimeMedium } from '../../utils/format';

/** Gate `resetPending` di VaultPage (P3): il vault e' bloccato in attesa della cancellazione definitiva; si puo' annullare (solo online). Stesso layout di VaultUnlock. */
export default function ResetPendingScreen({ scheduledAt }: { scheduledAt: string | null }) {
  const { t, i18n } = useTranslation();
  const { cancel, busy, error } = useCancelReset();
  const online = useOnline();
  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <div role="status" className="bg-white dark:bg-neutral-800 p-5 sm:p-8 rounded-xl shadow-lg max-w-md w-full text-center border border-neutral-200/60 dark:border-neutral-700/40">
        <div className="bg-neutral-100 dark:bg-neutral-700 p-4 rounded-full inline-flex mb-4">
          <Lock size={32} className="text-neutral-600 dark:text-neutral-400" aria-hidden="true" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.reset.pending.title')}</h2>
        <p className="text-neutral-500 dark:text-neutral-400">
          {scheduledAt ? t('vault.reset.pending.text', { date: formatDateTimeMedium(scheduledAt, i18n.language) }) : t('vault.reset.pending.textNoDate')}
        </p>
        {!online && <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">{t('vault.reset.pending.offline')}</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
        <Button variant="secondary" onClick={() => { void cancel(); }} disabled={busy || !online} isLoading={busy} className="w-full min-h-[44px] mt-6">
          {t('vault.reset.cancel')}
        </Button>
      </div>
    </div>
  );
}
