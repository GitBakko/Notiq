# Notiq

Offline-first note-taking PWA con real-time collaboration, encrypted vault e invitation-based auth.
Full-stack TypeScript monorepo. **Live su `notiq.epartner.it`** (IIS + pm2).

Stack e script: vedi `backend/package.json` e `frontend/package.json` (incluso `type` per il module system di ciascun workspace).
**Versione app:** `frontend/package.json` è la single source of truth (importata da `frontend/src/data/changelog.ts`).

> Le linee guida **Mobile UI / PWA** stanno in `frontend/CLAUDE.md` (si caricano lavorando sotto `frontend/`).

## Comandi non ovvi

Gli script standard (`dev`, `build`, `lint`, `test`) sono nei rispettivi `package.json`. Questi invece non sono indovinabili:

```bash
# Backend (cd backend)
npm run prune                            # Clean orphan attachments
npm run backup                           # ZIP backup (DB + files)
npx tsx src/scripts/testSmtp.ts <email>  # Test SMTP
```

> Nota: `npx prisma` legge `prisma.config.js` che fa `require('dotenv').config()`, quindi richiede che `backend/.env` esista.
> Prisma 7 CLI: niente flag `--schema` (usa `prisma.config.js`), e `db execute --file` non `--stdin`.

## Architettura

```
Routes (Zod validation) → Services (business logic) → Prisma (PostgreSQL)
                                                       ↕
Frontend: Dexie (IndexedDB) ← syncPull/syncPush → REST API (/api/*)
          TipTap Editor     ← HocuspocusProvider → WebSocket (/ws)
          ChatContext       ← WebSocket nativo   → WebSocket (/chat-ws)
          Zustand stores    ← persist middleware  → localStorage
```

**Data flow note:** User types → Dexie write (immediato) → SyncQueue → syncPush (debounced) → REST API → Prisma.
**Collab flow:** TipTap → Yjs → HocuspocusProvider → WebSocket → Hocuspocus Server → TipTap JSON → Prisma.
**Auth flow:** Register → email verifica → verify-email → login → JWT → `authStore` (Zustand persisted) → Axios interceptor auto-attacca token.
**Chat flow:** ChatPage → `ChatContext` (UNA sola connessione WS per pagina) → `/chat-ws` → `chatWebSocket.ts` → Prisma. Chat è **online-only** by design (no Dexie). REST prefix: `/api/chat-direct` (NON `/api/chat`, che è la chat a livello nota).

**Vault flow (v3, E2EE; sul branch `feat/vault-p2`, non in prod finché non c'è il rilascio P2):** PIN → Argon2id (Worker) → `authKey` → `POST /api/vault/unlock` → `serverShare` → `KEK_pin` → unwrap di VK (in memoria, CryptoKey non-extractable) → `K_note` per nota (HKDF) → envelope `nv3.<epoch>.<iv>.<ct>`. Il server non vede mai il plaintext. In Dexie, syncQueue e server c'è solo l'envelope (titolo `''`); il plaintext vive in memoria (`vaultCodec`). Sblocco offline con `shareEnc` cifrato dalla chiave del dispositivo (IndexedDB `notiq-vault-device`). Il setup scrive anche l'escrow (Kit Crockford `S_user` + share root sigillata); la procedura di recupero con la root è P4 e il reset è P3, entrambi non ancora fatti. Spec: `docs/superpowers/plans/2026-09-30-vault-v3-design.md` e `2026-10-02-vault-p2-plan.md`.

**Due WebSocket distinti, entrambi gestiti nell'upgrade event di `app.ts`:** `/ws` = Hocuspocus (collab editor), `/chat-ws` = chat system.

### File chiave

| Cosa | Path |
|------|------|
| Server entry | `backend/src/app.ts` (port 3001, route + upgrade WS su `/ws` e `/chat-ws`) |
| DB schema | `backend/prisma/schema.prisma` (+ `prisma/migrations/`) |
| Collab server | `backend/src/hocuspocus.ts` (re-esporta `extensions`, che stanno in `backend/src/utils/ydoc.ts` e DEVONO matchare Editor.tsx) |
| Chat WS server | `backend/src/chatWebSocket.ts` (protocollo message/reaction/typing/read/presence) |
| Chat context FE | `frontend/src/features/chat/` (`ChatContext` = singola connessione WS; i componenti usano `useChatContext()`) |
| Prisma client | `backend/src/plugins/prisma.ts` (singleton, pg adapter) |
| Logger | `backend/src/utils/logger.ts` (Pino shared; nelle route usare `request.log`) |
| SMTP config | `backend/.env` (variabili `SMTP_*`, lette da `email.service.ts`) |
| Prisma config | `backend/prisma.config.js` (carica dotenv, definisce datasource) |
| Frontend entry | `frontend/src/main.tsx` (React 19, QueryClient, BrowserRouter, SW) |
| Route/pagine | `frontend/src/App.tsx` (protette dentro `<AppLayout />`, pubbliche fuori) |
| Sync engine | `frontend/src/features/sync/syncService.ts` (syncPull + syncPush) |
| Offline DB | `frontend/src/lib/db.ts` (Dexie — MAI modificare versioni esistenti, solo aggiungerne) |
| API client | `frontend/src/lib/api.ts` (Axios + JWT interceptor + 401 auto-logout) |
| Crypto legacy | `frontend/src/utils/crypto.ts` (CryptoJS AES/PBKDF2, PIN come chiave diretta). Non cifra più il vault: serve ai blocchi cifrati dell'editor (`EncryptedBlockComponent`) e alla decifratura delle credenziali vecchie nel wizard di migrazione |
| Vault v3 crypto | `frontend/src/utils/vaultCrypto.ts` (WebCrypto: KEK, wrap di VK, envelope, vkProof, rootshare; funzioni pure), `utils/argon2.ts` + `argon2.worker.ts` + `argon2Core.ts` (Argon2id in un Worker, `DEFAULT_KDF`), `utils/vaultKit.ts` + `kitPdf.ts` (Kit Crockford e PDF a mano), `utils/vaultRootKeys.ts` (chiavi pubbliche root, parità col backend) |
| Vault v3 sessione | `frontend/src/lib/vaultSession.ts` (setup, sblocco online/offline, cambio PIN, Kit), `lib/deviceKeyStore.ts` (chiave del dispositivo, `shareEnc`, marker pending senza segreti), `lib/vaultApi.ts` (client di `/api/vault/*`, mai 401 atteso), `lib/apiCache.ts` (`purgeApiCache`) |
| Vault v3 dati | `frontend/src/lib/vaultCodec.ts` (encrypt/decryptItem, cache in memoria), `lib/vaultReconcile.ts` (`decide` pura + prepare/commit per nota), `lib/vaultNoteLock.ts` (Web Lock), `lib/vaultMove.ts` (dentro/fuori dal vault, solo online) |
| Vault v3 UI | `frontend/src/features/vault/` (`VaultPage` = macchina a stati `Gate` (loading/unknown/unavailable/none/ready/resetPending/setupDisabled, `VaultPage.tsx:43-49`; lo sblocco è fuori dal Gate), Setup, Unlock, Migrate + `vaultMigration.ts` + `legacyDecrypt.worker.ts`, `VaultNoteEditor`, `VaultSettingsSheet`, `RecoveryKitSheet`, `PinPolicy`), `components/vault/` (`VaultUnlockDialog`, `VaultSettingsSection`), `features/admin/VaultBenchPage.tsx` (benchmark Argon2id, solo SUPERADMIN, rotta `admin/vault-bench` FUORI da `<AppLayout />`) |
| Vault v3 server | `backend/src/routes/vault.ts` + `services/vault.service.ts` (keyring, unlock con lockout, items/migrate/finalize, kill switch `VAULT_SETUP_USERS`, `KDF_T_MIN`), `utils/vaultSeal.ts` (sigillo della share root, lo userà P4), `utils/vaultRootKeys.ts` (chiavi pubbliche root; con la lista vuota `POST /keyring` risponde 503) |
| Auth store | `frontend/src/store/authStore.ts` (Zustand persisted, key: `auth-storage`) |
| UI store | `frontend/src/store/uiStore.ts` (theme, sidebar, sort — persisted localStorage) |
| IIS routing | `frontend/public/web.config` (URL Rewrite per /api, /uploads, /ws, /chat-ws) |

### Convenzioni

- **Route backend:** default export async function (Fastify plugin). Protette con `{ onRequest: [fastify.authenticate] }` → popola `request.user: { id, email, role }`.
- **Service backend:** named exports. Lanciano `Error` con chiavi i18n per messaggi utente (es. `auth.errors.userExists`).
- **Feature frontend:** `features/<domain>/` contiene Page + service + hooks. Non cross-importare tra feature dirs.
- **Componenti:** default exports, PascalCase file. UI primitives in `components/ui/`.
- **i18n:** TUTTE le stringhe utente via `t('key')`. Aggiungere SEMPRE a `en.json` E `it.json`.
- **Styling:** Tailwind utilities + `clsx()`. SEMPRE aggiungere varianti `dark:`.
- **Nuovo entity Dexie:** incrementare version in `db.ts`, aggiungere in syncPull + syncPush.
- **Mutation local-first:** se `mutationFn` scrive su Dexie, spreddare `...LOCAL_FIRST` (`lib/networkMode.ts`) nell'oggetto passato a `useMutation`/`useQuery` — senza, TanStack Query la mette in pausa offline e la mutation semplicemente non gira.
- **Nuova TipTap extension strutturale:** DEVE essere aggiunta sia in `Editor.tsx` CHE in `utils/ydoc.ts` (backend).
- **Chat components:** usare `useChatContext()` dal `ChatContext` condiviso, MAI aprire una connessione WS diretta per componente.
- **Nuova sottocartella `uploads/`:** richiede route esplicita in `app.ts` (gli static file NON sono serviti con wildcard).
- **Vault v3, plaintext:** il plaintext di note e credenziali vault esiste solo in memoria. Mai in Dexie, localStorage, syncQueue, Cache Storage o log. Su una riga `isVault` Dexie e coda hanno solo envelope `nv3.` e `title: ''`. `noteService` rifiuta le scritture in chiaro su righe vault e ogni cambio di `isVault` (lo cambia solo `lib/vaultMove.ts`, online).
- **Vault v3, Web Lock** (`lib/vaultNoteLock.ts`, nome `notiq-vault-note:<id>`): `shared` per editor e form aperti e per la push di una nota vault (`ifAvailable`); `exclusive` con `ifAvailable` per il commit per nota del reconcile e per il flip `isVault` della pull. Il giro del reconcile sta sotto `notiq-vault-reconcile`, in attesa. Senza `navigator.locks` il reconcile fa solo REQUEUE e finalize. Mai tenere `exclusive` da un editor: bloccherebbe la push della nota aperta.
- **Vault v3, chi ha stato non salvato** si registra con `useVaultStore.getState().registerPreLock(fn)`. `lockVault()` azzera le chiavi e poi chiama i flusher con il contesto catturato `{ keys, userId, epoch }`: non leggere `userId`/`epoch` dagli store, e scrivere solo in locale (Dexie + syncQueue), mai via REST (al logout il token non c'è più).
- **Vault v3, Dexie:** nessuna versione nuova. `vaultBaseHash` e `vaultSentHashes` sono campi non indicizzati di `LocalNote` (`db.ts:45,47`); la pull li preserva.
- **Vault v3, cache del SW:** `/api/vault/*` e tutto `/api/notes/` non devono entrare in `api-cache`. Il predicato in `vite.config.ts:67` resta INLINE e senza riferimenti esterni (generateSW lo serializza con `toString()`). Le risposte `/api/vault/*` hanno `Cache-Control: no-store`.
- **Vault v3, kill switch e KDF:** `VAULT_SETUP_USERS` (vuoto o assente = nessuno, `*` = tutti, altrimenti lista di userId separata da virgole) è letto a ogni chiamata in `vault.service.ts:158-161`; chiude solo la creazione del keyring (`POST /keyring` → 503 `setupDisabled`; `GET /keyring` → `setupAllowed:false`); chi ha già un keyring READY continua a migrare (`/migrate`, `/items`, `/finalize` guardano solo `guard.ready`). `DEFAULT_KDF` (`utils/argon2.ts:4`) e `KDF_T_MIN` (`vault.service.ts:199`, usata da `routes/vault.ts:16` e `vault.service.ts:302`) si cambiano nello STESSO commit.
- **Hocuspocus `store()` non deve mai lanciare** (`backend/src/hocuspocus.ts`): nel debouncer di Hocuspocus 3.4.4 una run rifiutata lascia una voce stantia e ogni store successivo dello stesso doc fallisce. Un errore di persistenza si logga e, con `context.flush`, imposta `context.flushFailed`; è `flushLiveDoc` a lanciare, dopo il disconnect.

### Environment

```
# backend/.env (dotenv caricato da prisma.config.js e app.ts)
DATABASE_URL="postgresql://user:pass@localhost:5433/evernote_clone?schema=public"
JWT_SECRET="secret"
FRONTEND_URL="http://localhost:5173"
LOG_LEVEL="info"
VAULT_PEPPER_KEY=<32 byte random base64url, 43 caratteri>   # vault v3 (P1): senza, /api/vault/* risponde 503; MAI nell'env di macchina/utente
VAULT_SETUP_USERS=                                           # kill switch del setup vault v3: vuoto/assente = chiuso (503 setupDisabled), "*" = tutti, o userId separati da virgola (canary). Lo legge ogni chiamata; con dotenv serve comunque pm2 restart
# VAULT_ROOT_KEY_PATH=E:\NotiqSecrets\vault-root.json        # da P4 (non letto in P1)

# SMTP (lette da email.service.ts)
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password
SMTP_SECURE=false
SMTP_FROM_NAME=Notiq
SMTP_FROM_EMAIL=notiq@epartner.it

# frontend/.env.production
VITE_API_URL=/api
VITE_WS_URL=wss://notiq.epartner.it/ws
VITE_VAPID_PUBLIC_KEY=<your-vapid-public-key>
```

Dev proxy (vite.config.ts): `/api` → `:3001`, `/uploads` → `:3001`, `/ws` e `/chat-ws` → `ws://:3001`.

### Docker

- **Dev DB:** container Docker `notiq-db` su porta 5433 con volume `evernote_postgres_data` (PostgreSQL 15)
- **Dockerfiles:** Node 22-alpine (Prisma 7 richiede Node 20.19+). Backend Dockerfile include `prisma generate` esplicito.
- **Attenzione:** `docker compose up` avvia un backend sulla porta 3001 che intercetta il proxy Vite dev. Fermare i container Docker (`docker compose down`) quando si usa il dev locale.
- Entry point backend Docker: `dist/app.js` (non `dist/index.js`)

### Deploy produzione

Usa la skill `/notiq-deploy` — copre gli script PowerShell (`Build-Package.ps1` locale + `Deploy-Server.ps1` sul server), i path fisici IIS e i gotcha robocopy/pg_dump. I vecchi `pre-install.cmd`/`post-install.cmd` sono superati: **non fanno il dump del DB**. Il rilascio del vault v3 (P2) ha un runbook dedicato nella stessa skill (sezione "Rilascio vault P2"): due deploy possibili, canary con `VAULT_SETUP_USERS`, punto di non ritorno al primo keyring READY.

### Vincoli di schema (leggere `schema.prisma` per i modelli)

**Nota chat:** `ChatMessage` (chat a livello nota) e `DirectMessage`/`KanbanBoardChat` sono intenzionalmente separati — non unificare. `Friendship` usa ID ordinati (`userAId < userBId` sempre) per evitare duplicati.

### Campi notevoli su User

`color String?` — colore persistente assegnato alla registrazione, usato per awareness collaboration e chat. Palette di 15 colori predefiniti in `auth.service.ts`.

---

## AREE CRITICHE

Non modificare questi file senza revisione esplicita dell'impatto.

### TIER 1 — Rischio data loss / corruzione

| File | Motivo |
|------|--------|
| `frontend/src/features/sync/syncService.ts` | Motore sync offline. Self-healing, zombie prevention, race condition guards. Errori = note perse o duplicate. |
| `frontend/src/lib/db.ts` | Schema Dexie (IndexedDB). Un errore di migration corrompe il DB locale di TUTTI gli utenti. MAI modificare versioni esistenti, solo aggiungere nuove. |
| `backend/src/hocuspocus.ts` | Server collab Yjs. Errori = corruzione contenuto note. |
| `backend/src/utils/ydoc.ts` | Sede delle TipTap extensions server (devono matchare Editor.tsx) + `rebaseYdocState`/`contentToYNodes`. Errori = corruzione/duplicazione contenuto note. |
| `frontend/src/utils/crypto.ts` | Encryption legacy (blocchi cifrati dell'editor + credenziali vault vecchie, lette solo dal wizard di migrazione). Cambiare algo/parametri rende illeggibili blocchi e credenziali esistenti. |
| `frontend/src/utils/vaultCrypto.ts` | Crypto del vault v3. Formato envelope, AAD, info HKDF, `kdfCanon` e lunghezze dei wrap sono contratti con i dati già scritti e con `backend/src/services/vault.service.ts` (regex dell'envelope). Cambiarli rende illeggibili envelope e keyring esistenti; dopo il primo keyring READY l'unico recupero è il Kit. |
| `frontend/src/lib/vaultReconcile.ts` | Riconciliatore del vault: per ogni nota adotta, copia, ricifra o scarta riga Dexie e item di coda. Una decisione sbagliata (adozione dell'envelope vecchio, copia mancata, DROP) perde edit non ancora sincronizzati. La tabella dei casi è nella spec `docs/superpowers/plans/2026-10-22-vault-t15-reconcile-spec.md`: si cambia la spec prima del codice. |
| `frontend/src/store/vaultStore.ts` | Stato vault (`byUser` persisted = cache del keyring; `pinHash` solo residuo legacy). Cambiare `partialize` o storage key invalida la cache dei keyring; `lockVault`/`registerPreLock` garantiscono l'ultimo salvataggio prima del blocco. |
| `backend/prisma/schema.prisma` | Schema DB. Ogni modifica richiede migration. Errori = rollback complessi in prod. |

### TIER 2 — Impatto trasversale

| File | Motivo |
|------|--------|
| `frontend/src/lib/api.ts` | Axios instance condivisa. Toccare interceptor impatta TUTTE le chiamate API. |
| `frontend/src/store/authStore.ts` | Token JWT + user. Cambiare struttura persisted rompe sessioni attive. |
| `backend/src/app.ts` | Entry point server. Route registration, CORS, JWT, middleware. Ordine conta. |
| `backend/src/services/auth.service.ts` | Flusso register/login/verify. Coinvolge inviti, email, audit log. |
| `frontend/src/components/editor/Editor.tsx` | Editor TipTap. Extensions, collaboration, dedup guard. Molto complesso. |
| `backend/src/services/email.service.ts` | Template email localizzati. Usato da auth, sharing, chat, invites. |

Valutati e lasciati fuori dai TIER: `lib/vaultSession.ts`, `lib/vaultMove.ts`, `lib/vaultCodec.ts`, `backend/src/services/vault.service.ts`. Un loro difetto isolato non cancella dati: il server impone CAS e `baseHash` sulle note vault, il client fa il round-trip in memoria prima di ogni PUT e di `finalize`, e il Kit si mostra solo dopo il 201 del setup (nella rigenerazione, dopo il 200 della PUT). Passano comunque dal gate. L'array `TIER1` di `.claude/hooks/tier1-guard.cjs` va tenuto allineato a questa tabella (oggi non contiene `vaultCrypto.ts` né `vaultReconcile.ts`).

---

## STILE DI RISPOSTA ATTESO

1. **Proponi prima, applica dopo** su qualsiasi file in TIER 1 o TIER 2. Mostra il diff proposto e attendi conferma esplicita.
2. **Backup logico:** su modifiche importanti a logica esistente, commenta il vecchio codice con `// [BACKUP] <date> — <motivo>` prima di sostituirlo. Non farlo per aggiunte pure o fix banali.
3. **Avviso multi-file:** se una modifica impatta piu di 3 file, avvisami con un riepilogo dei file coinvolti e del tipo di modifica su ciascuno PRIMA di procedere.
4. **i18n sempre:** non hardcodare mai stringhe utente. Aggiungere chiavi a ENTRAMBI `en.json` e `it.json`.
5. **Dark mode:** ogni componente UI nuovo deve avere varianti `dark:`.
6. **Test awareness:** dopo modifiche a flussi critici, suggerisci quali E2E test rieseguire (file in `frontend/e2e/`).
7. **Non toccare versioni Dexie esistenti:** per modifiche allo schema offline, aggiungere SEMPRE una nuova versione incrementale.

---

## Debito tecnico

### Residuo

Nessun debito tecnico residuo critico. Remaining low-priority items:

- ~25 `any` type inline disables in frontend (TipTap API limits, justified)
- ~340 `any` in backend test files (acceptable for test mocks)

<!-- BEGIN multi-model-routing-notiq -->
## Routing modelli — addendum Notiq

Queste regole si aggiungono a quelle sopra e al routing globale (`~/.claude/CLAUDE.md`); in caso di conflitto prevalgono le regole preesistenti del progetto.

- File TIER 1 o TIER 2 in staging → trattali come `hardRisk` anche se la regex del gate non li riconosce (`syncService.ts`, `db.ts`, `hocuspocus.ts`, `utils/ydoc.ts`, `schema.prisma`, `vaultStore.ts`, `vaultCrypto.ts`, `vaultReconcile.ts`, `api.ts`, `app.ts`, `Editor.tsx`, `email.service.ts`).
- L'implementazione delegata al subagent Sonnet non scavalca "Proponi prima, applica dopo": sui file TIER 1/2 serve comunque la conferma esplicita (hook `tier1-guard`), anche dopo il plan di `architect`.
- Le release (`/notiq-release`: solo bump versione + changelog) sono esenti dal gate.
- FAIL e2e riportato da `triage` → lo verifica il principale; non archiviarlo come flaky senza conferma con `git stash` (`collaboration.spec.ts:249`, `auth.spec.ts:41`).
<!-- END multi-model-routing-notiq -->
