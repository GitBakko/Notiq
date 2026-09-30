import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const getNote = vi.fn();
const update = vi.fn();
const queueItems: { entity: string; entityId: string; data?: Record<string, unknown> }[] = [];
let row: { id: string; content: string; syncStatus: string } | undefined;
let onGetHook: (() => void) | undefined;

vi.mock('../../notes/noteService', () => ({ getNote: (...a: unknown[]) => getNote(...a) }));
vi.mock('../../../lib/db', () => ({
  db: {
    notes: { update: (...a: unknown[]) => update(...a), get: async () => { onGetHook?.(); return row; } },
    syncQueue: {
      where: () => ({ equals: () => ({ filter: (fn: (i: unknown) => boolean) => ({ count: async () => queueItems.filter(fn).length }) }) }),
    },
    transaction: async (_m: string, _a: unknown, _b: unknown, fn: () => Promise<unknown>) => fn(),
  },
}));

import { useVaultHydration } from '../useVaultHydration';

type N = { id: string; content?: string; syncStatus?: string } | undefined;
const mk = (over: object = {}) => ({ id: 'a', content: '', syncStatus: 'synced', ...over }) as never;
const setRow = (id: string, over: object = {}) => { row = { id, content: '', syncStatus: 'synced', ...over }; };
const hook = (n: N) => renderHook(({ note }: { note: N }) => useVaultHydration(note), { initialProps: { note: n } });
const setOnline = (v: boolean) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });

describe('useVaultHydration', () => {
  beforeEach(() => {
    getNote.mockReset(); update.mockReset(); queueItems.length = 0; row = undefined; onGetHook = undefined;
    setOnline(true);
  });

  it('ready without fetching for locally created rows, even after their first sync', async () => {
    const { result, rerender } = hook(mk({ id: 'c', content: 'mine', syncStatus: 'created' }));
    expect(result.current.status).toBe('ready');
    rerender({ note: mk({ id: 'c', content: 'mine', syncStatus: 'synced' }) });
    expect(result.current.status).toBe('ready');
    expect(getNote).not.toHaveBeenCalled();
  });

  it('non-empty local row: ready at once, no fetch, no queue lookup', async () => {
    setRow('n1', { content: 'local' });
    const { result, rerender } = hook(mk({ id: 'n1', content: 'local' }));
    expect(result.current.status).toBe('ready');
    rerender({ note: mk({ id: 'n1', content: 'typed', syncStatus: 'modified' }) });
    expect(result.current.status).toBe('ready');
    await act(async () => { await Promise.resolve(); });
    expect(getNote).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('created-here exemption ends when the note id changes (empty row of the same id is hydrated again)', async () => {
    setRow('A');
    getNote.mockResolvedValue({ content: 'server-a' });
    const { result, rerender } = hook(mk({ id: 'A', content: 'local-a', syncStatus: 'created' }));
    rerender({ note: mk({ id: 'A', content: '', syncStatus: 'synced' }) });
    expect(result.current.status).toBe('ready'); // still exempt while open
    expect(getNote).not.toHaveBeenCalled();
    rerender({ note: mk({ id: 'B', content: 'b', syncStatus: 'synced' }) });
    expect(result.current.status).toBe('ready');
    rerender({ note: mk({ id: 'A', content: '', syncStatus: 'synced' }) });
    await waitFor(() => expect(update).toHaveBeenCalledWith('A', { content: 'server-a' }));
  });

  describe('empty local content', () => {
    it('synced empty row: fetches once and writes only content', async () => {
      setRow('d');
      getNote.mockResolvedValue({ content: 'server-data' });
      hook(mk({ id: 'd' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith('d', { content: 'server-data' }));
      expect(getNote).toHaveBeenCalledTimes(1);
    });

    it('stays loading after the write until the live row shows the content (no editor on empty)', async () => {
      setRow('w');
      getNote.mockResolvedValue({ content: 'server-data' });
      const { result, rerender } = hook(mk({ id: 'w' }));
      await waitFor(() => expect(update).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });
      expect(result.current.status).toBe('loading');
      rerender({ note: mk({ id: 'w', content: 'server-data' }) });
      expect(result.current.status).toBe('ready');
    });

    it('TOCTOU: row edited while the fetch was in flight -> no write', async () => {
      setRow('t', { content: 'user-typed' });
      getNote.mockResolvedValue({ content: 'server-data' });
      const { result } = hook(mk({ id: 't' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      expect(update).not.toHaveBeenCalled();
    });

    it('TOCTOU: queue item appeared while the fetch was in flight -> no write', async () => {
      setRow('q');
      getNote.mockImplementation(async () => { queueItems.push({ entity: 'NOTE', entityId: 'q', data: { content: 'x' } }); return { content: 'server-data' }; });
      const { result } = hook(mk({ id: 'q' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      expect(update).not.toHaveBeenCalled();
    });

    it('row not synced (metadata edit only): still hydrated, content only', async () => {
      setRow('s', { syncStatus: 'updated' });
      getNote.mockResolvedValue({ content: 'server-data' });
      hook(mk({ id: 's', syncStatus: 'updated' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith('s', { content: 'server-data' }));
    });

    it('pending queue item: no fetch, unavailable', async () => {
      queueItems.push({ entity: 'NOTE', entityId: 'e', data: { content: 'x' } });
      const { result } = hook(mk({ id: 'e' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      expect(getNote).not.toHaveBeenCalled();
    });

    it('offline: no fetch, unavailable', async () => {
      setOnline(false);
      const { result } = hook(mk({ id: 'f' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      expect(getNote).not.toHaveBeenCalled();
    });

    it('coming back online re-runs hydration automatically', async () => {
      setRow('o');
      setOnline(false);
      getNote.mockResolvedValue({ content: 'server-data' });
      const { result, rerender } = hook(mk({ id: 'o' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      setOnline(true);
      act(() => { window.dispatchEvent(new Event('online')); });
      await waitFor(() => expect(update).toHaveBeenCalledWith('o', { content: 'server-data' }));
      rerender({ note: mk({ id: 'o', content: 'server-data' }) });
      expect(result.current.status).toBe('ready');
    });

    it('removes the online listener on unmount', async () => {
      const spy = vi.spyOn(window, 'removeEventListener');
      setOnline(false);
      const { unmount, result } = hook(mk({ id: 'u' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      unmount();
      expect(spy.mock.calls.some(c => c[0] === 'online')).toBe(true);
      spy.mockRestore();
    });

    it('fetch error: unavailable', async () => {
      getNote.mockRejectedValue(new Error('x'));
      const { result } = hook(mk({ id: 'g' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      expect(update).not.toHaveBeenCalled();
    });

    it('404: gone (no Retry), nothing written', async () => {
      getNote.mockRejectedValue({ response: { status: 404 } });
      const { result } = hook(mk({ id: 'n13' }));
      await waitFor(() => expect(result.current.status).toBe('gone'));
      expect(update).not.toHaveBeenCalled();
    });

    it('403: gone', async () => {
      getNote.mockRejectedValue({ response: { status: 403 } });
      const { result } = hook(mk({ id: 'n14' }));
      await waitFor(() => expect(result.current.status).toBe('gone'));
    });

    it('other HTTP failures (500) stay unavailable with Retry', async () => {
      getNote.mockRejectedValue({ response: { status: 500 } });
      const { result } = hook(mk({ id: 'n15' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
    });

    it('metadata-only queue items (pin/title/tags) do not block hydration', async () => {
      setRow('n10', { syncStatus: 'updated' });
      queueItems.push({ entity: 'NOTE', entityId: 'n10', data: { isPinned: true } });
      queueItems.push({ entity: 'NOTE', entityId: 'n10' });
      getNote.mockResolvedValue({ content: 'server' });
      hook(mk({ id: 'n10', syncStatus: 'updated' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith('n10', { content: 'server' }));
    });

    it('blocked by a queued content item, re-runs once that item is gone', async () => {
      setRow('n12', { syncStatus: 'updated' });
      queueItems.push({ entity: 'NOTE', entityId: 'n12', data: { content: 'x' } });
      getNote.mockResolvedValue({ content: 'server-n12' });
      const { result, rerender } = hook(mk({ id: 'n12', syncStatus: 'updated' }));
      await waitFor(() => expect(result.current.status).toBe('unavailable'));
      expect(getNote).not.toHaveBeenCalled();
      queueItems.length = 0; // the push went through
      rerender({ note: mk({ id: 'n12', syncStatus: 'synced' }) });
      await waitFor(() => expect(update).toHaveBeenCalledWith('n12', { content: 'server-n12' }));
    });

    it('server returns empty: status empty, no write, and NOT cached across mounts', async () => {
      getNote.mockResolvedValue({ content: '' });
      const first = hook(mk({ id: 'h' }));
      await waitFor(() => expect(first.result.current.status).toBe('empty'));
      expect(update).not.toHaveBeenCalled();
      first.unmount();
      // Second mount must ask the server again (a stale "empty" must not stick for the tab lifetime)
      setRow('h');
      getNote.mockResolvedValue({ content: 'now-there' });
      hook(mk({ id: 'h' }));
      await waitFor(() => expect(update).toHaveBeenCalledWith('h', { content: 'now-there' }));
      expect(getNote).toHaveBeenCalledTimes(2);
    });
  });
});
