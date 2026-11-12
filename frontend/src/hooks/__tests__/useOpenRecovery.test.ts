import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ getKeyring: vi.fn(), userId: 'u1' as string | undefined }));
vi.mock('../../lib/vaultApi', () => ({ getKeyring: (...a: unknown[]) => h.getKeyring(...a) }));
vi.mock('../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: h.userId ? { id: h.userId } : null }),
}));

import { useOpenRecovery } from '../useOpenRecovery';

const REC = { id: 'r1', status: 'WAITING', fingerprint: 'ABCD-1234', createdAt: '2026-11-12T10:00:00Z', notBefore: '2026-11-13T10:00:00Z' };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  h.userId = 'u1';
  h.getKeyring.mockReset().mockResolvedValue({ openRecovery: REC });
});
afterEach(() => vi.useRealTimers());

describe('useOpenRecovery', () => {
  it('al mount chiama getKeyring ed espone openRecovery', async () => {
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    expect(h.getKeyring).toHaveBeenCalledTimes(1);
    expect(result.current.openRecovery).toEqual(REC);
  });

  it('openRecovery assente nella risposta: null', async () => {
    h.getKeyring.mockResolvedValue({ status: 'READY' });
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    expect(result.current.openRecovery).toBeNull();
  });

  it('focus della finestra: richiama', async () => {
    renderHook(() => useOpenRecovery());
    await tick(0);
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
  });

  it('visibilitychange: richiama solo quando torna visibile', async () => {
    renderHook(() => useOpenRecovery());
    await tick(0);
    const vis = vi.spyOn(document, 'visibilityState', 'get');
    vis.mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(h.getKeyring).toHaveBeenCalledTimes(1);
    vis.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
    vis.mockRestore();
  });

  it('timer: una chiamata ogni 15 minuti', async () => {
    renderHook(() => useOpenRecovery());
    await tick(0);
    await tick(15 * 60_000 - 1);
    expect(h.getKeyring).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
    await tick(15 * 60_000);
    expect(h.getKeyring).toHaveBeenCalledTimes(3);
  });

  it('errore di rete o 503: tiene l ultimo valore', async () => {
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    h.getKeyring.mockRejectedValue(new Error('network'));
    await act(async () => { await result.current.refresh(); });
    expect(h.getKeyring).toHaveBeenCalledTimes(2);
    expect(result.current.openRecovery).toEqual(REC);
  });

  it('refresh aggiorna il valore (annullata: null)', async () => {
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    h.getKeyring.mockResolvedValue({ openRecovery: null });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.openRecovery).toBeNull();
  });

  it('dopo l unmount: niente chiamate (timer, focus, visibilitychange rimossi)', async () => {
    const { unmount } = renderHook(() => useOpenRecovery());
    await tick(0);
    unmount();
    h.getKeyring.mockClear();
    await tick(31 * 60_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.getKeyring).not.toHaveBeenCalled();
  });

  it('focus + visibilitychange nello stesso tick: una sola chiamata', async () => {
    renderHook(() => useOpenRecovery());
    await tick(0);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.getKeyring).toHaveBeenCalledTimes(2); // mount + una
  });

  it('risposta vecchia che arriva dopo una nuova: ignorata', async () => {
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    expect(result.current.openRecovery).toEqual(REC);
    let late!: (v: unknown) => void;
    h.getKeyring.mockReturnValueOnce(new Promise((r) => { late = r; }));
    let slow!: Promise<void>;
    act(() => { slow = result.current.refresh(); });
    h.getKeyring.mockResolvedValueOnce({ openRecovery: null });
    await act(async () => { await result.current.refresh(); }); // il refresh dopo un annullo
    expect(result.current.openRecovery).toBeNull();
    await act(async () => { late({ openRecovery: REC }); await slow; });
    expect(result.current.openRecovery).toBeNull();
  });

  it('cambio utente senza smontaggio: azzera il valore e scarta la risposta del vecchio utente', async () => {
    const { result, rerender } = renderHook(() => useOpenRecovery());
    await tick(0);
    expect(result.current.openRecovery).toEqual(REC);
    let late!: (v: unknown) => void;
    h.getKeyring.mockReturnValueOnce(new Promise((r) => { late = r; }));
    act(() => { void result.current.refresh(); }); // richiesta in volo dell'utente u1
    h.userId = 'u2';
    h.getKeyring.mockResolvedValue({ openRecovery: null });
    rerender();
    expect(result.current.openRecovery).toBeNull();
    await tick(0);
    await act(async () => { late({ openRecovery: REC }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.openRecovery).toBeNull();
  });

  it('refresh dell utente precedente chiamato dopo il cambio utente: non tocca lo stato e non scarta la GET del nuovo', async () => {
    const { result, rerender } = renderHook(() => useOpenRecovery());
    await tick(0);
    const oldRefresh = result.current.refresh; // creato per u1 (es. tenuto dal banner durante l'annullo)
    const REC2 = { ...REC, id: 'r2' };
    let u2!: (v: unknown) => void;
    h.getKeyring.mockReset().mockReturnValueOnce(new Promise((r) => { u2 = r; }));
    h.getKeyring.mockResolvedValue({ openRecovery: REC }); // risposta che il vecchio refresh NON deve applicare
    h.userId = 'u2';
    rerender();
    await tick(0); // GET di u2 in volo
    expect(h.getKeyring).toHaveBeenCalledTimes(1);
    await act(async () => { await oldRefresh(); });
    expect(h.getKeyring).toHaveBeenCalledTimes(1); // il vecchio refresh esce subito
    await act(async () => { u2({ openRecovery: REC2 }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.openRecovery).toEqual(REC2);
  });

  it('markCancelled(id): azzera il valore se l id coincide, altrimenti no', async () => {
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    act(() => result.current.markCancelled('altro'));
    expect(result.current.openRecovery).toEqual(REC);
    act(() => result.current.markCancelled('r1'));
    expect(result.current.openRecovery).toBeNull();
  });

  it('markCancelled scarta una GET in volo partita prima', async () => {
    const { result } = renderHook(() => useOpenRecovery());
    await tick(0);
    let late!: (v: unknown) => void;
    h.getKeyring.mockReturnValueOnce(new Promise((r) => { late = r; }));
    let slow!: Promise<void>;
    act(() => { slow = result.current.refresh(); });
    act(() => result.current.markCancelled('r1'));
    await act(async () => { late({ openRecovery: REC }); await slow; });
    expect(result.current.openRecovery).toBeNull();
  });

  it('utente non autenticato: nessuna chiamata', async () => {
    h.userId = undefined;
    const { result } = renderHook(() => useOpenRecovery());
    await tick(31 * 60_000);
    expect(h.getKeyring).not.toHaveBeenCalled();
    expect(result.current.openRecovery).toBeNull();
  });
});
