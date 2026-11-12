# Vault P4: handoff per la ripartenza dalla Fase 2 (1/11/2026)

Documento per riprendere il lavoro in una sessione nuova (anche in cloud) senza la memoria locale. Il design di riferimento è `2026-09-30-vault-v3-design.md`: sezione 3 (recupero da root in doppio controllo) e P4 a riga 562.

## Baseline

- Produzione: Notiq 1.14.0, tag `v1.14.0` = `b35dbd9`, KDF t=10.
- Branch di lavoro: `feat/vault-p4`, ultimo commit `9003935`.
- Nessuna attività P4 in produzione.
- Mai condividere o committare Kit, passphrase root o `vault-root.json`. La root usata nei test è solo di test e non entra mai nel bundle di produzione.

## Fatto: Fase 1

- `72428af`: `backend/src/services/vaultRootKey.service.ts`. Apertura del file root cifrato, selezione del `rootKeyId`, apertura di `S_root`, seal verso `clientEphPub`, firma del rilascio. Test con due chiavi e passphrase errata.
- `9003935`: `backend/src/services/vaultRecovery.service.ts`. Richiesta, approvazione, conferma, attesa 72h, rilascio condizionato, completamento idempotente, cancellazione e scadenze. I codici A/B esistono solo come HMAC. I contatori di release sono per admin. `complete` richiede `vkProof` e scrive keyring e request in un'unica transazione.
- Ultima verifica registrata: backend 1882/1882, build verde, lint senza errori (warning preesistenti).
- Il fixture `vault.route.test.ts` è stato portato da t=3 a `KDF_T_MIN` (t=10).

## Vincoli già verificati

- Nessuna migration Prisma: `VaultRequest`, gli enum e `NotificationType.VAULT_RECOVERY` esistono già (`20261001000000_vault_e2ee`). Un campo nuovo richiederebbe comunque una migration, mai `db push`.
- Crypto riutilizzabile: `openRootKeyFile`, `openRootShare`, `deriveRk`, `unwrapEscrow`, `verifyVkProof`.
- `authVerifierOf` è esportato da `vault.service.ts` per il wrap del nuovo PIN.

## Prossimo: Fase 2

1. Route utente `/api/vault/recovery/*` e admin `/api/admin/vault-recovery/*`.
2. `openRecovery` in `GET /keyring` e banner non chiudibile in `AppLayout` (aggiornamento al focus e polling ogni 15 minuti).
3. Guardia sulle notifiche `VAULT_RECOVERY`: delete, deleteAll e markAll non devono toccarle finché la richiesta è aperta.
4. Email EN e IT per richiesta, metà B, attesa, rilascio, completamento ed errori. Job per le scadenze.

Regole di processo:

- `backend/src/app.ts` e `backend/src/services/email.service.ts` sono TIER 2: prima di modificarli si mostra il diff e si attende l'approvazione esplicita dell'utente.
- I file TIER 1 e TIER 2 si modificano con Edit (hook `tier1-guard`), mai con `git apply`.
- Dopo `git add` e prima del commit, gate: `node "$HOME/.claude/jev-gate.mjs"`. Se non esiste nell'ambiente, trattare il rischio come medium (reviewer; red-team se tocca auth, migration o concorrenza).
- Push dopo ogni commit.

## Dopo

- Fase 3: chiave ECDH P-384 effimera nel DB IndexedDB raw `notiq-vault-device` (upgrade additivo, non Dexie), sessione client Kit → RK → VK, nuovo PIN ed escrow, nuovo Kit mostrato prima di `complete`, marker pending anti-perdita.
- Fase 4: `VaultRecovery.tsx`, `RecoveryCodeForm.tsx`, tab admin, i18n EN e IT, dark mode e mobile.
- Fase 5: test unit, integration ed E2E completi; poi eventuale release 1.15.0 con dump del DB e canary tramite `VAULT_SETUP_USERS`.

## Ambiente di sviluppo

- `backend/.env` non è nel repo: partire da `backend/.env.example`. I test backend e Prisma richiedono un Postgres raggiungibile (dev: container `notiq-db`, porta 5434).
- Typecheck frontend: `npx tsc -p tsconfig.app.json --noEmit` (il `tsc --noEmit` liscio non compila nulla). I test backend non sono typechecked.
- E2E instabili noti: `collaboration.spec.ts:249` e `auth.spec.ts:41`. Non archiviarli come flaky senza conferma con `git stash` su `main` pulito.
- Regole di progetto (TIER, i18n, dark mode, Dexie): `CLAUDE.md` di root e `frontend/CLAUDE.md`.

## Backlog separato

- Delivery delle notifiche alla scadenza dei promemoria: non implementata.
- Conferma esplicita di "sincronizzazione completata": assente.

## Aggiornamento 12/11/2026: Fase 2 completata

Piano eseguito: `docs/superpowers/plans/2026-11-12-vault-p4-fase2-plan.md` (task T1-T9, gap G1-G12, decisioni U1-U5, residui in §8). Commit su `feat/vault-p4`:

- `471ccd9`: piano della Fase 2 e porta del DB dev spostata a 5434.
- `f4f0319` (blocco A, T1-T3): correzioni della Fase 1, `sealRecoveryCode`, API admin, notifiche ed email del recupero.
- `d14c841` (blocco B, T4-T7): route utente e admin, guardia sulle notifiche, job delle scadenze e dei promemoria in `app.ts`, validazione del file root.
- Blocco C (T8-T9): banner `RecoveryBanner` + `useOpenRecovery` in `AppLayout`, `buildArgs` con il fingerprint, contratti del fingerprint e di `sealedCodeA` nella spec §3.2.

Verifiche: backend 2082/2082; frontend 1212 test, typecheck pulito; E2E `vault*.spec.ts` 19/19 (i 3 test di `vault-a11y` falliti al primo giro per carico passano al rilancio); prova visiva del banner in chiaro, scuro e mobile. Ogni blocco è passato da reviewer e red-team, senza BLOCKER/MAJOR/CRITICAL/HIGH aperti.

Decisioni prese durante l'esecuzione (già nella spec):
- La quota di 3 richieste in 30 giorni non conta le `EXPIRED` per tentativi esauriti.
- Una `WAITING` non rilasciata scade 7 giorni dopo `notBefore`.
- `GET /vault/keyring` e `DELETE /vault/recovery/:id` hanno il rate limit per utente, sessione e IP.
- Residui accettati e documentati in §3.2: segna-letto singolo, corsa tra guardia e create, limite di route in memoria per worker pm2.

Prossimo: Fase 3. Contratti da rispettare nel client: fingerprint a 40 bit (vettore fisso nel test G1 di `vaultRecovery.service.test.ts`), blob `sealedCodeA` da 133 byte (spec §3.2.4), firma del rilascio verificata con la chiave root fissata.
