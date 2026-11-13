// Fase 4 (T9): tab admin del recupero vault. Nessun QueryClientProvider: il rilascio passa da api.post e mai da useMutation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Vitest */
const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  me: 'admin1',
  toastOk: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${Object.values(o).join('|')}` : k), i18n: { language: 'it' } }),
}));
vi.mock('react-hot-toast', () => ({ toast: { success: (...a: unknown[]) => h.toastOk(...a), error: vi.fn() }, default: { success: (...a: unknown[]) => h.toastOk(...a), error: vi.fn() } }));
vi.mock('../../../lib/api', () => ({ default: { get: (...a: unknown[]) => h.get(...a), post: (...a: unknown[]) => h.post(...a) } }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: h.me } }),
}));

import VaultRecoveryTab from '../tabs/VaultRecoveryTab';

const UID = '8f1c2b7e-0000-4000-8000-000000000002';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const view = (o: Record<string, unknown> = {}) => ({
  id: 'r1', userId: 'u1', userEmail: 'mario@example.com', status: 'PENDING_APPROVAL', fingerprint: 'ABCD-1234', reason: 'persa il PIN',
  requestIp: '1.2.3.4', requestUserAgent: 'UA/1', createdAt: '2026-11-12T10:00:00.000Z', expiresAt: FUTURE, notBefore: null,
  attempts: 2, rejectReason: null, keyringStatus: 'READY', rootKeyId: 'rk_x', readyForRelease: false, ...o,
});
const apiErr = (status: number, message: string) => ({ response: { status, data: { message } } });

let items: Record<string, any[]>;
let detail: any;
beforeEach(() => {
  vi.clearAllMocks();
  h.me = 'admin1';
  items = { PENDING_APPROVAL: [view()], PENDING_CODE: [], WAITING: [], RELEASED: [] };
  detail = { ...view(), audit: [{ event: 'vault.recovery.requested', userId: 'u1', createdAt: '2026-11-12T10:00:00.000Z' }] };
  h.get.mockImplementation(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
    if (url === '/admin/vault-recovery') {
      const st = cfg?.params?.status as string | undefined;
      const list = st ? (items[st] ?? []) : Object.values(items).flat();
      return { data: { items: list, total: list.length, page: 1, limit: 50 } };
    }
    return { data: detail };
  });
  h.post.mockResolvedValue({ data: {} });
});

const openDetail = async () => {
  render(<VaultRecoveryTab />);
  fireEvent.click(await screen.findByText('mario@example.com'));
  return within(await screen.findByRole('dialog', { name: 'admin.vaultRecovery.detail.title' }));
};

describe('VaultRecoveryTab: lista', () => {
  it('di default carica le richieste aperte (un GET per stato aperto) e le mostra', async () => {
    items.WAITING = [view({ id: 'r2', userEmail: 'anna@example.com', status: 'WAITING' })];
    render(<VaultRecoveryTab />);
    await screen.findByText('mario@example.com');
    await screen.findByText('anna@example.com');
    const statuses = h.get.mock.calls.filter((c) => c[0] === '/admin/vault-recovery').map((c) => c[1].params.status).sort();
    expect(statuses).toEqual(['PENDING_APPROVAL', 'PENDING_CODE', 'RELEASED', 'WAITING']);
  });

  it('filtro "tutte": un solo GET senza status', async () => {
    render(<VaultRecoveryTab />);
    await screen.findByText('mario@example.com');
    h.get.mockClear();
    fireEvent.change(screen.getByLabelText('admin.vaultRecovery.filterLabel'), { target: { value: 'all' } });
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/admin/vault-recovery', { params: expect.not.objectContaining({ status: expect.anything() }) }));
  });

  it('filtro per utente: userId valido nei parametri, non valido ignorato con avviso', async () => {
    render(<VaultRecoveryTab />);
    await screen.findByText('mario@example.com');
    h.get.mockClear();
    const input = screen.getByLabelText('admin.vaultRecovery.userIdLabel');
    fireEvent.change(input, { target: { value: 'non-un-uuid' } });
    expect(screen.getByRole('alert').textContent).toContain('admin.vaultRecovery.userIdInvalid');
    expect(h.get).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '8f1c2b7e-0000-4000-8000-000000000001' } });
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/admin/vault-recovery', { params: expect.objectContaining({ userId: '8f1c2b7e-0000-4000-8000-000000000001' }) }));
  });

  it('nessuna richiesta: testo vuoto', async () => {
    items = { PENDING_APPROVAL: [], PENDING_CODE: [], WAITING: [], RELEASED: [] };
    render(<VaultRecoveryTab />);
    await screen.findByText('admin.vaultRecovery.empty');
  });
});

describe('VaultRecoveryTab: dettaglio e azioni', () => {
  it('il dettaglio e un dialog modale con i campi della richiesta e l\'audit', async () => {
    const d = await openDetail();
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    // in portale su body: dentro AppLayout (safe-area-top) il fixed non coprirebbe tutto il viewport
    expect(screen.getByRole('dialog').parentElement?.parentElement).toBe(document.body);
    expect(d.getByText('1.2.3.4')).toBeTruthy();
    expect(d.getByText('UA/1')).toBeTruthy();
    expect(d.getByText('ABCD-1234')).toBeTruthy();
    expect(d.getByText('persa il PIN')).toBeTruthy();
    expect(d.getByText('rk_x')).toBeTruthy();
    expect(d.getByText('vault.recovery.requested')).toBeTruthy();
    expect(h.get).toHaveBeenCalledWith('/admin/vault-recovery/r1');
  });

  it('il backdrop sta a z-50, non sotto la sidebar desktop (z-50 in AppLayout)', async () => {
    await openDetail();
    expect(screen.getByRole('dialog').parentElement?.className).toContain('z-50');
  });

  it('scroll del body bloccato col dettaglio aperto, anche dopo il ConfirmDialog annidato, e rilasciato alla chiusura', async () => {
    const d = await openDetail();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.change(d.getByLabelText('admin.vaultRecovery.rejectReason'), { target: { value: 'sospetto' } });
    fireEvent.click(d.getByText('admin.vaultRecovery.reject'));
    await screen.findByText('admin.vaultRecovery.rejectConfirm');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByText('common.cancel')); // il cleanup del ConfirmDialog mette 'unset'
    await waitFor(() => expect(screen.queryByText('admin.vaultRecovery.rejectConfirm')).toBeNull());
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByLabelText('common.close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('approva: POST approve poi il dettaglio si rilegge', async () => {
    const d = await openDetail();
    h.get.mockClear();
    fireEvent.click(d.getByText('admin.vaultRecovery.approve'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/admin/vault-recovery/r1/approve'));
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/admin/vault-recovery/r1'));
  });

  it('rifiuta: senza motivo il pulsante e disabilitato; con il motivo serve la conferma, poi POST reject col motivo', async () => {
    const d = await openDetail();
    const btn = d.getByText('admin.vaultRecovery.reject').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const reason = d.getByLabelText('admin.vaultRecovery.rejectReason') as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(500);
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(btn.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'sospetto' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(h.post).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText('admin.vaultRecovery.rejectConfirm'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/admin/vault-recovery/r1/reject', { reason: 'sospetto' }));
  });

  it('approva e rifiuta compaiono solo in PENDING_APPROVAL', async () => {
    detail = { ...view({ status: 'PENDING_CODE' }), audit: [] };
    items = { PENDING_APPROVAL: [], PENDING_CODE: [detail], WAITING: [], RELEASED: [] };
    const d = await openDetail();
    expect(d.queryByText('admin.vaultRecovery.approve')).toBeNull();
    expect(d.queryByText('admin.vaultRecovery.reject')).toBeNull();
  });

  it('rilascio: non pronto -> niente campo passphrase, "disponibile da"', async () => {
    detail = { ...view({ status: 'WAITING', notBefore: FUTURE, readyForRelease: false }), audit: [] };
    items = { PENDING_APPROVAL: [], PENDING_CODE: [], WAITING: [detail], RELEASED: [] };
    const d = await openDetail();
    expect(d.queryByLabelText('admin.vaultRecovery.passphrase')).toBeNull();
    expect(d.queryByText('admin.vaultRecovery.release')).toBeNull();
    expect(d.getByText(/admin\.vaultRecovery\.availableFrom/)).toBeTruthy();
  });

  it('"cronologia dell\'utente" imposta il filtro userId e chiude il dettaglio', async () => {
    detail = { ...detail, userId: UID };
    const d = await openDetail();
    h.get.mockClear();
    fireEvent.click(d.getByText('admin.vaultRecovery.detail.history'));
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/admin/vault-recovery', { params: expect.objectContaining({ userId: UID }) }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('VaultRecoveryTab: rilascio', () => {
  const ready = () => {
    detail = { ...view({ status: 'WAITING', notBefore: PAST, readyForRelease: true }), audit: [] };
    items = { PENDING_APPROVAL: [], PENDING_CODE: [], WAITING: [detail], RELEASED: [] };
  };
  const startRelease = async (pass = 'frase-root') => {
    const d = await openDetail();
    const input = d.getByLabelText('admin.vaultRecovery.passphrase') as HTMLInputElement;
    expect(input.type).toBe('password');
    // ne' il browser riempie la password di login dell'admin, ne' un password manager propone di salvare la frase root
    expect(input.autocomplete).toBe('one-time-code');
    for (const a of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) expect(input.hasAttribute(a)).toBe(true);
    expect(input.getAttribute('data-lpignore')).toBe('true');
    fireEvent.change(input, { target: { value: pass } });
    fireEvent.click(d.getByText('admin.vaultRecovery.release'));
    return { d, input };
  };
  const confirm = async () => fireEvent.click(await screen.findByText('admin.vaultRecovery.releaseConfirm'));

  it('pronto: la conferma non invia nulla finche non si conferma', async () => {
    ready();
    await startRelease();
    await screen.findByText('admin.vaultRecovery.releaseConfirm');
    expect(h.post).not.toHaveBeenCalled();
  });

  it('la passphrase e svuotata PRIMA che la POST si risolva; api.post chiamata direttamente', async () => {
    ready();
    let resolve!: (v: unknown) => void;
    h.post.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { input } = await startRelease('frase-root');
    await confirm();
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/admin/vault-recovery/r1/release', { passphrase: 'frase-root' }));
    expect(input.value).toBe(''); // la POST e ancora in volo
    await act(async () => { resolve({ data: { status: 'RELEASED' } }); });
    await waitFor(() => expect(h.toastOk).toHaveBeenCalled());
  });

  it.each([
    [403, 'errors.vault.invalidRootPassphrase', 'admin.vaultRecovery.errors.invalidPassphrase'],
    [429, 'errors.vault.recoveryReleaseRateLimited', 'admin.vaultRecovery.errors.rateLimited'],
    [503, 'errors.vault.rootKeyUnavailable', 'admin.vaultRecovery.errors.rootKeyUnavailable'],
    [409, 'errors.vault.recoveryKeyringChanged', 'admin.vaultRecovery.errors.keyringChanged'],
    [409, 'errors.vault.recoveryStateConflict', 'admin.vaultRecovery.errors.stateConflict'],
    [500, 'errors.common.unknownError', 'admin.vaultRecovery.errors.generic'],
  ])('errore %i %s -> testo dedicato, campo vuoto, dettaglio riletto', async (status, message, text) => {
    ready();
    h.post.mockRejectedValue(apiErr(status, message));
    const { input } = await startRelease();
    h.get.mockClear();
    await confirm();
    const alert = await screen.findByText(text);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(input.value).toBe('');
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/admin/vault-recovery/r1'));
  });

  it('la passphrase non compare mai nei log ne nei messaggi d\'errore', async () => {
    ready();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.post.mockRejectedValue(apiErr(403, 'errors.vault.invalidRootPassphrase'));
    await startRelease('segretissima');
    await confirm();
    await screen.findByText('admin.vaultRecovery.errors.invalidPassphrase');
    expect(document.body.textContent).not.toContain('segretissima');
    expect(JSON.stringify([...spy.mock.calls, ...log.mock.calls])).not.toContain('segretissima');
    spy.mockRestore();
    log.mockRestore();
  });

  it('l\'admin che rilascia il proprio recupero vede l\'avviso dedicato nella conferma', async () => {
    ready();
    h.me = 'u1';
    await startRelease();
    expect((await screen.findByText(/admin\.vaultRecovery\.releaseConfirmSelf/))).toBeTruthy();
  });

  it('un altro utente: messaggio di conferma normale, senza avviso self', async () => {
    ready();
    await startRelease();
    await screen.findByText('admin.vaultRecovery.releaseConfirmMessage');
    expect(screen.queryByText(/releaseConfirmSelf/)).toBeNull();
  });
});
