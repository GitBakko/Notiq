// Vault v3 (T15): Web Locks for vault notes. One lock per note (held by an open editor, asked by the pull and the
// reconcile) and one for the reconcile round. Without navigator.locks nothing runs and the result says so ('nolocks'):
// the caller decides (the reconcile does only REQUEUE/finalize, the pull writes directly).

export type LockResult<T> =
  | { status: 'ran'; value: T }
  | { status: 'busy' }
  | { status: 'nolocks' };

const NOTE_LOCK_PREFIX = 'notiq-vault-note:';
export const RECONCILE_LOCK = 'notiq-vault-reconcile';

export const noteLockName = (id: string) => NOTE_LOCK_PREFIX + id;

const locksApi = (): LockManager | null =>
  typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;

export const hasLocks = () => locksApi() !== null;

/**
 * Lock of one note. `mode`: 'exclusive' (default; reconcile commit, pull flip) or 'shared' (open editor, vault push:
 * shared holders coexist, only an exclusive holder keeps them out).
 * `ifAvailable`: do not wait, 'busy' when the lock cannot be granted at once; otherwise it waits.
 */
export async function withNoteLock<T>(
  id: string,
  fn: () => Promise<T> | T,
  opts: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' } = {},
): Promise<LockResult<T>> {
  const locks = locksApi();
  if (!locks) return { status: 'nolocks' };
  return locks.request(
    noteLockName(id),
    { mode: opts.mode ?? 'exclusive', ifAvailable: opts.ifAvailable === true },
    async (lock): Promise<LockResult<T>> => {
      if (!lock) return { status: 'busy' }; // ifAvailable and held elsewhere
      return { status: 'ran', value: await fn() };
    },
  );
}

/**
 * Lock of the reconcile round, always in waiting mode. `signal` aborts the wait: 'busy' (the caller shows "retry").
 * An AbortError thrown by `fn` itself is not swallowed.
 */
export async function withReconcileLock<T>(
  fn: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<LockResult<T>> {
  const locks = locksApi();
  if (!locks) return { status: 'nolocks' };
  let started = false;
  try {
    return await locks.request(
      RECONCILE_LOCK,
      signal ? { mode: 'exclusive', signal } : { mode: 'exclusive' },
      async (): Promise<LockResult<T>> => {
        started = true;
        return { status: 'ran', value: await fn() };
      },
    );
  } catch (e) {
    if (!started && (e as { name?: string })?.name === 'AbortError') return { status: 'busy' };
    throw e;
  }
}
