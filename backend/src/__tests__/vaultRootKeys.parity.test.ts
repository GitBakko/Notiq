import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { VAULT_ROOT_KEYS, VAULT_E2E_ROOT_KEYS } from '../utils/vaultRootKeys';

const PROD_KEY_ID = 'rk_68a265761e7e37c7';
const E2E_KEY_ID = 'rk_42f37978a7909b3e';

const b64u = (s: string) => Buffer.from(s, 'base64url');
// VAULT_FE_SRC permette di puntare il test a una copia (prova di fallimento).
const fePath = process.env.VAULT_FE_SRC ?? path.resolve(__dirname, '../../../frontend/src/utils/vaultRootKeys.ts');
const feSrc = fs.readFileSync(fePath, 'utf8');

const feKeys: Record<string, { ecdhSpki: string; ecdsaSpki: string }> = {};
for (const m of feSrc.matchAll(/(?:^|[\s{,])['"]?(rk_[0-9a-f]{16})['"]?\s*:\s*(?:Object\.freeze\(\s*)?\{\s*ecdhSpki\s*:\s*(['"])([^'"]+)\2\s*,\s*ecdsaSpki\s*:\s*(['"])([^'"]+)\4/g)) {
  feKeys[m[1]] = { ecdhSpki: m[3], ecdsaSpki: m[5] };
}
const feActive = /ACTIVE_VAULT_ROOT_KEY_ID[^=]*=\s*(['"])([^'"]*)\1/.exec(feSrc)?.[2];

describe('vaultRootKeys parita backend/frontend', () => {
  it('ogni chiave (produzione + test E2E): id ricalcolato, SPKI secp384r1', () => {
    const entries = Object.entries({ ...VAULT_ROOT_KEYS, ...VAULT_E2E_ROOT_KEYS });
    expect(entries.map(([id]) => id)).toEqual(expect.arrayContaining([PROD_KEY_ID, E2E_KEY_ID]));
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

  it('senza i flag E2E VAULT_ROOT_KEYS contiene solo la chiave di produzione, non quella di test', async () => {
    vi.resetModules();
    vi.stubEnv('VAULT_E2E', '');
    try {
      const { VAULT_ROOT_KEYS: keys } = await import('../utils/vaultRootKeys');
      expect(Object.keys(keys)).toEqual([PROD_KEY_ID]);
      expect(keys).not.toHaveProperty(E2E_KEY_ID);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Confronto SOLO con la mappa di PRODUZIONE. La chiave di test del frontend vivra in un ramo dev-only protetto da un flag, che la regex non deve leggere (un task successivo cambia insieme file frontend e regex).
  it('mappa frontend {id: {ecdhSpki, ecdsaSpki}} identica a quella backend di PRODUZIONE (stesse chiavi, nessuna in piu o in meno)', () => {
    const be = Object.fromEntries(Object.entries(VAULT_ROOT_KEYS).filter(([id]) => !(id in VAULT_E2E_ROOT_KEYS)).map(([id, k]) => [id, { ecdhSpki: k.ecdhSpki, ecdsaSpki: k.ecdsaSpki }]));
    expect(Object.keys(feKeys).length).toBeGreaterThan(0);
    expect(feKeys).toEqual(be);
  });

  it('id attivo frontend presente nella mappa', () => {
    expect(feActive).toBeTruthy();
    expect(Object.keys(feKeys)).toContain(feActive);
  });
});
