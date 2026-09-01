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

**Due WebSocket distinti, entrambi gestiti nell'upgrade event di `app.ts`:** `/ws` = Hocuspocus (collab editor), `/chat-ws` = chat system.

### File chiave

| Cosa | Path |
|------|------|
| Server entry | `backend/src/app.ts` (port 3001, route + upgrade WS su `/ws` e `/chat-ws`) |
| DB schema | `backend/prisma/schema.prisma` (+ `prisma/migrations/`) |
| Collab server | `backend/src/hocuspocus.ts` (extensions DEVONO matchare Editor.tsx) |
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
| Vault crypto | `frontend/src/utils/crypto.ts` (CryptoJS AES, PIN come chiave diretta) |
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
- **Nuova TipTap extension strutturale:** DEVE essere aggiunta sia in `Editor.tsx` CHE in `hocuspocus.ts`.
- **Chat components:** usare `useChatContext()` dal `ChatContext` condiviso, MAI aprire una connessione WS diretta per componente.
- **Nuova sottocartella `uploads/`:** richiede route esplicita in `app.ts` (gli static file NON sono serviti con wildcard).

### Environment

```
# backend/.env (dotenv caricato da prisma.config.js e app.ts)
DATABASE_URL="postgresql://user:pass@localhost:5433/evernote_clone?schema=public"
JWT_SECRET="secret"
FRONTEND_URL="http://localhost:5173"
LOG_LEVEL="info"

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

Usa la skill `/notiq-deploy` — copre gli script PowerShell (`Build-Package.ps1` locale + `Deploy-Server.ps1` sul server), i path fisici IIS e i gotcha robocopy/pg_dump. I vecchi `pre-install.cmd`/`post-install.cmd` sono superati: **non fanno il dump del DB**.

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
| `backend/src/hocuspocus.ts` | Server collab Yjs. Extensions devono matchare Editor.tsx. Errori = corruzione contenuto note. |
| `frontend/src/utils/crypto.ts` | Encryption vault. Cambiare algo/parametri rende illeggibili tutte le note vault esistenti. |
| `frontend/src/store/vaultStore.ts` | Stato vault (`pinHash` persisted). Cambiare `partialize` o storage key invalida tutti i vault. |
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
