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

## 9. Revisione del blocco E (client) e modello della cerimonia

Reviewer (2 MAJOR) e red-team (1 HIGH con PoC) hanno trovato lo stesso difetto di fondo: la cerimonia di completamento non aveva identità e non teneva il lock tra `prepareCompletion` e `send`, quindi con due cerimonie l'utente poteva confermare il Kit 1 mentre il server riceveva il payload del Kit 2. Modello adottato nel giro di correzioni 1:
- il Web Lock `notiq-vault-recovery:<userId>` resta tenuto da `prepare` fino a `send`/`discard` (il browser lo rilascia alla chiusura della scheda); seconde `prepare` e `resumeRecovery` ricevono `busy`;
- l'identità della cerimonia è `escrowHash`: nella closure, nell'AAD di `payloadEnc`, e la conferma del Kit avviene in una sola transazione IDB solo se il marker è quello della cerimonia;
- `send` senza marker verifica sul server (`COMPLETED` con lo stesso `escrowHash` = successo);
- chiave effimera senza `requestId` ricollegata tramite `openRecovery` (stesso FP) o cancellata; `COMPLETED` cancella la chiave; `startRecovery` con richiesta già aperta → `recoveryAlreadyOpen`;
- `syncLocalRecovery` non cancella mai marker di recupero; passi dopo il 200 best-effort; controllo dell'utente corrente prima dello sblocco e prima di restituire il Kit.

Residui accettati: i campi del marker fuori da `payloadEnc` (`kitConfirmed`) li può alterare solo codice dello stesso origin, che può già pilotare la libreria; `notBefore` firmato non è confrontato con l'ora locale (difesa in profondità, nessun attacco concreto). La UI di Fase 4 deve rispettare il lock della cerimonia (un solo flusso per utente alla volta) e chiamare `resumeRecovery` prima di `syncLocalRecovery`.

## 10. Redesign della cerimonia: «commit, poi Kit» (architect; APPROVATO dall'utente il 12/11/2026: U1, U3, U4, U5. D1 e D3 della §6 sono superate)

Due giri di revisione di fila hanno trovato MAJOR diversi nella stessa area (verdetti ed esiti della cerimonia, §9), quindi per regola niente terzo giro di toppe: l'architect ha rivisto il design da capo. Diagnosi: tutta la complessità nasce dal mostrare il nuovo Kit **prima** del commit (D1, D3): Kit la cui validità dipende da un evento futuro, payload persistito in IDB, `kitConfirmed`, lock lungo, `resumeRecovery`, verdetto `newKitInvalid`.

**Modello proposto (stesso ordine di setup e `regenerateKit`, `vaultSession.ts:229,479`):** una sola `completeRecovery({userId, requestId, kit, newPin})` sotto il Web Lock tenuto solo per la durata della chiamata. Fa la cerimonia crittografica di oggi (verifica del rilascio, Kit vecchio → VK, nuovo PIN e nuovo escrow, round-trip, `signVkProof`), scrive **prima della POST** il marker `kit` esistente `{kind:'kit', escrowHash, confirmed:false}`, POST con fino a 3 tentativi sui transitori (il server è idempotente: 200 = il NOSTRO payload è committato), e solo su 200 sblocca, aggiorna share e cache dal server, cancella la chiave effimera (CAS) e restituisce il nuovo Kit; la UI lo mostra e chiama `confirmKit`. Se la scheda si chiude tra commit e Kit, il percorso esistente `checkPendingOnStart` → `kitUnconfirmed` → banner (`VaultPage.tsx:256`): l'utente sblocca col nuovo PIN appena scelto e rigenera il Kit.

**Verdetti (5):** `applied` (restituisce il Kit) · `notApplied{keyringChanged | requestClosed | rejected}` (nulla è cambiato, vale il Kit precedente) · `completedElsewhere` (409 con richiesta COMPLETED: usare il PIN impostato altrove) · `unknown` (provare il nuovo PIN; il marker `kit` decide al riavvio) · errori di preparazione invariati. Nessun verdetto dice più «il Kit annotato non vale», perché un Kit si mostra solo dopo il 200. Il marker `kit` non si cancella mai in questo codice: lo risolve `checkPendingOnStart` (hash uguale → banner, diverso → cancellato), quindi un errore di classificazione HTTP non distrugge dati.

**Chiave effimera:** nessun lock nella fase di richiesta; ogni cancellazione è un compare-and-delete in una transazione IDB (per `requestId` o per `publicRaw` + età), con controllo che l'utente del token sia `userId` prima e dopo la risposta; grazia di 10 minuti per una chiave non legata (`createdAt`), oltre i ~94 s massimi della POST con 3 tentativi da 30 s.

**Si toglie:** payload in IDB (chiude G-E: niente oracolo offline sul nuovo PIN), `kitConfirmed`, marker `recovery`, `resumeRecovery`, cerimonia viva con `send`/`discard`, lock lungo, `confirmByServer`, `isTerminalReject`, `newKitInvalid` (≈ -200 righe). Nessuna modifica backend.

**Rischio residuo:** risposta persa + scheda chiusa + utente che dimentica il nuovo PIN prima di sbloccare = vault perso (Kit vecchio morto, nuovo mai visto). È la stessa classe di rischio già accettata per il setup (spec riga 162). Mitigazioni: nuovo PIN digitato due volte nella UI di Fase 4, banner, testo di `unknown`.

**Decisioni:** U1 sostituire D1 e D3 con «commit, poi Kit» (cambia la regola anti-perdita della spec §3.2.7, scritta su un finding red-team); U2 alternativa: tenere D1/D3 con quattro fix mirati (sconsigliata); U3 «Rimuovi vault da questo dispositivo» cancella la chiave effimera con avviso in Fase 4; U4 nessuna modifica backend; U5 grazia di 10 minuti.

### 10.1 Primo giro di revisione sul modello «commit, poi Kit»

Reviewer (1 MAJOR) e red-team (1 HIGH, 2 MEDIUM, con PoC `poc3.test.ts` F1-F6) non hanno trovato problemi nella parte crittografica né scritture in IDB fuori dal marker. Correzioni del giro 1:
- **HIGH:** `checkPendingOnStart` di un'altra scheda cancellava il marker `kit` mentre la POST era in volo. Ora prende lo stesso Web Lock, cancella con compare-and-delete e non tocca un marker più giovane di 10 minuti (`createdAt` sul marker `kit`, anche per setup e `regenerateKit`).
- **Regola unica per `COMPLETED`:** il verdetto si decide sempre confrontando `kr.escrowHash` con l'hash del proprio nuovo escrow. Uguale dopo la POST → `applied` col Kit; uguale in preparazione → `unknown`; diverso → `completedElsewhere`. Dopo un tentativo ambiguo nessun rifiuto vale «non applicato» senza verifica sul server.
- Controllo dell'utente corrente prima di marker, POST, refresh e share; in `startRecovery` 429 e 503 cancellano la chiave, un bind fallito annulla la richiesta, una chiave orfana in grazia dà `retryLater`.

Requisito per la Fase 4: durante la cerimonia la UI deve sopprimere il banner `kitUnconfirmed` (dopo il 200 lo store è sbloccato e `VaultPage` lo mostrerebbe mentre il nuovo Kit è ancora a schermo), come fa già il setup.

### 10.2 Secondo giro sul modello nuovo: causa comune nel marker `kit` a slot unico

Reviewer: 2 MAJOR. Red-team: nessun CRITICAL/HIGH, 2 MEDIUM, 4 LOW, PoC `poc4.test.ts`. Chiusi F1-F4 e F6; crittografia, lock e segreti in IDB reggono. I finding aperti hanno una causa comune: **un solo slot `kit` per utente**, condiviso da setup, `regenerateKit` e `completeRecovery`, e da tentativi diversi della stessa cerimonia.
- (MAJOR) `regenerateKit`/`confirmKit` (`vaultSession.ts:289,479,495,498`) sovrascrivono e cancellano il marker senza controllarne l'hash e senza il lock del recupero: una rigenerazione in un'altra scheda cancella il marker di un recupero in volo.
- (MEDIUM) Secondo tentativo dopo un `unknown` con la prima POST ancora in rete: `setPending` sovrascrive H1 con H2; la prima committa; marker sbagliato, nessun banner (PoC P1).
- (MAJOR) Dopo un `unknown` con commit avvenuto, `syncLocalRecovery` cancella la chiave effimera (COMPLETED) e il tentativo successivo dice `notThisDevice`, falso.
- (MEDIUM, regressione dei flussi P2) `checkPendingOnStart` con lock `ifAvailable`: con lo StrictMode di dev ed E2E la seconda esecuzione riceve `unknown` e il banner `kitUnconfirmed` o il toast `pinApplied` si perdono (in produzione LOW).
- LOW: 503 non del vault trattato come rifiuto certo; `changePin` al 409 conta un tentativo in più; keyring cambiato tra commit e retry; `createdAt` nel futuro; share nuovo con cache vecchia se il refresh fallisce; testo di `unknown` con commit certo.

Per regola (due giri di fila con MAJOR nella stessa area) niente terzo giro di toppe: decide l'utente.

### 10.3 Modello mirato sul marker `kit`: un marker per escrow, morte decisa da `(epoch, rev)` (architect; APPROVATO dall'utente il 12/11/2026: U6-U12 e avviso multi-file)

**Modello.** Un marker `kit` per ogni escrow, chiave `<userId>:kit:<escrowHash>`, valore immutabile `{kind:'kit', escrowHash, epoch, rev | null (setup), origin: 'setup'|'regenerate'|'recovery', requestId?}` scritto con `add`. Un marker con hash diverso dal keyring si cancella solo quando il keyring ha superato il suo `(epoch, rev)` (per il setup: `status !== 'NONE'` o epoch diversa): da quel momento il server non può più committare quella richiesta, perché `PUT /keyring` e `complete` fanno il CAS su `rev` e lo incrementano (`vault.service.ts:354,371`, `vaultRecovery.service.ts:441,456`). È un fatto letto dal server, non un'ipotesi sul tempo: niente Web Lock nel resolver, niente grazia di 10 minuti, nessun flusso tocca il marker di un altro.

**Risoluzione** (`checkPending`, una sola `GET /keyring`): hash uguale → `kitUnconfirmed`; hash diverso e keyring oltre `(epoch, rev)` → cancellato; stesso rev → resta senza banner (forse in volo); GET fallita → `unknown`. Slot legacy P2 `<userId>:kit` letto e cancellato come in 1.14.0, mai scritto. Marker `pin` resta a slot unico con compare-and-delete per hash. `checkPendingOnStart` senza lock, con dedupe della promise in volo nella scheda (chiude la regressione StrictMode). `confirmKit(userId, escrowHash)` cancella solo il proprio marker (la UI passa l'hash).

**`completeRecovery`.** Marker `{origin:'recovery', requestId, epoch, rev}`, mai cancellato da questo codice. Nuovo verdetto `appliedWithoutKit` («recupero applicato: sblocca col nuovo PIN e rigenera il Kit») quando `kr.escrowHash` coincide con un nostro marker `recovery` della stessa richiesta ma non col tentativo corrente. `getRecovery` prima del controllo della chiave locale, così `COMPLETED` non diventa `notThisDevice`. Dopo il 200: refresh del keyring (solo utente corrente) → se l'hash non è il nostro, Kit azzerato e `appliedWithoutKit` → share salvato solo se il refresh è riuscito.

**Chiude:** i 2 MAJOR e i 2 MEDIUM della §10.2, F5, i LOW su `createdAt` del marker, testo di `unknown`, keyring cambiato dopo un 200 idempotente, share con cache vecchia. Fix piccoli inclusi: 503 trattato come rifiuto solo se viene dal vault (`fromServer`), `changePin` al 409 senza un secondo `POST /unlock`. **Residui:** 409 con escrow sostituito tra commit e retry → `completedElsewhere` invece di «tuo» (chiuderlo richiederebbe esporre `completedPayloadHash`); chiave orfana con `createdAt` nel futuro → `retryLater` finché l'orologio non recupera.

**File:** `deviceKeyStore.ts`, `vaultSession.ts`, `vaultRecovery.ts`, `vaultApi.ts`, `RecoveryKitSheet.tsx`, `VaultSetup.tsx`, `VaultSettingsSheet.tsx`, `VaultMigrate.tsx`, `VaultPage.tsx` (passaggio di `escrowHash` a `confirmKit`), locale EN/IT, test, piano e spec. Nessun file TIER 1/2, nessuna modifica backend.

**Decisioni:** U6 marker per escrow con morte da `(epoch, rev)`; U7 `getRecovery` prima di `notThisDevice`; U8 marker `pin` a slot unico con compare-and-delete; U9 verdetto `appliedWithoutKit`; U10 i tre fix piccoli nello stesso giro; U11 slot legacy letto e cancellato senza migrazione; U12 i due residui accettati.

### 10.4 Revisione del modello del marker per escrow

Reviewer (2 MAJOR, scostamenti dell'implementazione dalla §10.3, non del design) e red-team (nessun CRITICAL/HIGH; PoC `poc5`-`poc7`: chiusi F1-F6 e P1-P5; regola `(epoch, rev)` verificata su 9 casi limite senza marker morti con richiesta ancora committabile). E2E `vault*.spec.ts` 19/19 col backend vero e verifica dei flussi P2 sotto StrictMode (banner una volta, toast del PIN). Correzioni del giro 1: `escrowHash` nel risultato `applied` per `confirmKit`; dopo il 200 cache scritta dal keyring letto, poi sblocco, poi share (dispositivo senza cache); testo di `appliedWithoutKit` col PIN del tentativo precedente; `changePin` con compare-and-delete del marker `pin`; 503 `fromServer` anche in `vaultSession`; setup al 409 che confronta l'hash; `checkPending` col controllo dell'utente; richiesta chiusa in preparazione → `requestClosed`.

Residui accettati: il dedupe di `checkPendingOnStart` può restituire al secondo chiamante una fotografia di pochi millisecondi prima (il banner arriva al giro dopo); P3a con refresh fallito (tre guasti insieme) → `applied` con un Kit già superato; schede col bundle 1.14.0 aperte durante un recupero (il loro `changePin` al 409 rimanda il wrap vecchio, lo slot legacy si cancella con una loro rigenerazione in volo, il loro `removeDevice` non pulisce i marker nuovi): finestra transitoria del deploy, da ricordare nel runbook della release.

Giro 2 del reviewer: 1 MAJOR, introdotto dal brief del giro 1 (stessa chiave per due casi). Nuovo verdetto `appliedKitReplaced` per il 200 nostro con l'escrow sostituito subito dopo da un'altra sessione (vale il PIN appena scelto, vault sbloccato, Kit da rigenerare); `appliedWithoutKit` resta solo per il commit di un tentativo precedente della stessa richiesta (vale il PIN di quel tentativo). Più due MINOR: 404 in preparazione → `requestClosed`; setup al 409 con GET fallita non cancella il marker. L'utente ha chiesto, dopo queste correzioni, un terzo giro completo di reviewer e red-team sull'intero blocco E prima del commit.

### 10.5 Giro completo su tutto il blocco E (reviewer + red-team)

Red-team: nessun CRITICAL/HIGH; tutte le PoC dei giri precedenti (poc3-poc7) chiuse; crittografia, marker per escrow, chiave effimera, `signVkProof` e `changePin` reggono, anche contro 11 tipi di risposte ostili del server (poc8). Reviewer: 1 MAJOR di testo (`unknown` con richiesta già `COMPLETED` ma verifica fallita diceva che vale il Kit precedente) e 3 MINOR. Correzioni del giro 3: verdetto `completedUnverified`; `isCurrent` prima della prima GET e prima di interpretare un 404; codice `notReleased` per le richieste non ancora rilasciate (prima «annulla e rifai»); `authKey` azzerato in `finally`; marker `pin` con la stessa regola di morte del `kit` (prima un toast falso «PIN non applicato» con un cambio PIN in volo, comportamento già presente nella 1.14.0); un 200 col keyring di un altro escrow accettato solo con la richiesta davvero `COMPLETED` o `rev` avanzato di 2. Su richiesta dell'utente, dopo queste correzioni un altro giro completo di reviewer e red-team.

**Backlog Fase 4 (backend, fuori dal diff):** `releaseRecovery` (`backend/src/services/vaultRecovery.service.ts:~246-283`) non fa il CAS sul keyring. Un `PUT /keyring` con escrow tra la lettura del keyring e il passaggio a `RELEASED` (prima che valga il 409 `recoveryInProgress`) lascia `S_root` disallineato dall'escrow: il client vede `kitInvalid` col Kit giusto. Fix: condizionare il flip a `RELEASED` a `rev`/`escrowHash` letti, nella stessa transazione.

### 10.6 Quarto giro completo e chiusura del blocco E

Reviewer: nessun BLOCKER/MAJOR. Red-team: nessun CRITICAL/HIGH, PoC poc3-poc9 tutte chiuse. Correzioni finali: validazione della forma delle risposte 2xx in `vaultApi.ts` (una risposta non del vault vale come errore di rete, cioè esito ambiguo: chiude X1-X8 delle PoC poc10-poc13), controllo dell'utente dopo la GET del keyring in `completedVerdict`, testi neutri di `completedElsewhere` e `pinChangedElsewhere`, regola del marker `pin` solo su `(epoch, rev)` come il `kit`.

Residui accettati: il toast «PIN non applicato» per un cambio PIN la cui PUT non è mai arrivata compare solo al primo avanzamento di `rev` (anche giorni dopo), mentre la 1.14.0 lo mostrava al riavvio successivo; il testo di `releaseInvalid` suggerisce di annullare e rifare anche quando serve aggiornare l'app (`rootKeyId` assente dal bundle). Entrambi da rivedere con la UI della Fase 4.

Revisione del delta finale: nessun BLOCKER/MAJOR; enum validati identici a `VaultStatus` e `VaultRequestStatus` del backend, compreso il ramo idempotente di `complete`. Blocco E committato.

**Primi punti per la Fase 4 (MINOR/NIT aperti, nessuna perdita di dati):**
- `vaultRecovery.ts:~268-274`: sul percorso ambiguo il `notReady` lanciato da `completedVerdict` viene catturato e diventa `unknown`; `vaultRecovery.ts:~229-235`: se l'utente cambia e la GET fallisce l'esito è `completedUnverified` invece di `notReady`. Fix: rilanciare `VaultSessionError` e controllare l'utente anche nel ramo d'errore, con test.
- Testo di `completedElsewhere`: va detto «il PIN attuale» e che il Kit precedente non vale più; testo di `pinChangedElsewhere` più preciso («il PIN scelto più di recente, qui o altrove»).
- `vaultApi.test.ts`: test con `it.each` su tutti i valori legittimi degli enum (keyring `NONE` con epoch/rev 0, `RESET_PENDING`, gli 8 stati della richiesta, `complete` idempotente).
- Validazione della forma assente su `unlock`, `confirmRecovery`, `cancelRecovery`, `getItems`, `migrate`, `finalize` (fuori dalla §10.6).
- Dalla §10.5: CAS sul keyring in `releaseRecovery` (backend). Dalla §10.6: toast «PIN non applicato» in ritardo, testo di `releaseInvalid`.
- La UI della Fase 4 deve: sopprimere il banner `kitUnconfirmed` durante la cerimonia, chiamare `confirmKit` con l'`escrowHash` del risultato, impedire un secondo `completeRecovery` dopo `applied`, mostrare ogni verdetto col suo testo.
