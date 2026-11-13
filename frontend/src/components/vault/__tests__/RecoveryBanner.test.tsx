import { useEffect } from 'react';
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

import { MemoryRouter, useLocation } from 'react-router-dom';
import RecoveryBanner from '../RecoveryBanner';
import { RECOVERY_CHANGED_EVENT, RECOVERY_CLOSED_EVENT, setCeremonyOpen } from '../../../lib/vaultEvents';
import { VaultApiError } from '../../../lib/vaultApi';

let loc = '';
function Where() { const l = useLocation(); useEffect(() => { loc = l.pathname + l.search; }); return null; } // non rende nulla: i test sul contenitore vuoto restano validi
const banner = () => <MemoryRouter initialEntries={['/notes']}><RecoveryBanner /><Where /></MemoryRouter>;
const renderBanner = () => render(banner());

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
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('role=status, nessun pulsante di chiusura: solo Annulla', () => {
    h.open = rec('PENDING_APPROVAL');
    renderBanner();
    expect(screen.getByRole('status')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.textContent)).toEqual(['vault.recoveryBanner.details', 'vault.recoveryBanner.cancel']);
    expect(screen.queryByLabelText(/dismiss|close|chiudi/i)).toBeNull();
  });

  it('Dettagli porta a /vault?recovery=1 (Annulla resta)', () => {
    h.open = rec('PENDING_CODE');
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'vault.recoveryBanner.details' }));
    expect(loc).toBe('/vault?recovery=1');
  });

  it('alla chiusura della cerimonia (evento) il banner rilegge il recupero aperto; dopo lo smontaggio no', () => {
    h.open = rec('RELEASED');
    const { unmount } = renderBanner();
    h.refresh.mockClear();
    act(() => { window.dispatchEvent(new Event(RECOVERY_CLOSED_EVENT)); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    unmount();
    window.dispatchEvent(new Event(RECOVERY_CLOSED_EVENT));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('la cerimonia segnala un cambio di stato (evento): il banner rilegge il recupero aperto', () => {
    h.open = rec('WAITING');
    renderBanner();
    h.refresh.mockClear();
    act(() => { window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT)); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('con la cerimonia di recupero montata il banner e nascosto; alla chiusura torna', () => {
    h.open = rec('RELEASED');
    renderBanner();
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => { setCeremonyOpen(true); });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => { setCeremonyOpen(false); });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('banner montato quando la cerimonia e gia aperta: parte nascosto', () => {
    h.open = rec('RELEASED');
    setCeremonyOpen(true);
    renderBanner();
    expect(screen.queryByRole('status')).toBeNull();
    act(() => { setCeremonyOpen(false); });
  });

  it('annullo con richiesta RELEASED: il dialogo avvisa che il rilascio va perso; con le altre no', () => {
    h.open = rec('RELEASED');
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' }));
    expect(screen.getByText('vault.recovery.cancelReleasedWarning')).toBeInTheDocument();
    expect(screen.queryByText('vault.recoveryBanner.confirmMessage')).toBeNull();
  });

  it('annullo con richiesta WAITING: testo normale', () => {
    h.open = rec('WAITING', NOT_BEFORE);
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' }));
    expect(screen.getByText('vault.recoveryBanner.confirmMessage')).toBeInTheDocument();
    expect(screen.queryByText('vault.recovery.cancelReleasedWarning')).toBeNull();
  });

  it('un refresh porta la richiesta a RELEASED con il dialogo aperto: il testo si aggiorna', () => {
    h.open = rec('WAITING', NOT_BEFORE);
    const { rerender } = renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' }));
    expect(screen.getByText('vault.recoveryBanner.confirmMessage')).toBeInTheDocument();
    h.open = rec('RELEASED');
    rerender(banner());
    expect(screen.getByText('vault.recovery.cancelReleasedWarning')).toBeInTheDocument();
    expect(screen.queryByText('vault.recoveryBanner.confirmMessage')).toBeNull();
  });

  it.each(['PENDING_APPROVAL', 'PENDING_CODE', 'RELEASED'])('%s: il testo contiene il fingerprint', (status) => {
    h.open = rec(status);
    renderBanner();
    expect(screen.getByRole('status').textContent).toContain('ABCD-1234');
  });

  it('WAITING: fingerprint, ora locale di notBefore e ore residue', () => {
    h.open = rec('WAITING', NOT_BEFORE);
    renderBanner();
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('ABCD-1234');
    expect(text).toContain(new Date(NOT_BEFORE).toLocaleString('it'));
    expect(text).toContain('12'); // ore residue
  });

  it('Annulla: dialog, conferma, cancelRecovery(id), poi refresh', async () => {
    h.open = rec('PENDING_CODE');
    renderBanner();
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
    const { container } = renderBanner();
    await confirmCancel();
    await waitFor(() => expect(h.markCancelled).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('errore di rete: messaggio generico e nessun refresh', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new Error('x'));
    renderBanner();
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('errore 5xx: messaggio generico e nessun refresh', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(500, 'errors.vault.unknown', 'unknown'));
    renderBanner();
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('409: refresh e, se il banner c e ancora, messaggio recoveryStateConflict', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(409, 'errors.vault.recoveryStateConflict', 'conflict'));
    renderBanner();
    await confirmCancel();
    expect(await screen.findByText('errors.vault.recoveryStateConflict')).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('vault.recoveryBanner.cancelError')).toBeNull();
  });

  it('410: refresh e messaggio recoveryExpired', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(410, 'errors.vault.recoveryExpired', 'unknown'));
    renderBanner();
    await confirmCancel();
    expect(await screen.findByText('errors.vault.recoveryExpired')).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('409 e dopo il refresh il banner e sparito: nessun messaggio', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new VaultApiError(409, 'errors.vault.recoveryStateConflict', 'conflict'));
    h.refresh.mockImplementation(async () => { h.open = null; });
    const { container, rerender } = renderBanner();
    await confirmCancel();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    rerender(banner());
    expect(container).toBeEmptyDOMElement();
  });

  it('annullo in corso: il pulsante Annulla e disabilitato', async () => {
    h.open = rec('PENDING_CODE');
    let resolve!: () => void;
    h.cancel.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    renderBanner();
    await confirmCancel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' })).toBeDisabled());
    resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'vault.recoveryBanner.cancel' })).not.toBeDisabled());
  });

  it('WAITING: superato notBefore il testo passa a textDue entro 60 s, senza nuove GET', async () => {
    vi.useFakeTimers(); // anche gli intervalli
    vi.setSystemTime(new Date('2026-11-12T22:00:00.000Z'));
    h.open = rec('WAITING', '2026-11-12T22:00:30.000Z');
    renderBanner();
    expect(screen.getByRole('status').textContent).toContain('states.waiting.text|');
    expect(screen.getByRole('status').textContent).not.toContain('textDue');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('status').textContent).toContain('states.waiting.textDue');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('l errore si azzera quando cambia lo status della richiesta', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new Error('x'));
    const { rerender } = renderBanner();
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    h.open = rec('WAITING', NOT_BEFORE);
    rerender(banner());
    expect(screen.queryByText('vault.recoveryBanner.cancelError')).toBeNull();
  });

  it('l errore si azzera quando cambia l id della richiesta', async () => {
    h.open = rec('PENDING_CODE');
    h.cancel.mockRejectedValue(new Error('x'));
    const { rerender } = renderBanner();
    await confirmCancel();
    expect(await screen.findByText('vault.recoveryBanner.cancelError')).toBeInTheDocument();
    h.open = { ...rec('PENDING_CODE'), id: 'r2' };
    rerender(banner());
    expect(screen.queryByText('vault.recoveryBanner.cancelError')).toBeNull();
  });
});
