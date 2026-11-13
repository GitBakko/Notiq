import { describe, it, expect, vi, afterEach } from 'vitest';
import { ACTIVE_VAULT_ROOT_KEY_ID, VAULT_ROOT_KEYS, getActiveRootKey } from '../vaultRootKeys';
import { b64uEncode } from '../vaultCrypto';

describe('vaultRootKeys', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

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

  // Senza VITE_VAULT_E2E la chiave di test non esiste nemmeno in memoria; col flag (solo dev) diventa quella attiva.
  it('chiave di test solo con VITE_VAULT_E2E=1', async () => {
    vi.stubEnv('VITE_VAULT_E2E', '');
    vi.resetModules();
    const off = await import('../vaultRootKeys');
    expect(Object.keys(off.VAULT_ROOT_KEYS)).toEqual(['rk_68a265761e7e37c7']);
    expect(off.ACTIVE_VAULT_ROOT_KEY_ID).toBe('rk_68a265761e7e37c7');

    vi.stubEnv('VITE_VAULT_E2E', '1');
    vi.stubEnv('MODE', 'development');
    vi.resetModules();
    const on = await import('../vaultRootKeys');
    expect(Object.keys(on.VAULT_ROOT_KEYS)).toEqual(['rk_68a265761e7e37c7', 'rk_42f37978a7909b3e']);
    expect(on.ACTIVE_VAULT_ROOT_KEY_ID).toBe('rk_42f37978a7909b3e');
    expect(on.getActiveRootKey()?.ecdhSpki.length).toBe(120);
    expect(Object.isFrozen(on.VAULT_ROOT_KEYS.rk_42f37978a7909b3e)).toBe(true);
  });

  // DEV segue NODE_ENV: con flag e DEV=true ma mode diverso da `development` (build con NODE_ENV=test) la chiave di test non c'e'.
  it.each(['production', 'test'])('flag E2E con DEV=true ma MODE=%s: nessuna chiave di test', async (mode) => {
    vi.stubEnv('VITE_VAULT_E2E', '1');
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', mode);
    vi.resetModules();
    const m = await import('../vaultRootKeys');
    expect(Object.keys(m.VAULT_ROOT_KEYS)).toEqual(['rk_68a265761e7e37c7']);
    expect(m.ACTIVE_VAULT_ROOT_KEY_ID).toBe('rk_68a265761e7e37c7');
  });
});
