# Notiq

Offline-first note-taking PWA con real-time collaboration, encrypted vault e invitation-based auth.
Full-stack TypeScript monorepo. Deployed su IIS a `notiq.epartner.it`.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19, Vite 7, TipTap v2, Zustand, TanStack Query v5, Dexie.js v4 (IndexedDB), TailwindCSS 3, i18next (EN/IT), Playwright |
| Backend | Node.js 18+, Fastify 5, Prisma 7, PostgreSQL 15, Hocuspocus v3 (Yjs WebSocket), Zod v4, bcrypt, Nodemailer, web-push |
| Infra | Docker Compose, Nginx (Docker), IIS + ARR (prod), PWA via vite-plugin-pwa |

**Module types:** Backend = CommonJS (`type: "commonjs"`), Frontend = ESM (`type: "module"`).

## Comandi (verificati 2026-02-18)

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
| DB schema | `backend/prisma/schema.prisma` (14 modelli, 5 migration) |
| Collab server | `backend/src/hocuspocus.ts` (extensions DEVONO matchare Editor.tsx) |
| Prisma client | `backend/src/plugins/prisma.ts` (singleton, pg adapter) |
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
DATABASE_URL="postgresql://user:pass@localhost:5432/notiq"
JWT_SECRET="secret"
FRONTEND_URL="http://localhost:5173"

# backend/config.json → SMTP { host, port, user, pass, secure }

# frontend/.env.production
VITE_API_URL=/api
VITE_WS_URL=wss://notiq.epartner.it/ws
```

Dev proxy (vite.config.ts): `/api` → `:3001`, `/uploads` → `:3001`, `/ws` → `ws://:3001`.

### Prisma models (14) ed enums

**Models:** User, Note, Notebook, Tag, TagsOnNotes, Attachment, SharedNote, SharedNotebook, Notification, PushSubscription, ChatMessage, AuditLog, Invitation, InvitationRequest, SystemSetting
**Enums:** Role (USER/SUPERADMIN), Permission (READ/WRITE), ShareStatus (PENDING/ACCEPTED/DECLINED), NotificationType (SHARE_NOTE/SHARE_NOTEBOOK/SYSTEM/REMINDER/CHAT_MESSAGE), InvitationStatus (PENDING/USED), RequestStatus (PENDING/APPROVED/REJECTED)

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
| `frontend/src/features/notes/NoteEditor.tsx:353-361` | DEBUG panel visibile in prod (mostra raw content). |
| `backend/Dockerfile:27` | CMD `node dist/index.js` errato → deve essere `node dist/app.js`. |
| `backend/src/services/email.service.ts:87+118` | Duplicate `case 'SHARE_INVITATION'` + dead code dopo break (L192-215). |
| `backend/config.json` | Contiene credenziali SMTP reali committate in git. |

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

| Prio | Issue | File |
|------|-------|------|
| P0 | DEBUG panel visibile in prod | `frontend/src/features/notes/NoteEditor.tsx:353-361` |
| P0 | SMTP credentials in git | `backend/config.json` |
| P0 | Dockerfile CMD errato (`index.js` vs `app.js`) | `backend/Dockerfile:27` |
| P1 | TipTap version mismatch (frontend v2 / backend v3) | `package.json` di entrambi |
| P1 | JWT senza scadenza | `backend/src/routes/auth.ts:70` (manca `expiresIn`) |
| P1 | CORS `origin: true` in produzione | `backend/src/app.ts:33` |
| P1 | Duplicate case + dead code in email service | `backend/src/services/email.service.ts:87-215` |
| P2 | lastActiveAt update ogni richiesta (no throttle) | `backend/src/app.ts:72-89` |
| P2 | Vault AES senza KDF (PIN diretto come chiave) | `frontend/src/utils/crypto.ts` |
| P2 | 106 lint errors (no-explicit-any, no-unused-vars) | `frontend/` vari file |
| P3 | Zero unit test backend | `backend/package.json` (test script = echo error) |
| P3 | console.log debug sparsi | Vari file frontend/backend |
