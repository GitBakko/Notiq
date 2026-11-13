/** Emesso da VaultPage quando la cerimonia di recupero si chiude: il banner globale rilegge lo stato della richiesta. */
export const RECOVERY_CLOSED_EVENT = 'notiq:vault-recovery-closed';

/** Emesso da VaultRecovery quando la richiesta cambia stato o arriva un esito: il banner globale la rilegge. */
export const RECOVERY_CHANGED_EVENT = 'notiq:vault-recovery-changed';

/** Cerimonia montata: la pagina mostra gia' stato e annullo, quindi il banner si nasconde. Flag di modulo + evento perche' banner e pagina non sono imparentati. */
export const RECOVERY_CEREMONY_EVENT = 'notiq:vault-recovery-ceremony';
let ceremonyOpen = false;
export const isCeremonyOpen = () => ceremonyOpen;
export function setCeremonyOpen(open: boolean) {
  ceremonyOpen = open;
  window.dispatchEvent(new Event(RECOVERY_CEREMONY_EVENT));
}
