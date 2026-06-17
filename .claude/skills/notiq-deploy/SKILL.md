---
name: notiq-deploy
description: Deploy Notiq to production (notiq.epartner.it — IIS + pm2). Use when the user asks to deploy, ship, or release to the live server. Encodes the verified build → zip → copy → pre/post-install flow and the hard-won robocopy/IIS gotchas.
disable-model-invocation: true
---

# Notiq — Production Deploy

Live target: **notiq.epartner.it** — IIS (ARR reverse proxy) + pm2. Windows Server, multi-site (~30 IIS sites) — **never touch other sites**.

## Server paths (verified)
- Frontend physical root: **`E:\www\Notiq\frontend`** (the site root itself, NOT `frontend\dist`)
- Backend: `E:\www\Notiq\backend` — pm2 process `notiq-backend`
- Preserve on server: `web.config` and a manual `web.config.bak` in the frontend root.

## Flow
1. **Build locally**
   - Frontend: `cd frontend && npm run build` → `frontend/dist/`
   - Backend: `cd backend && npm run build` → `backend/dist/`
2. **Package** into `_deploy/` zip (pattern: `notiq-v<version>-full-<timestamp>.zip`).
3. **Copy** zip to server.
4. **`deploy/pre-install.cmd`** — stop services + backup.
5. **Extract** package on server.
6. **`deploy/post-install.cmd`** — `npm ci` + prisma + start.

## Frontend copy — CRITICAL
Mirror the **contents of `dist/`** into the site root:
```bat
robocopy "<pkg>\frontend\dist" "E:\www\Notiq\frontend" /MIR /XF web.config web.config.bak
```
- **Always `/MIR`.** A "skip existing" merge leaves OLD `index.html` + `sw.js` (fixed names, no hash) → site silently stays on the previous version while hashed assets look updated.
- robocopy exit codes **1–3 = success** (PowerShell colors them red — not an error).

## Backend — after every deploy
```bash
cd E:\www\Notiq\backend
npx prisma generate
npx prisma migrate deploy   # only if new migrations
pm2 restart notiq-backend
```
Prisma 7 CLI: no `--schema` flag (reads `prisma.config.js`); use `db execute --file` not `--stdin`.

## Verify
- `curl -s https://notiq.epartner.it/` → compare asset hashes vs local `frontend/dist/index.html`.
- `curl -sI https://notiq.epartner.it/sw.js` → check `last-modified` is fresh.
- pm2: `pm2 status notiq-backend` / `pm2 logs notiq-backend`.

## Gotchas
- New `uploads/` subdir → needs explicit static route in `backend/src/app.ts` (no wildcard serving).
- `frontend/public/web.config` holds IIS URL-rewrite rules incl. `/chat-ws` WebSocket rule — don't clobber the server copy.
