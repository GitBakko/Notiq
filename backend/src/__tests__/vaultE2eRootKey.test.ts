import { describe, expect, it } from 'vitest';
import path from 'path';
import { openRootKeyFile } from '../utils/vaultRootKeyFile';
import { VAULT_E2E_ROOT_KEYS } from '../utils/vaultRootKeys';

const FIXTURE = path.resolve(__dirname, '../../../frontend/e2e/fixtures/vault-root-e2e.json');
const PASSPHRASE = 'notiq-e2e-test-root-passphrase-NOT-A-SECRET';

describe('chiave root di test E2E', () => {
  it('la fixture si apre con la passphrase di test e id e SPKI coincidono con VAULT_E2E_ROOT_KEYS', async () => {
    const { keys } = await openRootKeyFile(FIXTURE, PASSPHRASE);
    expect(Object.keys(keys)).toEqual(Object.keys(VAULT_E2E_ROOT_KEYS));
    for (const [id, k] of Object.entries(keys)) {
      expect(k.ecdhSpki.toString('base64url')).toBe(VAULT_E2E_ROOT_KEYS[id].ecdhSpki);
      expect(k.ecdsaSpki.toString('base64url')).toBe(VAULT_E2E_ROOT_KEYS[id].ecdsaSpki);
    }
  }, 30_000);
});
