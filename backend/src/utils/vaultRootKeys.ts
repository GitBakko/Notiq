// Chiavi pubbliche root del vault (piano P2 T25). DEVONO coincidere con `frontend/src/utils/vaultRootKeys.ts` (test di parita).
// id = rk_ + sha256(ecdhSpki DER || ecdsaSpki DER) hex [0:16]; SPKI EC secp384r1 in base64url.
export const VAULT_ROOT_KEYS: Readonly<Record<string, { ecdhSpki: string; ecdsaSpki: string }>> = Object.freeze({
  rk_68a265761e7e37c7: Object.freeze({
    ecdhSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE9UaYkpTPMfyJoTc6nnvLCB8F8Syd9j9Uy9JMQmeyRuBo8FLYCgLPRmq8djnO4sawRKTUzp4famYsn6M3kfFI9y9UQgWBIuZ8sZ61OBUpuRCH7sJ4LbLkYElNDqRo3YU_',
    ecdsaSpki: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEG2wXXQ9NrQeaMQIzyJod3M56-bTKPI--i3klBSzqYOnBILPGmeSy6BIryUvUBLF8RlVOoUpJ-gsOk5HiKZHBtM4e-NEJBda2zIEYj-RUHfygIRkcmAg9pIAaOFO417uJ',
  }),
});
