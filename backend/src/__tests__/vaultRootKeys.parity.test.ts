import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';

const b64u = (s: string) => Buffer.from(s, 'base64url');
// VAULT_FE_SRC permette di puntare il test a una copia (prova di fallimento).
const fePath = process.env.VAULT_FE_SRC ?? path.resolve(__dirname, '../../../frontend/src/utils/vaultRootKeys.ts');
const feSrc = fs.readFileSync(fePath, 'utf8');

const feKeys: Record<string, string> = {};
for (const m of feSrc.matchAll(/(?:^|[\s{,])['"]?(rk_[0-9a-f]{16})['"]?\s*:\s*(?:Object\.freeze\(\s*)?\{\s*ecdhSpki\s*:\s*(['"])([^'"]+)\2/g)) {
  feKeys[m[1]] = m[3];
}
const feActive = /ACTIVE_VAULT_ROOT_KEY_ID[^=]*=\s*(['"])([^'"]*)\1/.exec(feSrc)?.[2];

describe('vaultRootKeys parita backend/frontend', () => {
  it('ogni chiave: id ricalcolato, SPKI secp384r1', () => {
    const entries = Object.entries(VAULT_ROOT_KEYS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, k] of entries) {
      const ecdh = b64u(k.ecdhSpki);
      const ecdsa = b64u(k.ecdsaSpki);
      expect(ecdh.length).toBe(120);
      expect(ecdsa.length).toBe(120);
      expect(id).toBe('rk_' + crypto.createHash('sha256').update(Buffer.concat([ecdh, ecdsa])).digest('hex').slice(0, 16));
      for (const der of [ecdh, ecdsa]) {
        const pub = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
        expect(pub.asymmetricKeyType).toBe('ec');
        expect(pub.asymmetricKeyDetails?.namedCurve).toBe('secp384r1');
      }
    }
  });

  it('mappa frontend {id: ecdhSpki} identica a quella backend (stesse chiavi, nessuna in piu o in meno)', () => {
    const be = Object.fromEntries(Object.entries(VAULT_ROOT_KEYS).map(([id, k]) => [id, k.ecdhSpki]));
    expect(Object.keys(feKeys).length).toBeGreaterThan(0);
    expect(feKeys).toEqual(be);
  });

  it('id attivo frontend presente nella mappa', () => {
    expect(feActive).toBeTruthy();
    expect(Object.keys(feKeys)).toContain(feActive);
  });

  it('ecdsaSpki mai nel sorgente frontend', () => {
    for (const k of Object.values(VAULT_ROOT_KEYS)) expect(feSrc).not.toContain(k.ecdsaSpki);
  });
});
