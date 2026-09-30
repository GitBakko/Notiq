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
3. **Copy** the zip to the server (e.g. `E:\www\Notiq\_incoming\`) and **extract** it into a NEW dedicated subfolder (the zip has no top-level folder), e.g. `E:\www\Notiq\_incoming\notiq-vX.Y.Z-<ts>\` — never directly into `_incoming`.
4. **Dry-run on server** (no destructive action — sanity check paths/DB parse):
   ```powershell
   cd <extracted>; .\Deploy-Server.ps1 -DryRun
   ```
5. **Deploy for real:**
   ```powershell
   cd <extracted>; .\Deploy-Server.ps1
   ```
6. **Verify** (see checklist below).

## Owner manual checklist (the human steps the scripts can't do)
Copy this into a todo list each deploy:

- [ ] **Pre:** confirm release done — version bumped in `frontend/package.json`, `changelog.ts` entry added, i18n keys in en+it, committed & pushed.
- [ ] **Pre:** run E2E for touched flows (`cd frontend && npx playwright test e2e/<spec>`).
- [ ] **Pre:** run `.\deploy\Build-Package.ps1` locally; note the zip path + SHA256.
- [ ] **Transfer:** copy the zip to the server; verify SHA256 matches; extract into a NEW subfolder (e.g. `_incoming\notiq-vX.Y.Z-<ts>\`), never flat into `_incoming`.
- [ ] **Server prereqs (first deploy only):** `pg_dump` on PATH, `pm2` on PATH, `backend\.env` present & correct, Node ≥20.19.
- [ ] **Dry-run:** `cd <extracted>; .\Deploy-Server.ps1 -DryRun` — read output, confirm DB target + paths are right.
- [ ] **Deploy:** `cd <extracted>; .\Deploy-Server.ps1`. Watch for pg_dump success and robocopy/migrate output.
- [ ] **Verify site:** open https://notiq.epartner.it — compare asset hashes vs local `frontend/dist/index.html`; `curl -sI https://notiq.epartner.it/sw.js` → `last-modified` fresh.
- [ ] **Verify app:** login, create note (sync→DB), Vault (PIN), share + invite email (SMTP), Kanban board (offline + realtime), Chat.
- [ ] **Verify backend:** `pm2 status notiq-backend` online; `pm2 logs notiq-backend --lines 50` clean.
- [ ] **Rollback ready:** note the `E:\www\Notiq\_backup_<ts>` folder the script created (DB dump + app). To roll back: restore files from it and `pg_restore` the `.dump`.

## Frontend copy — CRITICAL (why `/MIR`)
A "skip existing" merge leaves OLD `index.html` + `sw.js` (fixed names, no content hash) → the site silently stays on the previous version while hashed assets look updated. `Deploy-Server.ps1` always uses `robocopy /MIR /XF web.config web.config.bak`. robocopy exit codes **1–7 = success** (PowerShell colors them red — the scripts already treat <8 as success).

## Gotchas
- **Extract into a fresh subfolder and run the script from inside it** (`PackageDir` defaults to the script's own folder). Never extract flat into `_incoming` (the zip has no top-level folder; `Expand-Archive` never removes orphans, so old files accumulate and `/MIR` would deploy them) and never copy the script out of its package folder (a stale copy would deploy with the old script next release).
- **pg_dump version**: must be ≥ the server Postgres major version, else the dump aborts. If it fails, install a matching/newer PostgreSQL client.
- **DATABASE_URL parse**: `Deploy-Server.ps1` reads it from `backend\.env` and URL-decodes user/pass. If the password has exotic chars and parsing fails, the dry-run will surface it before any destructive step.
- New `uploads/` subdir → needs an explicit static route in `backend/src/app.ts` (no wildcard serving).
- Prisma 7 CLI: no `--schema` flag (reads `prisma.config.js`); use `db execute --file` not `--stdin`.
- P2022 (column not found) after deploy → `npx prisma generate` + `pm2 restart notiq-backend`.

## Rilascio vault P1 (una tantum)
Piano: `docs/superpowers/plans/2026-09-30-vault-p1-plan.md` §6 + addendum. P1 aggiunge la migration `20261001000000_vault_e2ee`, le route `/api/vault/*` (503 sulle scritture finché non c'è la root) e la cerimonia della chiave root. Nessun cambio UX.

1. **Locale.** Backend: `npm test`, `npx tsc --noEmit`, `npm run lint`.
2. **Locale, e2e.** Rieseguire `vault-overwrite`, `notes`, `sharing`, `collaboration`, `encryption`, `import`, `offline-first`. `collaboration.spec.ts:249` e `auth.spec.ts:41` sono instabili noti: un FAIL si conferma con `git stash`.
3. **Pepper.** `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Salvarlo nel password manager (voce "Notiq VAULT_PEPPER_KEY", **separata** dai backup DB) e aggiungere `VAULT_PEPPER_KEY=<valore>` a `E:\www\Notiq\backend\.env`. **Mai** nell'env di macchina/utente: `pm2 save` lo scriverebbe nel dump.
4. **Cartella root.** `mkdir E:\NotiqSecrets`, poi `icacls E:\NotiqSecrets /inheritance:r /grant:r "Administrators:(OI)(CI)F"`. I passi 4 e 7 vanno eseguiti in una PowerShell **elevata** (Esegui come amministratore), altrimenti la cerimonia non riesce a scrivere nella cartella.
5. **Pacchetto.** `git log --oneline v1.12.2..HEAD` (la build legge il working tree), `Build-Package.ps1`, poi `Deploy-Server.ps1 -DryRun` (pre-flight senza errori), poi `Deploy-Server.ps1`; health check ok (come piano §6).
   - **Prima del deploy**, su Postgres: `SELECT pid, state, query FROM pg_stat_activity WHERE datname = '<db>' AND state <> 'idle'`. Nessun lock su `"User"`, altrimenti `migrate deploy` resta appeso con pm2 fermo.
   - `migrate deploy` (passo 7) deve applicare **1** migration (`20261001000000_vault_e2ee`). Se fallisce: `npx prisma migrate resolve --rolled-back 20261001000000_vault_e2ee` prima di riprovare, altrimenti ogni deploy successivo dà P3009.
   - Il `.env` nel `_backup_<ts>` è **senza** pepper (lo script lo toglie): in caso di ripristino va reinserito dal password manager.
6. **Verifiche post-deploy.**
   - `pm2 logs notiq-backend --nostream --lines 80 | findstr /C:"vault secrets"` → `vaultPepper:"ok"`. Annotare `pepperKeyId` accanto al pepper nel password manager.
   - `pm2 logs notiq-backend --nostream --lines 200 | findstr /C:"remoteAddress"` → devono comparire IP **pubblici e senza porta**.
     - Solo `127.0.0.1`: ARR non manda `X-Forwarded-For`, il rate limit per IP è di fatto spento.
     - `ip:porta`: prima `& "$env:windir\system32\inetsrv\appcmd.exe" list config -section:system.webServer/proxy`, poi `& "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.webServer/proxy /includePortInXForwardedFor:false`. Attenzione: `system.webServer/proxy` e' un'impostazione ARR a livello di server e vale per **ogni** sito che passa da ARR su quel server.
   - Con un JWT di test: `GET /api/vault/keyring` → 200 `{status:'NONE'}`; `POST /api/vault/keyring` → 503.
   - `SELECT count(*) FROM "VaultKeyring"` = 0.
   - Hard reload (vedi sopra): login, nota, vault legacy, condivisione.
7. **Cerimonia root.** Da console RDP: `cd E:\www\Notiq\backend; npm run vault:root-keygen -- --out E:\NotiqSecrets\vault-root.json`. Passphrase ≥20 caratteri in una voce **diversa** del password manager; salvare l'output (sha256 + JSON `pub`).
8. **Copia offline.** Copiare il file cifrato fuori dal server, senza la passphrase accanto. Sulla copia: `node dist\scripts\vaultRootKeygen.js --verify <copia>` → stessi id.
9. **Chiavi pubbliche.** **Non** committarle ora: vanno nel branch P2 (`backend/src/utils/vaultRootKeys.ts` + `frontend/src/utils/vaultRootKeys.ts`, test di parità).

**Rollback.** Ripristinare `dist` da `_backup_<ts>`; il DB resta com'è (migration additiva). Il `.env` live non viene toccato dal deploy: se lo si ripristina dal backup, reinserire il pepper.
