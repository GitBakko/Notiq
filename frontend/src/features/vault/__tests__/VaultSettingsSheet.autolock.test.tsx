import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1', email: 'a@b.it', name: 'A', surname: 'B' } }),
}));
vi.mock('../../../lib/vaultSession', () => ({ changePin: vi.fn(), regenerateKit: vi.fn(), confirmKit: vi.fn(async () => {}) }));
vi.mock('../../../lib/vaultReconcile', () => ({ vaultReconcile: vi.fn() }));
vi.mock('../../../utils/vaultRootKeys', () => ({ getActiveRootKey: vi.fn(() => ({ id: 'rk_x', ecdhSpki: new Uint8Array([1]) })) }));
vi.mock('../PinPolicy', () => ({ checkPin: vi.fn(async () => ({ ok: true })) }));
vi.mock('../RecoveryKitSheet', () => ({ default: () => <div>vault.kit.title</div> }));

// Store reale: l'auto-lock e' quello vero (10 min).
import { useVaultStore, type VaultKeys } from '../../../store/vaultStore';
import VaultSettingsSheet from '../VaultSettingsSheet';
import { regenerateKit } from '../../../lib/vaultSession';

const fakeKeys = () => ({ vkHkdf: {}, vkAes: {}, sigKey: {} }) as unknown as VaultKeys;
const MIN = 60 * 1000;

describe('VaultSettingsSheet: cerimonia del Kit e auto-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    useVaultStore.getState().unlock('u1', fakeKeys(), 1);
  });
  afterEach(() => {
    void useVaultStore.getState().lockVault();
    vi.useRealTimers();
  });

  const startCeremony = async () => {
    vi.mocked(regenerateKit).mockResolvedValue({ kit: new Uint8Array(20).fill(7) });
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('vault.settings.kitPin'), { target: { value: 'old111' } });
    await act(async () => { fireEvent.click(screen.getByText('vault.settings.kitButton')); });
    expect(screen.getByText('vault.kit.title')).toBeTruthy();
  };

  // Il keep-alive dell'auto-lock durante la cerimonia e' di RecoveryKitSheet (qui mockato): il foglio non ha piu' un timer suo.
  // Resta la garanzia strutturale: se il vault si blocca comunque, la cerimonia non viene smontata (smontare azzera il buffer del Kit).
  it('con il Kit impostato e il vault bloccato dall auto-lock, RecoveryKitSheet resta montato', async () => {
    await startCeremony();
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * MIN); });
    expect(useVaultStore.getState().isUnlocked).toBe(false);
    expect(screen.getByText('vault.kit.title')).toBeTruthy();
  });

  it('senza Kit impostato lo stesso silenzio blocca il vault (controprova)', async () => {
    render(<VaultSettingsSheet isOpen onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * MIN); });
    expect(useVaultStore.getState().isUnlocked).toBe(false);
  });
});
