// Hook solo per i test E2E del recupero vault. Servono NODE_ENV=test E VAULT_E2E=1: pm2 in produzione non imposta NODE_ENV,
// quindi "!== 'production'" non basterebbe. Le env vanno impostate prima dell'avvio (come fa dotenv): VAULT_ROOT_KEYS si fissa al caricamento del modulo e le route E2E alla registrazione del plugin; solo putE2eCodeB rilegge a ogni chiamata.
export function isVaultE2E(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.VAULT_E2E === '1';
}

// Outbox in memoria requestId -> codeB (la mail non e' leggibile dal browser di test). Non si svuota in lettura: l'E2E lo rilegge dopo un tentativo errato.
const outbox = new Map<string, string>();

export function putE2eCodeB(requestId: string, codeB: string): void {
  if (isVaultE2E()) outbox.set(requestId, codeB);
}

export function getE2eCodeB(requestId: string): string | undefined {
  return outbox.get(requestId);
}
