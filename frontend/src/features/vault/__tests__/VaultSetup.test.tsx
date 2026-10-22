import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1', email: 'a@b.it', name: 'A', surname: 'B' } }),
}));
vi.mock('../../../lib/vaultSession', () => ({ setup: vi.fn(), confirmKit: vi.fn(async () => {}) }));
vi.mock('../../../utils/vaultRootKeys', () => ({ getActiveRootKey: vi.fn() }));
vi.mock('../PinPolicy', () => ({ checkPin: vi.fn(async () => ({ ok: true })) }));

import VaultSetup from '../VaultSetup';
import { setup } from '../../../lib/vaultSession';
import { getActiveRootKey } from '../../../utils/vaultRootKeys';
import { checkPin } from '../PinPolicy';

const ROOT = { id: 'rk_x', ecdhSpki: new Uint8Array([1]) };
const fill = () => {
  fireEvent.change(screen.getByLabelText('vault.enterPin'), { target: { value: 'k7Rq2x' } });
  fireEvent.change(screen.getByLabelText('vault.confirmPin'), { target: { value: 'k7Rq2x' } });
  fireEvent.change(screen.getByLabelText('vault.setup.accountPassword'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByLabelText('vault.setup.riskAck'));
};
const submit = () => fireEvent.click(screen.getByText('vault.setupButton'));

beforeEach(() => {
  vi.mocked(setup).mockReset();
  vi.mocked(getActiveRootKey).mockReturnValue(ROOT);
  vi.mocked(checkPin).mockResolvedValue({ ok: true });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('VaultSetup', () => {
  it('senza root key: testo setupDisabled, nessun form, nessuna chiamata al server', () => {
    vi.mocked(getActiveRootKey).mockReturnValue(null);
    render(<VaultSetup />);
    expect(screen.getByText('errors.vault.setupDisabled')).toBeTruthy();
    expect(screen.queryByText('vault.setupButton')).toBeNull();
    expect(setup).not.toHaveBeenCalled();
  });

  it('mostra la frase di rischio e il Kit NON compare prima del 201', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(setup).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    render(<VaultSetup />);
    expect(screen.getByText('vault.setup.riskBody')).toBeTruthy();
    fill();
    submit();
    await waitFor(() => expect(setup).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    resolve({ ok: true, kit: new Uint8Array(20).fill(5), offlineSaved: true });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('passa PIN, password, root key e offlineUnlock a setup', async () => {
    vi.mocked(setup).mockResolvedValue({ ok: true, kit: new Uint8Array(20), offlineSaved: true });
    render(<VaultSetup />);
    fill();
    fireEvent.click(screen.getByLabelText('vault.setup.offlineUnlock'));
    submit();
    await waitFor(() => expect(setup).toHaveBeenCalledWith({ userId: 'u1', pin: 'k7Rq2x', password: 'pw', rootKey: ROOT, offlineUnlock: true }));
  });

  it('PIN rifiutato dalla policy: messaggio vault.pinPolicy.*, nessuna chiamata a setup', async () => {
    vi.mocked(checkPin).mockResolvedValue({ ok: false, reason: 'common' });
    render(<VaultSetup />);
    fill();
    submit();
    expect(await screen.findByText('vault.pinPolicy.common')).toBeTruthy();
    expect(setup).not.toHaveBeenCalled();
  });

  it('PIN e conferma diversi: vault.pinMismatch', async () => {
    render(<VaultSetup />);
    fill();
    fireEvent.change(screen.getByLabelText('vault.confirmPin'), { target: { value: 'k7Rq2y' } });
    submit();
    expect(await screen.findByText('vault.pinMismatch')).toBeTruthy();
    expect(setup).not.toHaveBeenCalled();
  });

  it('offline: pulsante disabilitato e avviso', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<VaultSetup />);
    fill();
    expect(screen.getByText('vault.setup.offline')).toBeTruthy();
    expect((screen.getByText('vault.setupButton').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('errore del server: mostra la chiave errors.*; sconosciuto -> unknownError', async () => {
    vi.mocked(setup).mockRejectedValueOnce(Object.assign(new Error('x'), { key: 'errors.vault.invalidPassword' }));
    render(<VaultSetup />);
    fill();
    submit();
    expect(await screen.findByText('errors.vault.invalidPassword')).toBeTruthy();
    // la password si svuota dopo ogni tentativo
    fireEvent.change(screen.getByLabelText('vault.setup.accountPassword'), { target: { value: 'pw' } });
    vi.mocked(setup).mockRejectedValueOnce(new Error('boom'));
    submit();
    expect(await screen.findByText('errors.common.unknownError')).toBeTruthy();
  });

  it('409 alreadySetup: avviso e callback, nessun Kit', async () => {
    vi.mocked(setup).mockResolvedValue({ ok: false, reason: 'alreadySetup' });
    const cb = vi.fn();
    render(<VaultSetup onAlreadySetup={cb} />);
    fill();
    submit();
    expect(await screen.findByText('vault.setup.alreadySetup')).toBeTruthy();
    expect(cb).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('doppio submit nello stesso tick: setup chiamato una volta sola', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(setup).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    const { container } = render(<VaultSetup />);
    fill();
    const form = container.querySelector('form')!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
    resolve({ ok: true, kit: new Uint8Array(20).fill(5), offlineSaved: true });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('checkPin che rigetta (chunk non caricato): errore mostrato, guardia rilasciata', async () => {
    vi.mocked(checkPin).mockRejectedValueOnce(new Error('chunk'));
    render(<VaultSetup />);
    fill();
    submit();
    expect(await screen.findByText('errors.common.unknownError')).toBeTruthy();
    expect(setup).not.toHaveBeenCalled();
    vi.mocked(setup).mockResolvedValue({ ok: false, reason: 'alreadySetup' });
    submit();
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(1));
  });
});
