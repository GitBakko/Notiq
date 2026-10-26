# Vault P2: piano di correzione dei MINOR residui (26/10/2026)

## 1. Testata

- **Data:** 26/10/2026.
- **Branch:** `feat/vault-p2`. **HEAD:** `6f28600`. I numeri di riga citati valgono per questo HEAD.
- **Stato:** piano approvato nei contenuti dall'utente (correggere tutto). Implementazione NON iniziata.
- **Fonti:**
  - `docs/superpowers/plans/2026-10-24-vault-p2-autotest-report.md` (run del 24/10).
  - `docs/superpowers/plans/2026-10-24-vault-p2-retest-report.md` (rilancio del 24/10, con l'aggiornamento su `TransformToKanbanModal`).
  - Run di pianificazione `wf_78471663-45f`: 6 piani dell'architect e 6 critiche avversariali, uno per gruppo (I8, F10, H3J7, VUI, A11Y, TKM). Output completo: `C:\Users\bakko\AppData\Local\Temp\claude\D--Develop-AI-Notiq\92f93dd6-5a41-4089-aebe-2adbfc44551d\tasks\w0q0vodl2.output`.
- **Regole che valgono per tutto il piano:**
  - I file TIER si cambiano solo dopo l'approvazione esplicita dell'utente, con il tool Edit (hook `tier1-guard`), mai con `git apply`.
  - Ogni correzione qui sotto ha già dentro le modifiche richieste dalla critica. Dove ho aggiunto qualcosa di mio lo scrivo ("integrazione del 26/10").
  - Le prove in `frontend/manual-p2/` sono locali: la cartella è ignorata da git. Le modifiche a quegli spec non finiscono nei commit.
  - Nessuna voce è "da riprogettare". Nessuna critica ha dato `wrong`. Tutti i MAJOR trovati si risolvono dentro questo piano.

## 2. Tabella di sintesi

| Voce | Difetto confermato? | File (TIER) | Verdetto della critica | Decisione utente? |
|---|---|---|---|---|
| I.8 | Sì. Testo scritto offline scartato in silenzio dal guard dei 150 caratteri | `note.service.ts` (no), `en.json`/`it.json` (no), `syncService.ts` (**TIER1**, opzionale), `sharing.service.ts` (no, opzionale) | ok-with-changes, 2 MAJOR integrati | Sì: D1, D2, D3, D4 |
| F.10 | Sì. Il selettore del promemoria mostra l'ora UTC (solo visualizzazione) | `format.ts`, `NoteEditor.tsx`, `VaultNoteEditor.tsx` (no) | ok-with-changes, solo MINOR | No |
| H.3 | Sì. Il toast dice "usa Riprova", ma Riprova salta gli item `vault:*` | `SyncStatusIndicator.tsx`, `en.json`/`it.json` (no) | ok-with-changes, solo MINOR | Sì: D5 |
| J.7 | Sì. Dopo "Rimuovi dal dispositivo" e lo sblocco, la lista resta "Untitled" | `VaultPage.tsx`, spec T15 (no) | ok-with-changes, 1 MAJOR sul test integrato | No |
| H.13 | Sì. La credenziale già caricata mostra il valore vecchio | `CredentialForm.tsx` (no) | ok-with-changes, solo MINOR | No |
| A.3 | Sì. L'utente legacy a kill switch chiuso vede il testo corto | `VaultPage.tsx`, `en.json`/`it.json` (no) | ok-with-changes, solo MINOR | Sì: D6 |
| B.5 | Sì. Nel wizard il PIN errato resta e il lockout non ha countdown | `VaultMigrate.tsx` (no) | ok-with-changes, 1 MAJOR sui test risolto | No |
| B.11 | No. È il comportamento progettato | nessuno | ok | Sì: D7 |
| B.15 | Sì. Il riepilogo del wizard non segnala gli allegati | `vault.service.ts`, `vaultMigration.ts`, `VaultMigrate.tsx`, `en.json`/`it.json` (no) | ok-with-changes, solo MINOR | Sì: D8 |
| M.3 | Sì. Target sotto 44 px su lista vault e form credenziale | `VaultPage.tsx`, `SortDropdown.tsx`, `CopyButton.tsx`, `CredentialForm.tsx` (no) | ok-with-changes, solo MINOR | Sì: D9 |
| M.5 | Sì. Pulsanti della ConfirmDialog a 40 px, X a 20 px e 2,56:1 | `ConfirmDialog.tsx`, `Dialog.tsx` (no) | ok-with-changes, solo MINOR | Sì: D10 |
| M.6 | Sì. Toast 2,54:1, testi neutral-400 2,56:1, tema di sistema che non segue l'OS | `App.tsx`, `CredentialForm.tsx`, `CredentialCard.tsx`, `uiStore.ts` (no) | ok-with-changes, 1 MAJOR (dark mode) integrato | Sì: D11 |
| Contrasti di NoteEditor | Sì. Icone 2,56:1, stati attivi 2,07-2,41:1, hover senza `dark:` | `NoteEditor.tsx` (no; `Editor.tsx` è TIER2 e non si tocca) | ok-with-changes, 1 MAJOR (criterio) integrato | Sì: D12 |
| TransformToKanbanModal | Sì, ma latente (LOW): oggi non si raggiunge dall'interfaccia | `TransformToKanbanModal.tsx` (no) | ok-with-changes, 1 MAJOR (test) integrato | Sì: D13 |

## 3. Decisioni che spettano all'utente

Ogni decisione ha le opzioni e una raccomandazione. Le raccomandazioni tengono conto della critica.

**D1. I.8, testo del toast `sync.contentDeferred`.** Il toast ora vale anche per lo scarto del guard, non solo per la sessione live.
- A (raccomandata, nessun file TIER): un testo generico che regge anche quando non si archivia nulla.
  - EN: "Your changes could not replace this note's current content. Any text you wrote is in its version history."
  - IT: "Le tue modifiche non hanno sostituito il contenuto attuale della nota. Il testo scritto è nella cronologia delle versioni."
- B: un flag nuovo `contentGuarded` con una chiave propria. Richiede di toccare `syncService.ts` (TIER1).
- Effetto collaterale di A: cambia anche il testo del caso "sessione live condivisa" (oggi `en.json:1366`, `it.json:990`).

**D2. I.8, correzione del pull al passaggio vault→normale (`syncService.ts`, TIER1).** Il diff esatto è nella sezione 4.
- a: non applicarla ora. La correzione server basta a evitare la perdita silenziosa. Però l'editor di B torna al testo del server e MK-B-OFFLINE resta solo nella cronologia. Inoltre un testo lungo scritto offline sovrascrive il server senza avviso (resta recuperabile dalla cronologia grazie al punto (d) di I.8).
- b (raccomandata, cambiata dalla critica): applicarla ora, insieme alla correzione server. Con il corpo vero in Dexie, B scrive in coda ai 323 caratteri, il guard accetta e il server riceve il testo completo con MK-B-OFFLINE.
- Ho verificato il motivo: `NoteEditor.tsx:146-150` fa `setContentInput(note.content)` senza guardia di dirty. Dopo `handleContentDeferred` (`syncService.ts:715-745`) l'editor mostra il testo del server.

**D3. I.8, niente snapshot delle versioni `nv3.` (punto d).**
- Sì per tutte le note vault (raccomandato). La UI non le mostra (§5.10 del piano P2) e non sono ripristinabili.
- In alternativa, solo per l'uscita dal vault. Resta però occupato lo slot di throttle dalla PUT `nv3.` precedente.

**D4. I.8, stesso difetto in `sharing.service.ts:860-882` (PUT REST del collaboratore WRITE).** Il guard scarta il testo corto e la risposta è 200.
- a (raccomandata): includerlo ora, solo backend. Si archivia il testo scartato con rethrow, come a `sharing.service.ts:890-899`. Niente flag nella risposta: il client lo ignorerebbe, perché `saveSharedNoteData` (`frontend/src/features/notes/noteService.ts:231-233`) non legge la risposta. Il testo resta recuperabile dalla cronologia, ma il collaboratore non vede un toast.
- b: aprire una voce separata con riferimento a I.8.
- Nota: la critica proponeva anche il flag nella risposta. Ho verificato che sul client non servirebbe senza una modifica in più al frontend. Per questo lo tolgo.

**D5. H.3, testo e comportamento del banner.**
- A: cambia solo il testo del toast e lascia Riprova, che resta inefficace.
- B (raccomandata): toast dedicato. Quando tutti gli item falliti sono `vault:*`, il banner mostra un testo proprio e non ha Riprova.
- C (sconsigliata): Riprova lancia il reconcile. Con la nota aperta il giro risponde LATER (`vaultReconcile.ts:193`), a vault bloccato SKIP (`:191`).
- Testi proposti per B (senza la promessa "si sistemano da sole", come chiede la critica):
  - `sync.vaultFailedToast` IT: "Alcune modifiche del vault sono in attesa di riconciliazione. Riprova non le riguarda: si risolvono allo sblocco del vault, alla chiusura della nota o con «Controlla ora» nelle impostazioni del vault."
  - `sync.vaultFailedToast` EN: "Some vault changes are waiting to be reconciled. Retry does not apply to them: they are resolved when you unlock the vault, close the note, or use \"Check now\" in the vault settings."
  - `sync.vaultFailed` IT: "{{count}} modifiche del vault in attesa". EN: "{{count}} vault change(s) waiting" (stesso stile di `sync.failed`, `en.json:1359`).

**D6. A.3, testo per l'utente legacy a kill switch chiuso.**
- a (raccomandata): IT "Il nuovo vault sarà disponibile a breve. Fino ad allora il tuo vault non è accessibile da questa versione." EN "The new vault will be available soon. Until then your vault can't be opened from this version."
  - Aggiunta facoltativa: IT "I contenuti restano intatti." EN "Its contents stay intact." È vero lato server (le righe legacy non si toccano), ma è una promessa in più rispetto al piano. Non scrivere "al sicuro": i dati legacy non sono E2EE.
- b: il testo letterale del piano: "Il nuovo vault sarà disponibile a breve; finora il tuo vault non è accessibile da questa versione".
- c: tenere il testo corto per tutti e chiudere la voce come accettata.

**D7. B.11, avviso sulla schermata di sblocco quando la migrazione si interrompe per un blocco.**
- a (raccomandata): nessuna modifica. La voce si chiude come accettata. Il banner `legacyLeft` dopo lo sblocco guida già la ripresa.
- b: un avviso su `VaultUnlock`. La critica nota che costa più dei "2 file" del piano: oggi `VaultPage` non conosce la fase del wizard al momento dello smontaggio.

**D8. B.15, testo dell'avviso sugli allegati.**
- a (raccomandata, testo neutro della critica): IT "{{n}} note hanno allegati: gli allegati non sono cifrati e non compaiono nel vault." EN "{{n}} notes have attachments: the attachments are not encrypted and are not shown in the vault."
  - Motivo: il contatore conta tutta la coda di `listLegacy`, non solo le note migrate. La frase del piano ("il testo ora è cifrato") sarebbe falsa per le note finite in locked, tooLarge o failed.
- b: il testo del piano, contando solo le note migrate (più codice).
- c: elencare i titoli delle note (più codice).
- d: aggiungere "Per vederli sposta la nota fuori dal vault". Non verificato nel codice: non va scelto senza una verifica.

**D9. M.3, chip dei filtri e reset `md:`.**
- Chip: A (raccomandata) pillola alta 44 px. B pillola da 25 px con area di tocco allargata da uno pseudo-elemento (più fragile).
- Reset `md:min-h-0`: la critica raccomanda di non metterlo sul pulsante di ordinamento (44x44 sempre). `frontend/CLAUDE.md:12` chiede 44x44 per ogni elemento interattivo, e `md:` (768 px) è il tablet touch (`frontend/CLAUDE.md:23`).
- Raccomandazione: 44 px sempre, senza reset, sia sui chip sia sull'ordinamento. Alternativa: tenere il reset solo sui chip, per lasciare compatta la riga su desktop.

**D10. M.5, dove applicare i 44 px dei pulsanti.**
- A: `Button.tsx` md da `h-10` a `h-11`. Cambia l'altezza dei pulsanti in tutta l'app: regressione visiva ampia.
- B (raccomandata): solo `ConfirmDialog` e la X di `Dialog`, a tutte le larghezze (+4 px su desktop).
- C: come B, ma solo su mobile (`sm:min-h-0`). Una classe in più, nessun vantaggio reale.
- Sotto-decisione: estendere B anche a `DeleteConfirmationDialog.tsx:63,66` e `InputDialog.tsx:61,64`, che hanno lo stesso `<Button>` da 40 px. Raccomandato sì: due classi per file.

**D11. M.6, tono del link "Rifai screenshot" (`CredentialForm.tsx:601`).**
- `text-neutral-500` (raccomandato): 4,55:1 su `bg-neutral-50`. È lo stesso colore delle etichette accanto (`:594`).
- `text-neutral-600`: 6,5:1, più margine, ma più scuro delle etichette.

**D12. Contrasti di NoteEditor.**
- Tono degli stati attivi di pin e promemoria: A (raccomandata) `amber-600`, 3,07:1, vicino al colore attuale. B `amber-700`, 4,84:1, ma vira al marrone.
- Allineare anche HardDrive `:690`, History `:700` e Sparkles inattivo `:719` a `text-neutral-500 dark:text-neutral-400`. Raccomandato sì: senza, nella stessa barra restano due grigi diversi.
- Allineare anche `VaultNoteEditor.tsx:309` e `:341`, che ripetono lo stesso schema `amber-500` / `neutral-400`. Raccomandato sì: due righe, stesso fix.

**D13. TransformToKanbanModal.**
- A (raccomandata): applicare l'irrobustimento. Un file fuori TIER, circa 10 righe, più un test unitario.
- B: chiudere la voce come non riproducibile, con un commento `ponytail:` alle righe 47-62.

## 4. File TIER coinvolti

Un solo file TIER è coinvolto, ed è **opzionale**: dipende da D2.

### `frontend/src/features/sync/syncService.ts` (TIER1), solo se D2 = b

- **Motivo:** la lista `GET /notes` non porta il content. Al passaggio vault→normale il pull scrive la riga con `content: n.content ?? ''` (`:204`). Su B la nota resta vuota offline. Il diff legge il content una volta sola, solo per queste righe.
- **Verifiche fatte sul codice:**
  - `vaultFlips` riceve righe con content `''` a `:204`.
  - Il ciclo di `:225` gira fuori dalla transazione Dexie, chiusa a `:221`.
  - `api` è già importato (`:2`).
  - In caso di errore il `catch` lascia `''`, come oggi.
  - Il ciclo tocca solo le righe che escono dal vault (`!n.isVault`). Le righe che entrano nel vault restano come sono.
- **Diff esatto (righe 225-226).**

OLD:
```ts
      for (const n of vaultFlips) {
        const apply = () => db.transaction('rw', db.notes, async () => {
```

NEW:
```ts
      for (const n of vaultFlips) {
        // I.8: GET /notes omits content; a note leaving the vault would land as '' (empty offline). Fetch it once.
        if (!n.isVault && !n.content) {
          try {
            const { data } = await api.get<{ content?: string }>(`/notes/${n.id}`);
            if (typeof data?.content === 'string') n.content = data.content;
          } catch { /* offline/404: keep '' as before; the editor loads it when online */ }
        }
        const apply = () => db.transaction('rw', db.notes, async () => {
```

- È un'aggiunta pura. Non serve il commento `// [BACKUP]`.
- **Procedura:** mostrare il diff all'utente, attendere la conferma esplicita, applicarlo con Edit. Il gate lo tratta come `hardRisk` (addendum Notiq): servono `reviewer` e `red-team` in parallelo.

### File TIER vicini che NON si toccano

- `frontend/src/components/editor/Editor.tsx` (TIER2): monta `TransformToKanbanModal` (`:625-632`, `:674-681`), ma il fix sta tutto nel modale.
- `frontend/src/lib/vaultReconcile.ts` (TIER1): B.15 non cambia `ServerItem` e usa un cast locale. H.13 importa solo `hydrateVaultNote`.
- `backend/src/hocuspocus.ts` (TIER1): `store()` usa lo stesso guard di I.8. È fuori da questo piano: va aperta una voce separata.
- `frontend/src/lib/db.ts` (TIER1): nessuna versione nuova.

## 5. Voci

### I.8: testo scritto offline scartato in silenzio dopo l'uscita dal vault

**Causa verificata.**
1. `GET /notes` non restituisce il content. Al passaggio vault→normale il pull scrive la riga con content `''` (`frontend/src/features/sync/syncService.ts:204`, applicata a `:225-232`). Su B la nota resta vuota e `synced` (evidenza `dexieB_dopoPull`: sha256 della stringa vuota).
2. B, offline, scrive MK-B-OFFLINE. La coda contiene una sola PUT di 142 caratteri (non "92 e 142", come diceva il piano).
3. `updateNote` non è più sul percorso vault, quindi `guard` è null (`backend/src/services/note.service.ts:229`). A `:370` parte `guardEmptyContentOverwrite` (`backend/src/utils/contentGuard.ts:15-20`, soglia 150): 142 < 150 e 323 > 150, quindi il content non si scrive. Non parte lo snapshot (`:411-413`) e non parte l'archivio (`:449`: `liveArchiveContent` resta undefined). Con il doc live (`routeLive`) succede lo stesso.
4. La route risponde `{ message: 'Note updated' }` senza flag (`backend/src/routes/notes.ts:87`). Il client segna `synced` e toglie l'item. La pull conserva la content locale (`syncService.ts:213`), quindi B diverge per sempre.
- Rischio collegato: lo snapshot della PUT di uscita archivia l'envelope `nv3.` e occupa la finestra di throttle di 2 minuti dello stesso writer (`backend/src/services/noteVersion.service.ts:64-68`, `:90-92`).

**Correzione finale** (piano dell'architect + modifiche della critica + una integrazione del 26/10).

In `backend/src/services/note.service.ts`:
- (a) Accanto a `:323-324`: `let guardDropped = undefined as string | undefined;`.
- (b) Dentro il blocco `if (contentField !== undefined)` di `:368-371`, dopo l'assegnazione del guard: `guardDropped = finalContent === undefined ? contentField : undefined;`. Va dentro il blocco, non dopo (critica).
- (c) Dopo la transazione, subito dopo il ramo live (`:449-458`) e prima del ramo m3 (`:459`), un nuovo ramo:
  ```ts
  } else if (guardDropped !== undefined && plain) {
    try {
      await archiveRestWriteWhileLive(id, guardDropped, updated.title, userId, sessionKey);
    } catch (err) {
      logger.error({ err, noteId: id }, 'updateNote: REST content not archived after the empty-overwrite guard');
      throw err;
    }
    // Same rule as the live path (H4): the server did not apply this content, whatever the archive outcome.
    contentDeferred = true;
  }
  ```
  - Il flag è **incondizionato** (anche con `'skipped'` e `'identical'`), come a `:456-458` e nel test `note.service.test.ts:643-650`. Così il client riallinea Dexie anche quando il guard scarta un doc vuoto, e B non resta con la nota vuota. La protezione dell'incidente 06/2026 non dipende dal flag: il server rifiuta comunque la scrittura.
  - **Integrazione del 26/10: `&& plain`** (`plain` è definito a `:329`). Per una nota non `plain` (per esempio cifrata legacy) il content non è JSON TipTap, quindi l'archivio risponde `'skipped'` (`noteVersion.service.ts:136-141`). Con il flag il client riallineerebbe Dexie e cancellerebbe l'unica copia del testo. Per le note `plain` invece `'skipped'` vuol dire solo doc vuoto o degenere: non c'è nulla da perdere. Le note non `plain` mantengono il comportamento di oggi.
- (d) A `:411`: `if (finalContent !== undefined && finalContent !== note.content && parseEnvelope(note.content) === null)`. `parseEnvelope` è già importato (`:11`) ed è null-safe. Dipende da D3.
- (e) Testo i18n di `sync.contentDeferred` in `en.json:1366` e `it.json:990` secondo D1.
- (f) Opzionale, D2: diff TIER1 della sezione 4.
- (g) Opzionale, D4: in `backend/src/services/sharing.service.ts`, quando il content è presente ma `accepted === undefined`, archiviare `data.content` riusando il blocco esistente di `:890-899` (archivio con rethrow). Nessun flag nella risposta.

Le righe `nv3.` già nel DB restano finché la nota non riceve uno snapshot o un archivio nuovo: il prune gira solo in scrittura (`noteVersion.service.ts:117`, `:203`). Sono ciphertext e nascoste, quindi è innocuo. La nota del retest (~riga 242, "la versione nv3 resta nel DB") resta "accettato".

**File e modifiche.**
- `backend/src/services/note.service.ts`: punti (a)-(d).
- `backend/src/services/__tests__/note.service.test.ts`: test nuovi e test di `:625` aggiornato.
- `frontend/src/locales/en.json`, `frontend/src/locales/it.json`: testo di D1.
- `frontend/e2e/vault-offline.spec.ts`: test nuovi.
- Se D2 = b: `frontend/src/features/sync/syncService.ts` (TIER1) e `frontend/src/features/sync/__tests__/syncService.test.ts`.
- Se D4 = a: `backend/src/services/sharing.service.ts` e `backend/src/services/__tests__/sharing.service.test.ts`.
- Solo locale: `frontend/manual-p2/lotto-R07g-out.spec.ts`.

**Criteri di accettazione.**
1. PUT su una nota normale non live con content di 323 caratteri e content nuova corta non degenere: `Note.content` invariata, esiste una `NoteVersion` con la content corta, la risposta è `{ message, contentDeferred: true }`.
2. PUT con doc degenere (`{"type":"doc","content":[]}`) su content sostanziosa: content invariata, nessuna `NoteVersion` nuova, risposta **con** `contentDeferred: true` (cambiato dalla critica).
3. Se `archiveRestWriteWhileLive` lancia un errore, la PUT risponde 5xx e l'item resta nella syncQueue.
4. Nota cifrata non `plain` con guard che scarta: archivio non chiamato, nessun flag (integrazione del 26/10).
5. Uscita dal vault, poi una PUT lunga entro 2 minuti: esiste una `NoteVersion` in chiaro con il testo precedente. La PUT di uscita non crea versioni `nv3.`: `SELECT count(*) FROM "NoteVersion" WHERE content LIKE 'nv3.%' AND "noteId"=<id>` non cresce.
6. Se D2 = b: dopo l'uscita su A e la pull su B, la riga Dexie di B ha il content completo. B offline aggiunge MK-B-OFFLINE e, tornato online, il server ha il corpo completo con MK-B-OFFLINE in coda. Nessun toast.
7. Se D2 = a: su B compare il toast, la cronologia contiene MK-B-OFFLINE, l'editor di B mostra il testo del server e Dexie si riallinea.
8. `cd backend; npx vitest run src/services/__tests__/note.service.test.ts src/routes/__tests__/notes.route.test.ts` verde, poi `npm test` verde.
9. `cd frontend; npx tsc -p tsconfig.app.json --noEmit` verde, `npx vitest run src/features/sync` verde, `npm run lint` a 0 errori.

**Test unit.**
- `note.service.test.ts`: nota plain, old `'X'.repeat(200)`, PUT corta non degenere. `update.data` senza content. `archiveRestWriteWhileLive` chiamata con `(id, short, title, 'user-1', sessionKey)`. Risultato con `contentDeferred: true`.
- `note.service.test.ts`: archivio che risolve `'skipped'` (doc degenere): risultato **con** `contentDeferred: true`. Il test di `:625` si aggiorna: archivio chiamato e `toMatchObject({ contentDeferred: true })`.
- `note.service.test.ts`: archivio rifiutato sul percorso guard: `rejects` e `logger.error` con `'REST content not archived'`.
- `note.service.test.ts`: doc live con content corta su content sostanziosa: archiviata e `contentDeferred` (oggi è muta).
- `note.service.test.ts`: nota `isEncrypted` con guard che scarta: archivio non chiamato, nessun flag (integrazione del 26/10).
- `note.service.test.ts`: uscita con guard (`note.content` `'nv3.0.…'`, `isVault: false`, content in chiaro, `baseHash`): `snapshotPreviousVersion` non chiamata. Nota normale: chiamata, come a `:492`.
- Se D2 = b, `syncService.test.ts`: pull con passaggio vault→normale chiama `GET /notes/:id` e la riga Dexie ha la content del server. Con la GET che fallisce la content resta `''`.
- Se D4 = a, `sharing.service.test.ts`: collaboratore con testo corto su content sostanziosa: archivio chiamato. Archivio rifiutato: `rejects`.
- Copertura esistente del client: `frontend/src/features/sync/__tests__/syncService.test.ts:1158-1290` (non `collaboration.spec.ts`, che testa solo il restore).

**Test E2E e Playwright eseguibili in autonomia.** Servono backend :3001 con `VAULT_SETUP_USERS=*` e Vite :5173.
- `npx playwright test e2e/vault-offline.spec.ts`, test di uscita. A e B sono due context dello stesso utente. Nota S nel vault con più di 150 caratteri. A esegue "Rimuovi dal Vault". B attende la pull, poi `context.setOffline(true)`, apre S e scrive MK-B-OFFLINE, poi `setOffline(false)`.
  - Se D2 = b: assert del criterio 6. Si controlla anche quello che l'utente vede: l'editor di B mostra il corpo completo con MK-B-OFFLINE.
  - Se D2 = a: assert del criterio 7. In più: un testo scritto su B dopo il ritorno online, prima della risposta della PUT, finisce comunque in cronologia.
- Test del guard, proposta del 26/10 da adattare: serve se D2 = b, perché il flusso di uscita non passa più dal guard. Nota normale con più di 150 caratteri. Su B si forza via `page.evaluate` la riga Dexie a content `''` (simula il corpo vuoto). Poi B va offline, scrive un testo corto e torna online. Assert: toast, `GET /api/notes/<id>/versions` contiene il testo, `GET /api/notes/<id>` invariato, editor e Dexie di B riallineati.
- Locale: `frontend/manual-p2/lotto-R07g-out.spec.ts`. Oggi controlla solo `recoverable` (`:117-119`) e passa anche col codice vecchio. Va aggiunto `ck('MK-B-OFFLINE in cronologia', versHas(S2,'MK-B-OFFLINE') > 0)` se D2 = a, oppure il controllo del server se D2 = b. Senza questa modifica il rilancio non prova nulla.
- Regressione: `npx playwright test e2e/vault-*.spec.ts`.

**Cosa resta manuale e perché.**
- PWA installata su un telefono reale in modalità aereo. `setOffline` non emula del tutto il SW e la perdita di rete reale. Si verifica che il toast si legga su mobile e che il ripristino dalla cronologia funzioni.

**Rischi.**
- Il testo di D1 cambia anche il caso della sessione live.
- Una sessione diversa dentro i 2 minuti fa rispondere 503 `archiveBusy` (`noteVersion.service.ts:174`, `:186`). L'item resta in coda con backoff (`syncService.ts:1324-1331`): ritardo, nessuna perdita.
- Il rethrow dopo il commit fa riapplicare i metadati al retry. È idempotente, come nel percorso live.
- Con (d) non si scrivono più versioni `nv3.`. La UI già non le mostra, ma è un cambio di comportamento.
- Fuori ambito: `hocuspocus.ts` (TIER1) usa lo stesso guard in `store()`. Va in una voce separata.
- Se D2 = a: un testo lungo scritto offline sovrascrive il server senza avviso (LWW). Il testo di A resta recuperabile dalla cronologia grazie a (d).

**Giudizio sulla critica.** Accetto i due MAJOR. Ho verificato il flag incondizionato a `note.service.ts:456-458` e il test a `note.service.test.ts:643-650`. Ho verificato anche il ripristino dell'editor a `NoteEditor.tsx:146-150`. Sulla parte `sharing.service.ts` la critica è fondata ma va ridotta: il flag nella risposta non servirebbe, perché `noteService.ts:231-233` ignora la risposta.

### F.10: il selettore del promemoria mostra l'ora UTC

**Causa verificata.** Il valore dell'input `datetime-local` è formattato in UTC: `new Date(note.reminderDate).toISOString().slice(0, 16)` a `frontend/src/features/notes/NoteEditor.tsx:772` (desktop), `:885` (input nascosto per mobile) e `frontend/src/features/vault/VaultNoteEditor.tsx:328`. Sono le uniche tre occorrenze (grep verificato). Il salvataggio è corretto: `new Date(e.target.value).toISOString()` legge la stringa come ora locale. Evidenza `out/L05/F10-evidence.json`: 15:55 locale diventa `13:55:00.000Z` (giusto), ma l'input dopo mostra `13:55`. Se l'utente riconferma, il promemoria slitta di 2 ore. Il difetto c'era già in NoteEditor: non è una regressione del vault.

**Correzione finale.**
- In `frontend/src/utils/format.ts` un helper puro:
  ```ts
  export const toDatetimeLocal = (iso: string): string => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  ```
  `getTimezoneOffset()` usa l'offset della data del promemoria, quindi l'ora legale è gestita. La guardia su NaN evita il `RangeError` con una data non valida (il backend accetta `z.string().nullable()` senza `.datetime()`, `routes/notes.ts:25`).
- Nelle tre righe: `value={note.reminderDate ? toDatetimeLocal(note.reminderDate) : ''}`. Il salvataggio (`onChange`) non cambia.
- Nota: `format.ts` importa già date-fns (`:1`). `format(d, "yyyy-MM-dd'T'HH:mm")` sarebbe equivalente. La scelta è indifferente; si tiene l'helper con la guardia testabile.
- Nessuna migrazione: il DB ha istanti UTC corretti.

**File e modifiche.**
- `frontend/src/utils/format.ts`: nuovo export.
- `frontend/src/features/vault/VaultNoteEditor.tsx`: riga 328 e import.
- `frontend/src/features/notes/NoteEditor.tsx`: righe 772 e 885 e import.
- `frontend/src/utils/__tests__/format.test.ts`: test indipendenti dalla TZ.
- `frontend/src/utils/__tests__/format.tz.test.ts`: file nuovo, TZ fissata.
- `frontend/e2e/reminder-timezone.spec.ts`: spec nuovo.
- Opzionale: `frontend/src/features/vault/__tests__/VaultNoteEditor.test.tsx:197-204`, un assert sul value.

**Criteri di accettazione.**
1. `grep -rn "reminderDate).toISOString().slice" frontend/src` restituisce 0 righe. (Il criterio originale includeva anche l'helper e non poteva mai dare 0.)
2. `npx vitest run src/utils/__tests__/format.test.ts src/utils/__tests__/format.tz.test.ts` (da `frontend/`) passa.
3. `npx tsc -p tsconfig.app.json --noEmit` passa, `npm run lint` a 0 errori.
4. Playwright in timezone Europe/Rome: dopo il fill di `2026-10-23T15:55`, la PUT ha `reminderDate` `2026-10-23T13:55:00.000Z`. Dopo il reload l'input vale `2026-10-23T15:55`. Vale per la nota normale e per la nota vault.
5. Un promemoria già salvato a `2026-10-23T13:55:00.000Z` mostra 15:55. Riaprendo l'input senza modifiche non parte nessuna PUT.
6. `npx playwright test e2e/vault-*.spec.ts` resta verde.

**Test unit.**
- `format.test.ts` (indipendente dalla TZ): solo orari a mezzogiorno. Per `d = new Date(Y, M, D, 12, 0)` su 2026-01-15, 2026-03-29, 2026-07-01 e 2026-10-25: `toDatetimeLocal(d.toISOString()) === 'YYYY-MM-DDT12:00'`. Input `'garbage'`: restituisce `''` senza eccezioni.
- `format.tz.test.ts`, **test primario di regressione**: quello indipendente passa anche col codice vecchio sulla CI in UTC (`.github/workflows/ci.yml:44,79`).
  - Prima riga del file: `process.env.TZ = 'Europe/Rome'`, prima di ogni import che usa Date.
  - `beforeAll`: precondizione `expect(new Date('2026-07-01T00:00:00Z').getTimezoneOffset()).toBe(-120)`.
  - Integrazione del 26/10: `afterAll` rimette il TZ originale, così il valore non passa ad altri file se il worker viene riusato.
  - Attesi fissi: `2026-10-23T13:55:00.000Z` → `2026-10-23T15:55`. `2026-01-15T12:00:00.000Z` → `2026-01-15T13:00`. `2026-10-25T00:30:00.000Z` → `2026-10-25T02:30` (CEST). `2026-10-25T01:30:00.000Z` → `2026-10-25T02:30` (CET, stessa stringa: qui il round-trip non vale, va scritto nel test). `2026-10-25T02:30:00.000Z` → `2026-10-25T03:30`. `2026-03-29T00:30:00.000Z` → `2026-03-29T01:30` (CET). `2026-03-29T01:30:00.000Z` → `2026-03-29T03:30` (CEST: le 02:xx non esistono).
  - Non scrivere l'affermazione generale "per un ISO allineato al minuto il round-trip vale".
- Opzionale, `VaultNoteEditor.test.tsx`: con `reminderDate: '2026-10-30T10:00:00.000Z'`, il value dell'input è uguale alla stringa costruita con i getter locali di quella data (non con `toDatetimeLocal`: sarebbe circolare).

**Test E2E e Playwright eseguibili in autonomia.**
- Nuovo `frontend/e2e/reminder-timezone.spec.ts` con `test.use({ timezoneId: 'Europe/Rome' })`. Servono backend :3001 e Vite :5173.
- Tutti i fill con `{ force: true }`: l'input ha `w-0 h-0 opacity-0` (`NoteEditor.tsx:778`, `:891`; `VaultNoteEditor.tsx:330`), come in `frontend/manual-p2/lotto-05c-features.spec.ts:81`.
- Su NoteEditor i due input (desktop e mobile) sono montati insieme e `reminderInputRef` punta all'ultimo. Usare `.last()` in modo esplicito e leggere `inputValue()` sullo stesso locator del fill.
- Caso 1, nota normale: `registerAndLogin` + `createNote` (`e2e/helpers.ts`). Fill `2026-12-01T15:55`. La PUT intercettata ha `2026-12-01T14:55:00.000Z` (CET). Dopo il reload l'input vale `2026-12-01T15:55`.
- Caso 2, nota vault: `createUserViaApi` + `loginInBrowser` + `setupVaultUi` + `createSecureNoteUi` (`e2e/vault-helpers.ts`). Data in ottobre (CEST, `13:55Z`), poi `lockUi`, `unlockUi`, riapertura e controllo `...T15:55`.
- Caso 3, dato esistente: via API `reminderDate` `2026-10-23T13:55:00.000Z`. L'input mostra `2026-10-23T15:55`.
- Regressione: `npx playwright test e2e/vault-*.spec.ts`.

**Cosa resta manuale e perché.**
- Picker nativo (`showPicker`) su un telefono vero: il picker dell'OS e il touch non si automatizzano in headless, e `adb devices` è vuoto.
- Consegna della notifica all'ora giusta: dipende dall'OS e dallo scheduler. Utile da osservare, fuori da F.10.

**Rischi.**
- I promemoria già riconfermati con l'ora sbagliata restano spostati. Non si possono riconoscere. Basta una nota nel changelog.
- Il ref condiviso dei due input di NoteEditor è preesistente: si correggono tutte e due le righe.
- Il rischio "TZ non onorato su Windows" del piano è infondato: la critica ha verificato su Node 24.15.0 Windows che `getTimezoneOffset()` passa da 0 a -120. La precondizione del test lo protegge comunque.

### H.3: il toast dice "usa Riprova", ma Riprova non agisce sugli item del vault

**Causa verificata.** `frontend/src/components/layout/SyncStatusIndicator.tsx:44-46` mostra sempre `t('sync.failedToast')`, senza guardare `lastError`. Il banner (`:73-86`) mostra Riprova per ogni item fallito. `retryFailedSyncItems` salta gli item `vault:*` (`frontend/src/features/sync/syncService.ts:1464`). Evidenza `H3-evidence.json`: `retry.before == retry.after`. Il piano P2 (§12, punto 11, `2026-10-02-vault-p2-plan.md:738`) chiede che il testo lo dica.

**Correzione finale** (opzione B di D5, con le modifiche della critica). Solo `SyncStatusIndicator.tsx`:
1. `const vaultOnly = failedCount > 0 && (items ?? []).filter((i) => i.status === 'failed').every((i) => i.lastError?.startsWith('vault:'));`
2. Toast: `toast.error(t(vaultOnly ? 'sync.vaultFailedToast' : 'sync.failedToast'))`. Con item misti resta il testo generico, perché Riprova serve agli item non vault.
3. Banner: se `vaultOnly`, niente bottone Riprova e testo `t('sync.vaultFailed', { count: failedCount })`. Il contenitore riceve `py-1.5` (come il banner pending di `:92`): senza il bottone perderebbe l'altezza di 44 px data dal `min-h-[44px]` di `:81`. Nessun colore nuovo, quindi nessun `dark:` in più.
4. Chiavi in `en.json` e `it.json` vicino a `:1361` e `:985`, con i testi di D5.
- `syncService.ts` non si tocca.

**File e modifiche.**
- `frontend/src/components/layout/SyncStatusIndicator.tsx`: calcolo di `vaultOnly`, scelta del toast, banner.
- `frontend/src/locales/it.json`, `frontend/src/locales/en.json`: `sync.vaultFailedToast`, `sync.vaultFailed`.
- `frontend/src/components/layout/__tests__/SyncStatusIndicator.test.tsx`: 3 test nuovi.
- `frontend/e2e/vault-conflict.spec.ts`: assert sul banner nel test di `:12`.

**Criteri di accettazione.**
1. Con soli item `vault:conflict` falliti: un solo toast con `sync.vaultFailedToast`, banner con `sync.vaultFailed` e senza Riprova, banner alto almeno 28 px (verificato in E2E).
2. Con item misti (`vault:*` e validation): toast `sync.failedToast` e Riprova, che chiama `retryFailedSyncItems`.
3. I test esistenti di `SyncStatusIndicator.test.tsx` passano senza modifiche.
4. Chiavi presenti in `en.json` e `it.json`.
5. `npx tsc -p tsconfig.app.json --noEmit`, `npm run lint` e `npx vitest run src/components/layout` passano.

**Test unit.**
- "Solo `vault:*`": `mockToast.error` chiamato con `'sync.vaultFailedToast'` (non basta il conteggio: il test passerebbe anche col testo vecchio), `queryByRole('button')` null, testo `sync.vaultFailed`.
- "Misti `vault:conflict` + validation": `sync.failedToast`, e Riprova chiama `retryFailedSyncItems`.
- "`lastError` `vault:notEnvelope` conta come vault".

**Test E2E e Playwright eseguibili in autonomia.**
- `vault-conflict.spec.ts:12`, subito dopo il poll su `vault:conflict` (`:45`): banner visibile (`getByText(/vault change\(s\) waiting/)`, da adattare al testo scelto in D5) e `getByRole('button', { name: 'Retry' })` con count 0.
- Il toast dura 4 s (`App.tsx:45-55`, nessun `duration`) e il poll può durare fino a 60 s: il controllo del toast è solo opzionale, con timeout di 3 s e non bloccante.
- Comando: `npx playwright test e2e/vault-conflict.spec.ts e2e/vault-offline.spec.ts`, con backend :3001 e Vite :5173.

**Cosa resta manuale e perché.** Il giudizio sulla chiarezza del testo per un utente reale. È una scelta di prodotto, non un test.

**Rischi.**
- Il testo nuovo vale solo per `lastError` `vault:*`. Gli item legacy saltati a `syncService.ts:1465-1467` hanno un `lastError` diverso: per loro Riprova resta inefficace. Succede solo con un bundle vecchio.
- Per gli altri `vault:*` (stale, epoch) il giro può dare LEAVE (`vaultReconcile.ts:285-286`) e l'item resta fallito anche dopo "Controlla ora". Per questo il testo non promette che si sistemano da soli.
- Il toast scatta solo alla prima transizione a failed (`:45`), come oggi.

### J.7: dopo "Rimuovi dal dispositivo" e lo sblocco, la lista resta "Untitled"

**Causa verificata** (con le correzioni della critica).
- Le righe vault dell'utente le cancella `vaultRows(userId, true)` in `frontend/src/components/vault/VaultSettingsSection.tsx:21-33`, non `removeFromDevice`.
- T-a parte allo sblocco (`frontend/src/features/vault/VaultPage.tsx:206-212`). In quel momento Dexie non ha righe vault (evidenza `passo9_dopoSblocco.righeDexie`). Gli id che esistono solo sul server escono già al passo 2 del listing (`frontend/src/lib/vaultReconcile.ts:801`): nessuna riga viene creata.
- La pull parte al mount e poi ogni 30 s (`frontend/src/hooks/useSync.ts:98-101`). Circa 23 s dopo arriva e scrive righe con content `''` (`syncService.ts:213`). La lista salta le righe senza envelope (`VaultPage.tsx:349`) e mostra "Untitled".
- Nessun trigger riparte: T-d (`VaultPage.tsx:220-235`) guarda solo la coda `vault:conflict`. T-b scatta solo all'evento online, T-c alla chiusura di un editor.
- Basta un giro dopo la pull: una riga `content: ''` senza `vaultBaseHash` va in T1 HYDRATE (`vaultReconcile.ts:289`).

**Correzione finale.**
1. **Prima del codice**, Addendum 4 nella spec `docs/superpowers/plans/2026-10-22-vault-t15-reconcile-spec.md`:
   - definizione di T-h: comparsa di una riga vault dell'utente, non condivisa, con content vuoto (pull dopo la rimozione dal dispositivo, nuovo dispositivo, o passaggio normale→vault della pull a `syncService.ts:204`);
   - stesso memo e stesso debounce di T-d (`:200`);
   - T-h nella frase sulla terminazione (`:202`) e nella riga dei componenti `VaultPage: T-c, T-d (memo), T-f, T-g, banner` (`:223`).
2. In `VaultPage.tsx`, la live query `needIds` (`:221-225`) aggiunge gli id `e<noteId>`:
   ```ts
   const needIds = useLiveQuery(async () => {
     if (!userId) return [] as string[];
     const q = await db.syncQueue.filter((i) => i.userId === userId && i.entity === 'NOTE' && i.status === 'failed' && i.lastError === 'vault:conflict').toArray();
     const e = (await db.notes.toArray()).filter((n) => n.userId === userId && !!n.isVault && n.ownership !== 'shared' && !n.content);
     return [...q.map((i) => `q${i.id}`), ...e.map((n) => `e${n.id}`)];
   }, [userId]);
   ```
   - `toArray` come la query `rows` di `:323` e come il mock dei test (`VaultPage.test.tsx:58`).
   - L'effetto di `:226-235` non cambia. Gli id del primo valore entrano nel memo (li copre T-a). Una riga vuota nuova dà un giro dopo 1 s, solo online e una volta per id e per sessione: niente cicli se HYDRATE fallisce.
   - Aggiornare i commenti di `:176` e `:220` con T-h.
- `syncService.ts` non si tocca.

**File e modifiche.**
- `docs/superpowers/plans/2026-10-22-vault-t15-reconcile-spec.md`: Addendum 4.
- `frontend/src/features/vault/VaultPage.tsx`: `needIds` e commenti.
- `frontend/src/features/vault/__tests__/VaultPage.test.tsx`: test T-h nel describe di `:687`.
- `frontend/e2e/vault-multidevice.spec.ts`: test nuovo.

**Criteri di accettazione.**
1. Dopo "Rimuovi dal dispositivo" e lo sblocco online, i titoli decifrati compaiono entro 1-2 s dall'arrivo della pull, senza chiudere note e senza "Controlla ora".
2. In Dexie le righe vault dell'utente hanno content che inizia con `nv3.` e `title ''`. Nessun plaintext in Dexie o in syncQueue.
3. Una riga che resta vuota (HYDRATE fallito o offline) non dà più di un giro per sessione sbloccata.
4. I test T-a, T-b, T-d, T-f e T-g esistenti passano invariati.
5. `npx tsc -p tsconfig.app.json --noEmit`, `npm run lint`, `npx vitest run src/features/vault` passano.

**Test unit** (`VaultPage.test.tsx`).
- "T-h: una riga vault vuota nuova dopo lo sblocco dà un giro dopo 1 s". Parti da `h.rows=[]`: T-a fa 1 giro. Aggiungi `{ id: 'n1', userId: 'u1', isVault: true, content: '' }`, incrementa `h.liveSubs`, avanza di 1 s: reconcile chiamato 2 volte. Col codice vecchio resta 1: il test discrimina.
- "T-h memo: la stessa riga ancora vuota non riscatta; una seconda riga vuota sì".
- "T-h: righe presenti al primo valore, condivise, con envelope, di un altro utente o offline non scattano".

**Test E2E e Playwright eseguibili in autonomia.** Nuovo test in `vault-multidevice.spec.ts`, con backend :3001 e Vite :5173.
- Il test deve controllare quando arriva la pull. Altrimenti passa anche senza T-h: se la pull cade fra "Remove" e lo sblocco, T-a idrata le righe (MAJOR della critica).
- Passi:
  1. Utente con vault e 2 note sincronizzate.
  2. Prima di "Remove", `page.route` blocca solo la lista note: pathname `/api/notes` con query `all=1` (la pull usa `/notes?includeTrashed=true&all=1`, `syncService.ts:119`). Sblocco e reconcile usano `/api/vault/*` e non vengono toccati.
  3. Impostazioni del vault, "Remove from this device", conferma dentro il dialog: `page.getByRole('dialog').getByRole('button', { name: 'Remove from this device' })`. Il nome compare due volte (bottone della sezione e conferma). Controllare il titolo "Remove the vault from this device?".
  4. `/vault`, sblocco online, `expectUnlocked`.
  5. Precondizione: IndexedDB ha 0 righe `isVault` dell'utente.
  6. `page.unroute`, poi `expect.poll` (60 s) sui titoli `h3` della lista uguali agli originali, senza click.
  7. Assert su IndexedDB: content `/^nv3\./` e `title ''`.
- Regressione: `npx playwright test e2e/vault-conflict.spec.ts e2e/vault-offline.spec.ts e2e/vault-migration.spec.ts`.

**Cosa resta manuale e perché.** Niente: il flusso è tutto automatizzabile.

**Rischi.**
- `needIds` ora legge `db.notes` a ogni scrittura sulle note, come la query `rows` di `:322`. Costo lineare, già accettato (piano §12, punto 15).
- Su un dispositivo nuovo le righe vuote della prima pull danno un giro in più. È voluto. Il giro è single-flight sotto `notiq-vault-reconcile`.
- Effetto in più (dalla critica): anche le righe vuote nate dai passaggi normale→vault della pull ora si idratano da sole.

### H.13: la credenziale già caricata mostra il valore vecchio

**Causa verificata.** La credenziale si idrata solo con content `''` (`frontend/src/features/vault/VaultPage.tsx:409-417`). La nota invece si idrata a ogni apertura, dentro il lock shared e prima della decifratura (`VaultNoteEditor.tsx:134`). `CredentialForm` prende il lock e decifra subito la prop (`CredentialForm.tsx:395-397`, `:92-125`). Dexie tiene pw-0 finché non arriva una pull. Evidenza `out/L06/H13-evidence.json`: nessuna POST all'apertura, valore pw-0, poi 422 e copia (nessuna perdita).
- Trappola: togliere solo la condizione in VaultPage non basta. `hydrateVaultNote` aggiorna anche `vaultBaseHash` (`vaultReconcile.ts:658`) e la push lo manda come CAS (`syncService.ts:621`). Un edit fatto sui dati vecchi partirebbe con la base nuova e la modifica di B sparirebbe senza 422.

**Correzione finale.** Solo `CredentialForm.tsx`, come fa `VaultNoteEditor`:
1. Nell'effetto del lock (`:395-397`): `await hydrateVaultNote(note.id).catch(() => false)` prima di `setLockGranted(true)`, sia nel callback di `withNoteLock` sia nel ramo `'nolocks'`. Basta un helper locale `grant`. Dopo l'await si ricontrolla `cancelled` in tutti e due i rami (altrimenti `setLockGranted` su un form smontato). Il ramo `catch` del lock resta com'è.
2. Nella prima decifratura (`:92-125`, caso `decryptedRef.current?.id !== note.id`) il content si rilegge da Dexie: `(await db.notes.get(note.id))?.content || note.content`. In `decryptedRef` va il content davvero decifrato.
3. Import: `import { db } from '../../lib/db'` e `import { hydrateVaultNote } from '../../lib/vaultReconcile'` (solo import, il file TIER non cambia).
- Fino a `loaded` il form non è modificabile (`:466-468`) e `saveNow` rifiuta (`:131`): nessun edit nasce sui dati vecchi.
- L'effetto `hydrateId` di VaultPage resta (riprova all'evento `online` per content `''`).

**File e modifiche.**
- `frontend/src/features/vault/CredentialForm.tsx`: idratazione nel lock e prima decifratura da Dexie.
- `frontend/src/features/vault/__tests__/CredentialForm.test.tsx`: mock e casi nuovi.
- Solo locale: `frontend/manual-p2/lotto-R06c.spec.ts` (atteso invertito).

**Criteri di accettazione.**
1. A ha già caricato S17 (pw-0). B la cambia in pw-B. A la apre entro 30 s senza pull in mezzo: il campo mostra pw-B.
2. Con content non vuoto, all'apertura parte una sola `POST /api/vault/items` con `ids:[id]`. Con content `''` ne partono al massimo due (VaultPage e form). Nessuna PUT, nessun 422. (Riscritto dalla critica: la seconda POST è benigna, `hydrateVaultNote` ha la CAS a `vaultReconcile.ts:656`.)
3. Form dirty con un cambio esterno di content: l'input dell'utente resta. Al salvataggio arriva un 422 e si crea una copia, come oggi.
4. Offline o idratazione in errore: il form si apre con la copia locale.
5. `npx tsc -p tsconfig.app.json --noEmit` e `npm run lint` puliti.

**Test unit** (`CredentialForm.test.tsx`).
- Mock: `vi.mock('../../../lib/db', ...)` con `notes.get` controllabile, `vi.mock('../../../lib/vaultReconcile', () => ({ hydrateVaultNote }))`. Lo schema è già in `VaultNoteEditor.test.tsx:38-39`.
- Test 1 (discrimina): `hydrateVaultNote` risolve prima della prima `decryptItem` ed è chiamata una volta per id.
- Test 2 (discrimina): la riga Dexie ha E2, la prop ha E1. Alla prima decifratura `decryptItem` riceve E2. Il mock di db deve restituire E2: con `undefined` il fallback farebbe passare il test a vuoto.
- Test 3 (regressione): `hydrateVaultNote` rifiutata, il form si carica.
- Test 4 (regressione): utente che digita, un cambio della prop non sovrascrive l'input.

**Test E2E e Playwright eseguibili in autonomia.**
- Locale: `frontend/manual-p2/lotto-R06c.spec.ts` (H13) con atteso invertito: A vede pw-B, nessun 422, 0 copie.
- Regressione: `npx playwright test e2e/vault-conflict.spec.ts e2e/vault-multidevice.spec.ts`.

**Cosa resta manuale e perché.** Niente.

**Rischi.**
- Lo spinner del form dura un round-trip in più. Con un server lento il form resta in caricamento più a lungo.

### A.3: l'utente legacy a kill switch chiuso vede il testo corto

**Causa verificata.** Con `setupAllowed: false` il Gate perde `legacyCount`: `frontend/src/features/vault/VaultPage.tsx:132` produce `{ k: 'setupDisabled' }` e il tipo a `:50` non ha il campo. Sia `:471` sia `:462` (legacy senza chiave root) mostrano `errors.vault.setupDisabled` ("Il vault non è ancora disponibile.", `it.json:1799`, `en.json:1799`). Il backend manda già `legacyCount` anche a kill switch chiuso (`backend/src/services/vault.service.ts:173-178`). Evidenza `out/L10/A3-evidence.json`.

**Correzione finale.**
- Tipo del Gate: `{ k: 'setupDisabled'; legacyCount: number }`.
- `:132`: `{ k: 'setupDisabled', legacyCount: kr.legacyCount ?? 0 }`.
- `:471`: `t(gate.legacyCount > 0 ? 'vault.setupDisabledLegacy' : 'errors.vault.setupDisabled')`.
- `:462`: direttamente `t('vault.setupDisabledLegacy')`.
- Nuova chiave `vault.setupDisabledLegacy` in `en.json` e `it.json`, con il testo di D6.
- `i18nVaultKeys.test.ts` non si tocca: lo scanner (`:29-38`) raccoglie da solo le stringhe `'vault.xxx'`, anche dentro il ternario.
- `VaultSetup.tsx:112` e `VaultSettingsSheet.tsx:223` non cambiano.

**File e modifiche.**
- `frontend/src/features/vault/VaultPage.tsx`: Gate e chiavi a `:462` e `:471`.
- `frontend/src/locales/it.json`, `frontend/src/locales/en.json`: `vault.setupDisabledLegacy`.
- `frontend/src/features/vault/__tests__/VaultPage.test.tsx`: casi di `:240-246` e `:263-269`.
- Solo locale: `frontend/manual-p2/lotto-10c-a3.spec.ts` (testo atteso).

**Criteri di accettazione.**
1. NONE, `setupAllowed: false`, `legacyCount > 0`: testo legacy con Riprova. Con `legacyCount` 0 resta il testo corto.
2. NONE, `legacyCount > 0`, senza chiave root: testo legacy, nessun wizard.
3. Riprova e l'evento `online` rileggono ancora il keyring (`VaultPage.tsx:157` invariato).
4. `VaultPage.test` e `i18nVaultKeys.test` verdi.

**Test unit.** `VaultPage.test.tsx`: `:240-246` e `:263-269` attendono `vault.setupDisabledLegacy` (falliscono col codice vecchio). `:254-261` e `:200-207` (`legacyCount` 0) restano su `errors.vault.setupDisabled`.

**Test E2E e Playwright eseguibili in autonomia.** Locale: `frontend/manual-p2/lotto-10c-a3.spec.ts` con il backend riavviato e `VAULT_SETUP_USERS` vuoto. F_ALTRO vede il testo legacy, N1 quello corto. Poi riavvio con `*` e Riprova.

**Cosa resta manuale e perché.** Niente.

**Rischi.** Solo testo e Gate. Nessun impatto sui dati.

### B.5: nel wizard il PIN errato resta e il lockout non ha countdown

**Causa verificata.** Nel `catch` di `submitUnlock` (`frontend/src/features/vault/VaultMigrate.tsx:241-244`) ci sono solo `setFormError` e `setPhase('unlock')`. Manca `setUnlockPin('')` e non si legge `lockedUntil`. `VaultUnlock.tsx:94-102` lo fa già, e `vaultSession.ts:135-136` e `:167-171` popolano `lockedUntil`.

**Correzione finale.** In `VaultMigrate.tsx`:
1. Nel `catch` di `submitUnlock`: `setUnlockPin('')`.
2. Riconoscimento del lockout **con duck typing** (scelta della critica, opzione b), senza importare `VaultSessionError`:
   ```ts
   const e = err as { code?: unknown; lockedUntil?: unknown };
   if (e?.code === 'pinLocked' && typeof e.lockedUntil === 'string') {
     const until = Date.parse(e.lockedUntil);
     setNow(Date.now());
     setLockedUntil(Number.isFinite(until) ? until : null);
   }
   ```
   Motivo: `VaultMigrate.test.tsx:23` mocka `lib/vaultSession` con un factory che esporta solo `setup`, `unlockOnline` e `confirmKit`. Con `instanceof VaultSessionError` Vitest lancerebbe `No "VaultSessionError" export is defined on the mock` e i test fallirebbero per il mock. Il duck typing non richiede di cambiare il mock.
3. Un effetto con `setInterval` da 1 s aggiorna `now`. Alla scadenza azzera `lockedUntil` e `formError`.
4. Finché `remaining > 0`: input e submit disabilitati, e al posto di `formError` si mostra `<p role="status" className="text-sm text-amber-700 dark:text-amber-400">{t('vault.unlock.lockedFor', { time: fmt(remaining) })}</p>`.
5. `fmt` si copia (3 righe) da `VaultUnlock.tsx`. Esportarlo da un file componente viola `react-refresh/only-export-components`.
- Nessuna chiave i18n nuova: `vault.unlock.lockedFor` esiste (`it.json:557`, `en.json:458`).

**File e modifiche.**
- `frontend/src/features/vault/VaultMigrate.tsx`: PIN svuotato e countdown.
- `frontend/src/features/vault/__tests__/VaultMigrate.test.tsx`: due casi nuovi.
- Solo locale: `frontend/manual-p2/lotto-09c-b4b5.spec.ts` (passo del lockout breve).

**Criteri di accettazione.**
1. Fase unlock (409), PIN errato: il campo si svuota e compare "PIN errato".
2. Al primo invio durante il lockout (il 7°) compare `lockedFor` con m:ss decrescente. Input e submit sono disabilitati. Nessuna `POST /api/vault/unlock` (una sola `GET /keyring`). Il 6° errore è un 403 senza `lockedUntil` (`vaultSession.ts:166`): il countdown non parte lì.
3. Alla scadenza il messaggio sparisce e il form torna attivo. Annulla porta ancora a `VaultUnlock` (`onDone`).

**Test unit** (`VaultMigrate.test.tsx`).
- `unlockOnline` rifiuta con `errors.vault.invalidPin`: l'input dello sblocco ha value `''`.
- `unlockOnline` rifiuta con un oggetto `{ code: 'pinLocked', lockedUntil: <ora + 60 s> }`: compare `vault.unlock.lockedFor`, il submit è disabilitato. Con `vi.advanceTimersByTime(61000)` torna attivo (schema già usato a `:158`).

**Test E2E e Playwright eseguibili in autonomia.** Locale: `frontend/manual-p2/lotto-09c-b4b5.spec.ts`.
- 6 PIN errati. Poi, sul DB dev, `UPDATE "VaultKeyring" SET "lockedUntil" = now() + interval '5 seconds'` per l'utente di test.
- 7° invio: countdown da 0:05, campo vuoto, input disabilitato. Attesa della scadenza, poi sblocco con PIN1.
- Non usare `lockedUntil = now()` a countdown già partito: il countdown è locale e terrebbe il form bloccato fino alla scadenza originale (15 min).

**Cosa resta manuale e perché.** L'email di lockout: si verifica solo con lo SMTP reale.

**Rischi.** Il countdown parte dal 7° invio, come in `VaultUnlock`. È coerente.

### B.11: dopo un logout da un'altra scheda compare "Vault bloccato"

**Causa verificata. Non è un difetto.** Il logout nell'altra scheda blocca il vault (listener `storage`, `vaultStore.ts:183`, `vaultSession.ts:532`). `VaultPage.tsx:150-154` rilegge il keyring, che è READY. `showWizard` (`:119`) torna false, il wizard si smonta e fa abort (`VaultMigrate.tsx:106-114`). La UI mostra `VaultUnlock` (`:473`). Evidenza `out/L09/B11-evidence.json`. L'atteso è già allargato (`manual-checklist.md:697`) e il retest lo dichiara ammesso (`retest-report.md:145`). L'invariante "nessuna `/vault/migrate` dopo il blocco" è PASS.
- Nota della critica: un batch già inviato finisce `verifyAndFinalize` con il contesto catturato (`vaultMigration.ts:288-314`). È corretto: gli envelope erano già cifrati.

**Correzione finale.** Nessuna modifica (D7 = a). Se l'utente sceglie D7 = b, la voce va pianificata a parte: `VaultPage` oggi non conosce la fase del wizard.

**File e modifiche.** Nessuno.

**Criteri di accettazione.** Il rilancio di `frontend/manual-p2/lotto-09e-b9b10b11.spec.ts` resta PASS: "Vault bloccato", nessuna POST `/vault/migrate` dopo il blocco, ripresa dal banner dopo lo sblocco.

**Test unit.** Nessuno.

**Test E2E e Playwright eseguibili in autonomia.** Locale: `lotto-09e-b9b10b11.spec.ts` come regressione, dopo B.5 e B.15.

**Cosa resta manuale e perché.** Niente.

**Rischi.** Il ramo `'locked'` di `vaultMigration.ts:259` resta difensivo. Serve per una corsa nello stesso tick.

### B.15: il riepilogo del wizard non segnala gli allegati

**Causa verificata.** Il client non ha l'informazione. `ServerItem` non ha campi sugli allegati (`frontend/src/lib/vaultReconcile.ts:17-26`). `itemSelect` conta solo le versioni (`backend/src/services/vault.service.ts:444-447`). `MigrationResult` non ha un contatore (`vaultMigration.ts:210-224`). Evidenza `out/L09/B15-evidence.json`: `summaryMentionsAttachment=false`.

**Correzione finale.**
1. `backend/src/services/vault.service.ts`: in `itemSelect` si aggiunge `attachments: true` dentro `_count.select`. Il tipo del parametro di `toItem` diventa `_count: { versions: number; attachments: number }`. `toItem` espone `hasAttachments: r._count.attachments > 0`. La route `/items` restituisce l'output del service senza schema di risposta (`routes/vault.ts:130-133`): il campo arriva al client.
2. `frontend/src/features/vault/vaultMigration.ts`: `MigrationResult` riceve `withAttachments: number`, a 0 in `res`. Dopo `listLegacy()`: `res.withAttachments = queue.filter((i) => (i as { hasAttachments?: boolean }).hasAttachments).length`. È un cast locale: `ServerItem` sta in un file TIER1 e non si tocca. Con un backend vecchio il campo manca e il contatore vale 0.
3. `frontend/src/features/vault/VaultMigrate.tsx`, fase done, dopo `tooLarge`: `<p className="text-sm text-amber-700 dark:text-amber-400">{t('vault.migrate.attachmentsNotice', { n })}</p>` se `n > 0`.
4. Chiave `vault.migrate.attachmentsNotice` in `it.json` e `en.json`, con il testo di D8.
- `i18nVaultKeys.test.ts` non si tocca: lo scanner raccoglie la chiave da `VaultMigrate.tsx`.

**File e modifiche.**
- `backend/src/services/vault.service.ts`: `_count.attachments` e `hasAttachments`.
- `backend/src/__tests__/vault.items.test.ts`: mock e assert.
- `frontend/src/features/vault/vaultMigration.ts`: `withAttachments`.
- `frontend/src/features/vault/VaultMigrate.tsx`: riga di avviso.
- `frontend/src/locales/it.json`, `frontend/src/locales/en.json`: la chiave.
- `frontend/src/features/vault/__tests__/vaultMigration.test.ts`: conteggio.
- `frontend/src/features/vault/__tests__/VaultMigrate.test.tsx`: fixture e render.
- Solo locale: `frontend/manual-p2/lotto-R09f-b14b15b16m4.spec.ts` (atteso).

**Criteri di accettazione.**
1. Wizard con un allegato su noteA: il riepilogo mostra l'avviso con n=1 (`summaryMentionsAttachment=true`; la regex `/attach|allegat/i` di `lotto-09f:105` regge con il testo neutro).
2. `SELECT count(*) FROM "Attachment" WHERE "noteId"='<noteA>'` resta invariato.
3. Item senza campo `hasAttachments` (backend vecchio): `withAttachments` 0 e nessuna riga.
4. Backend: `npx vitest run src/__tests__/vault.items.test.ts`. Frontend: vitest, tsc e lint verdi.

**Test unit.**
- `vault.items.test.ts`: il select contiene `_count.select.attachments`. `toItem` dà `hasAttachments: false` con `_count.attachments: 0` e `true` con 1.
- `vaultMigration.test.ts`: listing con 2 legacy, una con `hasAttachments`: `withAttachments=1`.
- `VaultMigrate.test.tsx`: risultato con `withAttachments` 2 rende la chiave; con 0 no.

**Test E2E e Playwright eseguibili in autonomia.** Locale: `frontend/manual-p2/lotto-R09f-b14b15b16m4.spec.ts` con atteso `summaryMentionsAttachment=true`. Q1, Q3 e notFound invariati.

**Cosa resta manuale e perché.** Niente.

**Rischi.**
- Una COUNT in più per ogni nota del listing, che usa anche il reconcile. Usa l'indice `@@index([noteId, isLatest])` (`schema.prisma:215`): costo basso. Conta anche gli allegati non `isLatest`, che per un booleano va bene.
- Serve il deploy congiunto di backend e frontend, già previsto da P2.

### M.3: target sotto 44 px su lista vault e form credenziale

**Causa verificata** (righe attuali; quelle del report erano slittate).
- `frontend/src/features/vault/VaultPage.tsx:615`: chip `px-2.5 py-1 text-xs` = 25 px.
- `frontend/src/components/ui/SortDropdown.tsx:47`: `px-2 py-1` + icona 14 = 30x22. È condiviso con `NotesPage.tsx:193`.
- `frontend/src/features/vault/CredentialForm.tsx`: Indietro `:474-480` senza padding (20 px); cestino `:481-487` 16x16; Indietro in `decryptFailed` `:458` 40 px; pulsanti della conferma `:497`, `:500` (`size="sm"`, 36 px); apri URL `:581` e generatore `:680` 28x28; occhio `:666-673` 16 px; "Rifai screenshot" `:601` `text-xs`; input `:570`, `:645`, `:664` 38 px.
- `frontend/src/features/vault/CopyButton.tsx:44`: `p-1.5` = 28x28.
- Lo `Input.tsx` condiviso (h-10) non è coinvolto e non va toccato.

**Correzione finale** (solo classi; stringhe finali già unite con M.6).
1. `VaultPage.tsx:615`: aggiungere `inline-flex items-center min-h-[44px]`. Aggiungere anche `md:min-h-0` solo se D9 tiene il reset sui chip.
2. `SortDropdown.tsx:47`: aggiungere `min-h-[44px] min-w-[44px] justify-center`, senza reset `md:` (raccomandazione D9). Vale anche per `NotesPage`, ed è voluto.
3. `CopyButton.tsx:44`: `p-1.5` diventa `min-h-[44px] min-w-[44px] flex items-center justify-center`.
4. `CredentialForm.tsx`:
   - `:473` contenitore dell'header: `p-4` diventa `px-4 py-1`. Così l'header resta alto 52 px (4+44+4) invece di 76 (critica).
   - `:476` Indietro: aggiungere `min-h-[44px] pr-2`.
   - `:483` cestino, stringa finale: `flex items-center justify-center gap-1 min-h-[44px] min-w-[44px] text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400 text-sm transition-colors`, più `aria-label={t('common.delete')}` (chiave esistente).
   - `:458`: `className="mt-4 min-h-[44px]"`.
   - `:497`, `:500`: `className="min-h-[44px]"`.
   - `:581`, `:680`: `p-1.5` diventa `min-h-[44px] min-w-[44px] flex items-center justify-center`.
   - `:601` retake, stringa finale (con D11 = neutral-500): `flex items-center gap-1 min-h-[44px] text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300 transition-colors`. Con D11 = neutral-600: `text-neutral-600 hover:text-neutral-800` al posto della coppia chiara.
   - Input `:570`, `:645`, `:664`: aggiungere `min-h-[44px]`. Su `:664` anche `pr-9` diventa `pr-11`.
   - `:669` occhio, stringa finale: `absolute right-0 inset-y-0 min-w-[44px] flex items-center justify-center text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300`.
- Nessuna stringa nuova. Le varianti `dark:` restano o vengono aggiunte come sopra.

**File e modifiche.**
- `frontend/src/features/vault/VaultPage.tsx`: classi dei chip.
- `frontend/src/components/ui/SortDropdown.tsx`: 44x44.
- `frontend/src/features/vault/CopyButton.tsx`: 44x44.
- `frontend/src/features/vault/CredentialForm.tsx`: header, pulsanti, input, occhio, `aria-label` del cestino.
- `frontend/e2e/vault-a11y.spec.ts`: spec nuovo (condiviso con M.5, M.6 e NoteEditor).

**Criteri di accettazione.**
1. A 320, 375 e 412 px sulla lista vault: ogni chip e il pulsante di ordinamento hanno `getBoundingClientRect` con altezza e larghezza >= 44.
2. Nel CredentialForm: Indietro, cestino, copia (x3), apri URL, generatore, occhio, Annulla ed Elimina della conferma e retake >= 44x44. Input alti >= 44.
3. L'header del CredentialForm resta alto 52 px (± 1).
4. A 320 px nessuno scroll orizzontale: `document.documentElement.scrollWidth <= 320`, sia su `/vault` sia su `/notes`. Su `/notes` il pulsante di ordinamento è >= 44x44.
5. Solo se D9 tiene il reset sui chip: a 1280 px i chip tornano compatti (altezza < 44).
6. `npx tsc -p tsconfig.app.json --noEmit` e `npm run lint` a 0 errori. `VaultPage.test.tsx` e i test del CredentialForm verdi.

**Test unit.** Nessun test nuovo: jsdom non calcola il layout. Si rieseguono i test di VaultPage e CredentialForm.

**Test E2E e Playwright eseguibili in autonomia.** Nuovo `frontend/e2e/vault-a11y.spec.ts`, con setup da `e2e/vault-helpers.ts` (`VAULT_SETUP_USERS` deve includere l'utente di test).
- Per 320x640, 375x667 e 412x915: apre `/vault`, misura chip e ordinamento. Crea una credenziale con `siteUrl`, la apre, attende che il form sia renderizzato (la decifratura è asincrona), poi misura tutti i button e gli input visibili in `main`.
- Stesso controllo di `scrollWidth` su `/notes`.

**Cosa resta manuale e perché.** Tap reale col pollice su Android e iOS: comfort e tap errati fra copia, apri e generatore affiancati. L'emulazione non misura la precisione del dito.

**Rischi.**
- Restano sotto 44, fuori voce: la X di `TagList.tsx:80` (condivisa), il banner "View", il titolo di `VaultNoteEditor`, "Add Tag", la toolbar. Il criterio si limita agli elementi elencati.
- Riga dei chip più alta su mobile: controllare che chip e ordinamento non vadano a capo a 320 px.

### M.5: pulsanti della ConfirmDialog a 40 px e X a 20 px

**Causa verificata.** `frontend/src/components/ui/ConfirmDialog.tsx:32` e `:35` usano `<Button>` senza `size`, quindi `h-10` (`Button.tsx:21`) = 40 px. In `frontend/src/components/ui/Dialog.tsx:54-55` la X non ha padding e misura 20x20. `text-neutral-400` (#94a3b8) su bianco dà 2,56:1, sotto il 3:1 per le icone. Evidenza `M5-evidence.json:70-86`.
- Correzione di un dato della critica: gli importer diretti di `ui/Dialog` sono 5, non 2 (`EncryptedBlockComponent.tsx`, `ConfirmDialog.tsx`, `DeleteConfirmationDialog.tsx`, `InputDialog.tsx`, `BulkArchiveDialog.tsx`; grep del 26/10). `ConfirmDialog` compare in 19 file. Il cambio della X resta comunque piccolo (colore e area di tocco).

**Correzione finale** (opzione B di D10).
1. `ConfirmDialog.tsx:32` e `:35`: `className="min-h-[44px]"` su tutti e due i Button (stesso schema di `CredentialForm.tsx:442`; `cn` è twMerge+clsx e `min-height` vince su `h-10`).
2. `Dialog.tsx:54`: la classe della X `text-neutral-400 hover:text-neutral-600 transition-colors dark:text-neutral-500 dark:hover:text-neutral-300` diventa `-m-3 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-700 transition-colors dark:text-neutral-400 dark:hover:text-neutral-200`. Il `-m-3` compensa i 24 px in più: il layout dei dialog non cambia.
3. Se D10 estende la correzione: `className="min-h-[44px]"` anche in `DeleteConfirmationDialog.tsx:63`, `:66` e `InputDialog.tsx:61`, `:64`.
- `Button.tsx` non si tocca.

**File e modifiche.**
- `frontend/src/components/ui/ConfirmDialog.tsx`: due classi.
- `frontend/src/components/ui/Dialog.tsx`: la X.
- Opzionali (D10): `frontend/src/components/ui/DeleteConfirmationDialog.tsx`, `frontend/src/components/ui/InputDialog.tsx`.
- `frontend/e2e/vault-a11y.spec.ts`: caso del dialog.

**Criteri di accettazione.**
1. In `/settings`, "Rimuovi da questo dispositivo", a 320, 375 e 412 px: Annulla e Conferma alti >= 44. La X "Chiudi" è >= 44x44.
2. In un solo run (sostituisce il confronto con HEAD): altezza dell'header <= altezza dell'`h2` + 1, e il top del primo `<p>` del dialog = bottom dell'header + 16 px (`mb-4`).
3. Contrasto della X (colore dell'svg contro lo sfondo del dialog) >= 3, in chiaro e in `html.dark`.
4. Escape, click sull'overlay e focus trap invariati. I test vitest che montano ConfirmDialog (NoteEditor.vault, VersionHistoryModal, VaultNoteEditor) verdi.

**Test unit.** Nessuno nuovo: jsdom non ha layout. Si rieseguono i test che montano ConfirmDialog e Dialog.

**Test E2E e Playwright eseguibili in autonomia.** In `vault-a11y.spec.ts`: apre la ConfirmDialog della sezione Vault in `/settings`, misura i 3 bottoni, controlla gli assert di layout e il contrasto in chiaro e in scuro, poi Escape e controlla che il dialog sia chiuso.

**Cosa resta manuale e perché.** VoiceOver e TalkBack: l'annuncio del dialog e del pulsante Chiudi non deve cambiare. Serve uno screen reader reale (checklist M.5, passo 7).

**Rischi.**
- `Dialog.tsx` è condiviso: la X diventa un po' più scura. L'area di tocco più grande può coprire 12 px di un titolo lungo vicino alla X.
- `M5-evidence.json:91-93` riporta anche "elementi che sforano" (l'email dell'utente). Non è coperto da questa correzione. Non verificato.

### M.6: toast, testi neutral-400 e tema di sistema

**Causa verificata.**
- (a) `frontend/src/App.tsx:48-52`: toast di successo `#10b981` con testo `#fff`, 2,54:1.
- (b) `neutral` è rimappato su slate (`tailwind.config.js:37-49`): `neutral-400` = #94a3b8, 2,56:1 su bianco. Righe: `CredentialForm.tsx:536` (dominio), `:554`, `:629`, `:701` (intestazioni `h4`), `:601` (retake), `:610` (testo di caricamento), `:483` (cestino), `:669` (occhio); `CredentialCard.tsx:118` (data).
- (c) `frontend/src/store/uiStore.ts:37-46` e `:105`: `applyThemeClass` gira solo all'import e in `setTheme`. Non c'è un listener `change`. Evidenza `M6-theme-evidence.json`: `C_liveAfterOsChange: "dark"` dopo il passaggio dell'OS a light.

**Correzione finale** (con il MAJOR della critica integrato).
- (a) `App.tsx:50`: `'#10b981'` diventa `'#047857'` (emerald-700, 5,48:1; emerald-600 dà 3,77 e non basta).
- (b) Due gruppi di righe:
  - `CredentialForm.tsx:536`, `:554`, `:629`, `:701` e `CredentialCard.tsx:118` hanno già `dark:text-neutral-500`: solo `text-neutral-400` diventa `text-neutral-500`. In scuro non cambia nulla.
  - `CredentialForm.tsx:483`, `:601`, `:610`, `:669` **non** hanno una variante scura del colore base. Qui `text-neutral-400` diventa `text-neutral-500 dark:text-neutral-400`. Senza `dark:text-neutral-400` il tema scuro peggiorerebbe: il retake scenderebbe da ~6,3:1 a ~3,4:1 (MAJOR della critica, verificato sulle classi attuali). Le stringhe finali di `:483`, `:601` e `:669` sono nella sezione M.3. `:610` diventa `flex flex-col items-center gap-2 text-neutral-500 dark:text-neutral-400`.
- (c) In fondo a `uiStore.ts`, dopo `:105`:
  ```ts
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useUIStore.getState().theme === 'system') applyThemeClass('system');
  });
  ```
  Il listener vive quanto l'app: niente cleanup. Niente fallback `addListener`.

**File e modifiche.**
- `frontend/src/App.tsx`: colore del toast.
- `frontend/src/features/vault/CredentialForm.tsx`: colori (insieme a M.3).
- `frontend/src/features/vault/CredentialCard.tsx`: `:118`.
- `frontend/src/store/uiStore.ts`: listener.
- `frontend/src/store/__tests__/uiStore.test.ts`: mock e test.
- `frontend/e2e/vault-a11y.spec.ts`: contrasti e tema.

**Criteri di accettazione.**
1. Toast "Vault sbloccato": rapporto fra `color` e `background` calcolati (`getComputedStyle` sul div del toast) >= 4,5.
2. Nel CredentialForm e nella lista: `h4`, dominio, data e retake >= 4,5, occhio e cestino >= 3. Si misura contro il primo antenato con sfondo opaco, non "su bianco": il retake sta su `bg-neutral-50` (`:557`), dove neutral-500 dà 4,55:1.
3. In `html.dark`: retake e testo di caricamento >= 4,5, occhio e cestino >= 3, sempre contro l'antenato opaco.
4. Con il tema `system` e la pagina aperta: `page.emulateMedia({ colorScheme: 'dark' })` mette `dark` su `html` senza reload. Il ritorno a `light` lo toglie.
5. Con il tema `light` esplicito il cambio dell'OS non tocca la classe.
6. `npx vitest run src/store/__tests__/uiStore.test.ts` verde, tsc e lint a 0.

**Test unit** (`uiStore.test.ts`).
- Il mock in `vi.hoisted` (righe 5-16) diventa stateful: `matches` modificabile e `addEventListener` che salva la callback.
- Test 1: `setTheme('system')`, `matches=true`, callback: `documentElement` ha `dark`. `matches=false`, callback: `light`.
- Test 2: `setTheme('light')`, `matches=true`, callback: la classe resta `light`.
- Il test 1 fallisce col codice vecchio (callback mai registrata).
- Rischio verificato dalla critica: solo `uiStore.test.ts` carica il modulo vero, con un mock che ha già `addEventListener`. Gli altri test che citano uiStore lo mockano. Oggi il modulo chiama già `matchMedia` all'import (il tema di default è `'system'`, `uiStore.ts:65`), quindi il rischio all'import non è nuovo.

**Test E2E e Playwright eseguibili in autonomia.** In `vault-a11y.spec.ts`:
- Helper di contrasto in `page.evaluate`: luminanza WCAG da `getComputedStyle(el).color` e dal primo antenato con `backgroundColor` non trasparente.
- Sblocca il vault, attende il toast di successo, assert >= 4,5.
- Apre una credenziale: assert >= 4,5 sulle `h4` e >= 3 sugli svg di occhio e cestino. Stessa cosa sulla data della `CredentialCard`. Ripete in `html.dark`.
- Tema: imposta `system` da `/settings`, poi `emulateMedia` dark, controlla `html.className`, poi `emulateMedia` light e controlla che `dark` sparisca.

**Cosa resta manuale e perché.**
- Cambio reale del tema dell'OS con la PWA installata e aperta. `emulateMedia` non passa dall'evento vero dell'OS né dal ciclo standalone della PWA.
- Giudizio estetico del verde più scuro del toast (facoltativo).

**Rischi.**
- In scuro `dark:text-neutral-500` su neutral-900 vale ~3,7: sotto 4,5 per testo piccolo. È fuori voce e non cambia.
- Restano fuori voce: il banner "View" (2,41) e "Add Tag" in `VaultNoteEditor` (2,56). Il toast in scuro resta bianco (default di react-hot-toast).
- `DatePicker.tsx:23` legge `matchMedia` una volta sola e non segue il cambio dell'OS. Non è coperto dal listener.

### Contrasti di NoteEditor

**Causa verificata.** Blocco azioni desktop `hidden md:flex` (`frontend/src/features/notes/NoteEditor.tsx:624`), header `bg-white dark:bg-neutral-900` (`:604`).
- `:753`, `:785`, `:787`, `:789`: icona inattiva `text-neutral-400`, 2,56:1, sotto il 3:1 per i componenti UI (WCAG 1.4.11).
- `:752` e `:785` attivi: `amber-500` su `amber-50`, ~2,07:1. Anche l'hover.
- `:787` attivo: `emerald-500` su `emerald-50`, 2,41:1.
- `:785`, `:787`, `:789`: `hover:bg-amber-50`, `hover:bg-emerald-50`, `hover:bg-red-50` senza `dark:`. In scuro compare una macchia chiara (`:753` invece ce l'ha).
- I target da 36 px non sono un difetto qui: il blocco è solo desktop.
- `NoteEditor.tsx` non è TIER (lo è `Editor.tsx`).

**Correzione finale** (solo classi; con D12 = A e allineamenti raccomandati).
- `:752` attivo: `text-amber-500 bg-amber-50 dark:bg-amber-900/20` diventa `text-amber-600 bg-amber-50 dark:text-amber-500 dark:bg-amber-900/20` (3,07:1).
- `:753` inattivo: diventa `text-neutral-500 hover:text-amber-600 hover:bg-amber-50 dark:text-neutral-400 dark:hover:text-amber-500 dark:hover:bg-amber-900/20` (4,76:1).
- `:785` (pin): le stesse due stringhe per il ramo attivo e quello inattivo.
- `:787` (vault): attivo `text-emerald-600 bg-emerald-50 dark:text-emerald-500 dark:bg-emerald-900/20` (3,58:1); inattivo `text-neutral-500 hover:text-emerald-600 hover:bg-emerald-50 dark:text-neutral-400 dark:hover:text-emerald-500 dark:hover:bg-emerald-900/20`.
- `:789` (cestino): `p-2 rounded-full transition-colors text-neutral-500 hover:bg-red-50 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-red-900/20 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed`.
- Se D12 lo conferma: `:690`, `:700` e il ramo inattivo di `:719` passano da `text-neutral-400` a `text-neutral-500 dark:text-neutral-400`.
- Se D12 lo conferma: `frontend/src/features/vault/VaultNoteEditor.tsx:309` e `:341` ricevono le stesse due stringhe di `:752`/`:753`.
- In scuro: neutral-400 su #141822 dà ~6,9:1.

**File e modifiche.**
- `frontend/src/features/notes/NoteEditor.tsx`: classi alle righe 752-753, 785, 787, 789 (e 690, 700, 719 con D12).
- Con D12: `frontend/src/features/vault/VaultNoteEditor.tsx` righe 309 e 341.
- `frontend/e2e/vault-a11y.spec.ts`: caso a 1280 px.

**Criteri di accettazione.**
1. A 1280 px su una nota normale: promemoria, pin, vault e cestino hanno contrasto fra il colore dell'svg e lo sfondo effettivo >= 3 a riposo e in hover, in chiaro e in scuro.
2. Stati attivi: solo pin e promemoria, >= 3, in chiaro e in scuro. Lo stato "vault attivo" non si misura: dall'interfaccia NoteEditor non lo mostra mai (`NotesPage.tsx:81-86` chiude l'editor di una nota vault, e `NoteEditor.tsx:997` porta a `/vault`). Il ramo di `:787` si corregge comunque.
3. In scuro, durante l'hover di pin, vault e cestino, lo sfondo del bottone non è `amber-50`, `emerald-50` o `red-50` (rgb 255,251,235 / 236,253,245 / 254,242,242).
4. `NoteEditor.vault.test.tsx` e `NoteEditor.collabGuard.test.tsx` verdi. tsc e lint a 0.

**Test unit.** Nessuno: cambiano solo classi. Si rieseguono i test di NoteEditor.

**Test E2E e Playwright eseguibili in autonomia.** Nuovo caso in `vault-a11y.spec.ts` a 1280x800.
- Prima di misurare: `page.addStyleTag({ content: '* { transition: none !important }' })`. Senza, `getComputedStyle` subito dopo `page.hover` legge un colore intermedio (150 ms di `transition-colors`).
- Crea una nota, misura le 4 icone a riposo e in hover. Pinna la nota e imposta un promemoria via REST (oppure con `locator.evaluate` sull'input nascosto di `:768-779` più l'evento `change`: `showPicker` non si usa in Playwright). Rimisura. Ripete con `html.dark`.
- Assert `>= 3.0` sul rapporto arrotondato a 2 decimali. Stesso helper di M.6.

**Cosa resta manuale e perché.** Il giudizio visivo della stella e della campana in `amber-600`. È una scelta estetica.

**Rischi.**
- `amber-600` su `amber-50` è 3,07:1, al limite della soglia.
- Il menu mobile "more" (`:794` e seguenti) e il bottone chat `:798` hanno problemi simili. Non verificati, fuori voce.

### TransformToKanbanModal: riga stantia di useLiveQuery

**Causa verificata.** Lo schema stantio esiste, ma oggi non si raggiunge dall'interfaccia.
- `useLiveQuery` (via `useObservable`) conserva il risultato delle deps precedenti finché la query nuova non emette (`frontend/node_modules/dexie-react-hooks/src/useObservable.ts:46-50`, `:57-101`, `:107-116`). Le tre query di `frontend/src/components/editor/TransformToKanbanModal.tsx:47-62` hanno deps `[selectedBoardId]` e non riportano l'id letto.
- Ogni cambio di board però passa da `selectedBoardId=''`: il modale si monta a ogni apertura (`Editor.tsx:625-632`, `:674-681`), Back fa `setSelectedBoardId('')` (`:308-311`), e anche `handleNewBoardConfirm` parte da `''` (`:143`). Con `''` la query risolve undefined nei microtask, prima del click successivo.
- Impatto se la gara accadesse (con un passaggio diretto A→B): le card finirebbero nella colonna della board A, mentre toast e navigazione indicano B (`kanbanService.ts:327-339` ricava `boardId` dalla colonna). Dato nel posto sbagliato, non corrotto.
- Classificazione: difetto latente LOW, da correggere come irrobustimento (D13 = A).

**Correzione finale.** Lo stesso schema di `VaultPage.tsx:390-395`, con UNA query al posto di tre. Le tre tabelle si leggono in sequenza con `await` (precedenti: `hooks/useNotebooks.ts:15-17`, `VaultPage.tsx:323`).
```ts
const q = useLiveQuery(async () => (selectedBoardId ? {
  id: selectedBoardId,
  columns: await db.kanbanColumns.where('boardId').equals(selectedBoardId).sortBy('position'),
  cards: await db.kanbanCards.where('boardId').equals(selectedBoardId).toArray(),
  board: await db.kanbanBoards.get(selectedBoardId),
} : undefined), [selectedBoardId]);
// useLiveQuery keeps the previous deps' result until the new query emits: use it only if it is the selected board's
const live = q && q.id === selectedBoardId ? q : undefined;
const liveColumns = live?.columns;
const liveCards = live?.cards;
const liveBoard = live?.board;
```
- Le righe 64-73 non cambiano. I tipi restano (`liveColumns` è `LocalKanbanColumn[] | undefined`).
- Scartate: tre wrapper separati (triplo del codice) e `key={selectedBoardId}` su un sottocomponente (ristruttura il modale).

**File e modifiche.**
- `frontend/src/components/editor/TransformToKanbanModal.tsx`: righe 47-62.
- `frontend/src/components/editor/__tests__/TransformToKanbanModal.test.tsx`: file nuovo.
- Consigliato: nuovo `frontend/e2e/kanban-transform.spec.ts` di non-regressione (nessuno spec copre la conversione; `e2e/kanban.spec.ts` no).

**Criteri di accettazione.**
1. Con la query di B non ancora emessa, il modale non mostra mai colonne o conteggi della board precedente: mostra `common.loading` oppure le colonne di `boardDetail` di B.
2. `createCard.mutateAsync` riceve solo `columnId` della board selezionata.
3. Comportamento invariato: una board nuova creata nel modale mostra subito le colonne da Dexie (il caso del commento di `:41-46`), il controllo dei duplicati funziona, il toast ha il titolo giusto.
4. `cd frontend && npx vitest run src/components/editor/__tests__/TransformToKanbanModal.test.tsx`: PASS col fix, FAIL con `git stash` del solo `TransformToKanbanModal.tsx`.
5. `npx tsc -p tsconfig.app.json --noEmit` pulito, `npm run lint` a 0, `npx vitest run` completa verde.

**Test unit** (file nuovo).
- Mock di `dexie-react-hooks.useLiveQuery`: tiene il valore in `useState` e chiama `fn()` a ogni cambio di deps. Se `h.hold.has(String(deps[0]))` aspetta la promise del gate prima di `setV`. Ha la flag di cancellazione di `VaultPage.test.tsx:49` (`let c = false; ... if (!c) setV(r); return () => { c = true; }`): senza, il rilascio tardivo di `''` cancellerebbe le colonne di B.
- Mock di `react-i18next`: `t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k`. Senza `defaultValue` le colonne custom comparirebbero come `kanban.column.custom` (`:291`) e il test 1 passerebbe anche col codice vecchio (MAJOR della critica, verificato).
- Altri mock: `../../lib/db`, `useKanbanBoards` (board A e B), `useKanbanBoard` (`{ data: undefined, isLoading: true }`), `useKanbanMutations` (`createCard.mutateAsync = vi.fn()`, `createBoard`), `useNavigate`, `react-hot-toast`. Se `useFocusTrap` dà problemi in jsdom, mockare `../../ui/Modal` con un passthrough dei children.
- Test 1 (discrimina): click su A, attesa di "ColA", Back con gate su `''` tenuto, click su B con gate su B tenuto. Atteso: `queryByText('ColA')` null e `common.loading` visibile.
- Test 2 (discrimina): con B ancora tenuto, `queryByRole('button', { name: /ColA/ })` null e `createCard.mutateAsync` mai chiamata. Poi rilascio di B, click su "ColB": chiamata con `columnId` `'colB'`.
- Test 3 (non-regressione): da `''` si sceglie A senza gate. Colonne da Dexie e conteggi corretti.

**Test E2E e Playwright eseguibili in autonomia.** Sono di **non-regressione**: non riproducono la gara, perché ogni cambio di board passa da `''` (righe 31, 82, 143, 308-311). Servono backend :3001 e Vite :5173.
- Login, due board A e B, una nota con una lista di 2 elementi, selezione, "Trasforma in Kanban", scelta di A, Back, scelta di B, prima colonna, "Mantieni". URL `/kanban?boardId=B`. Con `GET /api/kanban/boards/<B>`: le 2 card sono in B, A non ha card nuove.
- Stesso flusso con una board nuova creata nel modale: le colonne compaiono subito e le card finiscono nella board nuova.

**Cosa resta manuale e perché.** Niente. La gara non si riproduce dall'interfaccia: la copre il test unitario con il gate.

**Rischi.**
- Un cambio in `kanbanCards` ora rilancia anche la lettura di colonne e board. Costo trascurabile.
- Il test dipende da un mock che imita `useObservable`. Se `dexie-react-hooks` cambiasse semantica, il test non lo vedrebbe.
- Non verificati: `TransformToTaskListModal` e altri `useLiveQuery` fuori dal vault con lo stesso schema.

## 6. Avviso multi-file

Il piano tocca più di 3 file. Elenco completo. "Opz." = dipende da una decisione.

**Backend**

| File | Voce | Tipo di modifica |
|---|---|---|
| `backend/src/services/note.service.ts` | I.8 | logica: guard + archivio + flag; niente snapshot nv3 |
| `backend/src/services/__tests__/note.service.test.ts` | I.8 | test nuovi, test di `:625` aggiornato |
| `backend/src/services/vault.service.ts` | B.15 | `_count.attachments`, `hasAttachments` |
| `backend/src/__tests__/vault.items.test.ts` | B.15 | mock e assert |
| `backend/src/services/sharing.service.ts` | I.8 (opz. D4) | archivio del testo scartato dal guard |
| `backend/src/services/__tests__/sharing.service.test.ts` | I.8 (opz. D4) | test nuovi |

**Frontend, codice**

| File | Voce | Tipo di modifica |
|---|---|---|
| `frontend/src/features/sync/syncService.ts` | I.8 (opz. D2, **TIER1**) | GET del content al passaggio vault→normale |
| `frontend/src/locales/en.json` | I.8, H.3, A.3, B.15 | 1 testo cambiato, 4 chiavi nuove |
| `frontend/src/locales/it.json` | I.8, H.3, A.3, B.15 | 1 testo cambiato, 4 chiavi nuove |
| `frontend/src/utils/format.ts` | F.10 | nuovo helper `toDatetimeLocal` |
| `frontend/src/features/notes/NoteEditor.tsx` | F.10, contrasti | 2 value del promemoria; classi colore |
| `frontend/src/features/vault/VaultNoteEditor.tsx` | F.10 (+ opz. D12) | value del promemoria; classi `:309`, `:341` |
| `frontend/src/components/layout/SyncStatusIndicator.tsx` | H.3 | toast e banner per gli item `vault:*` |
| `frontend/src/features/vault/VaultPage.tsx` | J.7, A.3, M.3 | `needIds` (T-h); Gate `setupDisabled`; classi dei chip |
| `frontend/src/features/vault/CredentialForm.tsx` | H.13, M.3, M.6 | idratazione nel lock; classi 44 px; colori |
| `frontend/src/features/vault/VaultMigrate.tsx` | B.5, B.15 | PIN svuotato, countdown; avviso allegati |
| `frontend/src/features/vault/vaultMigration.ts` | B.15 | `withAttachments` |
| `frontend/src/components/ui/SortDropdown.tsx` | M.3 | classi 44x44 |
| `frontend/src/features/vault/CopyButton.tsx` | M.3 | classi 44x44 |
| `frontend/src/components/ui/ConfirmDialog.tsx` | M.5 | `min-h-[44px]` |
| `frontend/src/components/ui/Dialog.tsx` | M.5 | X 44x44 e colore |
| `frontend/src/components/ui/DeleteConfirmationDialog.tsx` | M.5 (opz. D10) | `min-h-[44px]` |
| `frontend/src/components/ui/InputDialog.tsx` | M.5 (opz. D10) | `min-h-[44px]` |
| `frontend/src/App.tsx` | M.6 | colore del toast |
| `frontend/src/features/vault/CredentialCard.tsx` | M.6 | colore `:118` |
| `frontend/src/store/uiStore.ts` | M.6 | listener `matchMedia` |
| `frontend/src/components/editor/TransformToKanbanModal.tsx` | TKM | una query con guardia sull'id |

**Frontend, test unit**

| File | Voce | Tipo di modifica |
|---|---|---|
| `frontend/src/features/sync/__tests__/syncService.test.ts` | I.8 (opz. D2) | test del pull |
| `frontend/src/utils/__tests__/format.test.ts` | F.10 | test indipendenti dalla TZ |
| `frontend/src/utils/__tests__/format.tz.test.ts` | F.10 | file nuovo |
| `frontend/src/features/vault/__tests__/VaultNoteEditor.test.tsx` | F.10 (opz.) | un assert |
| `frontend/src/components/layout/__tests__/SyncStatusIndicator.test.tsx` | H.3 | 3 test |
| `frontend/src/features/vault/__tests__/VaultPage.test.tsx` | J.7, A.3 | test T-h; 2 casi aggiornati |
| `frontend/src/features/vault/__tests__/CredentialForm.test.tsx` | H.13 | mock e 4 casi |
| `frontend/src/features/vault/__tests__/VaultMigrate.test.tsx` | B.5, B.15 | casi nuovi |
| `frontend/src/features/vault/__tests__/vaultMigration.test.ts` | B.15 | conteggio |
| `frontend/src/store/__tests__/uiStore.test.ts` | M.6 | mock stateful e 2 test |
| `frontend/src/components/editor/__tests__/TransformToKanbanModal.test.tsx` | TKM | file nuovo |

**Frontend, E2E**

| File | Voce | Tipo di modifica |
|---|---|---|
| `frontend/e2e/vault-offline.spec.ts` | I.8 | test nuovi |
| `frontend/e2e/reminder-timezone.spec.ts` | F.10 | file nuovo |
| `frontend/e2e/vault-conflict.spec.ts` | H.3 | assert sul banner |
| `frontend/e2e/vault-multidevice.spec.ts` | J.7 | test nuovo |
| `frontend/e2e/vault-a11y.spec.ts` | M.3, M.5, M.6, contrasti | file nuovo |
| `frontend/e2e/kanban-transform.spec.ts` | TKM (consigliato) | file nuovo, non-regressione |

**Documenti**

| File | Voce | Tipo di modifica |
|---|---|---|
| `docs/superpowers/plans/2026-10-22-vault-t15-reconcile-spec.md` | J.7 | Addendum 4 (prima del codice) |

**Solo locali** (`frontend/manual-p2/`, ignorata da git): `lotto-R07g-out.spec.ts` (I.8), `lotto-R06c.spec.ts` (H.13), `lotto-09c-b4b5.spec.ts` (B.5), `lotto-R09f-b14b15b16m4.spec.ts` (B.15), `lotto-10c-a3.spec.ts` (A.3). `lotto-09e-b9b10b11.spec.ts` (B.11) si rilancia senza modifiche.

**Totale:** 45 file versionati, di cui 8 dipendono da una decisione o sono consigliati (sharing.service e il suo test, syncService.ts e il suo test, DeleteConfirmationDialog, InputDialog, l'assert in VaultNoteEditor.test, kanban-transform.spec). Con tutte le raccomandazioni di D2, D4 e D10 i file versionati sono 44 (l'assert opzionale di F.10 resta fuori). In più 5 spec locali.

## 7. Ordine di implementazione consigliato

Prima si raccolgono le decisioni D1-D13. Poi un commit per voce (o per gruppo piccolo), con gate e push dopo ogni commit.

1. **Perdita di dati: I.8.**
   - Prima il backend (`note.service.ts`, poi `sharing.service.ts` se D4 = a) con i test unit.
   - Poi, se D2 = b, il diff TIER1 di `syncService.ts`: proposta all'utente, conferma, Edit.
   - Poi i18n ed E2E.
   - Gate: con `syncService.ts` in staging è `hardRisk` → `reviewer` + `red-team` in parallelo.
2. **Difetti funzionali.**
   - J.7: prima l'Addendum 4 della spec, poi `VaultPage.tsx`.
   - H.13.
   - F.10.
   - B.5.
   - TransformToKanbanModal.
3. **UI (testi e avvisi).** H.3, A.3, B.15 (backend e frontend insieme). B.11 si chiude come accettato se D7 = a.
4. **Accessibilità.** M.3 e M.6 insieme (stesse righe di `CredentialForm.tsx`, stringhe finali già unite), poi M.5, poi i contrasti di NoteEditor. Lo spec `vault-a11y.spec.ts` cresce a ogni passo.

Ai revisori si passano solo la spec della voce e l'istruzione di leggere `git diff --staged`.

## 8. Verifiche finali

Tutto in locale. **Mai PROD.**

1. **Ambiente.**
   - Docker Desktop avviato, container `notiq-db` su 5433. `docker compose down` se un backend Docker occupa la 3001.
   - Sink SMTP: `node frontend/manual-p2/lib/smtp-sink.mjs` (ascolta su `127.0.0.1:2525`).
   - Backend :3001 con le variabili SMTP verso il sink nell'ambiente del solo processo: `SMTP_HOST=127.0.0.1`, `SMTP_PORT=2525`, `SMTP_SECURE=false`. dotenv non sovrascrive le variabili già presenti. `VAULT_SETUP_USERS=*` nel `backend/.env` di dev.
   - Vite :5173.
2. **Frontend.** `cd frontend`:
   - `npx vitest run`: tutto verde (base 1160/1160 più i test nuovi).
   - `npx tsc -p tsconfig.app.json --noEmit`: pulito.
   - `npm run lint`: 0 errori.
3. **Backend.** `cd backend`:
   - `npm test`: verde.
   - `npm run lint`: 0 errori.
   - `npm run build`: compila (i test backend non sono typechecked).
4. **E2E.** `cd frontend; npx playwright test`: suite completa.
   - I fallimenti noti `collaboration.spec.ts:249` e `auth.spec.ts:41` non si archiviano come instabili senza la prova con `git stash` su `main` pulito.
   - Rilanci mirati: `e2e/vault-*.spec.ts`, `e2e/reminder-timezone.spec.ts`, `e2e/vault-a11y.spec.ts`, `e2e/kanban.spec.ts`, `e2e/notes.spec.ts`, `e2e/offline-first.spec.ts`.
5. **Prove locali** in `frontend/manual-p2/`: `lotto-R07g-out`, `lotto-R06c`, `lotto-09c-b4b5`, `lotto-09e-b9b10b11`, `lotto-R09f-b14b15b16m4`, `lotto-10c-a3`.
6. **Prove manuali residue** (solo quelle impossibili in autonomia, ognuna col motivo scritto nella sua voce): telefono in modalità aereo (I.8), picker nativo e notifica (F.10), tap reale (M.3), screen reader (M.5), tema reale dell'OS con la PWA installata (M.6), giudizi estetici (M.6, contrasti di NoteEditor) e chiarezza dei testi (H.3).
