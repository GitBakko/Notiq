import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';
import { Button } from '../../components/ui/Button';

interface Props {
  onRetry: () => void;
  retrying?: boolean;
}

/** Stato UNKNOWN del vault (piano 5.3): il keyring non e' raggiungibile e non c'e' una copia locale. Mai il setup, mai un purge. */
export default function VaultOfflineNotice({ onRetry, retrying = false }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-4 bg-neutral-50 dark:bg-neutral-900">
      <div role="status" className="w-full max-w-sm text-center bg-white dark:bg-neutral-800 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
          <WifiOff size={28} aria-hidden="true" />
        </div>
        <h2 className="text-xl font-bold mb-2 text-neutral-900 dark:text-white">{t('vault.offline.title')}</h2>
        <p className="text-neutral-500 dark:text-neutral-400 mb-6">{t('vault.offline.body')}</p>
        <Button onClick={onRetry} disabled={retrying} className="w-full min-h-[44px]">
          {t('vault.offline.retry')}
        </Button>
      </div>
    </div>
  );
}
