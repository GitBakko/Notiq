# Vault P3: reset del vault (PIN e Kit persi)

Data: 26/11/2026. Base: `main` = tag `v1.15.1` (`440fea7`). Rilascio previsto: 1.16.0.
Piano scritto dall'architect. Decisioni D1-D10 del §10 approvate dall'utente il 26/11/2026, come raccomandate.

## 1. Problema e base esistente

- Chi perde PIN e Kit, o ha l'escrow sulla chiave ritirata `rk_68a265761e7e37c7`, non può più usare il vault. Oggi non esiste una rotta di reset. Caso reale: il SUPERADMIN, con 2 note vault che non gli servono.
- Il design ha già deciso alcuni punti (`2026-09-30-vault-v3-design.md` §4, §5.1 e P3 alle righe 554-562):
  - il reset lo avvia l'utente;
  - conferma con un codice di sistema da riscrivere, stile GitHub, più la password dell'account;
  - finestra di 7 giorni in cui il reset si può annullare (§10.5);
  - la cancellazione definitiva la fa un job;
  - l'epoch sale di 1 e la riga del keyring resta.
- Lo schema c'è già, quindi **nessuna migration**: `VaultStatus.RESET_PENDING`, `VaultKeyring.resetScheduledAt`, `VaultRequestType.RESET`, `codeHash`, `attempts`, `notBefore`, `cancelledBy`.
- Il blocco delle scritture c'è già. Con `RESET_PENDING`, `getVaultGuard` restituisce `ready:false` e `assertVaultContent` risponde 422 `notReady` (`vault.service.ts:76`). Il blocco vale per:
  - creazione e aggiornamento del contenuto;
  - ingresso e uscita dal vault;
  - import, allegati e restore di una versione.

  Inoltre `unlock` risponde 409 `notReady` (`:460`). Le CAS di `PUT /keyring` e di `complete` richiedono `READY`, e così `createRecoveryRequest`.
- Il setup dopo il reset funziona già: `createKeyring` gestisce la riga `NONE` con epoch>0 (RT-10, `:297`) e azzera `prevVkWrap` (`:281`).
- La pulizia del client c'è già: `removeFromDevice(userId, {force:true})` (`vaultSession.ts:435-453`). Cancella le righe Dexie vault (note e tag), gli item di coda vault, `byUser` (`forgetUser`) e lo store `notiq-vault-device`. Nessuna versione Dexie nuova.

## 2. Approccio scelto

Le alternative scartate stanno nella tabella del §10.

1. **Chi avvia.** Solo l'utente, autenticato, con la password dell'account. L'admin non avvia e non approva, ma **può annullare**. Tutti i SUPERADMIN vengono avvisati.
2. **Macchina a stati.** Si riusa `VaultRequest(type=RESET)`.
   - **Richiesta:** `PENDING_CODE` (10 min, 5 tentativi) → `WAITING` (`notBefore = resetScheduledAt`) → `COMPLETED` oppure `CANCELLED`. Da `PENDING_CODE` può anche andare in `EXPIRED`.
   - **Keyring**, nella stessa transazione: `READY` → `RESET_PENDING` → `NONE` con epoch+1, oppure di nuovo `READY` se il reset viene annullato.
3. **Rotte utente** (`routes/vault.ts`):
   - `POST /vault/reset/challenge`, limite 5/h.
     - Risposta: `{requestId, code, expiresAt, counts}`.
     - Il codice è Crockford a 12 caratteri, generato con `newCode()`. Nel DB va solo l'HMAC, `codeHash(requestId,'R',code)`.
     - Una challenge nuova fa scadere la `PENDING_CODE` precedente.
   - `POST /vault/reset` `{requestId, code, password}`, limite 3/15min per utente.
     - Il codice non distingue maiuscole e minuscole, e i trattini sono facoltativi.
     - Una password sbagliata risponde 403 `invalidPassword`, mai 401, perché un 401 farebbe scattare il logout automatico.
     - Sia un codice sia una password sbagliati incrementano `attempts`. Al 5° errore la richiesta va in `EXPIRED`.
   - `POST /vault/reset/cancel`, senza body, limite `perIp` 10/min. Basta il JWT.
4. **Conferma.** Tutto avviene in una sola transazione, con advisory lock `vault-reset:<userId>`:
   - CAS del keyring `READY` → `RESET_PENDING`, con `resetScheduledAt = now+7g`;
   - la richiesta passa a `WAITING`;
   - le richieste `RECOVERY` aperte passano a `CANCELLED`, con `rootShareForClient` e `rootSignature` a null.

   Dopo il commit si scrivono l'audit e le notifiche.
5. **Hard delete.** Lo fa `runResetJobs()`, chiamato dentro `runRecoveryJobs()`, che gira già ogni 15 minuti (`app.ts:366`). `app.ts` non si tocca.
   - Per ogni keyring `RESET_PENDING` con `resetScheduledAt <= now` si apre una transazione con timeout di 30 s. Al suo interno, in quest'ordine:
     1. CAS con `updateMany {userId, status:'RESET_PENDING', resetScheduledAt ≤ now}` verso `NONE`:
        - `epoch+1` e `rev+1`;
        - i campi crittografici e `prevVkWrap` a null;
        - `failedAttempts` a 0, `lockedUntil` e `resetScheduledAt` a null;
        - `migrationState` a `NONE`.

        Se il count è 0 si esce: il reset è stato annullato o un altro worker pm2 l'ha già fatto.
     2. Lettura degli `url` degli allegati e dei conteggi.
     3. `note.deleteMany {userId, isVault:true}`, comprese le note nel cestino.
        - Vanno in cascata, per FK: `NoteVersion`, `TagsOnNotes`, `Attachment`, `SharedNote`, `ChatMessage`, `AiConversation`.
        - Il riferimento da Kanban va a null.
     4. `tag.deleteMany {userId, isVault:true}`.
     5. La richiesta passa a `COMPLETED`.
     6. `auditLog.create` con `vault.reset.completed {requestId, epoch:nuova, counts}`.
        - Va scritto **dentro** la transazione, perché fa anche da stato (punto 6).
        - È una create diretta, non `logEvent`, che ingoia gli errori.
   - Dopo il commit:
     - unlink best effort dei file (`getAttachmentPath`), con log e conteggio dei falliti; `npm run prune` resta la rete di sicurezza;
     - poi le notifiche.
   - Hocuspocus non è coinvolto: i doc vault non sono mai live (`hocuspocus.ts:308`).
6. **`lastResetEpoch: number|null` in `GET /keyring`.**
   - Viene letto dall'ultimo audit `vault.reset.completed`, cercando l'ultima nota sull'indice `[userId, createdAt]`.
   - Lo stesso schema, AuditLog usato come stato, c'è già per `reminder_sent` e `release_failed`.
   - Serve a distinguere un reset da una rotazione quando un dispositivo torna online dopo il nuovo setup: in entrambi i casi vede READY con epoch più alta.
7. **Client: una regola sola in `syncKeyringCache`.** Si applica solo a una risposta 200 validata (`okKeyring`), mai a 404, 5xx o errore di rete.
   - Con `RESET_PENDING`:
     - si chiama `lockVault()` se questo utente è sbloccato;
     - poi `deleteShare`, così lo sblocco offline non è più possibile;
     - le righe Dexie restano, perché un annullo deve poter ripristinare tutto.
   - Il purge scatta se c'è una cache e `lastResetEpoch > cache.epoch`, oppure se `status NONE && epoch > cache.epoch`. In quest'ordine:
     1. `await lockVault()`, così i flusher pre-lock scrivono **prima** della cancellazione;
     2. `removeFromDevice(userId,{force:true})`;
     3. `purgeVaultCache()`.

     Un guard in-flight a livello di modulo evita i purge doppi, e il purge è escluso mentre `rotating` è true.
   - La regola si chiama da due punti:
     - `VaultPage.loadKeyring`, per tutti gli stati (oggi solo READY, `:241`);
     - `useOpenRecovery`, che gira per ogni utente al mount, al focus e ogni 15 minuti, e restituirà anche `resetScheduledAt` per il banner.
8. **Righe sincronizzate sugli altri dispositivi.** `syncPull` le cancella da sola, perché toglie le note che mancano sul server (`syncService.ts:167-174`). **syncService non si tocca.**
   - Le righe sporche e gli item in coda ricevono 422 dal server finché il purge esplicito non li rimuove.
   - Non possono risorgere:
     - prima del nuovo setup il server risponde `notReady`;
     - dopo il setup risponde `stale`, perché l'epoch non combacia;
     - un update su una nota cancellata risponde 404.
9. **Rotte admin** (`vaultAdmin.ts`, prefisso `/vault-recovery`):
   - `type` facoltativo nella lista, con valore `RESET`;
   - `POST /:id/cancel-reset`.

## 3. Interazioni

- **Rotazione in corso** (`prevVkWrap`, note stale, `migrationState IN_PROGRESS`):
  - il reset è ammesso da `READY` in ogni caso, e cancella tutto;
  - durante `RESET_PENDING` rotazione e cambio PIN falliscono, perché la CAS richiede `READY`;
  - `StaleNotesDialog` non si apre, perché il vault è bloccato.
- **Recupero:**
  - la conferma del reset annulla le richieste RECOVERY aperte;
  - durante `RESET_PENDING` una nuova RECOVERY riceve già 409 (`recoveryNoKeyring`, che richiede READY);
  - l'annullo del reset non riapre il recupero.
- **Gate `resetPending`** (`VaultPage.tsx:55,739`):
  - oggi mostra solo un testo; diventa una schermata con la data del reset e il pulsante "Annulla reset", attivo online;
  - in `AppLayout`, accanto a `RecoveryBanner`, compare un banner non chiudibile.
- **Condivisione:** le note vault non sono condivisibili (`sharing.service.ts:25,463,780`). Le eventuali `SharedNote` residue vanno in cascata.
- **Kill switch:** dopo il reset il nuovo setup passa da `isSetupAllowed`. Se `VAULT_SETUP_USERS` esclude l'utente, il vault resta `setupDisabled`.

## 4. Audit e notifiche

- **Audit.** Eventi: `vault.reset.challenge`, `vault.reset.code_failed`, `vault.reset.password_rejected`, `vault.reset.scheduled {requestId, scheduledAt, counts}`, `vault.reset.cancelled {requestId, byAdmin:boolean}`, `vault.reset.completed {requestId, epoch, counts, filesFailed}`. Solo conteggi, mai titoli o codici.
- **Utente.** Email e notifica in-app di tipo `SYSTEM` su `scheduled`, `cancelled` e `completed`.
  - Non si usa `VAULT_RECOVERY`, che apre `/vault?recovery=1`.
  - L'email passa da `sendNotificationEmail`; `email.service.ts` (TIER 2) non si tocca.
- **Admin.** `notifySuperadmins` sugli stessi tre eventi, escluso chi compie l'azione, come già per `selfAction`. Le notifiche non lanciano mai eccezioni, come oggi.
- **Testi.** `utils/notificationI18n.ts` (`VAULT_RESET_TEXTS` it/en) e `en.json`/`it.json` (`vault.reset.*`, `errors.vault.reset*`, `admin.vaultRecovery.reset*`).

## 5. Compatibilità e rollback

- **Client 1.15.x in cache contro server 1.16:**
  - vede `RESET_PENDING` come "vault non disponibile" e `NONE` come setup; ignora `lastResetEpoch`;
  - non pulisce le righe sporche, ma il server le rifiuta;
  - dopo il nuovo setup, le note che non riesce a leggere finiscono nel `StaleNotesDialog`;
  - durante `RESET_PENDING` lo sblocco offline resta possibile su quel client, ma solo sui suoi dati locali.
- **Rollback del backend a 1.15.1:**
  - con un keyring in `RESET_PENDING` il job non esiste e il vault resta bloccato; si sblocca con la SQL di annullo (runbook §8) o con un nuovo deploy;
  - dopo `NONE` con epoch>0 il setup della 1.15.1 funziona (RT-10); `lastResetEpoch` sparisce, e si perde solo il purge esplicito sul client.

## 6. Invarianti

- Con 404, errore di rete o 5xx il client non cancella mai niente. Il purge parte solo da un 200 esplicito, con la regola del §2.7.
- Nessun plaintext persistito e nessuna versione Dexie nuova.
- Non si modificano: `syncService.ts`, `db.ts`, `vaultStore.ts`, `vaultReconcile.ts`, `vaultCrypto.ts`, `schema.prisma`, `app.ts`, `email.service.ts`, `api.ts`.
- La riga `VaultKeyring` non si cancella mai, e l'epoch sale soltanto.
- Il reset non tocca le note e i tag non vault, compreso un tag non vault con lo stesso nome di uno vault.
- Hard delete e CAS stanno nella stessa transazione. Se la CAS fallisce non si cancella niente, e due worker producono una sola cancellazione.
- Nel DB c'è solo l'HMAC del codice. Il codice non compare mai in log, notifiche o email.
- `dropVaultRows` parte solo dopo che `lockVault` ha finito.

## 7. Test

TDD: i test si scrivono prima del codice.

**Backend, `services/__tests__/vaultReset.service.test.ts`:**
- Challenge:
  - solo da READY; da NONE risponde 409;
  - conteggi esatti;
  - nel DB c'è solo l'HMAC;
  - una seconda challenge fa scadere la prima.
- Tentativi:
  - un codice o una password sbagliati non cambiano lo stato e incrementano `attempts`;
  - il 6° tentativo è rifiutato;
  - il codice scade dopo 10 minuti.
- Conferma valida: `RESET_PENDING` con scadenza +7g, richiesta in `WAITING`, richieste RECOVERY in `CANCELLED`.
- In `RESET_PENDING` vengono rifiutati: `unlock` (409), `createNote isVault` (422 `notReady`), `updateNote` sul contenuto, `PUT /keyring`, `POST /recovery`.
- Annullo:
  - quello dell'utente e quello dell'admin riportano a `READY`, con i conteggi invariati;
  - dopo il completamento l'annullo risponde 409.
- Job:
  - prima della scadenza non fa nulla;
  - dopo la scadenza:
    - nessuna nota, tag, versione, allegato o SharedNote vault rimasta;
    - dati non vault intatti;
    - epoch+1 e riga del keyring presente;
    - campi crittografici a null;
    - audit con la nuova epoch;
    - unlink dei file chiamato.
  - due run in parallelo producono una sola cancellazione;
  - un annullo fra la select e la CAS non cancella nulla.
- Dopo il reset:
  - `lastResetEpoch` è corretto;
  - un setup con `expectedEpoch = N+1` va a buon fine;
  - un envelope `nv3.N.` viene rifiutato.

**Backend, test delle rotte:**
- rate limit, 400 con messaggio fisso, header `no-store`, ruolo admin letto dal DB;
- una password sbagliata dà 403, mai 401.

**Frontend, test unitari:**
- `syncKeyringCache`:
  - `RESET_PENDING` blocca il vault e cancella lo share, e Dexie resta intatto;
  - `NONE` con epoch maggiore della cache esegue il purge;
  - READY con `lastResetEpoch` maggiore della cache esegue il purge;
  - una rotazione (`lastResetEpoch` null o ≤ cache) non esegue il purge;
  - le righe non vault restano;
  - il flusher gira prima del drop.
- `VaultResetDialog`:
  - il pulsante resta disabilitato finché codice e password non sono validi;
  - incollare è permesso;
  - maiuscole e trattini sono indifferenti.
- `useOpenRecovery` restituisce `resetScheduledAt`.

**E2E, `frontend/e2e/vault-reset.spec.ts`.** Usa due contesti dello stesso utente (A e B) più un admin, e un hook solo E2E `POST /__e2e/reset/advance`: porta `resetScheduledAt` nel passato e lancia `runResetJobs({userId})`.
- A conferma il reset: B, sbloccato, si blocca e mostra il banner.
- A annulla: B sblocca con lo stesso PIN e i dati ci sono.
- A conferma di nuovo, poi advance:
  - righe e item in coda di B spariscono, e B vede il setup;
  - il nuovo setup va a buon fine;
  - un push con l'envelope vecchio fallisce e la nota non risorge.
- Con `page.route` che risponde 404 su `GET /api/vault/keyring` non si cancella nulla.
- L'annullo fatto dall'admin funziona.
- Da rieseguire su chromium e WebKit: `vault-multidevice`, `vault-offline`, `vault-recovery`, `vault-root-retired`, `vault-a11y`.

## 8. Runbook di produzione

Primo uso: il vault del SUPERADMIN.

1. **Prima del deploy**, l'utente lancia in pgAdmin:
   - `SELECT id,email FROM "User" WHERE role='SUPERADMIN';`, per sapere se ci sono altri admin da avvisare;
   - `SELECT status,epoch,"rootKeyId" FROM "VaultKeyring" WHERE "userId"=$1;`;
   - `SELECT "noteType",count(*) FROM "Note" WHERE "userId"=$1 AND "isVault" GROUP BY 1;`, per avere il valore "prima".
2. Controllare che `VAULT_SETUP_USERS` nel `.env` di prod includa il SUPERADMIN, oppure valga `*`. Altrimenti, dopo il reset, il setup resta chiuso.
3. Build e deploy della 1.16.0 con `/notiq-deploy`, dump del DB compreso. Poi hard reload e verifica che venga servito l'asset nuovo.
4. Il SUPERADMIN va su `/vault`, sceglie "Ho perso PIN e Kit" e poi Reset, riscrive il codice e inserisce la password.
5. Verificare:
   - l'email e la notifica;
   - il banner su un secondo dispositivo;
   - lo stato `RESET_PENDING` con la data.

   L'annullo va provato su un account di prova.
6. Attendere 7 giorni (decisione D5). Il job gira entro 15 minuti dalla scadenza.
7. **Verifica dopo il job:**
   - 0 note e 0 tag vault;
   - keyring `NONE` a epoch N+1;
   - audit `vault.reset.completed` presente;
   - nessun file orfano (`npm run prune` in dry-run, se disponibile).
8. Nuovo setup e stampa del Kit, sulla chiave root nuova. Verificare `rootKeyRetired:false`.
9. **SQL di annullo di emergenza**, se il backend viene riportato indietro durante l'attesa. La lancia l'utente, in una transazione:
   - `UPDATE "VaultKeyring" SET status='READY',"resetScheduledAt"=NULL WHERE "userId"=$1 AND status='RESET_PENDING';`
   - `UPDATE "VaultRequest" SET status='CANCELLED',"cancelledAt"=now() WHERE "userId"=$1 AND type='RESET' AND status='WAITING';`

## 9. File da toccare

Nessun file TIER 1 o TIER 2. Sono più di 3 file, quindi l'utente va avvisato prima di procedere.

**Backend:**
- nuovo `backend/src/services/vaultReset.service.ts`: challenge, conferma, annullo, `runResetJobs`, conteggi;
- `backend/src/services/vaultRecovery.service.ts`:
  - chiamata da `runRecoveryJobs`;
  - `type` nella lista e nel dettaglio admin;
  - export di `newCode` e `codeHash`;
- `backend/src/services/vault.service.ts`: `lastResetEpoch` in `getKeyring`;
- `backend/src/routes/vault.ts`;
- `backend/src/routes/vaultAdmin.ts`;
- `backend/src/routes/vaultE2e.ts`;
- `backend/src/services/vaultRecoveryNotify.ts`;
- `backend/src/utils/notificationI18n.ts`.

**Frontend:**
- `frontend/src/lib/vaultApi.ts`: 3 chiamate nuove e `lastResetEpoch` in `okKeyring`;
- `frontend/src/lib/vaultSession.ts`: `syncKeyringCache` e il tipo `KeyringDto`;
- nuovo `frontend/src/features/vault/VaultResetDialog.tsx`:
  - bottom sheet su mobile, con `ConfirmDialog` per il passo finale;
  - varianti `dark:`;
  - target da 44px;
- `VaultPage.tsx`: Gate e `loadKeyring`;
- `VaultUnlock.tsx`: ingresso "PIN e Kit persi";
- `VaultSettingsSheet.tsx`: ingresso a vault sbloccato;
- `VaultRecovery.tsx` e `recoveryOutcome.ts`: rimando al reset quando il recupero non è possibile;
- `frontend/src/hooks/useOpenRecovery.ts`;
- nuovo `components/vault/ResetPendingBanner.tsx`, montato in `components/layout/AppLayout.tsx`;
- `features/admin/tabs/VaultRecoveryTab.tsx`: filtro RESET e annullo;
- `NotificationItem.tsx`;
- `en.json` e `it.json`;
- al momento della release: `frontend/package.json` (1.16.0) e changelog.

**Documentazione:**
- design §4, aggiornato con le deviazioni: stato `WAITING`, `lastResetEpoch`, annullo dell'admin, annullo senza password;
- `CLAUDE.md`: riga del Vault, con P3 fatto;
- runbook nella skill `notiq-deploy`.

**Fuori scope:**
- reset delle note vault legacy pre-v3 senza keyring (si cancellano a mano);
- reset avviato dall'admin;
- cancellazione immediata;
- promemoria 24 h prima del job;
- link di annullo senza login.

## 10. Decisioni aperte

| # | Domanda | Raccomandata | Scartata e perché |
|---|---------|--------------|-------------------|
| D1 | Chi avvia | Solo l'utente, con password | Avvio dall'admin: distrugge dati E2EE senza il segreto dell'utente. Approvazione dell'admin: con un solo admin diventa un'autoapprovazione di facciata, e l'admin non può verificare niente |
| D2 | Ruolo dell'admin | Avvisato su scheduled, cancelled e completed; può annullare | Nessun ruolo: un attaccante può cambiare la password via email e la vittima perde il JWT (`tokenVersion`); l'annullo dell'admin è l'unica difesa rapida |
| D3 | Conferma | Codice di sistema da 12 caratteri più password (design §4) | Riscrivere l'email: più semplice, ma senza scadenza né tentativi lato server, e senza traccia `PENDING_CODE` |
| D4 | Annullo | Basta il JWT, senza password | Password richiesta: una vittima a cui l'attaccante ha cambiato la password non potrebbe annullare |
| D5 | Attesa al primo uso (SUPERADMIN) | 7 giorni pieni, così il job si prova nel suo percorso vero | SQL che anticipa `resetScheduledAt`: SQL a mano in prod, e il job non viene provato nei tempi reali |
| D6 | Stato "reset avvenuto" per il client | `lastResetEpoch` letto da AuditLog | Colonna `resetEpoch`: migration su `schema.prisma` (TIER 1) per un solo intero |
| D7 | Destino delle RECOVERY aperte | Annullate alla conferma del reset | Annullate al job: per 7 giorni convivrebbero due cerimonie |
| D8 | Nascondere le note vault nel `GET /notes` durante l'attesa | No: le nasconde il client, perché il vault è bloccato | Sì: `syncPull` le cancellerebbe in locale, e un annullo richiederebbe di riscaricare tutto |
| D9 | Promemoria prima del job | No | Sì: un job e dei testi in più; bastano l'email iniziale e il banner |
| D10 | Versione | 1.16.0 | 1.15.2: è una funzione nuova, non un fix |

## 11. Rischi

- `lastResetEpoch` dipende da AuditLog. Uno script che cancella gli audit (`reset-db-except-superadmin.ts`, solo in dev) toglie solo il purge esplicito sul client, non la sicurezza: il server rifiuta comunque le scritture vecchie.
- Un dispositivo rimasto offline più di 7 giorni con modifiche vault non sincronizzate le perde. È voluto, perché il reset è distruttivo, e va scritto nel testo del dialog.
- L'unlink dei file avviene dopo il commit. Se fallisce restano file orfani, non dati raggiungibili.
- `syncKeyringCache` oggi è sincrona e gira anche durante `rotating`. Il purge va escluso quando `rotating` è true, per non scambiare una rotazione locale per un reset.
- Non ancora verificato:
  - se in prod ci sono altri SUPERADMIN, e il valore di `VAULT_SETUP_USERS`;
  - se `ConfirmDialog` accetta un campo di input; in caso contrario il dialog si costruisce sul primitive `Modal`, e `ConfirmDialog` resta solo per il passo finale.
