# Vault P4, Fase 4: UI del recupero (piano, 13/11/2026)

Base: `feat/vault-p4`. Prima parte (punti aperti della Fase 3 §10.6): CAS sul keyring in `releaseRecovery` con `rev++` nella stessa transazione del flip a `RELEASED`, `notReady` propagato sul percorso ambiguo, testi di `completedElsewhere`/`pinChangedElsewhere`, test sugli enum, validazione della forma su `unlock`, `confirmRecovery`, `cancelRecovery`, `getItems`, `migrateItems`, `finalizeItems`. Revisione della prima parte: reviewer senza BLOCKER/MAJOR, red-team senza CRITICAL/HIGH/MEDIUM. Corretti nello stesso commit i LOW economici: `regenerateKit` al 409 `recoveryInProgress` mostra quel testo invece di `kitNotUpdated` (con un rilascio aperto fino a 7 giorni l'utente ritentava a vuoto); CAS del keyring mancato al rilascio → 409 `recoveryKeyringChanged` distinto da `recoveryStateConflict`; `noteType` di `getItems` controllato solo come stringa (un valore futuro non blocca reconcile e migrazione); `serverShare` di `unlock` lungo esattamente 43 caratteri. Residui accettati: un `changePin` durante l'Argon2id del rilascio fa fallire il CAS e l'admin ripete (il rilascio non parte, nulla trapela); il `rev++` del rilascio è un trigger in più del toast «PIN non applicato» falso (stessa classe del residuo della Fase 3 §10.6); `okMigrated` accetta `results` più corto del lotto (solo con un server ostile).

Questo piano copre la UI (architect, sola lettura; APPROVATO dall'utente il 13/11/2026: F1-F10 e diff TIER 1 dello schema).

## 1. Componenti e macchina a stati

`VaultRecovery` resta montato dentro `VaultPage`, come il wizard di setup: `showWizard = gate.k === 'none' || recoveryOpen`. Così `reconcileEnabled` resta false per tutta la cerimonia e `checkPendingOnStart` non gira né mostra il banner `kitUnconfirmed` (`VaultPage.tsx:119-120,250-262`). Scartata una rotta separata: dopo il 200 lo store è sbloccato e `VaultPage`, rimontata, mostrerebbe il banner.

- `VaultPage`: stato `recoveryOpen`, aperto da `?recovery=1` (banner e notifiche) o da `VaultUnlock.onForgot`. Rende `<VaultRecovery userId onClose(next) renderKit/>`, `next` = `'unlock' | 'regenerate' | 'none'`.
- `VaultRecovery` usa `RecoveryCodeForm`, `PinInput`/`PinPolicy`, `ConfirmDialog` e, dopo `applied`, `RecoveryKitSheet` (chiama già `confirmKit(userId, escrowHash)`, `RecoveryKitSheet.tsx:96`).
- `features/vault/recoveryOutcome.ts`: funzione pura `outcomeOf(result | error) → { key, action }`.

Stati di `VaultRecovery`:
- `loading`: `localRecovery(userId)` + `getKeyring()`. Chiave legata → `status`. Chiave non legata → `syncLocalRecovery` (`active` → `status`, `unknown` → `retryLater`, altrimenti `intro`). Nessuna chiave con `openRecovery` → `foreign`. Nessuna chiave e nessuna richiesta → `intro` (solo da bloccato con keyring `READY`).
- `intro`: avviso «senza Kit resta solo il reset», motivo facoltativo (≤ 500), «Ho il Kit, avvia il recupero» → `startRecovery`. Errori: `alreadyOpen` → `loading`; `retryLater`; 429, 409 `recoveryNoKeyring`, 503 → testo del server.
- `foreign` (richiesta aperta altrove, o storage cancellato da ITP): «Annulla e rifai qui» (`ConfirmDialog` → `cancelRecovery` → `startRecovery`) oppure «Annulla richiesta».
- `status`: `getRecovery` ogni 60 s, al focus e alla visibilità. «Annulla richiesta» in ogni stato aperto; in `RELEASED` avvisa che al prossimo sblocco servirà un Kit nuovo. `PENDING_APPROVAL` (FP, ≤ 7 giorni), `PENDING_CODE` (`RecoveryCodeForm`), `WAITING` (conto alla rovescia), `RELEASED` → `complete`, terminali (`REJECTED` con motivo) → «Nuova richiesta» (`syncLocalRecovery`, poi `intro`) o «Chiudi».
- `complete`: Kit (34 simboli, `normalizeKit`), nuovo PIN due volte (`PinPolicy`, uguali). Una sola `completeRecovery`, protetta da `sentRef` e pulsante disabilitato. Errore lanciato (nessuna POST partita): si resta nel form; `notReady` → «Ricarica». `CompleteResult`: il form si smonta per sempre → `outcome`.
- `outcome`: testo e un pulsante (§2). `applied` → `RecoveryKitSheet(kit, escrowHash)` → `onClose('none')`.
- Invariante: il form `complete` si raggiunge solo da una `getRecovery` appena letta `RELEASED`; dopo `applied` la richiesta è `COMPLETED`, quindi un secondo `completeRecovery` è impossibile anche dopo ricarica. `busy` (lock della cerimonia) → testo e «Riprova».

`RecoveryCodeForm` (`userId`, `requestId`, `fingerprint`, `onChange()`): metà A da `readCodeA` precompilata (F6); `notThisDevice` → «codice visibile solo sul dispositivo che ha fatto la richiesta (FP …)», nessun campo, «Annulla e rifai qui»; null → `onChange()`. Metà B da email (`autoComplete="one-time-code"`). Normalizzazione Crockford e validazione `^[0-9A-HJKMNP-TV-Z]{8}$` su entrambe. «Tentativi rimasti» e «Scade il» da `attemptsLeft`/`expiresAt`. `confirmRecovery`: 200 → `onChange()`; 403 → nuova `getRecovery` (`EXPIRED` → terminale, altrimenti tentativi); 410 → `EXPIRED`; 409 → `onChange()`; 429 → «riprova tra 15 minuti»; rete → «Riprova».

## 2. Verdetti ed errori

Chiavi in `vault.recovery.errors.<code>`.

| Esito | Testo | Azione |
|---|---|---|
| `applied` | cerimonia del Kit | `RecoveryKitSheet`, poi vault sbloccato |
| `appliedKitReplaced` | esistente | «Rigenera il Kit» → `VaultSettingsSheet` |
| `appliedWithoutKit`, `completedElsewhere`, `completedUnverified`, `unknown` | esistenti | «Vai allo sblocco» (`unknown`: riaprendo, se la richiesta è ancora `RELEASED` il form ricompare) |
| `notApplied/keyringChanged`, `notApplied/rejected` | esistenti | «Riprova» con `getRecovery` nuova e form vuoto |
| `notApplied/requestClosed` | esistente | «Nuova richiesta» |
| `kitInvalid` | esistente | resta nel form, svuota il Kit |
| `releaseInvalid` | riscritto | «Annulla e rifai» con `ConfirmDialog`; se ricapita, contattare l'amministratore |
| `updateRequired` (nuovo, F8) | nuovo | «Aggiorna l'app»: `registration.update()` + `location.reload()`; «Non annullare la richiesta» |
| `notThisDevice` | esistente | «Annulla e rifai qui» |
| `notReleased` | esistente | torna a `status` |
| `busy`, `keyringChanged` in preparazione | esistenti | «Riprova» |
| `alreadyOpen`, `retryLater` | esistenti | `loading` / «Riprova tra qualche minuto» |
| `VaultSessionError` `notReady` | nuovo `sessionChanged` | «Ricarica» |
| `keyringInvalid`, rete prima del marker | testi comuni | «Riprova» |

F8: in `vaultRecovery.ts` `rootKeyId` assente dal bundle (~riga 363) e `getActiveRootKey()` null (~riga 374) diventano `updateRequired` (errori di preparazione: nessun marker, nessuna POST). Oggi suggeriscono di annullare, e annullare dopo il rilascio fa perdere il recupero.

Toast «PIN non applicato» in ritardo (F7): solo testo nuovo, `vault.pendingPinNotApplied` = «Un cambio del PIN avviato in precedenza su questo dispositivo non è mai arrivato al server. Resta valido il PIN con cui hai sbloccato.»

Testi nuovi: `updateRequired`, `releaseInvalid` riscritto, `sessionChanged`, `cancelReleasedWarning`, `pendingPinNotApplied`, schermate (`intro`, `status`, `code`, `complete`, `foreign`, `actions`), `vault.kitRotation.*`, `vault.settings.removeOpenRecovery`, `admin.vaultRecovery.*`. EN e IT.

## 3. Backend

- **Segnale di rotazione del Kit (Fase 3 §8), F1=A.** Colonna `VaultRequest.releasedEscrowHash String?` (TIER 1, migration additiva `ALTER TABLE "VaultRequest" ADD COLUMN "releasedEscrowHash" TEXT`). `releaseRecovery` la scrive nella transazione del flip, con lo stesso hash dell'escrow che usa `GET /keyring`: il CAS su `(epoch, rev)` garantisce che sia l'escrow corrente. `kitRotationRequired(userId, escrowHash)`: esiste una richiesta `RECOVERY` con `releasedEscrowHash = escrowHash` e stato `CANCELLED`/`EXPIRED`, o `RELEASED` con `releaseExpiresAt <= now`. Si spegne da solo quando l'escrow cambia (rigenerazione o `complete`). Esposto in `GET /keyring` accanto a `openRecovery` (`routes/vault.ts`); `vault.service.ts` invariato. Alternativa B scartata: derivarlo dall'`AuditLog` (stato funzionale nell'audit, query non indicizzata su JSON, si riaccende dopo una purge).
- `getRecovery` utente: `attemptsLeft` ed `expiresAt` solo in `PENDING_CODE`, `rejectReason` solo in `REJECTED`. `adminView`: `attempts`. Endpoint admin esistenti bastano (lista con `status`/`userId`, dettaglio, approve, reject, release).
- **Solo E2E**, attivo solo con `NODE_ENV === 'test'` **e** `VAULT_E2E === '1'` (pm2 non imposta `NODE_ENV`; `NODE_ENV=test` cambia solo `email.service.ts:17` e `vaultSeal.ts:46`): `utils/vaultE2e.ts` (`isVaultE2E()`, outbox in memoria `requestId → codeB`), `vaultRecoveryNotify.ts` scrive nell'outbox, `routes/vaultE2e.ts` registrato da `routes/vault.ts` (`GET /api/vault/__e2e/recovery/:id/code-b` solo del proprietario, `POST …/advance` porta `notBefore` a `now - 1s` solo in `WAITING`), `utils/vaultRootKeys.ts` con `VAULT_E2E_ROOT_KEYS` unita solo con `isVaultE2E()` e `warn` all'avvio. `app.ts` ed `email.service.ts` (TIER 2) non si toccano.
- Testo admin per 409 `recoveryStateConflict` al rilascio: «lo stato è cambiato, ricarica e riprova» (anche un `changePin` durante l'Argon2id del rilascio fa fallire il CAS; MINOR accettato del primo giro).

## 4. E2E e isolamento della chiave root di test

- Fixture `frontend/e2e/fixtures/vault-root-e2e.json` generata con `backend/src/scripts/vaultRootKeygen.ts` e passphrase di test in `vault-helpers.ts`; valida solo con un backend `VAULT_E2E` e un bundle di sviluppo.
- Frontend: chiave di test inline in `utils/vaultRootKeys.ts` dentro `import.meta.env.DEV && import.meta.env.VITE_VAULT_E2E === '1' ? {…} : {}`; con il flag diventa anche la chiave attiva. In build `DEV` è il letterale `false` e il ramo sparisce.
- Verifica: `frontend/scripts/check-bundle-root-keys.mjs` come `postbuild` (CI, build locale, `Build-Package.ps1`): fallisce se id o SPKI di test compaiono in `dist/**/*.js` e se manca l'id di produzione `rk_68a265761e7e37c7`.
- Avvio locale: backend con `NODE_ENV=test`, `VAULT_E2E=1`, `VAULT_ROOT_KEY_PATH=<fixture>`; Vite con `VITE_VAULT_E2E=1` da `webServer.env` di `playwright.config.ts`. Lo spec fallisce subito se le route `__e2e` danno 404 o se il `rootKeyId` dopo il setup non è quello di test.
- CI (`ci.yml`, job e2e): stesse variabili più `VAULT_PEPPER_KEY` di test e `VAULT_SETUP_USERS='*'`.
- Test 1 (flusso completo, contesti A richiedente, B altro dispositivo, ADM superadmin creato per il test via `PUT /api/admin/users/:id` `role`): setup e nota sicura; richiesta; B vede banner e `foreign`; approvazione; A ha la metà A, B nessun codice nel DOM; metà B errata (4 tentativi) e giusta; `advance`; passphrase errata e giusta (campo svuotato); Kit + PIN due volte → foglio del Kit senza banner `kitUnconfirmed`; conferma; nota leggibile; IndexedDB senza `recovery:<uid>` né marker `kit`; PIN vecchio rifiutato, nuovo accettato.
- Test 2 (rotazione): fino al rilascio, B annulla; A sblocca → foglio obbligatorio con avviso → rigenera → `kitRotationRequired: false`.

## 5. File (avviso multi-file)

- TIER 1 (diff da approvare): `backend/prisma/schema.prisma`, migration nuova.
- Backend: `vaultRecovery.service.ts`, `routes/vault.ts`, `routes/vaultE2e.ts` (nuovo), `utils/vaultE2e.ts` (nuovo), `vaultRecoveryNotify.ts`, `utils/vaultRootKeys.ts`, test.
- Frontend: `VaultRecovery.tsx`, `RecoveryCodeForm.tsx`, `recoveryOutcome.ts`, `admin/tabs/VaultRecoveryTab.tsx` (nuovi); `VaultPage.tsx`, `VaultUnlock.tsx`, `VaultSettingsSheet.tsx` (`forceKit`), `VaultSettingsSection.tsx`, `RecoveryBanner.tsx`, `NotificationItem.tsx`, `AdminPage.tsx`, `lib/vaultRecovery.ts`, `lib/vaultApi.ts`, `lib/vaultSession.ts` (solo tipo), `utils/vaultRootKeys.ts`, `vite-env.d.ts`, locale, `scripts/check-bundle-root-keys.mjs`, `package.json`, `playwright.config.ts`, `e2e/vault-recovery.spec.ts`, fixture, `e2e/vault-helpers.ts`.
- Altro: `.github/workflows/ci.yml`, spec P4, tabella del `CLAUDE.md` di root, runbook `/notiq-deploy` («in prod mai `VAULT_E2E` né `NODE_ENV=test`»).

## 6. Task (TDD)

- **T1** backend: colonna, `kitRotationRequired`, campi di `getRecovery`/admin. Test: release → cancel → flag vero; escrow cambiato → falso; `RELEASED` scaduta → vero; `COMPLETED` → falso; campi solo negli stati previsti. Migration con una sola `ADD COLUMN`. Dal red-team della prima parte: `getRecovery` (`vaultRecovery.service.ts:~311`) legge richiesta e keyring con un `include`, cioè due statement; un `complete` in mezzo accoppia il seal vecchio all'escrow nuovo e il client vede un falso `kitInvalid`. Lettura coerente in una transazione `RepeatableRead`.
- **T2** backend E2E: route 404 con un solo flag; outbox vuoto senza flag; chiave di test assente senza flag; parità estesa.
- **T3** `vaultRecovery.ts`: `updateRequired` nei due casi, nessun marker, nessuna POST.
- **T4** `recoveryOutcome.ts`: `it.each` su ogni verdetto, motivo e codice (chiave EN e IT, azione).
- **T5** `RecoveryCodeForm`: precompilazione, `notThisDevice`, normalizzazione, invio disabilitato, 403/410/429/409.
- **T6** `VaultRecovery` + `VaultPage`/`VaultUnlock`: ogni stato; una sola `completeRecovery`; `escrowHash` al foglio; con `recoveryOpen` niente `checkPendingOnStart` né banner; `foreign`, `busy`, `updateRequired`.
- **T7** rotazione: flag vero e richiesta non `RELEASED` → foglio non chiudibile (uscita «Blocca vault»); sparisce dopo `onDone`; con `RELEASED` aperta non compare (F10).
- **T8** avviso di rimozione con richiesta aperta, link del banner, path della notifica, testo del toast.
- **T9** tab admin: approve, reject (1-500, `ConfirmDialog`), release solo con `readyForRelease`; passphrase svuotata prima dell'`await`, `api.post` (mai `useMutation`); 403/429/503/409; avviso se l'utente è l'admin stesso; bottom sheet su mobile con focus trap.
- **T10** isolamento del bundle: test unitario senza flag; `postbuild` verde; prova negativa una tantum.
- **T11** E2E e CI verdi, `vault*.spec.ts` esistenti verdi con il flag.
- **T12** documenti.

## 7. Decisioni (raccomandazione dell'architect)

F1 colonna `releasedEscrowHash` (A) · F2 foglio di rotazione obbligatorio al primo sblocco, con «Blocca vault» · F3 metà B dall'outbox E2E (aggiornare la spec che dice «mailbox di test») · F4 route `advance` solo E2E · F5 chiave di test in tutte le sessioni E2E · F6 metà A precompilata · F7 toast del PIN: solo testo · F8 codice `updateRequired` · F9 rimozione dal dispositivo: solo avviso · F10 foglio di rotazione soppresso con una richiesta `RELEASED` aperta.

## 8. Rischi e residui

- Limite in memoria della route di release (3 ogni 15 minuti per admin, anche i successi): un superadmin nuovo per ogni test E2E.
- L'isolamento E2E del backend regge solo se in prod non c'è `NODE_ENV=test`: runbook e controllo nel deploy.
- Eliminazione del codice morto: coperta da `postbuild` col controllo positivo.
- Il job e2e della CI oggi non imposta `VAULT_PEPPER_KEY`: gli spec `vault*` forse non girano in CI (da verificare in T11).
- ITP di Safari e ECDSA P-384 su WebKit: prova manuale su iOS (Fase 5).
- `VaultSettingsSection` mostra «Rimuovi» solo con la cache del keyring: senza cache la chiave effimera non si cancella dalla UI.
- Dopo `applied` il `RecoveryBanner` può dire «rilasciata» fino al refresh (un annullo riceve 409): `refresh()` all'uscita.
