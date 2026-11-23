# Vault P4, Fase 5: rotazione della VK (piano, 23/11/2026)

Stato: **piano dell'architect approvato; D1-D5 approvate dall'utente il 23/11/2026 come raccomandate. D6-D10 approvate dall'utente lo stesso giorno, come raccomandate.**
Chiude il residuo del red-team del piano Fase 4 §9 («la rotazione del Kit non cambia la VK»), decisione dell'utente del 13/11/2026.

Verificati dal coordinatore sul codice (HEAD `b21604e`): `rotate` riservato e rifiutato in `vault.service.ts:318,336`; il server accetta solo l'epoch corrente (`vault.service.ts:79`, 422 `stale`). Da verificare nei test: `@updatedAt` di `Note` aggiornato dall'`updateMany` di `/migrate` (`vault.service.ts:529`), rate limit e durata di `/items` e `/migrate` su vault grandi.

**Idea:** ogni nuovo Kit porta una VK nuova. Il keyring sale a `epoch+1` con un solo CAS. Il client ricifra subito tutte le note; la VK vecchia resta solo avvolta dalla nuova (`prevVkWrap`). Il lavoro sulle note riusa `/migrate` + `/items` + `/finalize`.

## 1. Modello di minaccia

Attaccante con la VK vecchia (Kit superstite + `S_root` + `escrowBlob` di un rilascio annullato o scaduto).

**La rotazione chiude:**
- il ciphertext delle note sul server, in DB e via sync: tutte le note, credenziali comprese (stesso envelope), si ricifrano con VK_new;
- le versioni `nv3.<e-1>` in `NoteVersion`: le cancella `finalize`. Dal 27/10 non nascono più snapshot di envelope (`note.service.ts:414`), ma possono esistere righe precedenti, e la rotazione stessa crea uno snapshot di rollback per nota (`vault.service.ts:528`);
- tutte le scritture future: il server accetta solo l'epoch corrente (`vault.service.ts:79`);
- il controllo del keyring: con VK_old si sbusta la `vkSigKey` vecchia e si firma `PUT /keyring` o `complete`; dopo la rotazione `vkSigPub` è nuova e quella firma vale 403;
- l'escrow: `S_root'` e `S_user'` nuovi. Kit vecchio + `escrowBlob` vecchio danno solo VK_old.

**Non chiude:**
- il ciphertext già copiato (dump, backup ZIP/pg_dump, WAL precedenti alla rotazione): si chiude solo con il runbook di purge dei backup (P5);
- le copie Dexie su dispositivi che non sincronizzano più (telefono perso);
- la finestra tra la fuga e la rotazione;
- il bundle manomesso (§9.1 del design).

**Non dipendono dalla VK:** nomi dei Tag vault (in chiaro); allegati vault legacy (in chiaro, i nuovi bloccati in `attachments.ts:41-42`); blocchi cifrati dell'editor (CryptoJS con PIN proprio).

`prevVkWrap` dà VK_old a chi ha VK_new: non è una perdita, VK_new apre già gli stessi plaintext.

## 2. Opzioni

| Opzione | Costo | Rischio di perdita dati | Cosa lascia aperto |
|---|---|---|---|
| **A. Eager + VK vecchia avvolta dalla nuova (`prevVkWrap`, uno slot)** (raccomandata) | Medio: ricifratura di tutto il vault, ripresa automatica | Nessuno: le note sono sempre in `e` o `e+1` ed entrambe si aprono; al massimo una «copia in conflitto» | Solo il ciphertext copiato prima |
| B. Eager + VK vecchia distrutta a fine giro | Come A | Alto: edit offline in epoch vecchia bloccati (LEAVE `epoch`) per sempre | Nessun guadagno: l'attaccante ha già VK_old |
| C. Lazy (ricifra alla prossima scrittura) | Basso | Basso | Residuo aperto per ogni nota mai toccata. Scartata |
| D. Prima il contenuto, poi il keyring | Medio | Crash a metà = vault perso (VK_new solo in memoria) | Scartata |

**Semplificazione: «nuovo Kit = nuova VK».** Le tre vie esistenti (rigenerazione da Impostazioni, foglio obbligatorio F2, `complete` del recupero) fanno tutte una rotazione. Nessuna azione manuale separata.

## 3. Design

### Dati
- Una colonna nuova: `VaultKeyring.prevVkWrap Bytes?` = `AES-GCM(VK_new, VK_old)`, 60 byte, AAD `notiq/vault/v3/vkprev|userId|epochNew|epochOld`. Si sostituisce alla rotazione successiva; il reset P3 la deve azzerare.
- Nessuna colonna di stato. `staleCount` = note vault il cui content inizia con `nv3.` ma non con `nv3.<epoch>.`.
- Nessuna versione Dexie: bastano `vaultBaseHash` e `vaultSentHashes`.

### Protocollo
`PUT /keyring` con `{rev, wrap:{…, serverShare}, escrow, rotate:{vkSigPub(91), wrappedVkSigKey([80,220]), prevVkWrap(60)}}`, schema strict.
- `vkProof` firmato con la `sigKey` vecchia sull'epoch vecchia.
- 409 `rotationPending` se `staleCount > 0`; 409 `recoveryInProgress` come oggi.
- Pepper, `assertP256`, poi `updateMany where {epoch, rev}`: nello stesso CAS `epoch+1`, `rev+1`, wrap, `serverShareEnc` sigillato con la nuova epoch, escrow, `vkSigPub`, `wrappedVkSigKey`, `prevVkWrap`. Risposta `{rev, epoch}`.
- Il recupero (`vaultRecovery.service.ts:446-450`) accetta lo stesso `rotate` con le stesse regole. Nel payload di `complete` il `rotate` è **obbligatorio**, non opzionale. Il P4 non è in prod: non c'è compatibilità da tenere.

### Client che ruota (`rotateVault`, sostituisce `regenerateKit` in `vaultSession.ts:473-526`)
1. `flushPending` della coda (`vaultMigration.ts:151`). Con `staleCount > 0` prima finisce la rotazione pendente.
2. PIN; seconda Argon2 con salt nuovo e `DEFAULT_KDF` (come `changePin`); nuovi `serverShare`, VK_new, `sigKey`, `S_root'`, `S_user'`.
3. Round-trip completo in memoria: wrap del PIN, escrow, `prevVkWrap`, firma verificata con la SPKI nuova.
4. Marker `kit` `{epoch: kr.epoch, rev: kr.rev, origin:'regenerate'}` prima della PUT (`checkPending`, `vaultSession.ts:565`, invariato).
5. Su 200 (o 409 con il nostro `escrowHash`): `unlock(keys{…, prev}, epoch+1)`; cache dal server; `saveDeviceShare(newShare, epoch+1, wrappedVkSigKey nuovo)`; Kit mostrato («commit, poi Kit» invariato).
6. Dopo la cerimonia `finishRotation`, poi `vaultReconcile()`.

### `finishRotation` (= `migrateLegacy`, `vaultMigration.ts:248`, generalizzato)
- listing con `!isCurrentEnvelope` invece di `!startsWith('nv3.')` (`:177`);
- `classify` di un envelope decifra col codec (chiave `prev`);
- `/migrate` (CAS su `baseHash`, snapshot di rollback, `vault.service.ts:523-534`), verifica dai byte del server, `/finalize`;
- il controllo `keys !== ctx.keys` (`:261`) diventa un'opzione `live`, per il recupero.

### Note stale non decifrabili (D6, D7, D10)
Una nota stale che nessuna chiave apre bloccherebbe per sempre la rotazione e il `complete`. Si risolve con il **re-incapsulamento**, sul modello di ciò che `migrateLegacy` fa già con ciò che non riesce a decifrare.
- La nota illeggibile diventa un envelope valido all'epoch corrente.
  - NOTE: documento TipTap con un paragrafo «contenuto non leggibile», seguito dal testo dell'envelope vecchio copiato tale e quale.
  - CREDENTIAL: credenziale vuota con l'envelope vecchio nel campo `notes`.
- Nessuno schema e nessun endpoint nuovo: passa da `/migrate` e `/finalize`.
- Il ciphertext non si perde. Resta recuperabile, in caso di bug del client, fino alla rotazione successiva.
- L'attaccante con la VK vecchia non guadagna nulla: quella nota non si apriva con la VK vecchia nemmeno prima.
- **D6:** il re-incapsulamento parte solo dopo conferma esplicita in `ConfirmDialog`, che mostra il numero di note coinvolte. Protegge da un bug di derivazione della chiave scambiato per spazzatura.
- **D7:** il `complete` del recupero resta bloccato dalle note stale (409 `rotationPending`). La cerimonia le risolve prima, con lo stesso dialog.
  - Eccezione: un envelope vecchio oltre ~1,5 MiB non entra nel re-incapsulamento. L'utente deve cancellare la nota a mano.
- **D10:** indurimento backend. `createNote` e `updateNote` rispondono 422 se una nota vault ha contenuto che inizia con `nv3.` e l'utente non ha un keyring. Chiude gli envelope piantati prima del setup.

### Server: versioni
- `itemSelect._count.versions` (`vault.service.ts:454`) conta le versioni NOT `startsWith 'nv3.<epoch>.'`; `finalize` (`:570`) cancella le stesse. Il punto finale evita `nv3.1.` / `nv3.10.`.
- Così anche il finalize del reconcile (`vaultReconcile.ts:780-840`) pulisce le versioni dell'epoch vecchia.

**Versioni (`NoteVersion`) fuori epoch.** Contarle in `staleCount` bloccherebbe a torto: le versioni in chiaro di note legacy `locked`/`tooLarge`, o di note che non passano la validazione strutturale, restano per sempre. Quindi il punto sopra vale per `finalize`, non per la guardia. Regole:
- **D8:** le versioni non si contano nella guardia. Nella STESSA transazione del CAS di rotazione si cancellano le versioni envelope di epoch diversa da E, dove E è l'epoch del keyring PRIMA della rotazione:
  `noteVersion.deleteMany({ where: { note: { userId }, content: { startsWith: 'nv3.' }, NOT: { content: { startsWith: \`nv3.${E}.\` } } } })`
  - Dopo il CAS la VK di E-1 non è più raggiungibile (`prevVkWrap` contiene solo VK_E). Quelle versioni sono già illeggibili: perdita aggiuntiva zero.
  - Il filtro `note: { userId }` copre anche le note uscite dal vault.
  - Punti di intervento: `updateKeyring` (CAS e delete dentro `prisma.$transaction`) e la transazione esistente di `completeRecovery`.
- **D9:** `listNoteVersions` (`noteVersion.service.ts`) per le note `isVault` restituisce solo le versioni `nv3.<epoch corrente>.`. Nessuna UI vault la usa oggi (`VersionHistoryModal` è solo di `NoteEditor`).
- Lo snapshot rimasto dopo un crash lo pulisce già il passo 4 del reconcile (`vaultReconcile.ts` circa 780-781 e 820-840). Finalizza a ogni apertura del vault (`VaultPage.tsx` circa 264-267). Nessun codice frontend nuovo per P2.

### Ripresa dopo un'interruzione

| Momento | Cosa succede |
|---|---|
| Prima della PUT | Nulla scritto; il marker muore quando il keyring lo supera |
| Risposta persa | Banner `kitUnconfirmed`; PIN invariato; la rigenerazione rifà una rotazione dopo aver finito quella pendente |
| Giro a metà | A ogni sblocco online con `staleCount > 0` e `keys.prev` parte `finishRotation`, su qualunque dispositivo 1.15 |
| Durante il giro | Il codec legge `e` ed `e+1`; un edit ricifra con `e+1` e passa il CAS sul vecchio hash |
| Nota stale non decifrabile | `finishRotation` la restituisce in `unreadable[]`. Dopo la conferma in `ConfirmDialog` (D6), `rewrapUnreadable` la re-incapsula all'epoch corrente e il giro finisce |
| Snapshot rimasto dopo un crash | Lo pulisce il passo 4 del reconcile al prossimo sblocco (D8, D9) |

Invariante: mai ruotare con `staleCount > 0`, quindi nessuna nota resta più di un'epoch indietro.

### Multi-dispositivo e offline
- **Altra scheda:** `vaultStore.ts:192` blocca già al cambio di epoch; il flusher scrive con l'epoch vecchia, poi recupera il reconcile.
- **Altro dispositivo sbloccato:** `syncKeyringCache` (`vaultSession.ts:104`) deve chiamare `lockVault()` se l'epoch del server supera quella in memoria (oggi no). PIN invariato.
- **Edit offline in epoch vecchia:** push → 422 `stale`, item `failed`. Reconcile con `prev`: T5 payload uguale → ADOPT, altrimenti `withCopy` ADOPT; T9 (CREATE con epoch vecchia) → REENCRYPT_CREATE; T15 → `withCopy` (già coperto da `itemPayload`). `syncService.ts` invariato (ramo `1497-1498`).
- **Sblocco offline:** l'AAD di `shareEnc` contiene l'epoch → `offlineUnavailable` fino a uno sblocco online. Voluto: invalida la cache di un telefono rubato.
- **Bundle 1.14:** push in `stale` → LEAVE, senza cancellazioni; errori di decifratura nella UI fino all'aggiornamento.
- **Web Lock:** `finishRotation` sotto `notiq-vault-reconcile`; scrive solo sul server, niente lock per nota; gli altri dispositivi li protegge il CAS.

### Recupero
- Con `staleCount > 0` la cerimonia sbusta prima `prev` con la VK dell'escrow e finisce il giro (`ctx` esplicito, `live`).
- Le note stale non decifrabili si risolvono prima di `complete`, con lo stesso `ConfirmDialog` (D7).
- Poi `complete` con `rotate`, epoch+1 nei round-trip (`vaultRecovery.ts:391-406`).
- `afterCommit` deve passare la `wrappedVkSigKey` nuova (oggi `kr.wrappedVkSigKey`, `vaultRecovery.ts:317,424`).

## 4. File toccati

**TIER 1 (diff all'utente prima dell'applicazione):**
- `backend/prisma/schema.prisma`: `+ prevVkWrap Bytes?` in `VaultKeyring`; migration a mano `ALTER TABLE "VaultKeyring" ADD COLUMN "prevVkWrap" BYTEA;`, applicata con `migrate deploy`.
- `frontend/src/utils/vaultCrypto.ts`: `+ wrapPrevVk`, `unwrapPrevVk`. Solo aggiunte: envelope, AAD esistenti, HKDF e `kdfCanon` invariati.
- `frontend/src/store/vaultStore.ts`: `VaultKeys.prev?: {epoch, vkHkdf, vkAes}`, non persistito; `partialize` e storage key invariati.
- `frontend/src/lib/vaultReconcile.ts`: `Snapshot.prevEpoch`; righe e item dell'epoch precedente leggibili (`:326`, `:359`); regole T5 (`:285`) e T9 (`:243`); `staleLeft` separato da `legacyLeft` (`:780`).
- Invariati: `syncService.ts`, `db.ts`.

**Altri:** backend `vault.service.ts`, `vaultRecovery.service.ts`, `routes/vault.ts` (`assertP256` per `rotate.vkSigPub`); frontend `vaultCodec.ts` (chiave scelta dall'epoch dell'envelope; cache `kNotes` con chiave `epoch|noteId`), `vaultSession.ts`, `vaultRecovery.ts`, `vaultApi.ts`; UI `features/vault/vaultMigration.ts`, `VaultPage.tsx`, `VaultSettingsSheet.tsx`, `RecoveryKitSheet.tsx`, `VaultRecovery.tsx`; `en.json`, `it.json`; docs (spec del reconcile, design §2.1/§5.3, piano P4).

## 5. Task in TDD (test prima, a ogni giro)

- **T0 Spec.** `2026-10-22-vault-t15-reconcile-spec.md` (T5, T9, T15 con `prevEpoch`; `staleLeft`) e design §2.1 (oggi «l'epoch cambia solo con il reset»). La spec cambia prima del codice.
- **T1 Schema e migration** (TIER 1). `prisma migrate deploy` e `prisma generate` passano sul DB dev; colonna nullable.
- **T2 Backend, lettura e pulizia** (`vault.items.test.ts`, `vault.keyring.test.ts`). GET `/keyring` restituisce `prevVkWrap` (b64) e `staleCount`; `finalize` su una nota SE cancella le versioni in chiaro e `nv3.<e-1>.` e tiene `nv3.<e>.`; caso `nv3.1.` contro `nv3.10.` testato.
- **T3 Backend, PUT rotate** (`vault.keyring.test.ts`, `vault.route.test.ts`). Successo → epoch+1, campi nuovi, `unlock` apre `serverShare` con la nuova epoch; seconda PUT firmata con la chiave vecchia → 403; replay → 409; `staleCount > 0` → 409 `rotationPending`; rilascio aperto → 409; chiavi sconosciute → 400; escrow senza rotate → 400 (D2); PUT di una nota con l'epoch vecchia → 422 `stale`; `/migrate` SX → `ok` con snapshot. Aggiunte:
  - D8: la rotazione cancella nella stessa transazione del CAS le versioni envelope di epoch diversa da E (E = epoch prima della rotazione), anche di note uscite dal vault; le versioni in chiaro restano; `nv3.1.` contro `nv3.10.` testato.
  - D8: le versioni non entrano in `staleCount`.
  - D9: `listNoteVersions` di una nota `isVault` restituisce solo `nv3.<epoch corrente>.`.
  - D10: `createNote` e `updateNote` rispondono 422 se la nota vault ha content `nv3.` e l'utente non ha un keyring.
- **T4 Backend, `complete` con rotate** (`vaultRecovery.service.test.ts`). Idempotenza invariata, regole di T3, il rilascio successivo apre `sealedRootShare` con l'epoch nuova. Aggiunte: `rotate` obbligatorio nel payload (senza → 400); stessa cancellazione delle versioni di D8 nella transazione esistente di `completeRecovery`.
- **T5 Crypto** (`vaultCrypto.test.ts`). Round-trip; `userId` o epoch sbagliati falliscono; KAT con IV fisso (contratto congelato); lunghezza 60; vettori esistenti invariati.
- **T6 Codec e store** (`vaultCodec.test.ts`, `vaultStoreV3.test.ts`). Decifra `e-1` con `prev` ed `e` con la corrente; `e-2` → `stale`; `encrypt` sempre all'epoch corrente; `prev` mai in localStorage.
- **T7 Sessione** (`vaultSession.test.ts`). `rotateVault`: marker prima della PUT; su 200 Kit restituito, store a epoch+1 con `prev`, share salvato con epoch+1; 409 col nostro hash → successo; 409 diverso → `kitNotUpdated` e marker cancellato; `staleCount > 0` → `rotationPending`; `syncKeyringCache` con epoch più alta blocca il vault; `openKeyring` sbusta `prev`.
- **T8 `finishRotation`** (`vaultMigration.test.ts`). SX → SE verificati e finalizzati; abort a metà + secondo giro → `staleCount` 0; conflitti con 3 giri; nessun plaintext in Dexie o nella coda; `updatedAt` della nota aggiornato (propagazione alla pull). Aggiunte (D6):
  - `finishRotation` restituisce `unreadable[]`. La decifratura usa la chiave scelta dall'epoch dell'envelope.
  - In `unreadable[]` finiscono anche gli envelope malformati, quelli di epoch futura e, senza `prevVkWrap`, tutti gli stale.
  - Nuova funzione `rewrapUnreadable(ids, ctx)`: NOTE e CREDENTIAL come in §3, passando da `/migrate` e `/finalize`.
- **T9 Reconcile** (TIER 1, `vaultReconcile.test.ts`). Una riga per T5, T9, T15 con `prev` (uguale → ADOPT, diverso → copia cifrata nella nuova epoch); `e-2` → LEAVE `epoch`; `staleLeft` e `legacyLeft` separati. Aggiunta (Addendum 6 della spec): una riga Dexie illeggibile, con il server già re-incapsulato, finisce in HYDRATE senza copia e senza DROP.
- **T10 UI.** Impostazioni e F2 chiamano `rotateVault`; flush; avanzamento; ripresa automatica in `VaultPage`; il banner legacy non compare per gli SX; i18n en/it; `dark:`. Test dei componenti e `npx tsc -p tsconfig.app.json --noEmit`. Aggiunta (D6): `ConfirmDialog` di conferma del re-incapsulamento, con il numero di note coinvolte (i18n en/it, varianti `dark:`).
- **T11 Recupero** (`vaultRecovery.test.ts`). Verdetti invariati; keyring a epoch+1; Kit vecchio sul nuovo escrow → errore; giro pendente finito prima di `complete`. Aggiunta (D7): lo stesso `ConfirmDialog` nella cerimonia di recupero; envelope vecchio oltre ~1,5 MiB: l'utente cancella la nota a mano.
- **T12 E2E.** `vault-kit.spec.ts`: rotazione, note e credenziali leggibili, `/vault/items` senza `nv3.<e-1>.`, Kit vecchio che non apre il nuovo escrow; interruzione (abort di `/vault/migrate` dopo il primo batch, reload, sblocco) → ripresa fino a 0. `vault-multidevice.spec.ts`: B edit offline, A ruota, B online e sblocca → testo conservato (adottato o in copia); la seconda scheda di A si blocca. `vault-recovery.spec.ts`: `complete` → epoch+1. SQL dev: 0 note e 0 versioni vault `LIKE 'nv3.%' AND NOT LIKE 'nv3.<e>.%'`. Aggiunta (D6): spazzatura `nv3.<E>.` piantata via REST (solo JWT) → rotazione, conferma nel dialog, seconda rotazione con 200.
- **T13 Docs.** `CLAUDE.md` (vault flow), piano Fase 4 §9 (residuo chiuso), runbook 1.15.0 (solo la migration della colonna, nessun job in prod).

## 6. Rischi e residui

- Due rotazioni con un dispositivo offline con edit non sincronizzati: quegli edit restano LEAVE `epoch` (un solo slot `prev`).
- Vault grandi: rate limit e durata di `/items` e `/migrate` da misurare, anche su WebKit/iOS (due Argon2 + ricifratura).
- `@updatedAt` con `updateMany` di `/migrate` non verificato; se non si aggiorna rimedia la HYDRATE T1 del reconcile (coperto in T8).
- Copie in conflitto su dispositivi con edit non spinti: nessuna perdita, ma duplicati.
- I backup precedenti alla rotazione restano leggibili con VK_old.
- Corsa teorica di una PUT di nota a cavallo di due rotazioni: in `note.service.ts` (circa righe 230 e 286) la guardia sull'epoch si legge fuori dal lock. Servono due rotazioni complete tra lettura e scrittura. Accettato.

## 7. Decisioni per l'utente

- **D1.** Ogni rigenerazione del Kit ruota anche la VK; nessuna azione manuale separata. Raccomandato: sì.
- **D2.** Il server 1.15 rifiuta una PUT con escrow senza `rotate`: la rigenerazione da un bundle 1.14 fallisce fino all'aggiornamento. Raccomandato: sì.
- **D3.** `prevVkWrap` resta fino alla rotazione successiva (non si cancella a fine giro). Raccomandato: tenerla.
- **D4.** `prevVkWrap` in cache per leggere offline, durante il giro, le note non ancora ricifrate. Raccomandato: no.
- **D5.** Il PIN resta lo stesso nella rotazione (cambio PIN separato). Raccomandato: sì.

Esito D1-D5: approvate il 23/11/2026.

- **D6.** Una nota stale non decifrabile si re-incapsula (§3) solo dopo conferma esplicita in `ConfirmDialog`, con il numero di note coinvolte. Esito: approvata il 23/11/2026.
- **D7.** Il `complete` del recupero resta bloccato dalle note stale (409 `rotationPending`); la cerimonia le risolve prima con lo stesso dialog. Un envelope oltre ~1,5 MiB si cancella a mano. Esito: approvata il 23/11/2026.
- **D8.** Le versioni `NoteVersion` non contano nella guardia. Il CAS di rotazione e `completeRecovery` cancellano nella stessa transazione le versioni envelope di epoch diversa da E. Esito: approvata il 23/11/2026.
- **D9.** `listNoteVersions` restituisce per le note `isVault` solo le versioni `nv3.<epoch corrente>.`. Esito: approvata il 23/11/2026.
- **D10.** `createNote` e `updateNote` rispondono 422 se una nota vault ha content `nv3.` e l'utente non ha un keyring. Esito: approvata il 23/11/2026.
