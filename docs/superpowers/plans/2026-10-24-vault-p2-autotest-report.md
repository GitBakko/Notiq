# Report finale: verifiche autonome della checklist Vault P2 (branch `feat/vault-p2`, run 1 + run 2, 23-24/10/2026)

Le evidenze stanno in `D:/Develop/AI/Notiq/frontend/manual-p2/out/`, che nel testo abbrevio con `out/`. Precedenze applicate nella fusione:
- il run 2 prevale sul run 1 per le stesse voci (L03b rifà G.1-G.5, L18 rifà A.2 ed E.7 sul bundle prod);
- le riprese (L06, L16, L20) prevalgono sulla prima esecuzione;
- i verdetti del verificatore decidono se un FAIL è un difetto reale. Un FAIL con verdetto "atteso sbagliato in checklist" o "difetto del test" non è contato fra i FAIL confermati: è riclassificato PASS e annotato alla sezione 6.

L17 (Android reale) è SALTATO: `adb devices` era vuoto sia al preflight sia al lancio del run 2. Le sue parti sono alla sezione 5.

## 1. Riepilogo numerico

| Esito | Voci |
|---|---|
| PASS | 120 |
| FAIL confermati | 12: B.12, B.13, B.16, D.1, E.6, F.6, H.2, H.7, H.9, I.9, M.5, N.3 |
| OSSERVATO | 7: E.7, F.9, F.13, F.15, F.23, J.6, M.7 |
| SIMULATO | 4: D.2, H.4, H.15, I.7 |
| NON_ESEGUITO | 0 a livello di voce (le parti non eseguite sono alla sezione 4) |
| UTENTE | 6: N.4, N.5, N.6, N.7, N.8, N.9 |
| **Totale** | **149** |

FAIL del run 2 riclassificati dal verificatore (non sono difetti del prodotto):
- F.7, F.21, H.6 (L15): atteso sbagliato in checklist;
- H.12 e H.8 (run 2): difetto del test; le riprese danno PASS.

### Voci BLOCCANTE (35): 30 PASS, 2 FAIL, 3 UTENTE

| ID | Stato | Nota |
|---|---|---|
| A.1 | PASS | Parte open in L01, parte closed in L10 |
| A.2 | PASS | Bundle prod (L18): una sola GET `all=1`, 62 righe |
| A.3 | PASS | Il testo del passo 6 è da decidere (difetto MINOR, §2) |
| A.4 | PASS | Canary, lista con spazi, id errato; "assente" coperto da unit test |
| A.5 | PASS | Utente READY lavora col kill switch chiuso |
| B.1 | PASS | Credenziale bloccata mostrata "senza titolo" (MINOR) |
| B.2 | PASS | `searchText` resta in chiaro in Dexie fino alla pull (MINOR) |
| B.4 | PASS | Un keyring, B non vede il Kit |
| B.8 | PASS | Lo sblocco finalizza: `plain_v=0` |
| C.2 | PASS | Tabella policy |
| D.4 | PASS | Banner `kitUnconfirmed` (la variante C su iOS resta all'utente) |
| E.4 | PASS | Lockout, conto alla rovescia, email, scadenza |
| E.14 | PASS | Uscita entro 500 ms senza perdita |
| E.16 | PASS | Logout con modifica pendente |
| F.1 | PASS | Mai in chiaro |
| F.14 | PASS | Correzione 41df578 verificata |
| F.16 | PASS | Credenziale cifrata; metadati URL accettati |
| H.1 | PASS | Una copia (en e it) |
| **H.2** | **FAIL** | Con l'editor aperto la copia non nasce da sola in 3 casi su 5 (MAJOR) |
| H.5 | PASS | Rete che cade a metà del reconcile |
| I.1 | PASS | Testo appena scritto incluso, versioni in chiaro 0 |
| I.2 | PASS | Titolo in chiaro nelle `Notification` (MINOR) |
| I.8 | PASS | Variante: testo offline scartato in silenzio (MINOR) |
| J.1 | PASS | Cambio PIN, nessun segreto in rete |
| J.5 | PASS | B offline col vecchio PIN, online col nuovo |
| J.7 | PASS | Lista "Untitled" fino al reconcile (MINOR) |
| K.1 | PASS | `api-cache` senza `/api/vault/` né `/api/notes/<id>` |
| K.2 | PASS | Logout e sblocco svuotano `api-cache` |
| L.1 | PASS | 201 + 409 |
| L.2 | PASS | migrate parallelo |
| N.1 | PASS | Q7 = 10, tutte eccezioni ammesse |
| **N.3** | **FAIL** | Lint del backend rosso, preesistente su main (MINOR); la parte prod è dell'utente |
| N.4 | UTENTE | Prod |
| N.5 | UTENTE | iPhone, prod |
| N.6 | UTENTE | Canary in prod |

Il report del run 1 contava 34 BLOCCANTE perché ometteva E.4. Le BLOCCANTE della checklist sono 35.

## 2. Difetti reali confermati, ordinati per gravità

### MAJOR

**2.1 Aprire una nota vault senza digitare genera una scrittura (UPDATE + PUT con envelope nuovo)**
- **Voci:** H.7, H.9, I.9, B.16 (FAIL). Effetti visti anche in F.4/F.4x, F.8, H.3, H.8 e A.8.
- **Causa:**
  - `frontend/src/components/editor/Editor.tsx:341-345` chiama `editor.setEditable(editable)` al mount.
  - In `@tiptap/core` 2.27.1 (`Editor.ts:192-197`) `emitUpdate` vale `true` di default, quindi parte `onUpdate` (`Editor.tsx:306-310`).
  - L'evento arriva a `VaultNoteEditor.tsx:350-355`: `onChange` chiama `schedule()` (`:110-115`) e imposta `dirty=true`.
  - `flush()` (`:84-108`) ricifra con un IV nuovo e fa la PUT.
  - Succede ancora nel catch di `confirmExit` (`:222-223`).
  - Non è StrictMode: l'effect gira una volta anche in prod. Le credenziali non montano l'Editor e non lo fanno.
- **Repro:** sbloccare il vault e aprire una nota sicura già sincronizzata. Attendere 5-9 s senza digitare. Si vedono `PUT /api/notes/<id>` 200 e l'md5 del content sul server cambiato.
- **Atteso:** nessuna scrittura.
- **Osservato:**
  - una PUT a ogni apertura, su ogni dispositivo;
  - H.7: copia in conflitto spuria col testo "B8";
  - H.9, variante senza scrittura: copia "S10b-nota (conflict copy)";
  - I.9: riapertura stantia senza MK-B-EDIT, uscita dal vault bloccata da 422 ripetuti, poi "copia in conflitto" senza modifiche;
  - H.3: la PUT automatica di A batte la vera modifica di B, che prende 422;
  - F.8: la PUT spuria arriva dopo il DELETE, prende 404 e lascia la riga "updated" con l'editor aperto per 70 s;
  - A.8: un item di sync fallito senza spiegazione;
  - B.16: una nota RAW riscritta come JSON.
  - Nessuna perdita di testo: il contenuto finisce sempre nell'originale o nella copia.
- **Correzione suggerita (non applicata):**
  - in `VaultNoteEditor` `onChange`, `if (c === latest.current.body) return;` prima di `schedule()` (file non TIER);
  - in alternativa `editor.setEditable(editable, false)` in `Editor.tsx:343`. È TIER 2 e tocca anche le note normali, che hanno lo stesso effetto.
- **Evidenza:** `out/L06/PROBE-open.json`, `out/L05/F4x-evidence.json`, `out/L06/H7-evidence.json`, `out/L06/H9-evidence.json` (`varNq60`, `varLista`), `out/L07/I9-evidence.json`, `out/L09/B16-evidence.json`, `out/L09/M4-evidence.json` (`ctrl_putsNormalNoteOnOpen`), `out/L06/H3-evidence.json`.

**2.2 H.2: un conflitto con l'editor aperto non si risolve da solo in 3 casi su 5**
- **Causa:**
  - il trigger alla chiusura (`VaultPage.tsx:177-182`) corre insieme al flush dell'unmount;
  - `CredentialForm.tsx:367-399` rilascia il lock shared solo dopo `saveChainRef`, e la push tiene lo shared (`syncService.ts:625-632`);
  - il giro finisce in LATER, per lock occupato (`vaultReconcile.ts:857-858`) o per `listSig` cambiata (`:831`);
  - LATER incrementa solo `r.later` (`:824`) e nessuno lo rischedula.
- **Repro:** credenziale aperta su A e B. A va offline e scrive pw-A-1, B scrive pw-B-1. A torna online e prende 422. A scrive pw-A-2 e preme Indietro entro 600 ms. Varianti: PUT in volo con latenza 3000 + Indietro, oppure pw-A-2 prima del 422.
- **Atteso:** 1 copia con pw-A-2, originale pw-B-1, coda vuota.
- **Osservato:**
  - per 196 s nessuna copia;
  - coda con 2 item (uno failed `vault:conflict`, uno pending), riga A = pw-A-2, server = B;
  - si sblocca solo con "Controlla ora" o apri+chiudi; nel caso beforeFail nemmeno "Controlla ora" basta;
  - nessun dato perso.
- **Correzione:** rischedulare un giro quando `r.later > 0`, oppure far partire il trigger di chiusura dopo il rilascio del lock. `vaultReconcile.ts` e `syncService.ts` sono TIER 1: si cambia prima la spec.
- **Evidenza:** `out/L06/H2-evidence.json` (`runs[].timeline`, `nonRisolto`, `checkNowDiag`). Coincide in parte col backlog HANDOFF §4.2.

**2.3 B.13: credenziale v2 modificata col bundle vecchio dopo il keyring. Nessuna copia, la modifica non è più recuperabile dall'utente**
- **Causa:**
  - `vaultReconcile.ts:255` e `:243`: una riga v2 è LP, quindi t6 fa LEAVE legacyPin;
  - `:319-326`: `decryptLegacy` arriva solo dal wizard (`vaultMigration.ts:369`);
  - il wizard non è raggiungibile su B: `VaultPage.tsx:421` con `legacyLeft=0` (`vaultReconcile.ts:758`).
  - Va contro il design §6.3 e l'accettazione 16.
- **Repro (Ricetta B):** A esegue il wizard sul branch. B torna a main, sblocca col vecchio PIN e cambia la password di CV in MK-PW-OLDBUNDLE (PUT 422 `plaintextRejected`). B torna al branch e sblocca col PIN nuovo, poi "Controlla ora" e "Riprova".
- **Atteso:** 1 copia in conflitto con MK-PW-OLDBUNDLE, originale col valore del server, coda vuota.
- **Osservato:**
  - 0 copie;
  - l'item resta failed/validation e "Riprova" non invia nulla;
  - CV si apre con "Failed to decrypt credential";
  - la password nuova esiste solo nell'item fallito e nella riga locale.
- **Correzione:** offrire l'inserimento del PIN precedente fuori dal wizard (`decryptLegacy` nel reconcile) e generare la copia. File TIER 1.
- **Evidenza:** `out/L19/B13-evidence.json`, `out/L19/run1/`, `out/L19/run3/`, `out/L19/run2/B13-04-B-branch-CV-view.png`.

**2.4 B.12: credenziale lasciata legacy su B. "Untitled Credential" e "Failed to decrypt credential", senza via d'uscita**
- **Causa:**
  - stessa catena di 2.3 (`vaultReconcile.ts:241-243,255,319-326`);
  - la pull scrive il `title ''` del server (`syncService.ts:208-220`);
  - `CredentialForm.tsx:112-115` dà solo `decryptFailed`;
  - il testo `reason.legacyPin` dice "inseriscilo nel vault", ma non esiste un campo per farlo.
- **Repro:** B.12 completo, poi aprire la lista del vault su B e quindi la credenziale CV.
- **Atteso:** titoli originali decifrati.
- **Osservato:** la riga CV resta v2 con `title ''`, synced e senza item, anche se il server ha un envelope nv3 valido. La credenziale resta illeggibile finché non si cancellano i dati del sito. Il resto di B.12 è PASS.
- **Correzione:** in t6, con P = `legacyPin` e riga synced senza item, ADOPT del server invece di LEAVE. File TIER 1, va proposta prima.
- **Evidenza:** `out/L19/B12-evidence.json` (`titlesB`), `out/L19/run2/B13-04-B-branch-CV-view.png`.

**2.5 F.13: il drop di un file immagine sull'editor vault non è bloccato (MAJOR condizionato alla prova manuale)**
- **Causa:**
  - `ImageDrop.ts:47-48`: senza `uploadFn` (editor vault, `Editor.tsx:244-249`) `handleDrop` ritorna `false`;
  - `prosemirror-view` non fa `preventDefault` quando c'è solo un file;
  - `VaultNoteEditor` non ha `onDragOver`/`onDrop` di contorno (`NoteEditor.tsx:599-600` li ha solo per le note normali).
- **Repro:** `DragEvent` drop con un File PNG sul `.ProseMirror` del vault, poi lettura di `defaultPrevented`.
- **Atteso:** nessuna navigazione.
- **Osservato:** `syntheticDropDefaultPrevented=false`. Se Chrome naviga al file si perdono lo sblocco e l'ultimo secondo di modifiche. Non è dimostrabile in automazione: il drop via CDP non naviga nemmeno nel controllo negativo. Se la prova manuale mostra che Chrome non fa nulla, la gravità scende a NIT.
- **Correzione:** in `handleDrop`, con `!uploadFn` e file immagine presenti, `event.preventDefault(); return true;`.
- **Evidenza:** `out/L05/F13-evidence.json`.

### MINOR

| Voce | Titolo | Causa | Repro breve | Atteso / Osservato | Correzione | Evidenza |
|---|---|---|---|---|---|---|
| E.6 | Il lockout visto online disabilita lo sblocco offline sulla stessa schermata | `VaultUnlock.tsx:46` (`locked = remaining > 0`), `:63`, `:122`, `:136`; stato locale `:40,53-55` | R1e: 6 errori su A, poi B online con PIN1 (lockout), poi B offline senza reload | Atteso: PIN1 sblocca offline (design §5.2). Osservato: campo disabilitato per 15 min; funziona solo dopo un remount | `locked = remaining > 0 && !(offline && canOffline)` + listener online/offline | `out/L03/E6-evidence.json`, `out/L03/E6-step3-samescreen.png` |
| F.6 (e F.7) | Una riga vault locale corrotta non si autoripara; "Controlla ora" dice "tutto aggiornato" | `vaultReconcile.ts:638` (`hydrateVaultNote` esce se hs == base) e `:273` (T1 NONE); l'hash locale `hl` (`:362`) non viene confrontato | Alterare un carattere del content di una nota synced in Dexie, poi riaprire, Riprova, "Controlla ora", reload | Atteso: idratazione dal server. Osservato: illeggibile in tutti i percorsi, server intatto | T1 HYDRATE anche con riga synced e `hl !== hs`, idem in `hydrateVaultNote`. TIER 1: spec prima | `out/L05/F6-evidence.json`, `out/L05/F7-evidence.json` |
| B.13 variante | Copia in conflitto di una nota con titolo vuoto: "(conflict copy)" | `vaultReconcile.ts:306` (il titolo del server si adotta solo con riga synced) | Come B.13 ma su una nota ancora in chiaro su B | Atteso: "LB-N2 (conflict copy)". Osservato: titolo vuoto, contenuto corretto (2 run) | Togliere la condizione `syncStatus === 'synced'` quando `row.title === ''` e non ci sono item col titolo | `out/L19/variant/variant-evidence.json` |
| I.8 variante | Il testo breve scritto offline su una nota appena uscita dal vault viene scartato in silenzio | `backend/src/utils/contentGuard.ts:15-17`; `note.service.ts:230,366,377,407` (risposta 200 senza scrittura) | B offline apre la nota (corpo vuoto, backlog noto), scrive MK-B-OFFLINE, torna online | Atteso: nessuna perdita silenziosa. Osservato: PUT 200 non applicate, testo perso e nessun avviso. Non nasce in P2 | Salvare il contenuto rifiutato come versione oppure avvisare il client; da mettere in backlog | `out/L07/I8-evidence.json` (`variante_*`) |
| B.2 | `searchText` in chiaro in Dexie dopo la migrazione, fino alla pull successiva | `vaultMigration.ts:363-380` e il reconcile non lo azzerano; solo `vaultMove.ts:240` lo fa | Wizard, poi "Fine", poi dump | Atteso: nessun plaintext in Dexie (D8). Osservato: MK-BODY-A in `searchText` fino al reload/pull; su un dispositivo che va subito offline il residuo resta | Azzerare `searchText` nel commit per nota (TIER 1), oppure accettarlo come residuo | `out/L09/B1B2-evidence.json` |
| I.2 | Il titolo resta in chiaro nelle righe `Notification` dopo l'ingresso nel vault | `note.service.ts:343-345,396-401` (la pulizia non tocca `Notification`) | Condividere una nota, accettare, spostare nel vault, query su `Notification` | Atteso: nessun plaintext. Osservato: 3 righe col titolo, visibili a C | Pulizia o testo generico, oppure residuo accettato (decisione) | `out/L07/I2-evidence.json` |
| B.15 | Il riepilogo della migrazione non segnala la nota con allegato | Piano P2 `:450,:485,:768,:776` (D3 "si segnala"); nessun riferimento ad allegati in `VaultMigrate.tsx`/`vaultMigration.ts` | Wizard con un allegato su noteA | Atteso: segnalazione. Osservato: `summaryMentionsAttachment=false` | Aggiungere l'avviso al riepilogo | `out/L09/B15-evidence.json` |
| F.13 | Un'immagine remota nel paste HTML viene inserita e scaricata (web beacon) | `Editor.tsx:241-253` (nessun filtro sullo schema di `src` con `isVault`) | Incollare HTML con `<img src=http://...>` | Da decidere. Osservato: inserita, il browser la richiede a ogni apertura | Rifiutare nel vault gli `src` diversi da `/uploads` | `out/L05/F13-evidence.json` |
| B.1/B.3 | Credenziale legacy bloccata mostrata come "Credenziale senza titolo" | `CredentialCard.tsx:27-28,100` (ignora `note.title`); `VaultPage.tsx:304` invece ci ripiega | Wizard senza unknown77, poi la lista | Atteso: MK-TITLE-LOCK. Osservato: "senza titolo" (la ricerca la trova comunque) | Riga 100: `view?.title \|\| (!ENVELOPE_RE.test(note.content ?? '') ? note.title : '') \|\| t(...)` | `out/L09/B1B2-evidence.json`, `out/L09/B3b-evidence.json` |
| J.6 | Il testo `pinOfflineNote` promette "finché non torna online", ma il vecchio PIN resta valido offline | `it.json:647` (+ en); `cacheKeyring` solo in `vaultSession.ts:74` (chiamato a :156,180,234,279,457,493) | Cambio PIN sul PC; B online e sbloccato per 62 s, poi Blocca e offline | Osservato: PIN1 sblocca offline | Correggere il testo o aggiornare la cache al ritorno online (decisione) | `out/L06/J5-J6-evidence.json` |
| H.3 | Il toast `failedToast` dice "Usa Riprova", ma per `vault:conflict` Riprova non fa nulla | `it.json:976`, `en.json:1352`; requisito del piano P2 §12.11 (`:738`) non applicato | 422 di conflitto con l'editor aperto, poi Riprova | Osservato: coda identica prima e dopo | Riformulare il testo (decisione sulla formulazione) | `out/L06/H3-evidence.json` |
| H.13 | Una credenziale aperta mostra il valore vecchio: conflitto evitabile | `VaultPage.tsx:340-348` (idrata solo con content `''`); le note sì (`VaultNoteEditor.tsx:125`) | B cambia la password, A la apre | Osservato: pw-0, poi 422 e copia, nessuna perdita | Idratare la credenziale all'apertura come le note | `out/L06/H13-evidence.json` |
| J.4 | Il doppio invio del cambio PIN con la blocklist ancora da caricare avvia 2 flussi | `VaultSettingsSheet.tsx:110-115` (`pinBusy` impostato dopo `await checkPin`); `PinPolicy.ts:70-72` | Reload, PIN con 4+ minuscole, doppio clic su "Cambia PIN" | Osservato: 2 unlock, 3 PUT (200/409/200), rev +2, PIN finale valido | `setPinBusy(true)` prima di `await`, oppure guardia con un ref | `out/L08/J4-evidence.json` |
| J.7 | Dopo "Rimuovi dal dispositivo" e un nuovo sblocco la lista resta "Untitled" fino a un reconcile | `vaultReconcile.ts:179` (riga assente = T15 NONE); `syncService.ts:176-213` (pull senza content); `VaultPage.tsx:170-182` | Rimuovi, /vault, sblocco online subito | Osservato: lista vuota, poi "Untitled" per ~23 s e oltre, finché non si chiude una nota o si preme "Controlla ora" | Rilanciare il reconcile dopo una pull che porta righe vault vuote | `out/L08/J7-evidence.json` |
| F.23 | Il doppio clic sui pulsanti di creazione crea 2 item | `VaultPage.tsx:222-250` (nessuna guardia `isPending`) | Doppio clic su "New Secure Note" o "New Credential" | Atteso: 1. Osservato: 2, validi e cifrati | `if (createMutation.isPending) return;` + `disabled` | `out/L05/F23-evidence.json` |
| F.9 | Una nota vault fissata compare in sidebar come "Untitled Note" e il clic non porta a nulla | `hooks/usePinnedNotes.ts:5-9` (non filtra `isVault`); `NotesPage.tsx:82-87` | Fissare una nota vault | Osservato: voce morta che rivela l'esistenza della nota anche a vault bloccato | `&& !note.isVault`, oppure link a `/vault?noteId=` | `out/L05/F9-evidence.json`, `out/L05/F9-sidebar-click.png` |
| F.10 | Il selettore del promemoria mostra l'ora in UTC | `VaultNoteEditor.tsx:298` (copia di `NoteEditor.tsx:772`, preesistente) | Promemoria alle 15:55 (Europe/Rome), poi riapertura | Osservato: 13:55; se riconfermato, slitta di 2 h | Formattare in ora locale | `out/L05/F10-evidence.json` |
| A.3 p6 | Il testo `setupDisabled` è più corto di quello del piano e non dice al legacy che il suo vault non è accessibile | `it.json:1790`/`en.json:1790`; `VaultPage.tsx:402`, `:393`, `:126`; piano `:292`, `:588` (T17) | Utente legacy col kill switch chiuso | Osservato: "Il vault non è ancora disponibile." per tutti | Chiave dedicata con `legacyCount > 0`, oppure accettare il testo corto | `out/L10/A3-evidence.json`, `out/L10/A3-passo3-legacy.png` |
| D.1 | Il codice del Kit non ha il nome accessibile "Codice del Kit di recupero" | `RecoveryKitSheet.tsx:124-129` (`aria-label` su un div senza ruolo) | `ariaSnapshot()` del foglio del Kit | Osservato: solo `text: G6G4-...` | `role="group"` oppure un'etichetta nascosta | `out/L02/D1-aria.txt`, `out/L02/D1-summary.json` |
| M.5 | ConfirmDialog con pulsanti da 40 px e X da 20 px | `components/ui/Button.tsx:21` (md = `h-10`); `ConfirmDialog.tsx:32-43`; `Dialog.tsx:54-55` | /settings, "Rimuovi da questo dispositivo" | Atteso ≥ 44. Osservato: 79x40, 216x40, 20x20 | Correggere il componente condiviso (impatto su tutta l'app) | `out/L16/M5-evidence.json`, `out/L16/shots/m5-emu-it-m5-06-confirm.png` |
| M.3 | Target interattivi del vault sotto i 44 px | `CredentialForm.tsx:446-458`, `CopyButton.tsx:44-47`, `SortDropdown.tsx`, Input condivisi | Walk a 320/375/412 px | Osservato: chip 25 px, ordinamento 30x22, Indietro credenziale 66x20, copia 28x28 | Aggiungere `min-h-[44px] min-w-[44px]` | `out/L16/walk-emu-dark-it.json`, `out/L16/walk-m320-en.json` |
| M.6 | Toast di successo bianco su smeraldo: contrasto 2,54:1 | `App.tsx:45-53` (`#10b981` / `#fff`) | Qualunque toast di successo | Atteso: leggibile. Osservato: sotto 3:1 | Emerald-700 `#047857` | `out/L16/walk-*.json` (`lowContrast`) |
| N.3 | Lint del backend rosso: 3 `no-explicit-any` | `backend/src/utils/ydoc.ts:266,269,270` (commit e6879212, già su main e in prod 1.13.3) | `cd backend; npm run lint` | Atteso: verde. Osservato: exit 1, 3 errori e 60 warning. Non è una regressione P2 | Tipi `JSONContent`/`unknown` oppure un `eslint-disable` motivato. TIER 1: conferma esplicita | `out/L20/run2/be-lint.log` |

### NIT

| Voce | Titolo | Causa | Correzione | Evidenza |
|---|---|---|---|---|
| C.11 | Worker argon2 del benchmark non terminato in circa il 50% delle uscite durante la corsa (CPU a riposo, ~64 MiB trattenuti) | `features/admin/VaultBenchPage.tsx:70` (il cleanup non chiama `resetArgon2Worker()`, Stop sì a `:213`) | `useEffect(() => () => { stopRef.current = true; resetArgon2Worker(); }, [])` | `out/L16/C11-leave-leave-emu.json`, `out/L16/C11-leave-leave-pc.json` |
| M.4 | Dopo "Fine", con CPU 6x, i titoli della lista compaiono a poco a poco (fino a ~60 s) | `VaultPage.tsx:255-299` (`setPlain` solo a fine ciclo, commit per nota) | Aggiornamenti parziali di `setPlain` | `out/L16/titles-evidence.json` |
| M.7 | Plurali errati con n=1 ("1 elementi", "1 items", "1 credenziali sono bloccate", ecc.) | `en.json:426,528-530,567,569,579,1349` (+ it); nessuna chiave `_one` | Chiavi plurali i18next | `out/L16/wizard-wiz-m320-en.json`, `out/L16/M7-removeBlocked-*.json` |
| M.7 | `rateLimited` "Riprova tra poco" impreciso per il limite orario | `it.json:1788` | Testo più preciso | `out/L16/M7-phase1-*.json` |
| M.7 | Taccuino "First Notebook" in inglese per un utente IT | `backend/src/services/auth.service.ts:72` | Localizzare | – |
| M.6 | Testi `neutral-400` su bianco in chiaro: 2,56:1 | `CredentialForm.tsx:508,526,601,673`, `CredentialCard.tsx:118` | `neutral-500` o `neutral-600` | `out/L16/walk-*.json` |
| M.6 | Il tema "sistema" non segue il cambio dell'OS a pagina aperta | `store/uiStore.ts:37-45,105` (nessun listener `change`) | Listener su `matchMedia` | `out/L16/M6-theme-evidence.json` |
| M.1 | Su http LAN /vault mostra il setup senza avviso di contesto insicuro (solo dev) | `VaultPage.tsx` senza stato "insicuro"; solo il bench lo controlla (`VaultBenchPage.tsx:72`) | Facoltativo | `out/L16/M1-evidence.json` |
| F.5 | Con la nota eliminata sul server, "Riprova" non può riuscire | `vaultReconcile.ts:629-632`; `VaultNoteEditor.tsx:128-129,238-239` | Mostrare `itemNotFound` quando il server risponde absent | `out/L05/F5-evidence.json`, `out/L05/F5b-evidence.json` |

Sospetti ritirati dal verificatore (difetto del test o ambiente):
- H.12/D3: 5 giri sequenziali, non sovrapposti. Nella ripresa la concorrenza massima è 1.
- H.9/D4: il 422 c'era, prima di A10, ed è un effetto di 2.1.
- H.8: due 422, una per scheda.
- M.4: blocco a 602 s, perché il ritardo di 35 s supera il timeout Axios di 30 s.
- N.1: versioni in chiaro di M.4, dovute allo stallo di 150 s del vecchio script.
- E.7 passo 4: in dev era StrictMode; nel bundle prod è PASS.
- F.3: doppio lock in StrictMode.
- B.5: form disabilitato dopo la scadenza forzata via SQL.

## 3. OSSERVATO, osservazioni da decidere, SIMULATO

### 3.1 Voci OSSERVATO (servono decisioni)

- **E.7** (`out/L18/E7-evidence.json`, `out/L03/E7-evidence.json`).
  - Conformi: nessun "Avviso importante", PIN errato con il foglio che resta aperto, doppio invio = 1 POST, nota cifrata, invariante 0.
  - Nel bundle prod /vault aperta via SPA risulta sbloccata.
  - Senza passare da /vault il secondo spostamento non chiede il PIN.
  - Dopo una visita a /vault il PIN viene richiesto, perché `VaultPage.tsx:350-355` blocca allo smontaggio. È una scelta di sicurezza del piano P2 (`:97,294,588`), quindi l'atteso va corretto (sezione 6).
  - **Decisione:** tenere il blocco all'uscita da /vault oppure toglierlo.
- **F.9:** nota fissata visibile in sidebar come "Untitled Note" (difetto MINOR in §2). Decidere se escluderla o portare il clic a /vault.
- **F.13:** immagine remota incollata e caricata (MINOR); drop non bloccato (MAJOR condizionato). Decidere se bloccare le immagini remote nel vault.
- **F.15:** dettatura e "Insert Encrypted Block" presenti nella toolbar del vault, nessun plaintext. **Già accettato** dalla decisione utente: la dettatura resta.
- **F.23:** il doppio clic crea duplicati (MINOR). Va corretto.
- **J.6:** il vecchio PIN sblocca offline dopo più di 1 min online. Correggere il testo (`it.json:647`) oppure il codice.
- **M.7:**
  - 0 chiavi grezze, 0 testi nella lingua sbagliata, parità en/it 1743/1743;
  - email di lockout nella lingua di `User.locale`, con ripiego su en per locale vuoto;
  - plurali con n=1 errati (NIT);
  - `later` con n=1 ed `errors.vault.locked` mai prodotti a schermo.

### 3.2 Osservazioni da decidere dentro voci PASS

- **C.3:** il PIN viene troncato a 6 caratteri al setup; allo sblocco 7 caratteri contano come errore.
- **C.4:** una password alfanumerica di 16 caratteri troncata a 6 (`Xk9mP2`) passa la policy e diventa il PIN.
- **C.6:** dopo un 201 perso sullo stesso dispositivo, il testo dice "altro dispositivo".
- **C.9:** la casella "sblocco offline" parte non spuntata, mentre il design dice "attivo di default".
- **C.10:** se il Worker fallisce compare il messaggio generico; manca una chiave `kdfFailed`.
- **D.8:** con due cambi PIN in parallelo vale l'ultimo.
- **E.2:** il link "PIN dimenticato" non c'è nel `VaultUnlockDialog`.
- **D.4 variante C:** "Indietro" esce da /vault.
- **A.1:** 404 su una nota non ancora pushata (normale offline-first).
- **G.4 passo 3:** con m=1024 compare "Qualcosa è andato storto" e non "PIN errato". La checklist ammette entrambi.
- **E.12:** la rotellina e lo scroll non azzerano l'auto-lock: chi legge solo scorrendo viene bloccato a 10:00.
- **E.13:** dopo un freeze CDP di 15 min il contenuto resta visibile ~154 ms prima del blocco (non c'è controllo su `visibilitychange`). Su Android da verificare.
- **E.18:** la perdita della finestra di 1 s alla chiusura o al reload è già accettata. È identica sulle note normali.
- **E.4 / E.5:**
  - l'orario dell'email è un ISO con millisecondi (`2026-10-23T18:23:16.698Z (UTC)`);
  - il conto alla rovescia mostra solo minuti (`1439:57` per 24 h);
  - con `ceil`, un tentativo entro 1 s dal blocco mostra "15:00".
- **B.5:** nel wizard il PIN errato resta nel campo e il tempo residuo non compare.
- **B.11:** al logout da un'altra scheda la scheda 1 mostra "Vault bloccato" invece di `migrate.errors.locked` (vedi sezione 6).
- **F.16:** l'URL del sito della credenziale va in chiaro a `/api/url-metadata` (thum.io) e a icons.duckduckgo.com. Accettato e confermato.
- **F.17:** senza focus `writeText('')` fallisce in silenzio (NotAllowedError): la password resta negli appunti.
- **F.20:** una PUT con content identico e `baseHash` sbagliato risponde 200 (replay idempotente voluto).
- **H.3:** gli edit restano fermi finché non si chiude la nota (136 s osservati).
- **H.8:** perdita silenziosa di "t2" fra due schede: vince l'ultima scrittura locale. Decisione aperta (HANDOFF §5).
- **H.14 passo 5:** nessun residuo `byUser` in questo run.
- **H.15 (nota per il runbook):** dopo lo sblocco online con un bundle vecchio, lo switch offline torna OFF e lo share viene cancellato.
- **I.8:** resta 1 NoteVersion nv3 sulla nota uscita dal vault, nascosta in UI e non ripristinabile (by design §5.10, accettato).
- **I.11:** 8 s dopo il ripristino della rete l'item in coda c'è ancora (nessun criterio violato).
- **A.6 / A.7 / E.9:** durante il 503 o il pepper diverso il reconcile chiama `POST /api/vault/items` (503 oppure 200), senza effetti.
- **K.1:** `GET /api/vault/keyring` 2 volte per ingresso con sblocco (Gate + `unlockOnline`, per progetto).
- **J.9:** `skipped.busy` non compare mai: il secondo clic viene assorbito.
- **D.6:** con `clock.fastForward` il vault si blocca col Kit aperto. È un artefatto del metodo; con `runFor` è PASS.

### 3.3 Voci SIMULATO (limite)

- **D.2:** il ramo "permesso negato" usa uno stub di `writeText` respinto, perché CDP non concede né nega i permessi clipboard. La copia reale è PASS su PC ed emulazione.
- **H.4:** risposta persa simulata con route fwd-drop e latenza, non con timeout reali di rete o di proxy.
- **H.15:** bundle vecchio simulato con `localStorage.setItem` da un'altra scheda; il rollout con PWA autoUpdate si vede solo al deploy.
- **I.7:** ramo "applicata" con fwd-drop deterministico, non con latenza di 8 s + Offline reale.

Parti simulate dentro voci PASS:
- M.4: throttling CPU 20x/6x ed emulazione Pixel 7, non Android;
- G.1 e G.5: emulazione, non modalità aereo reale;
- E.12, D.6 ed E.7: orologio finto;
- E.18: `page.reload`/`page.close` al posto della tastiera;
- H.5: ritardo di 4 s invece del profilo CDP;
- J.3 e B.8/B.9: hold e `tokenVersion+1` al posto di breakpoint e chiusura reale;
- M.5: tastiera simulata con viewport di 420 px;
- A.9 e C.7: doppio tap solo in emulazione;
- C.6: caduta di rete solo su `/api/vault`.

## 4. Parti NON_ESEGUITE (nessuna voce intera)

- **L17 (Android reale): saltato** perché `adb devices` era vuoto. Tutte le sue parti sono alla sezione 5.
- **I.2:** ramo "flush del doc live fallito" non riprodotto. Servirebbe rompere Hocuspocus su :3001, che non si tocca. Può coprirlo uno unit test del server.
- **N.3:** E2E completi non rieseguiti; l'ultimo giro registrato è 55/55 del 22/10.
- **E.7 passi 6-8:** non rieseguiti su prod (coperti in L03). Il passo 8 è dell'utente.
- **E.18 passo 5** (switcher del telefono, facoltativo) ed **F.15** (dettatura reale col microfono, facoltativa).
- **A.5:** chiamate dirette a `/migrate` e `/finalize` con R0 non provate (non richieste dai passi).
- **A.4:** il valore "assente" del kill switch non è raggiungibile in e2e; è coperto dallo unit test `vault.keyring.test.ts -t setupAllowed`.
- **M.7:** `later` con n=1 ed `errors.vault.locked` non prodotti a schermo.
- **C.11 passo 8, D.2 incolla di un gruppo, D.3 secondo download con sha256:** non rifatti in emulazione (fatti su PC in L02).
- **N.2:** sblocco col pepper originale non ripetuto nel run 2. Non serve: :3001 non ha mai cambiato pepper.

## 5. Da fare a mano dall'utente

### iPhone e produzione

- **N.3, parte prod.** Perché non io: è produzione, vietata, e ydoc.ts è TIER 1.
  1. Lanciare la SQL pre-deploy del runbook in pgAdmin.
  2. Controllare il `.env` di prod: `VAULT_SETUP_USERS` vuoto.
  3. Annotare `ts1` del backup.
  4. Decidere se i 3 errori di lint in `ydoc.ts` bloccano il rilascio.
- **N.4.** Perché non io: è produzione.
  1. Fare il deploy con `/notiq-deploy`.
  2. Fare un hard reload.
  3. Controllare `index-*.js`, il content-type e il SW nuovo.
- **N.5.** Perché non io: niente iOS né prod.
  1. Aprire `/admin/vault-bench` da Safari e dalla PWA.
  2. Avviare la corsa e copiare il risultato.
  3. Confrontarlo con `DEFAULT_KDF`.
- **N.6.** Perché non io: è produzione e il punto di non ritorno.
  1. Impostare `VAULT_SETUP_USERS=<id SUPERADMIN>` e fare `pm2 restart`.
  2. Fare il setup.
  3. Verificare il keyring READY.
- **N.7.** Perché non io: è produzione. Seguire i passi successivi della sezione "Rilascio vault P2" di `/notiq-deploy`.
- **N.8.** Perché non io: serve un iPhone.
  1. Sbloccare il vault nella PWA.
  2. Background o schermo spento per 12-15 min.
  3. Riaprire: blocco e salvataggio corretti.
- **N.9.** Perché non io: serve un iPhone.
  1. Scaricare il PDF del Kit dalla PWA (blob).
  2. Swipe Indietro durante la cerimonia: banner `kitUnconfirmed` al prossimo sblocco (anche D.4, variante C).
  3. Controllare cosa propone il portachiavi iCloud sui campi PIN.
- **Limiti di prod da osservare al rilascio.** Perché non io: in dev non ci sono IIS, ARR né la PWA vecchia.
  - E.9/H.6: con pm2 fermo IIS dà 502, e deve comportarsi come guasto di trasporto (attempts fermo, failed dopo ~10 min).
  - H.12: comportamento di ARR con i 429 di `/vault/items`.
  - H.15/K.5: passaggio reale 1.13.3 → P2 con bundle vecchio in cache e `api-cache` vecchia.
  - H.4: timeout reali di rete o proxy.
- **J.5, facoltativo:** ripetere il cambio PIN con B = iPhone offline. Perché non io: niente iOS.
- **G.3 passo 9 / M.5 (VoiceOver):** ascoltare gli annunci dello switch "Sblocco offline", del dialog e del focus trap. Serve uno screen reader reale.

### Android (L17 saltato, `adb devices` vuoto)

- **G.1.**
  1. Bloccare il vault e attivare la modalità aereo.
  2. PIN errato ("PIN errato"), poi PIN1 sblocca.
  3. Modificare una credenziale, tornare online e controllare la push.
  - Perché non io: la modalità aereo reale non è riproducibile.
- **G.3 passo 9 (TalkBack).** Ascoltare l'annuncio dello switch con lo stato. Serve uno screen reader reale.
- **D.6 passo 4.**
  1. Foglio del Kit aperto, schermo spento per 12 min.
  2. Se il vault si è bloccato, al prossimo sblocco deve comparire il banner `kitUnconfirmed`.
  - Perché non io: serve la sospensione reale.
- **E.13.**
  1. Vault sbloccato, schermo spento o altra app per 15 min.
  2. Al ritorno: titoli e credenziali non devono essere visibili nemmeno per un istante.
  - Perché non io: in sospensione il timer può non avanzare; il freeze CDP mostra 154 ms di contenuto visibile.
- **E.18 passo 5 (facoltativo).** Scrivere " R4" e chiudere l'app dallo switcher. Serve un telefono.
- **A.9 passo 4.** Login, modalità aereo, /vault (mai il setup), poi rete di nuovo. L'emulazione non basta.
- **C.4, E.8, M.2, M.5, E.7 passo 8: tastiera reale.**
  1. Scrivere nei campi PIN di setup, sblocco e foglio: niente maiuscola automatica né autocorrezione.
  2. Con la tastiera aperta "Crea Vault" e "Fine" non devono essere coperti, e nemmeno il campo PIN del foglio da "Aggiungi al vault".
  3. Controllare barra dei gesti e safe area.
  - Perché non io: l'emulazione non ha la tastiera virtuale.
- **C.10, E.8, M.4: tempi reali.**
  1. Misurare i tempi di setup e di sblocco.
  2. Wizard di 2-3 min senza toccare lo schermo, con lo schermo spento 1 min a metà.
  - Perché non io: serve l'hardware.
- **C.11 passo 11.** `adb reverse` di 5173 e 3001, poi `/admin/vault-bench`, corsa, bottoni da 44 px. Nessun device collegato.
- **M.1.** Sonda `isSecureContext`/`crypto.subtle` sul telefono via `http://IP-LAN:5173` e via `adb reverse`. La LAN reale non è simulabile.
- **D.2.** Copiare il Kit, incollarlo in un'app; poi bloccare gli appunti dal lucchetto del sito: toast "Impossibile copiare". Gli appunti del telefono non sono raggiungibili.
- **D.3.** Download del PDF del Kit: file in Download, riapertura, foglio ancora aperto al ritorno. Serve il gestore download del telefono.
- **F.10 / M.3.**
  1. Usare il selettore data/ora nativo del promemoria.
  2. Controllare la toolbar sopra la tastiera vera.
  3. Incollare la password generata in un'altra app.
  - Perché non io: è UI di sistema.
- **F.17 / G.5 (facoltativi).** Ripetere la copia della password, e gli edit offline di G.5, su un telefono vero. Serve un dispositivo reale.

### PC con Chrome reale

- **C.4 (gestore password).**
  1. Con la password di login salvata, fare il setup con un utente nuovo: Chrome propone "Usa password suggerita"?
  2. Annotare se compare "Salvare/Aggiornare la password?" e con quale valore.
  3. Fare logout e login: quale password propone l'autofill?
  4. Allo sblocco: il campo PIN si riempie da solo?
  - Perché non io: il Chromium di Playwright non ha il gestore password.
- **F.16.** Compilare la password di una credenziale e annotare se Chrome propone "Salvare la password?". Stesso motivo.
- **F.17.** Copiare la password di una credenziale, attendere 35 s e aprire Win+V: la voce è ancora nella cronologia? Non c'è API per Win+V.
- **F.13.** Trascinare un PNG da Esplora file sull'editor di una nota sicura: la scheda naviga al file? Se sì, il difetto 2.5 è MAJOR confermato. Il drag dall'OS non è automatizzabile.
- **D.3.** Stampare il PDF del Kit in A4 e controllare che non ci siano tagli. La stampa è fisica.
- **I.7.** DevTools: latenza di 8000 ms sulla PUT di "Aggiungi al vault", poi Offline mentre è pending. Deve uscirne 1 copia in conflitto e nessun plaintext sul server. L'ho fatto solo con fwd-drop.
- **M.6 (facoltativo).** Giudizio estetico del tema scuro. Io ho valutato solo leggibilità e bordi.

### Decisioni di prodotto in sospeso

- E.7: blocco all'uscita da /vault.
- H.8: perdita di t2 fra schede.
- J.6: testo o codice.
- H.3: testo del toast.
- A.3 p6: testo `setupDisabled`.
- F.9: nota fissata in sidebar.
- F.13: immagini remote nel vault.
- I.2: titoli nelle `Notification`.
- I.8: testo offline scartato, da mettere in backlog.
- B.2: `searchText` residuo.
- N.3: il lint blocca il deploy?
- C.3, C.4, C.9, C.10, E.2 (dal run 1).
- Ordine di correzione dei MAJOR (§2.1-2.5). Tranne 2.1 e 2.5, toccano file TIER 1.

## 6. Atteso sbagliato in checklist: correzioni proposte

1. **A.2:** "una sola GET `all=1`" vale sul bundle prod (confermato in L18). Aggiungere "(in dev StrictMode ne fa 2 a pochi ms, `main.tsx:97`)".
2. **E.7, riga 1215:** "Senza passare da /vault il secondo spostamento non chiede il PIN; dopo una visita a /vault lo chiede, perché VaultPage blocca all'unmount (`VaultPage.tsx:351-355`, piano `:97,294`)". Il passo 4 va fatto sul bundle prod.
3. **C.4 passo 1:** "rifiutata se i primi 6 caratteri violano la policy; altrimenti diventa il PIN (rischio UX da decidere)".
4. **F.5:** togliere il percorso "`hydrateVaultNote` rimuove la riga" (non esiste); resta "l'editor si chiude da solo alla pull successiva".
5. **F.7:** l'atteso di "Controlla ora" diventa "nessun unresolved (T1 NONE)". T8 guarda l'epoch del server. Aggiungere che la riga resta illeggibile finché non si corregge F.6.
6. **F.6:** la riga ":637-639 hash diverso" va riletta: il codice confronta l'hash del server con la base. L'auto-riparazione richiede di cambiare prima la spec T1.
7. **F.20 passo 4:** usare un content diverso da quello del server, perché con content identico la PUT è un replay idempotente (200).
8. **F.21 passo 5:** con `withTitle=true` l'atteso è T6 REENCRYPT_TITLE: il titolo diventa "x", PUT 200 col solo content e `baseHash`, coda vuota. Lo "skip senza PUT" va su un seed con `withTitle=false`.
9. **H.6, riga 1871:** "Diretto (status 0): attempts fermo, retry ogni ~30 s, failed/`network` dopo ~10 min con banner. Proxy (500): backoff 5/15/45/135 s, poi failed". Al passo 4 osservare la coda per 10+ min, non 5.
10. **H.12 passo 3:** precisare che il limite riguarda la concorrenza (≤ 2 giri sovrapposti), non il numero totale di POST.
11. **B.3:** il banner dice "2 elementi da aggiornare" (credLock + MK-TITLE-BIG troppo grande), oppure togliere il big prima.
12. **B.4:** il titolo "201 + 409" va precisato. B fa una GET di pre-controllo e passa allo sblocco senza POST; il 409 si vede solo in una gara al millisecondo (unit test del backend).
13. **B.11:** allargare l'atteso: "oppure la schermata Vault bloccato (il Gate smonta il wizard)".
14. **B.12:** l'atteso "titoli originali decifrati" contraddice "LEAVE legacyPin" per le v2. Riallinearlo dopo la correzione di 2.4.
15. **I.8:** "nessuna versione nv3 nella cronologia" vale per la UI. Nel DB ne resta una, nascosta e non ripristinabile (D8, §5.10).
16. **K.3:** per un item UPDATE "title assente o vuoto", non "title `''`".
17. **E.4/E.5:** annotare che con `ceil` un tentativo entro 1 s dal blocco mostra "15:00" ("60:00", "1440:00").
18. **Note per chi ripete:**
    - B.6: corpi di almeno 150 caratteri nei seed, per `guardEmptyContentOverwrite`;
    - B.8/B.9: `page.close()` rilascia le route trattenute; serve `tokenVersion+1`;
    - M.4: uno stallo di `/migrate` oltre i 120 s del client si chiude con `drop()`, non con `release()`;
    - D.6/E.12: usare `clock.runFor`, non `fastForward`.

## 7. Stato di pulizia

- **Processi extra:** tutti fermati tramite i pid salvati, dopo il controllo del proprietario della porta.
  - alt :3002 e preview :4173/:4174 (L18);
  - Vite :5175 e worktree `D:/Develop/AI/Notiq-main` (L19, junction rimossa prima);
  - Chrome raw di L04/L05.
  - Le riprese L06 e L16 hanno riacceso e poi rispento sink e alt (pid 2584/442404 e 245956/346768).
- **Sink SMTP :2525:** fermato in L20 (pid 151376). Verificato ora: 2525, 3002, 4173, 4174 e 5175 sono libere.
- **Porte attive:** :3001 (pid 287860) `/health` 200, kill switch `'*'`, pepper originale; :5173 (pid 68980) 200.
- **Ripristini dell'ambiente:** :3001 è morto da solo tre volte, sempre senza errore nel log.
  - Run 1, ~12:19, L03: non ripristinato, run 1 in ENV_DOWN.
  - Run 2, 12:38:52, L03b: ripristinato una volta alle 12:40:25.
  - Run 2, 14:58:02, L06: ripristinato una volta alle 15:01:14 (pid 287860, log `D:/tmp/notiq-backend.150114.out.log`).
  - Da allora è rimasto stabile fino alla fine.
- **DB dev:**
  - nessun keyring RESET_PENDING;
  - `failedAttempts`/`lockedUntil` azzerati (4 contatori residui puliti in L20);
  - unico SUPERADMIN `superadmin@notiq.ai`;
  - locale di R0-R3/R1e riportati;
  - gli utenti di prova restano nel DB, elencati in `.state/users.json`, quasi tutti inutilizzabili.
- **File spuri:** i 26+2 file vuoti creati dall'hook in `frontend/manual-p2/` sono stati eliminati nella ripresa L16. Verificato ora: 0. La root del repo è pulita.
- **`frontend/manual-p2/`:** resta, non tracciata ed esclusa con `.git/info/exclude`, per eventuali riesecuzioni. Contiene `.state/users.json` con i Kit degli utenti di prova e non va committata. I pid in `.state` sono obsoleti.
- **`git -C D:/Develop/AI/Notiq status --porcelain`:** output vuoto, eseguito ora. Nessun file tracciato modificato. `git worktree list` mostra solo `D:/Develop/AI/Notiq d2e678d [feat/vault-p2]`.

## 8. Tabella finale

| ID | esito | nota breve |
|---|---|---|
| A.1 | PASS | Open (L01) e closed (L10): zero `/api/vault/*`, "Aggiungi" porta a "non disponibile" senza toccare la nota |
| A.2 | PASS | Bundle prod: 1 sola GET `all=1`, 62 righe synced, edit offline ok |
| A.3 | PASS | Kill switch chiuso, 503 dal modulo, Riprova senza reload; testo p6 da decidere (MINOR) |
| A.4 | PASS | Canary, lista con spazi, id errato, bench SUPERADMIN; "assente" via unit test |
| A.5 | PASS | READY lavora col kill switch chiuso: PUT nv3, Kit, cambio PIN, dispositivo B |
| A.6 | PASS | Pepper non valido: 503 `unavailable`, R1 sblocca offline, storage invariato |
| A.7 | PASS | Pepper diverso: `pepperMismatch`, nessun lockout, R1 offline ok |
| A.8 | PASS | RESET_PENDING: 422 `notReady`, nessun setup; item failed spurio (2.1) |
| A.9 | PASS | Slow 3G e offline senza setup; passo 4 su telefono all'utente |
| B.1 | PASS | Wizard 7/1/1, Q1-Q5 ok; credenziale bloccata "senza titolo" (MINOR) |
| B.2 | PASS | `pinHash` null; `searchText` in chiaro fino alla pull (MINOR) |
| B.3 | PASS | Riprova e PIN precedente ok; banner "2 elementi" (atteso da correggere) |
| B.4 | PASS | 2 dispositivi: un keyring, B senza Kit, somma riepiloghi 14 |
| B.5 | PASS | Lockout nel wizard, email, resume; note UX |
| B.6 | PASS | `flushTimeout` a 31 s, PUT in chiaro prima del POST `/keyring` |
| B.7 | PASS | Policy, password errata, doppi clic = 1 POST |
| B.8 | PASS | Finalize interrotta: lo sblocco porta `plain_v` a 0 |
| B.9 | PASS | Abbandono a Kit, migrate e setup: tutti recuperabili |
| B.10 | PASS | Altra scheda col lock: busy, poi chiusura riuscita |
| B.11 | PASS | Logout dall'altra scheda: Vault bloccato, nessuna `/migrate` |
| B.12 | FAIL | Credenziale legacy su B illeggibile, "Untitled", senza via d'uscita (MAJOR) |
| B.13 | FAIL | Edit v2 col bundle vecchio: nessuna copia, modifica invisibile (MAJOR); variante nota con copia senza titolo (MINOR) |
| B.14 | PASS | Nota legacy in sola lettura, uscita dal vault ok |
| B.15 | PASS | Cestino e notFound ok; allegato non segnalato (MINOR) |
| B.16 | FAIL | PUT automatica all'apertura di RAW (2.1, MINOR qui) |
| C.1 | PASS | Marker prima del Kit, payload senza PIN |
| C.2 | PASS | Tabella di 15 casi, 0 POST sui rifiuti |
| C.3 | PASS | Troncamento a 6 caratteri (UX da decidere) |
| C.4 | PASS | Attributi ok; password alfanumerica diventa PIN; gestore password all'utente |
| C.5 | PASS | 5 x 403 e poi 429, password svuotata, poi 201 col contatore azzerato |
| C.6 | PASS | 201 perso; testo "altro dispositivo" da decidere |
| C.7 | PASS | Doppi clic = 1 POST e 1 Kit |
| C.8 | PASS | 409 al perdente, 1 riga |
| C.9 | PASS | Share solo con la casella; default OFF da decidere |
| C.10 | PASS | Worker, errore e riprova; manca `kdfFailed`; tempi Android all'utente |
| C.11 | PASS | Bench su PC ed emulazione; worker non terminato all'uscita (NIT); Android all'utente |
| D.1 | FAIL | Codice del Kit senza nome accessibile (MINOR) |
| D.2 | SIMULATO | Copia ok; permesso negato via stub; Android all'utente |
| D.3 | PASS | PDF A4 Courier-Bold in 7 percorsi; stampa e Android all'utente |
| D.4 | PASS | Varianti A-E, banner `kitUnconfirmed`; iOS all'utente |
| D.5 | PASS | Marker cancellato in silenzio |
| D.6 | PASS | Kit aperto 12 min (runFor e Chrome nascosto reale): mai bloccato; Android all'utente |
| D.7 | PASS | Rigenerazione con lockout al 6° tentativo |
| D.8 | PASS | 409 e una sola rigenerazione |
| D.9 | PASS | Cambio PIN durante la cerimonia |
| E.1 | PASS | Sblocco 430 ms, `no-store` |
| E.2 | PASS | "PIN dimenticato"; link assente nel dialog |
| E.3 | PASS | Doppio invio = 1 POST |
| E.4 | PASS | Lockout al 6°, conto alla rovescia, email IT, scadenza |
| E.5 | PASS | 1 h / 24 h / tetto 24 h, un'email per soglia; formato `1439:57` |
| E.6 | FAIL | Il lockout online disabilita lo sblocco offline (MINOR) |
| E.7 | OSSERVATO | Prod: /vault sbloccata; dopo la visita il PIN viene richiesto (atteso da correggere) |
| E.8 | PASS | Emulazione; tastiera e tempi reali all'utente |
| E.9 | PASS | Diretto (L15) e proxy 500 (L18): niente reset, contatore invariato; 502 IIS all'utente |
| E.10 | PASS | Ripiego offline R1, errore di rete R2 |
| E.11 | PASS | Share intatto in 4 varianti |
| E.12 | PASS | Auto-lock 10 min; la rotellina non azzera il timer (UX) |
| E.13 | PASS | Chrome nascosto: bloccato a 600 s; freeze: 154 ms visibili; Android all'utente |
| E.14 | PASS | Uscite entro 500 ms senza perdita |
| E.15 | PASS | Doppio "Blocca" |
| E.16 | PASS | Logout con modifica pendente |
| E.17 | PASS | 401 `tokenVersion` senza loop |
| E.18 | PASS | Finestra di 1 s persa (accettata), uguale alle note normali |
| F.1 | PASS | Titolo e corpo mai in chiaro |
| F.2 | PASS | Titolo decifrato su B, ordinamento ok |
| F.3 | PASS | Lock shared ed exclusive, offline integro |
| F.4 | PASS | `notLoaded` + Riprova, nessuna PUT vuota; PUT spuria all'apertura (2.1) |
| F.5 | PASS | Si chiude alla pull; percorso `itemNotFound` assente (atteso da correggere, NIT) |
| F.6 | FAIL | Riga locale corrotta non si autoripara (MINOR) |
| F.7 | PASS | Riclassificato: T8 guarda il server (atteso da correggere); vuoto di fondo = F.6 |
| F.8 | PASS | Eliminazione definitiva con cascade; ghost da PUT spuria in un giro (2.1) |
| F.9 | OSSERVATO | Nota fissata in sidebar "Untitled Note" (MINOR) |
| F.10 | PASS | Promemoria ok; selettore in UTC (MINOR); `showPicker` all'utente |
| F.11 | PASS | Tag vault separati |
| F.12 | PASS | `tooLarge` senza PUT, poi ripresa |
| F.13 | OSSERVATO | Allegati/AI assenti; drop non bloccato (MAJOR condizionato); immagine remota (MINOR) |
| F.14 | PASS | Correzione 41df578 verificata, controprova su nota normale |
| F.15 | OSSERVATO | Dettatura presente, nessun plaintext (accettato dall'utente) |
| F.16 | PASS | Credenziale cifrata; URL ai metadati accettato; prompt Chrome all'utente |
| F.17 | PASS | Appunti puliti a ~33 s col focus, fallimento silenzioso senza focus; Win+V all'utente |
| F.18 | PASS | Ricerca locale, 0 richieste, niente vault in Ctrl+K |
| F.19 | PASS | Versioni nv3, restore 422, cascade |
| F.20 | PASS | 422 su plaintext/stale/conflict; replay idempotente annotato |
| F.21 | PASS | Riclassificato: passo 5 = T6 REENCRYPT_TITLE (atteso da correggere) |
| F.22 | PASS | `VaultPlaintextGuardError` 3/3 |
| F.23 | OSSERVATO | Doppio clic crea 2 item (MINOR) |
| G.1 | PASS | PC ed emulazione offline; modalità aereo reale all'utente |
| G.2 | PASS | API bloccate + reload: READY dalla cache, ripiego offline |
| G.3 | PASS | Switch offline passi 1-8; TalkBack/VoiceOver all'utente |
| G.4 | PASS | t=4 PIN errato; m=1024 "Qualcosa è andato storto"; online riscrive kdf |
| G.5 | PASS | 3 edit + nota nuova offline, push senza duplicati (emulazione) |
| H.1 | PASS | Una copia in conflitto (en e it) |
| H.2 | FAIL | Copia assente dopo 196 s in 3 casi su 5 (MAJOR) |
| H.3 | PASS | 422, banner, nessun loop; Riprova inefficace, testo del toast (MINOR) |
| H.4 | SIMULATO | Risposta persa con fwd-drop/latenza: nessuna copia |
| H.5 | PASS | Copia con id coerente dopo la riapertura |
| H.6 | PASS | Proxy (L18) backoff 5/15/45/135 s; diretto (L15) = atteso da correggere; 502 IIS all'utente |
| H.7 | FAIL | Web Lock corretti, ma copia spuria da sola lettura (2.1, MAJOR) |
| H.8 | PASS | Ripresa: max 1 422 per scheda; perdita di t2 da decidere |
| H.9 | FAIL | Ripresa: flusso principale ok, variante senza scrittura crea una copia (2.1, MAJOR) |
| H.10 | PASS | Eliminata da B: copia, nessuna ricreazione |
| H.11 | PASS | Senza `navigator.locks`: REQUEUE, poi copia al reload |
| H.12 | PASS | Ripresa: concorrenza max 1; 429 gestito; ARR all'utente |
| H.13 | PASS | Credenziale mostra il valore vecchio, poi copia (MINOR UX) |
| H.14 | PASS | Blocco, logout e rimozione cross-tab |
| H.15 | SIMULATO | Bundle vecchio simulato; dopo lo sblocco lo switch offline torna OFF |
| I.1 | PASS | Testo appena scritto incluso, Q6 ok, versioni in chiaro 0 |
| I.2 | PASS | Condivisa/pubblica revocata, WS chiusa; titolo nelle `Notification` (MINOR) |
| I.3 | PASS | NONE, legacy, READY bloccato: nessuna PUT `isVault` senza sblocco |
| I.4 | PASS | 5 rami di errore, nessuna nota a metà |
| I.5 | PASS | CAS: retry e massimo 3 PUT |
| I.6 | PASS | Doppio clic e remount: 1 PUT, editor congelato |
| I.7 | SIMULATO | Rami applicata/non applicata con fwd-drop |
| I.8 | PASS | Uscita in chiaro; nv3 nascosta (by design); testo offline scartato (MINOR) |
| I.9 | FAIL | Dopo un 422 riapertura stantia, poi copia senza modifiche (2.1, MAJOR) |
| I.10 | PASS | B con editor aperto: 1 copia con MK-B-LATE |
| I.11 | PASS | Credenziale senza comando; offline e server giù bloccati |
| J.1 | PASS | Cambio PIN, nessun segreto in rete, escrow invariato |
| J.2 | PASS | Errori, policy, offline, lockout, email |
| J.3 | PASS | Marker pending: PIN vecchio valido, poi PIN nuovo attivo |
| J.4 | PASS | Esito corretto; race 2 flussi, rev +2 (MINOR) |
| J.5 | PASS | B offline col PIN1, online col PIN2, cache aggiornata |
| J.6 | OSSERVATO | Vecchio PIN valido offline dopo 62 s online: testo fuorviante (MINOR) |
| J.7 | PASS | Guardia e rimozione completa; "Untitled" fino al reconcile (MINOR) |
| J.8 | PASS | "Come funziona", link, doppio clic = 1 dialog |
| J.9 | PASS | "Controlla ora" e legacy residuo |
| K.1 | PASS | `api-cache` pulita, `no-store`, nessun segreto nel dump |
| K.2 | PASS | Logout e sblocco svuotano `api-cache` |
| K.3 | PASS | Offline nel bundle prod: Worker dal SW, coda nv3, push |
| K.4 | PASS | Predicato inline, precache con bench e worker |
| K.5 | PASS | Purge per versione simulato; rollout reale all'utente |
| L.1 | PASS | 201 + 409, 1 riga |
| L.2 | PASS | `[ok, conflict]`, poi `[already, already]` |
| M.1 | PASS | LAN insicura: riquadro del bench; nessun avviso su /vault (NIT); telefono all'utente |
| M.2 | PASS | Foglio del Kit a 412/375/320 px, rotazione, PDF; tastiera all'utente |
| M.3 | PASS | Header a 44 px, VaultNotLoaded dark (ripresa); altri target sotto 44 (MINOR) |
| M.4 | PASS | Wizard con CPU lenta senza auto-lock; titoli progressivi (NIT); Android all'utente |
| M.5 | FAIL | ConfirmDialog 40 px, X 20 px (MINOR) |
| M.6 | PASS | Dark completo; toast 2,54:1 (MINOR); tema sistema (NIT) |
| M.7 | OSSERVATO | 0 chiavi grezze, email localizzata; plurali n=1 (NIT) |
| N.1 | PASS | Q7 = 10, tutte eccezioni ammesse (8 L2 sintetici + 2 B.16 F) |
| N.2 | PASS | Pulizia completa, :3001 `'*'`, git pulito |
| N.3 | FAIL | Test, tsc e build verdi; lint backend rosso in `ydoc.ts`, preesistente (MINOR); prod all'utente |
| N.4 | UTENTE | Bundle servito in prod |
| N.5 | UTENTE | Bench su iPhone e PWA in prod |
| N.6 | UTENTE | Canary in prod, punto di non ritorno |
| N.7 | UTENTE | Passi successivi del runbook in prod |
| N.8 | UTENTE | Sospensione iOS |
| N.9 | UTENTE | iOS: blob, swipe, portachiavi iCloud |

---
Tre limiti di questa sintesi:
- Le evidenze non le ho riaperte una per una: mi baso su quanto dichiarato dai lotti e dai verificatori. Ho rifatto io solo `git status`, il controllo delle porte e il conteggio dei file vuoti.
- La gravità MAJOR di F.13 dipende dalla prova manuale del drag da Esplora file.
- Quattro dei cinque difetti MAJOR richiedono modifiche a file TIER 1, quindi la spec va cambiata prima del codice.