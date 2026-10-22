import { describe, it, expect, beforeEach } from 'vitest';
import { useVaultStore } from '../vaultStore';

describe('vaultStore', () => {
  beforeEach(() => {
    useVaultStore.setState({ isSetup: false, pinHash: null, isUnlocked: false, byUser: {} });
  });

  it('parte bloccato', () => {
    const s = useVaultStore.getState();
    expect(s.isUnlocked).toBe(false);
    expect(s.keys).toBeNull();
  });

  it('lockVault azzera lo stato di sblocco', () => {
    useVaultStore.setState({ isUnlocked: true });
    void useVaultStore.getState().lockVault();
    expect(useVaultStore.getState().isUnlocked).toBe(false);
  });

  it('persiste solo isSetup, pinHash e byUser (mai isUnlocked)', () => {
    const options = useVaultStore.persist.getOptions();
    expect(options.name).toBe('vault-storage');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub parziale dello store
    const persisted = options.partialize!({ isSetup: true, pinHash: 'h', isUnlocked: true, byUser: {} } as any);
    expect(persisted).toEqual({ isSetup: true, pinHash: 'h', byUser: {} });
  });
});
