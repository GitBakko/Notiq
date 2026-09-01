# Offline-first mutations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: usa `superpowers:subagent-driven-development` per eseguire questo piano task-per-task. Gli step usano checkbox (`- [ ]`).

**Goal:** Far sì che le 31 mutation local-first dell'app scrivano davvero su Dexie quando la rete non c'è, senza cambiare comportamento alle 36 network-only, e senza che il delete offline si annulli da solo alla riconnessione.

**Architecture:** Opt-in esplicito, non default globale. Una costante condivisa `LOCAL_FIRST` (`{ networkMode: 'always' }`) viene spread nelle mutation e nelle query che leggono dati locali. Le network-only restano sul default della libreria. In più, tre correzioni al motore di sync che l'opt-in rende raggiungibili, e un fallback Dexie sulla board kanban senza il quale il fix resta invisibile all'utente.

**Tech Stack:** TanStack Query 5.90.21 · Dexie 4 · React 19 · Vitest · Playwright.

**Spec:** L'audit è nel ledger SDD `.superpowers/sdd/2026-08-31-kanban-hardening/progress.md` (sezione "DUE BUG PREESISTENTI CONFERMATI") e nell'output del workflow `wontz8h37`: 74 mutation classificate leggendo la funzione di servizio dietro ciascuna — 31 local-first, 36 network-only, 7 mixed — tre design indipendenti, un giudizio e una verifica avversariale che ha restituito NEEDS_CHANGES con cinque rotture. Questo piano è il design vincente **con le cinque correzioni incorporate**.

---

## Il bug, detto con precisione

`frontend/src/lib/queryClient.ts` non imposta `networkMode`, quindi vale il default v5 `'online'`. In `@tanstack/query-core@5.90.20`, `retryer.js`: `start()` chiama `pause().then(run)` quando `canFetch()` è falso, e `canFetch` sotto `'online'` ritorna `onlineManager.isOnline()`. **La `mutationFn` non viene invocata affatto** — indipendentemente dal fatto che faccia o no una chiamata di rete.

Due precisazioni che cambiano la diagnosi e che l'audit iniziale aveva sbagliato:

1. **È intermittente, non deterministico.** `onlineManager` non si inizializza mai da `navigator.onLine`: costruisce con `#online = true` e cambia solo sugli eventi `online`/`offline` della finestra. Una PWA avviata dalla home screen senza rete **crede di essere online**: le mutation partono e falliscono con errore di rete. La pausa avviene solo se un evento `offline` è scattato durante la sessione. Esistono quindi **due modalità di guasto visibilmente diverse**, e il fix deve unificarle.
2. **Una mutation in pausa è differita, non persa.** `QueryClient.mount()` collega `mutationCache.resumePausedMutations()` a `onlineManager`, quindi alla riconnessione riparte. Persa davvero solo se la tab si chiude prima. Il danno è "non fa nulla ora, poi agisce fuori contesto" — che su un delete è peggio di un errore.

---

## Global Constraints

- **Branch:** `fix/kanban-hardening` (stesso branch: questo lavoro dipende dalla `MutationCache` introdotta dal task 0.1 e tocca gli stessi file).
- **TIER 1:** `frontend/src/features/sync/syncService.ts` e `frontend/src/lib/db.ts`. Un cambio per commit, verificato da solo.
- **i18n:** ogni stringa utente in `en.json` **e** `it.json`. Questo piano non dovrebbe introdurne (vedi Task 3).
- **Typecheck frontend:** `cd frontend && npx tsc -p tsconfig.app.json --noEmit`. Il `tsc --noEmit` liscio **non compila nulla** e non è verifica valida.
- **Baseline da mantenere:** frontend `15 files / 170 tests`, backend `63 files / 1148 tests`, e2e `9/9`.
- **Commit:** `fix(offline): ...`, `test(offline): ...`, imperativo, minuscolo dopo i due punti.

---

## Ordine e dipendenze

L'ordine non è negoziabile e il motivo è che **l'opt-in rende raggiungibili bug oggi irraggiungibili**. Oggi il delete offline di un notebook non avviene mai (la mutation è in pausa); dopo il Task 3 avviene — e senza il Task 1 si annullerebbe da solo.

```
1. Guardie anti-resurrezione in syncPull      ⚠️ TIER 1 — PRIMA di tutto
2. deleteColumn: enqueue incondizionato         (no-op silenzioso reso raggiungibile)
3. LOCAL_FIRST su 31 mutation + 4 query         il fix vero
4. syncPush: guardia offline + break            ⚠️ TIER 1
5. Riconnessione: invalidare dopo syncPush      (la corsa dei 30 secondi)
6. useKanbanBoard: fallback Dexie               senza questo il fix è invisibile
7. e2e con setOffline(true) vero
8. Riga di convenzione in CLAUDE.md
```

---

## Registro avanzamento

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [x] | **1** | Guardie anti-resurrezione per notebook e tag in `syncPull` | `c5eed28` |
| [x] | **2** | `deleteColumn`: accodare il DELETE anche se la riga locale non c'è | `598aa41` |
| [x] | **3** | `LOCAL_FIRST` sulle 31 mutation local-first e sulle 4 query Dexie | `80739ba` |
| [x] | **4** | `syncPush`: guardia offline e uscita dal ciclo sul guasto di trasporto | `c93760c..eda6fc0` |
| [x] | **5** | Invalidare la board dopo `syncPush`, non solo nell'`onSuccess` | `c062aba..fdeb934` |
| [x] | **6** | `useKanbanBoard`: ricostruire la board da Dexie quando la GET fallisce | `4754b09..9a4aae5` |
| [x] | **7** | e2e offline reale con `setOffline(true)` | `0e74d57` |
| [x] | **8** | Convenzione in CLAUDE.md | `cbedc3d` |

---

### Task 1: Guardie anti-resurrezione per notebook e tag in `syncPull`

**Perché:** `syncPull` protegge ogni entità dal re-inserire una riga cancellata localmente il cui DELETE è ancora in coda — note (`:91-98`), note condivise (`:148`), task list (`:208`), task item (`:215`), board (`:312-319`), colonne (`:363`), card (`:369`). **Notebook (`:20`) e tag (`:40`) no:** le loro transazioni non aprono nemmeno `db.syncQueue`. Il filtro esistente esclude solo le righe *locali sporche*, e una riga cancellata localmente non è sporca — non esiste. Quindi viene rimessa dal `bulkPut` con `syncStatus: 'synced'`.
Oggi è irraggiungibile perché la mutation di delete è in pausa offline. Il Task 3 la rende raggiungibile: cancelli un notebook offline, riconnetti, `useSync.runSync` fa `syncPull()` **prima** di `syncPush()`, la GET lo restituisce ancora, e ricompare. Sparisce di nuovo ~30s dopo, o **mai** se il DELETE va terminale.

**Severità:** critical · **Effort:** M · **Rischio:** ⚠️ **TIER 1** — commit isolato.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts` (blocchi notebook e tag)
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts`

- [ ] **Step 1 — Leggere il pattern che funziona già.** Aprire il blocco note a `syncService.ts:91-98` e capire come costruisce il set `pendingDeleteIds` da `db.syncQueue` e lo filtra fuori dal `bulkPut`. Va replicato, non reinventato.
- [ ] **Step 2 — Test che fallisce.** Per notebook e per tag: una riga presente nella risposta server, un DELETE per quella riga in `syncQueue`, e l'asserzione che il `bulkPut` **non** la contenga. Deve fallire oggi.
- [ ] **Step 3 — Eseguire e vedere fallire.** `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts` — il fallimento deve mostrare la riga resuscitata, non un errore di mock.
- [ ] **Step 4 — Aggiungere `db.syncQueue` a entrambe le transazioni e i due filtri**, sullo stampo del blocco note.
- [ ] **Step 5 — Verde + suite intera + typecheck.**
- [ ] **Step 6 — Commit.** `fix(offline): stop syncPull resurrecting locally deleted notebooks and tags`

---

### Task 2: `deleteColumn` — accodare il DELETE anche se la riga locale non c'è

**Perché:** `kanbanService.ts:258` fa `if (!column) return;` **dentro** la transazione, prima dell'enqueue. Oggi irraggiungibile a mutation in pausa; dopo il Task 3, su un avvio offline a freddo, la funzione risolve con successo **senza aver fatto nulla**: nessun delete locale, nessun DELETE server, `onSuccess` scatta, la UI dichiara riuscito. È la terza istanza di una classe già corretta due volte in questo repo (`deleteCard` v1.10.2, `moveCard` 2026-08-31).

**Severità:** high · **Effort:** S · **Rischio:** nessun file TIER 1.

**File:**
- Modifica: `frontend/src/features/kanban/kanbanService.ts` (`deleteColumn`)
- Modifica: `frontend/src/features/kanban/__tests__/kanbanService.test.ts`

- [ ] **Step 1 — Test che fallisce:** `deleteColumn` con riga locale assente deve comunque accodare il DELETE. Rosso oggi.
- [ ] **Step 2 — Eseguire e vedere fallire.**
- [ ] **Step 3 — Spostare l'enqueue fuori dal ramo di uscita anticipata.** Verificare che `syncPull:363` protegga già il DELETE accodato risultante (lo fa) e dirlo nel report.
- [ ] **Step 4 — Verde + suite + typecheck.**
- [ ] **Step 5 — Commit.** `fix(kanban): enqueue the column DELETE even when the local row is gone`

---

### Task 3: `LOCAL_FIRST` sulle 31 mutation local-first e sulle 4 query Dexie

**Perché:** è il fix. Opt-in esplicito e greppabile invece di un default globale, perché un default `'always'` cambierebbe il comportamento di 36 mutation network-only che nessuno ha segnalato come rotte, e in due casi (`deleteCover`, `deleteAvatar`) lo peggiorerebbe.
**Le due metà sono accoppiate:** anche con le mutation sbloccate, l'`onSuccess → invalidateQueries` punta a query Dexie-backed che sono **anch'esse in pausa**, quindi il refetch non gira e la lista non si aggiorna. Le 4 query vanno nello stesso commit.

**Severità:** critical · **Effort:** M · **Rischio:** nessun TIER 1, ma tocca ~13 file.

**File:**
- Crea: `frontend/src/lib/networkMode.ts` (la costante, con il commento che spiega il perché e la via d'uscita)
- Modifica: i 9 file con mutation local-first, più i file delle 4 query Dexie-backed. ⚠️ La mappa del workflow elenca 13 file, ma 4 di essi (`syncService.ts`, `useSync.ts`, `CommandMenu.tsx`, `NoteEditor.tsx`) NON contengono alcun `useMutation` — sono osservazioni su query e plumbing registrate con lo stesso schema. Verificato dal controller: `grep -c "useMutation"` = 0 su tutti e quattro
- Modifica: `frontend/src/lib/__tests__/queryClient.test.ts`

- [ ] **Step 1 — La costante.** Un `export const LOCAL_FIRST = { networkMode: 'always' } as const;` con un commento che dice: cosa fa, perché è opt-in e non default, e la via d'uscita se un giorno si vuole invertire (flip del default + inversione della costante).
- [ ] **Step 2 — Due test che pinnano il comportamento vero**, non la configurazione. Con `MutationObserver` e `onlineManager.setOnline(false)`: con la costante la `mutationFn` **gira**, senza la costante **non gira** e `isPaused` è vero. Il secondo test fissa il bug stesso: se TanStack cambiasse la semantica di `canFetch`, lo dice il test invece degli utenti.
  ⚠️ **Non usare il `queryClient` singleton importato:** non è montato in unit test, quindi `resumePausedMutations` non è collegato e la mutation in pausa resta pendente per sempre nella cache condivisa. Costruire un `new QueryClient()` usa e getta per questi due test, oppure ripulire la cache nel `finally`.
- [ ] **Step 3 — Eseguire e vedere il secondo test fallire** se si aggiunge la costante prima del tempo: serve a provare che il test discrimina.
- [ ] **Step 4 — Applicare `...LOCAL_FIRST` alle 31 mutation local-first e alle 4 query Dexie-backed.** Nessun'altra modifica: niente swap a `useLiveQuery` (`getNotebooks`/`getTags` sono `orderBy('name').toArray()` **senza filtro userId**, mentre `useNotebooks`/`useTags` filtrano per utente — sarebbe un cambio di semantica dentro il fix di un altro bug).
- [ ] **Step 5 — Verde + typecheck + lint.**
- [ ] **Step 6 — Commit.** `fix(offline): run local-first mutations and dexie queries while offline`

---

### Task 4: `syncPush` — guardia offline e uscita dal ciclo sul guasto di trasporto

**Perché:** con le mutation sbloccate, ogni modifica offline atterra in `syncQueue` — la coda si riempie molto più di prima. Il ciclo a `:612` itera l'intera coda senza ricontrollare la rete, e il `catch` a `:831-862` manda qualsiasi errore senza `error.response` in `recordFailure` → a `MAX_RETRIES = 5` → `status: 'failed'`, che `:615` salta **per sempre**. Una caduta di rete all'item 1 di 60 brucia un tentativo su tutti e 60.
Servono **entrambe** le metà: la guardia all'ingresso su `!navigator.onLine`, e il `break` a metà ciclo quando un errore non ha `response` (guasto di trasporto, non risposta del server).
**I tre test a `:1457/:1480/:1499` asseriscono il comportamento sbagliato** (rigettano con un `Error` nudo e verificano che i tentativi si incrementino). Riscriverli è lo scopo del fix, non il suo costo.

**Severità:** high · **Effort:** M · **Rischio:** ⚠️ **TIER 1** — commit isolato.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts` (`syncPush`)
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` (inclusi i tre test da riscrivere)

- [ ] **Step 1 — Test che fallisce:** coda di 3 item, il primo rigetta con un errore senza `response`; asserire che gli item 2 e 3 **non** siano stati tentati e che i loro `attempts` siano invariati.
- [ ] **Step 2 — Eseguire e vedere fallire** (oggi tutti e tre bruciano un tentativo).
- [ ] **Step 3 — Guardia d'ingresso + `break`.** La guardia va sopra `isSyncing`. Lasciare un commento `ponytail:` che nomina il tetto noto: `navigator.onLine` è vero su un captive portal, quindi la guardia non copre quel caso — lo copre il `break`.
- [ ] **Step 4 — Riscrivere i tre test di persistenza dei fallimenti** perché asseriscano il comportamento corretto. Dire nel report cosa asserivano prima e perché era sbagliato.
- [ ] **Step 5 — Verde + suite intera + typecheck.**
- [ ] **Step 6 — Commit.** `fix(offline): stop syncPush burning retries on a transport failure`

---

### Task 5: Invalidare la board dopo `syncPush`, non solo nell'`onSuccess`

**Perché:** ogni mutation kanban chiama `invalidateBoard()` nel proprio `onSuccess`, che offline marca stale una query in pausa. Alla riconnessione `refetchOnReconnect` (default v5, non sovrascritto) scatta **subito**, mentre `syncPush` aspetta il tick da 30s di `useSync`. La board si ridisegna con lo snapshot server **precedente** al push, quindi senza il lavoro offline, e ci resta fino a un refocus o alla scadenza dei 5 minuti di `staleTime`. L'utente guarda il proprio lavoro offline sparire alla riconnessione — il sintomo esatto che questo fix doveva eliminare.

**Severità:** high · **Effort:** M · **Rischio:** tocca `useSync`, non TIER 1.

**File:**
- Modifica: `frontend/src/hooks/useSync.ts` oppure `frontend/src/features/sync/syncService.ts` (decidere e motivare)
- Modifica: il test corrispondente

- [ ] **Step 1 — Decidere dove.** Invalidare le query kanban **dopo** che `syncPush` ha completato, non dentro le singole mutation. Motivare la scelta del punto nel report.
- [ ] **Step 2 — Test che fallisce:** dopo un `syncPush` andato a buon fine, le chiavi kanban devono risultare invalidate.
- [ ] **Step 3 — Implementare, verde, typecheck.**
- [ ] **Step 4 — Commit.** `fix(offline): invalidate kanban queries after the push, not before it`

---

### Task 6: `useKanbanBoard` — ricostruire la board da Dexie quando la GET fallisce

**Perché:** senza questo, **il fix è invisibile sul kanban**. `useKanbanBoard` fa una `api.get` pura con `retry: false` e nessun fallback locale; `KanbanBoardPage.tsx:65` tratta qualsiasi errore — incluso il 404 di una board solo locale — come "board cancellata" e naviga via. Avvio offline a freddo: la lista board si vede (è una live query Dexie), ma toccare una board ti rimbalza fuori. Le 12 mutation kanban sbloccate **non sono nemmeno raggiungibili**.
Le righe ci sono già: le scrive quella stessa `queryFn` nella sua passata di idratazione.

**Severità:** high · **Effort:** M · **Rischio:** nessun TIER 1.

**File:**
- Modifica: `frontend/src/features/kanban/hooks/useKanbanBoard.ts`
- Modifica: `frontend/src/features/kanban/KanbanBoardPage.tsx`
- Modifica: i test corrispondenti

- [ ] **Step 1 — Test che fallisce:** con la GET che fallisce e le righe presenti in Dexie, l'hook deve restituire la board ricostruita invece di `undefined`.
- [ ] **Step 2 — Eseguire e vedere fallire.**
- [ ] **Step 3 — Ricostruire da `db.kanbanBoards` + `db.kanbanColumns` + `db.kanbanCards`** sul fallimento della GET. Distinguere "non ancora sincronizzata" da "davvero cancellata" prima di navigare via: una board assente da Dexie **e** 404 dal server è cancellata; una presente in Dexie non lo è.
- [ ] **Step 4 — Verde + typecheck.**
- [ ] **Step 5 — Commit.** `fix(kanban): render a board from dexie when the server fetch fails`

---

### Task 7: e2e offline reale con `setOffline(true)`

**Perché:** ogni test "offline" di questo repo finora intercetta le rotte con `page.route`, lasciando `navigator.onLine` a `true`. È per questo che il bug è sopravvissuto a un audit da 38 agent: l'illusione ha retto finché nessuno ha spento davvero la rete. Un test che usa `setOffline(true)` è l'unico che avrebbe potuto trovarlo, ed è l'unico che impedirà il ritorno.

**Severità:** high · **Effort:** M · **Rischio:** nessuno.

**File:**
- Crea: `frontend/e2e/offline-first.spec.ts`

- [ ] **Step 1 — Scrivere lo scenario:** login, `context.setOffline(true)`, creare una nota e un notebook, verificare che compaiano subito nella UI, `setOffline(false)`, verificare che raggiungano il server (contesto browser fresco o chiamata API).
- [ ] **Step 2 — Vederlo fallire** contro il codice pre-Task-3 (stash del commit e ripristino), e riportare l'output rosso.
- [ ] **Step 3 — Verde. Niente `waitForTimeout`:** asserire su stato osservabile, non su tempo trascorso.
- [ ] **Step 4 — Commit.** `test(offline): cover real offline writes with setOffline`

---

### Task 8: Convenzione in CLAUDE.md

**Perché:** l'opt-in marcisce verso lo sviluppatore — una nuova mutation local-first senza `...LOCAL_FIRST` è rotta esattamente come oggi, in silenzio. Non esiste regola di lint né marcatore di tipo. La difesa più economica è una riga dove chi aggiunge un'entità Dexie già guarda: la sezione `### Convenzioni` di `CLAUDE.md`, che tiene già invarianti di questa forma.

**Severità:** low · **Effort:** S · **Rischio:** nessuno.

- [ ] **Step 1 — Aggiungere una riga** a `### Convenzioni` in `CLAUDE.md`: una mutation la cui `mutationFn` scrive Dexie deve spreddare `LOCAL_FIRST`, altrimenti offline non gira.
- [ ] **Step 2 — Commit.** `docs(claude): record the LOCAL_FIRST mutation convention`

---

## Cosa questo piano NON copre

Elencato perché resti visibile, non perché sia stato dimenticato:

- **`syncPull` non ha guardia offline né cache-buster.** In produzione il service worker `NetworkFirst` su `/api` gli serve 200 vecchi di un giorno che tratta come autorevoli per le cancellazioni. Va affrontato, ma è un bug diverso.
- **Le 36 mutation network-only restano sul default.** Su un avvio offline a freddo partono e falliscono con un toast generico; sul percorso caldo restano in pausa. Le due modalità restano visibilmente diverse finché non si decide di invertire il default.
- **`disabled={isPending}` su mutation in pausa** lascia controlli disabilitati a tempo indeterminato (`AnnouncementBanner:91`, `SharedWithMePage:579/586`, `GroupsPage:250/490`, `BoardChatSidebar:175`, `CardDetailModal:583`).
- **Stacking del tasto Invio** che replica N invii di chat duplicati alla riconnessione.
- **Nessun query persister**: nulla sopravvive a un reload offline.
- **36 delle 40 `useQuery`** non sono toccate: una query in pausa ha `isFetching` falso, quindi `isLoading` è falso, quindi ogni ramo `isLoading ? spinner : render(data)` renderizza il ramo vuoto offline senza messaggio.
