import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';

export default function NetworkStatusIndicator() {
  const { t } = useTranslation();
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Only show when offline
  if (isOnline) return null;

  return (
    <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border-b border-red-200 dark:border-red-900/40">
      <WifiOff size={12} aria-hidden="true" />
      <span>{t('network.offline')}</span>
    </div>
  );
}
