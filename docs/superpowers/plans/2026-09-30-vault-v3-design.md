# Vault v3: design finale (cifratura reale, multi-dispositivo, recupero in doppio controllo, reset reale)

Il design di partenza è **security-first**: è l'unico senza finding fatali. Dagli altri due prendo l'hotfix P0, la password del vault, la cifratura dei titoli fin da subito e le guardie su sharing, search e AI. Ho rivisto nel codice le correzioni che dipendono da dettagli concreti:
- la CSP permette già il WASM (`app.ts:63` `'wasm-unsafe-eval'`);
- la coda di sync non unisce gli UPDATE, li spinge come snapshot (`syncService.ts:771`) e li riordina (`:755` `hasQueuedReferenceCreate`);
- `updateSharedNoteContent` (`sharing.service.ts:~850-866`) e `hocuspocus.ts` `store()` (`:413-428`) scrivono `Note.content` senza passare da `note.service`;
- `User.mobile` è modificabile dall'utente.

---

## 1. Sintesi

- Il vault funziona su **tutti i dispositivi**. Il dispositivo 2 chiede la password del vault, non la crea da capo. Il logout blocca il vault ma non lo cancella.
- Note, **titoli** e credenziali sono **cifrati nel browser** con AES-256-GCM. Il server vede solo ciphertext e chiavi incapsulate.
- Il "PIN" diventa una **password del vault** di almeno 10 caratteri, con controllo di robustezza. Serve a resistere a un furto del DB o del dispositivo.
- Lo sblocco funziona **offline** sui dispositivi già usati online. Creare il vault, cambiare password, reset e recupero richiedono la rete.
- Alla creazione l'utente riceve un **Recovery Kit** (codice di 34 caratteri) da conservare. Il recupero con root richiede **Kit + root + OTP email + validazione + 72 ore di attesa**. Root da solo, o l'utente da solo con il Kit, non può recuperare.
- Il **reset** cancella davvero note, credenziali, tag, versioni e allegati del vault. Serve il codice generato dal sistema da digitare (stile GitHub) + la password dell'account. Si può annullare per 7 giorni.
- I vault esistenti in prod si migrano **nel browser al primo sblocco**. Nessun dato viene cancellato prima che il server abbia riletto e verificato il ciphertext.
- Il buco "contenuto vuoto sovrascrive il server" si chiude subito, con un hotfix P0 senza crittografia. Poi si chiude in modo definitivo con il compare-and-swap lato server.
- Se l'utente perde **sia la password sia il Kit**, il vault è irrecuperabile, per scelta di design. Resta solo il reset.

---

## 2. Architettura chiavi e crittografia (parametri)

### 2.1 Gerarchia

```
password vault ──Argon2id(pinSalt16, m=64MiB,t=3,p=1)──► S (32B)
S ──HKDF("notiq/vault/v3/auth|"+userId)──► authKey ──► server: authVerifier = HMAC(PEPPER, authKey)
S || serverShare(32B, rilasciato da POST /unlock) ──HKDF(salt=pinSalt, "notiq/vault/v3/kek|"+userId)──► KEK_pin
VK = 32B random (una per utente per epoch)
wrappedVkPin = AES-GCM(KEK_pin, VK, AAD="vk|userId|epoch|"+kdfParamsJSON)
vkAuth = HKDF(VK,"notiq/vault/v3/vkauth") ──► server: vkVerifier = HMAC(PEPPER, vkAuth)   (prova di possesso di VK)
K_note = HKDF(VK, salt=noteId, "notiq/vault/v3/note")
Escrow 2-di-2:
  S_root (32B) ── sealed to ROOT ECDH P-384 pub ──► sealedRootShare
  S_user (20B = Recovery Kit, 32 char Crockford + 2 check)
  RK = HKDF(S_root||S_user, "notiq/vault/v3/escrow|"+userId)
  escrowBlob = AES-GCM(RK, VK, AAD="escrow|userId|epoch|rootKeyId")
  userShareUnderVk = AES-GCM(VK, S_user)   (ri-mostrare il Kit / re-seal su rotazione root senza nuovo Kit)
```

- Il cambio password re-incapsula solo VK. VK ed epoch non cambiano, quindi ciphertext e versioni restano validi.
- L'epoch cambia solo con il reset.

### 2.2 Scelte e parametri

| Elemento | Scelta | Motivo |
|---|---|---|
| KDF | **Argon2id** via `hash-wasm` (MIT, zero dipendenze), caricato in modo lazy nel chunk del vault e in un **Web Worker**. Parametri: m=65536 KiB, t=3, p=1, output 32B. Minimo imposto dal client e dallo Zod server: m≥65536, t≥3. | Contro una password a bassa entropia l'unica difesa significativa sulle GPU è la memory-hardness, e PBKDF2 sulle GPU costa poco. L'obiezione "serve cambiare la CSP" non vale più: la CSP è già in `app.ts:63`. Precedente: Bitwarden usa 64 MiB. Tempo e memoria su iOS vanno misurati in P2. `kdf` e `kdfParams` sono salvati, quindi si può calibrare senza downgrade. |
| Pepper | `VAULT_PEPPER_KEY` (32B, env). Protegge `authVerifier`, `vkVerifier` e `serverShareEnc`. Con `pepperKeyId` per la rotazione. | Un leak del **solo DB** (dump, backup) non permette il brute force offline. |
| Cifratura degli item | AES-256-GCM, IV random di 96 bit per ogni scrittura, chiave per nota `K_note`. | AEAD nativo in WebCrypto. |
| Envelope | `nv3.<epoch>.<b64url iv>.<b64url ct+tag>`. Plaintext: `{v:1,t:title,c:<TipTap JSON \| CredentialData>}`. AAD: `notiq/vault/v3/item\|userId\|noteId\|noteType\|epoch`. | Lega il ciphertext alla sua nota: il server non può scambiare blob o riportare un'epoch vecchia. Non esistono percorsi di "duplica nota" (verificato: niente in `notes.ts`/`note.service.ts`). |
| Titolo | Dentro l'envelope. Sul server `title=''`, `searchText=null`. | Cifratura dei titoli portata subito (finding dell'attacco su minimal-change). |
| Root | ECDH P-384 (seal) + ECDSA P-384 (firma), chiavi pubbliche **fissate nel bundle** in `frontend/src/utils/vaultRootKeys.ts` e anche nel backend per verificare la firma. | P-384 è disponibile ovunque in WebCrypto; X25519 no. |
| Password del vault | Almeno 10 caratteri, non solo cifre. Blocklist compatta di password comuni + stima di entropia di almeno ~50 bit (niente bundle zxcvbn). | Il PIN a 6 cifre cade in pochi giorni su un paio di GPU se il server è compromesso (DB + pepper). |
| Legacy | `crypto.ts` **non viene toccato**. `decryptContent` (`:40-72`) serve solo in lettura durante la migrazione. `hashPin` (`:10-12`) serve solo a riconoscere il vecchio PIN; poi `pinHash` viene azzerato. `EncryptedBlockComponent` è fuori scope. |  |

### 2.3 Cosa sa chi

| Soggetto | Possiede | Può decifrare? |
|---|---|---|
| Server/DB | `wrappedVkPin`, verifier con pepper, `serverShareEnc`, `escrowBlob`, `sealedRootShare`, ciphertext | No |
| Leak del DB o dei backup | Tutto quanto sopra, senza pepper | No: niente brute force offline |
| Operatore con DB + pepper | Può fare brute force offline della password | Solo se la password è debole (rischio residuo, §9) |
| Root (chiave offline) | `S_root` | No: gli manca `S_user` (160 bit) |
| Utente con Kit | `S_user` | No senza `S_root` e senza la procedura di recupero |

---

## 3. Recupero da root in doppio controllo

### 3.1 Chi detiene cosa

- **Root**:
  - chiavi private ECDH ed ECDSA P-384 su una macchina air-gapped, in PKCS#8 cifrato con passphrase;
  - 2 supporti offline in 2 luoghi, passphrase su carta in busta sigillata;
  - CLI offline `backend/src/scripts/vaultRoot.ts` con i comandi `keygen | open-package | release`;
  - drill trimestrale su un account di test.
- **Utente**: Recovery Kit (`S_user`) + account (password + email) + un dispositivo con login.
- **Server**: `escrowBlob` e `sealedRootShare`, che non può aprire. Più `recoveryPhone`, uno snapshot preso al setup e modificabile solo con `vkProof`. Chi ruba solo il JWT non può cambiare il numero da richiamare (fix del finding "numero di richiamo controllato dall'attaccante").

### 3.2 Protocollo

1. **Setup (P2).**
   - Il client sigilla `S_root` alla chiave root, costruisce l'escrow e fa `POST /vault/keyring`.
   - **Il Kit viene mostrato solo dopo il 201.** Chi perde la gara riceve 409 e non vede mai un Kit non valido.
   - Il Kit va scaricato o stampato, poi l'utente riscrive 2 gruppi presi a caso.
2. **Richiesta.**
   - Da un dispositivo con login: "Password del vault dimenticata → recupero assistito". L'interfaccia avverte subito che senza Kit resta solo il reset.
   - Il browser genera una coppia ECDH P-384 effimera. La privata è non-extractable e sta nell'IndexedDB raw `notiq-vault-device`, quindi `db.ts` non si tocca.
   - `POST /vault/recovery {clientEphPub, reason}` → OTP a 6 cifre per email (hash, 10 min, 5 tentativi).
3. **Conferma in-app.**
   - L'utente inserisce l'OTP → `PENDING_VALIDATION`, `notBefore = now + 72h`.
   - Email + push a tutte le sessioni con l'impronta `FP` (8 caratteri base32 di SHA-256(clientEphPub)) e il pulsante "Non sei tu? Annulla". Qualsiasi sessione può annullare.
4. **Validazione ufficiale (fuori banda).**
   - Root chiama `recoveryPhone`, **mai** un numero indicato nella richiesta, e verifica l'identità secondo la policy scritta.
   - L'utente legge ad alta voce l'impronta `FP` che vede in app. Root la annota **offline**, su carta o sulla macchina air-gapped.
   - `POST /admin/vault-recovery/:id/validate {evidence}`, messo in audit.
5. **Rilascio (solo dopo `notBefore`).**
   - Root scarica il package `{requestId, userId, sealedRootShare, clientEphPub, notBefore}` e lo porta via USB.
   - La CLI calcola l'impronta di `clientEphPub` e **chiede all'operatore l'impronta annotata al telefono**. Se non corrispondono, abort: un admin non può sostituire la chiave effimera tra validazione e rilascio.
   - La CLI apre `S_root`, lo sigilla a `clientEphPub` e firma con ECDSA `requestId|userId|FP|notBefore|sha256(seal)`.
   - `POST /:id/release`: il server verifica la firma con la chiave fissata e rifiuta il rilascio prima di `notBefore` o se la richiesta è annullata o scaduta.
6. **Completamento (solo sul dispositivo richiedente).**
   - Il client verifica la firma e **che `FP` firmato coincida con l'impronta della propria chiave**. Poi apre `S_root`, l'utente inserisce il Kit, il client calcola RK e ottiene VK.
   - Nuova password obbligatoria; **rotazione di `S_root` e `S_user`**, perché il vecchio `S_root` è passato dalla macchina dell'operatore: nuovo escrow e nuovo Kit.
   - `POST /vault/recovery/:id/complete {rev, vkProof, nuovi wrap, nuovo escrow}`. È autorizzato da **`vkProof`**, non da `authKeyOld`: così il recupero con password dimenticata può davvero scrivere il nuovo wrap (fix del finding).
   - Il server cancella `rootShareForClient`; il client cancella la chiave effimera. Audit + email.

### 3.3 Limiti

- Al massimo 1 richiesta aperta e 3 ogni 30 giorni.
- Il rilascio scade dopo 7 giorni.
- Il lockout dello sblocco non si applica al recupero.
- Ogni transizione di stato produce una riga `AuditLog` e un'email all'utente.

### 3.4 Perché root da solo non può

1. **Crittografia:**
   - l'escrow richiede `S_root || S_user`; root non ha mai `S_user`, che sta solo sul Kit e in `userShareUnderVk`, cifrato con VK;
   - sostituire `clientEphPub` non gli dà niente in più: ha già `S_root`, gli manca comunque `S_user`.
2. **Procedura:** OTP + 72 ore + annullamento da ogni sessione + firma verificata dal client.
3. **Unica via "da solo":** il brute force offline della password del vault con DB + pepper. Si mitiga con Argon2id e con la robustezza obbligatoria (§9). Non si può chiudere in una web app, dove chi controlla il bundle JS può sempre catturare la password.

---

## 4. Reset stile GitHub

Solo online. Si può fare sia a vault bloccato sia sbloccato, perché serve proprio quando la password è persa.

1. **Sfida.** `POST /vault/reset/challenge` restituisce:
   - un codice generato dal server di 12 caratteri Crockford `XXXX-XXXX-XXXX` (circa 60 bit), salvato come hash in `VaultRequest(type=RESET)`, valido 10 minuti, 5 tentativi;
   - i **conteggi reali**: note, credenziali, tag, versioni, allegati.
2. **Dialog.**
   - Elenco di cosa verrà distrutto, avviso "Irreversibile: neanche l'amministratore potrà recuperarlo", codice in un blocco monospace.
   - Un campo in cui riscrivere il codice (case-insensitive, trattini facoltativi; il paste **resta permesso** come su GitHub, per accessibilità e password manager) e un campo con la password dell'account.
   - Il pulsante resta disabilitato finché entrambi non sono validi. Si usa `ConfirmDialog`, mai `confirm()`.
3. **`POST /vault/reset {requestId, code, password}`** (bcrypt, rate limit 3 ogni 15 min).
   - Stato `RESET_PENDING`, `resetScheduledAt = now + 7g`.
   - **Da subito**: sblocco e scritture sul vault rifiutati, vault nascosto su tutti i dispositivi.
   - Email con link di annullamento + banner in ogni sessione. `POST /vault/reset/cancel` riporta a READY.
   - È la difesa contro "mailbox compromessa → reset password → vault distrutto". Se l'utente sceglie la cancellazione immediata (decisione D5), questo passo si salta.
4. **Hard delete.** Lo esegue un job periodico in `vault.service`, avviato da `app.ts` come gli altri `setInterval`, in **una transazione**:
   - `deleteMany Note {userId, isVault:true}`; NoteVersion, TagsOnNotes e Attachment cascadono;
   - cancellazione dei `Tag {isVault}`;
   - annullamento delle `VaultRequest` aperte;
   - azzeramento dei campi crittografici del keyring, `status=NONE`, **`epoch = epoch+1` sulla riga, che non viene mai cancellata**.
   - Dopo il commit: unlink dei file degli allegati (`npm run prune` come rete di sicurezza), audit `vault.reset` con i conteggi, email.
5. **Altri dispositivi.**
   - Solo una risposta **esplicita** `GET /vault/keyring → 200 {status:'NONE'|'RESET_PENDING', epoch > epoch in cache}` fa cancellare le note vault locali in Dexie, i relativi item della syncQueue e la cache.
   - Un 404 o un errore di rete non cancellano **mai** nulla: sono lo stato UNKNOWN (fix del finding "404 nudo cancella tutto" durante i deploy).
   - Le scritture rimaste in coda con la vecchia epoch ricevono 422 `errors.vault.stale` → `failed` (`syncService.ts:1004-1015`). Nessun resurrezione: l'epoch persiste sul keyring (fix del finding "epoch solo in AuditLog").
6. Il setup dopo un reset riparte con la nuova epoch. I vecchi envelope non verranno mai più accettati.
7. Il testo falso attuale (`en.json:349-350`, `it.json:447-448`) e il flusso in `VaultUnlock.tsx:28-35` vengono sostituiti.

---

## 5. Offline, multi-dispositivo, logout

### 5.1 Macchina a stati (`VaultPage.tsx:192-198`), per utente

| Stato | Condizione | UI |
|---|---|---|
| UNKNOWN | Offline senza cache per l'utente, o GET fallita o non 200 | "Connettiti una volta per usare il vault su questo dispositivo". **Mai il setup.** |
| NONE | 200 `status:NONE`, online | Setup; se `legacyCount>0` o c'è un `pinHash` locale, parte la migrazione |
| RESET_PENDING | 200 | Banner con il pulsante "Annulla reset" |
| READY | 200 `READY`, oppure cache presente offline | Sblocco |
| UNLOCKED | VK in memoria | Contenuto |

### 5.2 Offline

- Lo sblocco usa `wrappedVkPin` in cache in `vault-storage.byUser[userId]` e `serverShare` cifrato con una chiave AES non-extractable del dispositivo, in `notiq-vault-device`. Il tag GCM fa da verifica della password.
- Setup, cambio password, reset, recupero e migrazione sono disabilitati, con spiegazione.
- Gli edit vengono cifrati **prima** della scrittura in Dexie e messi in coda.
- Un item mai scaricato è in sola lettura: "Non ancora disponibile su questo dispositivo".
- Onestà: la cache offline permette a chi ruba il dispositivo un brute force offline. La difesa è la password robusta + Argon2id. Nelle impostazioni c'è "Disattiva sblocco offline su questo dispositivo".

### 5.3 Multi-dispositivo

- Il keyring è sul server. Il setup concorrente si risolve con la regola "create-only": 409 → sblocco con la password del vincitore.
- Il cambio password è un `PUT` con CAS su `rev` e `vkProof`.
- Un dispositivo offline accetta la vecchia password finché non torna online: VK è lo stesso, quindi non c'è rischio per i dati. Il ritardo va documentato.
- In "Cambia password" c'è l'opzione **"Ruota anche la chiave del vault"**, che ri-cifra tutti gli item lato client e incrementa l'epoch. Serve quando la password è stata vista da qualcuno, per rendere inutile la cache di un telefono rubato.

**Edit concorrenti: push "latest-state".** Qui c'è il fix del finding sulla catena `baseHash` rotta dal riordino di `hasQueuedReferenceCreate` e dal backoff per item.
- La riga Dexie della nota vault tiene `vaultBaseHash`: lo sha256 dell'ultimo ciphertext confermato dal server. È un campo non indicizzato: nessun bump di versione Dexie, solo il tipo in `LocalNote`.
- In `syncPush`, ramo NOTE UPDATE (`syncService.ts:~771`), per le note `isVault` il payload viene ricostruito al momento della push: `content` = contenuto **attuale** in Dexie, `baseHash` = `vaultBaseHash` attuale.
- Su 200 si imposta `vaultBaseHash = sha256(contenuto inviato)`, non quello corrente, così un edit fatto durante la push resta pendente.
- Gli item successivi della stessa nota diventano idempotenti. Ordine e backoff non contano più.
- La coda non riceve mai `baseHash`, quindi `noteService.ts:149-166` resta com'è.

**Conflitti.**
- Il server risponde 422 `errors.vault.conflict`, che è già terminale (`failed`) anche nei bundle vecchi.
- Allo sblocco il vault trova gli item `failed` delle note vault e salva la versione locale come nuova nota "(copia in conflitto)", ri-cifrata con il nuovo `noteId` nell'AAD. Poi accetta la versione del server e rimuove l'item.
- Niente sovrascritture silenziose.

### 5.4 Logout

- `authStore.ts:76`: `resetVault()` diventa `lockVault()`, che azzera VK in memoria.
- Copre anche `api.ts:36/:61` e `useKanbanRealtime.ts:154`, che passano tutti da `logout`.
- Il materiale in cache è per `userId`, quindi un altro utente sullo stesso browser non lo vede.
- Pulizia esplicita: Impostazioni → "Rimuovi vault da questo dispositivo".
- L'auto-lock a 10 minuti (`vaultStore.ts:4-18`) resta.

---

## 6. Migrazione dei vault esistenti in prod (zero data loss) e chiusura del buco di sovrascrittura

### 6.1 Chiusura del buco

1. **P0, subito, senza crittografia né schema.**
   - `CredentialForm.tsx:63-67` e il ramo vault di `NoteEditor`: con contenuto `''`, sola lettura con placeholder, **mai** `EMPTY_CREDENTIAL` modificabile.
   - Online: fetch pigro di `GET /notes/:id` (`notes.ts:65`) per riempire Dexie.
   - `VaultPage.tsx:92-102` crea le note vault con un documento iniziale non vuoto.
2. **P2, definitivo.**
   - Ogni item vault è sempre un envelope, anche se vuoto, quindi `''` vuol dire solo "non caricato".
   - Idratazione tramite `GET /vault/items` (ciphertext + `contentHash`), scritta in Dexie solo dove la riga locale è `synced`.
   - Il server impone CAS su `baseHash` + formato envelope + epoch corrente.

### 6.2 Migrazione

È client-side e si attiva con `status:NONE` + (`legacyCount>0` oppure `pinHash` locale).

0. **Flush.** `syncPush` deve svuotare la coda. Se restano item vault pendenti o `failed`, la migrazione si blocca con un messaggio. Il server non ha ancora il keyring, quindi le scritture in chiaro in coda passano.
1. **Nuova password del vault** (policy §2).
   - `POST /vault/keyring {…, migrationState:'IN_PROGRESS'}`. Il Kit si mostra dopo il 201.
   - Su 409, un altro dispositivo ha vinto: si sblocca con la sua password e si prosegue.
2. **Vecchi PIN.** Verificati con `hashPin` se c'è un `pinHash` locale. Ciclo su più PIN, perché ogni dispositivo può averne avuto uno diverso.
3. **Sorgente = server** (`GET /vault/items`), mai la copia locale, che può essere vecchia (`syncService.ts:172-185`). Per ogni item:
   - nota in chiaro (con `isEncrypted` true o false) → envelope `{t,c}`;
   - credenziale v2 o legacy → `decryptContent` (`crypto.ts:40`) → envelope;
   - roundtrip in memoria `decrypt(envelope) == originale` prima dell'invio.
4. **`POST /vault/migrate`** in batch da 200 con `baseHash = sha256(contenuto server)`. In una transazione per item:
   - CAS;
   - **snapshot forzato del plaintext come NoteVersion**, così resta un rollback;
   - `title=''`, `isEncrypted=true`, `searchText=null`, `ydocState=null`.
5. **Verifica dai byte del server.**
   - Nuova `GET /vault/items?ids=…`, decifratura e confronto con gli originali ancora in memoria.
   - Solo per gli id verificati: `POST /vault/finalize {ids}`.
   - Il server ricontrolla che il contenuto sia un envelope dell'epoch corrente e **solo allora** cancella le NoteVersion non-envelope di quegli id.
   - È il fix del finding "purge prima della prova": un bug del client resta reversibile fino alla finalizzazione.
6. **Item non decifrabili** (PIN di un altro dispositivo): restano **byte-identici**, marcati "Bloccato con un PIN precedente — inseriscilo per aggiornare". Sono in sola lettura e si possono riprovare. **La migrazione non cancella mai nulla.**
7. **Fine.** Quando `legacyCount=0` si passa a `migrationState=DONE`; in locale gli envelope vanno in Dexie e `pinHash=null` (fix del finding "pinHash reversibile persistito per sempre").

### 6.3 Bundle vecchi in cache (PWA)

- Dopo che esiste il keyring, le scritture in chiaro ricevono 422 `errors.vault.plaintextRejected` → `failed`, con banner rosso invece di un backoff silenzioso.
- Al primo avvio del bundle nuovo, le righe vault non `synced` con contenuto non-envelope diventano input di migrazione: vengono cifrate e salvate come "copia in conflitto". Nessun edit perso.

### 6.4 Spostamento nel vault (`NoteEditor.tsx:279-306`)

- Richiede il vault sbloccato. La cifratura avviene lato client.
- Il server, in una transazione:
  - cancella le righe `SharedNote`, imposta `isPublic=false`, `ydocState=null`, `searchText=null`;
  - **chiude le connessioni Hocuspocus** della nota, con il disconnect mirato già usato per l'SSE.
- Le versioni in chiaro si cancellano con lo stesso `finalize`, dopo la verifica del re-download.
- Note con allegati: spostamento bloccato.

### 6.5 Operazioni

- `pg_dump` prima del deploy di P2 (lo fa `Deploy-Server.ps1`).
- I dump e gli ZIP `npm run backup` precedenti contengono plaintext e vanno distrutti dopo la retention concordata.
- Script admin con il `legacyCount` per utente. Gli utenti che non aprono mai il vault restano in chiaro: il server non può cifrare al loro posto. Si mostra un banner di sollecito.

---

## 7. Modello dati, migration, API, file toccati

### 7.1 `schema.prisma` (TIER 1)

**Una** migration nuova `20261001000000_vault_e2ee`. Nessuna modifica alle migration applicate, mai `db push`.

```prisma
enum VaultStatus { NONE READY RESET_PENDING }
enum VaultMigrationState { NONE IN_PROGRESS DONE }
enum VaultRequestType { RESET RECOVERY }
enum VaultRequestStatus { PENDING_OTP PENDING_VALIDATION VALIDATED RELEASED COMPLETED CANCELLED EXPIRED REJECTED }

model VaultKeyring {            // la riga sopravvive al reset (epoch durevole)
  userId String @id  (User, onDelete: Cascade)
  status VaultStatus @default(NONE)
  epoch Int @default(0)
  rev Int @default(0)            // CAS
  kdf String?  kdfParams Json?  pinSalt Bytes?  wrappedVkPin Bytes?
  authVerifier Bytes?  vkVerifier Bytes?  serverShareEnc Bytes?  pepperKeyId String?
  escrowBlob Bytes?  sealedRootShare Bytes?  rootKeyId String?  userShareUnderVk Bytes?
  recoveryPhone String?          // snapshot, modificabile solo con vkProof
  migrationState VaultMigrationState @default(NONE)
  failedAttempts Int @default(0)  lockedUntil DateTime?  resetScheduledAt DateTime?
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
}

model VaultRequest {             // una sola tabella per reset e recupero
  id String @id @default(uuid())  userId String (Cascade)
  type VaultRequestType  status VaultRequestStatus
  codeHash String?  expiresAt DateTime?  attempts Int @default(0)
  clientEphPub Bytes?  fingerprint String?  notBefore DateTime?
  validatedById String?  validationNote String?
  rootShareForClient Bytes?  rootSignature Bytes?  reason String?
  createdAt DateTime @default(now())  completedAt DateTime?  cancelledAt DateTime?
  @@index([userId, type, status])
}
```

- `User` riceve solo le back-relation. `Note`, `NoteVersion` e `Tag` restano invariati.
- Audit: `AuditLog` esistente tramite `logEvent`, con eventi `vault.*`.
- Nuova env `VAULT_PEPPER_KEY`: il boot fallisce se manca. Va in un backup offline **separato** dai dump del DB.

### 7.2 API

Nuovo `backend/src/routes/vault.ts`, plugin con `onRequest:[fastify.authenticate]`. I byte viaggiano in base64url con lunghezze esatte in Zod.

| Endpoint | Body / risposta | Note |
|---|---|---|
| `GET /api/vault/keyring` | **Sempre 200** `{status, epoch, rev, kdf, kdfParams, pinSalt, wrappedVkPin, rootKeyId, migrationState, lockedUntil, resetScheduledAt, legacyCount}` | Mai 404 per dire "nessun vault" |
| `POST /api/vault/keyring` | `{expectedEpoch, kdf:'argon2id', kdfParams{m≥65536,t≥3,p:1}, pinSalt16, wrappedVkPin60, authKey32, vkAuth32, serverShare32, escrowBlob, sealedRootShare, rootKeyId: enum di id fissati, userShareUnderVk, recoveryPhone?}` | 409 se READY; 5/h |
| `POST /api/vault/unlock` | `{authKey}` → `{serverShare}` | 5 tentativi liberi, poi backoff 1m/5m/15m/1h/24h, email dopo 10; 10/min |
| `PUT /api/vault/keyring` | `{rev, vkProof, wrap?, escrow?, recoveryPhone?, rotate?}` | Cambio password, rotazione escrow/root/VK; 409 se `rev` è vecchio |
| `GET /api/vault/items?ids=` | `[{id, noteType, content, contentHash, updatedAt, isTrashed}]` | Solo note vault del proprietario; 60/min |
| `POST /api/vault/migrate` | `{items ≤200: {id, baseHash, content, noteType}}` | CAS per item + snapshot forzato |
| `POST /api/vault/finalize` | `{ids ≤500}` | Controlla gli envelope, cancella le versioni in chiaro, imposta DONE |
| `POST /api/vault/reset/challenge` | → `{requestId, code, expiresAt, counts}` | 5/h |
| `POST /api/vault/reset` · `POST /api/vault/reset/cancel` | `{requestId, code, password}` | 3/15min |
| `POST /api/vault/recovery` · `…/:id/confirm {otp}` · `DELETE …/:id` · `GET …/:id` · `…/:id/complete {rev, vkProof, wrap, escrow}` | | 1 aperta, 3 ogni 30 giorni |
| Admin (SUPERADMIN): `GET /api/admin/vault-recovery`, `POST /:id/validate {evidence ≥20}`, `GET /:id/package`, `POST /:id/release {rootShareForClient, rootSignature}`, `POST /:id/reject` | | Release solo dopo `notBefore` e con firma valida |

**Modifiche a codice esistente.**
- `notes.ts:18-26`: `baseHash` facoltativo `^[0-9a-f]{64}$`.
- `note.service.ts`, create (`:27-79`) e update (`:185-279`), se il keyring è READY e la nota è o diventa vault:
  - envelope dell'epoch corrente, `title=''`, `isEncrypted=true`, `searchText=null`;
  - `baseHash` obbligatorio se c'è `content` e uguale a `sha256(content)`, altrimenti 422 conflict.
  - Il passaggio false→true fa la transazione di §6.4. Il passaggio true→false richiede il plaintext nella stessa richiesta.
- `noteVersion.service` restore: rifiuta le versioni non-envelope per le note vault (fix del bypass).
- `sharing.service.ts`: `shareNote` e `updateSharedNoteContent` rifiutano `isVault`; `/share/notes/accepted` esclude `isVault` (fix del bypass).
- `hocuspocus.ts`: `onAuthenticate` rifiuta `isVault`; `store()` non persiste se `isVault` (fix del finding sulla sovrascrittura con plaintext).
- `import.ts:25/:51` e `attachments.ts:29`: rifiutano `isVault`.
- `search.service.ts:39/:68`: aggiunto `AND "isVault"=false`. `ai.service.ts:46`: blocca anche `isVault`.
- Promemoria di note vault: testo push generico.

### 7.3 Frontend

- **Nuovi file:**
  - `utils/vaultCrypto.ts` (in `utils`, perché serve anche a `syncService` senza import tra feature) e `utils/vaultRootKeys.ts`;
  - `features/vault/`: `vaultApi.ts`, `deviceKeyStore.ts`, `VaultMigrate.tsx`, `VaultResetDialog.tsx`, `VaultRecovery.tsx`, `RecoveryKitSheet.tsx`, `VaultOfflineNotice.tsx`;
  - sezione Vault in `SettingsPage`.
- **`vaultStore.ts`:**
  - chiave `vault-storage` invariata; `partialize` (`:65`) **aggiunge** `byUser: Record<userId,{status,epoch,rev,kdfParams,pinSalt,wrappedVkPin,rootKeyId}>`;
  - `isSetup` e `pinHash` restano come segnale legacy e vengono azzerati dopo la migrazione;
  - `vk: CryptoKey|null` in memoria sostituisce `pin` (`:24`).
- **Consumatori da aggiornare:**
  - `VaultPage.tsx` (`:34/:92-158/:192-198/:221`, con l'import nel vault rimosso);
  - `VaultSetup.tsx`, `VaultUnlock.tsx`;
  - `CredentialForm.tsx`, `CredentialCard.tsx:17`, `credentialTypes.ts:21-33`;
  - `NoteEditor.tsx` + `useNoteController`: prop `vaultCodec` per titolo e contenuto; per le note vault nascondere condivisione, AI, versioni e allegati.
- **i18n:** chiavi `vault.*` in **en.json e it.json**, sempre in coppia. Tutta la nuova UI ha varianti `dark:`, touch target da 44px, bottom sheet su mobile.

### 7.4 File TIER toccati

| TIER | File | Modifica |
|---|---|---|
| 1 | `backend/prisma/schema.prisma` | Modelli + 1 migration nuova |
| 1 | `frontend/src/store/vaultStore.ts` | Campi persistiti additivi, VK in memoria |
| 1 | `frontend/src/features/sync/syncService.ts` | Solo push latest-state per le note vault (`~:755-771`) + `vaultBaseHash` su 200 |
| 1 | `backend/src/hocuspocus.ts` | `onAuthenticate` + guardia in `store()` + disconnect al passaggio nel vault |
| 1 | `frontend/src/lib/db.ts` | **Solo il tipo** `vaultBaseHash?` in `LocalNote`, **nessuna** nuova versione |
| 1 | `frontend/src/utils/crypto.ts` | **Non toccato** |
| 2 | `frontend/src/store/authStore.ts` | `:76` → `lockVault()` |
| 2 | `backend/src/app.ts` | Registrazione route, controllo pepper al boot, job purge reset |
| 2 | `backend/src/services/email.service.ts` | Template OTP, stati recupero, reset, lockout |
| 2 | `api.ts`, `Editor.tsx`, `auth.service.ts` | **Non toccati** (allegati bloccati a livello `NoteEditor`; in P2 verificare che paste/drop immagini in `Editor.tsx` non lo aggirino, altrimenti serve una guardia TIER 2) |

Ogni file TIER richiede "proponi prima", il gate e reviewer + red-team.

---

## 8. Fasi di consegna

### P0: hotfix (senza crittografia né schema), rilasciabile subito

- **Scope:**
  - placeholder in sola lettura + fetch pigro (§6.1.1);
  - guardie server: Hocuspocus `isVault` (`onAuthenticate` + `store`), sharing `isVault`, search/AI `isVault`;
  - testo del reset onesto ("dimentica solo il PIN su questo dispositivo").
- **Criteri di accettazione:**
  - su un secondo contesto la credenziale mostra la copia del server, oppure offline un placeholder non modificabile; il contenuto sul server non viene mai sovrascritto;
  - una nota spostata nel vault è assente da `/api/search` e rifiutata dall'AI;
  - una connessione WS verso una nota vault viene rifiutata; lo share di una nota vault risponde 400;
  - `npx tsc -p tsconfig.app.json --noEmit`, lint e vitest verdi.
- **Test:**
  - unit: `CredentialForm` con `''` non chiama mai `updateNote`;
  - backend: search esclude `isVault`, hocuspocus rifiuta, `shareNote` rifiuta;
  - e2e: `frontend/e2e/vault-overwrite.spec.ts` (2 contesti).

### P1: fondazioni server + cerimonia root (nessun cambio UX)

- **Scope:**
  - `vaultRoot.ts keygen` offline, chiavi pubbliche fissate nel bundle, `VAULT_PEPPER_KEY`;
  - migration, `vault.ts` + service + Zod;
  - imposizione envelope/CAS e bypass chiusi (restore, `updateSharedNoteContent`, import, allegati), attivi **solo con keyring READY**.
- **Criteri di accettazione:**
  - `migrate deploy` segnala esattamente 1 migration pending e `migrate status` è pulito;
  - due `POST /keyring` concorrenti danno 201 + 409;
  - `GET /keyring` risponde sempre 200;
  - 6 `unlock` sbagliati impostano `lockedUntil` e scrivono una riga di audit;
  - senza keyring le scritture legacy passano ancora;
  - con keyring: plaintext → 422, `baseHash` sbagliato → 422 conflict, epoch vecchia → 422 stale;
  - `finalize` rifiuta gli id non-envelope;
  - `cd backend && npm test` verde.
- **Test:** `vault.service.test.ts` (409, lockout, HMAC con pepper, CAS su `rev`, `vkProof`); test di `note.service` su envelope, CAS e transazione di spostamento nel vault; restore e `updateSharedNoteContent` rifiutati.

### P2: client E2EE + migrazione + multi-dispositivo (un solo rilascio)

- **Scope:**
  - `vaultCrypto` (Argon2id in un worker), stato UNKNOWN/NONE/READY, setup con Kit dopo il 201, sblocco online/offline;
  - logout → lock; envelope per note, credenziali e titoli; idratazione; push latest-state; copie in conflitto;
  - wizard di migrazione + `finalize`; spostamento dentro e fuori dal vault; cambio password (+ rotazione VK facoltativa).
- **Criteri di accettazione:**
  - `SELECT content FROM "Note" WHERE "isVault"` restituisce solo `^nv3\.` (più le credenziali legacy bloccate, elencate) e `title=''`;
  - dopo `finalize` nessuna NoteVersion vault non-envelope; `searchText` e `ydocState` a NULL;
  - il dispositivo B chiede la password, non il setup, e decifra;
  - logout → login porta allo sblocco, non al setup;
  - offline con cache: lo sblocco funziona; senza cache: avviso, mai il setup;
  - `kdfParams` manomessi → lo sblocco fallisce;
  - 3 edit offline della stessa nota con un riferimento in coda producono **0** conflitti falsi;
  - un edit concorrente reale produce 1 copia in conflitto e nessuna perdita;
  - un utente legacy seed (note in chiaro + credenziale v2 + credenziale legacy) si migra con valori identici;
  - un item con PIN sconosciuto resta byte-identico;
  - migrazione da 2 dispositivi: 1 keyring, nessuna perdita;
  - un bundle vecchio che scrive plaintext dopo il keyring produce 1 copia in conflitto al primo avvio del bundle nuovo.
- **Test:**
  - unit: `vaultCrypto.test.ts` (known-answer Argon2id/HKDF, roundtrip, AAD swap, minimo dei parametri), `vaultStore.test.ts` (chiave invariata, `partialize` additivo), test della push latest-state;
  - e2e: `vault-multidevice.spec.ts`, `vault-offline.spec.ts` (`context.setOffline`), `vault-migration.spec.ts` (dati legacy seed + verifica sul DB), `vault-conflict.spec.ts`;
  - da rilanciare: `offline-first`, `dexie`, `encryption`, `notes`, `collaboration` (`:249` è instabile: confermarlo con `git stash`).

### P3: reset reale

- **Criteri di accettazione:**
  - codice o password sbagliati non cancellano nulla; il 6° tentativo è rifiutato; il codice scade a 10 minuti;
  - `RESET_PENDING` blocca subito sblocco e scritture; annullare ripristina tutto;
  - dopo il job: 0 note, tag, versioni e righe allegato vault, file eliminati, epoch+1, riga keyring presente;
  - il dispositivo B pulisce solo con uno stato esplicito, e un 404 simulato non cancella nulla;
  - le scritture in coda di B finiscono `failed` e non risorgono.
- **Test:** transazione di reset e scheduling del job lato backend; e2e `vault-reset.spec.ts` (2 contesti + route 404 simulata).

### P4: recupero root

- **Criteri di accettazione:**
  - release prima di `notBefore` → 4xx; firma non valida → rifiuto;
  - la CLI fa abort se l'impronta non coincide;
  - il client rifiuta un `FP` firmato diverso dal proprio;
  - senza Kit fallisce; con Kit recupera VK e forza nuova password e nuovo Kit; il vecchio Kit non funziona più;
  - l'annullamento da un'altra sessione blocca il flusso;
  - catena `AuditLog` completa; `rootShareForClient` NULL dopo il completamento.
- **Test:** `vaultRecovery.service.test.ts` (macchina a stati, rate limit, tempi); test Node della CLI con una chiave di test; e2e `vault-recovery.spec.ts` con un `rootKeyId` solo di test, mai incluso nel bundle di prod.

### P5: rifinitura

- **Scope:** viewer delle versioni che decifra, rotazione della chiave root con re-seal al prossimo sblocco tramite `userShareUnderVk`, runbook di purge dei backup, drill.
- **Criteri di accettazione:** il restore di una versione vault si decifra; la rotazione root non chiede un nuovo Kit.

---

## 9. Rischi residui

1. **Tetto dell'E2EE web**: chi controlla il bundle distribuito (operatore o attaccante su IIS) può catturare password e Kit. Mitigazioni: hash dei bundle pubblicati e testo onesto nella UI.
2. **Operatore con DB + pepper**: può fare brute force offline di password deboli. Lo limitano policy, blocklist e Argon2id 64 MiB, ma non è eliminabile senza WebAuthn PRF (evoluzione futura).
3. **Furto del dispositivo con cache offline**: stesso brute force offline, perché la chiave "non-extractable" è comunque su disco. Mitigazioni: password robusta e l'opzione per disattivare lo sblocco offline.
4. **Perdita di `VAULT_PEPPER_KEY`**: sblocco impossibile per tutti; resta solo il recupero con Kit + root. Serve un backup offline separato.
5. **Perdita della chiave root**: niente più recupero per nessuno. Serve il drill trimestrale.
6. **Kit + password persi**: vault irrecuperabile, per scelta.
7. **Credenziali legacy** cifrate con un PIN dimenticato: restano illeggibili, elencate, mai cancellate.
8. **Plaintext storico** in `pg_dump`, ZIP e WAL fino alla rotazione. Utenti che non aprono mai il vault: restano in chiaro sul server.
9. **Metadati visibili al server**: nomi dei tag vault, `noteType`, timestamp, conteggi, richiesta di screenshot `siteUrl` (`CredentialForm.tsx:129`), favicon DuckDuckGo (`:23`).
10. **Dipendenza nuova `hash-wasm`**: tempo e memoria su iOS PWA da misurare in P2; `kdfParams` resta calibrabile, ma solo verso l'alto.
11. **Push latest-state in `syncService`**: è l'unico punto TIER 1 del sync. Va verificato che nessun altro percorso scriva `content` delle note vault fuori da `updateNote`.
12. **DoS dello sblocco online**: con un JWT rubato qualcuno può innescare il lockout. È limitato nel tempo, lo sblocco offline resta disponibile e l'utente riceve un'email.

### Tracciabilità dei finding del red team

| Finding | Correzione |
|---|---|
| Hocuspocus `store()` scrive plaintext dopo lo spostamento nel vault | Guardia in `store()` + `onAuthenticate` + disconnect + `ydocState=null` (§6.4, §7.2) |
| Epoch solo in AuditLog | Epoch sulla riga `VaultKeyring`, mai cancellata (§4) |
| 404 nudo → purge | `GET` sempre 200; purge solo su stato esplicito; 404 = UNKNOWN (§4.5) |
| Cache offline brute-forzabile | Rischio dichiarato + opzione per disattivarla + password robusta (§5.2, §9) |
| Purge delle versioni senza prova | Snapshot forzato + `finalize` dopo la verifica dei byte del server (§6.2) |
| Swap di `clientEphPub` | Impronta annotata offline, controllo nella CLI + verifica client dell'`FP` firmato (§3.2) |
| `PUT` con `authKeyOld` blocca il recupero | `vkProof` per tutte le mutazioni del keyring (§3.2, §7.2) |
| Catena `baseHash` rotta dal riordino | Push latest-state + `vaultBaseHash` in Dexie (§5.3) |
| Restore e `updateSharedNoteContent` aggirano i controlli | Guardie dedicate (§7.2) |
| Root decifra da solo con brute force del PIN | Pepper + password robusta + Argon2id; limite dichiarato (§2.3, §9) |
| Migrazione che cifra una copia locale vecchia | Sorgente = server dopo il flush (§6.2) |
| Reset e `PUT` protetti solo dal JWT | Reset: codice + password + finestra di 7 giorni. `PUT`/complete: `vkProof` (§4, §7.2) |
| Il perdente del setup concorrente vede un Kit non valido | Kit mostrato solo dopo il 201 (§3.2) |
| Titoli in chiaro | Titolo nell'envelope da P2 (§2.2) |
| `''` come sentinella rende note vuote non modificabili | Item sempre envelope (§6.1) |
| U incapsulato con la password dell'account (ux-ops) | Non adottato: `S_user` esiste solo nel Kit |
| Numero di richiamo modificabile | `recoveryPhone` in snapshot, cambiabile solo con `vkProof` (§3.1) |
| Bundle vecchio perde gli edit dopo la migrazione | 422 terminale + conversione in copia in conflitto (§6.3) |
| Il cambio password non revoca i dispositivi rubati | Opzione "ruota la chiave del vault" (§5.3) |
| Paste disabilitato nel reset | Paste permesso (§4.2) |
| `pinHash` persistito per sempre | Azzerato a migrazione completata (§6.2.7) |

---

## 10. Decisioni richieste all'utente

1. **Password del vault al posto del PIN numerico** (almeno 10 caratteri, controllo di robustezza), con **sblocco offline attivo di default** e disattivabile per dispositivo? *Raccomandato: sì.* Un PIN a 6 cifre non regge a una compromissione completa del server né al furto del dispositivo.
2. **Il Recovery Kit vale solo insieme a root (2-di-2)**, senza auto-recupero con il solo Kit? *Raccomandato: sì.* Un Kit rubato da solo non apre il vault, ed è il requisito b.
3. **Accetti che Kit + password persi insieme = vault irrecuperabile** (resta solo il reset)? *Raccomandato: sì.* Qualsiasi alternativa permette a root di recuperare da solo.
4. **Custodia root e policy di validazione**:
   - una chiave offline su 2 supporti, con passphrase in busta sigillata (Shamir 2-di-3 rimandato);
   - richiamata solo al `recoveryPhone` registrato al setup, più documento d'identità in videochiamata;
   - attesa di 72 ore e scadenza a 7 giorni.
   *Raccomandato: sì così.*
5. **Reset con finestra di 7 giorni annullabile** prima della cancellazione definitiva, invece che immediato? Il vault resta subito bloccato e nascosto in entrambi i casi. *Raccomandato: finestra di 7 giorni.*
6. **Allegati e import bloccati nelle note vault, e nomi dei tag vault in chiaro sul server** (documentato)? *Raccomandato: sì.* Gli allegati cifrati diventano una feature separata.