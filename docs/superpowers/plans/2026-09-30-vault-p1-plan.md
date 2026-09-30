# Piano P1 (vault v3): fondazioni server e cerimonia root, senza cambi UX

Il piano è sola lettura: non ho modificato nessun file. I riferimenti `file:line` sono verificati sul `main` attuale (`577cf33`). Il design è `docs/superpowers/plans/2026-09-30-vault-v3-design.md`, abbreviato in "design:N".

---

## 1. Obiettivo e perimetro

**Obiettivo (design:498-514).**
- Portare in produzione le fondamenta server del vault v3:
  - una migration additiva;
  - `routes/vault.ts` e `vault.service.ts` (keyring, sblocco con lockout, `vkProof`, items/migrate/finalize);
  - l'imposizione di envelope e CAS sui percorsi di scrittura esistenti;
  - la chiusura dei bypass (restore, `updateSharedNoteContent`, import, allegati);
  - lo script della cerimonia root e il pepper.
- L'imposizione è **dormiente**: si attiva solo per un utente con `VaultKeyring.status='READY'`.

**Cosa NON cambia per gli utenti (invariante da dimostrare con i test):**
- **Nessun keyring può nascere in P1.** Le chiavi root fissate (`VAULT_ROOT_KEYS`) restano vuote e `POST /api/vault/keyring` risponde 503. Senza keyring ogni percorso esistente resta identico a oggi: note, vault legacy, sync, import, allegati, restore, condivisione.
- **Nessun file frontend di UX.** Unica eccezione: la chiave i18n `errors.notes.idConflict` (T3), che serve al fix IDOR. Nessun bundle chiama `/api/vault/*`.
- **Il boot non fallisce mai per i segreti del vault.** Se il pepper manca o è malformato, le route `/api/vault/*` rispondono 503 e il resto dell'app funziona (decisione D1).
- **La migration è solo additiva**: 4 `CREATE TYPE`, 1 `ALTER TYPE ADD VALUE`, 2 tabelle, 1 indice, 2 FK. Nessun `DROP`, nessun `ALTER` su tabelle esistenti.
- **Fuori perimetro:**
  - reset (P3);
  - recupero root, `vaultAdmin.ts`, `vaultRootKey.service`, controllo del file root al boot (P4);
  - `frontend/src/utils/vaultRootKeys.ts` e tutta la UI (P2);
  - Hocuspocus, search e AI, già chiusi in P0 (`hocuspocus.ts:400`, `:425`, `:482`).

**Deviazioni dal design, motivate:**

| Design | P1 | Motivo |
|---|---|---|
| Boot fallisce se manca `VAULT_PEPPER_KEY` (design:388) | Warning al boot + 503 sulle route vault | Il `.env` di prod oggi non ha il pepper; lo step 9 di `Deploy-Server.ps1:230-231` si limita a un warning. Decisione D1 |
| `GET /api/vault/items?ids=` (design:402) | `POST /api/vault/items {ids?, after?}` | Con 500 uuid servono circa 18,5 KB di query string. `frontend/public/web.config` non alza `maxQueryString` (default IIS 2048): risponde 404.15. Finding RT-2 |
| Il client manda `migrationState:'IN_PROGRESS'` (design:296) | Lo calcola il server da `legacyCount` | Un dato di stato non si prende dal client |
| Chiavi root fissate subito dopo la cerimonia | Fissate **solo nel branch P2** | Finding RT-1 (vedi §4) |

---

## 2. Diff `schema.prisma` (TIER 1) e migration

### 2.1 Diff

```prisma
// backend/prisma/schema.prisma

// --- model User (:12-86): SOLO back-relation, inserite prima della "}" di :86 ---
  chatReactions          MessageReaction[]          @relation("ChatReactions")
+ vaultKeyring           VaultKeyring?
+ vaultRequests          VaultRequest[]
}

// --- enum NotificationType (:276-293): valore aggiunto in coda ---
  KANBAN_COMMENT_DELETED
+ VAULT_RECOVERY
}

// --- nuovi, in fondo al file ---
+enum VaultStatus {
+  NONE
+  READY
+  RESET_PENDING
+}
+
+enum VaultMigrationState {
+  NONE
+  IN_PROGRESS
+  DONE
+}
+
+enum VaultRequestType {
+  RESET
+  RECOVERY
+}
+
+// reset:    PENDING_CODE → COMPLETED | EXPIRED
+// recupero: PENDING_APPROVAL → PENDING_CODE → WAITING → RELEASED → COMPLETED (| CANCELLED | EXPIRED | REJECTED)
+enum VaultRequestStatus {
+  PENDING_APPROVAL
+  PENDING_CODE
+  WAITING
+  RELEASED
+  COMPLETED
+  CANCELLED
+  EXPIRED
+  REJECTED
+}
+
+model VaultKeyring {
+  userId           String              @id
+  user             User                @relation(fields: [userId], references: [id], onDelete: Cascade)
+  status           VaultStatus         @default(NONE)
+  epoch            Int                 @default(0)   // durevole: la riga sopravvive al reset
+  rev              Int                 @default(0)   // CAS per PUT /keyring
+  kdf              String?
+  kdfParams        Json?
+  pinSalt          Bytes?
+  wrappedVkPin     Bytes?
+  authVerifier     Bytes?                           // HMAC(pepper-verifier, authKey)
+  serverShareEnc   Bytes?                           // AES-GCM(pepper-sharewrap, serverShare)
+  pepperKeyId      String?
+  vkSigPub         Bytes?                           // SPKI P-256
+  wrappedVkSigKey  Bytes?
+  escrowBlob       Bytes?
+  sealedRootShare  Bytes?
+  rootKeyId        String?
+  userShareUnderVk Bytes?
+  migrationState   VaultMigrationState @default(NONE)
+  failedAttempts   Int                 @default(0)
+  lockedUntil      DateTime?
+  resetScheduledAt DateTime?
+  createdAt        DateTime            @default(now())
+  updatedAt        DateTime            @updatedAt
+}
+
+model VaultRequest {
+  id                   String             @id @default(uuid())
+  userId               String
+  user                 User               @relation(fields: [userId], references: [id], onDelete: Cascade)
+  type                 VaultRequestType
+  status               VaultRequestStatus
+  codeHash             String?
+  codeAHash            String?
+  codeBHash            String?
+  expiresAt            DateTime?
+  attempts             Int                @default(0)
+  clientEphPub         Bytes?
+  fingerprint          String?
+  notBefore            DateTime?
+  requestIp            String?
+  requestUserAgent     String?
+  approvedById         String?
+  approvedAt           DateTime?
+  rejectReason         String?
+  releasedById         String?
+  releasedAt           DateTime?
+  releaseExpiresAt     DateTime?
+  rootShareForClient   Bytes?
+  rootSignature        Bytes?
+  reason               String?
+  completedPayloadHash String?
+  createdAt            DateTime           @default(now())
+  completedAt          DateTime?
+  cancelledAt          DateTime?
+  cancelledBy          String?
+
+  @@index([userId, type, status])
+}
```

- `Note`, `NoteVersion` e `Tag` restano invariati (design:387).
- `VaultRequest` e `VAULT_RECOVERY` sono inutilizzati fino a P3/P4. Li includo perché il design prevede **una** migration sola (design:345). Se in P3/P4 lo schema cambia, servirà una migration nuova.

### 2.2 Migration `backend/prisma/migrations/20261001000000_vault_e2ee/migration.sql`

Va generata con `npx prisma migrate dev --create-only --name vault_e2ee`, poi rinominata col timestamp. Contenuto atteso, e **unico ammesso** (10 statement):

```sql
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'VAULT_RECOVERY';

-- CreateEnum
CREATE TYPE "VaultStatus" AS ENUM ('NONE', 'READY', 'RESET_PENDING');
CREATE TYPE "VaultMigrationState" AS ENUM ('NONE', 'IN_PROGRESS', 'DONE');
CREATE TYPE "VaultRequestType" AS ENUM ('RESET', 'RECOVERY');
CREATE TYPE "VaultRequestStatus" AS ENUM ('PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REJECTED');

-- CreateTable
CREATE TABLE "VaultKeyring" (
    "userId" TEXT NOT NULL,
    "status" "VaultStatus" NOT NULL DEFAULT 'NONE',
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "rev" INTEGER NOT NULL DEFAULT 0,
    "kdf" TEXT,
    "kdfParams" JSONB,
    "pinSalt" BYTEA,
    "wrappedVkPin" BYTEA,
    "authVerifier" BYTEA,
    "serverShareEnc" BYTEA,
    "pepperKeyId" TEXT,
    "vkSigPub" BYTEA,
    "wrappedVkSigKey" BYTEA,
    "escrowBlob" BYTEA,
    "sealedRootShare" BYTEA,
    "rootKeyId" TEXT,
    "userShareUnderVk" BYTEA,
    "migrationState" "VaultMigrationState" NOT NULL DEFAULT 'NONE',
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "resetScheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VaultKeyring_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "VaultRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "VaultRequestType" NOT NULL,
    "status" "VaultRequestStatus" NOT NULL,
    "codeHash" TEXT, "codeAHash" TEXT, "codeBHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "clientEphPub" BYTEA, "fingerprint" TEXT, "notBefore" TIMESTAMP(3),
    "requestIp" TEXT, "requestUserAgent" TEXT,
    "approvedById" TEXT, "approvedAt" TIMESTAMP(3), "rejectReason" TEXT,
    "releasedById" TEXT, "releasedAt" TIMESTAMP(3), "releaseExpiresAt" TIMESTAMP(3),
    "rootShareForClient" BYTEA, "rootSignature" BYTEA, "reason" TEXT,
    "completedPayloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "cancelledBy" TEXT,
    CONSTRAINT "VaultRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VaultRequest_userId_type_status_idx" ON "VaultRequest"("userId", "type", "status");

-- AddForeignKey
ALTER TABLE "VaultKeyring" ADD CONSTRAINT "VaultKeyring_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultRequest" ADD CONSTRAINT "VaultRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**Controlli di sicurezza della migration (finding RT-11):**
- `migrate dev` può emettere SQL di drift. Motivi: `searchVector Unsupported("tsvector")` (`schema.prisma:154`) e la storia di `20260901130000_realign_migrations_with_schema`. Va **rimosso a mano**, e il criterio di T1 lo verifica.
- `ALTER TYPE ... ADD VALUE` dentro la transazione di Prisma funziona già: c'è il precedente in `migrations/20260223000000_add_task_lists/migration.sql:5-8`, sullo stesso PG15 di prod.
- Il lock FK su `User` è innocuo: pm2 è fermo durante `migrate deploy` (`Deploy-Server.ps1:153`, poi `:180`).
- **Rollback.** Il codice 1.12.2 ignora tabelle ed enum nuovi. Tornare al `dist` precedente non richiede di toccare il DB.

---

## 3. API e servizi

### 3.1 `backend/src/routes/vault.ts` (nuovo)

- Plugin Fastify con default export, prefisso `/api/vault`.
- `fastify.addHook('onRequest', fastify.authenticate)`, come in `notes.ts:46`.
- Hook `preHandler`: se `pepperStatus().status !== 'ok'` → **503** `errors.vault.unavailable`.
- Tutti i byte viaggiano in base64url. Un helper Zod `b64url(len | [min,max])` verifica `^[A-Za-z0-9_-]+$` e la lunghezza **decodificata** esatta, con un messaggio fisso che non riporta mai l'input.
- I rate limit usano il pattern `config: { rateLimit: { max, timeWindow } }`, come in `import.ts:9`.

| Endpoint | Body → risposta | Regole |
|---|---|---|
| `GET /keyring` | → **sempre 200** `{status, epoch, rev, kdf, kdfParams, pinSalt, wrappedVkPin, wrappedVkSigKey, rootKeyId, migrationState, lockedUntil, resetScheduledAt, legacyCount}` | Senza riga: `{status:'NONE', epoch:0, rev:0, …null, migrationState:'NONE', legacyCount}`. Non scrive mai. Non restituisce mai `authVerifier`, `serverShareEnc`, `escrowBlob`, `sealedRootShare`, `userShareUnderVk`, `vkSigPub`. `legacyCount = note.count({userId, isVault:true, NOT:{content:{startsWith:'nv3.'}}})`. 60/min |
| `POST /keyring` | `{expectedEpoch, kdf:'argon2id', kdfParams{m:65536..1048576, t:3..10, p:1}, pinSalt:16, wrappedVkPin:60, authKey:32, serverShare:32, vkSigPub:91, wrappedVkSigKey:[80,220], escrowBlob:60, sealedRootShare:157, rootKeyId, userShareUnderVk:48}` → 201 `{status, epoch, rev}` | **P1: se `Object.keys(VAULT_ROOT_KEYS).length===0` → 503 `errors.vault.unavailable`, prima di qualsiasi lettura** (RT-1). `vkSigPub`: `createPublicKey({format:'der', type:'spki'})`, curva `prime256v1`, altrimenti 400. `rootKeyId ∈ VAULT_ROOT_KEYS`. Logica in §3.2. 5/h |
| `POST /unlock` | `{authKey:32}` → `{serverShare}` | Lockout atomico (§4.4). **Mai 401**: un 401 fa logout in `frontend/src/lib/api.ts`. 10/min |
| `PUT /keyring` | `{payload: string ≤65536, vkProof:64}` → `{rev}` | `payload` = JSON di `{rev, wrap?:{kdf,kdfParams,pinSalt,wrappedVkPin,authKey}, escrow?:{escrowBlob,sealedRootShare,rootKeyId,userShareUnderVk}, rotate?}`. `rotate` → 400 `errors.vault.rotateNotSupported` fino a P2. Firma e CAS in §4.5. 10/h |
| `POST /items` | `{ids?: uuid[] ≤200, after?: uuid}` → `{items:[{id, noteType, content, contentHash, updatedAt, isTrashed}], next}` | Solo note `isVault` del chiamante. Gli id non posseduti o non vault vengono omessi. Senza `ids`: pagina di 100 ordinata per `id`, cursore `after`. `contentHash = sha256hex(content)`. 60/min |
| `POST /migrate` | `{items: [{id, baseHash, content, noteType}] ≤200}` → `{results:[{id, status:'ok'｜'already'｜'conflict'｜'notFound'｜'invalid'}]}` | **`bodyLimit: 16 MiB` sulla route** (RT-12). Il default Fastify è 1 MiB, perché in `app.ts:40-43` non è impostato. Contratto P2: batch ≤200 item **e** ≤12 MiB. 20/min |
| `POST /finalize` | `{ids: uuid[] ≤500}` → `{finalized, rejected, legacyCount, migrationState}` | 20/min |

- Nessuna route di reset o recupero.
- Registrazione in `app.ts`, dopo `:225`: `server.register(vaultRoutes, { prefix: '/api/vault' })`.

### 3.2 `backend/src/services/vault.service.ts` (nuovo, named export)

**Pepper** (§5.2): `pepperStatus(): {status:'ok'|'missing'|'invalid', keyId?}`, `verifierKey()`, `shareWrapKey()`. Nessuna cache: la derivazione costa microsecondi e i test possono cambiare `process.env`.

**Helper:**
- `sha256hex(s: string)`: UTF-8.
- `parseEnvelope(s): {epoch} | null`, con regex `^nv3\.(0|[1-9]\d{0,8})\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$` (IV di 12 B = 16 caratteri; ct + tag ≥ 16 B).
- `getVaultGuard(userId, db = prisma): null | {epoch, ready: boolean}`:
  - `null` (legacy) **solo** se non c'è una riga, oppure se `status='NONE' && epoch===0`;
  - `READY` → `{epoch, ready:true}`;
  - ogni altro stato (`RESET_PENDING`, `NONE` con `epoch>0` dopo un reset) → `{epoch, ready:false}`.
  - Così P3 non riapre per sbaglio le scritture in chiaro.
- `assertVaultContent(content, guard, baseHash?, current?)`: vedi §4.2.
- `verifyVkProof(row, method, path, payloadRaw, rev, sig)`: vedi §4.5.

**Keyring:**
- `getKeyring(userId)`.
- `createKeyring(userId, dto)`:
  - `authVerifier = HMAC-SHA256(verifierKey, utf8(userId) ‖ "|" ‖ authKey)`, calcolato **solo** con `authVerifierOf(userId, authKey)` (vedi addendum T6);
  - `serverShareEnc = iv12 ‖ AES-256-GCM(shareWrapKey, serverShare, AAD="notiq/vault/v3/servershare|"+userId+"|"+epoch) ‖ tag`, per un totale di 60 B;
  - `pepperKeyId`;
  - `migrationState = legacyCount>0 ? 'IN_PROGRESS' : 'NONE'`;
  - `status='READY'`.
- Ordine di `createKeyring`:
  1. `vaultKeyring.create`, possibile solo se `expectedEpoch===0`;
  2. su P2002: `updateMany({where:{userId, status:'NONE', epoch: expectedEpoch}, data:{…tutti i campi crittografici…, status:'READY', failedAttempts:0, lockedUntil:null, resetScheduledAt:null, rev:{increment:1}}})` (RT-10);
  3. `count!==1` → 409 `errors.vault.alreadySetup`;
  4. audit `vault.keyring.created`.
- `authKey` e `serverShare` in chiaro **non entrano mai in una chiamata Prisma**, perché gli errori di validazione di Prisma stampano gli argomenti. Entrano solo i valori derivati.
- `unlock(userId, authKey)`: vedi §4.4.
- `updateKeyring(userId, payloadRaw, proof)`: vedi §4.5. Con `wrap`, ricalcola `authVerifier` e `pepperKeyId`.

**Items:**
- `getItems(userId, {ids?, after?})`.
- `migrateItems(userId, items)`: una `$transaction` per item.
  1. `tx.note.findFirst({id, userId, isVault:true})`, altrimenti `notFound`.
  2. Se il contenuto corrente è già un envelope dell'epoch corrente → `already`.
  3. Se `noteType` o l'envelope non sono validi → `invalid`.
  4. Se `sha256hex(current)!==baseHash` → `conflict`.
  5. `tx.noteVersion.create({noteId, content: current, title})` **diretto**: `snapshotPreviousVersion` salterebbe i contenuti sotto i 150 caratteri (`noteVersion.service.ts:13`, `:29`).
  6. `tx.note.updateMany({where:{id, content: current}, data:{content, title:'', isEncrypted:true, searchText:null, ydocState:null}})`; con `count 0` → `conflict`.
  - Richiede `guard.ready`, altrimenti 409 `errors.vault.notReady`. Audit `vault.migrate` con i conteggi.
- `finalize(userId, ids)`:
  - Accetta solo gli id posseduti, `isVault`, con contenuto envelope dell'epoch corrente. Gli altri tornano in `rejected`.
  - `noteVersion.deleteMany({noteId:{in: accettati}, NOT:{content:{startsWith:'nv3.'}}})`.
  - Ricalcola `legacyCount`: se è 0 e `migrationState='IN_PROGRESS'`, imposta `DONE`.
  - Audit `vault.finalize`.

**Errori.** Si usa `new AppError(status, 'errors.vault.*')` da `utils/errors.ts:1-6`. Il gestore globale (`app.ts:78-80`) già mappa qualunque `statusCode`, quindi nessuna nuova classe e `errors.ts` non si tocca.
- 422: `plaintextRejected`, `stale`, `conflict`, `notReady`, `importBlocked`, `attachmentsBlocked`, `plaintextRequired`. Il 422 è terminale nel client esistente (`syncService.ts:1004-1013`).
- 429: `locked`.
- 503: `unavailable`, `pepperMismatch`.

### 3.3 `backend/src/utils/vaultRootKeys.ts` (nuovo)

- Contiene `export const VAULT_ROOT_KEYS: Record<string, {ecdhSpki: string; ecdsaSpki: string}> = {};` e un commento: "P1: DEVE restare vuoto; si popola solo nel branch P2 insieme a `frontend/src/utils/vaultRootKeys.ts`".
- La cartella `src/config/` non esiste. `utils/` ha già `logger` ed `errors`, quindi niente cartella nuova. Serve solo un percorso unico (RT-8).

### 3.4 File della chiave root: `backend/src/utils/vaultRootKeyFile.ts` e `backend/src/scripts/vaultRootKeygen.ts` (nuovi)

- **Libreria** (`utils/vaultRootKeyFile.ts`), importabile dai test e in P4 da `vaultRootKey.service`:
  - `generateRootKeyPair()`: due `generateKeyPairSync('ec', {namedCurve:'secp384r1'})` (ECDH ed ECDSA), in SPKI/PKCS#8 DER. `rootKeyId = "rk_" + sha256hex(ecdhSpki‖ecdsaSpki).slice(0,16)`.
  - `sealRootKeyFile(keys, passphrase, kdfParams = {m:262144, t:3, p:1})`:
    - formato file v1: `{header: "<stringa JSON>", ct}`, con `header = JSON.stringify({v:1, kdf:'argon2id', kdfParams, salt, iv, pub:{[id]:{ecdhSpki, ecdsaSpki}}})`;
    - `ct = AES-256-GCM(Argon2id(passphrase, salt), JSON{[id]:{ecdhPkcs8, ecdsaPkcs8}}, AAD = utf8(header))`;
    - l'header è una stringa, quindi nessuna canonicalizzazione; manomettere l'header fa fallire la decifratura.
  - `openRootKeyFile(path, passphrase)`, `assertPathOutsideApp(p)` (§5.3), `writeAtomicNoOverwrite(p, data)`: file temporaneo aperto con flag `'wx'`, poi `renameSync`; rifiuta se la destinazione esiste.
  - Argon2id con `hash-wasm` (`argon2id({…, memorySize: m, iterations: t, parallelism: p, hashLength: 32, outputType: 'binary'})`).
- **CLI** (`scripts/vaultRootKeygen.ts`): chiama `main()` senza guardia `require.main`. I test importano solo la libreria, così il problema del finding RT-8 non si pone.
  - `--out <path>`:
    1. richiede un TTY;
    2. chiede la passphrase due volte senza eco (`setRawMode`), minimo 20 caratteri; mai da argv o env;
    3. genera, sigilla, scrive;
    4. **rilegge e decifra** il file, poi fa una prova ECDH seal/unseal e una ECDSA sign/verify;
    5. stampa lo sha256 del file e il JSON `pub` da fissare.
  - `--verify <path>`: chiede la passphrase e stampa gli id (copia offline e drill).
  - Buffer azzerati con `fill(0)`, best effort.
- **`backend/package.json`:**
  - `"hash-wasm"` in `dependencies`, perché il server installa con `npm ci --omit=dev` (`Deploy-Server.ps1:178`);
  - script `"vault:root-keygen": "node dist/scripts/vaultRootKeygen.js"`. `tsx` è una devDependency e sul server non c'è; `tsconfig.json` include `src/**/*`, quindi lo script finisce in `dist`.

### 3.5 Codice esistente (dettagli in §4)

`note.service.ts`, `notes.ts`, `noteVersion.service.ts`, `sharing.service.ts`, `import.ts`, `attachments.ts`, `utils/logger.ts`, `app.ts`, `email.service.ts` (template `VAULT_LOCKOUT`).

---

## 4. Enforcement lato server (attivo solo con keyring READY)

### 4.1 Principio

- `getVaultGuard` viene chiamato **solo** quando la nota è vault, o lo sta diventando.
- Per le note normali: zero query in più. Per l'utente senza keyring: `null`, quindi percorso byte-identico a oggi.
- Le guardie sulle scritture **non dipendono dal pepper**, solo dallo stato del keyring.

### 4.2 `assertVaultContent(content, guard, baseHash?, current?)`

L'ordine è fisso:
1. Se `!guard.ready` → 422 `notReady`.
2. Se non è un envelope → 422 `plaintextRejected`.
3. Se l'epoch dell'envelope è diverso da `guard.epoch` → 422 `stale`.
4. Se `current !== undefined` (update) e `baseHash` manca oppure è diverso da `sha256hex(current)` → 422 `conflict`.

Si esegue **solo quando `content !== undefined`** (RT-4).

### 4.3 Punti di imposizione

| Punto | Oggi | Con `guard` non null |
|---|---|---|
| `notes.ts:17-33` `updateNoteSchema` | — | Aggiungere `baseHash: z.string().regex(/^[0-9a-f]{64}$/).optional()` |
| `note.service.ts:76` (P2002 in `createNote`) | `findUnique({where:{id}})` restituisce la nota di **un altro utente** (IDOR già esistente) | `findFirst({where:{id, userId}})`; se è null → `throw new ConflictError('errors.notes.idConflict')` (`errors.ts:20-22`), senza ricadere nel 500 di `app.ts:111-112` (RT-9). **Vale anche senza keyring**: è l'unico cambio di comportamento di P1 e riguarda solo richieste ostili. Spedibile da solo (T2) |
| `note.service.ts:29-81` `createNote` | — | Se `isVault`: `assertVaultContent(content, guard)`. `title !== ''` → 422 `plaintextRejected`. Forza `isEncrypted=true`, `searchText=null` |
| `note.service.ts:203` | `const { tags, ...rest } = data` | `const { tags, baseHash, ...rest } = data` **in ogni caso**, altrimenti Prisma riceve un campo sconosciuto anche nel percorso legacy |
| `note.service.ts:187-311` `updateNote`, nota che **resta** nel vault | — | Guard letto prima di `$transaction` (`:240`) solo se `note.isVault \|\| rest.isVault===true`. `title` presente e non vuoto → 422 `plaintextRejected` (RT-4). `content` presente → `assertVaultContent(content, guard, baseHash, note.content)`, `isEncrypted=true`. Solo metadati (`isTrashed`, `isPinned`, `tags`, `notebookId`, `reminderDate`): nessun controllo |
| Idem, nota che **entra** nel vault (`:236`) | shares cancellati, `ydocState`/`searchText` null, `closeConnections` (`:244-246`, `:278-283`, `:300-307`) | Come oggi, più: `content` obbligatorio (senza → 422 `plaintextRejected`) + `assertVaultContent` con CAS + `title=''` |
| Idem, nota che **esce** dal vault | — | `content` obbligatorio e **non** envelope (altrimenti 422 `plaintextRequired`) + CAS su `baseHash`. Se `rest.isEncrypted===false` e `noteType==='NOTE'`, ricalcola `searchText`: il ramo `:274` lo salta per `note.isEncrypted` |
| `note.service.ts:261-263` `guardEmptyContentOverwrite` | Taglia sotto i 150 caratteri (`contentGuard.ts:15-17`) | **Saltato** nei tre rami READY. Un envelope sotto i 150 caratteri verrebbe scartato in silenzio e la catena `baseHash` si romperebbe; un plaintext corto in uscita lascerebbe l'envelope su una nota non vault |
| `note.service.ts:293` scrittura finale | `tx.note.update` | **Invariato quando il guard è null o non si scrive `content`** (RT-5). Solo nel ramo READY con `content`: `tx.note.updateMany({where:{id, content: note.content}, data})`; `count 0` → 422 `conflict`, poi `tx.note.findUniqueOrThrow({where:{id}})`. Rende atomica la CAS, perché la lettura di `:200` è fuori dalla transazione. Lo snapshot di `:286-291` avviene nella stessa transazione, quindi con 422 va in rollback |
| `noteVersion.service.ts:85-111` `restoreNoteVersion` | — | Se `note.isVault` e c'è un guard: `assertVaultContent(version.content, guard)` senza CAS; `title` forzato a `''` nell'update di `:105` |
| `sharing.service.ts:878` | `prisma.note.update({where:{id: noteId}})` | `updateMany({where:{id: noteId, isVault:false}})`; `count 0` → `ForbiddenError('errors.sharing.forbidden')`. Chiude la corsa tra la lettura di `:853` e lo spostamento nel vault. Nessuna query sul keyring |
| `import.ts:12` e `:37` | `request.file()` prima di leggere la query (`:17`, `:42`) | Spostare la lettura di `isVault` **prima** di `request.file()`. Se `isVault==='true'` e il guard esiste → 422 `importBlocked` |
| `attachments.ts:12-38` (solo POST) | `checkNoteAccess` a `:34-36` | Dopo `:36`: se `access==='OWNER'` e `note.findFirst({id: noteId, userId, isVault:true})` e il guard esiste → 422 `attachmentsBlocked`. Le note vault sono accessibili solo al proprietario (`note.service.ts:24`) |
| `hocuspocus.ts:400`, `:425`, `:482` | Guardie P0 | **Non toccato** |

- Gli altri scrittori di `Note.content` sono solo `import.service.ts:321` e `onenote-import.service.ts:554`, entrambi chiusi dalla guardia in `import.ts`. `notebook.service.ts:81` tocca solo `notebookId` (verifica del red team).

### 4.4 Sblocco e lockout (atomico, RT-3)

1. Se `pepperStatus()` non è ok → 503. Se non c'è una riga o `status≠READY` → 409 `notReady`. Se `pepperKeyId` della riga è diverso dall'id corrente → 503 `errors.vault.pepperMismatch`, **non conteggiato**.
2. `ok = timingSafeEqual(authVerifierOf(userId, authKey), row.authVerifier)`: HMAC legato allo userId (addendum T6).
3. **Errore.** Un solo statement atomico, con il tempo in UTC: le colonne `TIMESTAMP(3)` di Prisma sono UTC, mentre `now()` dipende dal fuso della sessione.
   ```sql
   UPDATE "VaultKeyring"
   SET "failedAttempts" = "failedAttempts" + 1,
       "lockedUntil" = CASE WHEN ("failedAttempts" + 1) % 6 = 0
         THEN (now() AT TIME ZONE 'UTC') + CASE LEAST(("failedAttempts" + 1) / 6, 3)
              WHEN 1 THEN interval '15 minutes' WHEN 2 THEN interval '1 hour' ELSE interval '24 hours' END
         ELSE "lockedUntil" END,
       "updatedAt" = now() AT TIME ZONE 'UTC'
   WHERE "userId" = ${userId} AND "status" = 'READY'
     AND ("lockedUntil" IS NULL OR "lockedUntil" <= now() AT TIME ZONE 'UTC')
   RETURNING "failedAttempts", "lockedUntil"
   ```
   - 0 righe → 429 `locked`, restituendo `lockedUntil` letto.
   - Con n righe e `n % 6 === 0`: `logEvent(userId, 'vault.unlock.locked', {n, lockedUntil})` e email `VAULT_LOCKOUT`.
   - Risposta 403 `invalidPin`, **mai 401**.
4. **Successo.** `updateMany({where:{userId, status:'READY', OR:[{lockedUntil:null},{lockedUntil:{lte:new Date()}}]}, data:{failedAttempts:0, lockedUntil:null}})`.
   - `count!==1` → 429.
   - Solo dopo: decifra `serverShareEnc` e restituisce `{serverShare}`.
   - Richieste in parallelo oltre il budget non ottengono mai `serverShare` né distinguono un PIN giusto da uno sbagliato.

### 4.5 `vkProof` e `PUT /keyring`

1. Il messaggio è `"notiq/vault/v3/proof|PUT /api/vault/keyring|" + userId + "|" + row.epoch + "|" + payload.rev + "|" + sha256hex(payloadRaw)`. Il path è una **costante server**, non `request.url`.
2. Verifica con `crypto.verify('sha256', msg, {key: row.vkSigPub, format:'der', type:'spki', dsaEncoding:'ieee-p1363'}, sig)`: WebCrypto emette `r‖s`. Se fallisce → 403 `invalidProof`.
3. CAS: `updateMany({where:{userId, status:'READY', epoch: row.epoch, rev: payload.rev}, data:{…, rev:{increment:1}}})`. `count 0` → 409 `staleRev`, quindi il replay dopo il successo dà 409.

---

## 5. Segreti e chiave root

### 5.1 Pepper `VAULT_PEPPER_KEY`

- **Formato:** 32 byte casuali in base64url, 43 caratteri. Validazione `^[A-Za-z0-9_-]{43}$` + lunghezza decodificata = 32; qualsiasi altra cosa → `invalid`.
- **Generazione:** `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- **Sottochiavi (una sola derivazione, RT-8):** `hkdfSync('sha256', pepper, '', info, 32)` con
  - `info='notiq/vault/v3/verifier'` → chiave HMAC;
  - `'notiq/vault/v3/sharewrap'` → chiave AES-GCM;
  - `'notiq/vault/v3/pepper-id'` → primi 8 B in hex (16 caratteri) = `pepperKeyId`, salvato sulla riga.
  - Un pepper sostituito si riconosce sempre: 503, mai lockout.
- **Nessun fallback o default.** Nessuna rotazione in P1: `pepperKeyId` la rende possibile più avanti, con `VAULT_PEPPER_KEY_PREV` e re-HMAC al successivo sblocco riuscito.
- **Dove sta.** Solo in `E:\www\Notiq\backend\.env`, letto da `dotenv` dentro il processo (`app.ts:1`). **Mai** nell'env di macchina o utente: `pm2 save` (`Deploy-Server.ps1:194`) lo catturerebbe. Copia nel password manager, **separata** dai dump del DB.

### 5.2 Boot e redact

- **Boot.** Dopo `server.listen` (`app.ts:309`): `server.log.info({ vaultPepper: s.status, pepperKeyId: s.keyId }, 'vault secrets')`. Mai `process.exit`: il precedente di `JWT_SECRET` (`app.ts:115-119`) non si applica qui (D1). `pepperKeyId` non è un segreto.
- **Redact.**
  - `utils/logger.ts:3` esporta `REDACT_PATHS`: per ogni chiave in `['authKey','serverShare','passphrase','pin','codeA','codeB']`, i percorsi `k`, `*.k` e `*.*.k`.
  - Il logger condiviso usa `pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } })`.
  - `app.ts:41`: `logger: true` diventa `logger: { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }`, senza `level`, quindi resta il default `info` di oggi. `request.log` è un'istanza separata dal logger condiviso, quindi va configurata in entrambi.
- **Zod.** Nessun body delle route vault viene loggato. Il gestore di `app.ts:83-88` rimanda al client gli `issues` di Zod. Zod 4 (`package.json`: `^4.3.6`) non include l'input negli issues senza `reportInput`, e gli helper usano messaggi fissi. Lo verifica un test (RT-13).

### 5.3 Chiave root

- **Generazione:** con `vault:root-keygen` (§3.4), **sul server, dopo il deploy di P1**, da una console RDP interattiva.
- **Posizione consigliata:** `E:\NotiqSecrets\vault-root.json`.
- **Guardia sul path:** rifiuta qualsiasi path dentro `path.resolve(__dirname,'../../..')`, cioè `E:\www\Notiq` sul server e la root del repo in dev. Restano quindi esclusi:
  - i `/MIR` di `dist` e `prisma` (`Deploy-Server.ps1:158-159`) e della radice IIS (`:171`);
  - `_backup_<ts>` (`:78`, `:140-147`);
  - `backend/backups` (`backup.ts:4`);
  - git.
- **P1 non legge `VAULT_ROOT_KEY_PATH`.** Il controllo al boot dell'header del file (id fissati ⊆ `pub`, SPKI identici byte per byte, senza passphrase) arriva in P4 con `vaultRootKey.service`.
- **Chiavi pubbliche stampate:**
  - restano nel password manager, insieme allo sha256 del file, **fino al branch P2**;
  - in P2 vanno fissate nello stesso commit in `backend/src/utils/vaultRootKeys.ts` e `frontend/src/utils/vaultRootKeys.ts`, con un test di parità;
  - **mai** in una build che serve ancora il client legacy (RT-1).

---

## 6. Impatto deploy

**`Build-Package.ps1`: nessuna modifica.**
- Non include `.env` (`Build-Package.ps1:16`).
- Lo script di keygen viaggia in `dist/scripts`: è innocuo, perché senza TTY si rifiuta di partire.
- Prima di impacchettare: `git log --oneline v1.12.2..HEAD`, perché compila dal working tree.

**`Deploy-Server.ps1`: modifica piccola, solo se D3 = sì (T15).**
- **Pre-flight (`:98`):**
  - `throw` se `[Environment]::GetEnvironmentVariable('VAULT_PEPPER_KEY','Machine')` o `'User'` è valorizzata (rischio `pm2 save`);
  - `Write-Warn2` se `.env` non contiene `^\s*VAULT_PEPPER_KEY=`.
- **Passo 3 (`:143`):** copia il `.env` nel backup **senza** la riga `VAULT_PEPPER_KEY`, così il dump (`:123`) e il pepper non finiscono nella stessa cartella. Stampa inoltre un WARN "pepper non incluso nel backup: in caso di ripristino del `.env` va reinserito dal password manager" (RT-7).
- Il resto non cambia:
  - `npm ci --omit=dev` installa `hash-wasm` (WASM puro, nessuno script di install, quindi nessun avviso `allow-scripts`);
  - `migrate deploy` (`:180`) deve dire **1 migration**;
  - pm2 legge il pepper tramite dotenv, quindi niente `--update-env`.

**Runbook (amministratore singolo, Windows Server):**

1. **Locale.** Backend: `npm test`, `npx tsc --noEmit`, `npm run lint`.
2. **Locale, e2e.** Rieseguire `vault-overwrite`, `notes`, `sharing`, `collaboration`, `encryption`, `import` e `offline-first`. `collaboration.spec.ts:249` e `auth.spec.ts:41` sono instabili noti: confermare un eventuale FAIL con `git stash`.
3. **Pepper.** Generare il pepper (§5.1), salvarlo nel password manager (voce "Notiq VAULT_PEPPER_KEY", separata dai backup DB) e aggiungere `VAULT_PEPPER_KEY=<valore>` a `E:\www\Notiq\backend\.env`.
4. **Cartella della chiave root.** `mkdir E:\NotiqSecrets`, poi `icacls E:\NotiqSecrets /inheritance:r /grant:r "Administrators:(OI)(CI)F"` (in una PowerShell **elevata**, Esegui come amministratore, anche per la cerimonia del passo 7). Il permesso di lettura all'utente pm2 si aggiunge in P4, quando il processo leggerà il file.
5. **Pacchetto.** `Build-Package.ps1`, poi `Deploy-Server.ps1 -DryRun` (pre-flight senza errori), poi `Deploy-Server.ps1`. Controllare nel log del passo 7 che venga applicata **1** migration e che lo health check sia ok.
6. **Verifiche post-deploy:**
   - `pm2 logs notiq-backend --lines 80 | findstr "vault secrets"` → `vaultPepper:"ok"`. Annotare `pepperKeyId` accanto al pepper nel password manager.
   - Con un JWT di test: `GET /api/vault/keyring` → 200 `{status:'NONE'}`; `POST /api/vault/keyring` → 503.
   - `SELECT count(*) FROM "VaultKeyring"` = 0.
   - Verifica manuale in hard reload: login, nota, vault legacy, condivisione.
7. **Cerimonia root.** Da console RDP: `cd E:\www\Notiq\backend; npm run vault:root-keygen -- --out E:\NotiqSecrets\vault-root.json`. La passphrase, di almeno 20 caratteri, va in una voce **diversa** del password manager. Salvare l'output (sha256 + JSON `pub`) nel password manager.
8. **Copia offline.** Copiare il file cifrato fuori dal server, senza la passphrase accanto. Sulla copia: `node dist\scripts\vaultRootKeygen.js --verify <copia>` → stessi id.
9. **Chiavi pubbliche.** **Non** committarle ora: vanno nel branch P2.

**Rollback.**
- Si ripristina `dist` da `_backup_<ts>`. Il DB resta com'è (migration additiva).
- Il `.env` live non viene toccato dal deploy (`:166`). Se lo si ripristina dal backup, va reinserito il pepper.

---

## 7. File toccati e TIER

**⚠ Avviso multi-file (CLAUDE.md, "Avviso multi-file").** P1 tocca circa 25 file, elencati qui sotto. Tutti i file TIER richiedono **"proponi prima, applica dopo"**, la conferma esplicita dell'hook `tier1-guard` e, dopo `git add`, il gate con `reviewer` + `red-team` in parallelo (addendum Notiq: TIER in staging = `hardRisk`).

| TIER | File | Modifica | Approvazione |
|---|---|---|---|
| **1** | `backend/prisma/schema.prisma` | 4 enum, 2 modelli, 2 back-relation su `User` (`:84-86`), `VAULT_RECOVERY` (`:292`) | **Sì, esplicita** |
| **1** | `backend/prisma/migrations/20261001000000_vault_e2ee/migration.sql` (nuovo) | 10 statement della whitelist | **Sì, esplicita** |
| **2** | `backend/src/app.ts` | `:41` logger con redact; `register` dopo `:225`; una riga di log dopo `:309` | **Sì, esplicita** |
| **2** | `backend/src/services/email.service.ts` | `VAULT_LOCKOUT` nel tipo (`:61`), in `TRANSACTIONAL_EMAIL_TYPES` (`:64-67`) e come `case` nello switch (vicino a `:455`), testi it/en | **Sì, esplicita** |
| — | `backend/src/services/note.service.ts` | `:76` IDOR; `createNote` `:29-81`; `updateNote` `:203`, `:240-296` | No (critico: gate probabile high) |
| — | `backend/src/routes/notes.ts` | `:17-33` `baseHash` | No |
| — | `backend/src/services/noteVersion.service.ts` | `:85-111` | No |
| — | `backend/src/services/sharing.service.ts` | `:878` | No |
| — | `backend/src/routes/import.ts` | `:9-18`, `:34-43` | No |
| — | `backend/src/routes/attachments.ts` | `:34-37` | No |
| — | `backend/src/utils/logger.ts` | `:3` `REDACT_PATHS` | No |
| — | `backend/src/__tests__/setup.ts` | mock di `vaultKeyring`/`vaultRequest` nel mock Prisma (`:4-289`), `VAULT_PEPPER_KEY` di test (`:302-304`) | No |
| — | `backend/package.json` (+ lock) | `hash-wasm`, script `vault:root-keygen` | No |
| — | Nuovi: `services/vault.service.ts`, `routes/vault.ts`, `utils/vaultRootKeys.ts`, `utils/vaultRootKeyFile.ts`, `scripts/vaultRootKeygen.ts` + test | — | No (gate) |
| — | `frontend/src/locales/en.json`, `it.json` | solo `errors.notes.idConflict` | No |
| — | `deploy/Deploy-Server.ps1` | pre-flight + passo 3 (se D3) | No (ops: dry-run obbligatorio) |
| — | `CLAUDE.md` (Environment), design (§7.1:388), `.claude/skills/notiq-deploy/SKILL.md` | documentazione | No |

**Non toccati:** `hocuspocus.ts`, `syncService.ts`, `db.ts`, `crypto.ts`, `vaultStore.ts`, `api.ts`, `authStore.ts`, `Editor.tsx`, `auth.service.ts`, `utils/errors.ts`, `Build-Package.ps1`.

---

## 8. Task ordinati per subagent

Regole comuni:
- ogni task va a un subagent `model:"sonnet"` e tocca al massimo 3 file;
- ogni task si chiude con `cd backend && npm test && npx tsc --noEmit && npm run lint` verdi;
- poi `git add` → `node "$HOME/.claude/jev-gate.mjs"` → revisori secondo il gate;
- **cosa NON toccare:** i file "Non toccati" del §7;
- ordine vincolante: T1 prima di T5-T12 (tipi Prisma).

| # | File | Contenuto | Criteri di accettazione e test |
|---|---|---|---|
| **T1** ⚠T1 | `schema.prisma`, `migration.sql` | §2 | `npx prisma validate` ok. Su dev DB (`notiq-db`), prima di applicare, `migrate status` = esattamente 1 pending. `grep -nE 'DROP\|ALTER COLUMN\|tsvector\|searchVector\|RENAME\|"Note"\|"NoteVersion"' migration.sql` → nessun output. `grep -cE '^(CREATE\|ALTER) ' migration.sql` = 10. `migrate deploy`, poi `migrate status` pulito. `prisma generate` e test esistenti verdi |
| **T2** | `note.service.ts` (solo `:74-79`), `__tests__/note.service.test.ts` | Fix IDOR RT-9 | Test: P2002 su un id di un altro utente → `ConflictError('errors.notes.idConflict')`, nessun campo della nota altrui nella risposta. P2002 sul proprio id → restituisce la nota (idempotenza). **Spedibile anche se P1 slitta** |
| **T3** | `frontend/src/locales/en.json`, `it.json` | `errors.notes.idConflict` in entrambi | Chiave presente in entrambi i file; `npx tsc -p tsconfig.app.json --noEmit` verde |
| **T4** | `utils/logger.ts`, `__tests__/logger.redact.test.ts` | `REDACT_PATHS` (§5.2) | Il test costruisce `pino({redact:{paths: REDACT_PATHS}}, stream)` (il logger è mockato in `setup.ts:291`). Loggare `{body:{passphrase:'S3cr3t'}}`, `{authKey:'AAAA'}` e `{a:{b:{codeA:'X1'}}}` non lascia `S3cr3t`, `AAAA` o `X1` nello stream |
| **T5** | `services/vault.service.ts` (helper), `__tests__/setup.ts`, `__tests__/vault.service.test.ts` | Pepper, `parseEnvelope`, `sha256hex`, `getVaultGuard`, `assertVaultContent`, `verifyVkProof` | Pepper mancante, di 31 o 33 byte, o non base64url → `missing`/`invalid`; pepper valido → `keyId` stabile. Un pepper diverso dà un HMAC diverso. Envelope: accetta `nv3.0.<16>.<22+>`, rifiuta `nv3.x…`, `nv2.…`, JSON TipTap. Guard: nessuna riga → null; `NONE/0` → null; `READY` → `ready:true`; `RESET_PENDING` e `NONE/epoch 1` → `ready:false`. `assertVaultContent`, ordine plaintext → stale → conflict: 3 casi più "senza `baseHash` in update" → conflict. `vkProof` (chiave P-256 generata nel test, firma `ieee-p1363`): valida → ok; altro path, altro `rev` o `payload` modificato → 403 |
| **T6** | `vault.service.ts` (keyring), `utils/vaultRootKeys.ts`, `vault.service.test.ts` | `getKeyring`, `createKeyring`, `updateKeyring` | Con `VAULT_ROOT_KEYS` vuoto → 503 (**test "P1 lock"**: il modulo reale è `{}`; da rimuovere in P2). Con `vi.mock` di un `rk_test…`: due `create` concorrenti → 201 + 409 (il secondo riceve P2002, `updateMany` restituisce `count 0`). Il ramo fallback imposta `failedAttempts:0` e `lockedUntil:null`. `migrationState` = `IN_PROGRESS` se `legacyCount>0`. `getKeyring` non espone mai i 5 campi riservati e con nessuna riga non scrive. PUT firmato → rev+1; **replay** della stessa richiesta → 409; `rotate` → 400 |
| **T7** ⚠T2 | `vault.service.ts` (unlock), `email.service.ts`, `vault.service.test.ts` | §4.4 + template `VAULT_LOCKOUT` | Mock di `$queryRaw` che simula i contatori. Dal 1° al 5° errore → 403, nessuna email. Al 6° → `lockedUntil` a +15 min, `logEvent('vault.unlock.locked')`, email. Al 12° → 1 h, al 18° → 24 h. Con 0 righe restituite → 429. Successo → reset e `serverShare` restituito. `updateMany` con `count 0` → 429 senza `serverShare`. `pepperKeyId` diverso → 503 senza query di incremento. Il SQL contiene il predicato `lockedUntil` e `AT TIME ZONE 'UTC'`. **Concorrenza, manuale su dev DB:** riga READY inserita via SQL con `pepperKeyId` preso dal log di boot, poi 10 `POST /unlock` sbagliati in parallelo → esattamente 6×403 + 4×429, e `failedAttempts`=6 |
| **T8** | `vault.service.ts` (items/migrate/finalize), `vault.service.test.ts` | §3.2 | `getItems` restituisce solo note `isVault` del chiamante, paginazione con `after`. `migrate`: CAS diverso → `conflict` per quell'item, gli altri `ok`; snapshot `noteVersion.create` scritto **anche per un contenuto di 40 caratteri**; secondo giro → `already`. `finalize`: id non-envelope in `rejected`, `deleteMany` limitato agli accettati e `NOT startsWith 'nv3.'`, `legacyCount 0` → `DONE` |
| **T9** ⚠T2 | `routes/vault.ts`, `app.ts`, `routes/__tests__/vault.route.test.ts` | §3.1 + registrazione, redact e log di boot in `app.ts` | Nessuna riga → `GET /keyring` 200. Pepper mancante → 503 su tutte e 6 le route e **l'app parte comunque** (`health.route.test.ts` verde). Lunghezze Zod errate → 400, e il body della risposta **non contiene** la stringa inviata (RT-13). Nessuna route vault risponde 401 con un JWT valido. `POST /migrate` accetta 2 MiB (`bodyLimit`) |
| **T10** | `note.service.ts` (create/update), `notes.ts`, `note.service.test.ts` | §4.3 | **Senza keyring:** PUT in chiaro di una nota vault legacy passa, e passa anche con `VAULT_PEPPER_KEY` assente; il percorso usa ancora `tx.note.update` e restituisce la riga (RT-5); `baseHash` inviato da un client legacy non rompe Prisma. **Con READY:** plaintext → 422 `plaintextRejected`; `baseHash` sbagliato → 422 `conflict`; epoch vecchia → 422 `stale`; envelope di 120 caratteri **persistito**; `updateMany count 0` → 422; solo `isTrashed`/`isPinned`/`tags` su una nota vault → 200 senza `baseHash` (RT-4); `title:'x'` → 422; ingresso senza `content` → 422; uscita con envelope → 422 `plaintextRequired`; uscita con plaintext corto non scartato dal guard dei 150 caratteri |
| **T11** | `noteVersion.service.ts`, `sharing.service.ts`, `__tests__/vaultBypasses.test.ts` | §4.3 | Restore di una versione non-envelope con READY → 422; senza keyring → invariato. Restore con READY di un envelope corrente → titolo `''`. `updateSharedNoteContent`: la scrittura porta `isVault:false` e `count 0` → 403 |
| **T12** | `import.ts`, `attachments.ts`, `routes/__tests__/vaultGuards.route.test.ts` | §4.3 | Import con `?isVault=true` e READY → 422 **senza** chiamare `request.file()`/il service. Upload su una nota vault del proprietario con READY → 422. Senza keyring entrambi passano; `import.route.test.ts` e `attachments.route.test.ts` restano verdi |
| **T13** | `package.json` (+lock), `utils/vaultRootKeyFile.ts`, `__tests__/vaultRootKeyFile.test.ts` | §3.4 libreria | Test con `kdfParams {m:8192, t:1, p:1}`: la passphrase giusta apre, quella sbagliata lancia un errore; un byte alterato nell'header o in `ct` → errore; il file non contiene il prefisso DER PKCS#8 (`3081b6020100` / ricerca del `0201 00` iniziale); una mappa con 2 id apre entrambi; ECDH seal/unseal ed ECDSA sign/verify con le chiavi decifrate; `assertPathOutsideApp('<repo>/backend/x.json')` → errore; sovrascrittura rifiutata. Vettore noto Argon2id `hash-wasm` fissato (riusato in P2) |
| **T14** | `scripts/vaultRootKeygen.ts` | CLI §3.4 | Manuale in dev: `npm run build`, poi `node dist/scripts/vaultRootKeygen.js --out D:\tmp\vr.json` → id stampato. `--verify D:\tmp\vr.json` → stesso id. `--out` dentro il repo → errore. Senza TTY (`echo \| node …`) → errore. Nessun parametro in argv o env per la passphrase |
| **T15** (se D3) | `deploy/Deploy-Server.ps1` | §6 | `-DryRun` su una copia locale: WARN se il pepper manca; `throw` con `VAULT_PEPPER_KEY` in env utente; nel backup, `backend\.env` senza riga pepper e con il WARN stampato |
| **T16** | `CLAUDE.md`, design, `.claude/skills/notiq-deploy/SKILL.md` | Blocco Environment: `VAULT_PEPPER_KEY` (+ `VAULT_ROOT_KEY_PATH` "da P4"); design:388 aggiornato secondo D1; §7.2 `POST /vault/items`; runbook §6 nella skill | Revisione testuale |

---

## 9. Rischi residui

1. **Chiavi root fissate per errore prima di P2.** Con un JWT rubato si potrebbe creare un keyring: il client legacy riceverebbe 422 terminali, lo sblocco avverrebbe col PIN dell'attaccante e non esiste ancora un reset. Mitigazioni:
   - 503 finché la mappa è vuota;
   - test "P1 lock" (T6);
   - D2, password dell'account obbligatoria.
2. **Concorrenza del lockout dimostrata solo a mano.** Non esiste un'infrastruttura di test su DB reale: `setup.ts` mocka Prisma. Serve la verifica manuale di T7, oppure, in futuro, un test di integrazione.
3. **Rollback della migrazione (RT-6).** Con READY, `restore` rifiuta le versioni in chiaro e l'uscita dal vault richiede un plaintext che il client con un envelope rotto non ha. Il rollback di una nota migrata è quindi **solo amministrativo** (D4): SQL che riporta `NoteVersion.content` in `Note` con `isVault=false`, `isEncrypted=false`, prima di `finalize`.
4. **`bodyLimit` di `PUT /api/notes/:id` in P2.** L'envelope gonfia il contenuto di circa 1,37 volte. Una nota vicina a 1 MiB darà 413 in P2. Da decidere in P2: alzare `bodyLimit` su quella route oppure mettere un tetto dichiarato.
5. **Perdita del pepper.** Nessuno sbloccherebbe più online; restano la cache offline e Kit + root. Mitigazioni: copia nel password manager e `pepperKeyId` annotato. La rotazione non è costruita.
6. **Pepper e dump nello stesso albero.** Anche con T15 il `.env` live sta sotto `E:\www\Notiq`, con la stessa ACL dei `_backup_*`. La garanzia "un leak del solo DB non basta" vale solo per le copie fuori dal server.
7. **Incognite ops:**
   - account Windows con cui gira pm2 (serve per l'ACL in P4);
   - se i backup di sistema (Veeam o simili) includono `E:\NotiqSecrets` (il file è cifrato, ma design:108 lo vuole fuori dai backup).
8. **`hash-wasm` blocca l'event loop** per circa 1-3 s a 256 MiB: irrilevante per la CLI, ma il rilascio in P4 richiede `worker_threads`. Servono 256 MiB di RAM liberi durante la cerimonia.
9. **Drift di `migrate dev`.** Mitigato dalla whitelist di T1.
10. **Stati P3 e P4.** Il guard tratta già `RESET_PENDING` e `NONE/epoch>0` come "non legacy" (422 `notReady`/`stale`), quindi P3 non riapre il plaintext. Per `updateNote` P3 dovrà comunque aggiungere il blocco dei metadati in `RESET_PENDING`.

**Tracciabilità dei finding del red team:**

| Finding | Correzione in questo piano |
|---|---|
| RT-1 SERIOUS: chiavi root fissate prima di P2 | §4, §5.3; 503 con mappa vuota; test "P1 lock"; D2 |
| RT-2 SERIOUS: `GET /items?ids=` | `POST /items` paginato (§3.1) |
| RT-3 SERIOUS: corsa sul lockout | UPDATE atomico con `RETURNING` + successo condizionato (§4.4) |
| RT-4 SERIOUS: `baseHash` e titolo sui soli metadati | Controlli solo con `content`, o con `title` non vuoto (§4.2-4.3, T10) |
| RT-5: tipo di ritorno di `updateMany` | Solo nel ramo READY con `content`; il legacy resta `update` |
| RT-6: rollback | Solo amministrativo, documentato (D4, rischio 3) |
| RT-7: pepper escluso dal backup | Strip + WARN + pre-flight sull'env di macchina (T15) |
| RT-8: incoerenze tra i due piani | Una sola derivazione HKDF; `utils/vaultRootKeys.ts`; libreria e CLI separate |
| RT-9: P2002 → 500 | `ConflictError('errors.notes.idConflict')` (T2) |
| RT-10: fallback di `POST /keyring` | Azzera contatori, lock e tutti i campi (§3.2) |
| RT-11: drift della migration | Whitelist con grep in T1 |
| RT-12: 1 MiB su migrate | `bodyLimit` 16 MiB + contratto per P2 |
| RT-13: lacune nei test | Test Zod senza eco dell'input, pepper mancante → 503 con PUT legacy verde, concorrenza manuale |

---

## 10. Decisioni richieste all'utente

1. **D1: pepper mancante o malformato → il boot continua e le route vault rispondono 503**, invece di "il boot fallisce" (design:388).
   - Raccomandazione: **sì**. Fermare il boot manderebbe giù tutta l'app per una funzione che nessun client usa ancora. Il 503 non conta come tentativo di PIN sbagliato.
2. **D2: password dell'account obbligatoria su `POST /vault/keyring`** (campo `password`, `bcrypt.compare`, già 5/h).
   - Raccomandazione: **sì, sempre**, da implementare in T6. Chiude il sequestro del vault con un JWT rubato (RT-1), che altrimenti in P2 resta aperto finché non arriva il reset di P3. È un cambio al design §7.2.
3. **D3: pepper sul server già in P1, con lo strip dal backup `.env` in `Deploy-Server.ps1` (T15).**
   - Raccomandazione: **sì**. P2 diventa un rilascio solo client e il log di boot conferma `pepper: ok` prima che qualunque dato dipenda dal pepper.
   - Alternativa: generarlo ora e installarlo solo con P2. In quel caso T15 si sposta in P2.
4. **D4: rollback delle note migrate solo amministrativo** (SQL da runbook), senza aprire un'API "ripristina il plaintext uscendo dal vault".
   - Raccomandazione: **sì**. L'API sarebbe un percorso di scrittura in chiaro in più, da difendere per un caso raro. Lo snapshot forzato resta comunque nel DB fino a `finalize`.

---

## Addendum dopo la review di T1 (2026-09-30)

Finding del red team sulla migration: nessuno richiede di modificarla. Vincoli per le fasi successive:

1. **Una sola richiesta aperta per (userId, type).** Il DB non la impone: un indice unico parziale non si puo' modellare in Prisma e produrrebbe deriva permanente. In P3 e P4 la creazione di una `VaultRequest` DEVE avvenire dentro `$transaction` con `SELECT ... FROM "VaultKeyring" WHERE "userId"=$1 FOR UPDATE` prima del controllo di esistenza, mai con un semplice `findFirst` seguito da `create`.
2. **Audit delle azioni di root sotto l'attore.** `AuditLog.userId` va in cascata con l'utente: se un SUPERADMIN cancella l'utente, le righe a suo nome spariscono. Le azioni amministrative (approve, reject, release) si registrano con `logEvent(adminId, 'vault.recovery.<azione>', { targetUserId, requestId })`, non sotto l'utente destinatario.
3. **Deploy della migration (runbook §6).** Prima del deploy controllare che nessuna sessione tenga lock su `"User"` (`SELECT pid, state, query FROM pg_stat_activity WHERE datname = '<db>' AND state <> 'idle'`), perche' Prisma non imposta `lock_timeout` e il passo 7 resterebbe appeso con pm2 fermo. Se `migrate deploy` fallisce, prima di riprovare: `npx prisma migrate resolve --rolled-back 20261001000000_vault_e2ee`, altrimenti ogni deploy successivo fallisce con P3009.
4. Commento dello stato del reset in `schema.prisma` (`PENDING_CODE -> COMPLETED | EXPIRED`): va aggiornato in P3 quando si definisce l'annullamento (`CANCELLED`). Solo commento, nessuna migration.

## Addendum dopo la review di T6 (2026-09-30)

Deviazioni dal piano accettate dopo reviewer + red-team, e vincoli per i task successivi:

1. **`authVerifier` legato all'utente.** `authVerifier = HMAC-SHA256(verifierKey, utf8(userId) ‖ "|" ‖ authKey)`. Senza lo userId, chi ha accesso in scrittura al DB (ma non al pepper) potrebbe copiare il proprio `authVerifier` sulla riga della vittima e ottenere con `POST /unlock` il `serverShare` della vittima. Nessuna riga esiste ancora, quindi il cambio non richiede migration. T7 DEVE usare `authVerifierOf(userId, authKey)` (oggi interno a `vault.service.ts`), mai un HMAC ricalcolato a mano.
2. **`PUT /keyring` con `wrap` e pepper diverso.** Se `row.pepperKeyId` è diverso dall'id corrente → 503 `errors.vault.pepperMismatch`, prima di qualunque scrittura. Altrimenti il nuovo `authVerifier` sarebbe sotto il pepper nuovo e `serverShareEnc` sotto il vecchio: riga irrecuperabile.
3. **Audit della password errata** su `createKeyring`: `vault.keyring.passwordRejected`, senza details.
4. `rev` nel payload di `PUT` limitato a `2147483646` (int4 meno 1, così `rev+1` non va in overflow). `VAULT_ROOT_KEYS` è `Object.freeze({})`.
5. **Per T9 (route `POST /keyring`):** `expectedEpoch` validato come intero `0..2147483647` (altrimenti Prisma dà 500). Il service è già pronto a riusare `b64url` e `keyringUpdatePayloadSchema`.
6. **Per P3:** con la riga `NONE/epoch N` dopo un reset, un client che manda `expectedEpoch` sbagliato riceve 409 `alreadySetup`. Il client P2/P3 deve rileggere `GET /keyring` su 409 prima di riprovare; valutare in P3 un codice distinto.

## Addendum dopo la review di T7 (2026-09-30)

1. **429 `locked` senza `lockedUntil` nel body** (decisione utente). Il gestore globale (`app.ts:77-78`) manda solo `message`; il client legge `lockedUntil` da `GET /keyring`. Il §4.4 ("restituendo `lockedUntil` letto") è superato su questo punto: T9 non deve reintrodurlo.
2. **`lockedUntil` scaduto resta sulla riga** dal 7° all'11° tentativo (il `CASE` fa `ELSE "lockedUntil"`), quindi `GET /keyring` può esporre una data passata. Il server confronta sempre con `now()`, quindi è corretto. Il client P2 DEVE trattare `lockedUntil <= now` come sbloccato.
3. **Email di lockout fire-and-forget**, compresa la lettura dell'utente: nessun errore DB o SMTP cambia il 403 di un tentativo già contato. `VAULT_LOCKOUT` è transazionale.
4. **Percorso di successo legato all'epoch:** l'`updateMany` di azzeramento include `epoch: row.epoch`. Un reset più un nuovo setup tra la lettura e l'azzeramento dà 429, non il `serverShare` della vecchia epoch.
5. **Verifica di concorrenza manuale** (10 `POST /unlock` sbagliati in parallelo, quindi 6×403 + 4×429 e `failedAttempts=6`): resta obbligatoria e si fa subito dopo T9, sul DB dev. I test unitari non la possono dimostrare.

## Addendum dopo la review di T9 (2026-09-30)

1. **Rate limit per utente sulle route vault.** `config.rateLimit` con `keyGenerator: req => req.user.id`, nella fase `onRequest` dopo `authenticate` e prima del parsing del body. Motivo: in `app.ts` `trustProxy: true` più `allowList: ['127.0.0.1','::1']` rende il limite per IP aggirabile con `X-Forwarded-For: 127.0.0.1` (IIS ARR accoda l'header, non lo sostituisce). Il difetto globale resta aperto per le altre route (anche `/auth/login`): task separato, fuori da P1.
2. **Body malformati.** Error handler con scope sul plugin vault: gli errori `FST_ERR_CTP_*` rispondono con il loro status (400/413/415) e body fisso `errors.vault.invalidPayload`; tutto il resto risale all'handler globale. Difesa in profondità: Fastify 5.7 già non rimanda frammenti del body.
3. **`/migrate`:** `content` di ogni item ≤ 2 MiB (oltre al `bodyLimit` di 16 MiB del batch).
4. **Limite noto:** le richieste non autenticate verso `/api/vault/*` non sono limitate (il limite della route sostituisce quello globale per IP e gira dopo `authenticate`). Come ogni altra route con `config.rateLimit`; da risolvere nel task globale del rate limit.
5. **Verifica live su DB dev (30/09):** boot `vaultPepper: ok`; `GET /keyring` 200 NONE; `POST /keyring` 503 (lock P1); 10 `POST /unlock` sbagliati in parallelo → 6×403 + 4×429, `failedAttempts=6`, lock 15 min UTC; PIN giusto durante il lock → 429; dopo il lock → 200 con `serverShare` corretto; mai 401; boot senza pepper → app su, vault 503.

## Addendum dopo la review di T10 (2026-09-30)

1. **Versioni in chiaro all'ingresso nel vault (decisione).** Con keyring READY, `PUT isVault:true` salva ancora lo snapshot in chiaro e non cancella le versioni in chiaro precedenti. È voluto: sono l'unico rollback se l'envelope del client è rotto. **Contratto P2:** dopo uno spostamento nel vault, il client decifra di nuovo quello che ha scritto e, se coincide, chiama `POST /api/vault/finalize` con l'id; `finalize` cancella le versioni in chiaro. Fino ad allora `GET /notes/:id/versions` le mostra al proprietario.
2. **Snapshot sotto i 150 caratteri** (`noteVersion.service.ts:29`): all'ingresso nel vault o in un overwrite CAS di un contenuto corto non resta una versione precedente. Accettato: il client P2 verifica il round-trip prima della PUT. `/migrate` invece fa sempre lo snapshot.
3. **TOCTOU** tra una PUT su nota normale (guard `null`, `tx.note.update`) e uno spostamento nel vault concorrente dello stesso utente: la PUT può riscrivere plaintext sull'envelope. Non chiuso, perché aggiungere `isVault:false` al `where` romperebbe l'invariante "byte-identico senza keyring". Richiede lo stesso utente in gara con sé stesso su due dispositivi. Da rivalutare in P2.
4. **Regole aggiunte dalla review:** uscita dal vault con keyring non READY → 422 `notReady`; su una nota che resta nel vault `isEncrypted:false` → 422 `plaintextRejected` (anche senza `content`); l'uscita forza `isEncrypted=false` e ricalcola `searchText` solo per le note `NOTE`.
5. **Ordine di rilascio:** T11 (restore, `updateSharedNoteContent`) e T12 (import, allegati) devono essere in `main` prima che possa esistere un keyring READY. In P1 il lock (`VAULT_ROOT_KEYS` vuota) lo garantisce.
6. **Deploy:** la migration `20261001000000_vault_e2ee` deve essere applicata prima dell'avvio del nuovo backend, altrimenti ogni PUT su una nota vault dà 500 (P2021 su `VaultKeyring`). `Deploy-Server.ps1` fa `migrate deploy` (passo 7) prima di `pm2 start`: ordine corretto.

## Addendum dopo la review di T11 e T12 (2026-09-30)

1. **Ingresso nel vault di una nota con allegati (aggiunto).** Con keyring, `PUT isVault:true` su una nota che ha righe `Attachment` → 422 `errors.vault.attachmentsBlocked`. Motivo: i file restano in chiaro in `uploads/` e il design esclude gli allegati dal vault. Si rifiuta invece di cancellare, così non si perde niente. Senza keyring il comportamento non cambia. **Per P2:** le note vault legacy che hanno già allegati (caricati prima del keyring) vanno gestite dalla migrazione client, per esempio saltandole e segnalandole; decisione da prendere nel piano P2.
2. **Race note, non chiuse (stessa classe di addendum T10 #3):**
   - restore di una versione mentre la stessa nota entra nel vault da un altro dispositivo: la `update` scrive plaintext, titolo e `searchText` sull'envelope;
   - upload di un allegato da parte di un collaboratore WRITE mentre il proprietario sposta la nota nel vault;
   - in `updateSharedNoteContent` lo snapshot del vecchio contenuto avviene prima dell'`updateMany` condizionato: se la nota entra nel vault in quella finestra, resta una versione in chiaro (di contenuto già in chiaro).
   Chiuderle richiede `updateMany` condizionati su percorsi senza keyring, quindi di rompere l'invariante "byte-identico". Da rivalutare in P2.
3. **Restore di un envelope su una nota già uscita dal vault:** scrive l'envelope come contenuto con titolo vuoto. Solo integrità/UX, nessun impatto sulla riservatezza. Da gestire lato client in P2 (il client non propone versioni envelope su note non vault).
4. `updateSharedNoteContent` su una nota cancellata tra lettura e scrittura ora risponde 403 invece di 500 (P2025): innocuo.
5. Nessun altro scrittore di `Note.content`/`title` aperto: verificato da reviewer e red-team (hocuspocus P0, import dietro `import.ts`, migrate, toggleShare, notebook delete, script di manutenzione).
