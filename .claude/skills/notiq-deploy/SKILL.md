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
- **Mai `VAULT_E2E` né `NODE_ENV=test` in prod** (`backend\.env`, env di macchina o utente, env catturato da `pm2 save`): insieme attivano gli hook solo-E2E del recupero vault e la chiave root di test. `Deploy-Server.ps1` si ferma se li trova (pre-volo); controllarlo anche dopo modifiche manuali all'env.

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
   - `SELECT count(*) FROM "Note" WHERE "isVault" AND "noteType"='NOTE' AND content NOT LIKE '{%';` → note RAW non TipTap interessate dal limite B.16-F, accettato con l'opzione A il 28/10/2026; annotare il risultato senza riaprire il reconcile.
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
   - **H.15, upgrade reale 1.13.3 → P2:** con un account che abbia usato il bundle 1.13.3 e lo sblocco offline attivo, verificare il passaggio PWA `autoUpdate` e la vecchia `api-cache`: dopo uno sblocco online col bundle vecchio lo switch offline torna OFF e la share del dispositivo viene cancellata. Poi hard reload e nuova verifica del keyring come sopra.
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

## Rilascio vault P4 (1.15.0: recupero root + rotazione della VK)
Piani: Fase 2 `docs/superpowers/plans/2026-11-12-vault-p4-fase2-plan.md`, Fase 3 `2026-11-12-vault-p4-fase3-plan.md`, Fase 4 `2026-11-13-vault-p4-fase4-plan.md`, Fase 5 `2026-11-23-vault-p4-fase5-vk-rotation-plan.md` (decisioni D1-D22 al §7, residui al §6). In prod c'è la 1.14.0 (P2) e nessuna attività P4: `feat/vault-p4` porta tutto insieme (recupero con la chiave root, Fasi 1-4, e rotazione della VK, Fase 5). **P3 (reset del vault) NON esiste**: nessuna route di reset, solo i campi `resetScheduledAt` e lo stato UI `resetPending`. Dove sotto si dice «uscita = reset P3», oggi l'uscita non c'è.

**Punto di non ritorno: la prima rotazione della VK in prod** (rigenerazione del Kit o recupero completato da un client 1.15). Prima si torna al `dist` precedente senza perdere nulla; dopo, il DB è a epoch+1 (vedi Rollback P4).

1. **Contenuto del rilascio.**
   - Recupero con la root (Fasi 1-4): richiesta, codice in due metà (A in app, B per email), attesa di 3 giorni, rilascio del SUPERADMIN con la passphrase della root, `complete` con nuovo PIN e nuovo Kit. Dopo un rilascio annullato o scaduto il primo sblocco mostra un foglio di rotazione del Kit obbligatorio.
   - Rotazione della VK (Fase 5): ogni rigenerazione del Kit ruota la VK (epoch+1, `prevVkWrap`); anche il `complete` del recupero ruota. La ricifratura delle note la fa il **client** (`finishRotation`, via `/api/vault/migrate`): nessun job in prod.
   - Prima del passo 5 lanciare `/notiq-release` (bump a 1.15.0, changelog, whatsNew con la nota sulla compatibilità del passo 5). `Build-Package.ps1` legge la versione da `frontend/package.json`. Tag git solo sul pacchetto finale.
2. **Migration** (verificate: additive, colonne nullable senza default). `migrate deploy` deve applicarne **esattamente 2**:
   - `20261113000000_vault_request_released_escrow_hash`: `ALTER TABLE "VaultRequest" ADD COLUMN "releasedEscrowHash" TEXT;`
   - `20261123000000_vault_keyring_prev_vk_wrap`: `ALTER TABLE "VaultKeyring" ADD COLUMN "prevVkWrap" BYTEA;`
   - Prima del build: `git diff --stat main...HEAD -- backend/prisma` deve elencare solo queste due cartelle e `schema.prisma` (+2 righe).
   - Se `migrate deploy` fallisce: `npx prisma migrate resolve --rolled-back <nome della migration fallita>` prima di riprovare, altrimenti ogni deploy successivo dà P3009. Come per P1, prima del deploy su Postgres: `SELECT pid, state, query FROM pg_stat_activity WHERE datname = '<db>' AND state <> 'idle'`, nessuna transazione lunga su `"VaultKeyring"` o `"VaultRequest"`.
   - P2022 (colonna non trovata) dopo il deploy → `npx prisma generate` + `pm2 restart notiq-backend` (vedi Gotchas).
3. **Prerequisiti di config sul server.** Il deploy non li crea e non tocca `backend\.env`.
   - **`VAULT_ROOT_KEY_PATH`** in `E:\www\Notiq\backend\.env`, valore `E:\NotiqSecrets\vault-root.json` (il file della cerimonia P1, passo 7). Lo legge solo `releaseRootShare` a ogni rilascio (`backend/src/services/vaultRootKey.service.ts:84`). **Se la variabile o il file mancano**: il rilascio risponde 503 `errors.vault.rootKeyUnavailable` (non conta come tentativo); il resto del vault funziona. `.env` si legge al boot: serve `pm2 restart notiq-backend`. Né il pre-volo di `Deploy-Server.ps1` né l'avvio la controllano: si prova col passo 6.
   - **Permessi del file.** Il `icacls` del P1 concede solo `Administrators`: l'account con cui gira pm2 `notiq-backend` deve poter **leggere** il file. **Da verificare sul server** (quale utente esegue pm2) prima del deploy; non aprire la cartella a utenti generici.
   - **Chiave pubblica di produzione**: `PRODUCTION_ROOT_KEYS` in `backend/src/utils/vaultRootKeys.ts` e `frontend/src/utils/vaultRootKeys.ts`, `rootKeyId` `rk_68a265761e7e37c7` (quello di P2, test di parità). Il file sul server deve contenere **quella** chiave: `cd E:\www\Notiq\backend; node dist\scripts\vaultRootKeygen.js --verify E:\NotiqSecrets\vault-root.json` (chiede la passphrase) → stessi id del P1 passo 8. Con un id diverso il rilascio risponde 400 `errors.vault.invalidRootKey`; se la firma non verifica con la chiave fissata nel codice, 500 `errors.vault.releaseSignatureInvalid`. `rk_42f37978a7909b3e` è la chiave **di test E2E**: non deve comparire in `frontend\dist` né nel pacchetto (`Build-Package.ps1` e `Deploy-Server.ps1` lo controllano e si fermano).
   - **Passphrase della root.** La digita il SUPERADMIN nella tab admin di recupero al rilascio: non sta sul server né in `.env`. Passphrase errata: 403 `errors.vault.invalidRootPassphrase`, conta per il rate limit (3 rilasci ogni 15 minuti per amministratore, più un contatore su DB che sopravvive al restart). **Mai** scriverla in documenti, chat o log; mai riportare qui il contenuto di `vault-root.json`.
   - **SMTP** (`SMTP_*`): la metà B del codice di recupero viaggia **solo** per email (`backend/src/services/vaultRecoveryNotify.ts:53`). Se l'invio fallisce il recupero non va oltre il codice (nei log `Vault recovery email failed`). Verificare con `npx tsx src/scripts/testSmtp.ts <email>`.
   - **Web-push** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `backend/src/services/push.service.ts:5-15`): facoltativo. Se mancano i log dicono «VAPID keys not configured» e il push è spento; restano notifica in-app ed email.
   - **Job delle scadenze**: parte da solo in `app.ts` (`runRecoveryJobs`, timer ogni 15 minuti, primo giro 15 minuti dopo il boot; scadenze di approvazione 7 giorni, codice 24 ore, rilascio 7 giorni, promemoria 24 ore prima di `notBefore`; la scadenza vale comunque anche in lettura). Dopo il deploy `pm2 logs notiq-backend --nostream --lines 80 | findstr /C:"Vault recovery job scheduled"` → una riga.
   - **`VAULT_SETUP_USERS`** non riguarda rotazione e recupero (chiude solo `POST /keyring`, `vault.service.ts:249`): lasciarlo com'è (`*` dopo l'apertura P2).
   - **Mai `VAULT_E2E` né `NODE_ENV=test` in prod**: vedi Gotchas (pre-volo di `Deploy-Server.ps1` e sonda `GET /api/vault/__e2e/...`, atteso 404).
4. **Prima del deploy (locale).**
   - BE: `cd backend; npm test; npx tsc --noEmit; npm run lint`. FE: `cd frontend; npx vitest run; npx tsc -p tsconfig.app.json --noEmit; npm run lint; npm run build`. Dopo la build: `grep -c "api/vault/" frontend/dist/sw.js` ≥ 1; `grep -rn "rk_42f37978a7909b3e" frontend/dist` vuoto.
   - E2E: backend locale con gli hook di test (`NODE_ENV=test`, `VAULT_E2E=1`, `VAULT_SETUP_USERS=*`, `VAULT_ROOT_KEY_PATH=frontend/e2e/fixtures/vault-root-e2e.json`, pepper e `CORS_ORIGIN` come nel job e2e di `.github/workflows/ci.yml`; **solo nell'env del processo**, mai in `backend/.env`). Poi tutti gli `e2e/vault-*` (`a11y`, `conflict`, `kit`, `migration`, `multidevice`, `offline`, `overwrite`, `recovery`) più `offline-first`, `dexie`, `encryption`, `notes`, `collaboration`, `sharing`. Instabili noti: `collaboration.spec.ts:249` e `:288`, `auth.spec.ts:41`; un FAIL si conferma su `main` pulito con `git stash`.
   - Dopo la suite, sul DB dev, query «nessuna nota o versione vault fuori epoch» (quella del passo 6, senza filtro per utente, limitata agli utenti di test): 0 righe.
   - **WebKit/iOS: PREREQUISITO ANCORA APERTO.** `playwright.config.ts` ha solo il progetto `chromium`. Prova manuale su iPhone (Safari e PWA installata) di: rotazione (due Argon2id in sequenza; durata di `/items` e `/migrate` su un vault grande; rate limit `/migrate` 20/min, `/items` 60/min, `PUT /keyring` 10/h); recupero (ECDSA P-384 su WebKit; ITP che può cancellare lo storage dopo 7 giorni senza visite; piano Fase 4 §8, Fase 5 §6). Da chiudere prima dell'apertura generale.
5. **Pacchetto.**
   - `git log --oneline v1.14.0..HEAD` (la build legge il working tree), `Build-Package.ps1`, `Deploy-Server.ps1 -DryRun`, `Deploy-Server.ps1`. Il `pg_dump` deve completarsi; health check ok.
   - **Annotare il timestamp `ts1` di `_backup_<ts1>`**: è il rollback del `dist` pre-P4. Annotare SHA256 ed entry `index-*.js`.
   - `migrate deploy` applica 2 migration (passo 2). Provare che sia servito l'entry nuovo (hash `index-*.js` uguale a `frontend/dist/index.html`), poi hard reload. Su questo IIS un asset mancante risponde 200 con `index.html`.
   - **Compatibilità (D2): da scrivere nelle note di rilascio.** Il server 1.15 rifiuta `PUT /api/vault/keyring` con `escrow` senza `rotate`: **400 `errors.vault.invalidPayload`** (`backend/src/services/vault.service.ts:354-357`). Un client col bundle 1.14 ancora in cache (PWA `autoUpdate`) non riesce quindi a **rigenerare il Kit** finché non si aggiorna: errore di richiesta non valida, il marker `kit` si cancella (`isDefiniteReject`) e sul server non cambia nulla. Per l'utente: aggiornare l'app (hard reload, o chiudere e riaprire la PWA). Il cambio PIN dal bundle 1.14 (PUT con il solo `wrap`, senza `serverShare`) continua a funzionare.
6. **Canary sull'account del SUPERADMIN**, prima dell'apertura generale. Le query in prod le lancia l'utente in pgAdmin. Annotare `<admin>`: `SELECT id, email FROM "User" WHERE role = 'SUPERADMIN';`.
   - **Prima di tutto**: `pg_dump` esplicito, annotare il percorso (`<dump6>`), e lo stato di partenza: `SELECT epoch, rev, "migrationState", md5("escrowBlob") AS escrow_md5, "prevVkWrap" IS NOT NULL AS has_prev FROM "VaultKeyring" WHERE "userId" = '<admin>';` (atteso `has_prev` falso).
   - **Rotazione.** Hard reload sul PC, vault sbloccato, Impostazioni vault → rigenerazione del Kit (PIN) → Kit → conferma. Lasciar finire la ricifratura (avanzamento in UI). Il dialog «Some notes cannot be opened» non deve comparire con dati sani: se compare, fermarsi e annotare il conteggio (D/K/U).
   - **Controlli SQL dopo la rotazione** (`<admin>`):
     - `SELECT epoch, rev, md5("escrowBlob") AS escrow_md5, "prevVkWrap" IS NOT NULL AS has_prev, length("prevVkWrap") AS prev_len FROM "VaultKeyring" WHERE "userId" = '<admin>';` → epoch = quella annotata + 1, `escrow_md5` diverso, `has_prev` vero, `prev_len` 60.
     - Nessuna nota o versione vault fuori epoch (atteso **0 righe**):
       ```sql
       SELECT 'note' k, ring.epoch, count(*) FROM "Note" n
        JOIN "VaultKeyring" ring ON ring."userId" = n."userId"
        WHERE n."userId" = '<admin>' AND n."isVault" AND n.content LIKE 'nv3.%' AND n.content NOT LIKE 'nv3.' || ring.epoch || '.%'
        GROUP BY 1, 2
       UNION ALL
       SELECT 'version', ring.epoch, count(*) FROM "NoteVersion" v
        JOIN "Note" n ON n.id = v."noteId"
        JOIN "VaultKeyring" ring ON ring."userId" = n."userId"
        WHERE n."userId" = '<admin>' AND n."isVault" AND v.content LIKE 'nv3.%' AND v.content NOT LIKE 'nv3.' || ring.epoch || '.%'
        GROUP BY 1, 2;
       ```
     - Le credenziali «bloccate con un PIN precedente» e gli item oltre 2 MiB (non envelope, noti dal canary P2) non rientrano in questa query.
   - **Da UI**: note e credenziali si aprono con gli stessi valori; blocca e sblocca (decifratura con le chiavi nuove). Telefono: serve uno sblocco **online** (poi offline), vedi i limiti.
   - **Recupero, richiesta aperta e annullata** (senza attendere le 72 h): dal vault bloccato dell'amministratore avviare il recupero e annullarlo subito dalla stessa pagina. Poi `SELECT id, status FROM "VaultRequest" WHERE "userId" = '<admin>' AND type = 'RECOVERY' ORDER BY "createdAt" DESC LIMIT 3;` → l'ultima `CANCELLED`. Limite: `POST /recovery` 3/h per utente. Il rilascio con la passphrase e il `complete` **non** si provano nel canary (attesa di 3 giorni, e il `complete` ruoterebbe di nuovo la VK): il rilascio si prova solo con una richiesta reale e la passphrase dell'utente, e quel giorno si controlla anche `VAULT_ROOT_KEY_PATH` (passo 3).
7. **Apertura.** Nessun interruttore: dopo il deploy rotazione e recupero sono già disponibili per tutti gli utenti con keyring READY. Con il canary verde e WebKit/iOS chiuso, annunciare le note di rilascio (compatibilità D2, limiti sotto). Tenere `<dump6>` finché la prima rotazione di un utente reale non è andata a buon fine.
8. **Limiti noti e uscite** (piano Fase 5 §6; Fase 3 G-I).
   - **Altri dispositivi dopo un recupero o una rotazione.** Dopo un recupero gli altri dispositivi hanno uno `shareEnc` col `serverShare` vecchio: lo sblocco offline col nuovo PIN dà `wrongPin` finché non fanno uno **sblocco online** (G-I, piano Fase 3 :89). Verificato: né la notifica/email `completed` (`backend/src/services/vaultRecoveryNotify.ts`, `backend/src/utils/notificationI18n.ts`) né i testi della cerimonia lo dicono: **limite noto da comunicare all'utente** nelle note di rilascio. Per la rotazione vale lo stesso: l'AAD di `shareEnc` contiene l'epoch, quindi lo sblocco offline dà `offlineUnavailable` finché non c'è uno sblocco online (Fase 5 §3, voluto).
   - **Note K o U oltre `MAX_REWRAP_LEN`** (~1,5 MiB: chiave precedente mancante o envelope non verificabile), **o nota R ricifrata oltre `MAX_ENVELOPE_LEN`** (2 MiB): nel recupero `complete` resta **409 `errors.vault.rotationPending`**, e la rotazione da sbloccato resta bloccata. L'uscita prevista è il reset P3, che **non esiste ancora**: non improvvisare procedure manuali sul DB. Su un server onesto non capita (`assertVaultContent` rifiuta le epoch non correnti, il limite in scrittura del client è lo stesso). Se capita: fermarsi e aprire un incidente.
   - **«Elimina»** (nota D oltre il limite, D18/D20) salta le note con riga Dexie non `synced` o item in coda (toast `vault.rotation.deleteSkippedPending`): l'utente sincronizza e riprova.
   - **Due rotazioni** con un dispositivo offline con edit non sincronizzati: quegli edit restano `LEAVE` per epoch (un solo slot `prev`; D12, D19). Mai cancellati, ma non adottati.
   - **I backup precedenti alla rotazione** (`pg_dump`, `_backup_<ts>`) restano leggibili con la VK vecchia, quindi con un Kit vecchio sopravvissuto: la rotazione non li protegge. Il purge dei backup è P5 (non fatto).
9. **E2E dopo eventuali hotfix:** rieseguire quelli del passo 4.

**Rollback P4.** Ripristinare `dist` da `_backup_<ts1>` come in P1/P2. Le due migration sono additive: le colonne `prevVkWrap` e `releasedEscrowHash` restano nel DB, ignorate dal codice 1.14.
- **Prima della prima rotazione in prod:** rollback pulito. L'epoch non è cambiata, nessuna nota è stata ricifrata.
- **Dopo una rotazione o un recupero completati.** Dalla lettura del codice di `main` (1.14), **senza prova differenziale**: backend e codec della 1.14 trattano l'epoch come dato (guardia `guard.epoch` e AAD con l'epoch del keyring, `main:backend/src/services/vault.service.ts:79,439,515`; `main:frontend/src/lib/vaultCodec.ts:66-99`), le note sono tutte all'epoch nuova con il keyring nuovo: un client 1.14 dovrebbe sbloccare online e leggere. `prevVkWrap` è ignorato. Il `PUT /keyring` della 1.14 (rigenerazione Kit, cambio PIN) resta valido ma non ruota.
- **Dopo una rotazione interrotta** (note ancora a e-1, keyring a e): il client 1.14 non ha `prev`, quindi **non decifra** quelle note, e il suo server rifiuta le scritture con epoch vecchia (422 `errors.vault.stale`). I dati non si perdono, ma restano illeggibili finché non si torna avanti con la 1.15, che finisce il giro. Se il rollback è inevitabile in quel momento, dire all'utente che quelle note tornano leggibili solo con la 1.15.
- Ripristino completo del DB da `<dump6>`: perde le scritture di **tutti** gli utenti dopo il dump; concordare la procedura con l'utente prima di eseguirla. Dopo un `complete` di recupero riporta anche l'escrow precedente (Kit vecchio di nuovo valido): trattarlo come incidente.
- **Da verificare prima del deploy** (non stabilibile con certezza dal codice): (a) prova differenziale su DB dev: ruotare con la 1.15, poi avviare backend e bundle di `main` (1.14) sullo stesso DB e aprire note e credenziali; (b) il client Prisma generato per la 1.15 con il `dist` 1.14 ripristinato (il rollback non rigenera `node_modules`; le colonne nuove sono nullable e il codice vecchio non le seleziona, ma non è provato); (c) Client con bundle 1.15 in cache contro backend 1.14 tornato indietro: lo schema di `PUT /keyring` della 1.14 non è `strict` e scarterebbe `rotate` e `wrap.serverShare` (rotazione = lockout). La 1.15 chiude il caso: `rotateVault` e `changePin` rifiutano con `errors.vault.serverOutdated`, senza PUT (e senza Argon2 né unlock se già la prima GET è della 1.14; sulla rilettura dopo un 409 staleRev la guardia scatta dopo la seconda unlock, che sulla 1.14 conta un tentativo), quando `GET /keyring` non porta `staleCount` (la 1.14 non lo manda mai). Resta solo la finestra di pochi secondi tra la GET e la PUT: se il rollback cade lì, il PIN non apre più quel keyring. Il client non committa nulla in locale (la risposta `{ rev }` della 1.14 non passa il controllo di forma); non chiudere la scheda ancora sbloccata e aprire un incidente. Il recupero non è esposto: sulla 1.14 le sue route non esistono (404, nessuna scrittura). Resta valida la raccomandazione: dopo l'apertura del rilascio preferire il forward-fix al rollback del backend.
