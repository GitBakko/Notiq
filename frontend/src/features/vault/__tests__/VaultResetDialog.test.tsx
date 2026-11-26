import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k), i18n: { language: 'en' } }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/vaultApi', async (orig) => ({ ...(await orig<typeof import('../../../lib/vaultApi')>()), resetChallenge: vi.fn(), confirmReset: vi.fn() }));

import VaultResetDialog from '../VaultResetDialog';
import { normalizeResetCode } from '../resetCode';
import { resetChallenge, confirmReset, VaultApiError } from '../../../lib/vaultApi';
import { RESET_CHANGED_EVENT } from '../../../lib/vaultEvents';

const CH = { requestId: 'req-1', code: 'ABCD-EFGH-JKMN', expiresAt: '2026-11-27T10:10:00.000Z', counts: { notes: 3, tags: 2, attachments: 1 } };
const SCHEDULED = '2026-12-04T10:00:00.000Z';
const onClose = vi.fn();
const onScheduled = vi.fn();

const mount = () => render(<VaultResetDialog isOpen onClose={onClose} onScheduled={onScheduled} />);
const next = () => screen.getByRole('button', { name: 'vault.reset.start' }) as HTMLButtonElement;
const submit = () => screen.getByRole('button', { name: 'vault.reset.submit' }) as HTMLButtonElement;
const codeInput = () => screen.getByLabelText('vault.reset.codeLabel') as HTMLInputElement;
const pwInput = () => screen.getByLabelText('vault.reset.passwordLabel') as HTMLInputElement;
const toCodeStep = async () => { mount(); fireEvent.click(next()); await screen.findByLabelText('vault.reset.codeLabel'); };
const err = (status: number, key: string) => new VaultApiError(status, key, 'unknown', true);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resetChallenge).mockResolvedValue(CH);
  vi.mocked(confirmReset).mockResolvedValue({ scheduledAt: SCHEDULED });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });

describe('normalizeResetCode', () => {
  it('maiuscole, trattini e spazi indifferenti; alias Crockford', () => {
    expect(normalizeResetCode('abcd-efgh jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeResetCode('ab0o-1ilu')).toBe('AB00111U');
  });
});

describe('VaultResetDialog', () => {
  it('passo 1: dialog accessibile, avviso di perdita (anche modifiche non sincronizzate offline), nessuna challenge finche\' non si continua', () => {
    mount();
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('vault.reset.intro')).toBeTruthy();
    expect(screen.getByText('vault.reset.waitNote')).toBeTruthy();
    expect(screen.getByText('vault.reset.offlineLoss')).toBeTruthy();
    expect(resetChallenge).not.toHaveBeenCalled();
  });

  it('continua: chiede la challenge e mostra conteggi e codice da riscrivere', async () => {
    await toCodeStep();
    expect(resetChallenge).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/vault\.reset\.counts\|\{"notes":3,"tags":2,"attachments":1\}/)).toBeTruthy();
    expect(screen.getByText('ABCD-EFGH-JKMN')).toBeTruthy();
  });

  it('il pulsante resta disabilitato finche\' codice e password non sono validi', async () => {
    await toCodeStep();
    expect(submit().disabled).toBe(true);
    fireEvent.change(codeInput(), { target: { value: 'ABCD-EFGH-JKM' } }); // incompleto
    fireEvent.change(pwInput(), { target: { value: 'pw' } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(codeInput(), { target: { value: 'ABCD-EFGH-JKMX' } }); // sbagliato
    expect(submit().disabled).toBe(true);
    fireEvent.change(codeInput(), { target: { value: 'ABCD-EFGH-JKMN' } });
    expect(submit().disabled).toBe(false);
    fireEvent.change(pwInput(), { target: { value: '' } });
    expect(submit().disabled).toBe(true);
  });

  it('maiuscole e trattini indifferenti', async () => {
    await toCodeStep();
    fireEvent.change(pwInput(), { target: { value: 'pw' } });
    for (const v of ['abcdefghjkmn', 'abcd-efgh-jkmn', 'ABCDEFGHJKMN', ' abcd efgh jkmn ']) {
      fireEvent.change(codeInput(), { target: { value: v } });
      expect(submit().disabled).toBe(false);
    }
  });

  it('incollare e\' permesso', async () => {
    await toCodeStep();
    fireEvent.change(pwInput(), { target: { value: 'pw' } });
    await userEvent.click(codeInput());
    await userEvent.paste('abcd-efgh-jkmn');
    expect(submit().disabled).toBe(false);
  });

  it('testi, avviso ed etichette allineati a sinistra (il dialog puo\' stare dentro una scheda con text-center)', async () => {
    mount();
    expect(screen.getByText('vault.reset.intro').closest('div[class*="text-left"]')).toBeTruthy();
    fireEvent.click(next());
    await screen.findByLabelText('vault.reset.codeLabel');
    expect(screen.getByText('vault.reset.codeIntro').closest('form')!.className).toContain('text-left');
  });

  it('campi: autocomplete e tipo giusti, target da 44px', async () => {
    await toCodeStep();
    expect(pwInput().type).toBe('password');
    expect(pwInput().getAttribute('autocomplete')).toBe('current-password');
    expect(codeInput().getAttribute('autocomplete')).toBe('off');
    expect(submit().className).toContain('min-h-[44px]');
  });

  it('invio: prima il ConfirmDialog finale, la conferma chiama confirmReset col codice normalizzato e la password', async () => {
    const seen = vi.fn();
    window.addEventListener(RESET_CHANGED_EVENT, seen);
    await toCodeStep();
    fireEvent.change(codeInput(), { target: { value: 'abcd-efgh-jkmn' } });
    fireEvent.change(pwInput(), { target: { value: 's3cret' } });
    fireEvent.click(submit());
    expect(confirmReset).not.toHaveBeenCalled();
    expect(screen.getByText('vault.reset.confirmTitle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.confirmAction' }));
    await waitFor(() => expect(confirmReset).toHaveBeenCalledWith('req-1', 'ABCDEFGHJKMN', 's3cret'));
    await waitFor(() => expect(onScheduled).toHaveBeenCalledWith(SCHEDULED));
    const toastText = String(vi.mocked(toast.success).mock.calls[0][0]);
    expect(toastText).toMatch(/Dec/); // data in formato esteso
    expect(toastText).not.toMatch(/\d+\/\d+\/\d{4}/);
    expect(onClose).toHaveBeenCalled();
    expect(seen).toHaveBeenCalled();
    window.removeEventListener(RESET_CHANGED_EVENT, seen);
  });

  it('annulla nel ConfirmDialog: nessuna chiamata, si torna al form coi dati', async () => {
    await toCodeStep();
    fireEvent.change(codeInput(), { target: { value: 'ABCDEFGHJKMN' } });
    fireEvent.change(pwInput(), { target: { value: 'pw' } });
    fireEvent.click(submit());
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(confirmReset).not.toHaveBeenCalled();
    expect(pwInput().value).toBe('pw');
  });

  it('password errata (403): errore sul form, password svuotata, mai chiusura', async () => {
    vi.mocked(confirmReset).mockRejectedValue(err(403, 'errors.vault.resetInvalidPassword'));
    await toCodeStep();
    fireEvent.change(codeInput(), { target: { value: 'ABCDEFGHJKMN' } });
    fireEvent.change(pwInput(), { target: { value: 'bad' } });
    fireEvent.click(submit());
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.confirmAction' }));
    expect((await screen.findByRole('alert')).textContent).toBe('errors.vault.resetInvalidPassword');
    expect(pwInput().value).toBe('');
    expect(onScheduled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('codice scaduto (410): torna al primo passo con il messaggio e serve una nuova challenge', async () => {
    vi.mocked(confirmReset).mockRejectedValue(err(410, 'errors.vault.resetExpired'));
    await toCodeStep();
    fireEvent.change(codeInput(), { target: { value: 'ABCDEFGHJKMN' } });
    fireEvent.change(pwInput(), { target: { value: 'pw' } });
    fireEvent.click(submit());
    fireEvent.click(screen.getByRole('button', { name: 'vault.reset.confirmAction' }));
    expect((await screen.findByRole('alert')).textContent).toBe('errors.vault.resetExpired');
    expect(screen.queryByLabelText('vault.reset.codeLabel')).toBeNull();
    fireEvent.click(next());
    await waitFor(() => expect(resetChallenge).toHaveBeenCalledTimes(2));
  });

  it('challenge rifiutata (409 notReady, 429): errore sul primo passo', async () => {
    vi.mocked(resetChallenge).mockRejectedValue(err(429, 'errors.vault.resetRateLimited'));
    mount();
    fireEvent.click(next());
    expect((await screen.findByRole('alert')).textContent).toBe('errors.vault.resetRateLimited');
  });

  it('errore senza chiave del server: messaggio generico', async () => {
    vi.mocked(resetChallenge).mockRejectedValue(new Error('x'));
    mount();
    fireEvent.click(next());
    expect((await screen.findByRole('alert')).textContent).toBe('errors.common.unknownError');
  });

  it('offline: non si puo\' continuare e il testo lo dice', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    mount();
    expect(next().disabled).toBe(true);
    expect(screen.getByText('vault.reset.offline')).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(resetChallenge).not.toHaveBeenCalled();
  });

  it('Esc e chiudi chiamano onClose', () => {
    mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
