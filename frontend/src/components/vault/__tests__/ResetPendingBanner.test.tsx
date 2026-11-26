import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${Object.values(o).join('|')}` : k),
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const h = vi.hoisted(() => ({ at: null as string | null, refresh: vi.fn(), cancel: vi.fn(), nav: vi.fn() }));
vi.mock('../../../hooks/useOpenRecovery', () => ({
  useOpenRecovery: () => ({ openRecovery: null, resetScheduledAt: h.at, refresh: h.refresh, markCancelled: vi.fn() }),
}));
vi.mock('../../../lib/vaultApi', async (orig) => ({ ...(await orig<typeof import('../../../lib/vaultApi')>()), cancelReset: (...a: unknown[]) => h.cancel(...a) }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => h.nav }));

import ResetPendingBanner from '../ResetPendingBanner';
import { RESET_CHANGED_EVENT } from '../../../lib/vaultEvents';
import { VaultApiError } from '../../../lib/vaultApi';

const AT = '2026-12-04T10:00:00.000Z';
const textBtn = () => screen.getByRole('button', { name: /^vault\.reset\.banner\.text\|/ });
const mount = (path = '/notes') => render(<MemoryRouter initialEntries={[path]}><ResetPendingBanner /></MemoryRouter>);

beforeEach(() => {
  h.at = AT;
  h.refresh.mockReset().mockResolvedValue(undefined);
  h.cancel.mockReset().mockResolvedValue({ ok: true });
  h.nav.mockReset();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('ResetPendingBanner', () => {
  it('senza reset in attesa non rende nulla', () => {
    h.at = null;
    const { container } = mount();
    expect(container.firstChild).toBeNull();
  });

  it('con un reset in attesa: una riga di testo con la data (niente titolo), nessun pulsante di chiusura', () => {
    mount();
    expect(screen.getByText(/^vault\.reset\.banner\.text\|/)).toBeTruthy();
    expect(screen.queryByText('vault.reset.banner.title')).toBeNull();
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).toBeNull();
  });

  it('data in formato esteso (mese in lettere), mai 12/3/2026', () => {
    mount();
    const txt = screen.getByText(/^vault\.reset\.banner\.text\|/).textContent ?? '';
    expect(txt).toMatch(/Dec/);
    expect(txt).not.toMatch(/\d+\/\d+\/\d{4}/);
  });

  it('su /vault non si rende (la schermata del reset in attesa ha gia\' titolo e pulsante), nemmeno su un sotto-percorso', () => {
    expect(mount('/vault').container.firstChild).toBeNull();
    cleanup();
    expect(mount('/vault/x').container.firstChild).toBeNull();
    cleanup();
    expect(mount('/notes').container.firstChild).not.toBeNull();
  });

  it('"Annulla reset" non e\' il primario verde dentro il banner rosso: stile secondario; target da 44px', () => {
    mount();
    const b = screen.getByRole('button', { name: 'vault.reset.cancel' });
    expect(b.className).not.toContain('bg-gradient'); // non il primario verde
    expect(b.className).toContain('bg-white');
    expect(b.className).toContain('min-h-[44px]');
    expect(textBtn().className).toContain('min-h-[44px]');
  });

  it('compatto su mobile: i pulsanti stanno nella stessa riga, non impilati a tutta larghezza', () => {
    mount();
    const root = screen.getByRole('status');
    expect(root.className).not.toContain('flex-col');
    expect(screen.getByRole('button', { name: 'vault.reset.cancel' }).className).not.toContain('w-full');
  });

  it('il testo stesso è il collegamento al vault (pulsante con nome accessibile = il testo, 44px); nessun pulsante "Dettagli"', () => {
    mount();
    fireEvent.click(textBtn());
    expect(h.nav).toHaveBeenCalledWith('/vault');
    expect(screen.queryByRole('button', { name: 'vault.reset.banner.details' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2); // testo + Annulla reset
  });

  it('il testo non si tronca mai: nessuna classe line-clamp/truncate, può andare a capo', () => {
    const { container } = mount();
    expect(container.innerHTML).not.toMatch(/line-clamp|truncate|text-ellipsis|overflow-hidden/);
    expect(textBtn().className).toContain('text-left');
  });

  it('Annulla reset: chiama cancelReset, avvisa gli altri (evento) e rilegge lo stato', async () => {
    const seen = vi.fn();
    window.addEventListener(RESET_CHANGED_EVENT, seen);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.cancel' }));
    await waitFor(() => expect(h.cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(seen).toHaveBeenCalled());
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    window.removeEventListener(RESET_CHANGED_EVENT, seen);
  });

  it('409 non annullabile: errore mostrato e stato riletto', async () => {
    h.cancel.mockRejectedValue(new VaultApiError(409, 'errors.vault.resetNotCancellable', 'conflict', true));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.cancel' }));
    expect((await screen.findByRole('alert')).textContent).toBe('errors.vault.resetNotCancellable');
    expect(h.refresh).toHaveBeenCalled();
  });

  it('errore generico: messaggio generico, il banner resta', async () => {
    h.cancel.mockRejectedValue(new Error('x'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.cancel' }));
    expect((await screen.findByRole('alert')).textContent).toBe('errors.common.unknownError');
    expect(screen.getByText(/^vault\.reset\.banner\.text\|/)).toBeTruthy();
  });

  it('offline: Annulla reset disabilitato', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    mount();
    expect((screen.getByRole('button', { name: 'vault.reset.cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('un evento di reset cambiato (altra parte dell\'app) rilegge lo stato', async () => {
    mount();
    h.refresh.mockClear();
    act(() => { window.dispatchEvent(new Event(RESET_CHANGED_EVENT)); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
