# Notiq

Offline-first note-taking PWA con real-time collaboration, encrypted vault e invitation-based auth.
Full-stack TypeScript monorepo. Deployed su IIS a `notiq.epartner.it`.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19, Vite 7, TipTap v2, Zustand, TanStack Query v5, Dexie.js v4 (IndexedDB), TailwindCSS 3, i18next (EN/IT), Playwright |
| Backend | Node.js 20+, Fastify 5, Prisma 7, PostgreSQL 15, Hocuspocus v3 (Yjs WebSocket), Zod v4, bcrypt, Nodemailer, web-push |
| Infra | Docker Compose (Node 22-alpine), Nginx (Docker), IIS + ARR (prod), PWA via vite-plugin-pwa |

**Module types:** Backend = CommonJS (`type: "commonjs"`), Frontend = ESM (`type: "module"`).

## Comandi (verificati 2026-02-19)

```bash
# Backend (cd backend)
npm run dev          # tsx watch src/app.ts → localhost:3001
npm run build        # tsc → dist/   (outDir: dist, rootDir: src)
npm start            # node dist/app.js
npm run prune        # Clean orphan attachments
npm run backup       # ZIP backup (DB + files)
npx prisma migrate dev --name <name>   # Nuova migration
npx prisma migrate deploy              # Apply in production
npx prisma generate                    # Regenera client
npx prisma studio                      # DB browser GUI
npx tsx src/scripts/testSmtp.ts <email> # Test SMTP

# Frontend (cd frontend)
npm run dev          # Vite → localhost:5173 (proxies /api, /uploads, /ws verso :3001)
npm run build        # tsc -b && vite build
npm run lint         # ESLint (106 errori attuali: no-explicit-any, no-unused-vars)
npx playwright test  # E2E (12 spec files)

# Docker (root)
docker compose up -d --build   # Build + start
docker compose down             # Stop
```

> Nota: `npx prisma` legge `prisma.config.js` che fa `require('dotenv').config()`, quindi richiede che `backend/.env` esista.

## Architettura

```
Routes (Zod validation) → Services (business logic) → Prisma (PostgreSQL)
                                                       ↕
Frontend: Dexie (IndexedDB) ← syncPull/syncPush → REST API (/api/*)
          TipTap Editor     ← HocuspocusProvider → WebSocket (/ws)
          Zustand stores    ← persist middleware  → localStorage
```

**Data flow note:** User types → Dexie write (immediato) → SyncQueue → syncPush (debounced) → REST API → Prisma.
**Collab flow:** TipTap → Yjs → HocuspocusProvider → WebSocket → Hocuspocus Server → TipTap JSON → Prisma.
**Auth flow:** Register → email verifica → verify-email → login → JWT → `authStore` (Zustand persisted) → Axios interceptor auto-attacca token.

### File chiave

| Cosa | Path |
|------|------|
| Server entry | `backend/src/app.ts` (port 3001, registra tutte le route + Hocuspocus su `/ws`) |
| DB schema | `backend/prisma/schema.prisma` (19 modelli, 13 migrations) |
| Collab server | `backend/src/hocuspocus.ts` (extensions DEVONO matchare Editor.tsx) |
| Prisma client | `backend/src/plugins/prisma.ts` (singleton, pg adapter) |
| Logger | `backend/src/utils/logger.ts` (Pino shared, usare nei servizi; nelle route usare `request.log`) |
| SMTP config | `backend/config.json` (Nodemailer lo legge all'avvio) |
| Prisma config | `backend/prisma.config.js` (carica dotenv, definisce datasource) |
| Frontend entry | `frontend/src/main.tsx` (React 19, QueryClient, BrowserRouter, SW registration) |
| Route/pagine | `frontend/src/App.tsx` (protette dentro `<AppLayout />`, pubbliche fuori) |
| Sync engine | `frontend/src/features/sync/syncService.ts` (syncPull + syncPush) |
| Offline DB | `frontend/src/lib/db.ts` (Dexie, 9 versioni schema) |
| API client | `frontend/src/lib/api.ts` (Axios + JWT interceptor + 401 auto-logout) |
| Vault crypto | `frontend/src/utils/crypto.ts` (CryptoJS AES, PIN come chiave diretta) |
| Auth store | `frontend/src/store/authStore.ts` (Zustand persisted, chiave localStorage: `auth-storage`) |
| IIS routing | `frontend/public/web.config` (URL Rewrite per /api, /uploads, /ws) |

### Convenzioni

- **Route backend:** default export async function (Fastify plugin). Protette con `{ onRequest: [fastify.authenticate] }` → popola `request.user: { id, email, role }`.
- **Service backend:** named exports. Lanciano `Error` con chiavi i18n per messaggi utente (es. `auth.errors.userExists`).
- **Feature frontend:** `features/<domain>/` contiene Page + service + hooks. Non cross-importare tra feature dirs.
- **Componenti:** default exports, PascalCase file. UI primitives in `components/ui/`.
- **i18n:** TUTTE le stringhe utente via `t('key')`. Aggiungere SEMPRE a `en.json` E `it.json`.
- **Styling:** Tailwind utilities + `clsx()`. SEMPRE aggiungere varianti `dark:`.
- **Nuovo entity Dexie:** incrementare version in `db.ts`, aggiungere in syncPull + syncPush.
- **Nuova TipTap extension strutturale:** DEVE essere aggiunta sia in `Editor.tsx` CHE in `hocuspocus.ts`.

### Environment

```
# backend/.env (dotenv caricato da prisma.config.js e app.ts)
DATABASE_URL="postgresql://user:pass@localhost:5433/evernote_clone?schema=public"
JWT_SECRET="secret"
FRONTEND_URL="http://localhost:5173"
LOG_LEVEL="info"    # Pino log level (debug/info/warn/error)

# backend/config.json → SMTP { host, port, user, pass, secure }

# frontend/.env.production
VITE_API_URL=/api
VITE_WS_URL=wss://notiq.epartner.it/ws
VITE_VAPID_PUBLIC_KEY=<your-vapid-public-key>
```

Dev proxy (vite.config.ts): `/api` → `:3001`, `/uploads` → `:3001`, `/ws` → `ws://:3001`.

### Docker

- **Dev DB:** container Docker `notiq-db` su porta 5433 con volume `evernote_postgres_data` (PostgreSQL 15)
- **Dockerfiles:** Node 22-alpine (Prisma 7 richiede Node 20.19+). Backend Dockerfile include `prisma generate` esplicito.
- **Attenzione:** `docker compose up` avvia un backend sulla porta 3001 che intercetta il proxy Vite dev. Fermare i container Docker (`docker compose down`) quando si usa il dev locale.
- Entry point backend Docker: `dist/app.js` (non `dist/index.js`)

### Prisma models (19) ed enums (12 migrations)

**Models:** User, Invitation, SystemSetting, Notebook, Note, Tag, TagsOnNotes, Attachment, SharedNote, SharedNotebook, Notification, PushSubscription, ChatMessage, AuditLog, InvitationRequest, AiConversation, Group, GroupMember, PendingGroupInvite
**Enums:** Role (USER/SUPERADMIN), Permission (READ/WRITE), ShareStatus (PENDING/ACCEPTED/DECLINED), NotificationType (SHARE_NOTE/SHARE_NOTEBOOK/SYSTEM/REMINDER/CHAT_MESSAGE), InvitationStatus (PENDING/USED), RequestStatus (PENDING/APPROVED/REJECTED)

### Campi notevoli su User

`color String?` — colore persistente assegnato alla registrazione, usato per awareness collaboration e chat. Palette di 15 colori predefiniti in `auth.service.ts`.

---

## AREE CRITICHE

Non modificare questi file senza revisione esplicita dell'impatto.

### TIER 1 — Rischio data loss / corruzione

| File | Motivo |
|------|--------|
| `frontend/src/features/sync/syncService.ts` | Motore sync offline. Self-healing, zombie prevention, race condition guards. Errori = note perse o duplicate. |
| `frontend/src/lib/db.ts` | Schema Dexie (IndexedDB), 9 versioni. Un errore di migration corrompe il DB locale di TUTTI gli utenti. MAI modificare versioni esistenti, solo aggiungere nuove. |
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
| `backend/src/services/email.service.ts` | Template email localizzati. Bug noto (duplicate case). Usato da auth, sharing, chat, invites. |

### Bug noti da non dimenticare

| File | Bug |
|------|-----|
| `backend/config.json` | Contiene credenziali SMTP reali committate in git. Considerare `.gitignore` + env vars. |

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

### Risolto (audit feb 2026, Fasi 1-13 + cleanup finale)

- **14 CRITICAL** — JWT scadenza/invalidazione, IDOR, CORS whitelist, Dockerfile CMD/Node version, DEBUG panel prod, email duplicate case, XSS sanitizzazione, rate limiting, rimossi file debug
- **20 HIGH** — Zod validation su tutte le route (incluso GET /notes query), error handling standardizzato, Prisma select optimization, pagination, lastActiveAt throttle, rimosso JWT fallback 'supersecret'
- **~30 MEDIUM/LOW** — 8 DB indexes, structured logging (Pino, console.log→logger), import hardening (XXE + size limit), URL.createObjectURL leak fix, VAPID da env var, i18n keys aggiunte, TS errors frontend risolti

### Residuo

| Prio | Issue                                          | File                            |
|------|-------------------------------------------------|---------------------------------|
| P0   | SMTP credentials in git                         | `backend/config.json`           |
| P2   | Vault AES senza KDF (PIN diretto come chiave)   | `frontend/src/utils/crypto.ts`  |
| P2   | ~106 lint errors (no-explicit-any, no-unused-vars) | `frontend/` vari file        |
| P3   | Zero unit test backend                          | `backend/package.json`          |
