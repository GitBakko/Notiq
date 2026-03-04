import { useTranslation } from 'react-i18next';

export default function PageLoader() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex items-center justify-center h-full bg-white dark:bg-neutral-950">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600 mx-auto" />
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
          {t('common.loading')}
        </p>
      </div>
    </div>
  );
}
