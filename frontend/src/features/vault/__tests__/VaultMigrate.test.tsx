import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const m = vi.hoisted(() => ({
  flush: vi.fn(),
  migrate: vi.fn(),
  close: vi.fn(),
  setup: vi.fn(),
  unlock: vi.fn(),
  confirmKit: vi.fn(),
  pinReject: false,
}));

vi.mock('../vaultMigration', async (orig) => ({
  ...(await orig<typeof import('../vaultMigration')>()),
  flushPending: m.flush,
  migrateLegacy: m.migrate,
  closeMigration: m.close,
  createLegacyDecryptor: () => ({ size: 1, decrypt: async () => null, terminate: () => {} }),
}));
vi.mock('../../../lib/vaultSession', () => ({ setup: m.setup, unlockOnline: m.unlock, confirmKit: m.confirmKit }));
vi.mock('../PinPolicy', () => ({ checkPin: async (p: string) => (m.pinReject ? Promise.reject(new Error('chunk')) : p === 'weak' ? { ok: false, reason: 'common' } : { ok: true }) }));

import VaultMigrate from '../VaultMigrate';
import { useVaultStore, type VaultKeys } from '../../../store/vaultStore';

const U = 'u1';
const result = (o = {}) => ({ migrated: 3, locked: [], tooLarge: [], conflicts: [], unverified: [], failed: [], notFound: 0, ...o });
let kit: Uint8Array;
const renderKit = vi.fn((k: Uint8Array, onConfirmed: () => void) => <button onClick={onConfirmed}>kit-done{k.length}</button>);
const onDone = vi.fn();
const rootKey = { id: 'rk_x', ecdhSpki: new Uint8Array(1) };

const fill = (pin = 'k7Rq2x', pin2 = pin) => {
  fireEvent.change(screen.getByLabelText('vault.migrate.newPin'), { target: { value: pin } });
  fireEvent.change(screen.getByLabelText('vault.confirmPin'), { target: { value: pin2 } });
  fireEvent.change(screen.getByLabelText('vault.migrate.password'), { target: { value: 'account-pw' } });
  fireEvent.click(screen.getByRole('checkbox'));
};
const submit = () => fireEvent.click(screen.getByText('vault.migrate.start'));

beforeEach(() => {
  vi.clearAllMocks();
  m.pinReject = false;
  kit = new Uint8Array([1, 2, 3]);
  m.flush.mockResolvedValue(undefined);
  m.setup.mockResolvedValue({ ok: true, kit, offlineSaved: true });
  m.migrate.mockResolvedValue(result());
  m.close.mockResolvedValue({});
  m.confirmKit.mockResolvedValue(undefined);
  m.unlock.mockResolvedValue({ offlineSaved: false });
  useVaultStore.setState({ keys: { vkHkdf: {}, vkAes: {}, sigKey: {} } as unknown as VaultKeys, unlockedUserId: U, epoch: 1, isUnlocked: true });
});

describe('VaultMigrate', () => {
  it('PIN diversi o debole: errore nel modulo, niente flush ne setup', async () => {
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill('k7Rq2x', 'k7Rq2y');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('vault.pinMismatch');
    fireEvent.change(screen.getByLabelText('vault.migrate.newPin'), { target: { value: 'weak' } });
    fireEvent.change(screen.getByLabelText('vault.confirmPin'), { target: { value: 'weak' } });
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('vault.pinPolicy.common'));
    expect(m.flush).not.toHaveBeenCalled();
    expect(m.setup).not.toHaveBeenCalled();
  });

  it('checkPin che rigetta: torna al modulo con errore e un nuovo submit e possibile', async () => {
    m.pinReject = true;
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.common.unknownError');
    expect(m.flush).not.toHaveBeenCalled();
    m.pinReject = false;
    submit();
    expect(await screen.findByText('kit-done3')).toBeTruthy();
  });

  it('flusso completo: flush, setup, Kit, migrazione coi vecchi PIN non vuoti, chiusura, fine', async () => {
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('vault.migrate.oldPinLabel'), { target: { value: 'old111' } });
    fireEvent.click(screen.getByText('vault.migrate.addOldPin')); // secondo campo lasciato vuoto
    fill();
    submit();
    fireEvent.click(await screen.findByText('kit-done3'));
    expect(m.flush).toHaveBeenCalledWith(U, expect.anything());
    expect(m.setup).toHaveBeenCalledWith({ userId: U, pin: 'k7Rq2x', password: 'account-pw', rootKey });
    await waitFor(() => expect(screen.getByText('vault.migrate.finish')).toBeTruthy());
    expect(m.confirmKit).toHaveBeenCalledWith(U);
    expect(Array.from(kit)).toEqual([0, 0, 0]); // Kit azzerato dopo la conferma
    expect(m.migrate.mock.calls[0][0].pins).toEqual(['old111']);
    expect(m.close.mock.calls[0][0].pins).toEqual(['old111']);
    expect(m.migrate.mock.invocationCallOrder[0]).toBeLessThan(m.close.mock.invocationCallOrder[0]);
    fireEvent.click(screen.getByText('vault.migrate.finish'));
    expect(onDone).toHaveBeenCalled();
  });

  it('409 alreadySetup: chiede il PIN dell\'altro dispositivo, sblocca e migra senza Kit', async () => {
    m.setup.mockResolvedValue({ ok: false, reason: 'alreadySetup' });
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    submit();
    fireEvent.change(await screen.findByLabelText('vault.enterPin'), { target: { value: 'other1' } });
    fireEvent.click(screen.getByText('vault.migrate.unlockButton'));
    await waitFor(() => expect(m.migrate).toHaveBeenCalled());
    expect(m.unlock).toHaveBeenCalledWith(U, 'other1');
    expect(renderKit).not.toHaveBeenCalled();
  });

  it('setup rifiutato (password): si torna al modulo con il messaggio, campi intatti', async () => {
    m.setup.mockRejectedValue({ key: 'errors.vault.invalidPassword' });
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.vault.invalidPassword');
    expect(screen.getByLabelText('vault.migrate.newPin')).toHaveValue('k7Rq2x');
    expect(m.migrate).not.toHaveBeenCalled();
  });

  it('flush in timeout: errore con "riprova" che torna al modulo', async () => {
    const { MigrationError } = await import('../vaultMigration');
    m.flush.mockRejectedValue(new MigrationError('flushTimeout'));
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('vault.migrate.errors.flushTimeout');
    expect(m.setup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('vault.migrate.retry'));
    expect(await screen.findByLabelText('vault.migrate.newPin')).toBeTruthy();
  });

  // closeMigration vero attende il signal (lock di un altro tab): il mock fa lo stesso e risolve skipped:'busy'
  const closeWaitsSignal = () =>
    m.close.mockImplementationOnce((o: { signal: AbortSignal }) => new Promise((res) => o.signal.addEventListener('abort', () => res({ skipped: 'busy' }))));

  it('chiusura bloccata: "Annulla" interrompe, avviso busy, "riprova" rilancia solo la chiusura', async () => {
    closeWaitsSignal();
    m.close.mockResolvedValueOnce({});
    render(<VaultMigrate userId={U} resume rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    submit();
    const cancel = await screen.findByRole('button', { name: 'common.cancel' });
    expect(cancel.className).toContain('min-h-[44px]');
    fireEvent.click(cancel);
    expect(await screen.findByRole('alert')).toHaveTextContent('vault.migrate.errors.busy');
    fireEvent.click(screen.getByText('vault.migrate.retry'));
    await waitFor(() => expect(screen.getByText('vault.migrate.finish')).toBeTruthy());
    expect(m.migrate).toHaveBeenCalledTimes(1);
    expect(m.close).toHaveBeenCalledTimes(2);
    expect(m.flush).not.toHaveBeenCalled();
    expect(m.setup).not.toHaveBeenCalled();
  });

  it('chiusura bloccata: dopo 30 s scatta il timeout automatico (busy)', async () => {
    vi.useFakeTimers();
    try {
      closeWaitsSignal();
      render(<VaultMigrate userId={U} resume rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
      submit();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(screen.queryByRole('alert')).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(screen.getByRole('alert')).toHaveTextContent('vault.migrate.errors.busy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('chiusura con vault bloccato a meta (aborted): errore locked, non il riepilogo di successo', async () => {
    m.close.mockResolvedValueOnce({ aborted: true });
    render(<VaultMigrate userId={U} resume rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('vault.migrate.errors.locked');
    expect(screen.queryByText('vault.migrate.finish')).toBeNull();
  });

  it('chiusura con keyring non READY (notReady): errore dedicato, non "locked"', async () => {
    m.close.mockResolvedValueOnce({ skipped: 'notReady' });
    render(<VaultMigrate userId={U} resume rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('vault.migrate.errors.notReady');
  });

  it('due submit nello stesso tick: un solo setup e il Kit mostrato', async () => {
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    const form = screen.getByText('vault.migrate.start').closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(await screen.findByText('kit-done3')).toBeTruthy();
    expect(m.setup).toHaveBeenCalledTimes(1);
    expect(m.flush).toHaveBeenCalledTimes(1);
  });

  it('pagina smontata durante il setup: vault richiuso e Kit azzerato', async () => {
    let done!: (v: unknown) => void;
    m.setup.mockReturnValueOnce(new Promise((res) => { done = res; }));
    const lock = vi.spyOn(useVaultStore.getState(), 'lockVault').mockResolvedValue(undefined);
    const { unmount } = render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    submit();
    await waitFor(() => expect(m.setup).toHaveBeenCalled());
    unmount();
    await act(async () => { done({ ok: true, kit, offlineSaved: true }); });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(Array.from(kit)).toEqual([0, 0, 0]);
  });

  it('409: "Annulla" esce dal wizard', async () => {
    m.setup.mockResolvedValue({ ok: false, reason: 'alreadySetup' });
    render(<VaultMigrate userId={U} rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    fill();
    submit();
    await screen.findByLabelText('vault.enterPin');
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onDone).toHaveBeenCalled();
  });

  it('credenziali bloccate: riepilogo e nuovo tentativo con un altro PIN', async () => {
    m.migrate.mockResolvedValueOnce(result({ locked: ['c1'] })).mockResolvedValueOnce(result({ migrated: 1 }));
    render(<VaultMigrate userId={U} resume rootKey={rootKey} renderKit={renderKit} onDone={onDone} />);
    submit();
    expect(await screen.findByText('vault.migrate.lockedSummary')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('vault.migrate.oldPinLabel'), { target: { value: 'old222' } });
    fireEvent.click(screen.getByText('vault.migrate.retry'));
    await waitFor(() => expect(m.migrate).toHaveBeenCalledTimes(2));
    expect(m.migrate.mock.calls[1][0].pins).toEqual(['old222']);
  });
});
