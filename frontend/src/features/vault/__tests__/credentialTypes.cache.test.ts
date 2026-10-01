import { describe, it, expect, vi, beforeEach } from 'vitest';

const decryptContent = vi.fn();
const encryptContent = vi.fn();
vi.mock('../../../utils/crypto', () => ({
  decryptContent: (...a: unknown[]) => decryptContent(...a),
  encryptContent: (...a: unknown[]) => encryptContent(...a),
}));

import { useVaultStore } from '../../../store/vaultStore';
import { decryptCredential, encryptCredential, EMPTY_CREDENTIAL, __decryptCacheSize } from '../credentialTypes';

const data = { ...EMPTY_CREDENTIAL, username: 'bob' };

describe('credential decrypt cache', () => {
  beforeEach(() => {
    useVaultStore.setState({ isUnlocked: true, pin: '1234' });
    useVaultStore.setState({ isUnlocked: false }); // clears the cache
    useVaultStore.setState({ isUnlocked: true });
    decryptContent.mockReset();
    encryptContent.mockReset();
    decryptContent.mockReturnValue(JSON.stringify(data));
  });

  it('decrypts once for repeated calls', () => {
    expect(decryptCredential('ct', '1234')).toEqual(data);
    expect(decryptCredential('ct', '1234')).toEqual(data);
    expect(decryptContent).toHaveBeenCalledTimes(1);
  });

  it('returns a copy so callers cannot corrupt the cache', () => {
    decryptCredential('ct', '1234')!.username = 'evil';
    expect(decryptCredential('ct', '1234')!.username).toBe('bob');
  });

  it('decrypts again after the vault locks', () => {
    decryptCredential('ct', '1234');
    useVaultStore.setState({ isUnlocked: false });
    useVaultStore.setState({ isUnlocked: true });
    decryptCredential('ct', '1234');
    expect(decryptContent).toHaveBeenCalledTimes(2);
  });

  it('serves a just-encrypted credential without decrypting', () => {
    encryptContent.mockReturnValue('fresh-ct');
    expect(encryptCredential(data, '1234')).toBe('fresh-ct');
    expect(decryptCredential('fresh-ct', '1234')).toEqual(data);
    expect(decryptContent).not.toHaveBeenCalled();
  });

  it('does not cache a failed (wrong pin) decrypt', () => {
    decryptContent.mockReturnValueOnce('');
    expect(decryptCredential('ct', 'bad')).toBeNull();
    expect(decryptCredential('ct', 'bad')).toEqual(data);
    expect(decryptContent).toHaveBeenCalledTimes(2);
  });

  it('does not cache while the vault is locked', () => {
    useVaultStore.setState({ isUnlocked: false });
    encryptContent.mockReturnValue('locked-ct');
    encryptCredential(data, '1234');
    decryptCredential('locked-ct', '1234');
    expect(decryptContent).toHaveBeenCalledTimes(1);
  });

  it('does not cache a decrypt done with a pin different from the store pin', () => {
    decryptCredential('ct', 'other');
    decryptCredential('ct', 'other');
    expect(decryptContent).toHaveBeenCalledTimes(2);
  });

  it('caps the cache at 200 entries', () => {
    let i = 0;
    encryptContent.mockImplementation(() => 'ct-' + i++);
    for (let n = 0; n < 201; n++) encryptCredential(data, '1234');
    expect(__decryptCacheSize()).toBeLessThanOrEqual(200);
    expect(__decryptCacheSize()).toBeGreaterThan(0);
  });

  it('mutating the first (miss) result does not corrupt the cache', () => {
    decryptCredential('ct', '1234')!.username = 'evil';
    expect(decryptCredential('ct', '1234')!.username).toBe('bob');
  });
});
