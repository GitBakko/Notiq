# Schede task per la sessione cloud (GitHub)

**Scritto il 2026-09-29**, con ogni riga citata **riverificata sul codice di `main` (`832d783`) lo
stesso giorno**. Questo file e' il punto d'ingresso per una sessione Claude Code in cloud che parte
dal repository GitHub, senza la macchina locale. Il contesto storico (perche' esiste ogni finding,
le undici trappole, le decisioni prese) sta in `2026-09-02-HANDOFF.md`: leggine la **sezione 3**
prima di iniziare. Qui c'e' solo cio' che serve per eseguire.

Se una riga citata qui non corrisponde piu' al codice, **fidati del codice** e annota la discordanza
nella descrizione della PR.

---

## 0. Regole della sessione cloud

### Cosa NON puoi fare dal cloud, e quindi non devi tentare

- **Nessun accesso a produzione** (`notiq.epartner.it`, server IIS, pm2, DB di prod). Le tre verifiche
  manuali in sospeso della v1.11.2 (HANDOFF sezione 9, punto 0) restano all'utente.
- **Nessun deploy e nessuna release.** Non toccare `frontend/package.json` `version`, non scrivere in
  `frontend/src/data/changelog.ts`, non creare tag. La release si fa in locale con la skill
  `/notiq-release`, raccogliendo le PR mergiate.
- **Niente Docker `notiq-db`**, niente `D:\...`, niente `/d/Develop/...`: i path dell'handoff sono della
  macchina locale. Nel cloud la root del repo e' la working directory.
- **I ledger `.superpowers/sdd/*` non esistono** (gitignored). Non cercarli.

### Setup, una volta per sessione

```bash
# dalla root del repo
(cd backend  && npm ci && DATABASE_URL="postgresql://ci:ci@localhost:5432/ci?schema=public" npx prisma generate)
(cd frontend && npm ci)
```

`npx prisma` carica `backend/prisma.config.js`, che fa `require('dotenv').config()`. Se `prisma
generate` si lamenta della mancanza di `DATABASE_URL`, esporta le due variabili che usa la CI e
riprova:

```bash
export DATABASE_URL="postgresql://ci:ci@localhost:5432/ci?schema=public"
export JWT_SECRET="ci-dummy-secret"
```

**Gli unit test non usano un database**: `backend/src/__tests__/setup.ts` mocka Prisma per intero.
Tutti i task qui sotto si verificano senza Postgres. Gli e2e (Playwright) richiedono backend e DB
reali: nel cloud **non lanciarli**, ci pensa il job `E2E` della CI sulla PR.

### Comandi di verifica (sempre dalla root, con subshell: la cwd persiste)

```bash
(cd backend  && npx vitest run && npx tsc --noEmit && npm run lint)
(cd frontend && npx vitest run && npx tsc -p tsconfig.app.json --noEmit && npm run lint)
```

- `cd frontend && npx tsc --noEmit` **esce 0 senza compilare nulla** (`tsconfig.json` ha
  `"files": []`). Usa sempre `-p tsconfig.app.json`.
- `npx vitest run` lanciato dalla **root** raccoglie ~113 file senza setup e riporta ~700 falliti.
  Non e' un disastro, e' la cwd.
- Un test singolo: `(cd backend && npx vitest run src/__tests__/tasklist.service.test.ts)`.
- **I test backend non sono typechecked** (`backend/tsconfig.json` esclude `src/**/__tests__/**`).
  Se cambi la firma di un service, cerca a mano i test che lo chiamano.

### Flusso git per ogni task

1. Un branch per task, da `main` aggiornato: `git checkout main && git pull && git checkout -b <branch>`.
   Il nome del branch e' indicato in ogni scheda.
2. **Test rosso prima del codice.** Scrivi il test, lancialo, **incolla l'output rosso nella
   descrizione della PR**. Un test verde mai visto rosso non dimostra niente: in questo repo e'
   successo quattro volte (HANDOFF trappola 4).
3. Implementa, rilancia la verifica completa del workspace toccato.
4. **Mutazione di controllo**: per ogni asserzione negativa ("non deve succedere X"), rompi il codice
   di proposito, verifica che il test diventi rosso, ripristina. Scrivi nella PR quale mutazione hai
   fatto e quale test l'ha uccisa.
5. Commit con messaggio in italiano, stile del repo (`fix: P1 — ...`), piu' la riga di attribuzione.
6. Push e **apri una PR verso `main`. Non mergiarla.** La CI (`.github/workflows/ci.yml`) ha tre job
   bloccanti: `Backend`, `Frontend`, `E2E`.
7. **Se `E2E` fallisce su `collaboration.spec.ts:249` o `auth.spec.ts:41`**: sono flaky noti e
   preesistenti (HANDOFF trappola 5). Rilancia il job una volta. Se ripassa, annotalo nella PR. Se
   fallisce un **altro** spec, e' colpa tua fino a prova contraria.

### Regole del repo che valgono anche qui

- **File TIER 1 / TIER 2** (elenco in `CLAUDE.md` root): la PR *e'* la proposta di diff. Scrivi nel
  titolo `[TIER 2]` e non mergiare: l'utente la rivede.
- **`[BACKUP] 2026-09-29 — <motivo>`** come commento sul codice sostituito, quando cambi logica
  esistente (non sulle aggiunte pure).
- **Errori**: i service lanciano le classi di `backend/src/utils/errors` (`NotFoundError`,
  `ForbiddenError`, ...) con una **chiave i18n** come messaggio. I test asseriscono **entrambe**:
  la classe e la chiave.
- **i18n**: ogni stringa utente in `frontend/src/locales/en.json` **e** `frontend/src/locales/it.json`.
  **Non riscrivere quei file con un parser JSON**:
  contengono chiavi duplicate volute, e `json.load`+`json.dump` cambierebbe il valore effettivo.
  Inserisci le chiavi a mano, testualmente (HANDOFF trappola 6).
- **Dark mode**: ogni classe colore Tailwind nuova ha la sua variante `dark:`.
- **`window.confirm()` vietato**: si usa `ConfirmDialog`.
- **Mutation che scrivono su Dexie**: spreddare `...LOCAL_FIRST` (`frontend/src/lib/networkMode.ts`).

---

## 1. Ordine consigliato

| # | Task | Branch | Workspace | Rischio | Stima |
|---|---|---|---|---|---|
| T1 | P1 — `reorderTaskItems` senza scope | `fix/p1-reorder-scope` | backend | basso | 30 min |
| T2 | D1 — `lastActiveAt` non scatta mai | `fix/d1-last-active` | backend, **TIER 2** | medio (cambia il comportamento delle notifiche) | 1 h |
| T3 | C5 — commenti kanban non si aggiornano via SSE | `fix/c5-comments-invalidate` | frontend | basso | 20 min |
| T4 | P3 + P4 — `updateNote` non verifica `notebookId` e `tagId` | `fix/p3-p4-updatenote-scope` | backend | medio (tocca il sync delle note) | 1 h |
| T5 | P2 — `addTaskItem` crea card su una board non autorizzata | `fix/p2-additem-board-authz` | backend | basso | 45 min |
| T6 | Chat di nota: pagina 1 sono i 100 messaggi piu' **vecchi** | `fix/note-chat-latest-first` | backend + frontend | medio | 1-2 h |
| T7 | Chat diretta: "carica altri" a offset salta/duplica | `fix/direct-chat-cursor` | frontend | basso | 45 min |
| T8 | Lista amici sotto due chiavi di cache | `fix/friends-single-cache-key` | frontend | basso | 30 min |
| T9 | `DECLINED` assente dal tipo frontend delle condivisioni | `fix/declined-share-type` | frontend | basso | 1 h |

**Fuori da questa lista di proposito** — richiedono una decisione di progetto dell'utente, non
eseguirli in autonomia: G1 (revoca degli share propagati da un gruppo), 4.2+C2 (filtro dell'eco
SSE), task 3.4/3.6/3.7 del piano kanban (**TIER 1**, citano codice che non esiste piu': trappola 1),
stabilizzazione degli e2e flaky (serve girarli in locale). Se l'utente te li chiede, parti dalla
sezione corrispondente dell'Appendice di `2026-08-31-kanban-hardening.md` e proponi prima di fare.

> **Aggiornamento 2026-09-29, decisioni dell'utente:**
> - **G1:** chiuso come comportamento voluto.
> - **4.2 + C2:** risolti con la variante B (l'eco del proprio utente salta solo il pulse di highlight).
> - **3.4/3.6/3.7:** rivalutati. I tre difetti esistono ancora, ma il testo del piano è superato: le
>   rivalutazioni con il task riscritto sono in testa a ciascun task in `2026-08-31-kanban-hardening.md`.
>   Restano TIER 1, da fare in locale.
> - **E2E instabili:** li gestisce l'utente in locale.

---

## T1 — P1: `reorderTaskItems` scrive item di altre liste

**Branch:** `fix/p1-reorder-scope` · **Commit:** `fix: P1 — reorderTaskItems scopa gli item sulla lista autorizzata`

### Il difetto

`backend/src/services/tasklist.service.ts:414-431`:

```ts
export const reorderTaskItems = async (userId, taskListId, items) => {
  await assertWriteAccess(userId, taskListId);           // autorizza la lista A
  await prisma.$transaction(
    items.map((item) =>
      prisma.taskItem.update({
        where: { id: item.id },                          // scrive QUALSIASI item, di qualsiasi lista
        data: { position: item.position },
      })
    )
  );
  return { success: true };
};
```

I due fratelli nello stesso file lo scopano gia': `updateTaskItem` (`:356-363`) e `deleteTaskItem`
(`:398-405`) leggono l'item e lanciano `NotFoundError('errors.tasks.itemNotFound')` se
`existing.taskListId !== taskListId`.

**Scenario d'attacco:** Bob ha una share **READ** sulla lista di Alice, quindi riceve gli id dei
suoi item da `GET /api/tasklists/:id`. Bob chiama `PUT /api/tasklists/<lista-di-Bob>/items/reorder`
con gli id di Alice. `assertWriteAccess` passa (la lista e' di Bob), le scritture atterrano sulla
lista di Alice. Scalata READ→WRITE.

Route: `backend/src/routes/tasklists.ts:92-96` (`PUT /:id/items/reorder`, body validato da
`reorderSchema`).

### La correzione

In `reorderTaskItems`, **dopo** `assertWriteAccess` e **prima** della transazione:

```ts
const ids = [...new Set(items.map((i) => i.id))];
const owned = await prisma.taskItem.findMany({
  where: { id: { in: ids }, taskListId },
  select: { id: true },
});
if (owned.length !== ids.length) {
  throw new NotFoundError('errors.tasks.itemNotFound');
}
```

e, come difesa in profondita', scopa anche la scrittura: `where: { id: item.id, taskListId }`
(Prisma 7 accetta filtri non-unique nella `where` di `update`, purche' ci sia il campo unique `id`).

Perche' `NotFoundError` e non `ForbiddenError`: e' cio' che fanno i due fratelli, e non conferma
all'attaccante che l'id esiste altrove. `NotFoundError` e' gia' importato nel file (usato a `:362`).

**Non toccare:** `assertWriteAccess` (`:65-81`), la route, lo schema Zod.

### Test — `backend/src/__tests__/tasklist.service.test.ts`

1. Aggiungi `reorderTaskItems` all'import (`:10-20`).
2. Aggiungi un `describe('tasklist.service — reorderTaskItems', ...)` dopo quello di `deleteTaskItem`
   (che finisce a `:300`). Il mock `prismaMock.taskItem.findMany` esiste gia' (`:38`, ricreato a
   `:67`). `$transaction` in `setup.ts:277-282` con un array lo risolve e basta, e `items.map`
   invoca `update` subito: quindi **asserisci su `prismaMock.taskItem.update`, non su
   `$transaction`**.
3. Tre casi:
   - **Il caso che conta (scrivilo per primo, deve essere ROSSO sul codice attuale):** owner della
     lista `tl-1` (`taskList.findUnique` → `{ id: 'tl-1', userId: 'user-1' }`); `taskItem.findMany`
     → `[{ id: 'item-1' }]` (solo uno dei due id appartiene a `tl-1`); chiama con
     `[{ id: 'item-1', position: 0 }, { id: 'item-ALTRUI', position: 1 }]`.
     Atteso: `rejects.toThrow('errors.tasks.itemNotFound')`, **e** `rejects.toBeInstanceOf(NotFoundError)`,
     **e** `expect(prismaMock.taskItem.update).not.toHaveBeenCalled()`.
   - **Percorso felice:** `findMany` restituisce entrambi gli id → risolve `{ success: true }`,
     `update` chiamato 2 volte, e ogni chiamata ha `where` che contiene `taskListId: 'tl-1'`.
   - **Id duplicati nel body:** `[{id:'item-1',...},{id:'item-1',...}]` con `findMany` → `[{id:'item-1'}]`
     non deve lanciare (il `Set` li collassa).
4. **Mutazione di controllo:** togli l'`if (owned.length !== ids.length)` → il primo test deve
   diventare rosso. Ripristina.

### Criteri di accettazione

- [ ] Output rosso del primo test incollato nella PR.
- [ ] `(cd backend && npx vitest run && npx tsc --noEmit && npm run lint)` verde.
- [ ] Il test di route `backend/src/routes/__tests__/tasklists.route.test.ts:308-326` resta verde
      senza modifiche (mocka il service).
- [ ] CI verde sui tre job.
- [ ] Nella PR: aggiorna la riga P1 nell'Appendice di
      `docs/superpowers/plans/2026-08-31-kanban-hardening.md` (`:639`, colonna Stato → `**CORRETTO** <sha>`)
      e il conteggio a `:169` (ventitre corretti → ventiquattro, otto aperti → sette).

---

## T2 — D1: l'hook `lastActiveAt` non scatta mai `[TIER 2]`

**Branch:** `fix/d1-last-active` · **Commit:** `fix: D1 — lastActiveAt aggiornato dopo l'autenticazione`
**File TIER 2 (`backend/src/app.ts`): apri la PR con `[TIER 2]` nel titolo e non mergiarla.**

### Il difetto

`backend/src/app.ts:187-203`:

```ts
const lastActiveCache = new Map<string, number>();

server.addHook('onRequest', async (request: FastifyRequest) => {
  if (request.user) {   // SEMPRE undefined qui
    ...
      prisma.user.update({ where: { id: request.user.id }, data: { lastActiveAt: new Date() } })
    ...
  }
});
```

L'hook globale `onRequest` gira **prima** di `fastify.authenticate`, che le route registrano a
livello di route (`{ onRequest: [fastify.authenticate] }`). `request.user` e' popolato solo da
`request.jwtVerify()` dentro il decorator (`app.ts:168-184`). Quindi l'`if` e' sempre falso e
`lastActiveAt` non viene mai scritto dall'applicazione. Sul DB di dev, 824 utenti su 826 avevano
`lastActiveAt === createdAt`.

**Conseguenze oggi in produzione:** `isOnlineInApp` e' sempre falso, quindi ogni notifica escala a
email/push anche con l'utente attivo nell'app. I lettori:
`backend/src/services/kanban/notifications.ts:106-116`,
`backend/src/services/kanban/comments-chat.service.ts:245-269`,
`backend/src/services/chat.service.ts:134-154`,
`backend/src/services/notification.service.ts:26-34`,
e il tile "utenti attivi" di `backend/src/services/admin.service.ts:42`.

### La correzione

1. Crea `backend/src/utils/lastActive.ts` con la logica estratta, cosi' e' testabile senza avviare
   `app.ts` (che non ha test propri):

   ```ts
   import prisma from '../plugins/prisma';

   const THROTTLE_MS = 5 * 60 * 1000;
   const lastActiveCache = new Map<string, number>();

   // Fire-and-forget: a failed touch must never fail the request it rides on.
   export function touchLastActive(
     userId: string,
     log: { warn: (obj: object, msg: string) => void },
     now: number = Date.now(),
   ): void {
     const last = lastActiveCache.get(userId) || 0;
     if (now - last <= THROTTLE_MS) return;
     lastActiveCache.set(userId, now);
     prisma.user
       .update({ where: { id: userId }, data: { lastActiveAt: new Date(now) } })
       .catch((err) => log.warn({ err, userId }, 'lastActiveAt update failed'));
   }

   // Test-only: the cache is module state and would leak between tests.
   export function __resetLastActiveCache(): void {
     lastActiveCache.clear();
   }
   ```

   Verifica il path di import di `prisma` guardando come lo importano gli altri file in
   `backend/src/utils/` o `backend/src/services/`.

2. In `app.ts`, dentro il decorator `authenticate`, chiama `touchLastActive(request.user.id, request.log)`
   **solo dopo** che il controllo `tokenVersion` e' passato, cioe' subito prima della `}` che chiude
   il `try` (dopo il blocco `if (request.user.tokenVersion !== undefined) {...}`). Un token
   invalidato **non** deve aggiornare `lastActiveAt`.

3. Elimina da `app.ts` la `const lastActiveCache` (`:187`) e l'intero `server.addHook('onRequest', ...)`
   (`:189-203`), lasciando al loro posto il commento:
   `// [BACKUP] 2026-09-29 — D1: questo hook onRequest globale girava prima di fastify.authenticate, quindi request.user era sempre undefined e lastActiveAt non veniva mai scritto. Spostato dentro il decorator authenticate (utils/lastActive.ts).`

**Non toccare:** il resto del decorator, l'hook `onResponse` (`:206+`), i lettori elencati sopra.

### Test — nuovo file `backend/src/__tests__/lastActive.test.ts`

Il mock di `prisma.user.update` viene da `setup.ts`. Casi:

- **Primo touch scrive:** `touchLastActive('u1', log, 1_000_000)` → `prisma.user.update` chiamato una
  volta con `{ where: { id: 'u1' }, data: { lastActiveAt: new Date(1_000_000) } }`.
- **Throttle:** secondo touch a `now + 60_000` → nessuna nuova chiamata. Terzo a
  `now + 5*60_000 + 1` → seconda chiamata.
- **Utenti distinti non si throttlano a vicenda.**
- **Errore del DB non propaga:** `update` → `mockRejectedValueOnce(new Error('db down'))`; la
  funzione non lancia, e dopo `await new Promise(r => setImmediate(r))` `log.warn` e' stato chiamato
  con `'lastActiveAt update failed'`.
- `beforeEach(() => __resetLastActiveCache())`.

Rosso prima: scrivi il test prima di creare il modulo (fallisce all'import). Non e' una conferma
rossa del bug, e va detto nella PR. **La prova del bug** e' la lettura del codice sopra piu' la
query dell'HANDOFF; non esiste un test di integrazione di `app.ts` da far diventare rosso.

**Mutazione di controllo:** in `touchLastActive` cambia `<=` in `<` e poi rimuovi la riga
`lastActiveCache.set(...)`: il test del throttle deve morire in entrambi i casi.

### Effetto visibile da scrivere nella PR

Dopo il deploy, gli utenti attivi negli ultimi 5 minuti **smettono di ricevere email/push** per
commenti, chat e assegnazioni, e ricevono solo la notifica in-app. E' il comportamento progettato, ma
per gli utenti e' un cambiamento: va nel changelog della prossima release (lo scrive l'utente in
locale, non tu).

### Criteri di accettazione

- [ ] `grep -n "addHook('onRequest'" backend/src/app.ts` non trova piu' l'hook di `lastActiveAt`.
- [ ] Backend: vitest, tsc, lint verdi. CI verde.
- [ ] PR con `[TIER 2]` nel titolo, non mergiata.
- [ ] Appendice `2026-08-31-kanban-hardening.md`: riga D1 della tabella a `:162` → corretto, e
      conteggio a `:169`.

---

## T3 — C5: i commenti altrui non compaiono nella card aperta

**Branch:** `fix/c5-comments-invalidate` · **Commit:** `fix: C5 — gli eventi SSE dei commenti invalidano la query dei commenti`

### Il difetto

`frontend/src/features/kanban/hooks/useKanbanRealtime.ts:72-78`: per ogni evento SSE si invalida la
board e, se l'evento ha `cardId`, `queryKeys.kanban.cardActivities(cardId)`. **Mai**
`queryKeys.kanban.comments(cardId)` (`frontend/src/lib/queryKeys.ts:21`), che e' la chiave letta da
`frontend/src/features/kanban/hooks/useKanbanComments.ts:9`. Con `staleTime` globale di 5 minuti,
chi ha la card aperta non vede arrivare i commenti degli altri, mentre il badge del conteggio si
aggiorna (viaggia sulla board).

I tipi degli eventi sono in `frontend/src/features/kanban/types.ts:180-181`:
`comment:added` e `comment:deleted`, entrambi con `cardId`.

### La correzione

Subito dopo il blocco `if ('cardId' in event && event.cardId) {...}` (`:76-78`):

```ts
if (event.type === 'comment:added' || event.type === 'comment:deleted') {
  queryClient.invalidateQueries({ queryKey: queryKeys.kanban.comments(event.cardId) });
}
```

Solo quei due eventi: invalidare i commenti a ogni `card:moved` produrrebbe refetch inutili.

### Test

Cerca se esiste gia' un test di `useKanbanRealtime`
(`git ls-files frontend | grep -i realtime`). Se esiste, aggiungi un caso: dato un evento
`comment:added` con `cardId: 'c1'`, `invalidateQueries` viene chiamato con
`{ queryKey: ['kanban-comments', 'c1'] }`; con `card:moved` no. Se non esiste, e mockare la
connessione SSE richiede piu' di ~40 righe di setup, **non costruire un'infrastruttura di test per
una riga**: scrivilo nella PR e lascia la verifica al reviewer. Il CLAUDE.md suggerisce di
rieseguire gli e2e kanban (`frontend/e2e/kanban*.spec.ts`): lo fa la CI.

### Criteri di accettazione

- [ ] Frontend: vitest, `tsc -p tsconfig.app.json`, lint verdi. CI verde.
- [ ] Appendice: C5 (`:161` e `:696-699`) → corretto.

---

## T4 — P3 + P4: `updateNote` accetta `notebookId` e `tagId` altrui

**Branch:** `fix/p3-p4-updatenote-scope` · **Commit:** `fix: P3 P4 — updateNote verifica notebook e tag dell'utente`

### Il difetto

`backend/src/services/note.service.ts:185-235` (`updateNote`). La nota e' verificata
(`:198`, `findFirst({ where: { id, userId } })`), ma:

- **P3** — `data.notebookId` finisce in `updateData` (`:227`, via `...restWithoutContent`) **senza
  verifica**. `createNote` invece lo verifica (`:39-41`, `notebook.findFirst({ where: { id: notebookId, userId } })`).
  Gli id dei notebook altrui sono noti a chi ha ricevuto un'offerta di share, anche rifiutata. La nota
  finisce nel notebook della vittima; `Note.notebook` e' `onDelete: Cascade`, quindi quando la vittima
  cancella il notebook la nota dell'attaccante sparisce, e intanto il conteggio della vittima e' gonfiato.
- **P4** — `tags` (`:204-215`) crea `TagsOnNotes` con `tagId: t.tag.id` **mai verificato**, mentre
  `addTagToNote` lo verifica (`backend/src/services/tag.service.ts:59-60`). E' anche una lettura:
  `getNote` include `tags: { where: { userId }, include: { tag: true } }` (`:159`), e la riga ha lo
  `userId` dell'attaccante, quindi restituisce la Tag intera della vittima. Raggiungibilita' non
  confermata (serve conoscere un UUID di tag altrui), ma la correzione costa una query.

### La correzione

Dentro `updateNote`, **prima** di `prisma.$transaction` (dopo `:201`):

```ts
if (rest.notebookId !== undefined) {
  const nb = await prisma.notebook.findFirst({
    where: { id: rest.notebookId, userId },
    select: { id: true },
  });
  if (!nb) throw new NotFoundError('errors.notebooks.notFound');
}

if (tags !== undefined && tags.length > 0) {
  const ids = [...new Set(tags.map((t) => t.tag.id))];
  const owned = await prisma.tag.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  if (owned.length !== ids.length) throw new NotFoundError('errors.tags.noteOrTagNotFound');
}
```

Chiavi verificate il 2026-09-29: `errors.notebooks.notFound` esiste (usata da `createNote:52`),
`errors.tags.noteOrTagNotFound` esiste (usata da `tag.service.ts:56,60`). **`errors.tags.notFound`
NON esiste**: non usarla. `NotFoundError` e' gia' importato in `note.service.ts:7`.

Si **lancia** invece di filtrare in silenzio, coerente con `notebookId`: un tag scartato senza dirlo
sparirebbe dalla nota dell'utente senza spiegazione.

### ⚠️ Prima di chiudere: il sync offline

`updateNote` e' chiamato dal push del sync (`frontend/src/features/sync/syncService.ts`, **TIER 1**:
leggilo, non modificarlo). Un 404 nuovo su un UPDATE di nota potrebbe finire in retry infinito o
essere marcato `failed`. Verifica cosa fa `syncPush` con un 404 su `NOTE`/`UPDATE`
(`grep -n "404\|status ===" frontend/src/features/sync/syncService.ts`) e **scrivi nella PR** il
comportamento. Caso realistico: l'utente sposta offline una nota in un notebook che poi cancella da un
altro dispositivo. Oggi il PUT passa e la nota punta a un notebook inesistente (FK → 500 comunque),
quindi non peggiora; ma scrivilo esplicitamente.

**Non toccare:** `syncService.ts`, `guardEmptyContentOverwrite`, `createNote`.

### Test

Trova il file: `git ls-files backend | grep -i "note.service.test"`. Casi, **tutti rossi prima**:

- `notebookId` di un altro utente: `note.findFirst` → la nota; `notebook.findFirst` → `null`.
  Atteso: `NotFoundError` + chiave, e `prisma.$transaction` **non** chiamato.
- `tags` con un id non posseduto: `tag.findMany` → sottoinsieme. Atteso: `NotFoundError`,
  `tagsOnNotes.createMany` non chiamato.
- Percorso felice con notebook e tag propri: aggiornamento eseguito.
- `notebookId` assente dal body: `notebook.findFirst` **non** chiamato (nessuna query in piu' sul
  percorso caldo dell'autosave).

Se `setup.ts` non mocka `tag.findMany` o `notebook.findFirst`, aggiungili nel test come fa
`tasklist.service.test.ts:22-53`, non in `setup.ts`.

**Mutazioni:** togli ciascuno dei due `throw` → il test corrispondente muore.

### Criteri di accettazione

- [ ] Backend verde, CI verde (E2E compreso: gli spec di note e sync toccano `updateNote`).
- [ ] Comportamento del sync su 404 documentato nella PR.
- [ ] Appendice: P3 e P4 (`:641-642`) → corretti.

---

## T5 — P2: `addTaskItem` crea una card su una board mai autorizzata

**Branch:** `fix/p2-additem-board-authz` · **Commit:** `fix: P2 — addTaskItem crea la card solo se l'attore puo' scrivere la board`

### Il difetto

`backend/src/services/tasklist.service.ts:250-346`. Autorizza la **lista** (`:255`), poi nel blocco
"Auto-add card to linked kanban board" (`:277-343`) fa `kanbanCard.create` (`:313`) e
`broadcast('card:created')` (`:334`) sulla board collegata **senza verificare che l'attore abbia
WRITE sulla board**. E' lo specchio esatto di N5 (vedi Appendice `### N5`, `:575-629`, e leggila:
spiega perche' il fix **salta** invece di lanciare).

### La correzione

Nel blocco `try` a `:278`, dopo aver risolto `boardId` (`:298`) e **prima** di `kanbanCard.aggregate`
(`:307`), verifica che `userId` abbia accesso in scrittura alla board con l'helper esistente
`assertBoardAccess(boardId, userId, 'WRITE')` di `backend/src/services/kanbanPermissions.ts:4-25`
(import: `import { assertBoardAccess } from './kanbanPermissions';`). Lancia `NotFoundError` se la
board non esiste, `ForbiddenError` se lo share manca, non e' `ACCEPTED` o non e' `WRITE`.

Avvolgi **solo quella chiamata** in un try/catch dedicato: su `ForbiddenError` o `NotFoundError`
(entrambi gia' importati a `:4`, controlla con `instanceof`) **salta** l'auto-add con
`logger.warn({ userId, taskListId, boardId }, 'addTaskItem: actor cannot write linked board, skipping card auto-add')`
e `return item`. Qualsiasi altro errore lo rilanci, e lo prende il `catch` esterno esistente
(`:340-343`). Il modello e' il gate di N5: `backend/src/services/kanban/card.service.ts:238` e `:275`
(i suoi `logger.warn`). L'item della lista **deve** essere creato comunque: e' un'azione a cui
l'attore ha pieno diritto.

Gli altri errori restano gestiti dal `catch` esistente (`:340-343`).

### Test — `backend/src/__tests__/tasklist.service.test.ts`

Estendi il `describe` di `addTaskItem` (`:154-214`), sul modello del caso a `:183-213`:

- **Rosso prima:** proprietario della lista **senza** accesso alla board → l'item e' restituito,
  `kanbanCard.create` **non** chiamato, nessun `broadcast`.
- Proprietario della lista **con** WRITE sulla board → `kanbanCard.create` chiamato (il caso
  esistente a `:183` deve restare verde: potrebbe servire aggiungergli il mock dell'accesso board).
- Sharee della board in **READ** → nessuna card.

**Mutazione:** inverti la condizione di accesso → il primo caso muore.

### Criteri di accettazione

- [ ] Backend verde, CI verde.
- [ ] Appendice: P2 (`:640`) → corretto.

---

## T6 — Chat di nota: la prima pagina sono i messaggi piu' vecchi

**Branch:** `fix/note-chat-latest-first` · **Commit:** `fix: la chat di nota carica i messaggi piu' recenti`

### Il difetto

`backend/src/services/chat.service.ts:185-190`:

```ts
export const getMessages = async (noteId: string, page: number = 1, limit: number = 100) => {
  ... orderBy: { createdAt: 'asc' }, skip: (page - 1) * limit, take: limit,
```

Pagina 1 = i **100 piu' vecchi**. Oltre 100 messaggi la chat di nota mostra sempre gli stessi e i
nuovi non compaiono. La chat **diretta** invece e' corretta (`desc` + `.reverse()`): usala come
modello, in `backend/src/services/chat-direct.service.ts:157-200`.

### La correzione

1. Backend: `orderBy: { createdAt: 'desc' }`, poi `.reverse()` sul risultato prima di restituirlo,
   cosi' il contratto verso il frontend (ordine cronologico crescente) non cambia per pagina 1.
2. Frontend: trova il consumatore con
   `grep -rn "chat.*messages\|getMessages\|/chat/" frontend/src --include=*.ts --include=*.tsx | grep -v chat-direct | grep -v features/chat/`.
   Se il frontend chiede **solo** pagina 1, il fix backend basta: scrivilo nella PR. Se pagina
   pagine successive, con `desc` la pagina 2 diventa "i 100 precedenti" e va **prepesa** alla lista
   invece che appesa: adegua il merge.

### Test

Trova il test: `git ls-files backend | grep chat.service.test`. Rosso prima: mocka
`chatMessage.findMany` (verifica il nome del modello in `schema.prisma`: `ChatMessage`) e asserisci
che venga chiamato con `orderBy: { createdAt: 'desc' }` e che il risultato restituito sia in ordine
crescente.

### Criteri di accettazione

- [ ] Backend + frontend verdi, CI verde.
- [ ] Nella PR: chi consuma l'endpoint e se servono pagine > 1.

---

## T7 — Chat diretta: "carica altri" salta o duplica messaggi

**Branch:** `fix/direct-chat-cursor` · **Commit:** `fix: lo scrollback della chat diretta usa il cursore before`

### Il difetto

`frontend/src/features/chat/chatService.ts:84`: `getMessages(conversationId, page, limit)` manda
solo `page`/`limit`. `frontend/src/features/chat/components/ConversationView.tsx:134-155` (`loadMore`)
chiede `page + 1`. Il backend fa `skip = (page-1)*limit` su messaggi ordinati `desc`: se nel frattempo
arrivano N messaggi nuovi, pagina 2 si sposta di N e lo scrollback **duplica** (mitigato dal dedup a
`:144-147`) o **salta** (non mitigato) righe.

Il backend supporta gia' il cursore: `backend/src/routes/chat-direct.ts:22` (`before: z.string().uuid().optional()`)
e `backend/src/services/chat-direct.service.ts:166-180` (se `before` c'e', prende i messaggi con
`createdAt < createdAt(before)`). **Nessuna modifica backend.**

### La correzione

1. `chatService.ts:84`: aggiungi un parametro opzionale `before?: string` e passalo in `params`
   solo se definito.
2. `ConversationView.tsx` `loadMore`: invece di `page + 1`, chiama
   `getMessages(conversationId, 1, 50, allMessages[0]?.id)` (il messaggio **piu' vecchio** caricato:
   `allMessages` e' in ordine crescente, verificalo a `:147` dove i vecchi sono prepesi). Lo stato
   `page` diventa inutile: rimuovilo solo se non e' letto altrove nel file (`grep -n "page" `).
   **Non toccare** la `useQuery` di pagina 1 (`:110-115`) ne' il suo commento `[BACKUP]`: la scelta
   `staleTime: 0` + `refetchOnWindowFocus: false` e' voluta.
3. `hasMore`: resta `olderMessages.length === 50`.

### Test

Se esiste un test di `ConversationView` o `chatService` (`git ls-files frontend | grep -i conversation`),
aggiungi: `loadMore` chiama `getMessages` con `before` = id del messaggio piu' vecchio. Altrimenti
un test su `chatService.getMessages` che verifichi i `params` passati ad `api.get` (mocka
`frontend/src/lib/api.ts`).

### Criteri di accettazione

- [ ] Frontend verde, CI verde.
- [ ] Chat e' online-only (CLAUDE.md): **nessun** uso di Dexie.

---

## T8 — La lista amici vive sotto due chiavi di cache

**Branch:** `fix/friends-single-cache-key` · **Commit:** `fix: una sola chiave di cache per la lista amici`

### Il difetto

Verificato il 2026-09-29: `['chat','friends']` in
`frontend/src/features/chat/components/FriendRequestModal.tsx:72` **e**
`frontend/src/features/chat/components/GroupChatModal.tsx:49`; `['friends','list']` in
`frontend/src/features/sharing/SharedWithMePage.tsx:151`. Stessa risorsa, due cache: invalidarne una
non aggiorna l'altra (e il fix `9fb28e0` della lista amici ne invalida solo una: controlla quale con
`git show 9fb28e0`).

### La correzione

1. Elenca **tutti** gli usi di entrambe le chiavi, incluse le `invalidateQueries` e il `ChatContext`
   (`grep -rn "\['chat', *'friends'\]\|\['friends', *'list'\]\|'friends'" frontend/src`).
2. Se `frontend/src/lib/queryKeys.ts` ha gia' una sezione adatta, aggiungi li'
   `friends: ['friends', 'list'] as const` (o il nome coerente con il file) e sostituisci **ogni**
   uso letterale delle due chiavi con la costante.
3. Verifica che le due `queryFn` chiamino lo **stesso** endpoint e restituiscano la stessa forma. Se
   no, **fermati** e scrivilo nella PR: unificare chiavi con forme diverse rompe una delle due viste.

### Criteri di accettazione

- [ ] `grep -rn "\['chat', *'friends'\]" frontend/src` → vuoto.
- [ ] Frontend verde, CI verde.

---

## T9 — `DECLINED` non esiste nel tipo frontend delle condivisioni

**Branch:** `fix/declined-share-type` · **Commit:** `fix: DECLINED nel tipo delle condivisioni e filtro nei due punti rimasti`

### Il difetto

Mappa verificata il 2026-09-29 (`grep -rn "'ACCEPTED' | 'PENDING'" frontend/src`):

- **Dichiarazioni del tipo** (5): `frontend/src/components/sharing/NotebookSharingModal.tsx:17`,
  `frontend/src/components/sharing/SharingModal.tsx:17`,
  `frontend/src/components/sharing/SharedUsersModal.tsx:10`,
  `frontend/src/hooks/useNotebookShareCounts.ts:8`,
  `frontend/src/features/tasks/TaskListSharingModal.tsx:17`.
- **Cast `as`** (5): `frontend/src/components/layout/Sidebar.tsx:261`,
  `frontend/src/features/notes/NoteEditor.tsx:823` (gia' filtrato da `1b2daa0`: lascia il filtro,
  togli solo il cast), `frontend/src/features/notes/NotesPage.tsx:293`,
  `frontend/src/features/tasks/TaskListsPage.tsx:37` e `:129`.
- **Punti non filtrati:** `Sidebar.tsx:261` (share dei taccuini) e
  `SharedUsersModal.tsx:104`, `users.filter(u => u.status !== 'PENDING')`, che mette **i rifiutati
  fra chi ha accesso**. Controlla anche `NotesPage.tsx:293` e `TaskListsPage.tsx:37,129`: se non
  hanno un `.filter` sullo status a monte, vanno filtrati come `NoteEditor.tsx:823`.

Il modello di riferimento e' la correzione `1b2daa0` (`git show 1b2daa0`), che ha sistemato
`NoteEditor`.

### La correzione

1. `grep -rn "'ACCEPTED' | 'PENDING'" frontend/src` → aggiungi `| 'DECLINED'` a ogni dichiarazione.
2. Rimuovi i cast `as` che servivano solo a quel tipo (`grep -rn "as 'ACCEPTED'\|as ShareStatus\|status as" frontend/src`).
3. Lancia `npx tsc -p tsconfig.app.json --noEmit`: gli errori nuovi sono i punti da filtrare.
4. In `SharedUsersModal.tsx:104` sostituisci `!== 'PENDING'` con `=== 'ACCEPTED'`. In
   `Sidebar.tsx:261` escludi `DECLINED` come fa `1b2daa0`.
5. **Non** mostrare i DECLINED all'utente in nessuna lista "con accesso".

### Test

Rosso prima: un test di `SharedUsersModal` che renderizza una share `DECLINED` e asserisce che **non**
compare fra gli utenti con accesso. Cerca un test esistente del componente o di `NoteEditor` toccato
da `1b2daa0` come modello (`git show --stat 1b2daa0`).

### Criteri di accettazione

- [ ] Frontend verde, CI verde.
- [ ] Nessun `as` rimasto per forzare lo status.
