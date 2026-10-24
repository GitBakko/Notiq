import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const h = vi.hoisted(() => ({ unlockedUserId: 'u1' as string | null, touch: vi.fn() }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1', email: 'a@b.it', name: 'A', surname: 'B' } }),
}));
vi.mock('../../../store/vaultStore', () => ({
  useVaultStore: Object.assign((sel: (s: unknown) => unknown) => sel({ unlockedUserId: h.unlockedUserId }), { getState: () => ({ touchVault: h.touch }) }),
}));
vi.mock('../../../lib/vaultReconcile', () => ({ vaultReconcile: vi.fn() }));
vi.mock('../RecoveryKitSheet', () => ({ default: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>vault.kit.title</button> }));
vi.mock('../../../lib/vaultSession', () => ({ changePin: vi.fn(), regenerateKit: vi.fn(), confirmKit: vi.fn(async () => {}) }));
vi.mock('../../../utils/vaultRootKeys', () => ({ getActiveRootKey: vi.fn() }));
vi.mock('../PinPolicy', () => ({ checkPin: vi.fn(async () => ({ ok: true })) }));

import VaultSettingsSheet from '../VaultSettingsSheet';
import { changePin, regenerateKit } from '../../../lib/vaultSession';
import { vaultReconcile } from '../../../lib/vaultReconcile';
import toast from 'react-hot-toast';
import { getActiveRootKey } from '../../../utils/vaultRootKeys';
import { checkPin } from '../PinPolicy';

const ROOT = { id: 'rk_x', ecdhSpki: new Uint8Array([1]) };
const result = (o: object) => ({ hydrated: 0, conflictsResolved: 0, copies: 0, legacyResolved: 0, reactivated: 0, finalized: 0, legacyLeft: 0, unresolved: 0, later: 0, ...o });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  h.unlockedUserId = 'u1';
  vi.mocked(getActiveRootKey).mockReturnValue(ROOT);
  vi.mocked(checkPin).mockResolvedValue({ ok: true });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('VaultSettingsSheet', () => {
  it('chiuso: non rende nulla', () => {
    const { container } = render(<VaultSettingsSheet isOpen={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('da bloccato: nessun form, solo errors.vault.locked', () => {
    h.unlockedUserId = null;
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    expect(screen.getByText('errors.vault.locked')).toBeTruthy();
    expect(screen.queryByText('vault.settings.changePinButton')).toBeNull();
    expect(screen.queryByText('vault.settings.kitButton')).toBeNull();
  });

  it('cambio PIN: policy e conferma prima della chiamata; poi changePin con PIN attuale e nuovo', async () => {
    vi.mocked(changePin).mockResolvedValue();
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.currentPin', 'old111');
    type('vault.settings.newPin', 'k7Rq2x');
    type('vault.confirmPin', 'zzzzzz');
    fireEvent.click(screen.getByText('vault.settings.changePinButton'));
    await waitFor(() => expect(screen.getByText('vault.pinMismatch')).toBeTruthy());
    expect(changePin).not.toHaveBeenCalled();

    type('vault.confirmPin', 'k7Rq2x');
    fireEvent.click(screen.getByText('vault.settings.changePinButton'));
    await waitFor(() => expect(changePin).toHaveBeenCalledWith({ userId: 'u1', currentPin: 'old111', newPin: 'k7Rq2x' }));
  });

  it('J.4: doppio invio del cambio PIN nello stesso tick (checkPin lento): changePin una volta sola', async () => {
    let release!: (v: { ok: true }) => void;
    vi.mocked(checkPin).mockReturnValue(new Promise((r) => { release = r; }));
    vi.mocked(changePin).mockResolvedValue();
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.currentPin', 'old111');
    type('vault.settings.newPin', 'k7Rq2x');
    type('vault.confirmPin', 'k7Rq2x');
    const form = screen.getByLabelText('vault.settings.newPin').closest('form')!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await act(async () => { release({ ok: true }); });
    await waitFor(() => expect(changePin).toHaveBeenCalledTimes(1));
    expect(checkPin).toHaveBeenCalledTimes(1);
  });

  it('C.3/C.4: PIN di 16 caratteri incollato nel nuovo PIN: tenuti i primi 6 e avviso vault.pinTruncated', () => {
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.newPin', 'Xk9mP2abcdefghij');
    expect((screen.getByLabelText('vault.settings.newPin') as HTMLInputElement).value).toBe('Xk9mP2');
    expect(screen.getByText('vault.pinTruncated')).toBeTruthy();
    type('vault.settings.newPin', 'Xk9mP');
    expect(screen.queryByText('vault.pinTruncated')).toBeNull();
  });

  it('cambio PIN: PIN debole rifiutato dalla policy', async () => {
    vi.mocked(checkPin).mockResolvedValue({ ok: false, reason: 'sequence' });
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.currentPin', 'old111');
    type('vault.settings.newPin', '123456');
    type('vault.confirmPin', '123456');
    fireEvent.click(screen.getByText('vault.settings.changePinButton'));
    await waitFor(() => expect(screen.getByText('vault.pinPolicy.sequence')).toBeTruthy());
    expect(changePin).not.toHaveBeenCalled();
  });

  it('cambio PIN: errore del server mostrato con la sua chiave', async () => {
    vi.mocked(changePin).mockRejectedValue({ key: 'errors.vault.invalidPin' });
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.currentPin', 'old111');
    type('vault.settings.newPin', 'k7Rq2x');
    type('vault.confirmPin', 'k7Rq2x');
    fireEvent.click(screen.getByText('vault.settings.changePinButton'));
    await waitFor(() => expect(screen.getByText('errors.vault.invalidPin')).toBeTruthy());
  });

  it('Kit: nessuna cerimonia prima del PUT; dopo il PUT compare RecoveryKitSheet', async () => {
    let resolve!: (v: { kit: Uint8Array }) => void;
    vi.mocked(regenerateKit).mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.kitPin', 'old111');
    fireEvent.click(screen.getByText('vault.settings.kitButton'));
    await waitFor(() => expect(regenerateKit).toHaveBeenCalledWith({ userId: 'u1', pin: 'old111', rootKey: ROOT }));
    expect(screen.queryByText('vault.kit.title')).toBeNull();
    resolve({ kit: new Uint8Array(20).fill(7) });
    await waitFor(() => expect(screen.getByText('vault.kit.title')).toBeTruthy());
  });

  it('Kit: kitNotUpdated mostrato, nessun Kit', async () => {
    vi.mocked(regenerateKit).mockRejectedValue({ key: 'errors.vault.kitNotUpdated' });
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.kitPin', 'old111');
    fireEvent.click(screen.getByText('vault.settings.kitButton'));
    await waitFor(() => expect(screen.getByText('errors.vault.kitNotUpdated')).toBeTruthy());
    expect(screen.queryByText('vault.kit.title')).toBeNull();
  });

  it('senza root key il bottone Kit e disabilitato e regenerateKit non parte', () => {
    vi.mocked(getActiveRootKey).mockReturnValue(null);
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.kitPin', 'old111');
    expect((screen.getByText('vault.settings.kitButton').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(regenerateKit).not.toHaveBeenCalled();
  });

  it('offline: i due pulsanti sono disabilitati', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.currentPin', 'old111');
    expect((screen.getByText('vault.settings.kitButton').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('vault.settings.changePinButton').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Kit: touchVault al submit; onDone chiude la cerimonia con il toast', async () => {
    vi.mocked(regenerateKit).mockResolvedValue({ kit: new Uint8Array(20).fill(7) });
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.kitPin', 'old111');
    fireEvent.click(screen.getByText('vault.settings.kitButton'));
    await waitFor(() => expect(screen.getByText('vault.kit.title')).toBeTruthy());
    expect(h.touch).toHaveBeenCalled();
    fireEvent.click(screen.getByText('vault.kit.title')); // il mock chiama onDone
    await waitFor(() => expect(screen.queryByText('vault.kit.title')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('vault.settings.kitDone');
    expect(screen.getByText('vault.settings.kitButton')).toBeTruthy();
  });

  it('Kit: la chiusura del padre durante la cerimonia non la smonta', async () => {
    vi.mocked(regenerateKit).mockResolvedValue({ kit: new Uint8Array(20).fill(7) });
    const { rerender } = render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.kitPin', 'old111');
    fireEvent.click(screen.getByText('vault.settings.kitButton'));
    await waitFor(() => expect(screen.getByText('vault.kit.title')).toBeTruthy());
    rerender(<VaultSettingsSheet isOpen={false} onClose={() => {}} />);
    expect(screen.getByText('vault.kit.title')).toBeTruthy();
  });

  it('Esc ignorato mentre il Kit e in corso (busy)', async () => {
    vi.mocked(regenerateKit).mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<VaultSettingsSheet isOpen onClose={onClose} />);
    type('vault.settings.kitPin', 'old111');
    fireEvent.click(screen.getByText('vault.settings.kitButton'));
    await waitFor(() => expect(regenerateKit).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('alla chiusura i campi PIN si svuotano', () => {
    const { rerender } = render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    type('vault.settings.currentPin', 'old111');
    type('vault.settings.kitPin', 'old111');
    rerender(<VaultSettingsSheet isOpen={false} onClose={() => {}} />);
    rerender(<VaultSettingsSheet isOpen onClose={() => {}} />);
    expect((screen.getByLabelText('vault.settings.currentPin') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('vault.settings.kitPin') as HTMLInputElement).value).toBe('');
  });

  describe('controllo degli elementi da aggiornare (reconcile)', () => {
    const run = () => fireEvent.click(screen.getByText('vault.settings.checkButton'));

    it('da bloccato il controllo non c\'e', () => {
      h.unlockedUserId = null;
      render(<VaultSettingsSheet isOpen onClose={() => {}} />);
      expect(screen.queryByText('vault.settings.checkButton')).toBeNull();
    });

    it('banner legacyLeft con azione che chiude il foglio, e motivi unresolved', async () => {
      vi.mocked(vaultReconcile).mockResolvedValue(result({ legacyLeft: 3, unresolved: 2 }));
      const onClose = vi.fn();
      const onLegacyLeft = vi.fn();
      render(<VaultSettingsSheet isOpen onClose={onClose} onLegacyLeft={onLegacyLeft} />);
      run();
      await waitFor(() => expect(screen.getByText('vault.settings.legacyLeft')).toBeTruthy());
      expect(screen.getByText('vault.settings.unresolved')).toBeTruthy();
      for (const k of ['legacyPin', 'epoch', 'tooLarge', 'unchanged']) expect(screen.getByText(`vault.settings.reason.${k}`)).toBeTruthy();
      fireEvent.click(screen.getByText('vault.settings.legacyLeftAction'));
      expect(onLegacyLeft).toHaveBeenCalledWith(3); // la pagina aggiorna il proprio banner prima della chiusura
      expect(onClose).toHaveBeenCalled();
    });

    it('chiusura durante il controllo: lesito in volo non riappare alla riapertura', async () => {
      let resolve!: (v: ReturnType<typeof result>) => void;
      vi.mocked(vaultReconcile).mockReturnValue(new Promise((r) => { resolve = r; }));
      const { rerender } = render(<VaultSettingsSheet isOpen onClose={() => {}} />);
      run();
      rerender(<VaultSettingsSheet isOpen={false} onClose={() => {}} />);
      rerender(<VaultSettingsSheet isOpen onClose={() => {}} />);
      await act(async () => { resolve(result({ legacyLeft: 3 })); });
      expect(screen.queryByText('vault.settings.legacyLeft')).toBeNull();
    });

    it('solo rinviate (later == unresolved): nessun motivo permanente, riga "riprova piu tardi"', async () => {
      vi.mocked(vaultReconcile).mockResolvedValue(result({ unresolved: 2, later: 2 }));
      render(<VaultSettingsSheet isOpen onClose={() => {}} />);
      run();
      await waitFor(() => expect(screen.getByText('vault.settings.later')).toBeTruthy());
      expect(screen.queryByText('vault.settings.unresolved')).toBeNull();
      expect(screen.queryByText('vault.settings.reason.legacyPin')).toBeNull();
      expect(screen.queryByText('vault.settings.allUpToDate')).toBeNull();
    });

    it('rinviate e irrisolte insieme: i motivi contano solo unresolved - later', async () => {
      vi.mocked(vaultReconcile).mockResolvedValue(result({ unresolved: 5, later: 2 }));
      render(<VaultSettingsSheet isOpen onClose={() => {}} />);
      run();
      await waitFor(() => expect(screen.getByText('vault.settings.later')).toBeTruthy());
      expect(screen.getByText('vault.settings.unresolved')).toBeTruthy();
      expect(screen.getByText('vault.settings.reason.epoch')).toBeTruthy();
    });

    it('tutto a posto, skipped ed errore', async () => {
      vi.mocked(vaultReconcile).mockResolvedValueOnce(result({}));
      render(<VaultSettingsSheet isOpen onClose={() => {}} />);
      run();
      await waitFor(() => expect(screen.getByText('vault.settings.allUpToDate')).toBeTruthy());
      vi.mocked(vaultReconcile).mockResolvedValueOnce(result({ skipped: 'notReady' }));
      run();
      await waitFor(() => expect(screen.getByText('vault.settings.skipped.notReady')).toBeTruthy());
      expect(screen.queryByText('vault.settings.allUpToDate')).toBeNull();
      vi.mocked(vaultReconcile).mockRejectedValueOnce(new Error('x'));
      run();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.common.unknownError'));
    });
  });

  it('Esc chiude; il dialog ha role e aria-modal', () => {
    const onClose = vi.fn();
    render(<VaultSettingsSheet isOpen onClose={onClose} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
