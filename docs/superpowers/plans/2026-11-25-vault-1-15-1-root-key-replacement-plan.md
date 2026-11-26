# Vault 1.15.1: sostituzione della chiave root di produzione

Data: 25/11/2026. Base: `main` = tag `v1.15.0` (`d6b17bd`), in produzione dal 25/11.
Piano scritto dall'architect, decisioni approvate dall'utente il 25/11.

## 1. Problema

- In produzione c'è un solo file di chiave root, `E:\NotiqSecrets\vault-root.json`, con rootKeyId `rk_68a265761e7e37c7` (cerimonia del 01/10/2026). La sua chiave pubblica è fissata in `PRODUCTION_ROOT_KEYS` di `backend/src/utils/vaultRootKeys.ts` e `frontend/src/utils/vaultRootKeys.ts`.
- **La passphrase di quel file è persa.** `releaseRootShare` (`backend/src/services/vaultRootKey.service.ts:83`) non potrà mai aprirlo: nessun recupero del PIN è rilasciabile. Tutti gli escrow esistenti (`VaultKeyring.sealedRootShare`) sono sigillati con quella chiave.
- I dati non sono a rischio: sblocco col PIN, cambio PIN e rotazione della VK non usano la chiave root. Nel client il `rootKeyId` si controlla solo nel completamento del recupero (`frontend/src/lib/vaultRecovery.ts:401`).
- Oggi una richiesta di recupero viene accettata. L'admin la approva, l'utente aspetta 3 giorni e poi il rilascio fallisce (403 `invalidRootPassphrase`). Mitigazione manuale fino alla 1.15.1: l'admin rifiuta le richieste in approvazione. I SUPERADMIN però non ricevono alcuna notifica per una richiesta nuova (`vaultRecoveryNotify.ts`: `notifySuperadmins` copre solo `releaseFailed` e `selfAction`).

## 2. Approccio

- **Ritiro implicito della chiave.** `rk_68a265761e7e37c7` esce da `PRODUCTION_ROOT_KEYS` (BE e FE) e la nuova chiave prende il suo posto. Per il codice una chiave ritirata è un id che non sta in `VAULT_ROOT_KEYS`. I tre punti che creano sigilli la rifiutano già con 400 `invalidRootKey`: `createKeyring` (`vault.service.ts:246`), `PUT /keyring` (`vault.service.ts:395`), `complete` (`vaultRecovery.service.ts:475`). L'id vecchio resta solo in un commento.
  - Scartata: una lista `RETIRED_ROOT_KEY_IDS` accanto alla chiave tenuta. Andrebbe controllata in ogni punto, e un client 1.15.0 continuerebbe a creare escrow morti.
- **Blocco della richiesta lato server più UI.** `createRecoveryRequest` e `approveRecovery` rispondono 409 `errors.vault.recoveryRootKeyRetired` quando `!isRootKey(keyring.rootKeyId)`. Il controllo in approve copre anche le richieste già aperte. Il blocco lato server serve perché il client 1.15.0 in cache non ha la guardia nella UI. La UI 1.15.1 mostra il messaggio prima della POST.
- **Ri-sigillo forzato con un campo nuovo.** `GET /keyring` aggiunge `rootKeyRetired: status === 'READY' && !!rootKeyId && !isRootKey(rootKeyId)`. Il client 1.15.1 lo mette in OR in `rotationOf` (`VaultPage.tsx:58`): al primo sblocco online si apre il foglio obbligatorio di rigenerazione del Kit, che ruota la VK e sigilla l'escrow con la chiave nuova. `rotateVault` non ha bisogno della chiave root vecchia (`vaultSession.ts:648-665`).
  - Scartato il riuso di `kitRotationRequired`: il client 1.15.0 aprirebbe il foglio obbligatorio e sigillerebbe con l'id vecchio, con un 400 a ogni tentativo e il foglio bloccante. Il campo nuovo il client 1.15.0 lo ignora.
- **Notifica agli admin.** `notifySuperadmins` aggiunge l'evento `requested`, con email e notifica in-app di tipo `SYSTEM`. Non `VAULT_RECOVERY`, che è un enum Prisma e porta a `/vault?recovery=1`. Il richiedente è escluso, come per `selfAction`.

## 3. Decisioni (approvate il 25/11)

| # | Domanda | Decisione |
|---|---------|-----------|
| 1 | Avviso una tantum agli utenti con chiave ritirata che non sbloccano | No: basta il foglio al prossimo sblocco |
| 2 | Chi ha già perso il PIN con escrow ritirato | Nessun recupero (P3 non esiste). Testo: «Il recupero non è disponibile per questo vault. Sbloccalo col PIN e genera un nuovo Kit.» |
| 3 | Foglio di ri-sigillo rinviabile | No, non rinviabile come l'attuale |
| 4 | File `vault-root.json` vecchio | Archiviato offline, non cancellato: se la passphrase riemerge, apre gli escrow vecchi |
| 5 | Recupero completo in produzione con la chiave nuova | Sì, su un account di prova (3 giorni di attesa, ruota la VK di quell'account) |
| 6 | Notifica all'admin che chiede il recupero per sé | No: solo agli altri admin |

## 4. File da toccare

Nessun file TIER 1/2, nessuna migration, nessuna versione Dexie nuova. Sono più di 3 file: l'utente è stato avvisato il 25/11.

- BE `backend/src/utils/vaultRootKeys.ts`: sostituire l'entry di produzione (nuovo id e due SPKI).
- BE `backend/src/services/vault.service.ts`: `export` di `isRootKey` (`:224`), nient'altro.
- BE `backend/src/routes/vault.ts:117-124`: campo `rootKeyRetired` nella risposta di `GET /keyring`.
- BE `backend/src/services/vaultRecovery.service.ts`: guardia in `createRecoveryRequest` (dopo `:107`) e in `approveRecovery`; dopo la creazione `notifyAdminsInBackground('requested', …)`.
- BE `backend/src/services/vaultRecoveryNotify.ts` e `backend/src/utils/notificationI18n.ts`: testi `requested` it/en. Dati in-app: solo `requestId` ed email dell'utente.
- BE `backend/src/routes/vaultE2e.ts`: hook solo E2E che imposta `rootKeyId = 'rk_68a265761e7e37c7'` sul keyring dell'utente di test. Verificare prima che gli E2E non abbiano già un helper DB.
- FE `frontend/src/utils/vaultRootKeys.ts`: mappa e `ACTIVE_VAULT_ROOT_KEY_ID` (`:33`) col nuovo id.
- FE `frontend/scripts/check-bundle-root-keys.mjs`: `PROD_ID` nuovo; l'id ritirato trattato come fuga (fallisce se è nel bundle).
- FE `frontend/src/lib/vaultSession.ts`: solo il tipo `rootKeyRetired?: boolean`.
- FE `frontend/src/features/vault/VaultPage.tsx`: `rotationOf` più il motivo da passare al foglio.
- FE `frontend/src/features/vault/VaultSettingsSheet.tsx`: testo `vault.kitRotation.retiredWarning` (quello attuale parla di un recupero rilasciato).
- FE recupero: avvio da `VaultRecovery.tsx` e `components/vault/RecoveryBanner.tsx`; `recoveryOutcome.ts` per il 409.
- FE `frontend/src/components/.../NotificationItem.tsx`: nel caso `SYSTEM`, le chiavi `vaultRecovery.admin*` portano alla tab admin. `features/admin/tabs/VaultRecoveryTab.tsx` mostra l'errore di approve.
- FE `frontend/src/locales/en.json` e `it.json`.
- Test: `vaultRootKeys.parity.test.ts`, `frontend/src/utils/__tests__/vaultRootKeys.test.ts` (9 occorrenze), `vault.service.test.ts`, `vaultRecovery.service.test.ts`, `routes/__tests__/vaultE2e.route.test.ts` (`:71`), più i nuovi.

## 5. Invarianti

- Nessun sigillo nuovo con un id fuori da `VAULT_ROOT_KEYS`. In produzione la mappa ha esattamente una chiave, la nuova.
- `rk_42f37978a7909b3e` (test E2E) e `rk_68a265761e7e37c7` (ritirata) non compaiono in `frontend/dist`.
- Sblocco col PIN, cambio PIN, note e credenziali non dipendono da `rootKeyId`: un keyring con chiave ritirata resta pienamente usabile.
- Un 409 da chiave ritirata non crea righe `VaultRequest` e non consuma quota. Un approve con chiave ritirata non cambia lo stato.
- Notifiche agli admin: mai il codice né la sua metà B nei dati o nei log. Non lanciano mai eccezioni, come l'attuale `notifySuperadmins`.

## 6. Criteri di accettazione e test

TDD: i test si scrivono prima del codice.

- Unit BE:
  - `createRecoveryRequest` con chiave ritirata: 409, 0 righe create.
  - `approveRecovery` con chiave ritirata: 409, stato invariato.
  - `GET /keyring`: `rootKeyRetired` true, false, e assente con stato `NONE`.
  - `PUT /keyring` con `rotate` e l'id vecchio: 400.
  - `notifySuperadmins('requested')`: un'email e un `createNotification` per ogni admin, richiedente escluso.
  - Parità BE/FE con il nuovo id; un test fallisce se `rk_68a265761e7e37c7` torna nella mappa.
- Unit FE:
  - `rotationOf` col flag `rootKeyRetired`.
  - Testo del foglio con il motivo «chiave ritirata».
  - Avvio del recupero bloccato senza POST.
  - Link della notifica `SYSTEM` alla tab admin.
  - `getActiveRootKey()` restituisce il nuovo id.
- E2E (nuovo caso in `e2e/vault-recovery.spec.ts` o nuovo `e2e/vault-root-retired.spec.ts`, con l'hook e la chiave di test):
  - Con keyring a chiave ritirata, l'avvio del recupero mostra il messaggio.
  - Lo sblocco apre il foglio obbligatorio col testo della chiave ritirata. La rigenerazione porta `rootKeyId = rk_42f37978a7909b3e`, `rootKeyRetired = false`, epoch+1.
  - Dopo il ri-sigillo il recupero si avvia e si annulla.
  - Poi tutta la suite del passo 4 di «Rilascio vault P4» nella skill `notiq-deploy`.
- Comandi: BE `npm test; npx tsc --noEmit; npm run lint`. FE `npx vitest run; npx tsc -p tsconfig.app.json --noEmit; npm run lint; npm run build` (il postbuild deve passare).

## 7. Compatibilità

- **Client 1.15.0 contro server 1.15.1.** Setup e rigenerazione del Kit danno 400 `invalidRootKey` e non scrivono nulla. L'avvio del recupero dà 409 con un errore generico. Nessun foglio forzato. Si risolve con l'aggiornamento della PWA (hard reload, o chiudere e riaprire l'app).
- **Client 1.15.1 contro server 1.15.0 (rollback).** La rigenerazione dà 400 e non c'è il foglio forzato. Le richieste tornano possibili e vanno rifiutate a mano.
- **Deploy prima della cerimonia: impossibile per costruzione.** Senza SPKI il codice non si scrive, e test di parità e postbuild bloccano. Il caso pericoloso è `VAULT_ROOT_KEY_PATH` lasciato sul file vecchio: ogni rilascio diventerebbe un 403 che conta per il rate limit.

## 8. Runbook di rilascio

1. **Cerimonia** via RDP, in un file NUOVO senza sovrascrivere il vecchio: `cd E:\www\Notiq\backend; npm run vault:root-keygen -- --out E:\NotiqSecrets\vault-root-20261125.json`. Lo script verifica il file appena scritto. Poi subito `node dist\scripts\vaultRootKeygen.js --verify <file>`, da cui si annotano rootKeyId, sha256 e JSON `pub`. Passphrase in **due** posti, verificata prima di chiudere. Stessi ACL del vecchio, con lettura per l'utente di pm2 (`SRVAPP\Administrator`).
2. L'utente fornisce rootKeyId e le due SPKI (il JSON `pub`): sono dati pubblici.
3. Codice e test (sezione 6), poi `/notiq-release` 1.15.1 e build.
4. SQL prima del deploy:
   - `SELECT "rootKeyId", status, count(*) FROM "VaultKeyring" GROUP BY 1, 2;`
   - `SELECT r.id, r.status, r."userId" FROM "VaultRequest" r WHERE r.type = 'RECOVERY' AND r.status IN ('PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED');`
5. Rifiutare dalla tab admin le richieste aperte, con un motivo, PRIMA del deploy (dopo, approve dà comunque 409). Il rifiuto accetta solo `PENDING_APPROVAL`. Le richieste in `PENDING_CODE`, `WAITING` o `RELEASED` non si possono rifiutare: dalla 1.15.1 confirm e release rispondono 409 `recoveryRootKeyRetired` senza cambiare stato, poi la richiesta scade da sola o l'utente la annulla.
6. `VAULT_ROOT_KEY_PATH` sul file nuovo in `E:\www\Notiq\backend\.env`, deploy (con `pm2 restart`), log OK.
7. Canary SUPERADMIN: sblocco, foglio col testo della chiave ritirata, rigenerazione. SQL: `rootKeyId` nuovo ed epoch+1. Poi avvio e annullamento di un recupero: email e in-app arrivano agli altri admin.
8. Decisione 5: recupero completo su un account di prova (richiesta, approvazione, codice, 3 giorni, rilascio con la passphrase nuova, `complete`).
9. Archiviare offline il file vecchio (decisione 4). Monitorare il conteggio per rootKeyId finché i keyring con la chiave ritirata vanno a 0.

## 9. Rischi e fuori scope

- Gli utenti con chiave ritirata che non sbloccano restano senza recupero: il ri-sigillo avviene solo allo sblocco online.
- La notifica in-app `SYSTEM` può essere cancellata dall'admin; l'email resta.
- I backup già fatti contengono escrow non apribili: innocuo.
- Fuori scope: P3 (reset del vault), più chiavi attive insieme, rotazione periodica della chiave root.

### Esito delle review (26/11) e rischi accettati

Corretti:
- Guardia della chiave ritirata anche in `confirmRecovery` e `releaseRecovery`. In release la guardia sta prima del rate limit e di Argon2.
- Foglio forzato: un errore tecnico (`flushTimeout`, errore di rete, 400 `invalidRootKey`) lo rinvia fino al prossimo sblocco. Prima l'utente restava bloccato dietro il foglio. Con un PIN sbagliato il foglio resta aperto.
- La tab admin si apre da `?tab=` anche dopo un cambio di tab.

Accettati:
- Il limite di route `POST /recovery`, 3 all'ora, conta anche le risposte 409. Un client 1.15.0 che riprova resta bloccato al massimo per un'ora. «Quota» nel §5 indica il contatore del servizio.
- Un ciclo crea/annulla genera al massimo 3 notifiche all'ora per utente verso gli admin. Gli utenti arrivano solo su invito.
- Il bottone dell'email `requested` porta a `/vault`, non alla tab admin, perché il template `VAULT_RECOVERY` sta in `email.service.ts`, file TIER 2. Il link corretto c'è solo nella notifica in-app.
- Una richiesta `PENDING_APPROVAL` su chiave ritirata mostra all'utente «in attesa di approvazione» finché l'admin non la rifiuta (passo 5 del runbook).
- Alla prossima sostituzione della chiave root un client in cache sigillerebbe con l'id vecchio e riceverebbe 400. Il rinvio sugli errori tecnici evita il blocco.
- I limiti di route su release (3 ogni 15 minuti) e confirm (5 ogni 15 minuti) contano anche i 409 della chiave ritirata. Runbook: non cliccare Rilascia sulle richieste `WAITING` con chiave ritirata, altrimenti la prova del passo 8 può prendere 429 per 15 minuti.
- Un errore tecnico che si ripete a ogni sblocco, per esempio un elemento della coda sempre `pending` che fa scattare `flushTimeout`, rinvia il ri-sigillo per sempre. Il segnale è il conteggio per `rootKeyId` del passo 9: i keyring rimasti sulla chiave ritirata vanno guardati uno per uno.

Secondo giro (red-team del 26/11, corretto): un fallimento ripetuto di `finishRotation` non riapre più il foglio in loop, perché il rinvio diventa `'error'`. Dopo un errore del foglio il client rilegge il keyring: se la PUT era già andata a buon fine, l'epoch avanti blocca il vault.
