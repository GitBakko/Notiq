import { describe, it, expect, beforeEach } from 'vitest';
import { useVaultStore } from '../vaultStore';

const TEST_PIN = '1234';
const TEST_PIN_HASH = 'hashed-pin-value';

describe('vaultStore', () => {
  beforeEach(() => {
    // Reset the store to its initial state before each test
    useVaultStore.setState({
      isSetup: false,
      pinHash: null,
      isUnlocked: false,
      pin: null,
    });
  });

  describe('initial state', () => {
    it('starts with vault not set up and locked', () => {
      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(false);
      expect(state.pinHash).toBeNull();
      expect(state.isUnlocked).toBe(false);
      expect(state.pin).toBeNull();
    });
  });

  describe('setupVault', () => {
    it('marks the vault as set up and unlocked', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);

      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(true);
      expect(state.pinHash).toBe(TEST_PIN_HASH);
      expect(state.isUnlocked).toBe(true);
      expect(state.pin).toBe(TEST_PIN);
    });

    it('stores the pinHash for later verification', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);

      const state = useVaultStore.getState();
      expect(state.pinHash).toBe(TEST_PIN_HASH);
    });
  });

  describe('unlockVault', () => {
    it('sets isUnlocked to true and stores the PIN in memory', () => {
      // First set up the vault
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      // Then lock it
      useVaultStore.getState().lockVault();

      // Now unlock
      useVaultStore.getState().unlockVault(TEST_PIN);

      const state = useVaultStore.getState();
      expect(state.isUnlocked).toBe(true);
      expect(state.pin).toBe(TEST_PIN);
    });

    it('preserves isSetup and pinHash when unlocking', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().lockVault();
      useVaultStore.getState().unlockVault(TEST_PIN);

      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(true);
      expect(state.pinHash).toBe(TEST_PIN_HASH);
    });

    it('stores the provided PIN regardless of correctness (validation is caller responsibility)', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().lockVault();

      // The store itself does not validate the PIN against the hash.
      // That responsibility lies with the component calling unlockVault.
      useVaultStore.getState().unlockVault('wrong-pin');

      const state = useVaultStore.getState();
      expect(state.isUnlocked).toBe(true);
      expect(state.pin).toBe('wrong-pin');
    });
  });

  describe('lockVault', () => {
    it('sets isUnlocked to false and clears the in-memory PIN', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().lockVault();

      const state = useVaultStore.getState();
      expect(state.isUnlocked).toBe(false);
      expect(state.pin).toBeNull();
    });

    it('preserves isSetup and pinHash after locking', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().lockVault();

      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(true);
      expect(state.pinHash).toBe(TEST_PIN_HASH);
    });

    it('is idempotent when already locked', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().lockVault();
      useVaultStore.getState().lockVault();

      const state = useVaultStore.getState();
      expect(state.isUnlocked).toBe(false);
      expect(state.pin).toBeNull();
      expect(state.isSetup).toBe(true);
    });
  });

  describe('resetVault', () => {
    it('clears all vault state back to initial values', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().resetVault();

      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(false);
      expect(state.pinHash).toBeNull();
      expect(state.isUnlocked).toBe(false);
      expect(state.pin).toBeNull();
    });

    it('works even if vault was never set up', () => {
      useVaultStore.getState().resetVault();

      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(false);
      expect(state.pinHash).toBeNull();
      expect(state.isUnlocked).toBe(false);
      expect(state.pin).toBeNull();
    });

    it('works after vault is locked', () => {
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      useVaultStore.getState().lockVault();
      useVaultStore.getState().resetVault();

      const state = useVaultStore.getState();
      expect(state.isSetup).toBe(false);
      expect(state.pinHash).toBeNull();
    });
  });

  describe('persistence partialize', () => {
    it('only persists isSetup and pinHash (not isUnlocked or pin)', () => {
      // The persist middleware's partialize function filters the state.
      // We can verify this by checking the persist API directly.
      const persistOptions = useVaultStore.persist;
      expect(persistOptions).toBeDefined();

      // Simulate what partialize does by calling getOptions
      const options = persistOptions.getOptions();
      expect(options.name).toBe('vault-storage');

      // Verify partialize returns only isSetup and pinHash
      if (options.partialize) {
        const fullState = {
          isSetup: true,
          pinHash: 'some-hash',
          isUnlocked: true,
          pin: 'secret-pin',
          setupVault: () => {},
          unlockVault: () => {},
          lockVault: () => {},
          resetVault: () => {},
        };
        const persisted = options.partialize(fullState as any);
        expect(persisted).toEqual({ isSetup: true, pinHash: 'some-hash' });
        expect(persisted).not.toHaveProperty('isUnlocked');
        expect(persisted).not.toHaveProperty('pin');
      }
    });
  });

  describe('full workflow', () => {
    it('supports a complete setup -> lock -> unlock -> reset cycle', () => {
      // Setup
      useVaultStore.getState().setupVault(TEST_PIN_HASH, TEST_PIN);
      expect(useVaultStore.getState().isSetup).toBe(true);
      expect(useVaultStore.getState().isUnlocked).toBe(true);

      // Lock
      useVaultStore.getState().lockVault();
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      expect(useVaultStore.getState().pin).toBeNull();
      expect(useVaultStore.getState().isSetup).toBe(true);

      // Unlock
      useVaultStore.getState().unlockVault(TEST_PIN);
      expect(useVaultStore.getState().isUnlocked).toBe(true);
      expect(useVaultStore.getState().pin).toBe(TEST_PIN);

      // Reset
      useVaultStore.getState().resetVault();
      expect(useVaultStore.getState().isSetup).toBe(false);
      expect(useVaultStore.getState().pinHash).toBeNull();
      expect(useVaultStore.getState().isUnlocked).toBe(false);
      expect(useVaultStore.getState().pin).toBeNull();
    });
  });
});
