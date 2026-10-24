# Vault P2: report del rilancio delle verifiche dopo le correzioni (24/10/2026)

Branch `feat/vault-p2`, HEAD `a6cf29e`. Rilancio delle voci toccate dalle correzioni `980b24a`, `5d35c52`, `aec4bfd`, `7dbee80` e `a6cf29e`, più le voci vicine. I lotti sono LMIX, L05, L06, L07, L09 e L19, con la suite E2E completa. Riferimento: `docs/superpowers/plans/2026-10-24-vault-p2-autotest-report.md` (run precedente).


> **Aggiornamento del 24/10, scritto dopo il report.**
>
> - **F.21 è corretto** in `d473dd6`, con l'Addendum 3 della spec del reconcile. Il rilancio Playwright della voce F.21 passa:
>   - passo 4: 1 PUT 200 e coda vuota;
>   - passo 8 con `vault:notReady`: 1 PUT al primo "Controlla ora", nessuna ai successivi.
> - **I locator di `collaboration.spec.ts`** (righe 163, 169, 195, 201, 239 e 318) sono corretti nello stesso commit. Il file passa 5/5.
> - **Suite E2E dopo la correzione.**
>   - Primo giro: 54/56. Falliscono `vault-conflict.spec.ts:74` e `:158`, che passano al rilancio. In entrambi l'originale, aperto su A, mostra il valore di A mentre il server ha quello di B.
>   - Dopo: 10/10 ripetizioni isolate e un giro completo 58/58.
>   - La patch non tocca quel percorso. Il fallimento intermittente è comunque in indagine come possibile difetto preesistente, non come test instabile.
> - **Checklist:** applicate le modifiche della sezione 6 ("Modifiche ancora da fare"). Fa eccezione B.16 variante F, che resta un limite noto.

---

## 1. Sintesi

**77 voci rilanciate** in 6 lotti, tutti con stato OK.

| Esito | Voci | Quali |
|---|---|---|
| PASS | 69 | |
| OSSERVATO | 4 | F.6, F.15, F.17, H.13 |
| SIMULATO | 3 | H.4, H.15, I.7 |
| FAIL | 1 | F.21 |

Per lotto:

| Lotto | Voci | PASS | OSSERVATO | SIMULATO | FAIL |
|---|---|---|---|---|---|
| LMIX (C, D, E, J.1-J.4) | 8 | 8 | 0 | 0 | 0 |
| L05 (F) | 23 | 19 | 3 | 0 | 1 |
| L06 (H, J.5-J.6) | 16 | 13 | 1 | 2 | 0 |
| L07 (I, A.8) | 12 | 11 | 0 | 1 | 0 |
| L09 (B, M.4) | 15 | 15 | 0 | 0 | 0 |
| L19 (B.12, B.13) | 3 | 3 | 0 | 0 | 0 |

**Confronto con il run precedente, sulle stesse 77 voci.** Prima: 58 PASS (alcuni con un MINOR annotato), 5 OSSERVATO, 3 SIMULATO e 11 FAIL. Ora: 69 PASS, 4 OSSERVATO, 3 SIMULATO e 1 FAIL.

- 14 voci sono passate a PASS: 10 erano FAIL e 4 erano OSSERVATO (sezione 2).
- F.6 passa da FAIL a OSSERVATO. È un MINOR noto che resta non corretto per decisione utente.
- 3 voci erano PASS e ora non lo sono:
  - **F.21 da PASS a FAIL.** È un difetto reale che la PUT spuria all'apertura (2.1) mascherava. La 2.1 è ora corretta (sezione 3).
  - **F.17 da PASS a OSSERVATO.** Causa di ambiente: la finestra perde il focus. Non è un difetto dell'app.
  - **H.13 da PASS a OSSERVATO.** Il comportamento non è cambiato. Ho cambiato solo la classificazione, perché il MINOR di UX resta aperto.

**Voci BLOCCANTE per il rilascio**

- **F.21 (MAJOR, DIFETTO_REALE).** Dopo un passaggio RESET_PENDING e poi READY, le modifiche trattenute con `vault:notReady` non vengono più spinte al server finché l'utente non fa un'altra modifica. Nessun dato va perso: le modifiche restano in Dexie e in coda. Però, se l'utente non tocca più la nota, il server non le riceve mai. La causa è in `vaultReconcile.ts`, che è TIER 1: prima va cambiata la spec, poi il codice.
- Nessun altro bloccante. I 4 FAIL E2E sono un difetto del test (sezione 4). La suite va comunque riportata al verde prima del merge.

Non c'era una ripresa di voci dubbie dal run precedente (RIPRESA nulla), quindi nessuna voce di ripresa resta DIFETTO_DEL_TEST. I punti ancora non del tutto chiari sono elencati in fondo alla sezione 3.

---

## 2. Voci passate da FAIL/OSSERVATO a PASS

| Voce | Prima | Ora: evidenza principale | Correzione |
|---|---|---|---|
| D.1 | FAIL (MINOR) | Il codice del Kit sta in un `role=group` con nome "Recovery Kit code" (1 elemento, testo uguale al Kit). Invariati: formato, focus trap e dark. `out/retest/LMIX/D1-aria.txt` | D.1 |
| E.6 | FAIL (MINOR) | Lockout online, poi `setOffline` senza reload. Lo stesso elemento `<input>` torna abilitato, senza remount. PIN1 sblocca offline con 0 POST e il DB resta invariato. `E6-evidence.json` | E.6 |
| H.2 | FAIL | 5 varianti su 5. Copia e coda vuota arrivano 1-2 s dopo Indietro. Una sola copia, nessuna PUT 2xx sull'originale. `out/retest/L06/H2-evidence.json` | H.2 (Addendum 2) |
| H.7 | FAIL | Aprire senza digitare: 0 PUT. "Controlla ora" non crea copie spurie. Il giro sospeso su `notiq-vault-reconcile` completa al rilascio, senza lock orfani. | 2.1 |
| H.9 | FAIL | Aprire senza digitare: 0 PUT. Il flusso del 422 `plaintextRequired` dà una copia nel vault e l'originale fra le note normali. | 2.1 |
| I.9 | FAIL (MAJOR) | La riapertura mostra MK-B-EDIT dopo 20 ms, non più la versione stantia. Una sola nota e una sola PUT dopo il conflitto. Il secondo tentativo risponde 200. | 2.1 |
| B.16 | FAIL | Aprendo RAW e osservando per 10 s: `puts=[]` e md5 del server invariato. B legge "MK-RAW v2". | 2.1 |
| B.12 | FAIL (MAJOR) | 18 check su 18. La credenziale CV viene adottata (ADOPT) come envelope `nv3.0`, con titolo LB-CV e password MK-PW-ORIG. Nessun "Untitled", nessuna copia di N2 o CV. | B.12 |
| B.13 | FAIL (MAJOR) | 28 check su 28. Compaiono il banner "Items locked with a previous PIN: 1." e la schermata `legacyUnreadable`. Il wizard col PIN precedente crea "LB-CV (conflict copy)" con MK-PW-OLDBUNDLE. | B.13 |
| B.13 variante titolo | FAIL (MINOR) | La copia ha il titolo "LB-N2 (conflict copy)", nessuna copia ha il titolo vuoto. | B.13 |
| F.9 | OSSERVATO | Una nota vault fissata non compare in sidebar e non apre una WS `/ws`. | F.9 |
| F.13 | OSSERVATO | Varianti V1-V10: paste, drop, menu contestuale e nota preesistente con un'immagine remota. Le immagini sono tolte o nascoste con i tre toast previsti. Nessuna navigazione, nessuna POST attachments/ai/uploads, 0 richieste esterne. La controprova sulla nota normale è ok. | F.13 |
| F.23 | OSSERVATO | Doppio clic sui 4 punti di creazione: in tutti `serverDelta 1` e `localDelta 1`. | F.23 |
| J.6 | OSSERVATO | Dopo un contatto online la cache rev è uguale alla rev del server. Offline, PIN1 viene rifiutato e PIN2 accettato, con il contatore invariato. | J.6 |

**MINOR annotati sui PASS precedenti e ora chiusi:**

| Voce | Correzione | Esito ora |
|---|---|---|
| C.3 | C.3 | Avviso `vault.pinTruncated` presente |
| C.4 | C.4 | Troncamento con avviso, policy invariata |
| J.4 | J.4 | Esattamente 1 POST `/unlock` e 1 PUT `/keyring` (rev +1) in 6 giri. Prima: 2 unlock e 3 PUT. |
| I.2 | I.2 | 0 righe Notification dopo l'ingresso nel vault, prima erano 2 |
| B.1 | B.1 | La credenziale legacy bloccata mostra MK-TITLE-LOCK |
| B.2 | B.2 | `searchText` di noteA è `''` subito dopo "Fine" |
| A.8 | 2.1 | Nessun item failed spurio |
| F.4, F.8 | 2.1 | 0 PUT all'apertura su A e su B |

---

## 3. Difetti ancora aperti o nuovi

### 3.1 F.21: le modifiche trattenute per `vault:notReady` non ripartono dopo READY (NUOVO, MAJOR, BLOCCANTE)

- **Verdetto:** DIFETTO_REALE, MAJOR. Prima era PASS, ma solo perché un altro bug lo mascherava.
- **Causa:** `frontend/src/lib/vaultReconcile.ts:141-147`, funzione `reactivates`, regola T5. Un item failed con `lastError 'vault:notReady'` si riattiva solo se `data.content !== rowContent`. Dopo RESET_PENDING e poi READY la riga non è stata ricifrata, quindi l'item resta failed. Due punti fermano poi tutta la coda della nota:
  - `syncService.ts:1461-1464`: `retryFailedSyncItems` salta sempre i `vault:*`.
  - `syncService.ts:1000-1008`: `vaultHeld` trattiene gli item successivi della stessa nota.

  La spec `docs/superpowers/plans/2026-10-22-vault-t15-reconcile-spec.md`, Addendum 2 §5 (riga 216), prescrive LEAVE(unchanged) quando il fallimento si ripete uguale. Questo va bene per `stale`, ma non per `notReady`, che dipende da uno stato esterno (il keyring). Il reconcile gira solo con la cache READY sull'epoch corrente (`vaultReconcile.ts:714`). Quindi, quando il giro valuta un item `notReady`, il motivo del rifiuto è già sparito.
- **Perché emerge ora:** nel run precedente la PUT spuria all'apertura (2.1) ricifrava la riga e cambiava il content. Il commit `7dbee80` l'ha tolta.
- **Repro:**
  1. Utente con vault READY e una nota N aperta.
  2. In SQL, imposta `VaultKeyring.status='RESET_PENDING'`.
  3. Scrivi " NR1": la PUT risponde 422 `notReady` e l'item diventa failed.
  4. Scrivi " NR2": l'item resta trattenuto in coda.
  5. Blocca il vault.
  6. In SQL, rimetti `status='READY'`.
  7. Ricarica `/vault`, sblocca, apri N, torna indietro e attendi 60 s.

  Script: `frontend/manual-p2/lotto-R05d-search-seed.spec.ts`, test F.21.
- **Atteso (passo 4 della checklist):** l'item si riattiva, una PUT 200 porta " NR1 NR2" e la coda si svuota.
- **Osservato:**
  - Dopo oltre 60 s dalla chiusura dell'editor la coda è ancora `[UPDATE failed vault:notReady id 3, UPDATE pending id 4]`, con 0 PUT.
  - "Controlla ora" risponde "1 items were left unchanged".
  - La coda si sblocca solo dopo una modifica nuova (" NR3") seguita dalla chiusura dell'editor: allora parte 1 PUT 200 e la coda si svuota.
  - Gli item 3 e 4 hanno lo stesso `contentHead 'nv3.0.3Unf1PZ3'` della riga.
- **Impatto:** nessun dato perso, perché le modifiche restano in Dexie e in coda. Però viola la regola di F.21 "Non deve: item failed per sempre": se l'utente non modifica più la nota, NR1 e NR2 non arrivano mai al server.
- **Correzione proposta (prima la spec, poi il codice, perché `vaultReconcile.ts` è TIER 1):** in T5, per `vault:notReady`, riattivare l'item anche quando il content è uguale. Si può farlo perché il giro gira solo con il keyring READY. Il loop va limitato con un contatore o un memo per item e per sessione, come in T-d. Dopo la correzione va rilanciato solo il reconcile-reviewer, con la regola dei 2 round.
- **Evidenze:**
  - `D:/Develop/AI/Notiq/frontend/manual-p2/out/retest/L05/F21-evidence.json`: campi `step4`, `step4bStall.queue`, `checkNowAlerts`, `afterTypingNR3`, `afterCloseNR3`.
  - `frontend/manual-p2/out/artifacts/lotto-R05d-search-seed-F-2-0de54-e-e-vault-notReady-seminati/`: screenshot e trace.

### 3.2 MINOR noti e ancora aperti (non bloccanti)

Nessuno di questi è una regressione. Sono tutti già segnalati nelle voci della checklist.

| Voce | Difetto | Causa nota |
|---|---|---|
| F.6, F.7 | Una riga manomessa o illeggibile non si autoripara e "Controlla ora" non segnala nulla (T1 NONE). Nessuna PUT, INVARIANTE 0. | Decisione utente: non corretto |
| H.13 | La credenziale già aperta mostra pw-0 dopo un aggiornamento remoto. Con un edit di A si ottiene un 422 e una copia, senza perdite. L'unica POST `/vault/items` all'apertura è una lettura (`routes/vault.ts:130`, `vaultApi.ts:149`), quindi non contraddice la 2.1. | `VaultPage.tsx:340-348` |
| H.3 | Il toast `sync.failedToast` dice "Usa Riprova", ma per `vault:conflict` il pulsante non fa nulla. | Testo del toast |
| F.10 | Il selettore del promemoria mostra l'ora UTC (13:17 al posto delle 15:17 Europe/Rome). | |
| I.8 | Un testo scritto offline su una nota appena uscita dal vault viene scartato in silenzio (PUT 200 senza scrittura, da `contentGuard`). | |
| B.15 | Il riepilogo del wizard non segnala l'allegato (`summaryMentionsAttachment=false`). | |
| B.5 | Nel wizard il PIN errato resta nel campo e il tempo residuo del lockout non compare. | Nota UX |
| B.11 | Dopo un logout da un'altra scheda compare "Vault bloccato" e non `migrate.errors.locked`. È ammesso dall'atteso allargato. | Nota UX |
| A.3, H.13, J.7, M.3, M.5, M.6 | Restano aperti come annotato in checklist. Non sono stati rilanciati, tranne H.13. | |

### 3.3 Punti non chiari o da sistemare (non difetti confermati)

- **B.9 K, un fallimento isolato.** Nel primo run del lotto è fallito l'assert "il Kit non si ri-mostra mai" (visto 1 volta). In 3 riesecuzioni è passato 3 volte su 3. Sospetto un artefatto del watcher dello script, che si azzera dopo 700 ms. Non è riprodotto e non è confermato come difetto. Se ricompare, va indagato.
- **B.16 variante F (finalize interrotta).** `plain_v` di RAW resta 2 dopo lo sblocco: il reconcile non finalizza le RAW. Il vecchio script lo classificava "limite noto", e non è nell'elenco delle correzioni. Serve una decisione: limite accettato o difetto da tracciare.
- **F.13, markdown digitato.** Non produce un'immagine e non mostra alcun toast, perché nel vault la regola di input non esiste. L'atteso della checklist dice "toast remoteImagesRemoved": va corretto l'atteso, non il codice.
- **F.21, passo 6 della checklist.** Dice "resta failed" e "nessuna PUT". Va riscritto insieme alla correzione di 3.1.
- **J.6, titolo.** "Il vecchio PIN resta valido offline..." descrive il comportamento di prima e contraddice l'atteso attuale, che ora passa. Il titolo va cambiato.
- **C.3, campo di sblocco.** È stato verificato in LMIX: il campo non tronca (valore `k7Rq2xZ`, nessun `maxLength`) e risponde "PIN errato" senza lockout. L'atteso dello sblocco lasciato invariato in checklist è quindi corretto.
- **Assert riformulati in L09 (B.2 e B.3b).** In B.2 le righe nv3 hanno `searchText` assente (null) e mai plaintext, mentre noteA vale esattamente `''`. In B.3b la credenziale bloccata ora mostra `legacyUnreadable` e non più `decryptFailed`. Sono riformulazioni coerenti con le correzioni B.1, B.12 e B.13, senza allentare gli assert.

---

## 4. E2E

**Esito: FAIL.** 52 passati, 4 falliti, 0 flaky, 0 saltati (56 in totale, 7,3 minuti, `workers=1`).

| Riga dell'assert | Test (riga) |
|---|---|
| `collaboration.spec.ts:163` | "Shared Collab Note" (141) |
| `collaboration.spec.ts:195` | "Accept Test Note" (176) |
| `collaboration.spec.ts:239` | "Permission Test Note" (211) |
| `collaboration.spec.ts:318` | "Restore Live Note" (288) |

In tutti e quattro l'errore è lo stesso: violazione di strict mode, perché `getByText(title)` trova 2 elementi.

**Verdetto: DIFETTO_DEL_TEST (MINOR), non una regressione del prodotto.**

- **Causa:** `NotificationPanel` è sempre montato in `AppLayout.tsx:103`.
  - Da chiuso viene solo traslato fuori schermo (`NotificationPanel.tsx:40-41`, `translate-x-full`) e resta nel DOM.
  - `NotificationItem.tsx:232-235` rende `notifications.shareNote` (`en.json:918`) in un `<p>` che contiene il titolo della nota.
  - `getByText` fa match per sottostringa e conta anche gli elementi fuori schermo. Quando la notifica arriva prima dell'assert, trova l'`h3` della card (`SharedWithMePage.tsx:493`) e il `<p>` della notifica.
- **Perché non è una regressione:** fra `56ba46a` (E2E verdi) e HEAD nessun commit tocca sharing, notifications, `collaboration.spec.ts`, `sharing.service` o `notification.service`. L'unico cambio nel layout è `useKeyringRefresh` in `AppLayout.tsx` (+3 righe), che non rende DOM. Il fallimento dipende da quando arriva la notifica.
- **Correzione del test:** in `frontend/e2e/collaboration.spec.ts`, sostituire `pageB.getByText('<titolo>')` con `pageB.getByRole('heading', { name: '<titolo>', exact: true })`. Righe interessate:
  - 163 ("Shared Collab Note")
  - 195 e 201 ("Accept Test Note")
  - 239 ("Permission Test Note")
  - 318 ("Restore Live Note")

  La riga 201 è un secondo assert dello stesso test di 195.
- **Non verificato:** i 4 test non sono stati rieseguiti. La causa è dedotta dal codice e il markup non è stato confrontato con la git history. Dopo la correzione del test va rilanciata tutta la suite.
- **Test instabili noti:** `collaboration.spec.ts:249` e `auth.spec.ts:41` sono passati in questo run. Non sono stati archiviati.

---

## 5. Voci che restano all'utente

| Voce | Cosa | Motivo |
|---|---|---|
| C.4 (passi 1, 3, 4, 6) | Prompt del gestore password di Chrome: "Usa password suggerita", "Salvare/Aggiornare la password", autofill al login e nel campo di sblocco. Tastiera del telefono: prima lettera non maiuscola nei campi PIN. | Il Chromium di Playwright non ha il gestore password né una tastiera mobile reale. Attributi e troncamento sono già verificati. |
| D.1 (passo 9, facoltativo) | Leggere il codice del Kit con uno screen reader. | Non automatizzabile. Il `role=group` con nome è già verificato. |
| F.10 | Selettore del promemoria (`showPicker`) su un telefono vero. | `showPicker` nativo e touch non si automatizzano in headless. `adb devices` è vuoto. |
| F.16 | Compilare una credenziale e annotare se Chrome propone "Salvare la password?". | Il prompt del browser non è osservabile con Playwright/CDP. |
| F.17 | Copiare la password, restare 35 s sulla scheda con il focus e controllare che gli appunti si svuotino. Poi controllare la cronologia Win+V. | Nel run il focus della finestra headed non si è mantenuto (`NotAllowedError 'Document is not focused'`). Win+V non ha API. |
| F.13 (facoltativo) | Trascinare un PNG da Esplora file sull'editor di una nota sicura e fuori dall'editor su `/vault`. La scheda non deve navigare al file. | Il drag dal sistema operativo non si automatizza. È coperto da drop sintetici e da un drop CDP con un file reale. |
| F.15 (facoltativo) | Dettatura reale col microfono. | Serve un microfono fisico. La dettatura resta abilitata per decisione utente. |
| H.4 | Timeout reali di rete o del proxy con risposta persa. | In dev la perdita è simulata con una route `fwd-drop`. |
| H.12 | Comportamento di ARR/IIS con i 429 di `/vault/items`. | È un limite di prod, non riproducibile in dev. |
| H.15 | Passaggio reale dal bundle 1.13.3 a P2, con PWA `autoUpdate` e la vecchia `api-cache`. | Si vede solo al deploy. Da aggiungere al runbook: dopo uno sblocco online con il bundle vecchio, lo switch offline torna OFF e lo share viene cancellato. |
| I.7 | Perdita di rete reale durante l'ingresso nel vault. | È simulata con una route. L'esito SIMULATO non vale come PASS pieno. |
| M.4 | Tempi PBKDF2 reali e schermo spento su un Android lento. | Qui c'è solo il throttling CPU di Chromium con emulazione Pixel 7. `adb devices` è vuoto. |

---

## 6. Checklist aggiornata

File: `docs/superpowers/plans/2026-10-22-vault-p2-manual-checklist.md`, modificato solo in locale, senza `git add` né commit. È cambiato l'atteso di 57 voci. ID, passi e struttura sono invariati.

> Attenzione: dopo le modifiche il file non è stato riletto per intero. Sono stati controllati solo `git diff --stat` e i punti H.2, H.7 e H.8. Prima del commit va fatta una rilettura completa.

**Righe di passo cambiate (eccezioni alla regola "solo l'atteso"):**

- B.3, passo 3: testo del banner.
- C.4, passo 1.
- H.2, passo 6: tempo di attesa.
- H.6, passo 4: durata dell'osservazione.
- Titolo di B.4: il 409 si vede solo in una gara al millisecondo.

**Correzioni dalla §6 del report precedente:**

| Voce | Correzione |
|---|---|
| A.2 | Nota su StrictMode in dev |
| B.3 | Il banner dice "2 elementi da aggiornare" |
| B.4 | B fa una GET di pre-controllo; il 409 compare solo in una gara al millisecondo |
| B.11 | "Vault bloccato" aggiunto fra gli esiti ammessi |
| C.4 | Password suggerita o autofill troncata a 6 con avviso; rifiutata solo se i primi 6 caratteri violano la policy |
| E.4, E.5 | Con `ceil` un tentativo entro 1 s dal blocco mostra "15:00" e "60:00" |
| E.7 | Il PIN viene richiesto solo dopo una visita a `/vault`; passo 4 da fare sul bundle prod; il blocco all'uscita è marcato come decisione utente |
| F.5 | Tolto il percorso con `hydrateVaultNote` che rimuove la riga |
| F.6, F.7 | Nessuna auto-riparazione; "Controlla ora" non segnala nulla; marcati come MINOR noti non corretti |
| F.20 | Passo 4 con un content diverso da quello del server |
| F.21 | Il passo 5 è T6 REENCRYPT_TITLE; lo skip senza PUT si osserva sul seed `withTitle=false` |
| H.6 | Diretto e proxy distinti; osservazione di 10 minuti o più |
| H.12 | Il limite riguarda la concorrenza, non il numero di POST |
| I.8 | La versione nv3 resta nel DB, nascosta e non ripristinabile |
| K.3 | Per un item UPDATE il title è assente o vuoto |
| B.6, B.8, B.9, M.4, D.6, E.12 | Aggiunte le note per chi ripete |
| B.12 | Correzione 14 applicata insieme all'Addendum 2 |

**Atteso allineato alle correzioni committate:**

| Correzione | Voci |
|---|---|
| 2.1 | A.8, B.16, F.8, H.3, H.7, H.9, I.9 |
| Singole | F.13, E.6, F.23, F.9, J.4, D.1, B.1, C.3, J.6, I.2, B.2, H.2, B.12, B.13, N.3 |

**Decisioni utente e MINOR marcati:**

- Decisioni utente: E.7, H.8, C.9, F.15 (confermata il 24/10) e F.16. E.18 era già marcata il 23/10.
- MINOR aperti: A.3, B.15, F.10, H.3, H.13, I.8, J.7, M.3, M.5, M.6.

**Modifiche ancora da fare dopo questo rilancio:**

| Voce | Modifica |
|---|---|
| F.21 | Passi 4 e 6 da riallineare dopo la decisione sulla spec (sezione 3.1). Oggi il passo 6 dice "resta failed / nessuna PUT", mentre il passo 4 si aspetta la riattivazione. |
| F.13 | Per il markdown digitato: nessuna immagine e nessun toast (non `remoteImagesRemoved`). |
| J.6 | Titolo da riscrivere: il PIN vecchio non sblocca più offline dopo un contatto online. |
| H.13 | Precisare che una POST `/vault/items` all'apertura è una lettura e non viola la 2.1. |
| B.16 | Variante F: annotare che il reconcile non finalizza le RAW (`plain_v` resta 2), oppure aprire un difetto, secondo la decisione presa. |
| H.15 | Riportare la nota sul runbook (switch offline OFF dopo uno sblocco con il bundle vecchio). |

---

## 7. Ambiente e pulizia

**Servizi.** A fine run :3001, :5173 e il sink SMTP :2525 sono attivi, con health 200.

- In L09 il backend :3001 è morto da solo durante il lotto: i log si fermano a metà richiesta e stderr non riporta errori. Ne sono derivati un "Login failed" in B.9 K e un "Failed to fetch" in M.4. È stato riavviato una volta con il comando di ripristino, poi i test sono passati. La causa non è stata indagata.
- Il backend alternativo :3002 era spento all'inizio. L05, L07 e L09 l'hanno avviato in modalità sink e fermato a fine lotto tramite il pid salvato. LMIX e L19 hanno girato direttamente su :3001 con `NO_ALT=1`.
- L19 ha ricreato la ricetta B: worktree `main` in `D:\Develop\AI\Notiq-main`, junction di `node_modules` e Vite :5175. A fine lotto ha rimosso Vite (pid verificato), la junction (senza toccare la destinazione) e il worktree (confermato con `git worktree list`).
- Il limite di login di 5 al minuto per IP è condiviso fra i lotti. È stato gestito con `loginGate`, ma due rerun ravvicinati possono dare "Login failed".

**Repository.**

- `git status` mostra solo la modifica preesistente alla checklist, senza file vuoti spuri. In L06 e L19 un `>` usato per errore in Bash non ha lasciato file.
- Nessun file del prodotto è stato modificato.
- **Harness.** I nuovi spec e helper stanno sotto `frontend/manual-p2/`:
  - `lotto-LMIX-*`, `lotto-R05a..f`, `lotto-R06a..e`, `lotto-R07a..i`, `lotto-R09a..f`, `lotto-19r-retest.spec.ts`.
  - `lib/l19r.ts`.
  - Modifiche retrocompatibili a `lib/l02.ts`, `lib/users.ts` e `lib/budget.ts` (`NO_ALT`).
  - `fg.ps1` migliorato nello scratchpad.
  - Nessun assert è stato allentato. J.4, H.3, H.7, H.9, I.9, A.8 e J.6 ora hanno assert più stretti.

**Dati di test rimasti nel DB dev e in `.state/users.json`.**

- Utenti creati: LC3, LC4, LD1, LD1x0-2, J1..J4 (con suffisso), R05a..R05f, F17, LR12, LR13 (2 run) e LR13v, con le loro note vault.
- Utenti riportati allo stato iniziale:
  - R1e: `failedAttempts 0`, `lockedUntil null`.
  - J5*: PIN riportato a quello del registro.
  - Il vault di A.8 è tornato READY.

**Appunti di sistema.** In L05 sono stati salvati e poi ripristinati (Get-Clipboard/Set-Clipboard). In L09 è stata salvata solo una copia in `D:/tmp/clip-L09.txt`. Gli altri lotti non li hanno toccati.

**Evidenze.** `D:/Develop/AI/Notiq/frontend/manual-p2/out/retest/{LMIX,L05,L06,L07,L09,L19}/`
