# Notiq

Offline-first note-taking PWA con real-time collaboration, encrypted vault e invitation-based auth.
Full-stack TypeScript monorepo. **Live su `notiq.epartner.it`** (IIS + pm2).

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19, Vite 7, TipTap v2, Zustand, TanStack Query v5, Dexie.js v4 (IndexedDB), TailwindCSS 3, i18next (EN/IT), Playwright |
| Backend | Node.js 20+, Fastify 5, Prisma 7, PostgreSQL 15, Hocuspocus v3 (Yjs WebSocket), Zod v4, bcrypt, Nodemailer, web-push |
| Infra | Docker Compose (dev), IIS + ARR + pm2 (prod), PWA via vite-plugin-pwa |

**Module types:** Backend = CommonJS (`type: "commonjs"`), Frontend = ESM (`type: "module"`).

## Comandi (verificati 2026-02-25)

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
npm run lint         # ESLint
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

### Struttura progetto

```
Notiq/
├── backend/
│   ├── src/
│   │   ├── routes/          # Fastify route plugins (Zod validated)
│   │   ├── services/        # Business logic (named exports)
│   │   ├── plugins/         # Fastify plugins (prisma, jwt)
│   │   ├── utils/           # Logger (Pino), extractText, etc.
│   │   ├── scripts/         # One-off scripts (testSmtp, create-superadmin)
│   │   ├── __tests__/       # Unit tests (vitest)
│   │   ├── app.ts           # Server entry point
│   │   └── hocuspocus.ts    # Yjs collab server
│   ├── prisma/
│   │   ├── schema.prisma    # 30 models, 9 enums
│   │   └── migrations/      # 20 migrations
│   ├── prisma.config.js     # Prisma config (dotenv loader)
│   ├── Dockerfile
│   └── .env                 # DB, JWT, SMTP credentials (gitignored)
├── frontend/
│   ├── src/
│   │   ├── features/        # Domain modules (notes, vault, sync, tags, etc.)
│   │   ├── components/      # Shared UI (editor, layout, sharing, ui/)
│   │   ├── hooks/           # Custom hooks (useNotes, useImport, etc.)
│   │   ├── store/           # Zustand stores (auth, vault, ui)
│   │   ├── lib/             # api.ts (Axios), db.ts (Dexie)
│   │   ├── utils/           # crypto.ts, format.ts
│   │   ├── locales/         # en.json, it.json
│   │   └── __tests__/       # Unit tests (vitest)
│   ├── e2e/                 # Playwright E2E tests (12 specs)
│   ├── public/              # Static assets + web.config (IIS)
│   └── scripts/             # Utility scripts (scan-i18n)
├── deploy/                  # Deploy scripts (pre/post-install.cmd) — gitignored
├── docker-compose.yml       # Dev environment (PostgreSQL + backend + frontend)
├── CLAUDE.md                # This file
└── README.md                # Project overview
```

### File chiave

| Cosa | Path |
|------|------|
| Server entry | `backend/src/app.ts` (port 3001, route + Hocuspocus su `/ws`) |
| DB schema | `backend/prisma/schema.prisma` (30 modelli, 20 migrations) |
| Collab server | `backend/src/hocuspocus.ts` (extensions DEVONO matchare Editor.tsx) |
| Prisma client | `backend/src/plugins/prisma.ts` (singleton, pg adapter) |
| Logger | `backend/src/utils/logger.ts` (Pino shared; nelle route usare `request.log`) |
| SMTP config | `backend/.env` (variabili `SMTP_*`, lette da `email.service.ts`) |
| Prisma config | `backend/prisma.config.js` (carica dotenv, definisce datasource) |
| Frontend entry | `frontend/src/main.tsx` (React 19, QueryClient, BrowserRouter, SW) |
| Route/pagine | `frontend/src/App.tsx` (protette dentro `<AppLayout />`, pubbliche fuori) |
| Sync engine | `frontend/src/features/sync/syncService.ts` (syncPull + syncPush) |
| Offline DB | `frontend/src/lib/db.ts` (Dexie v4, schema v13) |
| API client | `frontend/src/lib/api.ts` (Axios + JWT interceptor + 401 auto-logout) |
| Vault crypto | `frontend/src/utils/crypto.ts` (CryptoJS AES, PIN come chiave diretta) |
| Auth store | `frontend/src/store/authStore.ts` (Zustand persisted, key: `auth-storage`) |
| UI store | `frontend/src/store/uiStore.ts` (theme, sidebar, sort — persisted localStorage) |
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
LOG_LEVEL="info"

# SMTP (lette da email.service.ts)
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password
SMTP_SECURE=false
SMTP_FROM_NAME=Notiq App

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

### Deploy produzione

- **Server:** IIS su Windows Server, backend gestito da pm2 (`notiq-backend`)
- **Path server:** Backend `E:\www\Notiq\backend`, Frontend `E:\www\Notiq\frontend`
- **Script deploy:** `deploy/pre-install.cmd` (stop + backup) e `deploy/post-install.cmd` (npm ci + prisma + start)
- **Flusso:** build locale → zip → copia su server → pre-install → estrai → post-install → verifica

### Prisma models (30) ed enums (9)

**Models:** User, Invitation, SystemSetting, Notebook, Note, Tag, TagsOnNotes, Attachment, SharedNote, SharedNotebook, Notification, PushSubscription, ChatMessage, AuditLog, InvitationRequest, AiConversation, Group, GroupMember, PendingGroupInvite, TaskList, TaskItem, SharedTaskList, KanbanBoard, KanbanColumn, KanbanCard, KanbanComment, SharedKanbanBoard, KanbanBoardChat, KanbanCardActivity, KanbanReminder
**Enums:** Role (USER/SUPERADMIN), Permission (READ/WRITE), ShareStatus (PENDING/ACCEPTED/DECLINED), NotificationType (SHARE_NOTE/SHARE_NOTEBOOK/SYSTEM/REMINDER/CHAT_MESSAGE/GROUP_INVITE/GROUP_REMOVE/TASK_ITEM_ADDED/TASK_ITEM_CHECKED/TASK_ITEM_REMOVED/TASK_LIST_SHARED/KANBAN_BOARD_SHARED/KANBAN_CARD_ASSIGNED/KANBAN_COMMENT_ADDED), InvitationStatus (PENDING/USED), RequestStatus (PENDING/APPROVED/REJECTED), NoteType (NOTE/CREDENTIAL), TaskPriority (LOW/MEDIUM/HIGH), KanbanCardAction (CREATED/MOVED/UPDATED/ASSIGNED/UNASSIGNED/DUE_DATE_SET/DUE_DATE_REMOVED/NOTE_LINKED/NOTE_UNLINKED/DELETED)

### Campi notevoli su User

`color String?` — colore persistente assegnato alla registrazione, usato per awareness collaboration e chat. Palette di 15 colori predefiniti in `auth.service.ts`.

---

## AREE CRITICHE

Non modificare questi file senza revisione esplicita dell'impatto.

### TIER 1 — Rischio data loss / corruzione

| File | Motivo |
|------|--------|
| `frontend/src/features/sync/syncService.ts` | Motore sync offline. Self-healing, zombie prevention, race condition guards. Errori = note perse o duplicate. |
| `frontend/src/lib/db.ts` | Schema Dexie (IndexedDB), 13 versioni. Un errore di migration corrompe il DB locale di TUTTI gli utenti. MAI modificare versioni esistenti, solo aggiungere nuove. |
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

## MOBILE UI DESIGN

Notiq è una PWA installabile su mobile. Ogni componente UI nuovo o modificato deve rispettare queste linee guida.

### Principi generali

- **Mobile-first:** costruisci sempre dal breakpoint base verso l'alto. Non aggiungere stili desktop e poi overridare per mobile.
- **Touch targets:** ogni elemento interattivo (bottoni, link, checkbox) deve avere area minima `44×44px` (usa `min-h-[44px] min-w-[44px]`).
- **Safe areas:** su iPhone e Android con notch/gesture bar, usare `env(safe-area-inset-*)` via Tailwind. Verificare che `viewport-fit=cover` sia presente nel meta viewport del `index.html`.
- **No hover-only interactions:** ogni interazione affidata a `:hover` deve avere un equivalente touch (`:active`, tap, long-press).
- **Scroll naturale:** preferire `overflow-y-auto` con `-webkit-overflow-scrolling: touch` su container scrollabili. Evitare `overflow: hidden` su body in viste mobile.

### Breakpoint Tailwind usati in Notiq

| Breakpoint | Uso tipico |
|------------|------------|
| _(default)_ | Mobile portrait (< 640px) |
| `sm:` (640px) | Mobile landscape / tablet small |
| `md:` (768px) | Tablet |
| `lg:` (1024px) | Desktop |

### Pattern per componenti mobile

- **Sidebar/Navigation:** su mobile deve essere un drawer (slide-in da sinistra o bottom sheet) con overlay scuro. Non mostrare sidebar fissa su schermi `< md`.
- **Editor TipTap:** su mobile verificare che la toolbar non venga nascosta dalla tastiera virtuale. Se necessario, usare `visualViewport` API per riposizionarla. Evitare toolbar floating che interferisce con la selezione testo.
- **Modal e Sheet:** su mobile preferire bottom sheet (`translate-y` + drag handle visibile) invece di modal centrato. Usare `rounded-t-2xl` e `max-h-[90vh] overflow-y-auto`.
- **Liste note:** card full-width con padding contenuto. Swipe actions (es. delete, archive) tramite gesture touch; non affidarsi a pulsanti visibili sempre.
- **Kanban:** su mobile mostrare una colonna alla volta con navigazione swipe orizzontale. Non tentare layout multi-colonna su schermi `< md`.

### Dark mode su mobile

- Rispettare `prefers-color-scheme` via media query. Verificare che `uiStore` sincronizzi il tema con `window.matchMedia('(prefers-color-scheme: dark)')` all'init.
- Evitare sfondi puri `#000000` (OLED burn risk): preferire `zinc-950` o `neutral-900` per il tema dark.

### Performance mobile

- **Immagini:** `loading="lazy"` e `decoding="async"` su tutti gli `<img>`. Per allegati mostrare thumbnail compressa, non originale.
- **Animazioni:** usare solo `transform` e `opacity` (GPU-accelerated). Evitare animazioni su `height`, `width`, `top`, `left`.
- **Font:** non caricare più di 2 weight per font family. Usare `font-display: swap`.
- **Bundle:** ogni nuova dipendenza UI va valutata per impatto sul bundle (PWA su mobile ha vincoli di cache più stringenti).

### Accessibilità mobile

- `aria-label` obbligatorio su tutti i bottoni icon-only.
- Focus trap attivo su modal e drawer aperti (`focus-trap-react` o implementazione custom).
- `role="dialog"` + `aria-modal="true"` su ogni overlay.
- Testare con VoiceOver (iOS) e TalkBack (Android) sui flussi critici: login, creazione nota, accesso vault.

### Tool MCP per UI mobile (Claude Code)

MCP server verificati e compatibili con lo stack React + TailwindCSS di Notiq:

**shadcn/ui MCP** — accesso diretto al registry componenti shadcn/ui, props TypeScript aggiornate, pattern Tailwind corretti. Utile per generare e ispezionare componenti senza allucinazioni sui nomi delle API.

```bash
# Aggiungere via Claude Code CLI (scope progetto)
claude mcp add shadcn -- npx -y mcp-remote https://www.shadcn.io/api/mcp
```

Oppure aggiungere manualmente al file di configurazione MCP:

```json
{
  "mcpServers": {
    "shadcn": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://www.shadcn.io/api/mcp"]
    }
  }
}
```

**Context7 MCP** — già connesso all'account. Usarlo per documentazione aggiornata di React 19, TailwindCSS 3, Vite e TipTap direttamente nel contesto di Claude Code.

Prompt di riferimento per Claude Code con questi MCP:
```
"Usa shadcn per trovare il componente Sheet, adattalo per Notiq mobile:
bottom sheet con drag handle, dark: variants Tailwind, touch targets ≥44px, safe areas PWA."
```

---

## Debito tecnico

### Risolto (audit feb 2026)

- **14 CRITICAL** — JWT scadenza/invalidazione, IDOR, CORS whitelist, Dockerfile, DEBUG panel prod, email duplicate case, XSS, rate limiting
- **20 HIGH** — Zod validation su tutte le route, error handling, Prisma select optimization, pagination, lastActiveAt throttle
- **~30 MEDIUM/LOW** — 8 DB indexes, structured logging (Pino), import hardening (XXE + size limit), URL.createObjectURL leak fix, VAPID da env var
- **P0 SMTP credentials** — migrato da `config.json` a variabili `.env` (feb 2026). `config.json` eliminato dal repo.

### Residuo

| Prio | Issue                                          | File                            |
|------|-------------------------------------------------|---------------------------------|
| P1   | Kanban boards non sincronizzati in Dexie (no offline) | `frontend/src/lib/db.ts`, `syncService.ts` |
| P1   | Kanban board: manca group sharing (solo email)   | `sharing.service.ts`, `ShareBoardModal.tsx` |
| P1   | ~170 `any` type nel backend                      | `backend/src/` vari file        |
| P1   | Zero E2E tests per Kanban                        | `frontend/e2e/`                 |
| P2   | Vault AES senza KDF (PIN diretto come chiave)   | `frontend/src/utils/crypto.ts`  |
| P2   | Missing DB indexes (GroupMember userId, KanbanBoardChat, AuditLog) | `schema.prisma` |
| P2   | Rate limiting solo globale (100/min), serve per-route | `backend/src/app.ts`     |
| P2   | Lint errors (no-explicit-any, no-unused-vars)    | `frontend/` vari file           |
| P3   | Unit test backend da espandere                   | `backend/src/__tests__/`        |
| P3   | Kanban column titles hardcoded in inglese         | `kanban.service.ts`             |
| P3   | ChatMessage e KanbanBoardChat duplicati (unificabili) | `schema.prisma`           |
