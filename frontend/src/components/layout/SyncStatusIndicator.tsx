import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, CloudUpload, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { db } from '../../lib/db';
import type { SyncQueueItem } from '../../lib/db';
import { retryFailedSyncItems } from '../../features/sync/syncService';
import { useAuthStore } from '../../store/authStore';

// Don't flash the banner during the normal debounced-sync window
const PENDING_VISIBLE_AFTER_MS = 15_000;
// One informational toast if items stay pending this long (re-armed when the queue drains)
const PENDING_TOAST_AFTER_MS = 60_000;

export default function SyncStatusIndicator() {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const [isRetrying, setIsRetrying] = useState(false);
  const [, setTick] = useState(0);

  const items = useLiveQuery<SyncQueueItem[]>(
    () => (userId ? db.syncQueue.where('userId').equals(userId).toArray() : Promise.resolve([])),
    [userId]
  );

  const failedCount = items?.filter((i) => i.status === 'failed').length ?? 0;
  const pendingItems = items?.filter((i) => i.status !== 'failed') ?? [];
  const oldestPendingAt = pendingItems.length > 0 ? Math.min(...pendingItems.map((i) => i.createdAt)) : null;
  const pendingAge = oldestPendingAt ? Date.now() - oldestPendingAt : 0;
  const showPending = pendingItems.length > 0 && pendingAge >= PENDING_VISIBLE_AFTER_MS;

  // liveQuery doesn't re-fire as time passes — tick every 5s while items are pending
  useEffect(() => {
    if (pendingItems.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [pendingItems.length]);

  // Toast only on the FIRST transition to failed
  const prevFailedRef = useRef(0);
  useEffect(() => {
    if (failedCount > 0 && prevFailedRef.current === 0) {
      toast.error(t('sync.failedToast'));
    }
    prevFailedRef.current = failedCount;
  }, [failedCount, t]);

  // One toast when items stay pending >60s; re-arm when the queue drains
  const pendingToastShownRef = useRef(false);
  useEffect(() => {
    if (pendingItems.length === 0) {
      pendingToastShownRef.current = false;
      return;
    }
    if (!pendingToastShownRef.current && pendingAge >= PENDING_TOAST_AFTER_MS) {
      pendingToastShownRef.current = true;
      toast(t('sync.pendingToast'), { icon: '⏳' });
    }
  });

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await retryFailedSyncItems();
    } finally {
      setIsRetrying(false);
    }
  };

  if (failedCount > 0) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border-b border-red-200 dark:border-red-900/40">
        <CloudOff size={12} aria-hidden="true" />
        <span>{t('sync.failed', { count: failedCount })}</span>
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="flex items-center gap-1 min-h-[44px] min-w-[44px] px-3 font-semibold hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50"
        >
          <RefreshCw size={12} className={isRetrying ? 'animate-spin' : ''} aria-hidden="true" />
          {t('sync.retry')}
        </button>
      </div>
    );
  }

  if (showPending) {
    return (
      <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 text-xs font-medium border-b border-amber-200 dark:border-amber-900/40">
        <CloudUpload size={12} aria-hidden="true" />
        <span>{t('sync.pending', { count: pendingItems.length })}</span>
      </div>
    );
  }

  return null;
}
