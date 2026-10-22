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

## Rilascio vault P2 (client E2EE, un solo rilascio)
Piano: `docs/superpowers/plans/2026-10-02-vault-p2-plan.md` §11 + addendum. Reconcile: `docs/superpowers/plans/2026-10-22-vault-t15-reconcile-spec.md`. **Nessuna migration**: `migrate deploy` deve dire "No pending migrations". Il bundle nuovo non ha più lo sblocco legacy: dal deploy all'apertura del canary l'account con vault legacy (oggi uno solo, l'utente, lo stesso SUPERADMIN del canary) NON apre il vault, né online né offline. Stima 2-4 h, al massimo 1 giorno lavorativo.

**Punto di non ritorno: il primo keyring READY in prod.** Prima si torna al `dist` precedente. Dopo si va solo avanti (forward-fix), con un `pg_dump` fresco (vedi passo 8) o con SQL per utente.

**Prerequisiti.** Branch `feat/vault-p2` completo: T25 (chiavi pubbliche reali `rk_68a265761e7e37c7`, ricevute dall'utente) e T26 (e2e) fatti. T25 toglie il lock P1: da quel commit un keyring READY è possibile, quindi il branch si unisce a `main` solo con tutto P2. Prima del passo 4 lanciare `/notiq-release` (bump versione + changelog + whatsNew): `Build-Package.ps1` legge la versione da `frontend/package.json` e i due zip hanno la stessa versione. Il tag git va solo sul pacchetto finale: quello del passo 4 se t = 3, quello del passo 7 se t > 3. Le chiavi si fissano in `backend/src/utils/vaultRootKeys.ts` e `frontend/src/utils/vaultRootKeys.ts`, con il test di parità.

1. **Locale.**
   - BE: `cd backend; npm test; npx tsc --noEmit; npm run lint`. FE: `cd frontend; npx vitest run; npx tsc -p tsconfig.app.json --noEmit; npm run lint; npm run build`.
   - Dopo la build: `grep -c "api/vault/" frontend/dist/sw.js` deve dare almeno 1 (il predicato Workbox serializzato esclude `/api/vault/`). `grep -rn "rk_e434f78b8f179ab3" backend/src frontend/src` deve essere vuoto.
   - E2E con `VAULT_SETUP_USERS=*` nel `backend/.env` di dev: i 5 nuovi `vault-{kit,multidevice,offline,migration,conflict}`, `vault-overwrite` adattato, più `offline-first`, `dexie`, `encryption`, `notes`, `collaboration`, `sharing`. Instabili noti: `collaboration.spec.ts:249` e `:288`, `auth.spec.ts:41`; un FAIL si conferma su `main` pulito con `git stash`.
   - T6 (bench) verde. D4 (il valore di `t`) si chiude al passo 6, con la misura in prod.
2. **Pre-deploy, su Postgres di prod** (annotare i risultati):
   - `SELECT count(*) FROM "VaultKeyring";` → 0.
   - `SELECT "userId", count(*) FROM "Note" WHERE "isVault" AND content NOT LIKE 'nv3.%' GROUP BY 1;` → utenti con vault legacy.
   - `SELECT n.id FROM "Note" n WHERE n."isVault" AND EXISTS (SELECT 1 FROM "Attachment" a WHERE a."noteId" = n.id);` → note vault con allegati (il corpo si migra, gli allegati si segnalano: D3).
   - `SELECT "userId", count(*) FROM "Note" GROUP BY 1 HAVING count(*) > 50;` → utenti toccati da `GET /notes?all=1` (il 21/10 era vuoto).
   - `SELECT count(*) FROM "Note" WHERE "noteType" = 'CREDENTIAL' AND "searchText" IS NOT NULL;` → credenziali vecchie con testo in chiaro nell'indice di ricerca. Il codice nuovo non lo rigenera, ma le righe esistenti si ripuliscono solo con una scrittura in prod: farla (`UPDATE "Note" SET "searchText" = NULL WHERE "noteType" = 'CREDENTIAL' AND "searchText" IS NOT NULL;`, il conteggio deve coincidere con quello della query sopra) solo dopo `pg_dump` e con conferma esplicita dell'utente.
   - Lock su `"User"`: `SELECT l.pid, l.mode, a.query FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.relation = '"User"'::regclass;` (P2 non ha migration: serve solo se un'altra sessione tiene lock).
   - Id del SUPERADMIN: `SELECT id, email FROM "User" WHERE role = 'SUPERADMIN';`. Annotarlo: è il `<id SUPERADMIN>` / `<admin>` del passo 8.
3. **`.env` di prod.** In `E:\www\Notiq\backend\.env` lasciare `VAULT_SETUP_USERS=` vuoto (o assente): `createKeyring` risponde 503 `errors.vault.setupDisabled` a tutti. Il deploy non tocca il `.env`, quindi il valore resta. Così nessun keyring READY può nascere prima del passo 8. Il kill switch chiude solo la creazione del keyring (`POST /keyring`, e `GET /keyring` dà `setupAllowed:false`): `/migrate`, `/items` e `/finalize` controllano solo `guard.ready`, quindi chi ha già un keyring READY continua a migrare anche con la variabile svuotata.
4. **Pacchetto (primo deploy, senza tag).**
   - `git log --oneline v1.13.3..HEAD` (la build legge il working tree), `Build-Package.ps1`, `Deploy-Server.ps1 -DryRun`, `Deploy-Server.ps1`. Il `pg_dump` deve completarsi; health check ok.
   - **Annotare il timestamp `ts1` di `_backup_<ts1>`.** Il rollback pre-P2 è sempre `_backup_<ts1>`, non quello dell'eventuale secondo deploy (che contiene già il primo `dist` P2).
   - Annotare SHA256 ed entry `index-*.js` del pacchetto nell'addendum D4 del piano (i due zip possono avere la stessa versione in `frontend/package.json`).
5. **Bundle.** Provare che sia servito l'entry nuovo (hash `index-*.js` uguale a `frontend/dist/index.html`), poi hard reload. Su questo IIS un asset mancante risponde 200 con `index.html`, non 404.
   - Con un JWT di test: `GET /api/vault/keyring` → 200 `NONE` con `setupAllowed:false`. Non provare `POST /api/vault/keyring` con un body finto: la validazione Zod risponde 400 prima del kill switch.
6. **Misura (D4, D13), con `VAULT_SETUP_USERS` ancora vuoto.** Account SUPERADMIN, rotta `/admin/vault-bench`, sull'iPhone di riferimento (iPhone 12 o più recente, A14+; se ce n'è più d'uno, il più vecchio). Prima in Safari, poi nella PWA installata; schermo sempre acceso, nessun'altra app in primo piano. t da 3 a 10 in ordine crescente, a 64 MiB, con screenshot dopo ogni t (un OOM vero ricarica la pagina). Incollare il JSON nell'addendum D4.
   - **t scelto = il massimo che rispetta ENTRAMBI i vincoli in Safari E nella PWA:** p95 a caldo al massimo 1,5 s (20 campioni) e sblocco a freddo al massimo 2 s (3 campioni, il peggiore). Minimo 3.
   - Poi `SELECT count(*) FROM "VaultKeyring";` → 0.
7. **Correzione di `t`.**
   - t = 3: niente.
   - t maggiore di 3: UN commit con `DEFAULT_KDF.t` (`frontend/src/utils/argon2.ts:4`) e il solo valore di `KDF_T_MIN` (`backend/src/services/vault.service.ts:199`, usata da `routes/vault.ts:16` e `vault.service.ts:302`). Verde `vault.keyring.test.ts` e `vault.service.test.ts` (i test con `t = KDF_T_MIN - 1` → 400 su POST e PUT devono passare col nuovo valore; nessuna chiamata contro prod). Poi `Build-Package.ps1` e `Deploy-Server.ps1` di nuovo (secondo deploy, **senza** `-SkipDbBackup`). Verificare il nuovo `index-*.js` con hard reload e il bench: `DEFAULT_KDF.t` uguale al t scelto. Annotare SHA256 ed entry anche di questo pacchetto. Il tag va solo qui.
   - **STOP** se t = 3 già viola un vincolo o c'è OOM: rollback del `dist` da `_backup_<ts1>` (ammesso, perché non esiste nessun keyring) e si torna dall'utente. Ridurre `m` sotto 64 MiB è vietato dal controllo dei `kdfParams` e richiede una decisione nuova.
8. **Canary SUPERADMIN.**
   - **Prima di tutto** (rollback): `pg_dump` esplicito del DB, annotare il percorso (`<dump8>`), e salvare lo stato d'origine: `SELECT id, "isEncrypted", title, "noteType" FROM "Note" WHERE "userId" = '<admin>' AND "isVault";` (la colonna `isEncrypted` d'origine non sta in `NoteVersion`: `migrateItems` la forza a true).
   - `VAULT_SETUP_USERS=<id SUPERADMIN>` in `.env`, poi `pm2 restart notiq-backend` (dotenv si legge al boot).
   - Prima del setup, sul dispositivo del canary (browser del PC): hard reload, aprire il bench e controllare che `DEFAULT_KDF.t` e l'entry siano quelli del pacchetto deployato. Il pavimento server `KDF_T_MIN` è solo la rete di sicurezza.
   - Migrazione nel browser (wizard). Prima di rigenerare il Kit annotare `SELECT md5("escrowBlob") FROM "VaultKeyring" WHERE "userId" = '<admin>';`.
   - `SELECT content ~ '^nv3\.' AS env, title = '' AS t, "searchText" IS NULL AS s, "ydocState" IS NULL AS y, count(*) FROM "Note" WHERE "userId" = '<admin>' AND "isVault" GROUP BY 1,2,3,4;` → solo `true`, tranne le credenziali "bloccate con un PIN precedente" e gli item oltre 2 MiB (elencati dal wizard).
   - `SELECT count(*) FROM "NoteVersion" v JOIN "Note" n ON n.id = v."noteId" WHERE n."userId" = '<admin>' AND n."isVault" AND v.content NOT LIKE 'nv3.%';` → 0 per gli id finalizzati.
   - `SELECT "userId", status, epoch, "migrationState" FROM "VaultKeyring" WHERE "userId" = '<admin>';` → `READY`; `migrationState` è `DONE` solo se `legacyCount` è 0 (il cestino, le credenziali bloccate e gli item oltre 2 MiB lo tengono in `IN_PROGRESS`: atteso).
   - I titoli si vedono decifrati nella lista vault. Telefono: sblocco con il PIN, poi offline. Rigenerazione del Kit → `md5("escrowBlob")` diverso da quello annotato.
   - Cache Storage (build di prod): DevTools, `api-cache` senza `/api/vault/` né `/api/notes/...`; dopo il logout `api-cache` non c'è.
9. **Apertura.** `VAULT_SETUP_USERS=*`, `pm2 restart notiq-backend`. Fra i passi 4 e 9 gli altri utenti con vault legacy non accedono al vault: tenere la finestra corta.
10. **Dopo l'apertura.**
    - Query legacy settimanale (quella del passo 2, seconda voce); contattare chi non ha migrato.
    - Retention dei dump che contengono ancora plaintext vault (design:335).
    - Bundle 1.13.x ancora in cache dopo il keyring: i 422 compaiono come banner generico fino all'aggiornamento del SW; il reconcile assorbe gli item rimasti.
11. **E2E dopo eventuali hotfix:** rieseguire quelli del passo 1.

**Rollback P2.**
- Prima del passo 8: ripristinare `dist` da `_backup_<ts1>`. `GET /notes?all=1` è opt-in e retrocompatibile.
- Dopo il passo 8: la finestra per il rollback via SQL non esiste. Il wizard chiama `finalizeItems` subito dopo ogni batch verificato (`vaultMigration.ts`, in `sendBatch`) e `finalize` cancella le `NoteVersion` non `nv3.` (`vault.service.ts`, `finalize`). Finito il wizard l'unica via indietro è il ripristino dal dump.
- Ripristino DB: usare `<dump8>` (preso subito prima del passo 8, senza keyring), non `_backup_<ts1>` (quest'ultimo vale per `dist`; un eventuale `_backup_<ts2>` ha un dump più recente ma ancora senza keyring). **Un ripristino completo perde le scritture di TUTTI gli utenti dopo il dump** (ore di misura e canary). Comandi: `pm2 stop notiq-backend`, `pg_restore` del dump in un DB temporaneo, poi o `--clean` sul DB di prod, o copia per utente delle righe del canary (`Note`, `NoteVersion`, `VaultKeyring` da cancellare) dal DB temporaneo; `UPDATE` completo = `content`, `title`, `searchText`, `ydocState`, `isEncrypted`, `noteType` dai valori d'origine. La procedura va concordata con l'utente prima di eseguirla.
