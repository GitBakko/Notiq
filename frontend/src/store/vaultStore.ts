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

interface VaultState {
  isSetup: boolean;
  pinHash: string | null;
  isUnlocked: boolean;
  pin: string | null; // Store PIN in memory when unlocked
  setupVault: (pinHash: string, pin: string) => void;
  unlockVault: (pin: string) => void;
  lockVault: () => void;
  resetVault: () => void;
  /** Reset the auto-lock timer (call on vault-related user activity) */
  touchVault: () => void;
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      isSetup: false,
      pinHash: null,
      isUnlocked: false,
      pin: null,

      setupVault: (pinHash, pin) => {
        set({ isSetup: true, pinHash, isUnlocked: true, pin });
        startAutoLockTimer(() => get().lockVault());
      },
      unlockVault: (pin) => {
        set({ isUnlocked: true, pin });
        startAutoLockTimer(() => get().lockVault());
      },
      lockVault: () => {
        clearAutoLockTimer();
        set({ isUnlocked: false, pin: null });
      },
      resetVault: () => {
        clearAutoLockTimer();
        set({ isSetup: false, pinHash: null, isUnlocked: false, pin: null });
      },
      touchVault: () => {
        if (get().isUnlocked) {
          startAutoLockTimer(() => get().lockVault());
        }
      },
    }),
    {
      name: 'vault-storage',
      partialize: (state) => ({ isSetup: state.isSetup, pinHash: state.pinHash }), // Only persist setup status and hash
    }
  )
);
