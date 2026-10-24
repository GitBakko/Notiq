import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ refresh: vi.fn(), byUser: {} as Record<string, { offlineUnlock?: boolean }> }));
vi.mock('../../lib/vaultSession', () => ({ refreshKeyringCache: (...a: unknown[]) => h.refresh(...a) }));
vi.mock('../../store/vaultStore', () => ({ useVaultStore: { getState: () => ({ byUser: h.byUser }) } }));

import { useKeyringRefresh } from '../useKeyringRefresh';

const setOnline = (v: boolean) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); await vi.dynamicImportSettled(); });

beforeEach(() => {
  vi.useFakeTimers();
  h.refresh.mockReset().mockResolvedValue(undefined);
  h.byUser = { u1: { offlineUnlock: true } };
  setOnline(true);
});
afterEach(() => { vi.useRealTimers(); setOnline(true); });

describe('useKeyringRefresh (J.6)', () => {
  it('una chiamata al mount e un altra ogni 30 s', async () => {
    renderHook(() => useKeyringRefresh('u1'));
    await tick(0);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledWith('u1');
    await tick(30_000);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    await tick(30_000);
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it('evento online: chiama subito', async () => {
    renderHook(() => useKeyringRefresh('u1'));
    await tick(0);
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0); await vi.dynamicImportSettled(); });
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('offlineUnlock disattivo: nessuna chiamata', async () => {
    h.byUser = { u1: { offlineUnlock: false } };
    renderHook(() => useKeyringRefresh('u1'));
    await tick(65_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('offlineUnlock letto al momento della chiamata: attivato dopo il mount, parte al giro successivo', async () => {
    h.byUser = { u1: { offlineUnlock: false } };
    renderHook(() => useKeyringRefresh('u1'));
    await tick(0);
    expect(h.refresh).not.toHaveBeenCalled();
    h.byUser = { u1: { offlineUnlock: true } };
    await tick(30_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('offline: nessuna chiamata', async () => {
    setOnline(false);
    renderHook(() => useKeyringRefresh('u1'));
    await tick(65_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('dopo l unmount: nessuna chiamata (timer ed evento online rimossi)', async () => {
    const { unmount } = renderHook(() => useKeyringRefresh('u1'));
    await tick(0);
    unmount();
    h.refresh.mockClear();
    await tick(65_000);
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0); await vi.dynamicImportSettled(); });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('senza userId: nessuna chiamata', async () => {
    renderHook(() => useKeyringRefresh(undefined));
    await tick(65_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
