---
name: notiq-deploy
description: Deploy Notiq to production (notiq.epartner.it — IIS + pm2). Use when the user asks to deploy, ship, or release to the live server. Drives the two PowerShell scripts (local Build-Package.ps1 + server Deploy-Server.ps1) and lists the owner's manual steps. Encodes the hard-won robocopy/IIS/pg_dump gotchas.
disable-model-invocation: true
---

# Notiq — Production Deploy

Live target: **notiq.epartner.it** — IIS (ARR reverse proxy) + pm2. Windows Server, multi-site (~30 IIS sites) — **never touch other sites** (only `E:\www\Notiq`).

## Server paths (verified)
- Frontend physical root: **`E:\www\Notiq\frontend`** (the site root itself, NOT `frontend\dist`)
- Backend: `E:\www\Notiq\backend` — pm2 process `notiq-backend`
- Preserve on server: `web.config` + a manual `web.config.bak` in the frontend root; and `backend\.env` (never overwritten).

## Two automated scripts (in `deploy/`)
| Script | Runs on | Does |
|--------|---------|------|
| `Build-Package.ps1` | **dev machine** (repo root) | build FE+BE → stage → `_deploy\notiq-v<ver>-full-<ts>.zip` (includes `Deploy-Server.ps1`) |
| `Deploy-Server.ps1` | **prod server** (extracted pkg) | pg_dump DB backup → app backup → pm2 stop → robocopy `/MIR` → `npm ci` + prisma generate + migrate deploy → pm2 restart → verify |

Legacy `pre-install.cmd` / `post-install.cmd` remain as manual fallback; the PS scripts supersede them (add pg_dump DB backup + robust error handling).

## Standard flow
1. **Release first** (if not done): bump version + changelog → see `notiq-release` skill. Commit.
2. **Build & package (local):**
   ```powershell
   .\deploy\Build-Package.ps1            # or -SkipBuild to repackage existing dist
   ```
   → produces `_deploy\notiq-v<ver>-full-<ts>.zip` + prints SHA256.
3. **Copy** the zip to the server (e.g. `E:\www\Notiq\_incoming\`) and **extract** it.
4. **Dry-run on server** (no destructive action — sanity check paths/DB parse):
   ```powershell
   .\Deploy-Server.ps1 -PackageDir <extracted> -DryRun
   ```
5. **Deploy for real:**
   ```powershell
   .\Deploy-Server.ps1 -PackageDir <extracted>
   ```
6. **Verify** (see checklist below).

## Owner manual checklist (the human steps the scripts can't do)
Copy this into a todo list each deploy:

- [ ] **Pre:** confirm release done — version bumped in `frontend/package.json`, `changelog.ts` entry added, i18n keys in en+it, committed & pushed.
- [ ] **Pre:** run E2E for touched flows (`cd frontend && npx playwright test e2e/<spec>`).
- [ ] **Pre:** run `.\deploy\Build-Package.ps1` locally; note the zip path + SHA256.
- [ ] **Transfer:** copy the zip to the server; verify SHA256 matches; extract.
- [ ] **Server prereqs (first deploy only):** `pg_dump` on PATH, `pm2` on PATH, `backend\.env` present & correct, Node ≥20.19.
- [ ] **Dry-run:** `.\Deploy-Server.ps1 -PackageDir <extracted> -DryRun` — read output, confirm DB target + paths are right.
- [ ] **Deploy:** `.\Deploy-Server.ps1 -PackageDir <extracted>`. Watch for pg_dump success and robocopy/migrate output.
- [ ] **Verify site:** open https://notiq.epartner.it — compare asset hashes vs local `frontend/dist/index.html`; `curl -sI https://notiq.epartner.it/sw.js` → `last-modified` fresh.
- [ ] **Verify app:** login, create note (sync→DB), Vault (PIN), share + invite email (SMTP), Kanban board (offline + realtime), Chat.
- [ ] **Verify backend:** `pm2 status notiq-backend` online; `pm2 logs notiq-backend --lines 50` clean.
- [ ] **Rollback ready:** note the `E:\www\Notiq\_backup_<ts>` folder the script created (DB dump + app). To roll back: restore files from it and `pg_restore` the `.dump`.

## Frontend copy — CRITICAL (why `/MIR`)
A "skip existing" merge leaves OLD `index.html` + `sw.js` (fixed names, no content hash) → the site silently stays on the previous version while hashed assets look updated. `Deploy-Server.ps1` always uses `robocopy /MIR /XF web.config web.config.bak`. robocopy exit codes **1–7 = success** (PowerShell colors them red — the scripts already treat <8 as success).

## Gotchas
- **pg_dump version**: must be ≥ the server Postgres major version, else the dump aborts. If it fails, install a matching/newer PostgreSQL client.
- **DATABASE_URL parse**: `Deploy-Server.ps1` reads it from `backend\.env` and URL-decodes user/pass. If the password has exotic chars and parsing fails, the dry-run will surface it before any destructive step.
- New `uploads/` subdir → needs an explicit static route in `backend/src/app.ts` (no wildcard serving).
- Prisma 7 CLI: no `--schema` flag (reads `prisma.config.js`); use `db execute --file` not `--stdin`.
- P2022 (column not found) after deploy → `npx prisma generate` + `pm2 restart notiq-backend`.
