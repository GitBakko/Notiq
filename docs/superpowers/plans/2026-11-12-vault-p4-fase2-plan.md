# Vault P4, Fase 2: piano di implementazione (12/11/2026)

Base: `feat/vault-p4` = `6d31471`. Piano dell'architect, gap G1–G3 verificati a mano sul codice. Le righe citate si riferiscono a `6d31471`.
Spec: `2026-09-30-vault-v3-design.md` §3 (righe 101-195), §7 (da 340), P4 (562-584). Handoff: `2026-11-01-vault-p4-fase2-handoff.md`.

## 1. Approccio

- Route utente nel plugin esistente `backend/src/routes/vault.ts` (auth, `no-store`, error handler, pepper e rate limit per utente già presenti).
- Route admin in un nuovo `backend/src/routes/vaultAdmin.ts`, registrato **dentro** `admin.ts` con `fastify.register(..., { prefix: '/vault-recovery' })`: eredita l'`onRequest` authenticate e `app.ts` non cambia per le route.
- Notifiche ed email in un nuovo `services/vaultRecoveryNotify.ts` che non lancia mai. In `email.service.ts` solo un case generico con escape.
- Guardia notifiche: "se l'utente ha una richiesta aperta, escludi `type=VAULT_RECOVERY`" (il service ammette al massimo una richiesta aperta). Nessun join JSON per notifica.

## 2. Task (ordinati, ognuno committabile; TDD: test prima del codice)

### T1. Correzioni Fase 1 (`vaultRecovery.service.ts`, `vaultRootKey.service.ts`)
Test in `backend/src/__tests__/vaultRecovery.service.test.ts` e `vaultRootKey.service.test.ts`.
- **G1** `fingerprintOf` a 40 bit (8 caratteri tutti variabili). Test: su 200 chiavi l'8° carattere non è sempre `'0'`; vettore fisso pubKey → FP (lo riuserà il client in Fase 3).
- **G2/G8** `approveRecovery` scrive `codeAHash`/`codeBHash` nella stessa `updateMany` della transizione e ritorna solo `{status:'PENDING_CODE'}`; i codici li recapita il service (T3). Test: `findUnique` dopo l'approve vede gli hash; il ritorno non ha `codeA`/`codeB`. I test che leggono i codici dal ritorno li leggono dal mock di notify.
- **G3** al 5° errore `confirmRecovery` fa `updateMany where {id, status:'PENDING_CODE'}`. Test: con la richiesta già `WAITING` l'errore non la porta in `EXPIRED`.
- **G4** `createRecoveryRequest` richiede un keyring `READY` con `sealedRootShare` e `rootKeyId`, altrimenti 409 `errors.vault.recoveryNoKeyring`. Test: utente senza keyring → 409, nessuna riga creata.
- **G5** `completeRecovery` richiede sia `wrap` sia `escrow` (spec §3.2.7, §7.2), altrimenti 400. Test: payload solo-wrap → 400.
- **G7** `getRecovery` restituisce il seal solo se `releaseExpiresAt > now`. Test: clock oltre `releaseExpiresAt`, stato ancora `RELEASED` → `rootShareForClient` null.
- **G6** `releaseRecovery` scrive `release_failed` solo per `invalidRootPassphrase` (403); 503 e 400 non contano. Test: con `VAULT_ROOT_KEY_PATH` assente il contatore resta 0.
- **G11** dopo la firma del rilascio, `crypto.verify` con `VAULT_ROOT_KEYS[rootKeyId]` prima di salvare (spec §3.2.6, §7.2).
- Nuova `sealRecoveryCode(codeA, clientEphPub, requestId, userId): Buffer` in `vaultRootKey.service.ts`, con helper privato `sealToClient(plain, pub, info, aad)` condiviso con `sealRecoveryShare`. **Contratto per la Fase 3:** blob = `ephPub(97) | iv(12) | ct(8) | tag(16)` = 133 byte; HKDF-SHA256 salt = `ephPub`, info = `notiq/vault/v3/recovery-code|${requestId}|${userId}`; AAD = `notiq/vault/v3/recovery-code|${requestId}`. Test: round-trip con la privata del client; AAD con altro requestId fallisce; blob di share e di code non intercambiabili.
- Decisione U4: `complete` azzera `failedAttempts`/`lockedUntil` del keyring.
- Criterio: `cd backend; npx vitest run src/__tests__/vaultRecovery.service.test.ts src/__tests__/vaultRootKey.service.test.ts` verde.

### T2. Nuove API del service (`vaultRecovery.service.ts`)
- `rejectRecovery(adminId, id, reason)`: `updateMany` PENDING_APPROVAL → REJECTED, `rejectReason` tagliato a 500; altro stato → 409.
- `getOpenRecovery(userId)` → `{id, status, fingerprint, createdAt, notBefore} | null`.
- `listRecoveriesForAdmin({page, limit, status?, userId?})` e `getRecoveryForAdmin(id)` (shape in §3; il dettaglio aggiunge `audit` = AuditLog con `details.requestId = id` ordinato per `createdAt`).
- `getRecovery` aggiunge `sealedCodeA` solo in `PENDING_CODE`, letto dalla notifica (`type VAULT_RECOVERY`, `data.requestId = id`, `data.event = 'code'`): **G9**, `VaultRequest` non ha la colonna, nessuna migration.
- Test: lista e dettaglio non contengono mai `codeAHash`, `codeBHash`, `clientEphPub`, `rootShareForClient`, `rootSignature` (assert sulle chiavi). Coprire il filtro JSON path di Prisma 7 su `details`/`data`.

### T3. Notifiche ed email per transizione
File: nuovo `services/vaultRecoveryNotify.ts`; `email.service.ts` (TIER 2, diff in §4); `notification.service.ts` (`'VAULT_RECOVERY'` nella union di `createNotification`, riga 11); `utils/notificationI18n.ts` (testi push EN/IT generici); chiamate da `vaultRecovery.service.ts`.
- `notifyRecovery(userId, event: RecoveryEvent, args: {requestId, fingerprint?, notBefore?, codeB?, sealedCodeA?, reason?}): Promise<void>`.
- `notifySuperadmins(event: 'releaseFailed' | 'selfAction', args: {requestId, adminEmail}): Promise<void>`.
- Entrambe try/catch con `logger.error({err, requestId})`, mai gli args nel log.
- `RecoveryEvent` = `requested | code | codeFailed | waiting | reminder | released | completed | cancelled | rejected | expired`.
- Notifica: `data = {localizationKey:'notifications.vaultRecovery.<event>', localizationArgs:{fingerprint?}, requestId, event, sealedCodeA?}`. **`codeB` solo nell'email, mai in `data`.**
- Email: testi EN/IT risolti nel modulo in base a `user.locale`, poi `sendNotificationEmail(email, 'VAULT_RECOVERY', {title, body, cta, codeB?})`.
- Audit nuovo: `vault.recovery.code_sent` con `{requestId, emailOk, notificationOk}` (senza codici) e `vault.recovery.rejected`.
- Test in `backend/src/__tests__/vaultRecoveryNotify.test.ts`: una sola email con `codeB`; la notifica ha `sealedCodeA` (133 byte b64url) e non `codeB`; errore SMTP non lancia. In `email.service.test.ts`: `VAULT_RECOVERY` parte anche con `emailNotificationsEnabled=false` (transazionale) e fa escape di `<script>` in title e body. Nei test del service: ogni transizione chiama notify con l'evento giusto; approve → `code`, `codeA` ricavabile solo aprendo il seal.

### T4. Guardia notifiche (`notification.service.ts`)
- Helper privato `recoveryGuard(userId): Promise<Prisma.NotificationWhereInput>` → `{ NOT: { type: 'VAULT_RECOVERY' } }` se esiste una richiesta RECOVERY in `PENDING_APPROVAL | PENDING_CODE | WAITING | RELEASED`, altrimenti `{}`. Lista duplicata con commento («= OPEN_STATES di vaultRecovery.service; import evitato per il ciclo notify↔notification»).
- Applicata a `markAllNotificationsAsRead`, `deleteNotification`, `deleteAllNotifications`. Route invariate.
- Test (`services/__tests__/notification.service.test.ts`, `routes/__tests__/notification.route.test.ts`): con richiesta aperta `DELETE /api/notifications/all` lascia la `VAULT_RECOVERY` e cancella le altre; idem `DELETE /:id` e `PUT /read-all`; con richiesta `CANCELLED` la cancellazione riesce.

### T5. Route utente (`backend/src/routes/vault.ts`)
Test in nuovo `routes/__tests__/vaultRecovery.route.test.ts` (mock di `vaultRecovery.service` come in `vault.route.test.ts`).
- `GET /keyring` → `{...getKeyring(id), openRecovery: await getOpenRecovery(id)}`; aggiornare il mock di `vault.route.test.ts`.
- `POST /recovery` `{clientEphPub: b64url(97), reason?: ≤500}` → 201 `{id, fingerprint}`; `limit(3,'1 hour')`; ip = `request.ip`, UA troncato dal service.
- `GET /recovery/:id` (uuid) → `{status, fingerprint, notBefore, releaseExpiresAt, sealedCodeA|null, rootShareForClient|null, rootSignature|null}` in b64url; `limit(60,'1 minute')`.
- `POST /recovery/:id/confirm` `{codeA, codeB}` entrambi `/^[0-9A-HJKMNP-TV-Z]{8}$/` → `{status, notBefore}`; `limit(5,'15 minutes')`.
- `DELETE /recovery/:id` → `{status:'CANCELLED'}`; `limit(10,'1 minute')`.
- `POST /recovery/:id/complete` `{payload ≤65536, vkProof: b64url(64)}` → `{status, idempotent}`; `limit(10,'1 hour')`. Path esattamente `/api/vault/recovery/:id/complete`: `verifyVkProof` firma quella stringa (`vaultRecovery.service.ts:198`).
- Test: Zod KO → 400 `errors.vault.invalidPayload` senza issues; `Cache-Control: no-store` su 200 e 4xx; 6ª `confirm` in 15 min → 429; id non uuid → 400; sentinella nei codici assente dai log catturati (pattern `SECRET` di `vault.route.test.ts:32`).

### T6. Route admin (nuovo `routes/vaultAdmin.ts` + una riga in `admin.ts`)
Test in nuovo `routes/__tests__/vaultAdmin.route.test.ts`.
- Hook nell'ordine: 1) `preHandler` ruolo letto dal **DB** (come `admin.ts:34-37`, non dal JWT) → 403 `errors.common.forbidden`; 2) pepper → 503; 3) `onSend` `no-store`; 4) stesso `setErrorHandler` di `vault.ts:76-81`.
- `GET /` `?page&limit≤100&status&userId`, `GET /:id`.
- `POST /:id/approve` → `{status:'PENDING_CODE'}`; `limit(30,'1 minute')`.
- `POST /:id/reject` `{reason 1..500}` → `{status:'REJECTED'}`.
- `POST /:id/release` `{passphrase 1..1024}` → `{status:'RELEASED'}`; `limit(3,'15 minutes')` per admin (il contatore DB resta la difesa che sopravvive al restart). `notifySuperadmins('releaseFailed')` su `invalidRootPassphrase` e `notifySuperadmins('selfAction')` li chiama il service (blocco A1), non la route.
- Decisione U3: approve/release della **propria** richiesta consentiti, con `details.self: true` nell'audit e email agli altri SUPERADMIN (`notifySuperadmins('selfAction')`).
- Test: utente con JWT `role:'SUPERADMIN'` falsificato ma ruolo DB USER → 403; body di approve con esattamente le chiavi `['status']`; passphrase sentinella mai in log né risposte; nessun campo segreto in lista.

### T7. Job delle scadenze (`vaultRecovery.service.ts` + `app.ts` TIER 2)
- `expireRecoveryRequests(now)`: `findMany` dei candidati, poi `updateMany` condizionata **per riga**; se `count===1` → `logEvent('vault.recovery.expired')` + `notifyRecovery('expired')`. Ritorna il conteggio. Un `RELEASED` scaduto ha il seal azzerato. (**G10**)
- `sendRecoveryReminders(now)`: richieste `WAITING` con `notBefore ∈ (now, now+24h]` senza riga AuditLog `vault.recovery.reminder_sent` per quel requestId → notify `reminder` + `logEvent` (decisione U2).
- `runRecoveryJobs()` esegue le due in sequenza; timer `setInterval` 15 min in `app.ts` (decisione U1, diff in §4).
- Da chiarire in T7 (emerso nel blocco A1): dopo `confirm` una richiesta `WAITING` conserva l'`expiresAt` dello stadio codice (24 h), e `getOpenRecovery` non filtra a lettura le richieste scadute non ancora marcate dal job. Va definita la scadenza di `WAITING` secondo la spec (§3.2.5, §3.3) e aggiunto il filtro a lettura, così il banner sparisce subito alla scadenza.
- Test con clock finto: due run consecutive → una sola email `expired` e una sola `reminder`.

### T8. Banner frontend
File: nuovo `frontend/src/hooks/useOpenRecovery.ts`; nuovo `frontend/src/components/vault/RecoveryBanner.tsx`; `components/layout/AppLayout.tsx` (`<RecoveryBanner />` prima di `<AnnouncementBanner />`, riga 97); `lib/vaultApi.ts` (`export interface OpenRecovery {id; status; fingerprint; createdAt; notBefore: string|null}`, `cancelRecovery(id)`, `'delete'` nella union di `call()`); `features/notifications/NotificationItem.tsx` (case `VAULT_RECOVERY` → `/vault`); `locales/en.json` e `it.json` (`vault.recoveryBanner.*`, `notifications.vaultRecovery.*`, `errors.vault.recovery*`, `recoveryNoKeyring`).
- Hook: `getKeyring` al mount, su `focus`, su `visibilitychange` (visibile) e ogni 15 min; su errore di rete o 503 **tiene l'ultimo valore**.
- Banner senza pulsante di chiusura, `role="status"`, testo per stato con FP, `notBefore` locale e ore residue. "Annulla" → `ConfirmDialog` (mai `confirm()`) → `cancelRecovery` → refresh. Bottone ≥44 px, varianti `dark:`.
- Test: `hooks/__tests__/useOpenRecovery.test.ts` (mount, focus, timer 15 min con fake timers, errore che non azzera); `components/vault/__tests__/RecoveryBanner.test.tsx` (nessun pulsante di chiusura; Annulla → dialog → `cancelRecovery(id)`; `openRecovery` null → niente render).
- Criteri: vitest dei due file; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; parità chiavi en/it.

### T9. Documentazione
Design §3.2.4: contratto di `sealRecoveryCode` e FP a 40 bit. Handoff: Fase 2 fatta.

### Criterio globale
`cd backend; npx vitest run` → baseline più i test nuovi, tutti verdi; `npm run build`; `npm run lint`. E2E da rieseguire: `frontend/e2e/vault*.spec.ts` (il banner gira in AppLayout).

## 3. Shape admin (nessun segreto)
- Lista: `{id, userId, userEmail, status, fingerprint, reason, requestIp, requestUserAgent, createdAt, expiresAt, notBefore, approvedById, approvedAt, rejectReason, releasedById, releasedAt, releaseExpiresAt, completedAt, cancelledAt, keyringStatus, rootKeyId, readyForRelease: status==='WAITING' && notBefore<=now}`.
- Dettaglio: gli stessi campi + `audit[{event, userId, createdAt, details}]`.

## 4. Diff TIER 2 (da approvare prima di applicarli)

### `backend/src/app.ts`
Dopo la riga 313 (`import { archiveCompletedCards } from './services/kanban/card.service';`):
```ts
+import { runRecoveryJobs } from './services/vaultRecovery.service';
```
Dopo la riga 359 (`if (archiveTimer.unref) archiveTimer.unref(); // never hold the process open`):
```ts
+
+    // Vault recovery: expiries (approval 7d, code 24h, release 7d) and the reminder 24h before notBefore.
+    // Same unref'd setInterval as above: every transition is a conditional updateMany and the reminder is
+    // deduplicated by an AuditLog marker, so overlapping workers converge. Expiry is also enforced at read time.
+    const recoveryTimer = setInterval(() => {
+      runRecoveryJobs().catch((err) =>
+        server.log.error({ err }, 'Scheduled vault recovery job failed')
+      );
+    }, 15 * 60 * 1000);
+    if (recoveryTimer.unref) recoveryTimer.unref();
```
Dopo la riga 364 (`server.log.info('Kanban archive job scheduled (hourly)');`):
```ts
+    server.log.info('Vault recovery job scheduled (every 15 min)');
```
Il commento di `app.ts:349-353` ("scheduler vero se compare un secondo job") va aggiornato per dire perché due job su `setInterval` restano accettabili.

### `backend/src/services/email.service.ts`
Riga 61: `| 'VAULT_LOCKOUT';` → `| 'VAULT_LOCKOUT' | 'VAULT_RECOVERY';`
Riga 66: aggiungere `'VAULT_RECOVERY',` dopo `'VAULT_LOCKOUT',` (tipi transazionali, inviati anche con le email di notifica disattivate).
Dopo la riga 508 (fine del case `VAULT_LOCKOUT`), prima della `}` dello switch:
```ts
+    case 'VAULT_RECOVERY': {
+      // Texts already localized by vaultRecoveryNotify.ts (EN/IT); here only escaping and layout.
+      if (!data.title) break;
+      const codeB = data.codeB
+        ? `<p style="font-size: 1.4em; letter-spacing: 3px;"><strong>${escapeHtml(data.codeB)}</strong></p>`
+        : '';
+      subject = `${escapeHtml(data.title)} - Notiq`;
+      html = `
+        <div style="font-family: sans-serif; padding: 20px;">
+          <h2>${escapeHtml(data.title)}</h2>
+          <p>${escapeHtml(data.body || '')}</p>
+          ${codeB}
+          <p><a href="${FRONTEND_URL}/vault" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">${escapeHtml(data.cta || 'Notiq')}</a></p>
+        </div>
+      `;
+      break;
+    }
```

## 5. Gap rispetto alla spec (Fase 1)
- **G1** `vaultRecovery.service.ts:14-23`: FP da 32 bit in 8 cifre base32 (8ª sempre `'0'`); la spec §3.2.2 vuole 40 bit. Verificato. Va corretto prima della Fase 3 (l'FP è firmato e confrontato dal client). In prod non esistono righe.
- **G2** `:65-73`: transizione a `PENDING_CODE` e hash in due statement; un crash in mezzo lascia una riga senza hash e `timingSafeEqual` su lunghezze diverse lancia RangeError (500). Verificato.
- **G3** `:89`: `update` incondizionato a `EXPIRED`, viola §3.3 «tutte condizionate». Verificato.
- **G4** `:41-46`: nessun controllo di keyring `READY` con escrow.
- **G5** `:188`: `complete` accetta `wrap`/`escrow` opzionali; la spec li vuole obbligatori.
- **G6** `:141`: ogni errore del rilascio conta come `release_failed`; manca l'email ai SUPERADMIN.
- **G7** `:172-173`: seal servito oltre `releaseExpiresAt` finché il job non gira.
- **G8** `:75`: `approveRecovery` restituisce i codici in chiaro al chiamante.
- **G9** `VaultRequest` senza colonna per `sealedCodeA`: letta da `Notification.data` (§7.1), protetta dalla guardia T4.
- **G10** `:228-233`: scadenze senza `.expired` né email; manca il promemoria a 24 h.
- **G11** `vaultRootKey.service.ts:64-70`: firma senza verifica con la chiave pubblica fissata.
- **G12** spec §7.2: `vaultAdmin.ts` registrato da `admin.ts` invece che da `app.ts`.

## 6. Decisioni (approvate dall'utente il 12/11/2026, insieme ai diff TIER 2 della §4)
- **U1** Secondo job periodico su `setInterval` ogni 15 min, senza scheduler nuovo.
- **U2** Dedup del promemoria con riga marker `vault.recovery.reminder_sent` in AuditLog.
- **U3** Self-approve/self-release del SUPERADMIN consentiti, con `details.self: true` ed email agli altri SUPERADMIN.
- **U4** `complete` azzera `failedAttempts`/`lockedUntil`.
- **U5** Metà B non consegnata (SMTP giù): nessun retry; audit `code_sent{emailOk:false}`, la richiesta scade in 24 h.

## 7. Rischi e mitigazioni
- Segreti nei log: `REDACT_PATHS` copre `passphrase`, `codeA`, `codeB` (`utils/logger.ts:3`); notify logga solo `requestId`; test con sentinelle.
- Enumerazione: route utente filtrate per `userId`; id altrui indistinguibile da inesistente; admin con ruolo dal DB.
- Concorrenza: transizioni condizionate; `attempts < 5` in `updateMany`. Release parallele con passphrase errate possono superare 3 tentativi prima del conteggio DB: le ferma il rate limit di route (in memoria). Rischio residuo accettato.
- TOCTOU della guardia notifiche: la difesa vera è il banner da `GET /keyring` (§3.2.2).
- Pepper assente: tutto `/api/vault/*` risponde 503, niente banner, recupero comunque impossibile; l'hook tiene l'ultimo valore.
- Push: `data` finisce nel payload push (`notification.service.ts:44`); contiene `sealedCodeA` (ciphertext per `clientEphPub`), mai `codeB`.
- Idempotenza: email di scadenza e promemoria solo su `count===1` o dopo il controllo del marker.
- Gate: `app.ts` ed `email.service.ts` sono TIER 2, quindi hardRisk → reviewer + red-team.

## 8. Esito del blocco A (T1-T3) e residui da chiudere nei blocchi B e C

Blocco A committato dopo reviewer (2 giri) e red-team: nessun BLOCKER/MAJOR/CRITICAL/HIGH aperto. Correzioni F1-F10 del primo giro: errori del rilascio separati (solo la passphrase errata conta), lock consultivo per utente sulla create (verificato su Postgres reale), notifiche in background e timeout web-push 10 s, quota senza le `EXPIRED` per tentativi esauriti (spec §3.3 aggiornata), controllo del fingerprint prima del rilascio, punto P-384 validato alla create, `confirm` 404/410/409, audit ed email `expired` al 5° errore, motivo del rifiuto nell'email, fingerprint nei testi `requested`/`waiting`.

Residui:
- **Blocco B.** `utils/vaultRootKeyFile.ts:111-128`: un file root leggibile ma malformato (JSON, `v`/`kdf`, `kdfParams`, ids) finisce nel 403 `invalidRootPassphrase` contato. Validare l'header fuori dal catch della passphrase → 503 `rootKeyUnavailable`; solo il fallimento del tag GCM resta 403. Test con un file JSON valido ma di forma sbagliata.
- **Blocco C (T8).** `frontend/src/features/notifications/NotificationItem.tsx:83-140`: `buildArgs` non passa `fingerprint` da `data.localizationArgs`, quindi il testo ripiega sul `message` del server nella lingua di `user.locale`. Aggiungere `fingerprint` agli args, con test.
- **Blocco B (T7).** Scadenza di `WAITING` e filtro a lettura di `getOpenRecovery` (vedi T7).
- Al 5° codice errato l'utente riceve sia `codeFailed` sia `expired`: accettato.
