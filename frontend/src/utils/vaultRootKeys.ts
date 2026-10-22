// Chiavi pubbliche root del vault fissate nel bundle (piano P2 5.1, T25). Stessi id e SPKI di VAULT_ROOT_KEYS del backend
// (test di parita in backend). Se la lista fosse vuota il setup sarebbe disabilitato e non chiamerebbe il server.
import { b64uDecode } from './vaultCrypto';

export const VAULT_ROOT_KEYS: Readonly<Record<string, { ecdhSpki: string }>> = Object.freeze({
  rk_68a265761e7e37c7: Object.freeze({
    ecdhSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE9UaYkpTPMfyJoTc6nnvLCB8F8Syd9j9Uy9JMQmeyRuBo8FLYCgLPRmq8djnO4sawRKTUzp4famYsn6M3kfFI9y9UQgWBIuZ8sZ61OBUpuRCH7sJ4LbLkYElNDqRo3YU_',
  }),
});

/** Id della chiave usata dai nuovi setup/rigenerazioni (T25); deve esistere in VAULT_ROOT_KEYS. */
export const ACTIVE_VAULT_ROOT_KEY_ID: string | null = 'rk_68a265761e7e37c7';

/** Chiave attiva nel formato di `lib/vaultSession` (`RootKeyInfo`), o null se la lista e' vuota o l'id non c'e'. */
export function getActiveRootKey(
  keys: Readonly<Record<string, { ecdhSpki: string }>> = VAULT_ROOT_KEYS,
  activeId: string | null = ACTIVE_VAULT_ROOT_KEY_ID,
): { id: string; ecdhSpki: Uint8Array } | null {
  if (!activeId || !Object.prototype.hasOwnProperty.call(keys, activeId)) return null;
  return { id: activeId, ecdhSpki: b64uDecode(keys[activeId].ecdhSpki) };
}
