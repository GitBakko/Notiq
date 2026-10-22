import { describe, it, expect } from 'vitest';
import { ACTIVE_VAULT_ROOT_KEY_ID, VAULT_ROOT_KEYS, getActiveRootKey } from '../vaultRootKeys';
import { b64uEncode } from '../vaultCrypto';

describe('vaultRootKeys', () => {
  it('lista congelata con la chiave di produzione attiva', () => {
    expect(Object.keys(VAULT_ROOT_KEYS)).toEqual(['rk_68a265761e7e37c7']);
    expect(Object.isFrozen(VAULT_ROOT_KEYS)).toBe(true);
    expect(Object.isFrozen(VAULT_ROOT_KEYS.rk_68a265761e7e37c7)).toBe(true);
    expect(ACTIVE_VAULT_ROOT_KEY_ID).toBe('rk_68a265761e7e37c7');
    const k = getActiveRootKey();
    expect(k?.id).toBe('rk_68a265761e7e37c7');
    expect(k?.ecdhSpki).toBeInstanceOf(Uint8Array);
    expect(k?.ecdhSpki.length).toBe(120);
  });

  it('id attivo assente dalla lista -> null; presente -> id e SPKI decodificato', () => {
    const spki = new Uint8Array([1, 2, 3, 250]);
    const keys = { rk_a: { ecdhSpki: b64uEncode(spki) } };
    expect(getActiveRootKey(keys, null)).toBeNull();
    expect(getActiveRootKey(keys, 'rk_b')).toBeNull();
    expect(getActiveRootKey(keys, 'toString')).toBeNull();
    const k = getActiveRootKey(keys, 'rk_a');
    expect(k?.id).toBe('rk_a');
    expect(Array.from(k!.ecdhSpki)).toEqual([1, 2, 3, 250]);
  });
});
