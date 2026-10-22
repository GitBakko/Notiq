// Da applicare come frontend/src/store/__tests__/vaultStoreV3.test.ts (T11)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useVaultStore, type VaultKeys, type VaultUserCache } from '../vaultStore';

const fakeKeys = (tag = 'k'): VaultKeys =>
  ({ vkHkdf: { tag: `${tag}-hkdf` }, vkAes: { tag: `${tag}-aes` }, sigKey: { tag: `${tag}-sig` } }) as unknown as VaultKeys;

const cache = (over: Partial<VaultUserCache> = {}): VaultUserCache => ({
  status: 'READY',
  epoch: 1,
  rev: 1,
  kdf: 'argon2id',
  kdfParams: { m: 65536, t: 3, p: 1 },
  pinSalt: 'salt',
  wrappedVkPin: 'wrapped',
  rootKeyId: 'rk_1',
  offlineUnlock: true,
  ...over,
});

describe('vaultStore v3', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useVaultStore.getState().lockVault();
    useVaultStore.setState({
      isSetup: false,
      pinHash: null,
      isUnlocked: false,
      byUser: {},
      unlockedUserId: null,
      keys: null,
      epoch: null,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('persistenza', () => {
    it('chiave di storage invariata', () => {
      expect(useVaultStore.persist.getOptions().name).toBe('vault-storage');
    });

    it('partialize: solo isSetup, pinHash, byUser (mai keys, isUnlocked, epoch, unlockedUserId)', () => {
      useVaultStore.getState().setKeyringCache('u1', cache());
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      const persisted = useVaultStore.persist.getOptions().partialize!(useVaultStore.getState()) as Record<string, unknown>;
      expect(Object.keys(persisted).sort()).toEqual(['byUser', 'isSetup', 'pinHash']);
    });

    it('lo storage vecchio (solo isSetup/pinHash) si carica con byUser={}', async () => {
      localStorage.setItem('vault-storage', JSON.stringify({ state: { isSetup: true, pinHash: 'h' }, version: 0 }));
      await useVaultStore.persist.rehydrate();
      const s = useVaultStore.getState();
      expect(s.isSetup).toBe(true);
      expect(s.pinHash).toBe('h');
      expect(s.byUser).toEqual({});
      expect(s.keys).toBeNull();
      localStorage.removeItem('vault-storage');
    });
  });

  describe('unlock / lock', () => {
    it('unlock imposta utente, chiavi ed epoch', () => {
      const keys = fakeKeys();
      useVaultStore.getState().unlock('u1', keys, 4);
      const s = useVaultStore.getState();
      expect(s.isUnlocked).toBe(true);
      expect(s.unlockedUserId).toBe('u1');
      expect(s.keys).toBe(keys);
      expect(s.epoch).toBe(4);
    });

    it('lockVault azzera tutto', () => {
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      useVaultStore.getState().lockVault();
      const s = useVaultStore.getState();
      expect(s.isUnlocked).toBe(false);
      expect(s.keys).toBeNull();
      expect(s.unlockedUserId).toBeNull();
      expect(s.epoch).toBeNull();
    });

    it('il flusher riceve chiavi non nulle quando lo store ha gia keys===null', async () => {
      const keys = fakeKeys();
      let seenKeys: VaultKeys | null = null;
      let storeKeysAtCall: VaultKeys | null | undefined;
      const off = useVaultStore.getState().registerPreLock(async (ctx) => {
        seenKeys = ctx.keys;
        storeKeysAtCall = useVaultStore.getState().keys;
      });
      useVaultStore.getState().unlock('u1', keys, 1);
      await useVaultStore.getState().lockVault();
      expect(seenKeys).toBe(keys);
      expect(storeKeysAtCall).toBeNull();
      off();
    });

    it('un flusher che lancia o rifiuta non impedisce lock ne gli altri flusher', async () => {
      const second = vi.fn();
      const offs = [
        useVaultStore.getState().registerPreLock(() => { throw new Error('boom'); }),
        useVaultStore.getState().registerPreLock(() => Promise.reject(new Error('nope'))),
        useVaultStore.getState().registerPreLock(second),
      ];
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      let p!: Promise<void>;
      expect(() => { p = useVaultStore.getState().lockVault(); }).not.toThrow();
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      await p;
      expect(second).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
      offs.forEach((o) => o());
    });

    it('lockVault si risolve dopo i flusher, con stato gia azzerato; il rifiuto e loggato', async () => {
      const order: string[] = [];
      let stateAtFlush: boolean | undefined;
      const reason = new Error('nope');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const offs = [
        useVaultStore.getState().registerPreLock(async () => {
          stateAtFlush = useVaultStore.getState().isUnlocked;
          await Promise.resolve();
          order.push('flush');
        }),
        useVaultStore.getState().registerPreLock(() => Promise.reject(reason)),
      ];
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      const p = useVaultStore.getState().lockVault();
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      await p;
      order.push('resolved');
      expect(order).toEqual(['flush', 'resolved']);
      expect(stateAtFlush).toBe(false);
      expect(errSpy).toHaveBeenCalledWith('[vault] pre-lock flush failed', reason);
      errSpy.mockRestore();
      offs.forEach((o) => o());
    });

    it('unlock con keys gia presenti: il flusher riceve le chiavi del vecchio utente', async () => {
      const k1 = fakeKeys('u1');
      const k2 = fakeKeys('u2');
      const fn = vi.fn();
      const off = useVaultStore.getState().registerPreLock(fn);
      useVaultStore.getState().unlock('u1', k1, 5);
      useVaultStore.getState().unlock('u2', k2, 7);
      await Promise.resolve();
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith({ keys: k1, userId: 'u1', epoch: 5 });
      expect(useVaultStore.getState().keys).toBe(k2);
      expect(useVaultStore.getState().unlockedUserId).toBe('u2');
      off();
    });

    it('unregister: il flusher non viene piu chiamato', async () => {
      const fn = vi.fn();
      const off = useVaultStore.getState().registerPreLock(fn);
      off();
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      await useVaultStore.getState().lockVault();
      expect(fn).not.toHaveBeenCalled();
    });

    it('lock da bloccato non richiama i flusher', async () => {
      const fn = vi.fn();
      const off = useVaultStore.getState().registerPreLock(fn);
      await useVaultStore.getState().lockVault();
      expect(fn).not.toHaveBeenCalled();
      off();
    });
  });

  describe('storage fra schede', () => {
    it('auth-storage con token null blocca il vault', async () => {
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-storage', newValue: JSON.stringify({ state: { token: null } }) }));
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      expect(useVaultStore.getState().keys).toBeNull();
    });

    it('auth-storage rimosso (newValue null) blocca il vault', () => {
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-storage', newValue: null }));
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });

    it('auth-storage con token valido non blocca', () => {
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-storage', newValue: JSON.stringify({ state: { token: 't' } }) }));
      expect(useVaultStore.getState().isUnlocked).toBe(true);
    });

    it('vault-storage: rehydrate parte da byUser undefined e non tocca le keys', async () => {
      const keys = fakeKeys();
      useVaultStore.getState().unlock('u1', keys, 1);
      // stato di partenza: byUser indefinito (non quello del beforeEach)
      useVaultStore.setState({ byUser: undefined as unknown as Record<string, VaultUserCache> });
      localStorage.setItem(
        'vault-storage',
        JSON.stringify({ state: { isSetup: false, pinHash: null, byUser: { u1: cache(), u9: cache() } }, version: 0 })
      );
      window.dispatchEvent(new StorageEvent('storage', { key: 'vault-storage' }));
      await vi.waitFor(() => expect(useVaultStore.getState().byUser?.u9).toBeDefined());
      expect(useVaultStore.getState().keys).toBe(keys);
      expect(useVaultStore.getState().isUnlocked).toBe(true);
      localStorage.removeItem('vault-storage');
    });
    const rehydrateWith = async (byUser: Record<string, VaultUserCache>, keys = fakeKeys()) => {
      useVaultStore.getState().unlock('u1', keys, 1);
      localStorage.setItem('vault-storage', JSON.stringify({ state: { isSetup: false, pinHash: null, byUser }, version: 0 }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'vault-storage' }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      localStorage.removeItem('vault-storage');
    };

    it('rehydrate con byUser[u1] rimosso blocca', async () => {
      await rehydrateWith({ u9: cache() });
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });

    it('rehydrate con status RESET_PENDING blocca', async () => {
      await rehydrateWith({ u1: cache({ status: 'RESET_PENDING' }) });
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });

    it('rehydrate con epoch diversa blocca', async () => {
      await rehydrateWith({ u1: cache({ epoch: 2 }) });
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });

    it('rehydrate con dati coerenti resta sbloccato', async () => {
      await rehydrateWith({ u1: cache() });
      expect(useVaultStore.getState().isUnlocked).toBe(true);
    });

    it('evento storage con key null blocca', () => {
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });

    it('setKeyringCache non persiste campi extra in kdfParams', () => {
      const c = cache({ kdfParams: { m: 1, t: 2, p: 3, extra: 'x' } as unknown as VaultUserCache['kdfParams'] });
      useVaultStore.getState().setKeyringCache('u1', c);
      expect(useVaultStore.getState().byUser.u1.kdfParams).toEqual({ m: 1, t: 2, p: 3 });
    });
  });

  describe('auto-lock 10 minuti', () => {
    it('blocca dopo 10 min e invoca il flusher', async () => {
      const fn = vi.fn();
      const off = useVaultStore.getState().registerPreLock(fn);
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      vi.advanceTimersByTime(10 * 60 * 1000 - 1);
      expect(useVaultStore.getState().isUnlocked).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      expect(useVaultStore.getState().keys).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
      off();
    });

    it('touchVault rinvia il lock', () => {
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      vi.advanceTimersByTime(9 * 60 * 1000);
      useVaultStore.getState().touchVault();
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(useVaultStore.getState().isUnlocked).toBe(true);
      vi.advanceTimersByTime(60 * 1000);
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });
  });

  describe('isolamento tra utenti', () => {
    it('getKeysFor: chiavi di u1 disponibili a u1, non a u2 (e blocca)', () => {
      const keys = fakeKeys();
      useVaultStore.getState().unlock('u1', keys, 1);
      expect(useVaultStore.getState().getKeysFor('u1')).toBe(keys);
      expect(useVaultStore.getState().getKeysFor('u2')).toBeNull();
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      expect(useVaultStore.getState().keys).toBeNull();
    });

    it('getKeysFor da bloccato restituisce null', () => {
      expect(useVaultStore.getState().getKeysFor('u1')).toBeNull();
    });
  });

  describe('cache del keyring', () => {
    it('setKeyringCache con offlineUnlock false scarta wrappedVkPin e campi estranei', () => {
      const dirty = { ...cache({ offlineUnlock: false }), extra: 'x', secret: 's' } as unknown as VaultUserCache;
      useVaultStore.getState().setKeyringCache('u1', dirty);
      const u = useVaultStore.getState().byUser.u1 as unknown as Record<string, unknown>;
      expect(u.wrappedVkPin).toBeUndefined();
      expect('wrappedVkPin' in u).toBe(false);
      expect(u.extra).toBeUndefined();
      expect(u.secret).toBeUndefined();
      expect(u.pinSalt).toBe('salt');
    });

    it('setKeyringCache con offlineUnlock true mantiene wrappedVkPin', () => {
      useVaultStore.getState().setKeyringCache('u1', cache());
      expect(useVaultStore.getState().byUser.u1.wrappedVkPin).toBe('wrapped');
    });

    it('setKeyringCache per utenti diversi non si sovrascrive', () => {
      useVaultStore.getState().setKeyringCache('u1', cache({ epoch: 1 }));
      useVaultStore.getState().setKeyringCache('u2', cache({ epoch: 2 }));
      expect(useVaultStore.getState().byUser.u1.epoch).toBe(1);
      expect(useVaultStore.getState().byUser.u2.epoch).toBe(2);
    });

    it('setOfflineUnlock(false) toglie wrappedVkPin e mantiene status/epoch', () => {
      useVaultStore.getState().setKeyringCache('u1', cache());
      useVaultStore.getState().setOfflineUnlock('u1', false);
      const u = useVaultStore.getState().byUser.u1;
      expect(u.wrappedVkPin).toBeUndefined();
      expect(u.offlineUnlock).toBe(false);
      expect(u.status).toBe('READY');
      expect(u.epoch).toBe(1);
    });

    it('setOfflineUnlock su utente sconosciuto non crea nulla', () => {
      useVaultStore.getState().setOfflineUnlock('ghost', true);
      expect(useVaultStore.getState().byUser).toEqual({});
    });

    it('forgetUser rimuove la cache e, se sbloccato, blocca', () => {
      useVaultStore.getState().setKeyringCache('u1', cache());
      useVaultStore.getState().setKeyringCache('u2', cache());
      useVaultStore.getState().unlock('u1', fakeKeys(), 1);
      useVaultStore.getState().forgetUser('u1');
      expect(useVaultStore.getState().byUser.u1).toBeUndefined();
      expect(useVaultStore.getState().byUser.u2).toBeDefined();
      expect(useVaultStore.getState().isUnlocked).toBe(false);
    });

    it('clearLegacy azzera i campi legacy e lascia byUser', () => {
      useVaultStore.setState({ isSetup: true, pinHash: 'h' });
      useVaultStore.getState().setKeyringCache('u1', cache());
      useVaultStore.getState().clearLegacy();
      const s = useVaultStore.getState();
      expect(s.isSetup).toBe(false);
      expect(s.pinHash).toBeNull();
      expect(s.byUser.u1).toBeDefined();
    });

    it('i campi legacy rimossi (pin, setupVault, unlockVault, resetVault) non esistono piu', () => {
      const s = useVaultStore.getState() as unknown as Record<string, unknown>;
      for (const k of ['pin', 'setupVault', 'unlockVault', 'resetVault']) expect(k in s).toBe(false);
    });

    it('storage con un campo ignoto (es. pin di una versione intermedia) si carica senza errori e byUser resta', async () => {
      localStorage.setItem('vault-storage', JSON.stringify({ state: { isSetup: true, pinHash: 'h', byUser: { u1: cache() } }, version: 0 }));
      try {
        await useVaultStore.persist.rehydrate();
        expect(useVaultStore.getState().byUser.u1).toBeDefined();
        const persisted = useVaultStore.persist.getOptions().partialize!(useVaultStore.getState()) as Record<string, unknown>;
        expect('pin' in persisted).toBe(false);
      } finally {
        localStorage.removeItem('vault-storage');
        useVaultStore.setState({ isSetup: false, pinHash: null, byUser: {} });
      }
    });
  });
});
