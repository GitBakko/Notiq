import { useCallback, useEffect, useState } from 'react';
import { db } from '../../lib/db';
import { getNote } from '../notes/noteService';

// 'empty' = the server itself confirmed the content is empty (not cached: re-checked on every mount/retry).
// 'gone' = the server answered 404/403 for this item: it no longer exists (or is no longer ours). No Retry.
export type VaultHydrationStatus = 'ready' | 'loading' | 'unavailable' | 'empty' | 'gone';

interface HydratableNote { id: string; content?: string; syncStatus?: string }
interface Res { key: string; v: VaultHydrationStatus }

const FETCH_TIMEOUT_MS = 8000;

const withTimeout = <T,>(p: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

/**
 * A vault row whose content was never loaded on this device (local content '') must not reach an
 * editor: the editor would save its empty state over the real server copy. Only that case is
 * hydrated: placeholder until the server content has been written to the local row (content only).
 * A non-empty local row is 'ready' at once, no fetch: a stale non-empty copy is a known limit,
 * closed by the server compare-and-swap (design doc, P2).
 * The editor is never mounted while a hydration fetch for that item can still write.
 */
export function useVaultHydration(note: HydratableNote | undefined) {
  const id = note?.id;
  // A row created on this device is authoritative; stay out of its way even after its first sync,
  // but only while the same item stays open: a different id (or closing) starts from scratch.
  // Derived state adjusted during render (React's documented pattern), not a ref.
  const [tracked, setTracked] = useState<{ id?: string; created: boolean }>({ created: false });
  if (tracked.id !== id) setTracked({ id, created: note?.syncStatus === 'created' });
  else if (id && !tracked.created && note?.syncStatus === 'created') setTracked({ id, created: true });
  const eligible = !!note && !tracked.created;
  const isEmpty = !note?.content;
  const syncStatus = note?.syncStatus;
  const [res, setRes] = useState<Res | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${id}:${attempt}`;

  useEffect(() => {
    if (!eligible || !id || !isEmpty) { setRes(null); return; }
    let cancelled = false;
    const done = (v: VaultHydrationStatus) => { if (!cancelled) setRes({ key, v }); };
    // Only queued CONTENT can conflict with the server copy; pin/title/tags updates must not block hydration
    const hasPending = () => db.syncQueue.where('entity').equals('NOTE')
      .filter(i => i.entityId === id && i.data?.content !== undefined).count();
    (async () => {
      if (!navigator.onLine) return done('unavailable');
      if ((await hasPending()) > 0) return done('unavailable'); // re-runs when syncStatus changes (push went through)
      let server;
      try { server = await withTimeout(getNote(id)); } catch (e) {
        const s = (e as { response?: { status?: number } })?.response?.status;
        return done(s === 404 || s === 403 ? 'gone' : 'unavailable');
      }
      if (!server.content) return done('empty');
      // Re-check atomically: the row may have been edited/queued while the fetch was in flight
      const written = await db.transaction('rw', db.notes, db.syncQueue, async () => {
        const row = await db.notes.get(id);
        if (!row || row.content || (await hasPending()) > 0) return false;
        await db.notes.update(id, { content: server.content });
        return true;
      });
      done(written ? 'ready' : 'unavailable');
    })().catch(() => done('unavailable'));
    return () => { cancelled = true; };
  }, [eligible, id, isEmpty, syncStatus, attempt, key]);

  const settled = res && res.key === key ? res : null;
  const retryable = settled?.v === 'unavailable';

  // Back online: try again automatically (only while the item is blocked; never under an open editor)
  useEffect(() => {
    if (!retryable) return;
    const onOnline = () => { setRes(null); setAttempt(a => a + 1); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [retryable]);

  const retry = useCallback(() => { setRes(null); setAttempt(a => a + 1); }, []);
  // 'ready' from the hydration means "written": keep blocking until the live row actually carries
  // the content (an editor mounted on the empty row would neither refresh nor be safe to save from).
  const status: VaultHydrationStatus = !eligible || !isEmpty ? 'ready' : !settled || settled.v === 'ready' ? 'loading' : settled.v;
  return { status, retry };
}
