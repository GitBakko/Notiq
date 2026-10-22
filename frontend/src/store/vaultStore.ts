import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const VAULT_AUTO_LOCK_MS = 10 * 60 * 1000; // 10 minutes of inactivity

let autoLockTimer: ReturnType<typeof setTimeout> | null = null;

function startAutoLockTimer(lockFn: () => void) {
  clearAutoLockTimer();
  autoLockTimer = setTimeout(lockFn, VAULT_AUTO_LOCK_MS);
}

function clearAutoLockTimer() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
}

/** Chiavi v3 in memoria (non-extractable). Mai persistite. */
export interface VaultKeys {
  vkHkdf: CryptoKey;
  vkAes: CryptoKey;
  sigKey: CryptoKey;
}

/** Cache locale del keyring di un utente (nessun segreto in chiaro: wrappedVkPin e' cifrato). */
export interface VaultUserCache {
  status: 'NONE' | 'READY' | 'RESET_PENDING';
  epoch: number;
  rev: number;
  kdf: string;
  kdfParams: { m: number; t: number; p: number };
  pinSalt: string;
  wrappedVkPin?: string;
  rootKeyId: string;
  offlineUnlock: boolean;
}

/** Contesto catturato da lockVault PRIMA dell'azzeramento. */
export interface VaultPreLockContext {
  keys: VaultKeys;
  userId: string;
  epoch: number;
}

/**
 * Chiamato da lockVault con il contesto catturato PRIMA dell'azzeramento (ultimo salvataggio dell'editor).
 * Il flusher NON deve leggere userId/epoch dagli store: a questo punto sono gia' azzerati o cambiati.
 */
export type VaultPreLockFlusher = (ctx: VaultPreLockContext) => Promise<void> | void;

// Fuori dallo state: non persistiti, non serializzati.
const preLockFlushers = new Set<VaultPreLockFlusher>();

interface VaultState {
  /** Legacy (pre-v3), solo residuo persistito: lo azzera `clearLegacy`. Nessuna azione lo scrive piu'. */
  isSetup: boolean;
  /** Legacy (pre-v3), solo residuo persistito (SHA-256 non salato): lo azzera `clearLegacy`. */
  pinHash: string | null;
  isUnlocked: boolean;

  /** Persistito. Cache del keyring per userId. */
  byUser: Record<string, VaultUserCache>;
  /** In memoria. */
  unlockedUserId: string | null;
  keys: VaultKeys | null;
  epoch: number | null;

  /** Stato azzerato subito (sincrono); la Promise si risolve dopo i flusher pre-lock. */
  lockVault: () => Promise<void>;
  /** Reset the auto-lock timer (call on vault-related user activity) */
  touchVault: () => void;

  setKeyringCache: (userId: string, cache: VaultUserCache) => void;
  unlock: (userId: string, keys: VaultKeys, epoch: number) => void;
  /** Cancella solo i campi legacy; byUser resta. */
  clearLegacy: () => void;
  setOfflineUnlock: (userId: string, enabled: boolean) => void;
  forgetUser: (userId: string) => void;
  /** Le chiavi valgono solo per l'utente sbloccato: per un altro utente blocca e restituisce null. */
  getKeysFor: (userId: string) => VaultKeys | null;
  registerPreLock: (fn: VaultPreLockFlusher) => () => void;
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      isSetup: false,
      pinHash: null,
      isUnlocked: false,
      byUser: {},
      unlockedUserId: null,
      keys: null,
      epoch: null,

      lockVault: () => {
        clearAutoLockTimer();
        // Cattura PRIMA di azzerare: i flusher cifrano ancora l'ultimo salvataggio.
        const { keys, unlockedUserId, epoch } = get();
        set({ isUnlocked: false, keys: null, unlockedUserId: null, epoch: null });
        if (!keys || !unlockedUserId || epoch == null) return Promise.resolve();
        const ctx: VaultPreLockContext = { keys, userId: unlockedUserId, epoch };
        // Promise.resolve().then: un flusher che lancia sincrono non blocca il lock ne' gli altri.
        return Promise.allSettled(
          [...preLockFlushers].map((fn) => Promise.resolve().then(() => fn(ctx)))
        ).then((results) => {
          for (const r of results) {
            if (r.status === 'rejected') console.error('[vault] pre-lock flush failed', r.reason);
          }
        });
      },
      touchVault: () => {
        if (get().isUnlocked) {
          startAutoLockTimer(() => get().lockVault());
        }
      },

      setKeyringCache: (userId, cache) =>
        set((s) => {
          const clean: VaultUserCache = {
            status: cache.status,
            epoch: cache.epoch,
            rev: cache.rev,
            kdf: cache.kdf,
            kdfParams: { m: cache.kdfParams.m, t: cache.kdfParams.t, p: cache.kdfParams.p },
            pinSalt: cache.pinSalt,
            rootKeyId: cache.rootKeyId,
            offlineUnlock: cache.offlineUnlock,
          };
          if (cache.offlineUnlock && cache.wrappedVkPin !== undefined) clean.wrappedVkPin = cache.wrappedVkPin;
          return { byUser: { ...s.byUser, [userId]: clean } };
        }),
      unlock: (userId, keys, epoch) => {
        // Cambio utente/chiavi: flush con le chiavi vecchie prima di sostituirle.
        if (get().keys) void get().lockVault();
        set({ isUnlocked: true, unlockedUserId: userId, keys, epoch });
        startAutoLockTimer(() => get().lockVault());
      },
      clearLegacy: () => set({ isSetup: false, pinHash: null }),
      setOfflineUnlock: (userId, enabled) =>
        set((s) => {
          const cur = s.byUser[userId];
          if (!cur) return {};
          const next: VaultUserCache = { ...cur, offlineUnlock: enabled };
          if (!enabled) delete next.wrappedVkPin;
          return { byUser: { ...s.byUser, [userId]: next } };
        }),
      forgetUser: (userId) => {
        if (get().unlockedUserId === userId) get().lockVault();
        set((s) => {
          const { [userId]: _removed, ...rest } = s.byUser;
          void _removed;
          return { byUser: rest };
        });
      },
      getKeysFor: (userId) => {
        const { keys, unlockedUserId } = get();
        if (!keys) return null;
        if (unlockedUserId !== userId) {
          get().lockVault();
          return null;
        }
        return keys;
      },
      registerPreLock: (fn) => {
        preLockFlushers.add(fn);
        return () => {
          preLockFlushers.delete(fn);
        };
      },
    }),
    {
      name: 'vault-storage',
      // Solo setup legacy, hash legacy e cache del keyring. Mai chiavi ne' isUnlocked.
      partialize: (state) => ({ isSetup: state.isSetup, pinHash: state.pinHash, byUser: state.byUser }),
    }
  )
);

// Fra schede: rehydrate della cache persistita (le chiavi in memoria restano) e lock se l'altra scheda fa logout.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null) {
      // localStorage.clear() in un'altra scheda: come un logout.
      void useVaultStore.getState().lockVault();
    } else if (e.key === 'vault-storage') {
      void Promise.resolve(useVaultStore.persist.rehydrate()).then(() => {
        const { unlockedUserId, epoch, byUser, lockVault } = useVaultStore.getState();
        if (!unlockedUserId) return;
        const c = byUser[unlockedUserId];
        if (!c || c.status !== 'READY' || c.epoch !== epoch) void lockVault();
      });
    } else if (e.key === 'auth-storage') {
      let token: unknown = null;
      try {
        token = e.newValue ? JSON.parse(e.newValue)?.state?.token : null;
      } catch {
        token = null;
      }
      if (!token) void useVaultStore.getState().lockVault();
    }
  });
}
