import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/vaultSession', () => ({ confirmKit: vi.fn(async () => {}) }));

import RecoveryKitSheet from '../RecoveryKitSheet';
import { confirmKit } from '../../../lib/vaultSession';
import toast from 'react-hot-toast';
import { formatKit } from '../../../utils/vaultKit';
import { useVaultStore } from '../../../store/vaultStore';

const mkKit = () => Uint8Array.from({ length: 20 }, (_, i) => (i * 13 + 7) & 255);
const groupsOf = (kit: Uint8Array) => formatKit(kit).split('  ')[0].split('-');

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0); // gruppi 1 e 2 (indici 0 e 1)
  URL.createObjectURL = vi.fn(() => 'blob:kit');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.mocked(confirmKit).mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RecoveryKitSheet', () => {
  it('dialog modale; mostra il Kit; Fine disabilitato finche i 2 gruppi non sono corretti', () => {
    const kit = mkKit();
    render(<RecoveryKitSheet kit={kit} userId="u1" onDone={() => {}} />);
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText('vault.kit.codeLabel').textContent).toBe(formatKit(kit));
    const done = screen.getByText('vault.kit.done').closest('button')!;
    expect(done.disabled).toBe(true);

    const [g0, g1] = groupsOf(kit);
    const [i0, i1] = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(i0, { target: { value: g0 } });
    expect(done.disabled).toBe(true);
    fireEvent.change(i1, { target: { value: 'ZZZZ-ZZZZ' } });
    expect(done.disabled).toBe(true);
    fireEvent.change(i1, { target: { value: g1.toLowerCase() } }); // normalizzato
    expect(done.disabled).toBe(false);
  });

  it('Esc e click sullo sfondo non chiudono (nessuna onDone)', () => {
    const onDone = vi.fn();
    const { container } = render(<RecoveryKitSheet kit={mkKit()} userId="u1" onDone={onDone} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(container.firstChild as Element);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('Fine: confirmKit(userId), fill(0) del Kit, revoke dell URL del PDF, poi onDone', async () => {
    const kit = mkKit();
    const onDone = vi.fn();
    render(<RecoveryKitSheet kit={kit} userId="u1" onDone={onDone} />);
    fireEvent.click(screen.getByText('vault.kit.downloadPdf'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const [g0, g1] = groupsOf(kit);
    const [i0, i1] = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(i0, { target: { value: g0 } });
    fireEvent.change(i1, { target: { value: g1 } });
    fireEvent.click(screen.getByText('vault.kit.done'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(confirmKit).toHaveBeenCalledWith('u1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:kit');
    expect(kit.every((b) => b === 0)).toBe(true);
  });

  it('unmount senza conferma: URL revocato, Kit azzerato, confirmKit NON chiamato (il marker resta)', () => {
    const kit = mkKit();
    const { unmount } = render(<RecoveryKitSheet kit={kit} userId="u1" onDone={() => {}} />);
    fireEvent.click(screen.getByText('vault.kit.downloadPdf'));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:kit');
    expect(kit.every((b) => b === 0)).toBe(true);
    expect(confirmKit).not.toHaveBeenCalled();
  });

  it('copia: scrive il Kit formattato negli appunti', async () => {
    const kit = mkKit();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RecoveryKitSheet kit={kit} userId="u1" onDone={() => {}} />);
    fireEvent.click(screen.getByText('vault.kit.copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(formatKit(kit)));
  });

  it('confirmKit fallisce: errore mostrato, sheet aperto per riprovare, Kit non azzerato, niente onDone', async () => {
    vi.mocked(confirmKit).mockRejectedValueOnce(new Error('idb'));
    const kit = mkKit();
    const onDone = vi.fn();
    render(<RecoveryKitSheet kit={kit} userId="u1" onDone={onDone} />);
    const [g0, g1] = groupsOf(kit);
    const [i0, i1] = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(i0, { target: { value: g0 } });
    fireEvent.change(i1, { target: { value: g1 } });
    fireEvent.click(screen.getByText('vault.kit.done'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.common.unknownError'));
    expect(onDone).not.toHaveBeenCalled();
    expect(kit.some((b) => b !== 0)).toBe(true);
    fireEvent.click(screen.getByText('vault.kit.done')); // retry
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('keep-alive: touchVault ogni 60 s; stop allo smontaggio', () => {
    vi.useFakeTimers();
    const touchVault = vi.spyOn(useVaultStore.getState(), 'touchVault'); // vault bloccato: state stabile, touch e no-op
    const { unmount } = render(<RecoveryKitSheet kit={mkKit()} userId="u1" onDone={() => {}} />);
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(touchVault).toHaveBeenCalledTimes(1);
    unmount();
    touchVault.mockClear();
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(touchVault).not.toHaveBeenCalled();
  });

  it('keep-alive con store reale: dopo 11 minuti il vault resta sbloccato, il foglio montato e il Kit non azzerato', () => {
    vi.useFakeTimers();
    const kit = mkKit();
    function Parent() { // come in VaultPage: il foglio si smonta quando il vault si blocca
      const unlocked = useVaultStore((s) => s.isUnlocked);
      return unlocked ? <RecoveryKitSheet kit={kit} userId="u1" onDone={() => {}} /> : null;
    }
    act(() => { useVaultStore.getState().unlockVault('pin'); });
    render(<Parent />);
    act(() => { vi.advanceTimersByTime(11 * 60_000); });
    expect(useVaultStore.getState().isUnlocked).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(kit.some((b) => b !== 0)).toBe(true);
    act(() => { void useVaultStore.getState().lockVault(); }); // pulizia timer
  });
});
