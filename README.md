<p align="center">
  <img src="docs/assets/notiq-logo.png" alt="Notiq" width="120" />
</p>

<h1 align="center">Notiq</h1>

<p align="center">
  <strong>Offline-first note-taking PWA</strong> with real-time collaboration, encrypted vault, dedicated chat, and invitation-based authentication.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.9.0-white?style=flat-square&labelColor=2A9D8F&color=264653" alt="Version" />
  <img src="https://img.shields.io/badge/react-19-white?style=flat-square&labelColor=2A9D8F&color=264653" alt="React 19" />
  <img src="https://img.shields.io/badge/fastify-5-white?style=flat-square&labelColor=2A9D8F&color=264653" alt="Fastify 5" />
  <img src="https://img.shields.io/badge/prisma-7-white?style=flat-square&labelColor=2A9D8F&color=264653" alt="Prisma 7" />
  <img src="https://img.shields.io/badge/license-private-white?style=flat-square&labelColor=6B7280&color=374151" alt="License" />
</p>

---

## Features

<table>
<tr>
<td width="50%">

**Rich Text Editor**
TipTap v2 with tables, code blocks, task lists, images, audio recording, live status bar, and list-to-Kanban/TaskList transform.

**Real-time Collaboration**
Yjs + Hocuspocus WebSocket server with persistent user colors, avatar presence indicators, and live title sync via awareness.

**Offline-first**
Dexie.js (IndexedDB) with background sync queue and exponential backoff. Works without internet, syncs when reconnected.

**Encrypted Vault**
PBKDF2-derived AES-encrypted notes and credentials behind PIN protection with 10-min auto-lock.

</td>
<td width="50%">

**Dedicated Chat System**
WhatsApp-like 1:1 and group conversations with real-time WebSocket messaging, emoji reactions (emoji-mart), message replies with quotes, file sharing with thumbnails, read receipts, typing indicators, online presence dots, and 3-tier notifications (in-chat / sound / push with anti-spam).

**Kanban Boards**
Drag-and-drop boards with columns, cards, comments, assignees, due dates, priority levels, note linking with smart sharing, activity history, board chat, cover images, completion tracking, auto-archiving, context menu, marquee selection, and real-time SSE updates.

**Friend System & Groups**
Auto-friend on share accept, friend requests, blocking. User groups with invitation management. Friends tab in Sharing Center with direct chat launch.

**Admin Announcements**
Broadcast messages with customizable color/icon banners, push notifications, rich text editor, category-based styling (Urgent/Maintenance/Feature), dismissal tracking, and history page.

</td>
</tr>
</table>

**Also:** Task lists, reminders, PWA with push notifications, multi-language (EN/IT), collapsible sidebar with icon rail, admin panel with audit logs and chat file management, network status indicator, AI assistant, Evernote/OneNote import.

---

## Tech Stack

| Layer | Technologies |
|:------|:------------|
| **Frontend** | React 19, Vite 7, TipTap v2, Zustand, TanStack Query v5, Dexie.js v4, TailwindCSS 3, i18next, emoji-mart |
| **Backend** | Node.js 20+, Fastify 5, Prisma 7, PostgreSQL 15, Hocuspocus v3, Zod v4, Pino, Nodemailer, web-push, sharp |
| **Infra** | Docker Compose, IIS + ARR (production), PWA via vite-plugin-pwa |

---

## Architecture

```
Frontend (React SPA)
  ├── Dexie (IndexedDB)       <- offline storage
  ├── SyncService              <- background sync queue
  ├── TipTap Editor            <- rich text editing
  ├── HocuspocusProvider       <- real-time collaboration (WebSocket /ws)
  └── ChatWebSocket            <- real-time messaging (WebSocket /chat-ws)
       |
       v
Backend (Fastify)
  ├── Routes (Zod validation)
  ├── Services (business logic)
  ├── Prisma ORM (40 models) --> PostgreSQL
  ├── Hocuspocus Server        -> Yjs WebSocket
  ├── Chat WebSocket Server    -> messaging, presence, typing
  └── Pino                     -> structured logging
```

**Data flow:** User types -> Dexie write (instant) -> SyncQueue -> REST API -> Prisma

**Collab flow:** TipTap -> Yjs -> HocuspocusProvider -> WebSocket -> Hocuspocus Server -> Prisma

**Chat flow:** MessageInput -> WebSocket /chat-ws -> Chat Server -> broadcast to participants + push for offline

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- npm

### Setup

```bash
# Clone
git clone https://github.com/GitBakko/Notiq.git
cd Notiq

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

### Docker

```bash
docker compose up -d --build
```

### Environment Variables

<details>
<summary><strong>Backend</strong> (<code>backend/.env</code>)</summary>

| Variable | Description | Default |
|:---------|:-----------|:--------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `JWT_SECRET` | Secret for JWT signing | Required |
| `FRONTEND_URL` | Frontend origin for CORS | `http://localhost:5173` |
| `LOG_LEVEL` | Pino log level | `info` |

</details>

<details>
<summary><strong>Frontend</strong> (<code>frontend/.env.production</code>)</summary>

| Variable | Description | Default |
|:---------|:-----------|:--------|
| `VITE_API_URL` | API base URL | `/api` |
| `VITE_WS_URL` | WebSocket URL | Required for prod |
| `VITE_VAPID_PUBLIC_KEY` | VAPID key for push notifications | Built-in fallback |

</details>

---

## Project Structure

```
Notiq/
  backend/
    src/
      routes/        # Fastify route plugins (Zod-validated)
      services/      # Business logic layer
      utils/         # Logger, text extraction, errors
      plugins/       # Prisma client singleton
      scripts/       # CLI tools (admin, backup, migration)
      chatWebSocket.ts  # Chat WS server (/chat-ws)
      hocuspocus.ts     # Collab WS server (/ws)
    prisma/
      schema.prisma  # 40 models, 26 migrations
  frontend/
    src/
      components/    # Reusable UI (editor/, layout/, sharing/, ui/)
      features/      # Domain modules (auth, notes, vault, groups, tasks, kanban, chat, announcements)
      store/         # Zustand stores (auth, vault, ui)
      lib/           # API client, Dexie DB, i18n
      locales/       # en.json, it.json
    e2e/             # Playwright E2E tests
  deploy/            # Deployment scripts (pre/post-install)
```

---

## Security

- JWT authentication with token expiration and version-based invalidation
- Zod input validation on all API routes
- CSP, HSTS, Permissions-Policy security headers
- CORS whitelist (configurable per environment)
- Per-route rate limiting on sensitive endpoints
- SSRF protection on URL metadata fetching
- XSS sanitization on user-generated content
- IDOR protection on all resource endpoints
- Graceful shutdown (SIGTERM/SIGINT)
- Per-user WebSocket connection limits
- Production source maps disabled

---

<p align="center">
  <img src="docs/assets/notiq-logo.png" alt="Notiq" width="32" />
</p>

<p align="center">
  <sub>Private project &mdash; built with precision.</sub>
</p>
