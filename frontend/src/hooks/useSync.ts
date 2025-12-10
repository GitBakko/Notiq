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


  // Periodic PULL (and initial sync)
  useEffect(() => {
    if (!token) return;

    const runPull = async () => {
      try {
        await syncPull();
      } catch (error) {
        console.error('Periodic Pull failed:', error);
      }
    };

    // Initial pull on mount
    runPull();

    // Periodic pull every 30s
    const intervalId = setInterval(runPull, 30000);

    return () => clearInterval(intervalId);
  }, [token]);
}
