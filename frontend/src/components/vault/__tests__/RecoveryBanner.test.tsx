import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${Object.values(o).join('|')}` : k),
    i18n: { language: 'it' },
  }),
}));

const h = vi.hoisted(() => ({
  open: null as unknown,
  refresh: vi.fn(),
  markCancelled: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../../../hooks/useOpenRecovery', () => ({
  useOpenRecovery: () => ({ openRecovery: h.open, refresh: h.refresh, markCancelled: h.markCancelled }),
}));
vi.mock('../../../lib/vaultApi', async (orig) => ({
  ...(await orig<typeof import('../../../lib/vaultApi')>()),
  cancelRecovery: (...a: unknown[]) => h.cancel(...a),
}));

import RecoveryBanner from '../RecoveryBanner';
import { VaultApiError } from '../../../lib/vaultApi';

const NOT_BEFORE = '2026-11-13T10:00:00.000Z';
const rec = (status: string, notBefore: string | null = null) => ({
  id: 'r1', status, fingerprint: 'ABCD-1234', createdAt: '2026-11-12T10:00:00.000Z', notBefore,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T22:00:00.000Z')); // 12 h prima di notBefore
  h.open = null;
  h.refresh.mockReset().mockResolvedValue(undefined);
  h.markCancelled.mockReset();
  h.cancel.mockReset().mockResolvedValue({ status: 'CANCELLED' });
});
afterEach(() => vi.useRealTimers());

describe('RecoveryBanner', () => {
  it('openRecovery null: niente render', () => {
    const { container } = render(<RecoveryBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('role=status, nessun pulsante di chiusura: solo Annulla', () => {
    h.open = rec('PENDING_APPROVAL');
    render(<RecoveryBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('vault.recoveryBanner.cancel');
    expect(screen.queryByLabelText(/dismiss|close|chiudi/i)).toBeNull();
  });

  it.each(['PENDING_APPROVAL', 'PENDING_CODE', 'RELEASED'])('%s: il testo contiene il fingerprint', (status) => {
    h.open = rec(status);
    render(<RecoveryBanner />);
    expect(screen.getByRole('status').textContent).toContain('ABCD-1234');
  });

  it('WAITING: fingerprint, ora locale di notBefore e ore residue', () => {
    h.open = rec('WAITING', NOT_BEFORE);
    render(<RecoveryBanner />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('ABCD-1234');
    expect(text).toContain(new Date(NOT_BEFORE).toLocaleString('it'));
    expect(text).toContain('12'); // ore residue
  });

  it('Annulla: dialog, conferma, cancelRecovery(id), poi refresh', async () => {
    h.open = rec('PENDING_CODE');
    render(<RecoveryBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' }));
    expect(h.cancel).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'vault.recoveryBanner.confirmAction' }));
    await waitFor(() => expect(h.cancel).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
  });

  async function confirmCancel() {
    fireEvent.click(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'vault.recoveryBanner.confirmAction' }));
  }

  it('DELETE ok e refresh fallito: markCancelled toglie il banner', async () => {
    h.open = rec('PENDING_CODE');
    h.markCancelled.mockImplementation(() => { h.open = null; });
    h.refresh.mockResolvedValue(undefined); // il refresh reale inghiotte l'errore e tiene il valore
    const { container } = render(<RecoveryBanner />);
    await confirmCancel();
    await waitFor(() => expect(h.markCancelled).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('errore di rete: messaggio generico e nessun refresh', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new Error('x'));
    render(<RecoveryBanner />);
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('errore 5xx: messaggio generico e nessun refresh', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(500, 'errors.vault.unknown', 'unknown'));
    render(<RecoveryBanner />);
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('409: refresh e, se il banner c e ancora, messaggio recoveryStateConflict', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(409, 'errors.vault.recoveryStateConflict', 'conflict'));
    render(<RecoveryBanner />);
    await confirmCancel();
    expect(await screen.findByText('errors.vault.recoveryStateConflict')).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('vault.recoveryBanner.cancelError')).toBeNull();
  });

  it('410: refresh e messaggio recoveryExpired', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(410, 'errors.vault.recoveryExpired', 'unknown'));
    render(<RecoveryBanner />);
    await confirmCancel();
    expect(await screen.findByText('errors.vault.recoveryExpired')).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('409 e dopo il refresh il banner e sparito: nessun messaggio', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(409, 'errors.vault.recoveryStateConflict', 'conflict'));
    h.refresh.mockImplementation(async () => { h.open = null; });
    const { container, rerender } = render(<RecoveryBanner />);
    await confirmCancel();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    rerender(<RecoveryBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('annullo in corso: il pulsante Annulla e disabilitato', async () => {
    h.open = rec('PENDING_CODE');
    let resolve!: () => void;
    h.cancel.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    render(<RecoveryBanner />);
    await confirmCancel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' })).toBeDisabled());
    resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' })).not.toBeDisabled());
  });

  it('WAITING: superato notBefore il testo passa a textDue entro 60 s, senza nuove GET', async () => {
    vi.useFakeTimers(); // anche gli intervalli
    vi.setSystemTime(new Date('2026-11-12T22:00:00.000Z'));
    h.open = rec('WAITING', '2026-11-12T22:00:30.000Z');
    render(<RecoveryBanner />);
    expect(screen.getByRole('status').textContent).toContain('states.waiting.text|');
    expect(screen.getByRole('status').textContent).not.toContain('textDue');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('status').textContent).toContain('states.waiting.textDue');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('l errore si azzera quando cambia lo status della richiesta', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new Error('x'));
    const { rerender } = render(<RecoveryBanner />);
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    h.open = rec('WAITING', NOT_BEFORE);
    rerender(<RecoveryBanner />);
    expect(screen.queryByText('vault.recoveryBanner.cancelError')).toBeNull();
  });

  it('l errore si azzera quando cambia l id della richiesta', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new Error('x'));
    const { rerender } = render(<RecoveryBanner />);
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    h.open = { ...rec('PENDING_CODE'), id: 'r2' };
    rerender(<RecoveryBanner />);
    expect(screen.queryByText('vault.recoveryBanner.cancelError')).toBeNull();
  });
});
