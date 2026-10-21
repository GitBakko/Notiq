// T12: logout v3 (usa lib/apiCache.purgeApiCache, che chiama caches.delete)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAuthStore } from '../authStore';
import { useVaultStore, type VaultKeys } from '../vaultStore';
import queryClient from '../../lib/queryClient';

vi.mock('../../features/user/userService', () => ({
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  changePassword: vi.fn(),
}));

const keys = { vkHkdf: {}, vkAes: {}, sigKey: {} } as unknown as VaultKeys;
const userCache = {
  status: 'READY' as const,
  epoch: 1,
  rev: 1,
  kdf: 'argon2id',
  kdfParams: { m: 65536, t: 3, p: 1 },
  pinSalt: 's',
  wrappedVkPin: 'w',
  rootKeyId: 'rk',
  offlineUnlock: true,
};

describe('authStore.logout (vault v3)', () => {
  let del: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: del });
    useAuthStore.setState({ user: { id: 'u1', email: 'a@b.c' }, token: 't' });
    useVaultStore.setState({ isSetup: true, pinHash: 'h', byUser: { u1: userCache } });
    useVaultStore.getState().unlock('u1', keys, 1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useVaultStore.getState().lockVault();
  });

  it('blocca il vault, pulisce il legacy, svuota api-cache', () => {
    useAuthStore.getState().logout();
    const v = useVaultStore.getState();
    expect(useAuthStore.getState().token).toBeNull();
    expect(v.isUnlocked).toBe(false);
    expect(v.keys).toBeNull();
    expect(v.isSetup).toBe(false);
    expect(v.pinHash).toBeNull();
    expect(del).toHaveBeenCalledWith('api-cache');
  });

  it('byUser resta intatto', () => {
    useAuthStore.getState().logout();
    expect(useVaultStore.getState().byUser).toEqual({ u1: userCache });
  });

  it('i flusher pre-lock ricevono il contesto dell utente uscito al logout', async () => {
    const fn = vi.fn();
    const off = useVaultStore.getState().registerPreLock(fn);
    useAuthStore.getState().logout();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledWith({ keys, userId: 'u1', epoch: 1 });
    off();
  });

  it('logout: lockVault prima di azzerare il token, poi queryClient.clear', () => {
    const order: string[] = [];
    const lockSpy = vi.spyOn(useVaultStore.getState(), 'lockVault').mockImplementation(() => {
      order.push(`lock(token=${useAuthStore.getState().token})`);
      return Promise.resolve();
    });
    const clearSpy = vi.spyOn(queryClient, 'clear').mockImplementation(() => {
      order.push('clear');
    });
    useAuthStore.getState().logout();
    expect(order).toEqual(['lock(token=t)', 'clear']);
    expect(useAuthStore.getState().token).toBeNull();
    lockSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('non lancia se Cache Storage non esiste o rifiuta', () => {
    vi.stubGlobal('caches', undefined);
    expect(() => useAuthStore.getState().logout()).not.toThrow();
    vi.stubGlobal('caches', { delete: vi.fn().mockRejectedValue(new Error('x')) });
    expect(() => useAuthStore.getState().logout()).not.toThrow();
  });
});
