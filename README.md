# Notiq

Offline-first note-taking PWA with real-time collaboration, encrypted vault, and invitation-based authentication.

## Features

- **Rich Text Editor** — TipTap v2 with tables, code blocks, task lists, images, audio recording, live status bar, and list-to-Kanban/TaskList transform via context menu
- **Real-time Collaboration** — Yjs + Hocuspocus WebSocket server with persistent user colors and avatar presence
- **Offline-first** — Dexie.js (IndexedDB) with background sync queue
- **Encrypted Vault** — AES-encrypted notes and credentials behind PIN protection
- **Task Lists** — Collaborative task/shopping lists with checkable items, priority levels, sharing with real-time notifications, and check ownership tracking
- **Kanban Boards** — Drag-and-drop boards with columns, cards, comments, assignees, due dates, note linking with smart sharing, activity history, board chat, cover images, column reordering, and real-time SSE updates
- **Sharing** — Note, notebook, task list, and kanban board sharing with granular permissions (read/write), Sharing Center with sent invitations panel, resend/cancel, smart merge duplicate detection, and clickable sharing badges with read-only user viewer
- **Groups** — User groups with avatar, invitation management, shared notebooks, and expandable member visibility for all groups
- **Reminders** — Date-based reminders with notification support
- **AI Chat** — Per-note AI assistant powered by AWS Bedrock with dynamic titles and notification badges
- **Import** — Evernote (.enex) and OneNote (.mht, .html, .zip) import with attachment support
- **Multi-language** — English and Italian (i18next)
- **PWA** — Installable, push notifications via Web Push API
- **Collapsible Panels** — Collapse the note/vault list for a wider editor view, with persistent state
- **Admin Panel** — User management, audit logs, invitation system, configurable invitation expiry

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, Vite 7, TipTap v2, Zustand, TanStack Query v5, Dexie.js v4, TailwindCSS 3, i18next |
| Backend | Node.js 20+, Fastify 5, Prisma 7, PostgreSQL 15, Hocuspocus v3, Zod v4, Pino, Nodemailer, web-push |
| Infra | Docker Compose, Nginx, IIS + ARR (production), PWA via vite-plugin-pwa |

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- npm

### Setup

```bash
# Clone
git clone https://github.com/yourusername/notiq.git
cd notiq

# Backend
cd backend
cp .env.example .env        # Configure DATABASE_URL, JWT_SECRET, FRONTEND_URL
npm install
npx prisma migrate deploy
npx prisma generate
npm run dev                  # Starts on :3001

# Frontend (new terminal)
cd frontend
npm install
npm run dev                  # Starts on :5173 (proxies API to :3001)
```

### Environment Variables

**Backend** (`backend/.env`):

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `JWT_SECRET` | Secret for JWT signing | Required |
| `FRONTEND_URL` | Frontend origin for CORS | `http://localhost:5173` |
| `LOG_LEVEL` | Pino log level | `info` |

**Frontend** (`frontend/.env.production`):

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_URL` | API base URL | `/api` |
| `VITE_WS_URL` | WebSocket URL | Required for prod |
| `VITE_VAPID_PUBLIC_KEY` | VAPID key for push notifications | Built-in fallback |

### Docker

```bash
docker compose up -d --build
```

## Architecture

```
Frontend (React SPA)
  |-- Dexie (IndexedDB)  <-- offline storage
  |-- SyncService         <-- background sync queue
  |-- TipTap Editor       <-- rich text editing
  |-- HocuspocusProvider  <-- real-time collaboration (WebSocket)
  |
  v
Backend (Fastify)
  |-- Routes (Zod validation)
  |-- Services (business logic)
  |-- Prisma ORM --> PostgreSQL
  |-- Hocuspocus Server (Yjs WebSocket)
  |-- Pino (structured logging)
```

**Data flow:** User types -> Dexie write (instant) -> SyncQueue -> REST API -> Prisma

**Collab flow:** TipTap -> Yjs -> HocuspocusProvider -> WebSocket -> Hocuspocus Server -> Prisma

## Project Structure

```
notiq/
  backend/
    src/
      routes/        # Fastify route plugins (Zod-validated)
      services/      # Business logic layer
      utils/         # Logger, text extraction
      plugins/       # Prisma client singleton
      scripts/       # CLI tools (admin, backup, migration)
    prisma/
      schema.prisma  # 30 models, 20 migrations
  frontend/
    src/
      components/    # Reusable UI (editor/, layout/, sharing/, ui/)
      features/      # Domain modules (auth/, notes/, admin/, vault/, groups/, tasks/, etc.)
      store/         # Zustand stores (auth, vault)
      lib/           # API client, Dexie DB, i18n
      locales/       # en.json, it.json
    e2e/             # Playwright E2E tests (18 specs)
  docs/
    deployment/      # IIS/Docker deployment guides
    testing/         # E2E test documentation
    archive/         # Historical design specs and roadmap
```

## Security

- JWT authentication with token expiration and version-based invalidation
- Zod input validation on all API routes
- CORS whitelist (configurable per environment)
- Rate limiting on authentication endpoints
- XSS sanitization on user-generated content
- IDOR protection on all resource endpoints
- Structured logging (no sensitive data in logs)
- Import file size limits and XXE protection

## License

Private project.
