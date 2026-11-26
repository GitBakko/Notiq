import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${Object.values(o).join('|')}` : k), i18n: { language: 'en' } }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const h = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock('../../../lib/vaultApi', async (orig) => ({ ...(await orig<typeof import('../../../lib/vaultApi')>()), cancelReset: (...a: unknown[]) => h.cancel(...a) }));

import ResetPendingScreen from '../ResetPendingScreen';
import { RESET_CHANGED_EVENT } from '../../../lib/vaultEvents';
import { VaultApiError } from '../../../lib/vaultApi';

beforeEach(() => {
  h.cancel.mockReset().mockResolvedValue({ ok: true });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('ResetPendingScreen', () => {
  it('mostra titolo e data della cancellazione', () => {
    render(<ResetPendingScreen scheduledAt="2026-12-04T10:00:00.000Z" />);
    expect(screen.getByText('vault.reset.pending.title')).toBeTruthy();
    const txt = screen.getByText(/^vault\.reset\.pending\.text\|/).textContent ?? '';
    expect(txt).toMatch(/Dec/);
    expect(txt).not.toMatch(/\d+\/\d+\/\d{4}/);
  });

  it('"Annulla reset" in stile secondario (non il primario verde), 44px; layout come le altre schermate del Gate (VaultUnlock)', () => {
    const { container } = render(<ResetPendingScreen scheduledAt={null} />);
    const b = screen.getByRole('button', { name: 'vault.reset.cancel' });
    expect(b.className).not.toContain('bg-gradient'); // non il primario verde
    expect(b.className).toContain('bg-white');
    expect(b.className).toContain('min-h-[44px]');
    expect((container.firstChild as HTMLElement).className).toContain('flex-col');
    expect((container.firstChild as HTMLElement).className).toContain('h-full');
  });

  it('senza data (server vecchio): testo senza data', () => {
    render(<ResetPendingScreen scheduledAt={null} />);
    expect(screen.getByText('vault.reset.pending.textNoDate')).toBeTruthy();
  });

  it('Annulla reset: cancelReset e RESET_CHANGED_EVENT', async () => {
    const seen = vi.fn();
    window.addEventListener(RESET_CHANGED_EVENT, seen);
    render(<ResetPendingScreen scheduledAt={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.cancel' }));
    await waitFor(() => expect(h.cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(seen).toHaveBeenCalled());
    window.removeEventListener(RESET_CHANGED_EVENT, seen);
  });

  it('errore: messaggio con la chiave del server', async () => {
    h.cancel.mockRejectedValue(new VaultApiError(409, 'errors.vault.resetNotCancellable', 'conflict', true));
    render(<ResetPendingScreen scheduledAt={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.cancel' }));
    expect((await screen.findByRole('alert')).textContent).toBe('errors.vault.resetNotCancellable');
  });

  it('offline: il pulsante e\' disabilitato e il testo lo spiega', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<ResetPendingScreen scheduledAt={null} />);
    expect((screen.getByRole('button', { name: 'vault.reset.cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('vault.reset.pending.offline')).toBeTruthy();
  });
});
