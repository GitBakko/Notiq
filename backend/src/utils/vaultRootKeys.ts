import { isVaultE2E } from './vaultE2e';

// Chiavi pubbliche root del vault (piano P2 T25). DEVONO coincidere con `frontend/src/utils/vaultRootKeys.ts` (test di parita).
// id = rk_ + sha256(ecdhSpki DER || ecdsaSpki DER) hex [0:16]; SPKI EC secp384r1 in base64url.
type RootKeyMap = Readonly<Record<string, { ecdhSpki: string; ecdsaSpki: string }>>;

// rk_68a265761e7e37c7 ritirata il 25/11/2026: la passphrase del suo file e' persa.
const PRODUCTION_ROOT_KEYS: RootKeyMap = {
  rk_160b1fd2a596b806: Object.freeze({
    ecdhSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEdkP7hpynx89MiprBGugF23FetHrZ-bZr5druKGFQqNz7wHncyd2PKaXs19pC4S94gSVTT__SAeeiCpAiZrEOSsKRb3O_IKfG_C-gKPlTlfciCHSviZLEksL9tzNp3_GL',
    ecdsaSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAErNl1hpE1D5EqxrRcp55N241JbmzTqp73hxVYhH5a6SuPEVf4f9vOGkNn-SMYiomTLAYDQXAuFxfVWmH4j1VoQ-JgV7SmcVfWiYm--br0Jqr6o7vRFe2VLQdHeYgGLMQc',
  }),
};

// Chiave SOLO per i test E2E (fixture frontend/e2e/fixtures/vault-root-e2e.json, passphrase di test pubblica). Entra in VAULT_ROOT_KEYS solo con isVaultE2E() al caricamento del modulo.
export const VAULT_E2E_ROOT_KEYS: RootKeyMap = Object.freeze({
  rk_42f37978a7909b3e: Object.freeze({
    ecdhSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEcfIJTVDdJbPPRd4-B2T-cGQ3DqTHR7soIEat06LaQ4WlUuG-N8cWNHocaDihzzuD_oCLS1QeeTbh0zaC7TozMc1axF0j2gwk-2iGYr9cVytb2AracHycVs-r9TDNfLbg',
    ecdsaSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEA_H3BOwmJhlYyygtRNnYsyq3-7I4EAi_YGEH7f1EzXCAbXYZjN2epM1TGxDI2GUxgzRhqVrRABUtFb-leNtcPPRV2XViW1CQksSpPLy0vjaQvjd2NCzU7vUzxgoDTWcF',
  }),
});

export const VAULT_ROOT_KEYS: RootKeyMap = Object.freeze(isVaultE2E() ? { ...PRODUCTION_ROOT_KEYS, ...VAULT_E2E_ROOT_KEYS } : { ...PRODUCTION_ROOT_KEYS });
