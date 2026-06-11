import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { syncPull, syncPush } from '../features/sync/syncService';
import { useAuthStore } from '../store/authStore';

export function useSync() {
  const { token } = useAuthStore();

  // Reactive Sync: Watch for pending items in the queue
  const pendingCount = useLiveQuery(() => db.syncQueue.count(), []);

  // Trigger PUSH whenever there are pending items
  useEffect(() => {
    if (!token || !pendingCount) return;

    const runPush = async () => {
      // Small delay to allow batching if multiple updates happen instanly?
      // syncPush processes the whole queue anyway.
      try {
        await syncPush();
      } catch (error) {
        console.error('Auto-Push failed:', error);
      }
    };

    runPush();
  }, [pendingCount, token]);


  // Periodic PULL + PUSH retry (and initial sync)
  useEffect(() => {
    if (!token) return;

    const runSync = async () => {
      try {
        await syncPull();
      } catch (error) {
        console.error('Periodic Pull failed:', error);
      }
      // Retry kick for the push queue: the count-based effect above only fires when the
      // queue CHANGES, so items stuck after a connectivity loss would otherwise wait for
      // the next user edit. syncPush is cheap when the queue is empty or in backoff.
      try {
        await syncPush();
      } catch (error) {
        console.error('Periodic Push retry failed:', error);
      }
    };

    // Initial sync on mount
    runSync();

    // Periodic sync every 30s
    const intervalId = setInterval(runSync, 30000);

    return () => clearInterval(intervalId);
  }, [token]);
}
