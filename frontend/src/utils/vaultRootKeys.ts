// Chiavi pubbliche root del vault fissate nel bundle (piano P2 5.1, T25). Stessi id e SPKI di VAULT_ROOT_KEYS del backend
// (test di parita in backend). Se la lista fosse vuota il setup sarebbe disabilitato e non chiamerebbe il server.
import { b64uDecode } from './vaultCrypto';

// Chiave SOLO per gli E2E (fixture e2e/fixtures/vault-root-e2e.json, passphrase di test pubblica). Il guard sta inline e usa MODE:
// `DEV` segue NODE_ENV, non `vite build` (NODE_ENV=test + VITE_VAULT_E2E=1 darebbe una build di produzione con la chiave attiva),
// mentre `vite build` e' sempre mode `production` salvo --mode. Il postbuild (scripts/check-bundle-root-keys.mjs) e' la rete di sicurezza.
// Il test di parita backend legge il blocco tra i due marcatori: non spostarli.
// E2E-KEYS-BEGIN
const E2E: { activeId: string; keys: Record<string, { ecdhSpki: string; ecdsaSpki: string }> } | null =
  import.meta.env.MODE === 'development' && import.meta.env.DEV && import.meta.env.VITE_VAULT_E2E === '1'
    ? {
        activeId: 'rk_42f37978a7909b3e',
        keys: {
          rk_42f37978a7909b3e: Object.freeze({
            ecdhSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEcfIJTVDdJbPPRd4-B2T-cGQ3DqTHR7soIEat06LaQ4WlUuG-N8cWNHocaDihzzuD_oCLS1QeeTbh0zaC7TozMc1axF0j2gwk-2iGYr9cVytb2AracHycVs-r9TDNfLbg',
            ecdsaSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEA_H3BOwmJhlYyygtRNnYsyq3-7I4EAi_YGEH7f1EzXCAbXYZjN2epM1TGxDI2GUxgzRhqVrRABUtFb-leNtcPPRV2XViW1CQksSpPLy0vjaQvjd2NCzU7vUzxgoDTWcF',
          }),
        },
      }
    : null;
// E2E-KEYS-END

export const VAULT_ROOT_KEYS: Readonly<Record<string, { ecdhSpki: string; ecdsaSpki: string }>> = Object.freeze({
  rk_68a265761e7e37c7: Object.freeze({
    ecdhSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE9UaYkpTPMfyJoTc6nnvLCB8F8Syd9j9Uy9JMQmeyRuBo8FLYCgLPRmq8djnO4sawRKTUzp4famYsn6M3kfFI9y9UQgWBIuZ8sZ61OBUpuRCH7sJ4LbLkYElNDqRo3YU_',
    ecdsaSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEG2wXXQ9NrQeaMQIzyJod3M56-bTKPI--i3klBSzqYOnBILPGmeSy6BIryUvUBLF8RlVOoUpJ-gsOk5HiKZHBtM4e-NEJBda2zIEYj-RUHfygIRkcmAg9pIAaOFO417uJ',
  }),
  ...E2E?.keys,
});

/** Id della chiave usata dai nuovi setup/rigenerazioni (T25); deve esistere in VAULT_ROOT_KEYS. Con il flag E2E e' quella di test. */
export const ACTIVE_VAULT_ROOT_KEY_ID: string | null = E2E?.activeId ?? 'rk_68a265761e7e37c7';

/** Chiave attiva nel formato di `lib/vaultSession` (`RootKeyInfo`), o null se la lista e' vuota o l'id non c'e'. */
export function getActiveRootKey(
  keys: Readonly<Record<string, { ecdhSpki: string }>> = VAULT_ROOT_KEYS,
  activeId: string | null = ACTIVE_VAULT_ROOT_KEY_ID,
): { id: string; ecdhSpki: Uint8Array } | null {
  if (!activeId || !Object.prototype.hasOwnProperty.call(keys, activeId)) return null;
  return { id: activeId, ecdhSpki: b64uDecode(keys[activeId].ecdhSpki) };
}
