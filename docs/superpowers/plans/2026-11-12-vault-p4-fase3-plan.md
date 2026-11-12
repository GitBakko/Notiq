# Vault P4, Fase 3: client crittografico del recupero (piano, 12/11/2026)

Base: `feat/vault-p4` = `6c67bf3`. Piano dell'architect; gap G-A, G-B, G-C, G-D verificati a mano sul codice. Spec: `2026-09-30-vault-v3-design.md` (§2.2, §3.2, §5, §7, P4). Le righe citate si riferiscono a `6c67bf3`.

Scope: libreria e sessione client del recupero, senza pagine UI (Fase 4). Più le modifiche backend indispensabili (T1).

## 1. Approccio

- Funzioni pure nuove in `frontend/src/utils/vaultRecoveryCrypto.ts`; sessione in `frontend/src/lib/vaultRecovery.ts`. Si riusano le primitive già esportate da `vaultCrypto.ts` (`deriveRk`, `unwrapEscrow`, `importVk`, `unwrapVkSigKey`, `wrapEscrow`, `sealRootShare`, `wrapUserShare`, `deriveKekPin`, `wrapVkPin`, `deriveAuthKey`).
- Unico cambio TIER 1: `signVkProof` accetta l'endpoint firmato (§3).
- Parità Node ↔ WebCrypto con una fixture JSON generata da un test backend che usa le funzioni vere `sealRecoveryShare`, `sealRecoveryCode`, `rootReleaseMessage`.
- Scartati: copiare il formato del `vkProof` (due copie di un contratto firmato divergono); alzare `DB_VERSION` di `notiq-vault-device` (le schede col bundle vecchio riceverebbero `VersionError` e `saveDeviceShare` spegnerebbe lo sblocco offline, `vaultSession.ts:119-121`); esporre il vecchio `serverShare` in `RELEASED` (oracolo offline sul PIN vecchio, contro §3.5.1).

## 2. Task (TDD: test prima del codice)

### T1. Backend: gap G-A e G-B
- `backend/src/services/vault.service.ts`: esportare `sealServerShare` (`:127`).
- `backend/src/services/vaultRecovery.service.ts`: `recoveryCompletePayloadSchema` = `{rev, wrap: {…campi del wrap attuale…, serverShare: b64url(32)}, escrow}`, `wrap` ed `escrow` obbligatori, `rotate` vietato. `completeRecovery` (`:407-438`) lo usa e scrive anche `serverShareEnc = sealServerShare(userId, keyring.epoch, share)`. `getRecovery` (`:301-328`) aggiunge `escrowBlob` solo quando il seal è servibile (`RELEASED` non scaduta).
- `backend/src/routes/vault.ts:166`: `escrowBlob: toB64(r.escrowBlob)`.
- `keyringUpdatePayloadSchema` e `PUT /keyring` invariati.
- Test (`vaultRecovery.service.test.ts`, `vaultRecovery.route.test.ts`): complete senza `wrap.serverShare` → 400; con → `serverShareEnc` scritto e `openServerShare` restituisce gli stessi byte; `escrowBlob` solo in `RELEASED` non scaduta; payload dei test esistenti aggiornati.

### T2. Vettori di parità e chiave ECDSA root nel bundle (G-D)
- `frontend/src/utils/vaultRootKeys.ts`: `ecdsaSpki` in ogni voce, dopo `ecdhSpki` (la regex del test di parità vuole `ecdhSpki` per primo).
- `backend/src/__tests__/vaultRootKeys.parity.test.ts`: togliere il test «ecdsaSpki mai nel sorgente frontend» (`:47-49`, voluto in P2 quando il client non verificava firme), confrontare `{ecdhSpki, ecdsaSpki}`.
- Nuovi `backend/src/__tests__/vaultRecoveryVectors.test.ts` e fixture `frontend/src/utils/__tests__/fixtures/vaultRecoveryVectors.json`: `clientPkcs8`/`clientPubRaw` di TEST, `requestId`, `userId`, `sRootHex`, `codeA`, `sealedShare` (157 B), `sealedCode` (133 B), `fingerprint`, `notBefore`, `rootKeyId`, `ecdsaSpki` e `signature` (96 B) di una coppia ECDSA di test. `VAULT_VECTORS_WRITE=1` rigenera; in modalità normale il test verifica: le buste della fixture si aprono col layout di §4; buste nuove di `sealRecoveryShare`/`sealRecoveryCode` si aprono con lo stesso layout; `rootReleaseMessage(fixture)` verifica la firma; `fingerprintOf(clientPubRaw) === fingerprint`.

### T3. `utils/vaultRecoveryCrypto.ts` + diff TIER 1 di `signVkProof`
- API: `generateRecoveryKeyPair()` (ECDH P-384, privata non-extractable `['deriveBits']`, pubblica raw 97 B); `fingerprintOf(publicRaw)`; `openSealedCodeA(blob, priv, requestId, userId)`; `openRecoveryShare(blob, priv, requestId, userId)` → 32 B; `verifyRelease({rootShareForClient, signature, requestId, userId, notBefore, ownPubRaw, ecdsaSpki})` → boolean, mai eccezioni sui dati; `buildRecoveryPayload(...)` → `{payload, escrowHash, wrappedVkPinHash}`.
- Test (`frontend/src/utils/__tests__/vaultRecoveryCrypto.test.ts`, ambiente node): vettore FP `04|01..60` → `E7E0T7Q5`; privata non-extractable; buste della fixture aperte; `requestId`/`userId` diversi → `decryptFailed`; busta del codice data a `openRecoveryShare` e viceversa → `decryptFailed`; `verifyRelease` true sulla fixture e false con FP, `notBefore` (+1 ms), busta (1 byte), firma o SPKI diversi; codice A fuori alfabeto → errore.
- `vaultCrypto.test.ts`: `signVkProof` con l'endpoint del complete verificato da `node:crypto.verify` sul messaggio del server; default invariato; endpoint fuori pattern → `invalidInput`.

### T4. `deviceKeyStore.ts` e `vaultApi.ts` (D2: nessun cambio di versione)
- Chiave effimera in `deviceKeys` sotto `recovery:<userId>`: `{requestId|null, privateKey, publicRaw}`, scritta con `add`. `getRecoveryKey`, `addRecoveryKey`, `bindRecoveryKey`, `deleteRecoveryKey`.
- `PendingMarker` di tipo `recovery` sotto `<userId>:recovery`: `{requestId, payloadHash, escrowHash, kitConfirmed, payloadEnc}`, scritto con `add`. `removeDevice` cancella anche questi.
- `vaultApi.ts`: `createRecovery`, `getRecovery` (con `purgeVaultCache` nel `finally`), `confirmRecovery`, `completeRecovery`.
- Test: store e `DB_VERSION` invariati; chiave riletta non-extractable e usabile; secondo `add` → `ConstraintError`; `removeDevice` pulisce; `getDeviceKey` non restituisce mai la chiave di recupero; URL e metodi delle 4 chiamate.

### T5. `lib/vaultRecovery.ts`: richiesta, codice A, pulizia
- `startRecovery`: genera la coppia → `addRecoveryKey` (se fallisce, niente POST) → POST → FP del 201 diverso da quello locale → cancel ed errore → `bindRecoveryKey`. Rifiuto definitivo (4xx, 503) cancella la chiave; rete e 5xx no.
- `localRecovery`, `readCodeA` (null se non `PENDING_CODE`; `notThisDevice` senza chiave locale), `syncLocalRecovery` (cancella chiave e marker solo con 200 in `CANCELLED`/`REJECTED`/`EXPIRED` o 404 `recoveryNotFound`; mai su rete, 5xx o 401).
- Test per ogni ramo, con fakeIndexedDb e `vaultApi` mockata.

### T6. `lib/vaultRecovery.ts`: completamento e ripresa
- `prepareCompletion({userId, requestId, kit, newPin})` sotto il Web Lock `notiq-vault-recovery:<userId>` (exclusive, `ifAvailable`; occupato → `busy`): GET `/recovery/:id` (`RELEASED`, FP uguale al locale) → GET `/keyring` → `verifyRelease` con `VAULT_ROOT_KEYS[kr.rootKeyId].ecdsaSpki` (fallita → `releaseInvalid`, nessuna scrittura) → `openRecoveryShare` → Kit → RK → `unwrapEscrow` (errore → `kitInvalid`) → VK e chiave di firma → nuovo salt, nuovo `serverShare` (32 B), nuovi `S_root'`/`S_user'`, wrap con `DEFAULT_KDF`, escrow con `getActiveRootKey()` → **round-trip a runtime** (il nuovo wrap con il nuovo PIN e il nuovo escrow col nuovo Kit restituiscono la stessa VK) → `signVkProof(..., 'POST /api/vault/recovery/<id>/complete')` → `payloadEnc` (AES-GCM con la chiave del dispositivo, AAD `notiq/vault/v3/recovery-pending|<userId>|<requestId>`) → marker con `kitConfirmed: false` → restituisce il nuovo Kit alla UI. Al cambio utente → `discard`.
- `send()`: marker `kitConfirmed: true` → POST. Su 200: cache del keyring con `rev + 1` e `refreshKeyringCache`; `saveDeviceShare(newServerShare)` se lo sblocco offline è attivo, altrimenti `deleteShare`; sblocco dello store col nuovo PIN; `purgeApiCache`; cancella marker e chiave. Su 409 `staleRev`/`recoveryStateConflict`: confronta `escrowHash` del keyring con quello del marker (uguale → come 200; diverso → marker cancellato ed errore `newKitInvalid`). Rete o 5xx → marker tenuto, errore ambiguo. Buffer azzerati nel `finally`.
- `resumeRecovery(userId)` → `'none' | 'completed' | 'newKitInvalid' | 'busy' | 'unknown'`: `RELEASED` + `kitConfirmed` → rimanda la stessa stringa; `RELEASED` senza conferma → scarta (D3); `COMPLETED` con `escrowHash` uguale → `completed` (poi `deleteShare`, vault bloccato, si sblocca col nuovo PIN); `COMPLETED` con hash diverso, `EXPIRED`, `CANCELLED` → `newKitInvalid`; GET fallita → `unknown` senza cancellare nulla.
- Esportare da `vaultSession.ts` (non TIER) `cacheKeyring` e `saveDeviceShare`. i18n EN/IT: `vault.recovery.errors.{releaseInvalid,kitInvalid,notThisDevice,keyringChanged,busy,newKitInvalid}`.
- Test: flusso completo con keyring vero come nel setup, busta e firma fatte in Node con chiave di test, `vi.mock` di `vaultRootKeys`; nessuna POST dopo `prepare`; IDB grezzo senza `authKey`, `serverShare` né PIN; `vkProof` verificato con `node:crypto`; dimensioni del payload (escrow 60 B, share 157 B, `userShareUnderVk` 48 B); nuovo escrow e nuovo wrap danno la stessa VK; Kit vecchio sul nuovo escrow fallisce; firma o FP falsi → `releaseInvalid`; Kit errato → `kitInvalid`; 200 → store sbloccato, `rev + 1`, chiave e marker spariti; ogni ramo di `resumeRecovery`; lock occupato → `busy`.

### T7. Documentazione
Spec §3.2.2 (niente upgrade dell'IDB, chiavi `recovery:<userId>`), §3.2.7 passo 2 (il payload contiene `authKey` e `serverShare`, è cifrato con la chiave del dispositivo; regola `kitConfirmed`), §7.2 (`complete` con `wrap.serverShare`, `GET /recovery/:id` con `escrowBlob`); handoff della Fase 3.

Criterio globale: lint e `tsc` puliti nei due workspace, suite intere verdi. Gate: `vaultCrypto.ts` è TIER 1 → hardRisk → reviewer + red-team.

## 3. Diff TIER 1 (da approvare)

`frontend/src/utils/vaultCrypto.ts:196-202`:
```ts
-/** vkProof, 64 B (r||s, IEEE P1363 come richiede il backend). Path costante, rev <= 2147483646. */
-export async function signVkProof(sigKey: CryptoKey, userId: string, epoch: number, rev: number, payloadRaw: string) {
+/** vkProof, 64 B (r||s, IEEE P1363 come richiede il backend). `endpoint` = "METHOD path" firmato (default PUT del keyring); rev <= 2147483646. */
+export async function signVkProof(sigKey: CryptoKey, userId: string, epoch: number, rev: number, payloadRaw: string, endpoint = 'PUT /api/vault/keyring') {
   checkAad(userId, epoch);
   if (!Number.isInteger(rev) || rev < 0 || rev > 2147483646) throw fail('invalidInput');
-  const msg = `${P}proof|PUT /api/vault/keyring|${userId}|${epoch}|${rev}|${await sha256hex(payloadRaw)}`;
+  if (!/^(PUT|POST) \/api\/vault\/[A-Za-z0-9/_-]+$/.test(endpoint)) throw fail('invalidInput');
+  const msg = `${P}proof|${endpoint}|${userId}|${epoch}|${rev}|${await sha256hex(payloadRaw)}`;
```
I chiamanti esistenti restano invariati (default). Nessuna modifica a `vaultStore.ts`.

## 4. Contratti lato client

- **Busta verso il client** (`vaultRootKey.service.ts:38-58`): `ephPub(97) | iv(12) | ct | tag(16)` in b64url; ECDH P-384 (48 B) → HKDF-SHA256 (salt = `ephPub`, info utf8, 32 B) → AES-256-GCM (tag 128 bit, AAD utf8).
- **Share** (`:64-68`): ct 32 B, totale 157 B; info `notiq/vault/v3/recovery|<requestId>|<userId>`, AAD `notiq/vault/v3/recovery-share|<requestId>`.
- **Codice A** (`:71-76`): ct 8 B, totale 133 B; info `notiq/vault/v3/recovery-code|<requestId>|<userId>`, AAD `notiq/vault/v3/recovery-code|<requestId>`. Da `GET /recovery/:id` in `PENDING_CODE` o da `notification.data.sealedCodeA`.
- **Firma del rilascio** (`:78-81`, `:110-113`): messaggio `notiq/vault/v3/recovery-release|<requestId>|<userId>|<FP>|<notBefore ISO>|<sha256 hex dei 157 B>`, ECDSA P-384/SHA-256, IEEE P1363 (96 B); FP = quello proprio del client; `notBefore` normalizzato con `new Date(s).toISOString()`; chiave scelta con `kr.rootKeyId`.
- **FP** (`vaultRecovery.service.ts:18-23`): SHA-256 della pubblica raw, primi 5 byte (40 bit) in 8 simboli da 5 bit MSB-first, alfabeto `0123456789ABCDEFGHJKMNPQRSTVWXYZ`; vettore `vaultRecovery.service.test.ts:82-86`.
- **Complete**: body `{payload ≤65536, vkProof b64url(64)}`; proof `notiq/vault/v3/proof|POST /api/vault/recovery/<id>/complete|<userId>|<epoch>|<rev>|<sha256hex(payload)>` (`vault.service.ts:94`); payload (dopo T1) `{rev, wrap:{kdf, kdfParams (m≥65536, t≥10, p=1), pinSalt16, wrappedVkPin60, authKey32, serverShare32}, escrow:{escrowBlob60, sealedRootShare157, rootKeyId, userShareUnderVk48}}`; `rev` = rev del keyring (CAS); stesso payload su `COMPLETED` → 200, diverso → 409; il client confronta `escrowHash` di `GET /keyring`. Escrow AAD `escrow|<userId>|<epoch>|<rootKeyId>` (`vaultCrypto.ts:261`); RK = HKDF(`S_root ‖ S_user`, salt vuoto, `notiq/vault/v3/escrow|<userId>`) (`:301-309`).

## 5. Gap e divergenze
- **G-A (bloccante, verificato):** la KEK è `HKDF(S ‖ serverShare)` (`vaultCrypto.ts:115-118`), `serverShare` esce solo da `POST /unlock` col PIN vecchio, e `complete` aggiorna solo `authVerifier` (`vaultRecovery.service.ts:430`). → T1 con rotazione di `serverShare`.
- **G-B (bloccante, verificato):** `escrowBlob` non arriva mai al client (`vault.service.ts:181`). → T1.
- **G-C (verificato):** `signVkProof` firma sempre `PUT /api/vault/keyring` (`vaultCrypto.ts:200`). → diff TIER 1 di §3.
- **G-D (verificato):** chiave ECDSA root assente dal bundle e vietata dal test di parità (`:47-49`), mentre la spec (riga 70, §3.2.7) la vuole. → T2.
- **G-E:** la spec §3.2.7 passo 2 dice «solo ciphertext e una firma», ma il payload contiene `authKey` (e, dopo T1, `serverShare`): con `pinSalt` danno un oracolo offline sul nuovo PIN, e `authKey` è una credenziale per `POST /unlock`. → correggere la spec (D1).
- **G-F:** l'upgrade «additivo» dell'IDB provoca `VersionError` nei bundle vecchi. → D2.
- **G-G:** `complete` non restituisce `rev`: il client usa `kr.rev + 1` e poi `refreshKeyringCache`.
- **G-I (backlog):** dopo il recupero gli altri dispositivi hanno uno `shareEnc` col `serverShare` vecchio: lo sblocco offline col nuovo PIN fallisce come `wrongPin` finché non fanno uno sblocco online. Da scrivere nell'email/notifica `completed`.

## 6. Decisioni (approvate dall'utente il 12/11/2026, insieme al diff TIER 1 della §3)
- **D1** Payload persistito per la ripresa cifrato con la chiave AES non-extractable del dispositivo (stessa protezione dello `shareEnc`), cancellato a ogni esito. Alternativa: solo hash, e in `RELEASED` la ripresa rifà la cerimonia con un Kit nuovo. Raccomandato D1.
- **D2** Nessun cambio di `DB_VERSION` di `notiq-vault-device`: chiave effimera in `deviceKeys`, marker in `pending`. Raccomandato.
- **D3** La ripresa rimanda il payload solo se `kitConfirmed` (l'utente ha confermato di aver salvato il nuovo Kit); altrimenti scarta e vale il Kit precedente. Raccomandato.
- **D4** Approvare la modifica backend T1 in questa fase (senza, la Fase 3 non si completa) e la chiave ECDSA root pubblica nel bundle (T2).

## 7. Rischi e mitigazioni
- Perdita del vault: round-trip del nuovo wrap e del nuovo escrow fino alla stessa VK, nei test e a runtime prima di mostrare il Kit.
- Kit vecchio o nuovo: il vecchio smette di valere solo al commit di `complete`; esiti ambigui tengono il marker; esiti definitivi dicono quale Kit vale (confronto `escrowHash`).
- Più schede: Web Lock + marker create-only; il server accetta un solo payload (CAS su `rev`, `RELEASED → COMPLETED`).
- Più dispositivi: VK ed epoch invariate; effetti su `shareEnc` in G-I.
- Scheda chiusa a metà, logout a metà: D1, D3, idempotenza del server, `discard` che azzera i buffer.
- Safari/iOS: ITP può cancellare lo storage dopo 7 giorni senza visite (il recupero dura ≥ 72 h + approvazione): senza chiave locale la UI di Fase 4 propone «annulla e rifai» (le annullate non contano nella quota). ECDSA P-384 su WebKit da provare in Fase 5.
- Fase 5: l'E2E richiede una chiave root di test nel bundle e mai in prod; manca il meccanismo di build.

## 8. Esito della revisione del blocco D (T1-T2) e requisiti aggiunti

Reviewer e red-team sul blocco D: nessun BLOCKER/MAJOR/CRITICAL/HIGH. Corretti nel giro 1: messaggio firmato e FP fissati a mano nel test dei vettori; `getRecovery` con una sola lettura coerente ed `escrowBlob` solo con keyring `READY`; `PUT /keyring` con `escrow` rifiutato (409 `recoveryInProgress`) mentre c'è un rilascio `RELEASED` aperto; `.strict()` anche su `wrap` ed `escrow` del `complete`; `payload` nella redaction dei log.

Requisiti aggiunti:
- **Blocco E2 (T6), dal red-team.** `vaultSession.ts:~418-425` (`changePin`): al 409 `staleRev` oggi rimanda lo stesso `wrap`, costruito col `serverShare` letto prima. Se nel frattempo un altro dispositivo ha completato un recupero (che ruota `serverShare`), il server accetta il wrap vecchio e da quel momento nessun PIN apre più il vault. Fix: al 409 rifare `openKeyring(currentPin)` e ricostruire il wrap; dopo un recupero il PIN vecchio dà `wrongPin` e il cambio si ferma. Test dedicato.
- **Fase 4, dal red-team.** Dopo un rilascio poi annullato o scaduto, chi ha ottenuto `S_root` ed `escrowBlob` (attaccante con JWT e mailbox che ha superato le 72 ore) ha bisogno solo del Kit per ricavare la VK offline, in futuro e senza procedura. Mitigazione da progettare in Fase 4: dopo una transizione `RELEASED → CANCELLED/EXPIRED`, `GET /keyring` segnala che il Kit va rigenerato e la UI, al primo sblocco, impone la rigenerazione (nuovo `S_root`, nuovo escrow) con un avviso. Fino ad allora è un residuo noto.
- **Accettato.** Il ramo idempotente del `complete` risponde 200 senza verificare il `vkProof`: richiede il payload byte-identico, che contiene 32 byte casuali di `serverShare`.
