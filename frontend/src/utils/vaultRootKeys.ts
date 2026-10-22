// Chiavi pubbliche root del vault fissate nel bundle (piano P2 5.1). Lista VUOTA e congelata: la riempie T25
// (stessi id di VAULT_ROOT_KEYS del backend). Finche e' vuota il setup e' disabilitato e non chiama il server.
import { b64uDecode } from './vaultCrypto';

export const VAULT_ROOT_KEYS: Readonly<Record<string, { ecdhSpki: string }>> = Object.freeze({});

/** Id della chiave usata dai nuovi setup/rigenerazioni (T25); deve esistere in VAULT_ROOT_KEYS. */
export const ACTIVE_VAULT_ROOT_KEY_ID: string | null = null;

/** Chiave attiva nel formato di `lib/vaultSession` (`RootKeyInfo`), o null se la lista e' vuota o l'id non c'e'. */
export function getActiveRootKey(
  keys: Readonly<Record<string, { ecdhSpki: string }>> = VAULT_ROOT_KEYS,
  activeId: string | null = ACTIVE_VAULT_ROOT_KEY_ID,
): { id: string; ecdhSpki: Uint8Array } | null {
  if (!activeId || !Object.prototype.hasOwnProperty.call(keys, activeId)) return null;
  return { id: activeId, ecdhSpki: b64uDecode(keys[activeId].ecdhSpki) };
}
