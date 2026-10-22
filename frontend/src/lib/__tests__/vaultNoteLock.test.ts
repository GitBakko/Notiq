import { describe, it, expect, afterEach } from 'vitest';
import { withNoteLock, withReconcileLock, hasLocks, noteLockName, RECONCILE_LOCK } from '../vaultNoteLock';

/* eslint-disable @typescript-eslint/no-explicit-any -- minimal LockManager mock */
// Minimal navigator.locks: exclusive and shared, FIFO per name, ifAvailable and AbortSignal on the wait.
const installLocks = () => {
  const held = new Set<string>();
  const state = new Map<string, { mode: string; n: number }>();
  const waiting = new Map<string, Array<{ mode: string; go: () => void }>>();
  const canGrant = (name: string, mode: string) => {
    const s = state.get(name);
    return !s || (mode === 'shared' && s.mode === 'shared');
  };
  const pump = (name: string) => {
    const q = waiting.get(name) ?? [];
    while (q.length && canGrant(name, q[0].mode)) q.shift()!.go();
  };
  const request = async (name: string, opts: any, cb: (lock: unknown) => Promise<unknown>) => {
    const mode = opts.mode ?? 'exclusive';
    const run = async () => {
      const s = state.get(name);
      if (s) s.n++; else state.set(name, { mode, n: 1 });
      held.add(name);
      try { return await cb({ name, mode }); } finally {
        const cur = state.get(name)!;
        if (--cur.n === 0) { state.delete(name); held.delete(name); }
        pump(name);
      }
    };
    if (canGrant(name, mode) && !(waiting.get(name)?.length)) return run();
    if (opts.ifAvailable) return cb(null);
    return new Promise((resolve, reject) => {
      const entry = { mode, go: () => { run().then(resolve, reject); } };
      waiting.set(name, [...(waiting.get(name) ?? []), entry]);
      opts.signal?.addEventListener('abort', () => {
        waiting.set(name, (waiting.get(name) ?? []).filter(w => w !== entry));
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return held;
};
const removeLocks = () => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });

afterEach(removeLocks);

describe('vaultNoteLock without navigator.locks', () => {
  it('runs nothing and says nolocks', async () => {
    removeLocks();
    let ran = false;
    expect(hasLocks()).toBe(false);
    expect(await withNoteLock('n1', () => { ran = true; })).toEqual({ status: 'nolocks' });
    expect(await withReconcileLock(() => { ran = true; })).toEqual({ status: 'nolocks' });
    expect(ran).toBe(false);
  });
});

describe('withNoteLock', () => {
  it('uses the per-note name and returns the value', async () => {
    const held = installLocks();
    let during: string[] = [];
    const r = await withNoteLock('n1', () => { during = [...held]; return 42; });
    expect(r).toEqual({ status: 'ran', value: 42 });
    expect(during).toEqual([noteLockName('n1')]);
    expect(noteLockName('n1')).toBe('notiq-vault-note:n1');
  });

  it('ifAvailable: busy while held, runs after release; other notes are free', async () => {
    installLocks();
    let release!: () => void;
    const holder = withNoteLock('n1', () => new Promise<void>(res => { release = res; }));
    await Promise.resolve();
    expect(await withNoteLock('n1', () => 1, { ifAvailable: true })).toEqual({ status: 'busy' });
    expect(await withNoteLock('n2', () => 2, { ifAvailable: true })).toEqual({ status: 'ran', value: 2 });
    release();
    await holder;
    expect(await withNoteLock('n1', () => 3, { ifAvailable: true })).toEqual({ status: 'ran', value: 3 });
  });

  it('without ifAvailable it waits for the holder', async () => {
    installLocks();
    const order: string[] = [];
    let release!: () => void;
    const holder = withNoteLock('n1', async () => { order.push('a'); await new Promise<void>(res => { release = res; }); });
    await Promise.resolve();
    const waiter = withNoteLock('n1', () => { order.push('b'); });
    await Promise.resolve();
    expect(order).toEqual(['a']);
    release();
    await Promise.all([holder, waiter]);
    expect(order).toEqual(['a', 'b']);
  });

  it('shared + shared coexist, also with ifAvailable', async () => {
    installLocks();
    let release!: () => void;
    const editor = withNoteLock('n1', () => new Promise<void>(res => { release = res; }), { mode: 'shared' });
    await Promise.resolve();
    expect(await withNoteLock('n1', () => 1, { mode: 'shared', ifAvailable: true })).toEqual({ status: 'ran', value: 1 });
    release();
    await editor;
  });

  it('exclusive ifAvailable is busy while a shared holder is there; runs after release', async () => {
    installLocks();
    let release!: () => void;
    const editor = withNoteLock('n1', () => new Promise<void>(res => { release = res; }), { mode: 'shared' });
    await Promise.resolve();
    expect(await withNoteLock('n1', () => 1, { ifAvailable: true })).toEqual({ status: 'busy' });
    expect(await withNoteLock('n1', () => 1, { mode: 'exclusive', ifAvailable: true })).toEqual({ status: 'busy' });
    release();
    await editor;
    expect(await withNoteLock('n1', () => 2, { ifAvailable: true })).toEqual({ status: 'ran', value: 2 });
  });

  it('shared ifAvailable is busy while an exclusive holder is there', async () => {
    installLocks();
    let release!: () => void;
    const holder = withNoteLock('n1', () => new Promise<void>(res => { release = res; }));
    await Promise.resolve();
    expect(await withNoteLock('n1', () => 1, { mode: 'shared', ifAvailable: true })).toEqual({ status: 'busy' });
    release();
    await holder;
    expect(await withNoteLock('n1', () => 2, { mode: 'shared', ifAvailable: true })).toEqual({ status: 'ran', value: 2 });
  });
});

describe('withReconcileLock', () => {
  it('waits, then runs under the reconcile name', async () => {
    const held = installLocks();
    let during: string[] = [];
    let release!: () => void;
    const first = withReconcileLock(() => new Promise<void>(res => { release = res; }));
    await Promise.resolve();
    const second = withReconcileLock(() => { during = [...held]; return 'x'; });
    release();
    await first;
    expect(await second).toEqual({ status: 'ran', value: 'x' });
    expect(during).toEqual([RECONCILE_LOCK]);
  });

  it('abort while waiting -> busy; the holder is untouched', async () => {
    installLocks();
    let release!: () => void;
    const holder = withReconcileLock(() => new Promise<void>(res => { release = res; }));
    await Promise.resolve();
    const ac = new AbortController();
    const waiter = withReconcileLock(() => 'never', ac.signal);
    await Promise.resolve();
    ac.abort();
    expect(await waiter).toEqual({ status: 'busy' });
    release();
    expect((await holder).status).toBe('ran');
  });

  it('an error thrown by fn propagates, even an AbortError', async () => {
    installLocks();
    await expect(withReconcileLock(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); })).rejects.toThrow('x');
  });
});
