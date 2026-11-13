import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k) }) }));
vi.mock('../../../lib/vaultRecovery', async (orig) => ({ ...(await orig<typeof import('../../../lib/vaultRecovery')>()), readCodeA: vi.fn() }));
vi.mock('../../../lib/vaultApi', async (orig) => ({ ...(await orig<typeof import('../../../lib/vaultApi')>()), confirmRecovery: vi.fn(), getRecovery: vi.fn() }));

import RecoveryCodeForm from '../RecoveryCodeForm';
import { readCodeA, VaultRecoveryError } from '../../../lib/vaultRecovery';
import { confirmRecovery, getRecovery, VaultApiError, type RecoveryDto } from '../../../lib/vaultApi';

const dto = (over: Partial<RecoveryDto> = {}): RecoveryDto => ({
  status: 'PENDING_CODE', fingerprint: 'FP12', notBefore: null, releaseExpiresAt: null, sealedCodeA: 'x', rootShareForClient: null, rootSignature: null, escrowBlob: null,
  attemptsLeft: 3, expiresAt: '2026-11-20T10:00:00.000Z', ...over,
});
const CODE_A = 'ABCD1234';
const B = () => screen.getByLabelText('vault.recovery.code.halfB') as HTMLInputElement;
const submitBtn = () => screen.getByRole('button', { name: /vault\.recovery\.code\.submit|vault\.recovery\.actions\.retry/ }) as HTMLButtonElement;

const onChange = vi.fn();
const onCancelAndRedo = vi.fn();
const mount = (props: Partial<React.ComponentProps<typeof RecoveryCodeForm>> = {}) =>
  render(<RecoveryCodeForm userId="u1" requestId="r1" fingerprint="FP12" attemptsLeft={4} expiresAt="2026-11-20T10:00:00.000Z" onChange={onChange} onCancelAndRedo={onCancelAndRedo} {...props} />);
const ready = async () => { mount(); await screen.findByDisplayValue(CODE_A); };
const typeB = (v: string) => fireEvent.change(B(), { target: { value: v } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readCodeA).mockResolvedValue(CODE_A);
});

describe('RecoveryCodeForm', () => {
  it('precompila la meta A (sola lettura) e mostra tentativi rimasti e scadenza', async () => {
    mount();
    const a = (await screen.findByDisplayValue(CODE_A)) as HTMLInputElement;
    expect(a.readOnly).toBe(true);
    expect(readCodeA).toHaveBeenCalledWith('u1', 'r1');
    expect(screen.getByText(/vault\.recovery\.code\.attemptsLeft\|\{"n":4\}/)).toBeTruthy();
    expect(screen.getByText(/vault\.recovery\.code\.expiresAt/)).toBeTruthy();
  });

  it('senza attemptsLeft/expiresAt (server vecchio) non mostra le righe', async () => {
    mount({ attemptsLeft: undefined, expiresAt: undefined });
    await screen.findByDisplayValue(CODE_A);
    expect(screen.queryByText(/attemptsLeft/)).toBeNull();
    expect(screen.queryByText(/expiresAt/)).toBeNull();
  });

  it('meta B: autoComplete one-time-code e autoCapitalize characters', async () => {
    await ready();
    expect(B().getAttribute('autocomplete')).toBe('one-time-code');
    expect(B().getAttribute('autocapitalize')).toBe('characters');
  });

  it('notThisDevice: testo con FP, nessun campo, azione "annulla e rifai qui" delegata al padre', async () => {
    vi.mocked(readCodeA).mockRejectedValue(new VaultRecoveryError('notThisDevice'));
    mount();
    expect(await screen.findByText(/vault\.recovery\.code\.notThisDevice\|\{"fingerprint":"FP12"\}/)).toBeTruthy();
    expect(screen.queryByLabelText('vault.recovery.code.halfB')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'vault.recovery.actions.cancelAndRedo' }));
    expect(onCancelAndRedo).toHaveBeenCalledTimes(1);
  });

  it('readCodeA null (non piu PENDING_CODE): onChange', async () => {
    vi.mocked(readCodeA).mockResolvedValue(null);
    mount();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    // il padre puo' restare sulla stessa richiesta (ancora PENDING_CODE): il form non resta su "loading" per sempre
    expect(await screen.findByRole('button', { name: 'vault.recovery.actions.retry' })).toBeTruthy();
  });

  it('invio disabilitato finche la meta B non e valida; normalizza O->0, I/L->1, spazi, trattini e maiuscole', async () => {
    await ready();
    expect(submitBtn().disabled).toBe(true);
    typeB('abc');
    expect(submitBtn().disabled).toBe(true);
    typeB('uuuuuuuu'); // U non e nell'alfabeto Crockford
    expect(submitBtn().disabled).toBe(true);
    typeB('o1Lz-k 9mx');
    expect(submitBtn().disabled).toBe(false);
    vi.mocked(confirmRecovery).mockResolvedValue({ status: 'WAITING', notBefore: 'x' });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(confirmRecovery).toHaveBeenCalledWith('r1', 'ABCD1234', '011ZK9MX'));
  });

  it('meta A non valida: invio disabilitato', async () => {
    vi.mocked(readCodeA).mockResolvedValue('abc');
    mount();
    await screen.findByDisplayValue('abc');
    typeB('ABCD1234');
    expect(submitBtn().disabled).toBe(true);
  });

  it('200: onChange, una sola POST anche con doppio clic', async () => {
    await ready();
    let res!: (v: unknown) => void;
    vi.mocked(confirmRecovery).mockReturnValue(new Promise((r) => { res = r; }) as never);
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    fireEvent.click(submitBtn());
    expect(confirmRecovery).toHaveBeenCalledTimes(1);
    await act(async () => { res({ status: 'WAITING', notBefore: 'x' }); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('403 recoveryInvalidCode: testo, B svuotata, tentativi aggiornati da getRecovery', async () => {
    await ready();
    vi.mocked(confirmRecovery).mockRejectedValue(new VaultApiError(403, 'errors.vault.recoveryInvalidCode', 'forbidden', true));
    vi.mocked(getRecovery).mockResolvedValue(dto({ attemptsLeft: 2 }));
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    expect((await screen.findByRole('alert')).textContent).toContain('errors.vault.recoveryInvalidCode');
    expect(getRecovery).toHaveBeenCalledWith('r1');
    await waitFor(() => expect(screen.getByText(/attemptsLeft\|\{"n":2\}/)).toBeTruthy());
    expect(B().value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('403 con richiesta EXPIRED dopo il refresh: onChange (terminale)', async () => {
    await ready();
    vi.mocked(confirmRecovery).mockRejectedValue(new VaultApiError(403, 'errors.vault.recoveryInvalidCode', 'forbidden', true));
    vi.mocked(getRecovery).mockResolvedValue(dto({ status: 'EXPIRED', attemptsLeft: null }));
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it.each([[410, 'errors.vault.recoveryExpired', 'unknown'], [409, 'errors.vault.recoveryStateConflict', 'conflict']] as const)('%i: onChange', async (status, key, kind) => {
    await ready();
    vi.mocked(confirmRecovery).mockRejectedValue(new VaultApiError(status, key, kind, true));
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('429: "troppi tentativi, riprova tra 15 minuti"', async () => {
    await ready();
    vi.mocked(confirmRecovery).mockRejectedValue(new VaultApiError(429, 'errors.vault.rateLimited', 'rateLimited', true));
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    expect((await screen.findByRole('alert')).textContent).toContain('vault.recovery.code.tooMany');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rete: messaggio e pulsante "Riprova" che rimanda la stessa richiesta', async () => {
    await ready();
    vi.mocked(confirmRecovery).mockRejectedValueOnce(new VaultApiError(0, 'errors.common.networkError', 'network'));
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    expect((await screen.findByRole('alert')).textContent).toContain('errors.common.networkError');
    expect(B().value).toBe('K7Q2M9ZX'); // il codice non si perde su un errore di rete
    expect(submitBtn().textContent).toContain('vault.recovery.actions.retry');
    vi.mocked(confirmRecovery).mockResolvedValue({ status: 'WAITING', notBefore: 'x' });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(confirmRecovery).toHaveBeenCalledTimes(2);
  });

  it('non scrive mai i codici nei log', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await ready();
    vi.mocked(confirmRecovery).mockRejectedValue(new VaultApiError(0, 'errors.common.networkError', 'network'));
    typeB('K7Q2M9ZX');
    fireEvent.click(submitBtn());
    await screen.findByRole('alert');
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/K7Q2M9ZX|ABCD1234/);
    spies.forEach((s) => s.mockRestore());
  });
});
