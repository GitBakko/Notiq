import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { time?: string }) => (o?.time ? `${k}:${o.time}` : k) }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../store/authStore', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }) }));
const cache = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../../store/vaultStore', () => ({ useVaultStore: (sel: (s: unknown) => unknown) => sel({ byUser: { u1: cache.value } }) }));
vi.mock('../../../lib/vaultSession', () => {
  class VaultSessionError extends Error {
    code: string;
    key: string;
    lockedUntil: string | null;
    constructor(code: string, key: string, lockedUntil: string | null = null) {
      super(key);
      this.code = code;
      this.key = key;
      this.lockedUntil = lockedUntil;
    }
  }
  return { unlockOnline: vi.fn(), unlockOffline: vi.fn(), VaultSessionError };
});

import VaultUnlock from '../VaultUnlock';
import toast from 'react-hot-toast';
import { unlockOnline, unlockOffline, VaultSessionError } from '../../../lib/vaultSession';

const setOnline = (v: boolean) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const type = (v = 'k7Rq2x') => fireEvent.change(screen.getByLabelText('vault.enterPin'), { target: { value: v } });
const submit = () => fireEvent.click(screen.getByText('vault.unlockButton'));
const netErr = () => Object.assign(new Error('n'), { name: 'VaultApiError', status: 0, key: 'errors.common.networkError' });

beforeEach(() => {
  vi.mocked(unlockOnline).mockReset().mockResolvedValue({ offlineSaved: true });
  vi.mocked(unlockOffline).mockReset().mockResolvedValue();
  cache.value = { status: 'READY', offlineUnlock: true, wrappedVkPin: 'x' };
  setOnline(true);
});
afterEach(() => vi.useRealTimers());

describe('VaultUnlock', () => {
  it('online: unlockOnline(userId, pin) e onUnlocked', async () => {
    const cb = vi.fn();
    render(<VaultUnlock onUnlocked={cb} />);
    type();
    submit();
    await waitFor(() => expect(cb).toHaveBeenCalled());
    expect(unlockOnline).toHaveBeenCalledWith('u1', 'k7Rq2x');
    expect(unlockOffline).not.toHaveBeenCalled();
  });

  it('doppio submit nello stesso tick: unlockOnline una volta sola', async () => {
    const cb = vi.fn();
    render(<VaultUnlock onUnlocked={cb} />);
    type();
    const form = screen.getByLabelText('vault.enterPin').closest('form')!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await waitFor(() => expect(cb).toHaveBeenCalled());
    expect(unlockOnline).toHaveBeenCalledTimes(1);
  });

  it('offline: unlockOffline, nessuna chiamata di rete', async () => {
    setOnline(false);
    const cb = vi.fn();
    render(<VaultUnlock onUnlocked={cb} />);
    type();
    submit();
    await waitFor(() => expect(cb).toHaveBeenCalled());
    expect(unlockOnline).not.toHaveBeenCalled();
    expect(unlockOffline).toHaveBeenCalledWith('u1', 'k7Rq2x');
  });

  it('offline senza sblocco offline: errors.vault.offlineUnavailable', async () => {
    setOnline(false);
    vi.mocked(unlockOffline).mockRejectedValue(new VaultSessionError('offlineUnavailable', 'errors.vault.offlineUnavailable'));
    render(<VaultUnlock />);
    type();
    submit();
    expect(await screen.findByText('errors.vault.offlineUnavailable')).toBeTruthy();
  });

  it('rete caduta durante lo sblocco online: ripiega su offline se abilitato', async () => {
    vi.mocked(unlockOnline).mockRejectedValue(netErr());
    const cb = vi.fn();
    render(<VaultUnlock onUnlocked={cb} />);
    type();
    submit();
    await waitFor(() => expect(cb).toHaveBeenCalled());
    expect(unlockOffline).toHaveBeenCalled();
  });

  it('rete caduta senza sblocco offline: errore di rete, nessun fallback', async () => {
    cache.value = { status: 'READY', offlineUnlock: false };
    vi.mocked(unlockOnline).mockRejectedValue(netErr());
    render(<VaultUnlock />);
    type();
    submit();
    expect(await screen.findByText('errors.common.networkError')).toBeTruthy();
    expect(unlockOffline).not.toHaveBeenCalled();
  });

  it('wrongPin: messaggio invalidPin e campo svuotato', async () => {
    vi.mocked(unlockOnline).mockRejectedValue(new VaultSessionError('wrongPin', 'errors.vault.whatever'));
    render(<VaultUnlock />);
    type();
    submit();
    expect(await screen.findByText('errors.vault.invalidPin')).toBeTruthy();
    expect((screen.getByLabelText('vault.enterPin') as HTMLInputElement).value).toBe('');
  });

  it('pinLocked: conto alla rovescia, form disabilitato, poi si sblocca', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const until = new Date(Date.now() + 3000).toISOString();
    vi.mocked(unlockOnline).mockRejectedValue(new VaultSessionError('pinLocked', 'errors.vault.locked', until));
    render(<VaultUnlock />);
    type();
    submit();
    expect(await screen.findByText(/vault\.unlock\.lockedFor:0:0[1-3]/)).toBeTruthy();
    expect((screen.getByLabelText('vault.enterPin') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.queryByText(/vault\.unlock\.lockedFor/)).toBeNull();
    expect(screen.queryByText('errors.vault.locked')).toBeNull(); // niente errore stantio
    expect((screen.getByLabelText('vault.enterPin') as HTMLInputElement).disabled).toBe(false);
  });

  it('E.6: blocco PIN attivo, offline con sblocco offline: campo abilitato e invio usa unlockOffline; online torna disabilitato', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const until = new Date(Date.now() + 60000).toISOString();
    vi.mocked(unlockOnline).mockRejectedValue(new VaultSessionError('pinLocked', 'errors.vault.locked', until));
    render(<VaultUnlock />);
    type();
    submit();
    await screen.findByText(/vault\.unlock\.lockedFor/);
    const input = () => screen.getByLabelText('vault.enterPin') as HTMLInputElement;
    expect(input().disabled).toBe(true);
    act(() => { setOnline(false); window.dispatchEvent(new Event('offline')); });
    expect(input().disabled).toBe(false);
    expect(screen.queryByText('errors.vault.locked')).toBeNull(); // l alert del blocco online non resta con il campo abilitato
    type();
    submit();
    await waitFor(() => expect(unlockOffline).toHaveBeenCalledWith('u1', 'k7Rq2x'));
    act(() => { setOnline(true); window.dispatchEvent(new Event('online')); });
    expect(input().disabled).toBe(true);
  });

  it('E.6: blocco PIN attivo e offline SENZA sblocco offline: resta disabilitato', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    cache.value = { status: 'READY', offlineUnlock: false };
    const until = new Date(Date.now() + 60000).toISOString();
    vi.mocked(unlockOnline).mockRejectedValue(new VaultSessionError('pinLocked', 'errors.vault.locked', until));
    render(<VaultUnlock />);
    type();
    submit();
    await screen.findByText(/vault\.unlock\.lockedFor/);
    act(() => { setOnline(false); window.dispatchEvent(new Event('offline')); });
    expect((screen.getByLabelText('vault.enterPin') as HTMLInputElement).disabled).toBe(true);
  });

  it('notice="alreadySetup": mostra vault.setup.alreadySetup sopra il form; assente senza prop', () => {
    const { unmount } = render(<VaultUnlock notice="alreadySetup" />);
    expect(screen.getByText('vault.setup.alreadySetup')).toBeTruthy();
    expect(screen.getByLabelText('vault.enterPin')).toBeTruthy();
    unmount();
    render(<VaultUnlock />);
    expect(screen.queryByText('vault.setup.alreadySetup')).toBeNull();
  });

  it('offlineSaved=false dopo lo sblocco online: toast offlineNotSaved e sblocco comunque completato', async () => {
    vi.mocked(unlockOnline).mockResolvedValue({ offlineSaved: false });
    const cb = vi.fn();
    render(<VaultUnlock onUnlocked={cb} />);
    type();
    submit();
    await waitFor(() => expect(cb).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('vault.setup.offlineNotSaved');
  });

  it('PIN dimenticato: spiega che non c e recupero; nessun reset locale', () => {
    render(<VaultUnlock />);
    expect(screen.queryByText('vault.unlock.forgotBody')).toBeNull();
    fireEvent.click(screen.getByText('vault.forgotPin'));
    expect(screen.getByText('vault.unlock.forgotBody')).toBeTruthy();
    expect(screen.queryByText('vault.resetVaultButton')).toBeNull();
    expect(screen.queryByPlaceholderText('vault.resetVaultPlaceholder')).toBeNull();
  });
});
