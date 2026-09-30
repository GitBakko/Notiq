import { useTranslation } from 'react-i18next';
import { ArrowLeft, Lock, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';

interface Props {
  loading?: boolean;
  emptyOnServer?: boolean;
  gone?: boolean;
  onRetry?: () => void;
  onBack?: () => void;
}

export default function VaultNotLoaded({ loading, emptyOnServer, gone, onRetry, onBack }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-neutral-500 dark:text-neutral-400">
      {loading ? <Loader2 size={40} className="mb-4 animate-spin opacity-40" /> : <Lock size={40} className="mb-4 opacity-30" />}
      {!loading && <p className="mb-4">{t(gone ? 'vault.itemNotFound' : emptyOnServer ? 'vault.itemEmptyOnServer' : 'vault.notLoaded')}</p>}
      <div className="flex gap-2">
        {onBack && (
          <Button variant="ghost" onClick={onBack} className="min-h-[44px]">
            <ArrowLeft size={16} className="mr-2" />
            {t('common.back')}
          </Button>
        )}
        {!loading && !emptyOnServer && !gone && onRetry && (
          <Button variant="secondary" onClick={onRetry} className="min-h-[44px]">
            {t('vault.notLoadedRetry')}
          </Button>
        )}
      </div>
    </div>
  );
}
