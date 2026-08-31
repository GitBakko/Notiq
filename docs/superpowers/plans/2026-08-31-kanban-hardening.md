# Kanban Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: usa `superpowers:subagent-driven-development` (consigliato) o `superpowers:executing-plans` per eseguire questo piano task-per-task. Gli step usano checkbox (`- [ ]`) per il tracking.

**Goal:** Eliminare le 7 cause strutturali che generano i 185 difetti verificati del Kanban, in 44 task committabili singolarmente, senza regressioni sui percorsi TIER 1.

**Architecture:** Nessuna riscrittura. Ogni tema viene chiuso in un solo punto di strozzatura: un helper di autorizzazione condiviso in `kanbanPermissions.ts`; una funzione pura `computeColumnOrder()` che diventa l'unico proprietario dell'ordinamento; `broadcast()` che diventa il chokepoint SSE (filtro, `actorId`, strip dei campi riservati); una `MutationCache` globale che dà per la prima volta una superficie d'errore all'app; e tre one-liner in `syncService.ts` che riconciliano coda e Dexie. L'ordine degli stage è dettato dalle dipendenze, non dalla severità: la diagnostica viene prima perché oggi ogni fix fallisce in silenzio e non sarebbe verificabile.

**Tech Stack:** Fastify 5 · Prisma 7 · PostgreSQL 15 · Zod · React 19 · Vite · TanStack Query 5.90 · Dexie 4 · Zustand · Tailwind · Vitest (entrambi i workspace) · Playwright (non ancora in CI) · SSE per il realtime kanban.

**Spec:** `docs/plans/2026-08-31-kanban-hardening.md` — audit del 2026-08-31 (38 agent, 14 dimensioni + 4 gap investigation, verifica avversariale per dimensione). Contiene i 7 temi strutturali, la tabella dei rischi e l'appendice con tutti i 185 finding verificati (7 critical, 42 high, 83 medium, 53 low). **Leggere la spec insieme al piano: il piano argomenta dalla spec.**

---

## Global Constraints

Valgono per **ogni** task. Non vengono ripetute nei singoli task.

- **Branch:** tutto il lavoro su `fix/kanban-hardening`, mai su `main`. Un commit per task.
- **i18n:** ogni stringa utente passa da `t('key')` e la chiave va aggiunta a **entrambi** `frontend/src/locales/en.json` e `frontend/src/locales/it.json`. Le chiavi delle notifiche backend vanno anche in `backend/src/utils/notificationI18n.ts`.
- **Dark mode:** ogni elemento UI nuovo o modificato deve avere le varianti `dark:`.
- **`window.confirm()` è vietato** — usare il componente `ConfirmDialog` esistente.
- **File TIER 1** (rischio perdita dati — un cambio per commit, mai batchare): `frontend/src/features/sync/syncService.ts`, `frontend/src/lib/db.ts`, `backend/prisma/schema.prisma`, `backend/src/hocuspocus.ts`, `frontend/src/utils/crypto.ts`, `frontend/src/store/vaultStore.ts`.
- **File TIER 2** (impatto trasversale — diff proposto prima di applicare): `frontend/src/lib/api.ts`, `frontend/src/store/authStore.ts`, `backend/src/app.ts`, `backend/src/services/auth.service.ts`, `frontend/src/components/editor/Editor.tsx`, `backend/src/services/email.service.ts`.
- **Versioni Dexie:** mai modificare una versione esistente in `db.ts`. Solo aggiungerne di nuove — e una proprietà non indicizzata **non richiede** un bump di versione.
- **Test:** Vitest in entrambi i workspace. Backend `cd backend && npx vitest run <path>`, frontend `cd frontend && npx vitest run <path>`. Singolo test: `-t "nome"`.
- **Typecheck:** backend `cd backend && npx tsc --noEmit`. Frontend **`cd frontend && npx tsc -p tsconfig.app.json --noEmit`** — ⚠️ `npx tsc --noEmit` liscio nel frontend esce 0 senza compilare nulla (`tsconfig.json` ha `"files": []`): è un controllo finto, non usarlo mai come verifica.
- **Lint:** `npm run lint` nel workspace toccato.
- **Baseline verde da mantenere** (misurata sul branch `fix/kanban-hardening` al commit `a767527`, 2026-08-31): backend `Test Files 61 passed, Tests 1083 passed`; frontend `Test Files 9 passed, Tests 131 passed`. Se un task fa scendere questi numeri senza averlo dichiarato, è una regressione. ⚠️ Alcuni stage citano `62 / 1089` nei loro step: è sbagliato, vale il numero qui sopra.
- **Prisma:** `npx prisma` legge `prisma.config.js` che richiede `backend/.env`. Niente flag `--schema`. Prisma 7: `db execute --file`, non `--stdin`.
- **Commit:** convenzione del repo — `fix(kanban): ...`, `feat(kanban): ...`, `test(kanban): ...`, `perf(kanban): ...`, `chore(...): ...`. Imperativo, minuscolo dopo i due punti.
- **TDD:** test che fallisce → eseguirlo e vederlo fallire con l'errore atteso → implementazione minima → test verde → commit. Dove un task non può portare un test (aggiunta di una chiave i18n, una stringa di route), lo dichiara e porta una **Verifica** manuale o un `grep` che dimostra il cambio.

---

## Ordine e dipendenze

```
Stage 0  Diagnostica        4 task   ── sblocca la verificabilità di tutto il resto
   │                                    0.4 (SSE reconnect) è prerequisito duro di 5.3
   ├── Stage 1  Permessi   10 task   ── backend-only, i 10 task sono paralleli tra loro
   │      └── Stage 4  SSE  6 task   ── dopo Stage 1 (revoke = confine di autorizzazione stabile)
   ├── Stage 2  position    6 task   ── SEQUENZIALE: 2.1 prima di 2.2, sempre
   ├── Stage 3  Sync        7 task   ── ⚠️ TIER 1, un cambio per commit
   └── Stage 5  Carico      6 task   ── 5.3 bloccato su 0.4; 5.2 ha senso solo dopo 5.1
       Stage 6  Rinviabile  5 task   ── nessuna dipendenza; 6.5 dopo che lo Stage 3 si è assestato
```

**Le tre trappole del piano stesso** (dalla tabella rischi della spec, ripetute qui perché costano dati):

1. Il resequence di `moveCard` (2.2) **deve** scrivere solo le righe la cui posizione cambia davvero. `KanbanCard.updatedAt` è `@updatedAt`, Prisma lo applica su `updateMany`, e `archiveCompletedCards` filtra su `updatedAt`: una riscrittura piena azzera il timer di archiviazione a 7 giorni dell'intera colonna ad ogni drag.
2. In 3.6 il filtro di ownership va rilassato **nello stesso commit** in cui si cancella il blocco di pull shared. Quel blocco è l'unico path che pruna le board shared revocate.
3. **Non aggiungere `@@unique([columnId, position])`.** Lo shift `increment: 1` lo viola transitoriamente dentro la transazione, e i dati di produzione hanno già posizioni duplicate per via del bug 2.2: la migration fallirebbe sui dati reali.

---

## Registro avanzamento

Spuntare la riga **dopo** che il task è stato eseguito **e** committato, incollando lo short hash.


### Stage 0 — Diagnostica

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [x] | **0.1** | Aggiungere un handler globale `onError` alle mutation | `f711230` |
| [x] | **0.2** | Aggiungere le tre chiavi i18n mancanti | `f36e57a` |
| [x] | **0.3** | Correggere i nomi dei placeholder nelle notifiche di commento e chat board | `d2d4e9d` |
| [x] | **0.4** | Far riconnettere l'SSE su risposta non-OK e su fine stream pulita | `6e014e8` |

### Stage 1 — Buchi di permessi

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [x] | **1.1** | Aggiungere `assertBelongsToBoard` a kanbanPermissions | `c68438e..5ac03b7` |
| [x] | **1.2** | Bloccare lo spostamento di card fra board diverse | `feb2b23` |
| [x] | **1.3** | Limitare `reorderColumns` alle colonne della board | `c81c748` |
| [x] | **1.4** | Validare `assigneeId` contro i partecipanti della board | `70a5952..289097c` |
| [x] | **1.5** | Rimuovere `noteId` dal percorso di update della card | `9571cf0` |
| [x] | **1.6** | Controllo d'accesso in `linkTaskListToBoard` | `44dc60d` |
| [x] | **1.7** | `shareWithUserIds` diventa un filtro, non una lista di concessione | `f4750d6` |
| [x] | **1.8** | `checkNoteSharingForBoard` deve verificare il proprietario della nota | `e28265d` |
| [x] | **1.9** | `deleteComment` deve rivalidare l'accesso alla board | `d7dff00` |
| [x] | **1.10** | La ri-condivisione di una board non deve riportare a PENDING uno share ACCEPTED | `43c201d` |

### Stage 2 — Riscrittura di position

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [ ] | **2.1** | Estrarre `computeColumnOrder` come funzione pura | `` |
| [ ] | **2.2** | Riscrivere `moveCard` come resequence diff-based | `` |
| [ ] | **2.3** | Tiebreaker deterministico su ogni ordinamento per `position` | `` |
| [ ] | **2.4** | Eliminare il sentinella `999` | `` |
| [ ] | **2.5** | Rispecchiare insert-and-shift nella scrittura Dexie | `` |
| [ ] | **2.6** | Atomizzare `aggregate` + `create` in `createCard` e `createColumn` | `` |

### Stage 3 — Sync e offline (TIER 1)

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [ ] | **3.1** | Scope `useKanbanBoards` all'utente corrente e stampa `viewerId` in pull | `` |
| [ ] | **3.2** | Risolvere il `columnId` della card CREATE da Dexie invece che dal payload in coda | `` |
| [ ] | **3.3** | Non scartare più in silenzio una CREATE che va in 404 | `` |
| [ ] | **3.4** | Far restituire a `syncPush` la promise in volo e incatenare il refresh della board | `` |
| [ ] | **3.5** | Rimuovere il guard "non pushare mai le board condivise" | `` |
| [ ] | **3.6** | Eliminare il pull duplicato delle board condivise e allargare il prune (stesso commit) | `` |
| [ ] | **3.7** | Isolare notebooks, tags e notes in `syncPull` con try/catch propri | `` |

### Stage 4 — Chokepoint SSE

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [ ] | **4.1** | Aggiungere `actorId` a `KanbanEvent` e togliere la nota collegata dentro `broadcast()` | `` |
| [ ] | **4.2** | Filtrare lato client l'eco dei propri eventi | `` |
| [ ] | **4.3** | `disconnectUser()` e chiusura degli stream sul revoke della board | `` |
| [ ] | **4.4** | Emettere `board:updated` da update, delete e dalle quattro route cover/avatar | `` |
| [ ] | **4.5** | Fare invalidare la board query all'evento `connected` | `` |
| [ ] | **4.6** | Allineare la union di eventi frontend a quella backend | `` |

### Stage 5 — Carico

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [ ] | **5.1** | Togliere le scritture da `getBoard` | `` |
| [ ] | **5.2** | Saltare il fetch di dettaglio per board in `syncPull` quando non serve | `` |
| [ ] | **5.3** | Rimuovere il poll a 3 secondi dalla chat di board | `` |
| [ ] | **5.4** | Paginare chat e commenti dal più recente | `` |
| [ ] | **5.5** | Batchare la lookup dei destinatari e togliere l'SMTP dal request path | `` |
| [ ] | **5.6** | Eliminare il doppio invio di ogni card in `handleBulkMove` | `` |

### Stage 6 — Rinviabile

| ✓ | Task | Titolo | Commit |
|---|------|--------|--------|
| [ ] | **6.1** | Sweep di accessibilità sul kanban (label, tastiera, hover-trap) | `` |
| [ ] | **6.2** | Spiegare perché il board diventa read-only con i filtri attivi, e persistere i filtri | `` |
| [ ] | **6.3** | Hardening cover/avatar — estensione dal mimetype validato e cleanup su delete board | `` |
| [ ] | **6.4** | Query limitate — paginazione archivio, indice sui commenti, cap sui reminder | `` |
| [ ] | **6.5** | Collegare la suite Playwright alla CI | `` |

**Totale: 44 task.**

---

## Stage 0 — Diagnostica (sblocca tutto)

Ogni fix delle stage successive è oggi **invisibile**: `grep -c onError frontend/src/features/kanban/hooks/useKanbanMutations.ts` restituisce `0`, `frontend/src/lib/queryClient.ts` (12 righe in tutto) non ha alcuna `MutationCache`, e l'interceptor in `frontend/src/lib/api.ts` gestisce solo il 401 (`api.ts:33`) — tutti gli altri status vengono ri-rigettati senza che nulla li mostri all'utente. In più tre chiavi i18n mancano davvero e tre notifiche kanban interpolano placeholder sbagliati, quindi anche quando un errore arriva a schermo è vuoto o monco. Infine il canale SSE muore in silenzio al primo hiccup. Prima di iniziare deve essere vero: repo su `main`, `cd backend && npx vitest run` verde (baseline: `Test Files 62 passed`, `Tests 1089 passed`), `cd frontend && npx vitest run` verde (baseline: `Test Files 9 passed`, `Tests 131 passed`), `backend/.env` presente. Nessun file TIER 1 viene toccato in questa stage.

> **Comando di typecheck del frontend — leggere prima di iniziare.** `frontend/tsconfig.json` contiene solo `{"files": [], "references": [...]}`. Di conseguenza **`cd frontend && npx tsc --noEmit` esce 0 senza compilare nulla**: è un controllo finto. Il typecheck reale del frontend è **`npx tsc -p tsconfig.app.json --noEmit`** ed è quello usato in ogni step di questa stage. Sul backend `npx tsc --noEmit` è corretto, ma `backend/tsconfig.json` ha `"exclude": ["node_modules", "src/**/__tests__/**"]`: i file di test backend **non** vengono typecheckati, solo eseguiti da Vitest.

---

### Task 0.1: Aggiungere un handler globale `onError` alle mutation

**Perché:** Oggi una mutation kanban che fallisce (403 permessi, 400 validazione, 500) non produce nessun output: nessun toast, nessun log, la UI resta ferma e l'utente pensa di aver salvato. Senza questo handler non è possibile validare nessuno dei fix delle stage successive, perché il loro rifiuto è invisibile.
**Severità:** critical · **Effort:** M · **Rischio:** none — nessun file negli elenchi TIER 1/TIER 2. Ma `queryClient.ts` è l'istanza passata a `<QueryClientProvider>` in `main.tsx` e quindi è condivisa da ogni mutation dell'app: trattalo con la stessa cautela di un file TIER 2. Un handler troppo aggressivo produce toast doppi o toast su errori già gestiti.

**File:**
- Modifica: `frontend/src/lib/queryClient.ts:1-12` (riscrittura completa del file — sono 12 righe in tutto)
- Modifica: `frontend/src/features/kanban/KanbanBoardPage.tsx:12`, `:203-207`, `:236-244`, `:295-303`
- Crea: `frontend/src/lib/__tests__/queryClient.test.ts` (la cartella `frontend/src/lib/__tests__/` **non esiste**, va creata)

**Interfacce:**
- Consuma: `getApiErrorMessage(error: unknown, fallbackKey = 'common.somethingWentWrong'): string` da `frontend/src/utils/errorUtils.ts` (già esistente: legge `error?.response?.data?.message`, se assente ritorna `i18n.t(fallbackKey)`, altrimenti `i18n.t(message)`)
- Produce: `export function handleMutationError(error: unknown, mutation?: { options?: { onError?: unknown } }): void` — usata dalle stage successive per non duplicare la gestione errori nelle singole mutation

**Contesto verificato prima di iniziare (non riverificare):**
- `frontend/src/lib/api.ts` intercetta SOLO `error.response?.status === 401` (riga 33): tenta `/auth/refresh` (riga 53), e se fallisce chiama `useAuthStore.getState().logout()` (righe 36 e 61). Nessun altro status viene toccato. Quindi il nuovo handler **deve saltare il 401**, altrimenti al logout compare un toast inutile.
- `queryClient` è passato a `<QueryClientProvider client={queryClient}>` nelle ultime righe di `frontend/src/main.tsx`. Nessun altro `QueryClient` viene istanziato in `src/`.
- `import { Toaster } from 'react-hot-toast'` è a `frontend/src/App.tsx:6`; il componente `<Toaster` è montato a `frontend/src/App.tsx:44`.
- Versione installata: `@tanstack/react-query@5.90.21` (`query-core@5.90.20`). `MutationCache` è ri-esportata da `@tanstack/react-query` (`build/modern/index.d.ts` riga 1: `export * from '@tanstack/query-core'`). La firma di `MutationCacheConfig.onError` (`node_modules/@tanstack/query-core/build/modern/hydration-BlEVG2Lp.d.ts:169`) è:
  `onError?: (error: DefaultError, variables: unknown, onMutateResult: unknown, mutation: Mutation<unknown, unknown, unknown>, context: MutationFunctionContext) => Promise<unknown> | unknown` — il **quarto** argomento è la `mutation`, e `Mutation.options` è pubblica (stesso file, riga 268).
- **Rischio toast doppi.** `MutationCache.onError` gira *in aggiunta* all'`onError` della singola mutation. `grep -rn "onError" frontend/src` restituisce, oltre a props `<img onError>` (`vault/CredentialCard.tsx:58`, `vault/CredentialForm.tsx:364`), a un'opzione di hook custom (`hooks/useImport.tsx:15,112`) e a due stringhe di locale (`en.json:1507`, `it.json:1507`), questi handler passati a `useMutation({...})`: `components/editor/ChatSidebar.tsx:109`, `features/admin/tabs/ChatFilesTab.tsx:93`, `features/groups/GroupsPage.tsx:58,68,78,92,103,112,121`, `features/notebooks/NotebooksPage.tsx:38,50,62`, `features/tags/TagList.tsx:45,56`, `features/tags/TagsPage.tsx:38,53`, `features/trash/TrashPage.tsx:33,45`, `features/vault/VaultPage.tsx:75`. Tutti finiscono in `mutation.options.onError` e la guardia dell'handler li esclude senza toccare un solo file.
- Restano **tre** `onError` passati al *secondo* argomento di `.mutate()`, che NON finiscono in `mutation.options` e quindi produrrebbero toast doppi: `KanbanBoardPage.tsx:205`, `:241`, `:300`. Vengono rimossi in questo task, perché in tutti e tre i casi il messaggio globale è uguale o migliore:
  - `:205` `toast.error(t('kanban.column.hasCards'))` → `en.json:836` = "Move or delete all cards before removing this column." Ma `kanbanService.deleteColumn` (`frontend/src/features/kanban/kanbanService.ts:252-280`) è una transazione Dexie che alla riga 260 fa `db.kanbanCards.where('columnId').equals(columnId).delete()`: cancella lui stesso le card della colonna. Quel messaggio non può mai essere vero su quel path. È testo morto.
  - `:241` `toast.error(t('kanban.cover.uploadError'))` → `en.json:914` = "Failed to upload cover image"; il backend risponde `errors.kanban.coverTooLarge` = "File too large (max 5MB)" (`en.json`, blocco `errors.kanban`), più informativo.
  - `:300` `toast.error(t('common.genericError'))` → `en.json:18` = "An error occurred"; il backend risponde `errors.kanban.avatarTooLarge` = "File too large (max 2MB)".
- `frontend/vitest.config.ts`: `environment: 'jsdom'`, `include: ['src/**/*.test.ts', 'src/**/*.test.tsx']`, `setupFiles: ['./src/__tests__/setup.ts']`. Il setup importa solo `@testing-library/jest-dom` e stubba `localStorage`: non mocka né `i18next` né `react-hot-toast`, quindi il test qui sotto deve mockarli da sé.

- [ ] **Step 1 — Scrivere il test (fallisce: l'export non esiste)**

Crea la cartella `frontend/src/lib/__tests__/` e dentro il file `queryClient.test.ts` con esattamente questo contenuto:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// errorUtils importa `i18n from 'i18next'` e chiama i18n.t(chiave).
// Restituendo la chiave verbatim possiamo asserire sul messaggio esatto.
vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

import toast from 'react-hot-toast';
import { handleMutationError } from '../queryClient';

function axiosError(status: number, message?: string) {
  return { response: { status, data: message ? { message } : {} } };
}

describe('handleMutationError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts the translated server message on a 403', () => {
    handleMutationError(axiosError(403, 'errors.kanban.ownerOnly'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('errors.kanban.ownerOnly');
  });

  it('falls back to common.somethingWentWrong when the response has no message', () => {
    handleMutationError(axiosError(500));
    expect(toast.error).toHaveBeenCalledWith('common.somethingWentWrong');
  });

  it('stays silent on 401 (api.ts already refreshes the token or logs out)', () => {
    handleMutationError(axiosError(401, 'errors.common.accessDenied'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays silent when the mutation declares its own onError', () => {
    handleMutationError(axiosError(400, 'errors.kanban.columnHasCards'), {
      options: { onError: () => {} },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts when the mutation has options but no onError', () => {
    handleMutationError(axiosError(400, 'errors.kanban.columnHasCards'), {
      options: {},
    });
    expect(toast.error).toHaveBeenCalledWith('errors.kanban.columnHasCards');
  });

  it('toasts the fallback on a network error with no response at all', () => {
    handleMutationError(new Error('Network Error'));
    expect(toast.error).toHaveBeenCalledWith('common.somethingWentWrong');
  });
});
```

Nota: le stringhe `'errors.kanban.ownerOnly'` e `'errors.kanban.columnHasCards'` qui sono solo payload passanti — `i18next` è mockato per restituire la chiave, quindi questo test **non** dipende dal Task 0.2.

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd frontend && npx vitest run src/lib/__tests__/queryClient.test.ts`
Atteso: FAIL — `Test Files  1 failed (1)` / `Tests  6 failed (6)`. Ogni test fallisce con
`TypeError: __vi_import_1__.handleMutationError is not a function`
perché `queryClient.ts` non esporta ancora nulla oltre al default.

- [ ] **Step 3 — Riscrivere `frontend/src/lib/queryClient.ts`**

Sostituisci **l'intero contenuto** del file con:

```ts
import { QueryClient, MutationCache } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '../utils/errorUtils';

/**
 * Global mutation error handler.
 *
 * Without this, a failed mutation produces no observable output at all:
 * no toast, no log, the UI just stays put and the user assumes it saved.
 *
 * Two deliberate exemptions:
 *  - 401: api.ts already refreshes the token, or logs out. A toast there is noise.
 *  - mutations that declare their own onError in useMutation({...}): they already
 *    show a specific message, so a second generic toast would be a duplicate.
 */
export function handleMutationError(
  error: unknown,
  mutation?: { options?: { onError?: unknown } },
): void {
  if (mutation?.options?.onError) return;

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 401) return;

  toast.error(getApiErrorMessage(error));
}

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _onMutateResult, mutation) =>
      handleMutationError(error, mutation),
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

export default queryClient;
```

- [ ] **Step 4 — Eseguire il test e vederlo passare**

Run: `cd frontend && npx vitest run src/lib/__tests__/queryClient.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

- [ ] **Step 5 — Rimuovere i tre `onError` a livello di `.mutate()` in `KanbanBoardPage.tsx`**

In `frontend/src/features/kanban/KanbanBoardPage.tsx`, sostituisci la funzione alle righe **203-207**:

```tsx
  function handleDeleteColumn(columnId: string): void {
    mutations.deleteColumn.mutate(columnId, {
      onError: () => toast.error(t('kanban.column.hasCards')),
    });
  }
```

con:

```tsx
  function handleDeleteColumn(columnId: string): void {
    // The error message is now produced by the global MutationCache handler in
    // lib/queryClient.ts. The old local message said "move or delete all cards
    // first", which can never be true here: kanbanService.deleteColumn is a Dexie
    // transaction that deletes the column's cards itself.
    mutations.deleteColumn.mutate(columnId);
  }
```

Sostituisci la funzione alle righe **236-244**:

```tsx
  function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    mutations.uploadCover.mutate(
      { bid: boardId, file },
      { onError: () => toast.error(t('kanban.cover.uploadError')) },
    );
    e.target.value = '';
  }
```

con:

```tsx
  function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    // Global handler surfaces the server message (e.g. errors.kanban.coverTooLarge).
    mutations.uploadCover.mutate({ bid: boardId, file });
    e.target.value = '';
  }
```

Sostituisci la funzione alle righe **295-303**:

```tsx
  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    mutations.uploadAvatar.mutate(
      { bid: boardId, file },
      { onError: () => toast.error(t('common.genericError')) },
    );
    e.target.value = '';
  }
```

con:

```tsx
  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    // Global handler surfaces the server message (e.g. errors.kanban.avatarTooLarge).
    mutations.uploadAvatar.mutate({ bid: boardId, file });
    e.target.value = '';
  }
```

Infine cancella la riga **12**, che ora è un import inutilizzato:

```tsx
import toast from 'react-hot-toast';
```

- [ ] **Step 6 — Verificare che non resti nessun `toast` orfano nel file**

Run: `cd frontend && grep -n "toast" src/features/kanban/KanbanBoardPage.tsx`
Atteso: nessun output, exit code 1. I commenti inseriti nello Step 5 dicono di proposito "local message" e non "local toast" proprio perché questo grep resti pulito. Se stampa una riga, l'import o un uso è rimasto: rimuovilo.

- [ ] **Step 7 — Typecheck e lint**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Atteso: PASS — nessun output, exit code 0. `tsconfig.app.json` ha `noUnusedLocals: true`, quindi un import `toast` dimenticato produce `error TS6133: 'toast' is declared but its value is never read.`

Run: `cd frontend && npm run lint`
Atteso: PASS — l'ultima riga è `✖ 52 problems (0 errors, 52 warnings)`. Le 52 warning sono preesistenti (`react-hooks/set-state-in-effect`, `react-hooks/exhaustive-deps` ecc., configurate come `warn` in `eslint.config.js`). L'unica cosa che conta è **`0 errors`**. Se il conteggio warning cresce di 1 su `KanbanBoardPage.tsx` o `queryClient.ts`, hai introdotto qualcosa: guarda quale.

- [ ] **Step 8 — Verifica manuale (il wiring `MutationCache → handleMutationError` non è coperto da un test)**

Non esiste in `frontend/src` nessun test che renderizzi dentro un `QueryClientProvider` (l'unico riferimento a `QueryClientProvider` è `src/main.tsx`), quindi il cablaggio non è verificabile a unità: il test dello Step 1 copre l'handler, non il fatto che la `MutationCache` lo chiami. Verifica così:
1. `cd backend && npm run dev` e `cd frontend && npm run dev`
2. Apri una board kanban, DevTools → Network → attiva "Offline"
3. Carica una cover image (pulsante cover della board)
4. Atteso: appare un toast rosso con "Something went wrong." / "Qualcosa è andato storto." — **uno solo**, non due.
5. Rimetti online, ricarica: nessun toast al login.

- [ ] **Step 9 — Suite frontend completa (regressione)**

Run: `cd frontend && npx vitest run`
Atteso: PASS — `Test Files  10 passed (10)` / `Tests  137 passed (137)` (9 file e 131 test di baseline, più il nuovo `src/lib/__tests__/queryClient.test.ts` con 6 test). La suite impiega ~85 s: `crypto.test.ts` è lenta di suo (~10 s per test), non è un blocco.

- [ ] **Step 10 — Commit**

```bash
git add frontend/src/lib/queryClient.ts frontend/src/lib/__tests__/queryClient.test.ts frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat(frontend): surface mutation errors with a global MutationCache handler"
```

---

### Task 0.2: Aggiungere le tre chiavi i18n mancanti

**Perché:** Un utente non-owner che tenta un bulk-archive riceve un toast con la chiave grezza `errors.kanban.ownerOnly` (non esiste in nessuno dei due file di locale, e i18next stampa la chiave quando non trova la traduzione); il modal "Condividi Nota con i Membri della Board" mostra un paragrafo vuoto; e la notifica push di spostamento multiplo card arriva con testo generico perché la chiave non è nel dizionario backend, mentre la stessa notifica in-app renderizza "Mario ha spostato  card su Board: " perché `buildArgs` scarta `count` e `summary`.
**Severità:** high · **Effort:** S · **Rischio:** none — nessun file TIER 1/2; sole aggiunte, nessuna chiave esistente modificata.

**File:**
- Modifica: `frontend/src/locales/en.json:966-969`, `:1549`
- Modifica: `frontend/src/locales/it.json:1221-1224`, `:1549`
- Modifica: `backend/src/utils/notificationI18n.ts:165-169`
- Modifica: `frontend/src/features/notifications/NotificationItem.tsx:125-132`
- Crea: `backend/src/utils/__tests__/notificationI18n.test.ts` (la cartella `backend/src/utils/__tests__/` esiste già: contiene `contentGuard.test.ts`, `extractText.test.ts`, `ydocIntegrity.test.ts`)

**Interfacce:**
- Consuma: `resolveNotification(localizationKey: string | undefined, localizationArgs: Record<string, string> | undefined, locale: string | null | undefined, fallbackTitle: string, fallbackBody: string): { title: string; body: string }` da `backend/src/utils/notificationI18n.ts:203-225` (già esistente)
- Produce: le chiavi frontend `kanban.noteLink.sharingGapDescription` ed `errors.kanban.ownerOnly`, e le voci backend `notifications.kanbanBulkMove` + `notifications.kanbanBulkMove_TITLE`. Il Task 0.3 dipende dal fatto che `resolveNotification` sia importabile e funzionante (lo è già), non da queste chiavi.

**Contesto verificato prima di iniziare (non riverificare):**
- `grep -rn "errors.kanban.ownerOnly" backend/src frontend/src` → SOLO `backend/src/routes/kanban.ts:584` e `:595`, entrambi `if (!isOwner) throw new ForbiddenError('errors.kanban.ownerOnly');` (rispettivamente `POST /boards/:id/bulk-archive-preview` e `POST /boards/:id/bulk-archive`). Zero occorrenze nei locale. **Chiave assente confermata.**
- `grep -rn "sharingGap" frontend/src` → `features/kanban/components/SharingGapModal.tsx:44` usa `kanban.noteLink.sharingGapTitle` (presente: `en.json:966`, `it.json:1221`) e `SharingGapModal.tsx:49` usa `kanban.noteLink.sharingGapDescription` (**assente in entrambi**). L'unica variabile di interpolazione passata è `noteTitle`: `t('kanban.noteLink.sharingGapDescription', { noteTitle: sharingCheck.noteTitle })`.
- `notifications.kanbanBulkMove` e `notifications.kanbanBulkMove_TITLE` **esistono già** nei locale frontend (`en.json:763-764`, `it.json:1018-1019`) — non toccarli. Manca solo la voce nel dizionario backend `notificationI18n.ts`. Il call site è `backend/src/services/kanban/card.service.ts:542-561`: `localizationKey: 'notifications.kanbanBulkMove'` (riga 554) con `localizationArgs: { actorName, count: String(totalCount), boardTitle: board.title, summary }` (righe 555-560).
- `buildArgs` in `NotificationItem.tsx:83-135` è una whitelist esplicita; il blocco kanban è alle righe 125-132 e copre `assignerName`, `cardTitle`, `boardTitle`, `authorName`, `actorName`, `fromColumn`, `toColumn`. `senderName` è già gestito a parte (riga 123). `count` e `summary` **non** ci sono. La chiave usata per il rendering viene da `NotificationItem.tsx:184` (`data.localizationKey || TYPE_TO_KEY[notification.type]`), quindi la notifica bulk-move usa davvero il template `kanbanBulkMove` e resta con due buchi. **Da aggiungere, confermato.**
- `interpolate` (`notificationI18n.ts:194-196`) lascia il placeholder intatto (`{{key}}`) quando l'arg manca, e `resolveNotification` ritorna `{ title: fallbackTitle, body: fallbackBody }` quando `translations[localizationKey]` è `undefined` (riga 216).

- [ ] **Step 1 — Scrivere il test backend (fallisce: chiave assente nel dizionario)**

Crea `backend/src/utils/__tests__/notificationI18n.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveNotification } from '../notificationI18n';

describe('notificationI18n — kanbanBulkMove', () => {
  const args = {
    actorName: 'Alice',
    count: '3',
    boardTitle: 'Sprint 42',
    summary: '2 × Done, 1 × Doing',
  };

  it('resolves the English body and title', () => {
    const { title, body } = resolveNotification(
      'notifications.kanbanBulkMove',
      args,
      'en',
      'FallbackTitle',
      'FallbackBody',
    );
    expect(title).toBe('Cards Moved');
    expect(body).toBe('Alice moved 3 cards on Sprint 42: 2 × Done, 1 × Doing');
  });

  it('resolves the Italian body and title', () => {
    const { title, body } = resolveNotification(
      'notifications.kanbanBulkMove',
      args,
      'it',
      'FallbackTitle',
      'FallbackBody',
    );
    expect(title).toBe('Card Spostate');
    expect(body).toBe('Alice ha spostato 3 card su Sprint 42: 2 × Done, 1 × Doing');
  });

  it('leaves no unresolved {{placeholder}} in either locale', () => {
    for (const locale of ['en', 'it']) {
      const { body } = resolveNotification(
        'notifications.kanbanBulkMove',
        args,
        locale,
        'FallbackTitle',
        'FallbackBody',
      );
      // Guard against a vacuous pass: an unknown key returns fallbackBody,
      // which trivially contains no {{placeholder}}.
      expect(body).not.toBe('FallbackBody');
      expect(body).not.toContain('{{');
    }
  });
});
```

L'asserzione `expect(body).not.toBe('FallbackBody')` non è decorativa: senza di essa il terzo test passerebbe anche **prima** del fix, perché la stringa di fallback non contiene `{{`.

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/utils/__tests__/notificationI18n.test.ts`
Atteso: FAIL — `Test Files  1 failed (1)` / `Tests  3 failed (3)`, con esattamente questi tre messaggi:
```
resolves the English body and title
AssertionError: expected 'FallbackTitle' to be 'Cards Moved' // Object.is equality

resolves the Italian body and title
AssertionError: expected 'FallbackTitle' to be 'Card Spostate' // Object.is equality

leaves no unresolved {{placeholder}} in either locale
AssertionError: expected 'FallbackBody' not to be 'FallbackBody' // Object.is equality
```
Causa: `resolveNotification` fa `if (!bodyEntry) return { title: fallbackTitle, body: fallbackBody };` e `translations['notifications.kanbanBulkMove']` è `undefined`.

- [ ] **Step 3 — Aggiungere la voce al dizionario backend**

In `backend/src/utils/notificationI18n.ts`, tra la chiusura di `'notifications.kanbanCardMoved_TITLE'` (riga 168, `  },`) e il commento `  // --- Chat ---` (riga 169), inserisci:

```ts
  'notifications.kanbanBulkMove': {
    en: '{{actorName}} moved {{count}} cards on {{boardTitle}}: {{summary}}',
    it: '{{actorName}} ha spostato {{count}} card su {{boardTitle}}: {{summary}}',
  },
  'notifications.kanbanBulkMove_TITLE': {
    en: 'Cards Moved',
    it: 'Card Spostate',
  },
```

Il contesto risultante (righe 165-177) deve essere esattamente:

```ts
  'notifications.kanbanCardMoved_TITLE': {
    en: 'Card Moved',
    it: 'Card Spostata',
  },
  'notifications.kanbanBulkMove': {
    en: '{{actorName}} moved {{count}} cards on {{boardTitle}}: {{summary}}',
    it: '{{actorName}} ha spostato {{count}} card su {{boardTitle}}: {{summary}}',
  },
  'notifications.kanbanBulkMove_TITLE': {
    en: 'Cards Moved',
    it: 'Card Spostate',
  },
  // --- Chat ---
```

- [ ] **Step 4 — Eseguire il test e vederlo passare**

Run: `cd backend && npx vitest run src/utils/__tests__/notificationI18n.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` / `Tests  3 passed (3)`.

- [ ] **Step 5 — Aggiungere `count` e `summary` alla whitelist `buildArgs`**

In `frontend/src/features/notifications/NotificationItem.tsx`, sostituisci le righe **125-132**:

```tsx
  // Kanban — assignerName, cardTitle, boardTitle, authorName, actorName, fromColumn, toColumn
  if (src.assignerName) args.assignerName = src.assignerName;
  if (src.cardTitle) args.cardTitle = src.cardTitle;
  if (src.boardTitle) args.boardTitle = src.boardTitle;
  if (src.authorName) args.authorName = src.authorName;
  if (src.actorName) args.actorName = src.actorName;
  if (src.fromColumn) args.fromColumn = src.fromColumn;
  if (src.toColumn) args.toColumn = src.toColumn;
```

con:

```tsx
  // Kanban — assignerName, cardTitle, boardTitle, authorName, actorName, fromColumn, toColumn
  if (src.assignerName) args.assignerName = src.assignerName;
  if (src.cardTitle) args.cardTitle = src.cardTitle;
  if (src.boardTitle) args.boardTitle = src.boardTitle;
  if (src.authorName) args.authorName = src.authorName;
  if (src.actorName) args.actorName = src.actorName;
  if (src.fromColumn) args.fromColumn = src.fromColumn;
  if (src.toColumn) args.toColumn = src.toColumn;

  // count, summary — used by kanbanBulkMove. Note: count can legitimately be
  // the number 0-as-string, so test for null/undefined, not falsiness.
  if (src.count !== undefined && src.count !== null) args.count = String(src.count);
  if (src.summary) args.summary = src.summary;
```

- [ ] **Step 6 — Aggiungere `sharingGapDescription` a `en.json`**

In `frontend/src/locales/en.json`, dentro il blocco `"noteLink"`, sostituisci le righe **966-969**:

```json
      "sharingGapTitle": "Share Note with Board Members",
      "usersWithAccess": "Already have access",
      "usersWithoutAccess": "Will be given access",
      "confirmLink": "Link & Share"
```

con:

```json
      "sharingGapTitle": "Share Note with Board Members",
      "sharingGapDescription": "Some board members cannot open \"{{noteTitle}}\". Select who should get access to it.",
      "usersWithAccess": "Already have access",
      "usersWithoutAccess": "Will be given access",
      "confirmLink": "Link & Share"
```

- [ ] **Step 7 — Aggiungere `sharingGapDescription` a `it.json`**

In `frontend/src/locales/it.json`, dentro il blocco `"noteLink"`, sostituisci le righe **1221-1224**:

```json
      "sharingGapTitle": "Condividi Nota con i Membri della Board",
      "usersWithAccess": "Hanno gia' accesso",
      "usersWithoutAccess": "Riceveranno accesso",
      "confirmLink": "Collega e Condividi"
```

con:

```json
      "sharingGapTitle": "Condividi Nota con i Membri della Board",
      "sharingGapDescription": "Alcuni membri della board non possono aprire \"{{noteTitle}}\". Seleziona chi deve ricevere l'accesso.",
      "usersWithAccess": "Hanno gia' accesso",
      "usersWithoutAccess": "Riceveranno accesso",
      "confirmLink": "Collega e Condividi"
```

- [ ] **Step 8 — Aggiungere `errors.kanban.ownerOnly` a `en.json`**

In `frontend/src/locales/en.json`, dentro `"errors" > "kanban"`, sostituisci la riga **1549**:

```json
      "onlyOwnerCanDelete": "Only the owner can delete a board",
```

con:

```json
      "onlyOwnerCanDelete": "Only the owner can delete a board",
      "ownerOnly": "Only the board owner can perform this action",
```

- [ ] **Step 9 — Aggiungere `errors.kanban.ownerOnly` a `it.json`**

In `frontend/src/locales/it.json`, dentro `"errors" > "kanban"`, sostituisci la riga **1549**:

```json
      "onlyOwnerCanDelete": "Solo il proprietario può eliminare la board",
```

con:

```json
      "onlyOwnerCanDelete": "Solo il proprietario può eliminare la board",
      "ownerOnly": "Solo il proprietario della board può eseguire questa azione",
```

- [ ] **Step 10 — Verifica: entrambi i locale hanno tutte e due le chiavi nuove**

Le aggiunte a JSON di traduzione non sono coperte da unit test in questo repo (non esiste un test di parità dei locale). Prova della modifica:

Run: `cd frontend && grep -c '"ownerOnly"\|"sharingGapDescription"' src/locales/en.json src/locales/it.json`
Atteso, esattamente:
```
src/locales/en.json:2
src/locales/it.json:2
```
Un `1` da una parte significa che una delle due chiavi è stata dimenticata in quel file.

- [ ] **Step 11 — Verifica: i JSON sono ancora validi**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/it.json','utf8')); console.log('locales OK')"`
Atteso: `locales OK`. Un `SyntaxError: Unexpected token` significa virgola mancante o doppia in uno dei blocchi modificati.

- [ ] **Step 12 — Typecheck di entrambi i workspace**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Atteso: PASS — nessun output, exit code 0.

Run: `cd backend && npx tsc --noEmit`
Atteso: PASS — nessun output, exit code 0.

- [ ] **Step 13 — Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json backend/src/utils/notificationI18n.ts backend/src/utils/__tests__/notificationI18n.test.ts frontend/src/features/notifications/NotificationItem.tsx
git commit -m "fix(i18n): add missing kanban ownerOnly, sharingGapDescription and bulkMove keys"
```

---

### Task 0.3: Correggere i nomi dei placeholder nelle notifiche di commento e chat board

**Perché:** Le tre notifiche kanban di commento/chat arrivano con buchi nel testo: «{{authorName}} ha commentato "Card X" nella board "{{boardTitle}}"» invece di «Mario ha commentato "Card X" nella board "Sprint 42"». Gli argomenti passati si chiamano `commenterName`/`deleterName`/`authorName`, i template si aspettano `authorName`/`senderName`, e `boardTitle` non viene proprio recuperato dal DB.
**Severità:** high · **Effort:** M · **Rischio:** none — nessun file TIER 1/2; le select Prisma vengono estese, non ristrette.

**File:**
- Modifica: `backend/src/services/kanban/comments-chat.service.ts:38-45`, `:79`, `:97-105`, `:135`, `:235`
- Modifica: `backend/src/services/kanban/__tests__/comments-chat.service.test.ts` (nuovo import + helper dopo la riga 46; tre nuovi test; sei mock esistenti alle righe 146, 180, 204, 244, 275, 293)

**Interfacce:**
- Consuma: `resolveNotification(localizationKey, localizationArgs, locale, fallbackTitle, fallbackBody): { title: string; body: string }` da `backend/src/utils/notificationI18n.ts`
- Produce: nessuna

**Contesto verificato prima di iniziare (non riverificare):**

| Call site (HEAD) | `localizationKey` | args attuali (SBAGLIATI) | placeholder del template |
|---|---|---|---|
| `comments-chat.service.ts:78-79` (`createComment`) | `notifications.kanbanCommentAdded` | `{ commenterName, cardTitle }` | `{{authorName}}`, `{{cardTitle}}`, `{{boardTitle}}` |
| `comments-chat.service.ts:134-135` (`deleteComment`) | `notifications.kanbanCommentDeleted` | `{ deleterName, cardTitle }` | `{{authorName}}`, `{{cardTitle}}`, `{{boardTitle}}` |
| `comments-chat.service.ts:234-235` (`createBoardChatMessage`) | `notifications.kanbanBoardChat` | `{ authorName, boardTitle }` | `{{senderName}}`, `{{boardTitle}}` |

I template stanno in `backend/src/utils/notificationI18n.ts:137-140` (`kanbanCommentAdded`), `:153-156` (`kanbanCommentDeleted`), `:179-182` (`kanbanBoardChat`), e sono replicati identici in `frontend/src/locales/en.json:753,757,761` / `it.json:1008,1012,1016`. La whitelist `buildArgs` di `NotificationItem.tsx:123-132` accetta `senderName`, `authorName`, `cardTitle`, `boardTitle` ma **non** `commenterName` né `deleterName`, quindi il buco esiste sia sul push che in-app.

`createComment` e `deleteComment` non recuperano il titolo della board: le select prendono solo `column: { select: { boardId: true } }`. Il modello `KanbanColumn` (`backend/prisma/schema.prisma:486-496`) ha `board KanbanBoard @relation(fields: [boardId], references: [id], onDelete: Cascade)` alla riga 492, quindi basta annidare la select. `createBoardChatMessage` invece ha già `board.title` (select a `comments-chat.service.ts:189-196`) — lì serve solo il rename.

**Non toccare** i campi top-level di `data` (`commenterName` a riga 77, `deleterName` a riga 133, `authorName` a riga 233): sono asseriti dai test esistenti alle righe 213-227, 300-314 e 440-451 e sono innocui. Si cambia solo `localizationArgs`.

Firme degli spy usati nei nuovi test (verificate): `notifyBoardUsersTiered(actorId, boardId, type, title, body, data, emailOpts)` → `data` è `mock.calls[i][5]`; `createNotification(userId, type, title, body, data)` → `data` è `mock.calls[i][4]`.

Il mock Prisma di `backend/src/__tests__/setup.ts` definisce già tutti i metodi usati (`kanbanCard.findUnique`, `kanbanComment.findUnique/create/delete`, `kanbanBoard.findUnique`, `kanbanBoardChat.create`, `user.findUnique`): nessuna augmentation aggiuntiva serve.

- [ ] **Step 1 — Scrivere i tre test (falliscono: i nomi degli args non combaciano)**

Nel file `backend/src/services/kanban/__tests__/comments-chat.service.test.ts`, subito **dopo** la riga 46 (`import { notifyBoardUsersTiered } from '../notifications';`) inserisci:

```ts
import { resolveNotification } from '../../../utils/notificationI18n';

/** Reads localizationKey/localizationArgs off the notifyBoardUsersTiered call and renders it. */
function renderTieredNotification(callIndex = 0): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (notifyBoardUsersTiered as any).mock.calls[callIndex][5];
  return resolveNotification(
    data.localizationKey,
    data.localizationArgs,
    'en',
    'FallbackTitle',
    'FallbackBody',
  ).body;
}
```

Poi, dentro `describe('createComment', ...)`, subito dopo la fine del test `'calls notifyBoardUsersTiered with correct args'` (che termina con `expect.objectContaining({ type: 'KANBAN_COMMENT' }),` / `);` / `});`), aggiungi:

```ts
    it('passes localizationArgs whose keys match the kanbanCommentAdded template', async () => {
      const user = makeUser({ name: 'Alice' });
      const boardId = 'board-args';

      mockedPrisma.kanbanCard.findUnique.mockResolvedValue({
        title: 'My Card',
        assigneeId: null,
        column: { boardId, board: { title: 'My Board' } },
      });

      const comment = makeKanbanComment({ cardId: 'card-args', authorId: user.id });
      mockedPrisma.kanbanComment.create.mockResolvedValue(commentWithAuthor(comment, user));

      await createComment('card-args', user.id, 'Nice');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (notifyBoardUsersTiered as any).mock.calls[0][5];
      expect(data.localizationArgs).toEqual({
        authorName: 'Alice',
        cardTitle: 'My Card',
        boardTitle: 'My Board',
      });
      expect(renderTieredNotification()).toBe(
        'Alice commented on "My Card" in board "My Board"',
      );
      expect(renderTieredNotification()).not.toContain('{{');
    });
```

Dentro `describe('deleteComment', ...)`, subito dopo la fine del test `'calls notifyBoardUsersTiered for comment deletion'`, aggiungi:

```ts
    it('passes localizationArgs whose keys match the kanbanCommentDeleted template', async () => {
      const user = makeUser({ name: 'Carol' });
      const boardId = 'board-del-args';

      mockedPrisma.kanbanComment.findUnique.mockResolvedValue({
        authorId: user.id,
        content: 'Bye',
        card: {
          id: 'card-del-args',
          title: 'My Card',
          column: { boardId, board: { title: 'My Board' } },
        },
        author: { name: user.name, email: user.email },
      });
      mockedPrisma.kanbanComment.delete.mockResolvedValue({});

      await deleteComment('comment-del-args', user.id);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (notifyBoardUsersTiered as any).mock.calls[0][5];
      expect(data.localizationArgs).toEqual({
        authorName: 'Carol',
        cardTitle: 'My Card',
        boardTitle: 'My Board',
      });
      expect(renderTieredNotification()).toBe(
        'Carol deleted a comment on "My Card" in board "My Board"',
      );
      expect(renderTieredNotification()).not.toContain('{{');
    });
```

Dentro `describe('createBoardChatMessage', ...)`, subito dopo la fine del test `'does NOT send email when user has emailNotificationsEnabled=false'`, aggiungi:

```ts
    it('passes localizationArgs whose keys match the kanbanBoardChat template', async () => {
      const { createNotification } = await import('../../notification.service');
      const author = makeUser({ name: 'Sender' });
      const recipient = makeUser();
      const boardId = 'board-chat-args';

      const chatMsg = makeKanbanBoardChat({ boardId, authorId: author.id, content: 'Hi' });
      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(chatWithAuthor(chatMsg, author));
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue({
        title: 'My Board',
        ownerId: recipient.id,
        shares: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (getPresenceUsers as any).mockReturnValue([]);
      mockedPrisma.user.findUnique.mockResolvedValue({
        lastActiveAt: new Date(Date.now() - 10 * 60 * 1000),
        email: recipient.email,
        locale: 'en',
        emailNotificationsEnabled: false,
      });

      await createBoardChatMessage(boardId, author.id, 'Hi');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (createNotification as any).mock.calls[0][4];
      expect(data.localizationArgs).toEqual({
        senderName: 'Sender',
        boardTitle: 'My Board',
      });

      const body = resolveNotification(
        data.localizationKey,
        data.localizationArgs,
        'en',
        'FallbackTitle',
        'FallbackBody',
      ).body;
      expect(body).toBe('Sender sent a message in board "My Board"');
      expect(body).not.toContain('{{');
    });
```

- [ ] **Step 2 — Eseguire i test e vederli fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts`
Atteso: FAIL — `Test Files  1 failed (1)` / `Tests  3 failed | 21 passed (24)`, con esattamente questi tre messaggi:
```
createComment > passes localizationArgs whose keys match the kanbanCommentAdded template
AssertionError: expected { commenterName: 'Alice', …(1) } to deeply equal { authorName: 'Alice', …(2) }

deleteComment > passes localizationArgs whose keys match the kanbanCommentDeleted template
AssertionError: expected { deleterName: 'Carol', …(1) } to deeply equal { authorName: 'Carol', …(2) }

createBoardChatMessage > passes localizationArgs whose keys match the kanbanBoardChat template
AssertionError: expected { authorName: 'Sender', …(1) } to deeply equal { senderName: 'Sender', …(1) }
```

- [ ] **Step 3 — Estendere la select di `createComment` e correggere gli args**

In `backend/src/services/kanban/comments-chat.service.ts`, sostituisci le righe **38-45**:

```ts
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      title: true,
      assigneeId: true,
      column: { select: { boardId: true } },
    },
  });
```

con:

```ts
  const card = await prisma.kanbanCard.findUnique({
    where: { id: cardId },
    select: {
      title: true,
      assigneeId: true,
      // board.title is needed by the notifications.kanbanCommentAdded template
      column: { select: { boardId: true, board: { select: { title: true } } } },
    },
  });
```

Poi sostituisci la riga **79**:

```ts
      localizationArgs: { commenterName, cardTitle: card.title },
```

con:

```ts
      // Key names MUST match the {{placeholders}} in notifications.kanbanCommentAdded
      // (backend/src/utils/notificationI18n.ts + locales): authorName, cardTitle, boardTitle.
      localizationArgs: {
        authorName: commenterName,
        cardTitle: card.title,
        boardTitle: card.column.board.title,
      },
```

- [ ] **Step 4 — Estendere la select di `deleteComment` e correggere gli args**

Sostituisci le righe **97-105**:

```ts
  const comment = await prisma.kanbanComment.findUnique({
    where: { id: commentId },
    select: {
      authorId: true,
      content: true,
      card: { select: { id: true, title: true, column: { select: { boardId: true } } } },
      author: { select: { name: true, email: true } },
    },
  });
```

con:

```ts
  const comment = await prisma.kanbanComment.findUnique({
    where: { id: commentId },
    select: {
      authorId: true,
      content: true,
      // board.title is needed by the notifications.kanbanCommentDeleted template
      card: {
        select: {
          id: true,
          title: true,
          column: { select: { boardId: true, board: { select: { title: true } } } },
        },
      },
      author: { select: { name: true, email: true } },
    },
  });
```

Poi sostituisci la riga **135**:

```ts
      localizationArgs: { deleterName, cardTitle: comment.card.title },
```

con:

```ts
      // Key names MUST match the {{placeholders}} in notifications.kanbanCommentDeleted:
      // authorName, cardTitle, boardTitle.
      localizationArgs: {
        authorName: deleterName,
        cardTitle: comment.card.title,
        boardTitle: comment.card.column.board.title,
      },
```

- [ ] **Step 5 — Correggere gli args della chat di board**

Sostituisci la riga **235**:

```ts
          localizationArgs: { authorName, boardTitle: board.title },
```

con:

```ts
          // notifications.kanbanBoardChat interpolates {{senderName}}, not {{authorName}}.
          localizationArgs: { senderName: authorName, boardTitle: board.title },
```

- [ ] **Step 6 — Aggiornare i sei mock esistenti che ora devono includere `board.title`**

Da questo momento il servizio legge `card.column.board.title` e `comment.card.column.board.title`: i mock che non lo espongono fanno esplodere i test con `TypeError: Cannot read properties of undefined (reading 'title')`. Sempre in `backend/src/services/kanban/__tests__/comments-chat.service.test.ts`, applica queste sei sostituzioni **cercando le stringhe letterali** (i numeri di riga qui sotto sono quelli del file *prima* delle aggiunte dello Step 1; dopo lo Step 1 sono tutti slittati):

| Riga originale | Da | A |
|---|---|---|
| 146 | `        column: { boardId: board.id },` | `        column: { boardId: board.id, board: { title: 'Test Board' } },` |
| 180 | `        column: { boardId },` | `        column: { boardId, board: { title: 'Test Board' } },` |
| 204 | `        column: { boardId },` | `        column: { boardId, board: { title: 'Test Board' } },` |
| 244 | `        card: { id: cardId, title: 'Card Title', column: { boardId } },` | `        card: { id: cardId, title: 'Card Title', column: { boardId, board: { title: 'Test Board' } } },` |
| 275 | `        card: { id: 'card-1', title: 'Card', column: { boardId: 'board-1' } },` | `        card: { id: 'card-1', title: 'Card', column: { boardId: 'board-1', board: { title: 'Test Board' } } },` |
| 293 | `        card: { id: cardId, title: 'My Card', column: { boardId } },` | `        card: { id: cardId, title: 'My Card', column: { boardId, board: { title: 'Test Board' } } },` |

Cinque delle sei stringhe sono uniche nel file. `        column: { boardId },` compare **due volte** (righe originali 180 e 204): vanno sostituite **entrambe** con lo stesso testo.

- [ ] **Step 7 — Eseguire i test e vederli passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` / `Tests  24 passed (24)` (21 preesistenti + 3 nuovi).

- [ ] **Step 8 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: PASS — nessun output, exit code 0.

Se una delle due select degli Step 3/4 non è stata estesa, l'errore è testualmente:
`src/services/kanban/comments-chat.service.ts(85,33): error TS2551: Property 'board' does not exist on type '{ boardId: string; }'. Did you mean 'boardId'?`
Attenzione: `backend/tsconfig.json` esclude `src/**/__tests__/**`, quindi Vitest può passare mentre `tsc` fallisce. **Questo step non è opzionale.**

- [ ] **Step 9 — Suite backend completa (regressione su Prisma select)**

Run: `cd backend && npx vitest run`
Atteso: PASS — `Test Files  63 passed (63)` / `Tests  1092 passed (1092)` (baseline 62 file / 1089 test, più i 3 test di `notificationI18n.test.ts` creato nel Task 0.2; il conteggio dei file cresce solo se il Task 0.2 è già stato committato — se lo esegui prima del Task 0.2, attendi `62 passed (62)` / `1089 passed`).

- [ ] **Step 10 — Commit**

```bash
git add backend/src/services/kanban/comments-chat.service.ts backend/src/services/kanban/__tests__/comments-chat.service.test.ts
git commit -m "fix(kanban): align comment and board-chat notification args with their i18n templates"
```

---

### Task 0.4: Far riconnettere l'SSE su risposta non-OK e su fine stream pulita

**Perché:** Se il primo `fetch` dello stream SSE risponde 401/403/502 (token scaduto, backend che riparte, restart IIS), oppure se il server chiude lo stream in modo pulito, `connect()` esce con un `return` nudo e il realtime della board resta morto **per tutta la sessione**: niente presence, niente card che si muovono, niente chat — finché l'utente non ricarica la pagina.
**Severità:** critical · **Effort:** M · **Rischio:** none — hook isolato, nessun file TIER 1/2.

> **Prerequisito duro per lo Stage 5, task 5.3** (rimozione del poll a 3s della chat di board). Oggi `frontend/src/features/kanban/hooks/useKanbanChat.ts:12` fa `refetchInterval: 3000`: quando lo stream SSE muore, quel poll è **l'unico** canale di aggiornamento rimasto. Rimuoverlo prima che questo task sia in produzione lascerebbe la chat completamente ferma dopo ogni disconnessione.

**File:**
- Modifica: `frontend/src/features/kanban/hooks/useKanbanRealtime.ts:73-130`
- Crea: `frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx` (la cartella `frontend/src/features/kanban/hooks/__tests__/` **non esiste**, va creata)

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna (la firma `useKanbanRealtime(boardId: string | undefined): { presenceUsers: BoardPresenceUser[]; highlightedCardIds: Set<string> }` resta invariata)

**Contesto verificato prima di iniziare (non riverificare):**
- L'hook usa **`fetch` + `ReadableStream`**, non `EventSource` (serve l'header `Authorization: Bearer`). Endpoint: `/api/kanban/boards/${boardId}/events` (riga 86).
- Il file contiene **due** `useEffect`: il primo (righe 21-27) pulisce i timer di highlight; il secondo (righe **73-130**) è quello dello stream SSE ed è l'unico da toccare.
- Backoff esistente: **nessuno**. C'è un solo `reconnectTimeout = setTimeout(connect, 5000);` fisso, alla riga **118**, raggiungibile **solo dal `catch`**. Viene sostituito da un backoff esponenziale con **tetto a 30 s** (2s → 4s → 8s → 16s → 30s → 30s …), numero di tentativi non limitato: finché la board è aperta si continua a riprovare, e l'`abort` del cleanup ferma tutto.
- I due path che oggi non ritentano: riga **91** `if (!response.ok || !response.body) return;` e l'uscita dal `while (true)` per `done === true` (riga **99** `if (done) break;`), che cade fuori dal `try` senza fare nulla.
- L'unica uscita che **deve** restare senza retry è l'`AbortError` (riga **117**): è lo smontaggio del componente o il cambio di board, dove il cleanup (righe 124-129) chiama `abortController.abort()`.
- L'hook chiama `useQueryClient()` (riga 14), `useAuthStore.getState()` (righe 32, 76) e importa `db` da `../../../lib/db` (riga 5). Nel test tutti e tre vengono mockati con `vi.hoisted()` + `vi.mock()`: **non serve un `QueryClientProvider`**, perché `@tanstack/react-query` viene sostituito interamente da uno stub che espone solo `useQueryClient`. Il repo non ha `fake-indexeddb` installato, quindi Dexie va mockato, non istanziato.
- `queryKeys.kanban.board(id)` (`frontend/src/lib/queryKeys.ts:19`) ritorna `['kanban-board', id]`: è la chiave asserita dal test harness.

- [ ] **Step 1 — Scrivere il test (fallisce: nessun retry viene schedulato)**

Crea la cartella `frontend/src/features/kanban/hooks/__tests__/` e dentro il file `useKanbanRealtime.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockDb, mockAuthStore, mockQueryClient } = vi.hoisted(() => {
  const createTable = () => ({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(1),
    where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: vi.fn().mockResolvedValue(0) })) })),
  });
  return {
    mockDb: { kanbanCards: createTable(), kanbanColumns: createTable() },
    mockAuthStore: { getState: vi.fn(() => ({ token: 'test-token', user: { id: 'user-1' } })) },
    mockQueryClient: { invalidateQueries: vi.fn() },
  };
});

vi.mock('../../../../lib/db', () => ({ db: mockDb }));
vi.mock('../../../../store/authStore', () => ({ useAuthStore: mockAuthStore }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));

import { useKanbanRealtime } from '../useKanbanRealtime';

function sseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of payloads) controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthStore.getState.mockReturnValue({ token: 'test-token', user: { id: 'user-1' } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useKanbanRealtime harness', () => {
  it('invalidates the board query on a remote event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream([{ type: 'card:deleted', boardId: 'board-1', cardId: 'card-9', actorId: 'user-2' }]),
    }));

    renderHook(() => useKanbanRealtime('board-1'));

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['kanban-board', 'board-1'] });
    });
  });
});

describe('useKanbanRealtime reconnect', () => {
  it('schedules a reconnect when the SSE response is not ok', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, body: null });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-nok'));

    // Flush the pending fetch promise
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First backoff step is 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('schedules a reconnect when the stream ends cleanly', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }) } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-eof'));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('does NOT reconnect after unmount', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, body: null });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => useKanbanRealtime('board-unmount'));

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`
Atteso: FAIL — `Test Files  1 failed (1)` / `Tests  2 failed | 2 passed (4)`. I due falliti sono:
```
useKanbanRealtime reconnect > schedules a reconnect when the SSE response is not ok
AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times

useKanbanRealtime reconnect > schedules a reconnect when the stream ends cleanly
AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times
```
`useKanbanRealtime harness > invalidates the board query on a remote event` e `does NOT reconnect after unmount` passano già oggi: il primo prova che il mocking regge, il secondo impedisce che il fix reintroduca retry dopo lo smontaggio.

- [ ] **Step 3 — Ristrutturare l'effect dell'hook**

In `frontend/src/features/kanban/hooks/useKanbanRealtime.ts`, sostituisci **l'intero blocco righe 73-130** — dal secondo `  useEffect(() => {` (riga 73) fino a `  }, [boardId, handleEvent]);` (riga 130) inclusa — con:

```ts
  useEffect(() => {
    if (!boardId) return;

    const token = useAuthStore.getState().token;
    if (!token) return;

    const abortController = new AbortController();
    abortRef.current = abortController;

    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // [BACKUP] 2026-08-31 — the old code only retried from the catch block, with a
    // flat setTimeout(connect, 5000). A non-OK response (401/403/502) and a clean
    // stream end both returned bare, killing realtime for the whole session:
    //
    //   if (!response.ok || !response.body) return;
    //   ...
    //   } catch (err: unknown) {
    //     if (err instanceof Error && err.name === 'AbortError') return;
    //     reconnectTimeout = setTimeout(connect, 5000);
    //   }
    //
    // Now every exit path schedules a reconnect except a deliberate abort.
    // Bounded exponential backoff: 2s, 4s, 8s, 16s, capped at 30s, retried for as
    // long as the board stays mounted. The cleanup's abort() stops it for good.
    function scheduleReconnect(): void {
      if (abortController.signal.aborted) return;
      const delay = Math.min(30_000, 2000 * 2 ** attempt);
      attempt += 1;
      reconnectTimeout = setTimeout(connect, delay);
    }

    async function connect(): Promise<void> {
      try {
        const response = await fetch(`/api/kanban/boards/${boardId}/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          scheduleReconnect();
          return;
        }

        // Connected: reset the backoff so the next drop retries quickly.
        attempt = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const event: KanbanSSEEvent = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch {
              // Ignore malformed SSE data
            }
          }
        }

        // Clean EOF: the server closed the stream. Reconnect.
        scheduleReconnect();
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        scheduleReconnect();
      }
    }

    connect();

    return () => {
      abortController.abort();
      abortRef.current = null;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      setPresenceUsers([]);
    };
  }, [boardId, handleEvent]);
```

`scheduleReconnect` e `connect` devono restare **dichiarazioni di funzione** (`function foo()`), non `const foo = () => {}`: si riferiscono a vicenda e solo l'hoisting delle function declaration lo permette. Attenzione anche a `buffer.split('\n')`: è un newline reale, non due caratteri.

- [ ] **Step 4 — Eseguire il test e vederlo passare**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`
Atteso: PASS — `Test Files  1 passed (1)` / `Tests  4 passed (4)`.

- [ ] **Step 5 — Typecheck e lint**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Atteso: PASS — nessun output, exit code 0. Se compare `Block-scoped variable 'connect' used before its declaration`, `scheduleReconnect` o `connect` sono state scritte come `const`: riportale a `function`.

Run: `cd frontend && npx eslint src/features/kanban/hooks/useKanbanRealtime.ts`
Atteso: PASS — nessun output (nessun problema su questo file).

- [ ] **Step 6 — Verifica manuale della riconnessione**

1. `cd backend && npm run dev`, `cd frontend && npm run dev`, apri una board kanban in due schede.
2. Ferma il backend (Ctrl+C). Nella scheda A, DevTools → Network: la richiesta a `boards/<id>/events` fallisce.
3. Atteso: dopo ~2s parte una nuova richiesta a `events`, poi ~4s, ~8s, ~16s, poi ogni 30s. Nessuna raffica di richieste.
4. Riavvia il backend. Atteso: entro 30s la richiesta a `events` riesce (status 200, stato `pending`), e muovendo una card nella scheda B la scheda A si aggiorna.
5. Naviga via dalla board (torna alla lista board). Atteso: nessuna nuova richiesta a `events` in Network.

- [ ] **Step 7 — E2E kanban (non è in CI, va lanciato a mano)**

`frontend/playwright.config.ts` ha `webServer: { command: 'npm run dev', url: 'http://localhost:5173' }`: avvia **solo Vite**. Il backend su `:3001` va acceso a parte, altrimenti ogni chiamata `/api` fallisce.

Run: `cd backend && npm run dev` (in un terminale), poi `cd frontend && npx playwright test e2e/kanban.spec.ts`
Atteso: PASS — tutti gli spec del file verdi. Questo spec esercita drag&drop e aggiornamenti di board, i percorsi che dipendono dallo stream SSE.

- [ ] **Step 8 — Suite frontend completa (regressione)**

Run: `cd frontend && npx vitest run`
Atteso: PASS — `Test Files  11 passed (11)` / `Tests  141 passed (141)` (9 file / 131 test di baseline, + 6 test del Task 0.1, + 4 test di questo task).

- [ ] **Step 9 — Commit**

```bash
git add frontend/src/features/kanban/hooks/useKanbanRealtime.ts frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx
git commit -m "fix(kanban): reconnect the SSE stream on non-ok response and clean EOF"
```

---

## Stage 1 — Buchi di permessi (backend-only, paralleli)

Questo stage chiude dieci falle di autorizzazione sul dominio kanban. Sono tutte **backend-only** e ognuna è un **commit indipendente**: nessuna tocca il frontend, nessuna richiede migration Prisma, nessuna tocca file TIER 1. L'unica dipendenza di interfaccia è che i Task 1.3, 1.4 consumano la funzione creata dal Task 1.1 (`assertBelongsToBoard`) — se lavori in parallelo, fai atterrare 1.1 per primo. Prima di iniziare: `cd backend && npx vitest run` deve essere verde, e `backend/.env` deve esistere (Prisma lo richiede via `prisma.config.js`).

Baseline verificata su `main` (commit `141e6af`), eseguendo `cd backend && npx vitest run`: **`Test Files  61 passed (61)`**, **`Tests  1083 passed (1083)`**. Vitest è alla v4.0.18. Per file toccati da questo stage:

| File | Test attuali | Test a fine stage |
|---|---|---|
| `src/services/__tests__/kanbanPermissions.test.ts` | 16 | 26 |
| `src/services/kanban/__tests__/column.service.test.ts` | 9 | 11 |
| `src/services/kanban/__tests__/card.service.test.ts` | 29 | 34 |
| `src/services/kanban/__tests__/comments-chat.service.test.ts` | 21 | 23 |
| `src/services/kanban/__tests__/linking.service.test.ts` | 39 | 46 |
| `src/services/__tests__/sharing.service.test.ts` | 45 | 49 |

Totale a fine stage: **1113 test in 61 file** (+30).

---

### Task 1.1: Aggiungere `assertBelongsToBoard` a kanbanPermissions

**Perché:** Oggi tre punti del backend accettano liste di id (colonne, card, utenti) e li scrivono senza mai verificare che appartengano alla board su cui l'utente ha i permessi. Manca la primitiva condivisa per farlo; senza di essa ogni fix duplicherebbe la stessa query.
**Severità:** high · **Effort:** M · **Rischio:** none — solo aggiunte in coda al file, nessuna funzione esistente viene toccata.

**File:**
- Modifica: `backend/src/services/kanbanPermissions.ts:3-7` (import esistenti già a posto) e append in coda al file (dopo la riga 53, ultima riga del file)
- Modifica: `backend/src/services/__tests__/kanbanPermissions.test.ts:3-7` (import) e append in coda (dopo la riga 246, ultima riga del file)

**Interfacce:**
- Consuma: nessuna
- Produce: `assertBelongsToBoard(boardId: string, ids: { columnIds?: string[]; cardIds?: string[]; userIds?: string[] }): Promise<void>` — consumata dal Task 1.3 (`columnIds`) e dal Task 1.4 (`userIds`). Lancia `ForbiddenError('errors.common.accessDenied')` se anche un solo id non appartiene alla board; lancia `NotFoundError('errors.kanban.boardNotFound')` se la board non esiste (solo nel ramo `userIds`, che è l'unico a interrogare la board). Non lancia nulla se tutti gli array sono assenti o vuoti.

`backend/src/services/kanbanPermissions.ts` importa già a riga 1 `prisma from '../plugins/prisma'` e a riga 2 `{ NotFoundError, ForbiddenError } from '../utils/errors'`: la nuova funzione non ha bisogno di import aggiuntivi.

Decisione sulle chiavi i18n, fissata qui una volta per tutte: la funzione **riusa** `errors.common.accessDenied` e `errors.kanban.boardNotFound`. Verificate presenti in entrambi i locale file — `en.json` → `"Access denied"` / `"Board not found"`, `it.json` → `"Accesso negato"` / `"Board non trovata"`. Nessuna chiave nuova, e un id straniero non rivela mai se esiste davvero.

Il mock Prisma globale (`backend/src/__tests__/setup.ts`) definisce già `kanbanColumn.count` (riga 207) e `kanbanCard.count` (riga 217): **nessuna riga di augmentation è necessaria** in questo file di test.

- [ ] **Step 1 — Estendere l'import nel file di test**

In `backend/src/services/__tests__/kanbanPermissions.test.ts`, sostituisci le righe 3-7 con:

```ts
import {
  assertBoardAccess,
  getColumnWithAccess,
  getCardWithAccess,
  assertBelongsToBoard,
} from '../kanbanPermissions';
```

- [ ] **Step 2 — Scrivere i test che falliscono**

Appendi in coda a `backend/src/services/__tests__/kanbanPermissions.test.ts` (dopo la riga 246, che è la chiusura `});` dell'ultimo `describe`):

```ts

// ===========================================================================
// assertBelongsToBoard
// ===========================================================================

describe('assertBelongsToBoard', () => {
  const otherBoard = makeKanbanBoard({ ownerId: stranger.id });

  it('resolves without querying anything when no ids are given', async () => {
    await expect(assertBelongsToBoard(board.id, {})).resolves.toBeUndefined();

    expect(prismaMock.kanbanColumn.count).not.toHaveBeenCalled();
    expect(prismaMock.kanbanCard.count).not.toHaveBeenCalled();
    expect(prismaMock.kanbanBoard.findUnique).not.toHaveBeenCalled();
  });

  it('resolves when every column belongs to the board', async () => {
    const colA = makeKanbanColumn({ boardId: board.id });
    const colB = makeKanbanColumn({ boardId: board.id });
    prismaMock.kanbanColumn.count.mockResolvedValue(2);

    await expect(
      assertBelongsToBoard(board.id, { columnIds: [colA.id, colB.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanColumn.count).toHaveBeenCalledWith({
      where: { boardId: board.id, id: { in: [colA.id, colB.id] } },
    });
  });

  it('throws ForbiddenError when a column belongs to another board', async () => {
    const mine = makeKanbanColumn({ boardId: board.id });
    const foreign = makeKanbanColumn({ boardId: otherBoard.id });
    prismaMock.kanbanColumn.count.mockResolvedValue(1);

    await expect(
      assertBelongsToBoard(board.id, { columnIds: [mine.id, foreign.id] })
    ).rejects.toThrow(ForbiddenError);
  });

  it('de-duplicates column ids before comparing the count', async () => {
    const colA = makeKanbanColumn({ boardId: board.id });
    prismaMock.kanbanColumn.count.mockResolvedValue(1);

    await expect(
      assertBelongsToBoard(board.id, { columnIds: [colA.id, colA.id, colA.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanColumn.count).toHaveBeenCalledWith({
      where: { boardId: board.id, id: { in: [colA.id] } },
    });
  });

  it('resolves when every card belongs to the board', async () => {
    const cardA = makeKanbanCard({ columnId: column.id });
    prismaMock.kanbanCard.count.mockResolvedValue(1);

    await expect(
      assertBelongsToBoard(board.id, { cardIds: [cardA.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanCard.count).toHaveBeenCalledWith({
      where: { column: { boardId: board.id }, id: { in: [cardA.id] } },
    });
  });

  it('throws ForbiddenError when a card belongs to another board', async () => {
    const foreign = makeKanbanCard();
    prismaMock.kanbanCard.count.mockResolvedValue(0);

    await expect(
      assertBelongsToBoard(board.id, { cardIds: [foreign.id] })
    ).rejects.toThrow(ForbiddenError);
  });

  it('resolves when the user is the board owner', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [],
    });

    await expect(
      assertBelongsToBoard(board.id, { userIds: [owner.id] })
    ).resolves.toBeUndefined();
  });

  it('resolves when the user has an ACCEPTED share', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [{ userId: writer.id }],
    });

    await expect(
      assertBelongsToBoard(board.id, { userIds: [writer.id] })
    ).resolves.toBeUndefined();

    expect(prismaMock.kanbanBoard.findUnique).toHaveBeenCalledWith({
      where: { id: board.id },
      select: {
        ownerId: true,
        shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
      },
    });
  });

  it('throws ForbiddenError for a user who is not a board participant', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [{ userId: writer.id }],
    });

    await expect(
      assertBelongsToBoard(board.id, { userIds: [stranger.id] })
    ).rejects.toThrow(ForbiddenError);
  });

  it('throws NotFoundError when the board does not exist', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(null);

    await expect(
      assertBelongsToBoard('nonexistent-board', { userIds: [owner.id] })
    ).rejects.toThrow(NotFoundError);
  });
});
```

Tutti gli identificatori usati esistono già nel file: `prismaMock` (riga 17), `owner`/`writer`/`stranger` (righe 23-26), `board`/`column` (righe 28-29), `makeKanbanBoard`/`makeKanbanColumn`/`makeKanbanCard` (import righe 10-12), `NotFoundError`/`ForbiddenError` (import riga 15).

- [ ] **Step 3 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanPermissions.test.ts`
Atteso: FAIL. La riga di riepilogo è `Tests  10 failed | 16 passed (26)` e ognuno dei 10 nuovi test riporta `TypeError: assertBelongsToBoard is not a function`.

- [ ] **Step 4 — Implementare**

Appendi in coda a `backend/src/services/kanbanPermissions.ts` (dopo la riga 53, che è la `}` di chiusura di `getCardWithAccess`):

```ts

/** Empty/undefined → [], and duplicates collapsed so `count === length` stays a valid check. */
const uniq = (ids?: string[]): string[] => (ids && ids.length > 0 ? [...new Set(ids)] : []);

/**
 * Assert that every given id actually belongs to `boardId`.
 * Call this AFTER assertBoardAccess/getColumnWithAccess: it answers
 * "is this id part of the board I already proved access to?", not "can I write here?".
 */
export async function assertBelongsToBoard(
  boardId: string,
  ids: { columnIds?: string[]; cardIds?: string[]; userIds?: string[] }
): Promise<void> {
  const columnIds = uniq(ids.columnIds);
  const cardIds = uniq(ids.cardIds);
  const userIds = uniq(ids.userIds);

  if (columnIds.length > 0) {
    const found = await prisma.kanbanColumn.count({
      where: { boardId, id: { in: columnIds } },
    });
    if (found !== columnIds.length) throw new ForbiddenError('errors.common.accessDenied');
  }

  if (cardIds.length > 0) {
    const found = await prisma.kanbanCard.count({
      where: { column: { boardId }, id: { in: cardIds } },
    });
    if (found !== cardIds.length) throw new ForbiddenError('errors.common.accessDenied');
  }

  if (userIds.length > 0) {
    const board = await prisma.kanbanBoard.findUnique({
      where: { id: boardId },
      select: {
        ownerId: true,
        shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
      },
    });
    if (!board) throw new NotFoundError('errors.kanban.boardNotFound');

    const participants = new Set<string>([board.ownerId, ...board.shares.map((s) => s.userId)]);
    for (const userId of userIds) {
      if (!participants.has(userId)) throw new ForbiddenError('errors.common.accessDenied');
    }
  }
}
```

- [ ] **Step 5 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanPermissions.test.ts`
Atteso: PASS. `Test Files  1 passed (1)` e `Tests  26 passed (26)`.

- [ ] **Step 6 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 7 — Commit**

```bash
git add backend/src/services/kanbanPermissions.ts backend/src/services/__tests__/kanbanPermissions.test.ts
git commit -m "feat(kanban): add assertBelongsToBoard ownership primitive"
```

---

### Task 1.2: Bloccare lo spostamento di card fra board diverse

**Perché:** Chiunque abbia accesso in scrittura a una qualsiasi board può spostare una propria card dentro una colonna di una board altrui, semplicemente passando un `toColumnId` che non appartiene alla sua board. La card compare nella board della vittima, e i partecipanti di quella board ricevono la notifica "X ha spostato ...".
**Severità:** critical · **Effort:** S · **Rischio:** none — un solo `if` prima della transazione, nessun percorso legittimo cambia comportamento.

**File:**
- Modifica: `backend/src/services/kanban/card.service.ts:199-201`
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts` (append dentro `describe('moveCard')`, che inizia a riga 423 e si chiude a riga 599)

**Interfacce:**
- Consuma: nessuna (non usa `assertBelongsToBoard`: qui i due `boardId` sono già entrambi in memoria, un confronto in RAM è più corto e non aggiunge query)
- Produce: nessuna

La guardia va nel **service**, non nella route. La route `PUT /kanban/cards/:id/move` (`backend/src/routes/kanban.ts:463-470`) è oggi l'unico chiamante backend di `moveCard` (verificato con `grep -rn "moveCard" backend/src --include=*.ts`; `bulkMoveNotify` a `card.service.ts:506` invia solo notifiche e **non** chiama `moveCard`), ma tre percorsi frontend distinti la colpiscono: il drag & drop (`frontend/src/features/kanban/hooks/useBoardDnD.ts:243`), il bulk move da marquee (`frontend/src/features/kanban/KanbanBoardPage.tsx:361`) e la coda di sync offline (`frontend/src/features/sync/syncService.ts:692`). Una guardia sola nel service li copre tutti.

Classe d'errore e chiave i18n: identiche al throw a riga 199, `NotFoundError('errors.kanban.columnNotFound')`. La chiave esiste già in entrambi i locale file — `en.json` → `"Column not found"`, `it.json` → `"Colonna non trovata"` (verificato). Riusarla è anche la scelta più sicura: non conferma all'attaccante che la colonna straniera esista.

- [ ] **Step 1 — Scrivere il test che fallisce**

Appendi dentro il blocco `describe('moveCard', ...)` di `backend/src/services/kanban/__tests__/card.service.test.ts`, subito prima della sua parentesi di chiusura (riga 599, `});`):

```ts

  it('throws NotFoundError and writes nothing when the target column is on another board', async () => {
    const foreignBoard = makeKanbanBoard();
    const foreignColumn = makeKanbanColumn({ boardId: foreignBoard.id, title: 'Victim Column' });

    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: sourceColumn.title, isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: foreignBoard.id,
      title: foreignColumn.title,
      position: 0,
      isCompleted: false,
    });

    await expect(moveCard(card.id, foreignColumn.id, 0, actor.id)).rejects.toThrow(NotFoundError);

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.kanbanCard.update).not.toHaveBeenCalled();
    expect(prismaMock.kanbanCard.updateMany).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
```

Identificatori usati, tutti già presenti: `actor`/`board`/`sourceColumn`/`card` (fixture del `describe('moveCard')`, righe 424-428), `makeKanbanBoard`/`makeKanbanColumn` (import righe 69-70), `NotFoundError` (import riga 74), `broadcast` (import riga 65), `prismaMock` (riga 78).

- [ ] **Step 2 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "throws NotFoundError and writes nothing when the target column is on another board"`
Atteso: FAIL con `AssertionError: promise resolved "undefined" instead of rejecting`. La riga di riepilogo contiene `1 failed`.

- [ ] **Step 3 — Implementare**

In `backend/src/services/kanban/card.service.ts`, sostituisci la riga 201 (`  const boardId = card.column.boardId;`) con:

```ts
  const boardId = card.column.boardId;

  // The target column must live on the same board as the card: without this the
  // caller can inject a card into any board whose column id they can guess.
  if (targetColumn.boardId !== boardId) {
    logger.warn(
      { cardId, toColumnId, boardId, targetBoardId: targetColumn.boardId },
      'Rejected cross-board card move'
    );
    throw new NotFoundError('errors.kanban.columnNotFound');
  }
```

`logger` è importato a riga 2, `NotFoundError` a riga 3: nessun import da aggiungere.

- [ ] **Step 4 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "throws NotFoundError and writes nothing when the target column is on another board"`
Atteso: PASS. La riga di riepilogo contiene `1 passed`.

- [ ] **Step 5 — Nessuna regressione**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`
Atteso: PASS, `Tests  30 passed (30)`, nessun `failed`.

- [ ] **Step 6 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 7 — Commit**

```bash
git add backend/src/services/kanban/card.service.ts backend/src/services/kanban/__tests__/card.service.test.ts
git commit -m "fix(kanban): reject cross-board card moves in moveCard"
```

---

### Task 1.3: Limitare `reorderColumns` alle colonne della board

**Perché:** `PUT /kanban/boards/:id/columns/reorder` verifica il permesso di scrittura sulla board dell'URL, poi scrive le posizioni per id nudo: mettendo nell'array l'id di una colonna di un'altra board, l'utente rimescola le colonne altrui. In più l'array non ha limite di lunghezza, quindi una singola richiesta può aprire una transazione con migliaia di update.
**Severità:** high · **Effort:** S · **Rischio:** none.

**File:**
- Modifica: `backend/src/services/kanban/column.service.ts:3` (import) e `:54-68` (corpo di `reorderColumns`)
- Modifica: `backend/src/routes/kanban.ts:37-39`
- Modifica: `backend/src/services/kanban/__tests__/column.service.test.ts:4-11` (mock + import), `:21-40` (beforeEach) e append dentro `describe('reorderColumns')` (righe 136-166)

**Interfacce:**
- Consuma: `assertBelongsToBoard(boardId: string, ids: { columnIds?: string[]; cardIds?: string[]; userIds?: string[] }): Promise<void>` dal Task 1.1
- Produce: nessuna (la firma `reorderColumns(boardId: string, items: { id: string; position: number }[])` non cambia)

Sul cap dell'array: in `backend/src/routes/kanban.ts` **non esiste** oggi alcun `.max()` su array — né `bulkArchiveExecSchema` (riga 594) né `bulkMoveNotifySchema` (righe 472-478) ne hanno uno. La disciplina di cap che il file applica è sugli scalari (`title` max 100/200/500, `description` max 2000/5000, `limit` max 100, `olderThanDays` max 365). Introduciamo qui il primo cap su array: `.max(100)`, cioè cento colonne per board, ordine di grandezza già ampiamente sopra qualunque uso reale.

Nota sull'implementazione: la guardia sostituisce lo scoping delle write, non lo affianca. Riscrivere gli `update` in `updateMany({ where: { id, boardId } })` renderebbe la scrittura non falsificabile ma **silenziosa** su id stranieri (0 righe toccate, `{ success: true }` al client). Con la guardia il client riceve un 403 esplicito, e non esiste nessuna API che sposti una colonna fra board fra il `count` e l'update — quindi non c'è finestra TOCTOU da chiudere.

- [ ] **Step 1 — Aggiungere il mock e gli import nel file di test**

In `backend/src/services/kanban/__tests__/column.service.test.ts`, subito dopo il blocco `vi.mock('../../kanbanSSE', ...)` (righe 4-6), inserisci:

```ts

vi.mock('../../kanbanPermissions', () => ({
  assertBelongsToBoard: vi.fn().mockResolvedValue(undefined),
}));
```

Poi sostituisci la riga 11 (`import { NotFoundError, BadRequestError } from '../../../utils/errors';`) con le due righe seguenti — `ForbiddenError` va unito all'import esistente, non duplicato:

```ts
import { NotFoundError, BadRequestError, ForbiddenError } from '../../../utils/errors';
import { assertBelongsToBoard } from '../../kanbanPermissions';
```

- [ ] **Step 2 — Ri-armare il mock nel beforeEach**

Il `beforeEach` esistente (righe 21-40) chiama `vi.clearAllMocks()`, che azzera i conteggi ma **non** rimuove un eventuale `mockRejectedValueOnce` residuo. Aggiungi in coda al corpo del `beforeEach`, subito dopo il blocco `prismaMock.$transaction = vi.fn(...)` e prima della `});` di riga 40:

```ts

  // clearAllMocks does not drop queued `...Once` implementations: reset explicitly
  (assertBelongsToBoard as any).mockReset();
  (assertBelongsToBoard as any).mockResolvedValue(undefined);
```

- [ ] **Step 3 — Scrivere i test che falliscono**

Appendi dentro `describe('reorderColumns', ...)`, subito prima della sua parentesi di chiusura (riga 166, `});`):

```ts

  it('asserts every column id belongs to the board before writing', async () => {
    const board = makeKanbanBoard();
    const col1 = makeKanbanColumn({ boardId: board.id, position: 0 });
    const col2 = makeKanbanColumn({ boardId: board.id, position: 1 });

    prismaMock.kanbanColumn.update.mockResolvedValue({});

    await reorderColumns(board.id, [
      { id: col1.id, position: 1 },
      { id: col2.id, position: 0 },
    ]);

    expect(assertBelongsToBoard).toHaveBeenCalledWith(board.id, {
      columnIds: [col1.id, col2.id],
    });
  });

  it('does not write anything when a column belongs to another board', async () => {
    const board = makeKanbanBoard();
    const foreign = makeKanbanColumn();

    prismaMock.kanbanColumn.update.mockResolvedValue({});
    (assertBelongsToBoard as any).mockRejectedValueOnce(
      new ForbiddenError('errors.common.accessDenied')
    );

    await expect(
      reorderColumns(board.id, [{ id: foreign.id, position: 0 }])
    ).rejects.toThrow(ForbiddenError);

    expect(prismaMock.kanbanColumn.update).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/column.service.test.ts -t "asserts every column id belongs to the board before writing"`
Atteso: FAIL con `AssertionError: expected "spy" to be called with arguments: [ …, { columnIds: [ … ] } ]` seguito da `Number of calls: 0`. Riepilogo con `1 failed`.

- [ ] **Step 5 — Implementare il service**

In `backend/src/services/kanban/column.service.ts`, sostituisci la riga 3 (`import { broadcast } from '../kanbanSSE';`) con:

```ts
import { broadcast } from '../kanbanSSE';
import { assertBelongsToBoard } from '../kanbanPermissions';
```

Poi sostituisci le righe 54-68 (l'intera funzione `reorderColumns`) con:

```ts
export async function reorderColumns(
  boardId: string,
  items: { id: string; position: number }[]
) {
  // The route only proved WRITE access to `boardId`; the ids in the body are
  // caller-controlled and must be confirmed to live on that board before writing.
  await assertBelongsToBoard(boardId, { columnIds: items.map((item) => item.id) });

  await prisma.$transaction(
    items.map((item) =>
      prisma.kanbanColumn.update({
        where: { id: item.id },
        data: { position: item.position },
      })
    )
  );

  broadcast(boardId, { type: 'columns:reordered', boardId, columns: items });
}
```

- [ ] **Step 6 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/column.service.test.ts`
Atteso: PASS, `Test Files  1 passed (1)` e `Tests  11 passed (11)`.

- [ ] **Step 7 — Limitare l'array nello schema Zod**

In `backend/src/routes/kanban.ts`, sostituisci le righe 37-39 con:

```ts
const reorderColumnsSchema = z.object({
  columns: z.array(z.object({ id: z.string(), position: z.number().int().min(0) })).min(1).max(100),
});
```

- [ ] **Step 8 — Verifica dello schema**

**Verifica:** non esiste in questo repo alcun test di route per il kanban (nessun file sotto `backend/src/routes/__tests__/`), quindi il cap Zod non è coprbile con un unit test. La verifica è un grep che prova la modifica.

Run: `cd backend && grep -n "reorderColumnsSchema" -A 2 src/routes/kanban.ts`
Atteso: tre righe stampate, `37:const reorderColumnsSchema = z.object({`, `38-  columns: z.array(...).min(1).max(100),`, `39-});` — la riga 38 contiene `.min(1).max(100)`.

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 9 — Commit**

```bash
git add backend/src/services/kanban/column.service.ts backend/src/routes/kanban.ts backend/src/services/kanban/__tests__/column.service.test.ts
git commit -m "fix(kanban): scope reorderColumns to the board and cap the array"
```

---

### Task 1.4: Validare `assigneeId` contro i partecipanti della board

**Perché:** `PUT /kanban/cards/:id` accetta qualunque `assigneeId`. Si può assegnare una card a un utente qualsiasi dell'istanza — che riceve subito la notifica in-app "X ti ha assegnato ..." e, se la card ha una scadenza, dei promemoria kanban su una board che non ha mai visto. È un canale di spam autenticato verso qualsiasi utente.
**Severità:** high · **Effort:** S · **Rischio:** none — un solo `if` prima della `update`.

**File:**
- Modifica: `backend/src/services/kanban/card.service.ts:6` (import) e `:65`
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts:32-35` (mock), `:66` (import), `:74` (import), `:87-92` (beforeEach) e append dentro `describe('updateCard')` (che inizia a riga 259 e si chiude a riga 417)

**Interfacce:**
- Consuma: `assertBelongsToBoard(boardId: string, ids: { columnIds?: string[]; cardIds?: string[]; userIds?: string[] }): Promise<void>` dal Task 1.1
- Produce: nessuna

Sul riuso: `backend/src/services/kanban/notifications.ts` calcola due volte l'insieme dei partecipanti (righe 37-49 in `notifyBoardUsers`, righe 76-89 in `notifyBoardUsersTiered`) ma **non esporta** nessun helper per farlo — sono due blocchi inline. Per questo il Task 1.1 mette quella logica in `assertBelongsToBoard`, ed è quella che consumiamo qui. Non rifattorizzare i due blocchi inline di `notifications.ts`: sono in un percorso di notifica non critico e cambiarli allargherebbe il commit senza chiudere nessuna falla.

- [ ] **Step 1 — Aggiungere il mock e gli import nel file di test**

In `backend/src/services/kanban/__tests__/card.service.test.ts`, subito dopo il blocco `vi.mock('../notifications', ...)` (righe 32-35), inserisci:

```ts

vi.mock('../../kanbanPermissions', () => ({
  assertBelongsToBoard: vi.fn().mockResolvedValue(undefined),
}));
```

Poi, subito dopo la riga 66 (`import { notifyBoardUsers, notifyBoardUsersTiered } from '../notifications';`), inserisci:

```ts
import { assertBelongsToBoard } from '../../kanbanPermissions';
```

E sostituisci la riga 74 con:

```ts
import { NotFoundError, BadRequestError, ForbiddenError } from '../../../utils/errors';
```

- [ ] **Step 2 — Ri-armare il mock nel beforeEach**

Il `beforeEach` globale del file (righe 87-92) chiama `vi.clearAllMocks()`, che non rimuove i `...Once` in coda. Aggiungi dentro quel `beforeEach`, subito dopo `prismaMock.kanbanCard.aggregate = vi.fn();` e prima della `});` di riga 92:

```ts

  // clearAllMocks does not drop queued `...Once` implementations: reset explicitly
  (assertBelongsToBoard as any).mockReset();
  (assertBelongsToBoard as any).mockResolvedValue(undefined);
```

- [ ] **Step 3 — Scrivere i test che falliscono**

Appendi dentro `describe('updateCard', ...)`, subito prima della sua parentesi di chiusura (riga 417, `});`):

```ts

  it('checks the new assignee is a board participant before writing', async () => {
    const assignee = makeUser();
    const rawCard = makeRawCardResult({ assigneeId: assignee.id });
    prismaMock.kanbanCard.update.mockResolvedValue(rawCard);
    prismaMock.user.findUnique.mockResolvedValue({ name: assignee.name, email: assignee.email });
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ title: board.title });

    await updateCard('card-u1', { assigneeId: assignee.id }, actor.id);

    expect(assertBelongsToBoard).toHaveBeenCalledWith(board.id, { userIds: [assignee.id] });
  });

  it('does not write when the assignee is not a board participant', async () => {
    const outsider = makeUser();
    prismaMock.kanbanCard.update.mockResolvedValue(makeRawCardResult());
    (assertBelongsToBoard as any).mockRejectedValueOnce(
      new ForbiddenError('errors.common.accessDenied')
    );

    await expect(
      updateCard('card-u1', { assigneeId: outsider.id }, actor.id)
    ).rejects.toThrow(ForbiddenError);

    expect(prismaMock.kanbanCard.update).not.toHaveBeenCalled();
    expect(notifyBoardUsers).not.toHaveBeenCalled();
  });

  it('does not check membership when clearing the assignee', async () => {
    const previousAssignee = makeUser();
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      ...currentCard,
      assigneeId: previousAssignee.id,
    });
    prismaMock.kanbanCard.update.mockResolvedValue(makeRawCardResult({ assigneeId: null }));

    await updateCard('card-u1', { assigneeId: null }, actor.id);

    expect(assertBelongsToBoard).not.toHaveBeenCalled();
  });
```

Identificatori usati, tutti già presenti nel `describe('updateCard')`: `actor` (riga 260), `board` (riga 261), `currentCard` (righe 264-269), `makeRawCardResult` (riga 271), `makeUser` (import riga 68), `notifyBoardUsers` (import riga 66).

- [ ] **Step 4 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "does not write when the assignee is not a board participant"`
Atteso: FAIL con `AssertionError: promise resolved "{ id: 'card-u1', … }" instead of rejecting`. Riepilogo con `1 failed`.

- [ ] **Step 5 — Implementare**

In `backend/src/services/kanban/card.service.ts`, sostituisci la riga 6 (`import { notifyBoardUsers, notifyBoardUsersTiered } from './notifications';`) con:

```ts
import { notifyBoardUsers, notifyBoardUsersTiered } from './notifications';
import { assertBelongsToBoard } from '../kanbanPermissions';
```

Poi sostituisci la riga 65 (`  if (!currentCard) throw new NotFoundError('errors.kanban.cardNotFound');`) con:

```ts
  if (!currentCard) throw new NotFoundError('errors.kanban.cardNotFound');

  // A card may only be assigned to someone who is already on the board: otherwise
  // any writer can push notifications and reminders onto arbitrary users.
  // Truthy check on purpose — `null` means "unassign" and needs no membership.
  if (data.assigneeId) {
    await assertBelongsToBoard(currentCard.column.boardId, { userIds: [data.assigneeId] });
  }
```

Il `select` di `currentCard` (riga 63) include già `column: { select: { boardId: true } }`, quindi `currentCard.column.boardId` è tipato e disponibile.

- [ ] **Step 6 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`
Atteso: PASS, nessun `failed`. Il totale è `Tests  33 passed (33)` se il Task 1.2 è già stato committato, `Tests  32 passed (32)` altrimenti.

- [ ] **Step 7 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 8 — Commit**

```bash
git add backend/src/services/kanban/card.service.ts backend/src/services/kanban/__tests__/card.service.test.ts
git commit -m "fix(kanban): validate card assignee is a board participant"
```

---

### Task 1.5: Rimuovere `noteId` dal percorso di update della card

**Perché:** `PUT /kanban/cards/:id` accetta `noteId` e lo scrive direttamente sulla card, scavalcando l'intero flusso autorizzato di link-note — quello che verifica che chi collega sia il proprietario della nota (`linking.service.ts:89`), che registra l'attività `NOTE_LINKED` e che gestisce la condivisione. Risultato: si può attaccare l'id di una nota qualsiasi a una card, e chi vede la card vede il riferimento alla nota.
**Severità:** high · **Effort:** S · **Rischio:** none — nessun chiamante usa questo campo (dimostrato allo Step 1).

**File:**
- Modifica: `backend/src/routes/kanban.ts:47-54`
- Modifica: `backend/src/services/kanban/card.service.ts:48-59` e `:71`
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts` (append dentro `describe('updateCard')`, che si chiude a riga 417)

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

La route autorizzata che sostituisce questo campo è `POST /kanban/cards/:id/link-note` (`backend/src/routes/kanban.ts:542-547`) → `linkNoteToCard` in `backend/src/services/kanban/linking.service.ts:69`, e per lo scollegamento `DELETE /kanban/cards/:id/link-note` (`routes/kanban.ts:550-554`) → `unlinkNoteFromCard` (`linking.service.ts:132`).

- [ ] **Step 1 — Provare che nessun chiamante manda `noteId` sul percorso di update**

Run: `cd frontend && grep -n "noteId" src/features/kanban/kanbanService.ts`
Atteso: esattamente 13 righe — `317`, `449` (entrambe `noteId: null` in oggetti card locali Dexie), `555`, `557` (`checkNoteSharing`), `564`, `568` (`linkNoteToCard`), `595`, `596` (`getLinkedBoardsForNote`), `602`, `604` (`checkBoardNoteSharing`), `611`, `613`, `614` (`linkNoteToBoard`). **Nessuna** dentro `updateCard`, che inizia a riga 348 e il cui parametro `data` dichiara solo `title`, `description`, `assigneeId`, `dueDate`, `priority`.

Run: `cd frontend && sed -n '88,100p' src/features/kanban/hooks/useKanbanMutations.ts`
Atteso: il tipo della mutation `updateCard` elenca `cardId`, `title`, `description`, `assigneeId`, `dueDate`, `priority` — nessun `noteId`.

Run: `cd frontend && grep -n "kanban/cards" src/features/sync/syncService.ts`
Atteso: tre righe — `692` (`/move`), `697` (`api.put(\`/kanban/cards/${item.entityId}\`, item.data)`) e `700` (`api.delete`). A riga 697 `item.data` è esattamente il `data` accodato da `kanbanService.updateCard`, quindi senza `noteId`.

Conclusione: nessuna migrazione frontend necessaria. Se uno di questi grep restituisse un `noteId` dentro il payload di update, fermati e migra prima quel chiamante alla route `link-note`.

- [ ] **Step 2 — Scrivere il test che fallisce**

Appendi dentro `describe('updateCard', ...)` in `backend/src/services/kanban/__tests__/card.service.test.ts`, subito prima della sua parentesi di chiusura:

```ts

  it('ignores a noteId smuggled into the update payload', async () => {
    prismaMock.kanbanCard.update.mockResolvedValue(makeRawCardResult());

    // `as any` on purpose: the field is gone from the type, this proves the
    // runtime drops it too (the Zod schema strips it, this is the second line).
    await updateCard('card-u1', { noteId: 'someone-elses-note' } as any, actor.id);

    expect(prismaMock.kanbanCard.update).toHaveBeenCalledWith({
      where: { id: 'card-u1' },
      data: {},
      select: expect.any(Object),
    });
  });
```

- [ ] **Step 3 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "ignores a noteId smuggled into the update payload"`
Atteso: FAIL con `AssertionError: expected "spy" to be called with arguments: [ { where: …, data: {}, select: Any<Object> } ]` e, nella differenza mostrata, `data: { noteId: 'someone-elses-note' }`. Riepilogo con `1 failed`.

- [ ] **Step 4 — Implementare**

In `backend/src/services/kanban/card.service.ts`, elimina la riga 56 (`    noteId?: string | null;`) dal tipo del parametro `data`, così che le righe 48-59 diventino:

```ts
export async function updateCard(
  cardId: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueDate?: string | null;
    priority?: string | null;
  },
  actorId: string
) {
```

Poi elimina la riga 71 (`  if (data.noteId !== undefined) updateData.noteId = data.noteId;`), così che il blocco `updateData` diventi:

```ts
  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.dueDate !== undefined) {
    updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  }
```

In `backend/src/routes/kanban.ts`, elimina la riga 53 (`  noteId: z.string().nullable().optional(),`), così che lo schema alle righe 47-54 diventi:

```ts
const updateCardSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  priority: z.enum(['STANDBY', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().optional(),
});
```

- [ ] **Step 5 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "ignores a noteId smuggled into the update payload"`
Atteso: PASS, riepilogo con `1 passed`.

- [ ] **Step 6 — Nessuna regressione + typecheck**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts && npx tsc --noEmit`
Atteso: sui test nessun `failed` (il totale è `Tests  34 passed (34)` con 1.2 e 1.4 già committati, `30 passed` se questo task è il primo dei tre a toccare il file), poi nessun output dal typecheck ed exit code 0.

- [ ] **Step 7 — Commit**

```bash
git add backend/src/routes/kanban.ts backend/src/services/kanban/card.service.ts backend/src/services/kanban/__tests__/card.service.test.ts
git commit -m "fix(kanban): drop noteId from the card update path"
```

---

### Task 1.6: Controllo d'accesso in `linkTaskListToBoard`

**Perché:** `POST /kanban/boards/:id/link-tasklist` verifica solo che tu possa scrivere sulla **tua** board, mai che tu possa toccare la task list: passando l'id di una lista altrui la si collega, e la routine di sincronizzazione che segue **scrive** sui `TaskItem` della vittima, spuntando le sue attività. È scrittura su dati altrui, non solo lettura.
**Severità:** critical · **Effort:** S · **Rischio:** none.

**File:**
- Modifica: `backend/src/services/kanban/linking.service.ts:380`
- Modifica: `backend/src/services/kanban/__tests__/linking.service.test.ts` (append dentro `describe('linkTaskListToBoard')`, righe 496-625)

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

Il controllo equivalente esiste già in `backend/src/services/kanban/board.service.ts:299-309` (dentro `createBoardFromTaskList`) ed è quello che copiamo alla lettera: proprietario, oppure share `ACCEPTED` **e** `WRITE`, altrimenti `ForbiddenError('errors.common.accessDenied')`. `ForbiddenError` è già importato in `linking.service.ts` alla riga 4; `errors.common.accessDenied` esiste in entrambi i locale file (verificato: `"Access denied"` / `"Accesso negato"`).

I quattro test esistenti in `describe('linkTaskListToBoard')` passano tutti un `userId` uguale a `taskList.userId` (righe 506, 551) oppure si fermano prima del nuovo controllo (righe 601, 609, 618): **nessuno regredisce**.

- [ ] **Step 1 — Scrivere i test che falliscono**

Appendi dentro `describe('linkTaskListToBoard', ...)` in `backend/src/services/kanban/__tests__/linking.service.test.ts`, subito prima della sua parentesi di chiusura (riga 625, `});`):

```ts

  it('throws ForbiddenError and writes nothing when the task list belongs to someone else', async () => {
    const attacker = setupUser();
    const victim = setupUser();
    const victimList = makeTaskList({ userId: victim.id });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: null });
    prismaMock.taskList.findUnique.mockResolvedValue({
      id: victimList.id,
      title: victimList.title,
      userId: victim.id,
    });
    prismaMock.sharedTaskList.findUnique.mockResolvedValue(null);

    await expect(
      linkTaskListToBoard('board-1', victimList.id, attacker.id)
    ).rejects.toThrow('errors.common.accessDenied');

    // The write must not happen — neither the link nor the TaskItem sync.
    expect(prismaMock.kanbanBoard.update).not.toHaveBeenCalled();
    expect(prismaMock.taskItem.update).not.toHaveBeenCalled();
    expect(prismaMock.kanbanCard.update).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError when the share is READ-only', async () => {
    const collaborator = setupUser();
    const victim = setupUser();
    const victimList = makeTaskList({ userId: victim.id });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: null });
    prismaMock.taskList.findUnique.mockResolvedValue({
      id: victimList.id,
      title: victimList.title,
      userId: victim.id,
    });
    prismaMock.sharedTaskList.findUnique.mockResolvedValue({
      status: 'ACCEPTED',
      permission: 'READ',
    });

    await expect(
      linkTaskListToBoard('board-1', victimList.id, collaborator.id)
    ).rejects.toThrow('errors.common.accessDenied');

    expect(prismaMock.kanbanBoard.update).not.toHaveBeenCalled();
  });

  it('allows linking a task list shared with ACCEPTED + WRITE', async () => {
    const collaborator = setupUser();
    const victim = setupUser();
    const sharedList = makeTaskList({ userId: victim.id });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ taskListId: null });
    prismaMock.taskList.findUnique.mockResolvedValue({
      id: sharedList.id,
      title: sharedList.title,
      userId: victim.id,
    });
    prismaMock.sharedTaskList.findUnique.mockResolvedValue({
      status: 'ACCEPTED',
      permission: 'WRITE',
    });
    prismaMock.kanbanBoard.update.mockResolvedValue({
      taskListId: sharedList.id,
      taskListLinkedById: collaborator.id,
      taskList: { id: sharedList.id, title: sharedList.title, userId: victim.id },
    });
    prismaMock.kanbanColumn.findMany.mockResolvedValue([]);
    prismaMock.kanbanCard.findMany.mockResolvedValue([]);
    prismaMock.taskItem.findMany.mockResolvedValue([]);

    await linkTaskListToBoard('board-1', sharedList.id, collaborator.id);

    expect(prismaMock.kanbanBoard.update).toHaveBeenCalled();
    expect(prismaMock.sharedTaskList.findUnique).toHaveBeenCalledWith({
      where: { taskListId_userId: { taskListId: sharedList.id, userId: collaborator.id } },
      select: { status: true, permission: true },
    });
  });
```

Identificatori usati, tutti già presenti: `setupUser` (riga 57), `makeTaskList` (import riga 9), `linkTaskListToBoard` (import riga 41), `broadcast` (import riga 47), `prismaMock` (riga 49). `prismaMock.sharedTaskList.findUnique` è definito nel mock globale (`backend/src/__tests__/setup.ts:180`): nessuna augmentation necessaria.

- [ ] **Step 2 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts -t "throws ForbiddenError and writes nothing when the task list belongs to someone else"`
Atteso: FAIL con `AssertionError: promise resolved "{ taskListId: … }" instead of rejecting`. Riepilogo con `1 failed`.

- [ ] **Step 3 — Implementare**

In `backend/src/services/kanban/linking.service.ts`, sostituisci la riga 380 (`  if (!taskList) throw new NotFoundError('errors.tasks.listNotFound');`) con:

```ts
  if (!taskList) throw new NotFoundError('errors.tasks.listNotFound');

  // Same rule as createBoardFromTaskList (board.service.ts): owner, or an
  // ACCEPTED + WRITE share. Linking writes back onto the list's TaskItem rows,
  // so this must run before any write below.
  if (taskList.userId !== userId) {
    const shared = await prisma.sharedTaskList.findUnique({
      where: { taskListId_userId: { taskListId, userId } },
      select: { status: true, permission: true },
    });
    if (!shared || shared.status !== 'ACCEPTED' || shared.permission !== 'WRITE') {
      throw new ForbiddenError('errors.common.accessDenied');
    }
  }
```

- [ ] **Step 4 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts`
Atteso: PASS, `Test Files  1 passed (1)` e `Tests  42 passed (42)`.

- [ ] **Step 5 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 6 — Commit**

```bash
git add backend/src/services/kanban/linking.service.ts backend/src/services/kanban/__tests__/linking.service.test.ts
git commit -m "fix(kanban): require task list access before linking it to a board"
```

---

### Task 1.7: `shareWithUserIds` diventa un filtro, non una lista di concessione

**Perché:** Collegando una nota a una card o a una board si può passare un `shareWithUserIds` arbitrario, e `autoShareNoteForBoard` crea per ciascuno uno `SharedNote` con status **ACCEPTED** più notifica in-app ed email. Nessuno di quegli utenti deve essere sulla board: è un canale per spingere note non richieste — con email — nella casella di chiunque.
**Severità:** high · **Effort:** M · **Rischio:** none.

**File:**
- Modifica: `backend/src/services/kanban/linking.service.ts:8` (nuovo helper locale), `:98-108` (`linkNoteToCard`), `:207-211` (`linkNoteToBoard`)
- Modifica: `backend/src/routes/kanban.ts:334-337` e `:528-531`
- Modifica: `backend/src/services/kanban/__tests__/linking.service.test.ts:241-249` (test esistente da aggiornare) e append dentro `describe('linkNoteToCard')` (righe 125-251) e `describe('linkNoteToBoard')` (righe 336-426)

**Interfacce:**
- Consuma: nessuna (l'helper è locale al file, non esportato: `checkNoteSharingForBoard` nello stesso file fa già la stessa query alle righe 26-43, quindi il pattern è quello del file e non serve importare `kanbanPermissions` — il cui mock romperebbe gli altri 39 test)
- Produce: nessuna

**Non è un breaking change per la UI.** Verificato: `SharingGapModal` (`frontend/src/features/kanban/components/SharingGapModal.tsx:24`) inizializza la selezione da `sharingCheck.usersWithoutAccess`, che è calcolata dal server stesso in `checkNoteSharingForBoard` a partire dai soli partecipanti della board (`linking.service.ts:40-55`). I due chiamanti — `CardDetailModal.tsx:183` e `KanbanBoardPage.tsx:271` — girano quella selezione a `linkNote` / `linkBoardNote`. La UI manda quindi già solo un sottoinsieme dei partecipanti: l'intersezione non toglie nulla a nessun flusso legittimo. `NoteLinkPicker.tsx` non manda affatto `shareWithUserIds` (espone solo `onSelect(note: NoteSearchResult)`, riga 13).

Cap Zod: `.max(50)` su entrambi gli array. Cinquanta partecipanti per board è sopra qualunque uso reale e limita il fan-out di email di una singola richiesta.

- [ ] **Step 1 — Aggiornare il test esistente che passa id stranieri**

Il test `'calls autoShareNoteForBoard when shareWithUserIds are provided'` (righe 217-250) passa `['other-user-1', 'other-user-2']` — due id che non sono partecipanti — e si aspetta che arrivino intatti ad `autoShareNoteForBoard`. Con l'intersezione questo test **regredirebbe**, quindi va riscritto ora, insieme ai nuovi. Sostituisci il suo corpo (righe 217-250) con:

```ts
  it('calls autoShareNoteForBoard with the board participants among shareWithUserIds', async () => {
    const user = setupUser();
    const note = makeNote({ userId: user.id });

    prismaMock.kanbanCard.findUnique
      .mockResolvedValueOnce({
        noteId: null,
        column: { boardId: 'board-1', board: { title: 'Board Title' } },
      })
      .mockResolvedValueOnce({
        id: 'card-1',
        _count: { comments: 0 },
      });

    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: user.id,
    });

    prismaMock.kanbanCard.update.mockResolvedValue({ id: 'card-1' });

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: user.id,
      shares: [{ userId: 'other-user-1' }, { userId: 'other-user-2' }],
    });

    const { autoShareNoteForBoard } = await import('../../sharing.service');

    await linkNoteToCard('card-1', note.id, user.id, ['other-user-1', 'other-user-2']);

    expect(autoShareNoteForBoard).toHaveBeenCalledWith(
      user.id,
      note.id,
      ['other-user-1', 'other-user-2'],
      'READ',
      'Board Title'
    );
  });
```

- [ ] **Step 2 — Scrivere i test che falliscono**

Appendi dentro `describe('linkNoteToCard', ...)`, subito prima della sua parentesi di chiusura (riga 251, `});`):

```ts

  it('auto-shares only with users who are actually on the board', async () => {
    const owner = setupUser();
    const participant = setupUser();
    const outsider = setupUser();
    const note = makeNote({ userId: owner.id });
    const board = makeKanbanBoard({ ownerId: owner.id });

    prismaMock.kanbanCard.findUnique
      .mockResolvedValueOnce({
        noteId: null,
        column: { boardId: board.id, board: { title: board.title } },
      })
      .mockResolvedValueOnce({ id: 'card-1', _count: { comments: 0 } });
    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: owner.id,
    });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [{ userId: participant.id }],
    });

    const { autoShareNoteForBoard } = await import('../../sharing.service');

    await linkNoteToCard('card-1', note.id, owner.id, [participant.id, outsider.id]);

    expect(autoShareNoteForBoard).toHaveBeenCalledWith(
      owner.id,
      note.id,
      [participant.id],
      'READ',
      board.title
    );
  });

  it('does not call autoShareNoteForBoard when no requested user is on the board', async () => {
    const owner = setupUser();
    const outsider = setupUser();
    const note = makeNote({ userId: owner.id });
    const board = makeKanbanBoard({ ownerId: owner.id });

    prismaMock.kanbanCard.findUnique
      .mockResolvedValueOnce({
        noteId: null,
        column: { boardId: board.id, board: { title: board.title } },
      })
      .mockResolvedValueOnce({ id: 'card-1', _count: { comments: 0 } });
    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: owner.id,
    });
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: owner.id,
      shares: [],
    });

    const { autoShareNoteForBoard } = await import('../../sharing.service');

    await linkNoteToCard('card-1', note.id, owner.id, [outsider.id]);

    expect(autoShareNoteForBoard).not.toHaveBeenCalled();
  });
```

Appendi dentro `describe('linkNoteToBoard', ...)`, subito prima della sua parentesi di chiusura (riga 426, `});`):

```ts

  it('auto-shares only with users who are actually on the board', async () => {
    const owner = setupUser();
    const participant = setupUser();
    const outsider = setupUser();
    const note = makeNote({ userId: owner.id });
    const board = makeKanbanBoard({ ownerId: owner.id });

    prismaMock.kanbanBoard.findUnique
      .mockResolvedValueOnce({ noteId: null, title: board.title })
      .mockResolvedValueOnce({ ownerId: owner.id, shares: [{ userId: participant.id }] });
    prismaMock.note.findUnique.mockResolvedValue({
      id: note.id,
      title: note.title,
      userId: owner.id,
    });
    prismaMock.kanbanBoard.update.mockResolvedValue({
      noteId: note.id,
      noteLinkedById: owner.id,
      note: { id: note.id, title: note.title, userId: owner.id },
    });

    const { autoShareNoteForBoard } = await import('../../sharing.service');

    await linkNoteToBoard(board.id, note.id, owner.id, [participant.id, outsider.id]);

    expect(autoShareNoteForBoard).toHaveBeenCalledWith(
      owner.id,
      note.id,
      [participant.id],
      'READ',
      board.title
    );
  });
```

- [ ] **Step 3 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts -t "auto-shares only with users who are actually on the board"`
Atteso: FAIL su entrambi i test omonimi (`Tests  2 failed`), con `AssertionError: expected "autoShareNoteForBoard" to be called with arguments: [ …, [ '<participant-id>' ], … ]` e, nella differenza, l'array che contiene anche l'id dell'outsider.

- [ ] **Step 4 — Implementare l'helper locale**

In `backend/src/services/kanban/linking.service.ts`, sostituisci la riga 8 (`// ─── Note Linking ──────────────────────────────────────────`) con:

```ts
/**
 * Owner + ACCEPTED shares of a board. `shareWithUserIds` from the client is a
 * *filter* over this set, never a grant list: without the intersection any
 * writer can auto-share (status ACCEPTED, plus email) with arbitrary users.
 */
async function boardParticipantIds(boardId: string): Promise<Set<string>> {
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: {
      ownerId: true,
      shares: { where: { status: 'ACCEPTED' }, select: { userId: true } },
    },
  });
  if (!board) throw new NotFoundError('errors.kanban.boardNotFound');
  return new Set<string>([board.ownerId, ...board.shares.map((s) => s.userId)]);
}

// ─── Note Linking ──────────────────────────────────────────
```

`prisma` è importato a riga 2 e `NotFoundError` a riga 4: nessun import nuovo.

- [ ] **Step 5 — Applicare il filtro nei due call site**

In `linkNoteToCard`, sostituisci le righe 98-108 (dal commento `// Auto-share with selected users` fino alla `}` di chiusura del blocco `if`) con:

```ts
  // Auto-share, restricted to actual board participants
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const participants = await boardParticipantIds(boardId);
    const targets = shareWithUserIds.filter((id) => participants.has(id));
    if (targets.length > 0) {
      const { autoShareNoteForBoard } = await import('../sharing.service');
      await autoShareNoteForBoard(
        actorId,
        noteId,
        targets,
        'READ',
        card.column.board.title
      );
    }
  }
```

In `linkNoteToBoard`, sostituisci le righe 207-211 con:

```ts
  // Auto-share, restricted to actual board participants
  if (shareWithUserIds && shareWithUserIds.length > 0) {
    const participants = await boardParticipantIds(boardId);
    const targets = shareWithUserIds.filter((id) => participants.has(id));
    if (targets.length > 0) {
      const { autoShareNoteForBoard } = await import('../sharing.service');
      await autoShareNoteForBoard(actorId, noteId, targets, 'READ', board.title);
    }
  }
```

- [ ] **Step 6 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts`
Atteso: PASS, nessun `failed`. Il totale è `Tests  45 passed (45)` se il Task 1.6 è già stato committato, `Tests  42 passed (42)` altrimenti.

- [ ] **Step 7 — Limitare gli array negli schemi Zod**

In `backend/src/routes/kanban.ts`, sostituisci le righe 334-337 (indentate di 2 spazi, sono dentro il plugin) con:

```ts
  const boardLinkNoteSchema = z.object({
    noteId: z.string().uuid(),
    shareWithUserIds: z.array(z.string().uuid()).max(50).optional(),
  });
```

e le righe 528-531 con:

```ts
  const linkNoteSchema = z.object({
    noteId: z.string().uuid(),
    shareWithUserIds: z.array(z.string().uuid()).max(50).optional(),
  });
```

- [ ] **Step 8 — Verifica degli schemi**

**Verifica:** non esistono test di route per il kanban in questo repo, quindi il cap Zod non è coprbile con un unit test. La verifica è un grep che prova la modifica.

Run: `cd backend && grep -n "shareWithUserIds: z.array" src/routes/kanban.ts`
Atteso: esattamente due righe, `336:` e `530:`, entrambe con `shareWithUserIds: z.array(z.string().uuid()).max(50).optional(),`.

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 9 — Commit**

```bash
git add backend/src/services/kanban/linking.service.ts backend/src/routes/kanban.ts backend/src/services/kanban/__tests__/linking.service.test.ts
git commit -m "fix(kanban): intersect shareWithUserIds with board participants"
```

---

### Task 1.8: `checkNoteSharingForBoard` deve verificare il proprietario della nota

**Perché:** `GET /kanban/cards/:id/check-note-sharing` e `GET /kanban/boards/:id/check-note-sharing` restituiscono `noteTitle` e `noteOwnerId` per **qualunque** id di nota passato in query. Chiunque abbia una board può enumerare titoli e proprietari delle note dell'intera istanza.
**Severità:** high · **Effort:** S · **Rischio:** none.

**File:**
- Modifica: `backend/src/services/kanban/linking.service.ts:23`
- Modifica: `backend/src/services/kanban/__tests__/linking.service.test.ts` (append dentro `describe('checkNoteSharingForBoard')`, righe 65-119)

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

La regola scelta è owner-only, ed è esattamente il vincolo che vale a valle: `linkNoteToCard` (`linking.service.ts:89`) e `linkNoteToBoard` (`:195`) lanciano entrambi `ForbiddenError('errors.kanban.onlyOwnerCanLink')` se chi collega non è il proprietario della nota, e il picker (`searchUserNotes`, `:243-251`) offre solo note di cui l'utente è `userId`. Nessun flusso legittimo interroga questa funzione su una nota non propria. Chiave riusata: `errors.kanban.onlyOwnerCanLink`, presente in `en.json` (`"Only the note owner can link this note"`) e in `it.json` (`"Solo il proprietario della nota può collegarla"`) — verificato.

I tre test esistenti nel `describe` sopravvivono: quello a riga 66 passa `owner.id` con `note.userId === owner.id`, quello a riga 103 si ferma sul `NotFoundError` della nota, e quello a riga 111 passa `'u1'` con `userId: 'u1'`.

- [ ] **Step 1 — Scrivere il test che fallisce**

Appendi dentro `describe('checkNoteSharingForBoard', ...)` in `backend/src/services/kanban/__tests__/linking.service.test.ts`, subito prima della sua parentesi di chiusura (riga 119, `});`):

```ts

  it('throws ForbiddenError when the requester does not own the note', async () => {
    const snooper = setupUser();
    const victim = setupUser();
    const victimNote = makeNote({ userId: victim.id, title: 'Secret roadmap' });

    prismaMock.note.findUnique.mockResolvedValue({
      id: victimNote.id,
      title: victimNote.title,
      userId: victim.id,
    });
    // Deliberately answerable: the guard must fire before this is ever read.
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      ownerId: victim.id,
      owner: { id: victim.id, name: victim.name, email: victim.email },
      shares: [],
    });
    prismaMock.sharedNote.findMany.mockResolvedValue([]);

    await expect(
      checkNoteSharingForBoard(victimNote.id, 'board-1', snooper.id)
    ).rejects.toThrow('errors.kanban.onlyOwnerCanLink');

    // The board must never even be queried for a note the caller cannot see.
    expect(prismaMock.kanbanBoard.findUnique).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts -t "throws ForbiddenError when the requester does not own the note"`
Atteso: FAIL con `AssertionError: promise resolved "{ noteTitle: 'Secret roadmap', … }" instead of rejecting`. Riepilogo con `1 failed`.

- [ ] **Step 3 — Implementare**

In `backend/src/services/kanban/linking.service.ts`, sostituisci la riga 23 (`  if (!note) throw new NotFoundError('errors.notes.notFound');`) con:

```ts
  if (!note) throw new NotFoundError('errors.notes.notFound');

  // Only the note owner may link a note (see linkNoteToCard / linkNoteToBoard),
  // so only the owner may probe its title, owner and sharing state.
  if (note.userId !== requestingUserId) throw new ForbiddenError('errors.kanban.onlyOwnerCanLink');
```

`ForbiddenError` è già importato a riga 4.

- [ ] **Step 4 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/linking.service.test.ts`
Atteso: PASS, nessun `failed`. Il totale dipende da quali task del file sono già dentro: `Tests  40 passed (40)` se questo è l'unico dei tre, `Tests  46 passed (46)` se 1.6 e 1.7 sono già committati.

- [ ] **Step 5 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 6 — Commit**

```bash
git add backend/src/services/kanban/linking.service.ts backend/src/services/kanban/__tests__/linking.service.test.ts
git commit -m "fix(kanban): restrict checkNoteSharingForBoard to the note owner"
```

---

### Task 1.9: `deleteComment` deve rivalidare l'accesso alla board

**Perché:** `DELETE /kanban/comments/:id` (`backend/src/routes/kanban.ts:520-524`) è l'unica route kanban senza alcun controllo d'accesso: chiama il service, che verifica solo `comment.authorId === userId`. Un utente a cui la condivisione della board è stata revocata, o declassato a sola lettura, può ancora cancellare i propri vecchi commenti — e ogni cancellazione fa partire una notifica (con email) a tutti i partecipanti attuali della board.
**Severità:** medium · **Effort:** S · **Rischio:** none.

**File:**
- Modifica: `backend/src/services/kanban/comments-chat.service.ts:4` (import) e `:106-112`
- Modifica: `backend/src/services/kanban/__tests__/comments-chat.service.test.ts:28-32` (mock), `:46` (import), `:81-83` (beforeEach) e append dentro `describe('deleteComment')` (righe 235-316)

**Interfacce:**
- Consuma: `assertBoardAccess(boardId: string, userId: string, requiredPermission: 'READ' | 'WRITE'): Promise<{ isOwner: boolean }>` — già esistente in `backend/src/services/kanbanPermissions.ts:4`
- Produce: nessuna

Nota deliberata: qui **non** si usa `assertBelongsToBoard` del Task 1.1. Quella primitiva verifica solo l'appartenenza, mentre qui serve anche il livello di permesso — `createComment` richiede WRITE (route `backend/src/routes/kanban.ts:515`), quindi cancellare deve richiedere lo stesso. `assertBoardAccess` copre entrambe le cose e non aggiunge codice nuovo.

I quattro test esistenti in `describe('deleteComment')` restano verdi: il mock di `assertBoardAccess` risolve sempre, e il controllo `authorId` continua a scattare dopo (test a riga 269).

- [ ] **Step 1 — Aggiungere il mock e l'import nel file di test**

In `backend/src/services/kanban/__tests__/comments-chat.service.test.ts`, subito dopo il blocco `vi.mock('../notifications', ...)` (righe 28-32), inserisci:

```ts

vi.mock('../../kanbanPermissions', () => ({
  assertBoardAccess: vi.fn().mockResolvedValue({ isOwner: true }),
}));
```

Poi, subito dopo la riga 46 (`import { notifyBoardUsersTiered } from '../notifications';`), inserisci:

```ts
import { assertBoardAccess } from '../../kanbanPermissions';
```

`ForbiddenError` è già importato alla riga 44 del file di test.

- [ ] **Step 2 — Ri-armare il mock nel beforeEach**

Il `beforeEach` del `describe` esterno (righe 81-83) chiama solo `vi.clearAllMocks()`, che non rimuove i `...Once` in coda. Sostituisci le righe 81-83 con:

```ts
  beforeEach(() => {
    vi.clearAllMocks();

    // clearAllMocks does not drop queued `...Once` implementations: reset explicitly
    (assertBoardAccess as any).mockReset();
    (assertBoardAccess as any).mockResolvedValue({ isOwner: true });
  });
```

- [ ] **Step 3 — Scrivere i test che falliscono**

Appendi dentro `describe('deleteComment', ...)`, subito prima della sua parentesi di chiusura (riga 316, `  });`). Nota l'indentazione a 4 spazi: il `describe` è annidato dentro `describe('comments-chat.service')`.

```ts

    it('re-validates board WRITE access before deleting', async () => {
      const user = makeUser();
      const boardId = 'board-del-3';

      mockedPrisma.kanbanComment.findUnique.mockResolvedValue({
        authorId: user.id,
        content: 'Mine',
        card: { id: 'card-del-3', title: 'Card', column: { boardId } },
        author: { name: user.name, email: user.email },
      });
      mockedPrisma.kanbanComment.delete.mockResolvedValue({});

      await deleteComment('comment-3', user.id);

      expect(assertBoardAccess).toHaveBeenCalledWith(boardId, user.id, 'WRITE');
    });

    it('does not delete when board access has been revoked', async () => {
      const user = makeUser();
      const boardId = 'board-del-4';

      mockedPrisma.kanbanComment.findUnique.mockResolvedValue({
        authorId: user.id,
        content: 'Mine',
        card: { id: 'card-del-4', title: 'Card', column: { boardId } },
        author: { name: user.name, email: user.email },
      });
      mockedPrisma.kanbanComment.delete.mockResolvedValue({});
      (assertBoardAccess as any).mockRejectedValueOnce(
        new ForbiddenError('errors.common.accessDenied')
      );

      await expect(deleteComment('comment-4', user.id)).rejects.toThrow(ForbiddenError);

      expect(mockedPrisma.kanbanComment.delete).not.toHaveBeenCalled();
      expect(notifyBoardUsersTiered).not.toHaveBeenCalled();
    });
```

- [ ] **Step 4 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts -t "re-validates board WRITE access before deleting"`
Atteso: FAIL con `AssertionError: expected "spy" to be called with arguments: [ 'board-del-3', …, 'WRITE' ]` seguito da `Number of calls: 0`. Riepilogo con `1 failed`.

- [ ] **Step 5 — Implementare**

In `backend/src/services/kanban/comments-chat.service.ts`, sostituisci la riga 4 con:

```ts
import { notifyBoardUsersTiered, boardChatEmailDebounce, BOARD_CHAT_EMAIL_DEBOUNCE_MS } from './notifications';
import { assertBoardAccess } from '../kanbanPermissions';
```

Poi sostituisci le righe 106-112 (dal `if (!comment)` fino a `  const boardId = comment.card.column.boardId;` incluso) con:

```ts
  if (!comment) throw new NotFoundError('errors.kanban.commentNotFound');

  const boardId = comment.card.column.boardId;

  // The DELETE /comments/:id route carries no board id, so it cannot check
  // access itself: a revoked or demoted user must not still be able to delete
  // (and notify the whole board about) their old comments.
  await assertBoardAccess(boardId, userId, 'WRITE');

  if (comment.authorId !== userId) throw new ForbiddenError('errors.kanban.notYourComment');

  await prisma.kanbanComment.delete({ where: { id: commentId } });

  // Broadcast deletion for real-time UI update
```

La dichiarazione `const boardId` risale in cima al blocco: assicurati che non ne restino due (la riga 112 originale è quella sostituita).

- [ ] **Step 6 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts`
Atteso: PASS, `Test Files  1 passed (1)` e `Tests  23 passed (23)`.

- [ ] **Step 7 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 8 — Commit**

```bash
git add backend/src/services/kanban/comments-chat.service.ts backend/src/services/kanban/__tests__/comments-chat.service.test.ts
git commit -m "fix(kanban): re-check board access in deleteComment"
```

---

### Task 1.10: La ri-condivisione di una board non deve riportare a PENDING uno share ACCEPTED

**Perché:** L'owner che ri-condivide una board per cambiare il permesso di un collaboratore da READ a WRITE lo riporta a `PENDING`: il collaboratore perde l'accesso all'istante (`assertBoardAccess` richiede `ACCEPTED`, `kanbanPermissions.ts:20`) finché non riaccetta l'invito, e riceve una seconda email d'invito per una board su cui stava già lavorando.
**Severità:** medium · **Effort:** M · **Rischio:** TIER 2 — `backend/src/services/sharing.service.ts` è condiviso da note, notebook, task list e kanban; la modifica è confinata dentro `shareKanbanBoard`, nessun altro percorso viene toccato.

**File:**
- Modifica: `backend/src/services/sharing.service.ts:575-580`
- Modifica: `backend/src/services/__tests__/sharing.service.test.ts:3-14` (import) e append in coda al file (dopo la riga 853)

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

**Trappola da non toccare.** `respondToShareById` (`sharing.service.ts:401-554`) ha già il guard corretto in tutti e tre i rami: riga 411 (NOTE), 428 (NOTEBOOK) e 445 (KANBAN) fanno `if (existing.status !== 'PENDING') return { success: true, status: existing.status };`. Non "aggiustarlo" con `if (existing.status === status)`: quella variante legalizzerebbe la transizione DECLINED → ACCEPTED. Se un giorno dovesse davvero servire ammorbidirlo, l'unica condizione accettabile è `existing.status !== 'PENDING' && !(existing.status === 'ACCEPTED' && status === 'DECLINED')`. In questo task non si tocca `respondToShareById`.

Nota di scoping: lo stesso schema esiste anche in `shareNote` (`sharing.service.ts:51`) e nelle sue sorelle. Fuori scope qui — un commit, una falla.

`backend/src/services/__tests__/sharing.service.test.ts` ha oggi un solo blocco kanban, `describe('revokeKanbanBoardShare')` (righe 832-853, 2 test): la copertura di `shareKanbanBoard` va creata da zero. Il file mocka già `audit.service`, `email.service`, `notification.service` e `kanbanSSE` (righe 21-35), quindi i side-effect di `shareKanbanBoard` sono tutti neutralizzati.

- [ ] **Step 1 — Estendere l'import**

In `backend/src/services/__tests__/sharing.service.test.ts`, sostituisci le righe 3-14 con — attenzione a **non** perdere `revokeKanbanBoardShare`, che serve al `describe` già presente a riga 832:

```ts
import {
  shareNote,
  revokeKanbanBoardShare,
  revokeNoteShare,
  getAcceptedSharedNotes,
  getSharedNotes,
  shareNotebook,
  revokeNotebookShare,
  getSharedNotebooks,
  respondToShareById,
  updateSharedNoteContent,
  shareKanbanBoard,
} from '../sharing.service';
```

- [ ] **Step 2 — Scrivere i test che falliscono**

Appendi in coda a `backend/src/services/__tests__/sharing.service.test.ts` (dopo la riga 853, ultima riga del file):

```ts

// ===========================================================================
// shareKanbanBoard
// ===========================================================================

describe('shareKanbanBoard', () => {
  const SHARE_BOARD_ID = 'board-id-2';
  const sampleBoard = { title: 'My Board', ownerId: OWNER_ID };

  function primeCommonMocks() {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue(sampleBoard);
    // First user.findUnique = target by email, second = the sharer
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ ...targetUser, locale: 'en' })
      .mockResolvedValueOnce({ name: ownerUser.name, email: ownerUser.email });
    prismaMock.sharedKanbanBoard.upsert.mockResolvedValue({
      id: 'share-1',
      boardId: SHARE_BOARD_ID,
      userId: TARGET_USER_ID,
      permission: 'WRITE',
      status: 'PENDING',
      user: targetUser,
    });
  }

  it('creates a PENDING share when none exists yet', async () => {
    primeCommonMocks();
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue(null);

    await shareKanbanBoard(OWNER_ID, SHARE_BOARD_ID, targetUser.email, 'WRITE');

    expect(prismaMock.sharedKanbanBoard.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { permission: 'WRITE', status: 'PENDING' },
        create: {
          boardId: SHARE_BOARD_ID,
          userId: TARGET_USER_ID,
          permission: 'WRITE',
          status: 'PENDING',
        },
      })
    );
  });

  it('keeps an ACCEPTED share ACCEPTED when the owner re-shares to change permission', async () => {
    primeCommonMocks();
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({ status: 'ACCEPTED' });

    await shareKanbanBoard(OWNER_ID, SHARE_BOARD_ID, targetUser.email, 'WRITE');

    expect(prismaMock.sharedKanbanBoard.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { permission: 'WRITE', status: 'ACCEPTED' },
      })
    );
  });

  it('resets a DECLINED share back to PENDING on re-share', async () => {
    primeCommonMocks();
    prismaMock.sharedKanbanBoard.findUnique.mockResolvedValue({ status: 'DECLINED' });

    await shareKanbanBoard(OWNER_ID, SHARE_BOARD_ID, targetUser.email, 'READ');

    expect(prismaMock.sharedKanbanBoard.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { permission: 'READ', status: 'PENDING' },
      })
    );
  });

  it('throws when the requester is not the board owner', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      title: 'My Board',
      ownerId: 'someone-else',
    });

    await expect(
      shareKanbanBoard(OWNER_ID, SHARE_BOARD_ID, targetUser.email, 'READ')
    ).rejects.toThrow('errors.common.notTheOwner');

    expect(prismaMock.sharedKanbanBoard.upsert).not.toHaveBeenCalled();
  });
});
```

`OWNER_ID` (riga 48), `TARGET_USER_ID` (riga 49), `ownerUser` (riga 53), `targetUser` (riga 54) e `prismaMock` (riga 42) esistono già nel file. `SHARE_BOARD_ID` è un nome nuovo per non collidere con il `BOARD_ID` locale del `describe('revokeKanbanBoardShare')`.

- [ ] **Step 3 — Vedere il rosso**

Run: `cd backend && npx vitest run src/services/__tests__/sharing.service.test.ts -t "keeps an ACCEPTED share ACCEPTED when the owner re-shares to change permission"`
Atteso: FAIL con `AssertionError: expected "upsert" to be called with arguments: [ ObjectContaining{ update: { permission: 'WRITE', status: 'ACCEPTED' } } ]` e, nella differenza, `status: 'PENDING'`. Riepilogo con `1 failed`.

- [ ] **Step 4 — Implementare**

In `backend/src/services/sharing.service.ts`, sostituisci le righe 575-580 (l'intera `prisma.sharedKanbanBoard.upsert`) con:

```ts
  // Re-sharing must not knock an active collaborator back to PENDING: they would
  // lose access on the spot (assertBoardAccess requires ACCEPTED) until they
  // re-accept. DECLINED and missing rows do go (back) to PENDING.
  const existingShare = await prisma.sharedKanbanBoard.findUnique({
    where: { boardId_userId: { boardId, userId: targetUser.id } },
    select: { status: true },
  });
  const nextStatus = existingShare?.status === 'ACCEPTED' ? 'ACCEPTED' : 'PENDING';

  const share = await prisma.sharedKanbanBoard.upsert({
    where: { boardId_userId: { boardId, userId: targetUser.id } },
    update: { permission, status: nextStatus },
    create: { boardId, userId: targetUser.id, permission, status: 'PENDING' },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  });
```

- [ ] **Step 5 — Vedere il verde**

Run: `cd backend && npx vitest run src/services/__tests__/sharing.service.test.ts`
Atteso: PASS, `Test Files  1 passed (1)` e `Tests  49 passed (49)`.

- [ ] **Step 6 — Verificare di non aver toccato `respondToShareById`**

**Verifica:** questo è un controllo di non-regressione su codice che il task deliberatamente **non** modifica; non c'è nulla da testare, solo da provare che è rimasto intatto. La nuova logica è inserita dopo `respondToShareById`, quindi i numeri di riga di quest'ultimo non si spostano.

Run: `cd backend && grep -n "existing.status !== 'PENDING'" src/services/sharing.service.ts`
Atteso: esattamente tre righe — `411:`, `428:` e `445:` — tutte con `    if (existing.status !== 'PENDING') return { success: true, status: existing.status };`. Se ne compaiono meno di tre, o se una contiene `=== status`, la modifica ha sconfinato: annullala.

- [ ] **Step 7 — Typecheck e lint**

Run: `cd backend && npx tsc --noEmit && npm run lint`
Atteso: nessun output dal typecheck (exit code 0), poi `eslint src/` termina senza errori (nessun output, exit code 0).

- [ ] **Step 8 — Commit**

```bash
git add backend/src/services/sharing.service.ts backend/src/services/__tests__/sharing.service.test.ts
git commit -m "fix(kanban): preserve ACCEPTED board shares on re-share"
```

---

### Chiusura dello stage

- [ ] **Step 1 — Suite backend completa**

Run: `cd backend && npx vitest run`
Atteso: PASS, `Test Files  61 passed (61)` e `Tests  1113 passed (1113)`. Rispetto alla baseline (`1083 passed`) lo stage aggiunge 30 test: +10 in `kanbanPermissions.test.ts` (1.1), +5 in `card.service.test.ts` (1 da 1.2, 3 da 1.4, 1 da 1.5), +2 in `column.service.test.ts` (1.3), +7 in `linking.service.test.ts` (3 da 1.6, 3 da 1.7, 1 da 1.8), +2 in `comments-chat.service.test.ts` (1.9), +4 in `sharing.service.test.ts` (1.10). Il Task 1.7 inoltre **riscrive** un test esistente di `linking.service.test.ts` senza cambiarne il conteggio.

- [ ] **Step 2 — Typecheck e lint finali**

Run: `cd backend && npx tsc --noEmit && npm run lint`
Atteso: nessun output dal typecheck (exit code 0), poi `eslint src/` senza errori.

- [ ] **Step 3 — Verifica manuale dei flussi condivisi (owner)**

**Verifica:** nessuno di questi dieci fix tocca il frontend, ma tre cambiano codici di risposta su percorsi che la UI usa davvero, e non esistono test di route nel repo. Con due account e una board condivisa, verifica a mano:
1. **Riordino colonne** (drag di una colonna): le posizioni si salvano, nessun toast d'errore.
2. **Assegnazione card**: l'assegnatario proposto dalla UI è già un partecipante, quindi l'assegnazione va a buon fine; l'attività `ASSIGNED` compare nel dettaglio card.
3. **Link nota a card con gap di condivisione**: il `SharingGapModal` si apre, e confermando la selezione la nota risulta condivisa con i partecipanti scelti (nessuno sparisce dalla lista).
4. **Ri-condivisione board a un collaboratore già ACCEPTED per cambiare permesso**: il collaboratore **non** deve tornare in stato "invito da accettare", e il permesso deve risultare aggiornato.

- [ ] **Step 4 — E2E consigliati (non in CI)**

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts e2e/sharing.spec.ts`
Atteso: entrambe le spec passano. Non sono cablate in CI, quindi vanno lanciate a mano dopo lo stage.

---

## Stage 2 — Riscrittura di `position` (sequenziale)

Questo stage elimina il bug per cui due card finiscono sulla stessa `position` e un indice resta vuoto. `moveCard` (`backend/src/services/kanban/card.service.ts:175-323`) fa tre passaggi dentro una sola transazione (righe 202-232):

1. riga 204: `updateMany({ where: { columnId: toColumnId, position: { gte: newPosition } }, data: { position: { increment: 1 } } })`
2. riga 210: `update({ where: { id: cardId }, data: { columnId: toColumnId, position: newPosition } })`
3. riga 217, ramo stessa-colonna: `updateMany({ where: { columnId: card.columnId, position: { gt: card.position }, id: { not: cardId } }, data: { position: { decrement: 1 } } })`

Il passo 3 usa `card.position`, il valore **pre-move**, contro righe che il passo 1 ha già spostato. Traccia con card A=0, B=1, C=2, D=3 e sposta A all'indice 2: il passo 1 dà C=3, D=4; il passo 2 dà A=2; il passo 3 decrementa tutto ciò che ha position > 0 tranne A, dando B=0, C=2, D=3. Stato finale: **A=2 e C=2 collidono, e la position 1 è un buco.**

La suite esistente passa **con il bug dentro** perché `prismaMock.kanbanCard.updateMany` è stubbato a `{count:0}` e le asserzioni verificano solo che `$transaction` sia stato chiamato; nessuno dei 5 test `moveCard` esistenti usa `toColumnId === card.columnId`. Per questo i test vengono PRIMA in questo stage.

**L'ordine 2.1 → 2.2 è obbligatorio:** il test deve esistere e fallire prima della riscrittura. **2.4 e 2.5 diventano osservabili solo dopo che 2.2 è atterrato** (finché il server non riordina davvero, sistemare il sentinella lato client non cambia nulla di visibile).

Baseline verificata prima di iniziare (Vitest 4.0.18, `cd backend && npx vitest run src/services/kanban` → `Test Files 5 passed (5)`, `Tests 115 passed (115)`): `card.service.test.ts` 29 test, `board.service.test.ts` 17, `column.service.test.ts` 9, `linking.service.test.ts` 39, `comments-chat.service.test.ts` 21. Lato frontend `npx vitest run src/features/kanban` → `Tests 9 passed (9)` (`kanbanService.test.ts` 8 + `CardContextMenu.test.tsx` 1). `npx tsc --noEmit` è pulito in entrambi i workspace; `npm run lint` dà 0 errori (63 warning backend, 52 frontend, tutti preesistenti).

> **Nota sui numeri di riga di `KanbanBoardPage.tsx`:** la Stage 1 tocca quel file sopra il punto che la Task 2.4 modifica e può spostare le righe di ±3. I numeri qui sotto sono quelli di `HEAD` prima della Stage 1; l'ancora affidabile è il commento `// Optimistic UI + silent REST calls`, non il numero.

---

### Task 2.1: Estrarre `computeColumnOrder` come funzione pura

**Perché:** Oggi la logica di riordino è sparsa in tre `updateMany` che nessuno può testare in isolamento, e infatti sbagliano. Una funzione pura con una tabella di casi rende il comportamento ("cosa significa indice 2") verificabile in millisecondi e condiviso tra server e client.
**Severità:** high · **Effort:** S · **Rischio:** none (file nuovo, nessun consumer ancora)

**File:**
- Crea: `backend/src/services/kanban/position.ts`
- Crea: `backend/src/services/kanban/__tests__/position.test.ts`

Il file sta accanto a `card.service.ts`, come `helpers.ts`. `backend/src/services/kanban/index.ts` contiene esattamente cinque righe (`export * from './board.service'`, `'./column.service'`, `'./card.service'`, `'./comments-chat.service'`, `'./linking.service'`): quindi `position.ts` (come `helpers.ts` e `notifications.ts`) resta un modulo interno e **non** va aggiunto a `index.ts`.

**Interfacce:**
- Consuma: nessuna
- Produce: `export function computeColumnOrder(cardIds: string[], cardId: string, newIndex: number): string[]`

- [ ] **Step 1 — Scrivere il test table-driven (fallisce: il modulo non esiste)**

Crea `backend/src/services/kanban/__tests__/position.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeColumnOrder } from '../position';

describe('computeColumnOrder', () => {
  const cases: {
    name: string;
    cardIds: string[];
    cardId: string;
    newIndex: number;
    expected: string[];
  }[] = [
    {
      name: 'moves a card down',
      cardIds: ['a', 'b', 'c', 'd'],
      cardId: 'a',
      newIndex: 2,
      expected: ['b', 'c', 'a', 'd'],
    },
    {
      name: 'moves a card up',
      cardIds: ['a', 'b', 'c', 'd'],
      cardId: 'd',
      newIndex: 1,
      expected: ['a', 'd', 'b', 'c'],
    },
    {
      name: 'moves a card to the first index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'c',
      newIndex: 0,
      expected: ['c', 'a', 'b'],
    },
    {
      name: 'moves a card to the last index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'a',
      newIndex: 2,
      expected: ['b', 'c', 'a'],
    },
    {
      name: 'is a no-op when the card is already at that index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'b',
      newIndex: 1,
      expected: ['a', 'b', 'c'],
    },
    {
      name: 'inserts a card coming from another column',
      cardIds: ['x', 'y'],
      cardId: 'new',
      newIndex: 1,
      expected: ['x', 'new', 'y'],
    },
    {
      name: 'clamps an index past the end (the 999 sentinel) to an append',
      cardIds: ['a', 'b'],
      cardId: 'a',
      newIndex: 999,
      expected: ['b', 'a'],
    },
    {
      name: 'appends a foreign card when the index is past the end',
      cardIds: ['x', 'y'],
      cardId: 'z',
      newIndex: 999,
      expected: ['x', 'y', 'z'],
    },
    {
      name: 'clamps a negative index to the front',
      cardIds: ['a', 'b'],
      cardId: 'b',
      newIndex: -3,
      expected: ['b', 'a'],
    },
    {
      name: 'inserts into an empty column',
      cardIds: [],
      cardId: 'only',
      newIndex: 4,
      expected: ['only'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(computeColumnOrder(c.cardIds, c.cardId, c.newIndex)).toEqual(c.expected);
    });
  }

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    computeColumnOrder(input, 'a', 2);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/position.test.ts`
Atteso: FAIL — `Error: Cannot find module '../position' imported from 'D:/Develop/AI/Notiq/backend/src/services/kanban/__tests__/position.test.ts'`, poi `Test Files  1 failed (1)` e `Tests  no tests`.

- [ ] **Step 3 — Implementare la funzione**

Crea `backend/src/services/kanban/position.ts`:

```ts
/**
 * Pure ordering helper for a kanban column.
 *
 * Given the current order of a column (card ids, position-ascending) it returns
 * the order after `cardId` has been placed at `newIndex`. The card is removed
 * first and re-inserted — exactly what @dnd-kit's `arrayMove` does on the
 * client — so the server and the board agree on what "index 2" means.
 *
 * - `cardId` may be absent from `cardIds` (cross-column insert): it is added.
 * - `newIndex` is clamped into [0, length], so a sentinel like 999 appends
 *   instead of writing an out-of-range position into the database.
 *
 * The returned array IS the new position mapping: index i → position i.
 */
export function computeColumnOrder(
  cardIds: string[],
  cardId: string,
  newIndex: number
): string[] {
  const rest = cardIds.filter((id) => id !== cardId);
  const index = Math.min(Math.max(newIndex, 0), rest.length);
  rest.splice(index, 0, cardId);
  return rest;
}
```

- [ ] **Step 4 — Vedere il test passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/position.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` e `Tests  11 passed (11)`.

- [ ] **Step 5 — Typecheck**

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 6 — Commit**

```bash
git add backend/src/services/kanban/position.ts backend/src/services/kanban/__tests__/position.test.ts
git commit -m "feat(kanban): add computeColumnOrder pure ordering helper"
```

---

### Task 2.2: Riscrivere `moveCard` come resequence diff-based

**Perché:** Trascinando una card verso il basso nella stessa colonna due card finiscono sulla stessa `position` e un indice resta vuoto: l'ordine sullo schermo diventa instabile (dipende dal tie-break casuale di PostgreSQL) e al refresh le card "saltano". Questo è il cuore dello stage.
**Severità:** critical · **Effort:** M · **Rischio:** none (`card.service.ts` non è in TIER 1/2), ma è un percorso di scrittura su dati utente: un commit solo per questa modifica, niente altro nel diff.

**File:**
- Modifica: `backend/src/services/kanban/card.service.ts:5` (import) e `backend/src/services/kanban/card.service.ts:200-240` (transazione + broadcast)
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts:423-598` (blocco `describe('moveCard')`)

**VINCOLO CRITICO da tenere nel codice.** `KanbanCard.updatedAt` è `@updatedAt` (verificato in `backend/prisma/schema.prisma`, riga 520 del model `KanbanCard`): Prisma lo aggiorna **a ogni `update`/`updateMany`**. E `archiveCompletedCards` (`backend/src/services/kanban/card.service.ts:374-402`) filtra su `updatedAt: { lte: cutoffDate }` (riga 391) con `cutoffDate = now - 7 giorni`. Quindi una riscrittura ingenua di tutta la colonna azzererebbe l'orologio dell'archiviazione a 7 giorni **a ogni singolo drag**: le card completate non verrebbero più archiviate mai. L'implementazione DEVE confrontare l'ordine calcolato con quello letto e scrivere **solo** le righe la cui `position` cambia davvero.

**SECONDO VINCOLO.** L'oggetto passato a `broadcast` in `moveCard` (righe 234-240) **non** contiene `actorId` — a differenza di altri broadcast del file. Il test esistente alle righe 454-460 asserisce l'oggetto esatto con `toHaveBeenCalledWith`: aggiungere `actorId` lo fa fallire. La sostituzione qui sotto lo lascia fuori: non aggiungerlo.

**Interfacce:**
- Consuma: `computeColumnOrder(cardIds: string[], cardId: string, newIndex: number): string[]` (Task 2.1)
- Produce: `moveCard(cardId: string, toColumnId: string, newPosition: number, actorId?: string, skipNotification?: boolean): Promise<void>` — firma invariata, ma dopo la chiamata le `position` della colonna di destinazione sono una permutazione contigua `0..n-1` senza duplicati; l'evento SSE `card:moved` porta la position **effettiva** (clampata), non quella richiesta.

- [ ] **Step 1 — Aggiungere il `beforeEach` e i tre test di regressione**

In `backend/src/services/kanban/__tests__/card.service.test.ts`, subito dopo la riga 428 (`  const card = makeKanbanCard({ columnId: sourceColumn.id });`) e prima del primo `it` alla riga 430, inserire:

```ts
  beforeEach(() => {
    // moveCard now READS the column before rewriting it: without a default the
    // findMany mock resolves to undefined and every test in this block explodes.
    // mockReset (not mockClear) also drains any leftover mockResolvedValueOnce
    // queue from a previous test in this describe.
    prismaMock.kanbanCard.findMany.mockReset();
    prismaMock.kanbanCard.findMany.mockResolvedValue([]);
    // Same shape as column.service.test.ts: run the callback with prismaMock.
    prismaMock.$transaction = vi.fn((fn: any) => {
      if (typeof fn === 'function') return fn(prismaMock);
      return Promise.all(fn);
    });
  });

  /** The (id, position) pairs the service actually wrote, in write order. */
  function positionWrites(): { id: string; position: number }[] {
    return prismaMock.kanbanCard.update.mock.calls
      .map(([arg]: [any]) => arg)
      .filter((arg: any) => arg.data.position !== undefined)
      .map((arg: any) => ({ id: arg.where.id, position: arg.data.position as number }));
  }
```

Poi, in fondo allo stesso `describe('moveCard')` — dopo la chiusura dell'ultimo `it` (riga 597) e prima della chiusura del `describe` alla riga 598 — aggiungere i tre test:

```ts
  it('never leaves two cards on the same position after a same-column downward move', async () => {
    // A=0 B=1 C=2 D=3, drag A down to index 2 -> expected final order B C A D.
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: 'A',
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'To Do',
      position: 0,
      isCompleted: false,
    });
    prismaMock.kanbanCard.findMany.mockResolvedValue([
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
      { id: 'C', position: 2 },
      { id: 'D', position: 3 },
    ]);
    prismaMock.kanbanCard.update.mockResolvedValue({});

    await moveCard('A', sourceColumn.id, 2, actor.id);

    // Start from the pre-move state and apply what the service wrote.
    const final: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
    for (const w of positionWrites()) final[w.id] = w.position;

    expect(final).toEqual({ B: 0, C: 1, A: 2, D: 3 });
    // No duplicate positions.
    expect(new Set(Object.values(final)).size).toBe(4);
    // Contiguous 0..n-1 permutation, no holes.
    expect(Object.values(final).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('writes only the rows between the old and the new index', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: 'A',
      columnId: sourceColumn.id,
      position: 0,
      taskItemId: null,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'To Do',
      position: 0,
      isCompleted: false,
    });
    prismaMock.kanbanCard.findMany.mockResolvedValue([
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
      { id: 'C', position: 2 },
      { id: 'D', position: 3 },
    ]);
    prismaMock.kanbanCard.update.mockResolvedValue({});

    await moveCard('A', sourceColumn.id, 2, actor.id);

    const writes = positionWrites();
    expect(writes).toEqual([
      { id: 'B', position: 0 },
      { id: 'C', position: 1 },
      { id: 'A', position: 2 },
    ]);
    // D does not move. Writing it would bump its @updatedAt and reset the
    // 7-day archive clock read by archiveCompletedCards().
    expect(writes.map((w) => w.id)).not.toContain('D');
    // The reposition must go through targeted updates, never updateMany.
    expect(prismaMock.kanbanCard.updateMany).not.toHaveBeenCalled();
  });

  it('inserts into the middle of the target column without duplicating a position', async () => {
    prismaMock.kanbanCard.findUnique.mockResolvedValue({
      title: card.title,
      columnId: sourceColumn.id,
      position: 1,
      taskItemId: null,
      column: { boardId: board.id, title: 'To Do', isCompleted: false },
    });
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: 'Done',
      position: 1,
      isCompleted: false,
    });
    // 1st findMany = source column (without the moved card), 2nd = target column
    prismaMock.kanbanCard.findMany
      .mockResolvedValueOnce([
        { id: 'S1', position: 0 },
        { id: 'S2', position: 1 },
      ])
      .mockResolvedValueOnce([
        { id: 'X', position: 0 },
        { id: 'Y', position: 1 },
      ]);
    prismaMock.kanbanCard.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ name: actor.name, email: actor.email });

    await moveCard('M', targetColumn.id, 1, actor.id);

    expect(positionWrites()).toEqual([
      { id: 'M', position: 1 },
      { id: 'Y', position: 2 },
    ]);
    // S1/S2 are already contiguous once M is gone: nothing to rewrite there.
    // NOTE: the broadcast object carries no actorId — matching the service.
    expect(broadcast).toHaveBeenCalledWith(board.id, {
      type: 'card:moved',
      boardId: board.id,
      cardId: 'M',
      toColumnId: targetColumn.id,
      position: 1,
    });
  });
```

> Le righe `prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 0 })` nei cinque test `moveCard` preesistenti diventano inutili ma innocue: lasciarle non cambia l'esito di nessuna asserzione.

- [ ] **Step 2 — Vedere i nuovi test fallire (e i vecchi restare verdi)**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`
Atteso: FAIL — `Tests  3 failed | 29 passed (32)`, con questi messaggi:
- `AssertionError: expected { A: 2, B: 1, C: 2, D: 3 } to deeply equal { B: +0, C: 1, A: 2, D: 3 }`
- `AssertionError: expected [ { id: 'A', position: 2 } ] to deeply equal [ { id: 'B', position: +0 }, …(2) ]`
- `AssertionError: expected [ { id: 'M', position: 1 } ] to deeply equal [ { id: 'M', position: 1 }, …(1) ]`

- [ ] **Step 3 — Aggiungere l'import in `card.service.ts`**

Sostituire la riga 5 di `backend/src/services/kanban/card.service.ts`:

```ts
import { logCardActivity, cardWithAssigneeSelect, transformCard } from './helpers';
```

con:

```ts
import { logCardActivity, cardWithAssigneeSelect, transformCard } from './helpers';
import { computeColumnOrder } from './position';
```

- [ ] **Step 4 — Sostituire la transazione e il broadcast**

In `backend/src/services/kanban/card.service.ts`, rimpiazzare integralmente le righe 200-240 (da `  const boardId = card.column.boardId;` fino a `  });` che chiude il `broadcast(...)`) con:

```ts
  const boardId = card.column.boardId;
  const isCrossColumn = card.columnId !== toColumnId;

  // [BACKUP] 2026-08-31 — the previous body was three updateMany calls:
  //   1. increment every position >= newPosition in the target column
  //   2. update the card to (toColumnId, newPosition)
  //   3. decrement every position > card.position in the source column
  // Step 3 used card.position (the PRE-move value) against rows step 1 had
  // already shifted. With A=0 B=1 C=2 D=3 and A moved to index 2 the result was
  // A=2, C=2 (collision) and a hole at position 1. Replaced by a read-then-diff
  // resequence: the column order is computed in memory and only the rows that
  // actually change position are written.
  const order = await prisma.$transaction(async (tx) => {
    // Cross-column: close the hole the card leaves behind in the source column.
    if (isCrossColumn) {
      const sourceCards = await tx.kanbanCard.findMany({
        where: { columnId: card.columnId, archivedAt: null, id: { not: cardId } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      });
      for (let i = 0; i < sourceCards.length; i++) {
        if (sourceCards[i].position === i) continue;
        await tx.kanbanCard.update({ where: { id: sourceCards[i].id }, data: { position: i } });
      }
    }

    // The target column as it is now. Archived cards are excluded on purpose:
    // getBoard() filters archivedAt: null, so they are never rendered and must
    // not consume positions.
    const targetCards = await tx.kanbanCard.findMany({
      where: { columnId: toColumnId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, position: true },
    });

    const nextOrder = computeColumnOrder(targetCards.map((c) => c.id), cardId, newPosition);
    // The explicit <string, number> generic is required: without it TS types the
    // .map() result as (string | number)[][] and the Map constructor rejects it.
    const currentPosition = new Map<string, number>(targetCards.map((c) => [c.id, c.position]));

    for (let i = 0; i < nextOrder.length; i++) {
      const id = nextOrder[i];
      // Rows that do not actually move are NOT written. KanbanCard.updatedAt is
      // @updatedAt and archiveCompletedCards() filters on `updatedAt <= cutoff`
      // as the 7-day archive clock: rewriting the whole column would reset that
      // clock for every card on every single drag.
      // (On a cross-column move the moved card is absent from currentPosition,
      // so it is always written — together with its new columnId.)
      if (currentPosition.get(id) === i) continue;
      await tx.kanbanCard.update({
        where: { id },
        data:
          id === cardId && isCrossColumn
            ? { columnId: toColumnId, position: i }
            : { position: i },
      });
    }

    return nextOrder;
  });

  broadcast(boardId, {
    type: 'card:moved',
    boardId,
    cardId,
    toColumnId,
    // The position actually written, not the one requested: computeColumnOrder
    // clamps an out-of-range index (e.g. an append) into the column.
    position: order.indexOf(cardId),
  });
```

> Il campo `position: true` resta nella `select` della `findUnique` alle righe 182-191: non serve più alla logica, ma i test lo forniscono e toglierlo allarga il diff senza guadagno. Tutto il blocco dopo il broadcast (auto-assign, `logCardActivity`, sync `TaskItem`, notifiche, reminder — righe 242-323) resta invariato.

- [ ] **Step 5 — Vedere tutti i test del file passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` e `Tests  32 passed (32)`.

- [ ] **Step 6 — Verificare che il resto della suite kanban non sia rotto**

Run: `cd backend && npx vitest run src/services/kanban && npx tsc --noEmit`
Atteso: PASS — `Test Files  6 passed (6)`, `Tests  129 passed (129)` (115 di baseline + 11 di `position.test.ts` + 3 nuovi), e nessun output da `tsc`.

- [ ] **Step 7 — Commit**

```bash
git add backend/src/services/kanban/card.service.ts backend/src/services/kanban/__tests__/card.service.test.ts
git commit -m "fix(kanban): moveCard resequences the column instead of colliding positions"
```

---

### Task 2.3: Tiebreaker deterministico su ogni ordinamento per `position`

**Perché:** Finché due righe possono condividere una `position` (e anche dopo: i dati già corrotti in produzione restano lì), `ORDER BY position` lascia l'ordine delle righe pari al capriccio del planner di PostgreSQL. Risultato: la stessa board mostra le card in ordine diverso a due refresh consecutivi.
**Severità:** medium · **Effort:** S · **Rischio:** none

**File:**
- Modifica: `backend/src/services/kanban/board.service.ts:168` (colonne di `getBoard`) e `backend/src/services/kanban/board.service.ts:172` (card di `getBoard`)
- Modifica: `backend/src/services/kanban/board.service.ts:135`, `backend/src/services/kanban/board.service.ts:150`, `backend/src/services/kanban/board.service.ts:331` (colonne)
- Modifica: `backend/src/routes/sharing.ts:337` (colonne) e `backend/src/routes/sharing.ts:340` (card)
- Modifica: `backend/src/services/kanban/__tests__/board.service.test.ts` (dentro `describe('getBoard')`, dopo il primo `it` che chiude alla riga 221)

**Inventario completo** (da `grep -n "position: 'asc'" backend/src/services/kanban/board.service.ts backend/src/routes/sharing.ts`), così nessun sito resta indietro:

| File:riga | Cosa ordina | Azione |
|---|---|---|
| `board.service.ts:172` | **card** della board (`getBoard`) | `[{ position: 'asc' }, { createdAt: 'asc' }]` |
| `routes/sharing.ts:340` | **card** delle board condivise (`GET /sharing/kanbans/accepted`, usata dal sync) | `[{ position: 'asc' }, { createdAt: 'asc' }]` |
| `board.service.ts:168` | colonne (`getBoard`) | `[{ position: 'asc' }, { id: 'asc' }]` |
| `board.service.ts:135` | colonne (`createBoard`, dentro l'`include` della create) | `[{ position: 'asc' }, { id: 'asc' }]` |
| `board.service.ts:150` | colonne (auto-complete dell'ultima colonna in `getBoard`) | `[{ position: 'asc' }, { id: 'asc' }]` |
| `board.service.ts:331` | colonne (`createBoardFromTaskList`) | `[{ position: 'asc' }, { id: 'asc' }]` |
| `routes/sharing.ts:337` | colonne (board condivise) | `[{ position: 'asc' }, { id: 'asc' }]` |
| `board.service.ts:282` | `TaskItem` di una task list — **non** card kanban | lasciare invariato |
| `card.service.ts:357`, `:414`, `:475` | ordinano per `createdAt`/`archivedAt`/`updatedAt`, non per `position` | lasciare invariato |

Il tiebreaker delle **colonne** è `id`, non `createdAt`: il model `KanbanColumn` in `backend/prisma/schema.prisma` (righe 486-496) ha solo `id`, `title`, `position`, `isCompleted`, `boardId` — né `createdAt` né `updatedAt` (lo conferma anche `makeKanbanColumn` in `backend/src/__tests__/factories.ts:155-164`, che non li produce). `id` è un uuid: arbitrario ma stabile, che è tutto quello che serve.

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

- [ ] **Step 1 — Aggiungere il test sull'`orderBy` di `getBoard` (fallisce)**

In `backend/src/services/kanban/__tests__/board.service.test.ts`, dentro `describe('getBoard')`, subito dopo il primo `it` (che chiude alla riga 221) e prima di `it('throws NotFoundError when board does not exist')`, inserire:

```ts
    it('orders cards and columns with a deterministic tiebreaker', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id });
      const column = makeKanbanColumn({ boardId: board.id });

      m(prisma.kanbanColumn.findMany).mockResolvedValue([
        { id: column.id, isCompleted: true } as any,
      ]);
      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        ...board,
        noteId: null,
        taskListId: null,
        columns: [],
        shares: [],
        owner: { id: user.id, name: user.name, email: user.email, color: user.color, avatarUrl: user.avatarUrl },
        note: null,
        taskList: null,
      } as any);
      m(prisma.kanbanCard.count).mockResolvedValue(0);

      await getBoard(board.id);

      const arg = m(prisma.kanbanBoard.findUnique).mock.calls[0][0] as any;
      // Two cards can share a position (legacy rows written by the old moveCard),
      // and a plain ORDER BY position then leaves their order to the planner.
      expect(arg.include.columns.include.cards.orderBy).toEqual([
        { position: 'asc' },
        { createdAt: 'asc' },
      ]);
      // KanbanColumn has no createdAt in schema.prisma — id is the stable tiebreaker.
      expect(arg.include.columns.orderBy).toEqual([{ position: 'asc' }, { id: 'asc' }]);
    });
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts -t "deterministic tiebreaker"`
Atteso: FAIL — `AssertionError: expected { position: 'asc' } to deeply equal [ { position: 'asc' }, …(1) ]`, poi `Tests  1 failed | 17 skipped (18)`.

- [ ] **Step 3 — Applicare il tiebreaker in `board.service.ts`**

Sostituire le righe 165-177 di `backend/src/services/kanban/board.service.ts` (il blocco `const board = await prisma.kanbanBoard.findUnique({ ... columns: { ... } },`) con:

```ts
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    include: {
      columns: {
        // KanbanColumn has no createdAt (see schema.prisma): id is the stable
        // tiebreaker so the same board never renders in two different orders.
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: {
          cards: {
            where: { archivedAt: null },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            select: cardWithAssigneeSelect,
          },
        },
      },
```

Poi la riga 135 (dentro l'`include` di `createBoard`), che è:

```ts
        columns: { orderBy: { position: 'asc' } },
```

diventa:

```ts
        columns: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
```

la riga 150 (dentro il `prisma.kanbanColumn.findMany` dell'auto-complete in `getBoard`), che è:

```ts
      orderBy: { position: 'asc' },
```

diventa:

```ts
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
```

e la riga 331 (dentro l'`include` di `createBoardFromTaskList`), che è:

```ts
        columns: { orderBy: { position: 'asc' } },
```

diventa:

```ts
        columns: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
```

> Attenzione: dopo la sostituzione del blocco `getBoard` (che aggiunge 2 righe di commento) i numeri 331 slittano a 333. Fare le sostituzioni dal basso verso l'alto, oppure identificare i blocchi dal testo invece che dal numero.

- [ ] **Step 4 — Applicare il tiebreaker in `routes/sharing.ts`**

Sostituire le righe 336-347 di `backend/src/routes/sharing.ts` (dentro `fastify.get('/kanbans/accepted', ...)`) con:

```ts
            columns: {
              orderBy: [{ position: 'asc' }, { id: 'asc' }],
              include: {
                cards: {
                  orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
                  include: {
                    assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
                    _count: { select: { comments: true } },
                  },
                },
              },
            },
```

- [ ] **Step 5 — Vedere il test passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` e `Tests  18 passed (18)`.

- [ ] **Step 6 — Verifica dei siti senza test**

`routes/sharing.ts` non ha test unitari sulla forma della query. Prova che nessun ordinamento di card/colonne kanban è rimasto senza tiebreaker:

Run: `cd backend && grep -rn "orderBy: { position: 'asc' }" src/services/kanban/ src/routes/sharing.ts | wc -l`
Atteso: `1`. L'unico hit residuo è la riga `items: { orderBy: { position: 'asc' } },` in `createBoardFromTaskList` (ordina i `TaskItem` di una task list, non card kanban). Qualsiasi conteggio > 1 significa un sito dimenticato — rilanciare senza `| wc -l` per vederlo.

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 7 — Commit**

```bash
git add backend/src/services/kanban/board.service.ts backend/src/routes/sharing.ts backend/src/services/kanban/__tests__/board.service.test.ts
git commit -m "fix(kanban): deterministic tiebreaker on every card and column ordering"
```

---

### Task 2.4: Eliminare il sentinella `999`

**Perché:** Spostando una card in un'altra colonna dal menu (o con la selezione multipla), il client manda `position: 999` e il server scriveva letteralmente 999 nel DB. La card resta appesa a un indice fuori scala, e ogni riordino successivo di quella colonna parte da uno stato che non è una permutazione contigua.
**Severità:** high · **Effort:** S · **Rischio:** none

**File:**
- Modifica: `frontend/src/features/kanban/hooks/useBoardDnD.ts:268-300`
- Modifica: `frontend/src/features/kanban/KanbanBoardPage.tsx:356-365`
- Crea: `frontend/src/features/kanban/hooks/__tests__/useBoardDnD.test.ts`

**I due (soli) call site di `999`**, da `grep -rn "999" frontend/src --include=*.ts --include=*.tsx` (gli altri 4 hit sono classi Tailwind `z-[9999]` in `EditorContextMenu.tsx`, `TableContextMenu.tsx`, `TagSelector.tsx`, `LoadingOverlay.tsx`, non correlati):

1. `frontend/src/features/kanban/hooks/useBoardDnD.ts:295` — dentro `handleMoveCardToColumn`, usata da **quattro** punti: `KanbanBoardPage.tsx:358` (bulk move), `:881` e `:923` (menu contestuale della card, desktop), `:1029` (menu mobile). Sistemandola nell'hook si sistemano tutti e quattro.
2. `frontend/src/features/kanban/KanbanBoardPage.tsx:363` — la chiamata REST diretta `PUT /kanban/cards/:id/move?silent=true` dentro `handleBulkMove`, che bypassa l'hook.

**Interfacce:**
- Consuma: nessuna (dipende solo dal fatto che 2.2 sia atterrato: prima, il server ignorava comunque l'indice giusto)
- Produce: `handleMoveCardToColumn(cardId: string, targetColumnId: string): void` — firma invariata, ora invia l'indice reale di append

- [ ] **Step 1 — Scrivere il test dell'hook (fallisce)**

Crea `frontend/src/features/kanban/hooks/__tests__/useBoardDnD.test.ts` (la cartella `__tests__/` esiste già, contiene `useKanbanRealtime.test.tsx`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardDnD } from '../useBoardDnD';
import type { KanbanBoard } from '../../types';

/** Minimal board shape: the hook only reads columns[].id / .position / .cards. */
function makeBoard(): KanbanBoard {
  return {
    id: 'board-1',
    columns: [
      {
        id: 'col-a',
        position: 0,
        cards: [
          { id: 'c1', position: 0 },
          { id: 'c2', position: 1 },
        ],
      },
      { id: 'col-b', position: 1, cards: [{ id: 'c3', position: 0 }] },
      { id: 'col-empty', position: 2, cards: [] },
    ],
  } as unknown as KanbanBoard;
}

describe('useBoardDnD.handleMoveCardToColumn', () => {
  function setup() {
    const moveCardMutate = vi.fn();
    const mutations = {
      moveCard: { mutate: moveCardMutate },
      reorderColumns: { mutate: vi.fn() },
    };
    // The board object MUST be built outside the render callback: the hook has a
    // useEffect keyed on board.columns that calls setLocalColumns, so a fresh
    // object per render is an infinite update loop.
    const board = makeBoard();
    const { result } = renderHook(() =>
      useBoardDnD({ board, boardId: 'board-1', mutations }),
    );
    return { result, moveCardMutate };
  }

  it('sends the append index of the target column, not a 999 sentinel', () => {
    const { result, moveCardMutate } = setup();

    act(() => {
      result.current.handleMoveCardToColumn('c1', 'col-b');
    });

    // col-b already holds one card → the card lands at index 1.
    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-b',
      position: 1,
    });
  });

  it('sends index 0 when the target column is empty', () => {
    const { result, moveCardMutate } = setup();

    act(() => {
      result.current.handleMoveCardToColumn('c1', 'col-empty');
    });

    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-empty',
      position: 0,
    });
  });

  it('does not count the moved card twice when it already sits in the target column', () => {
    const { result, moveCardMutate } = setup();

    act(() => {
      result.current.handleMoveCardToColumn('c1', 'col-a');
    });

    // col-a holds c1 and c2; without c1 that is one card → append at index 1.
    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-a',
      position: 1,
    });
  });
});
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useBoardDnD.test.ts`
Atteso: FAIL — `Tests  3 failed (3)`, ognuno con `AssertionError: expected { cardId: 'c1', …(2) } to deeply equal { cardId: 'c1', …(2) }` e nel diff `- "position": 1` / `+ "position": 999` (rispettivamente `1`, `0`, `1` attesi contro `999` ricevuto).

- [ ] **Step 3 — Sostituire `handleMoveCardToColumn`**

Rimpiazzare integralmente le righe 268-300 di `frontend/src/features/kanban/hooks/useBoardDnD.ts` con:

```ts
  // Move card to a different column via menu (mobile & desktop)
  const handleMoveCardToColumn = useCallback(
    (cardId: string, targetColumnId: string) => {
      // [BACKUP] 2026-08-31 — previously sent `position: 999` as an "append"
      // sentinel. The server took it literally and wrote 999 into the row, so
      // the column stopped being a contiguous 0..n-1 range. Send the real
      // append index instead, computed BEFORE the optimistic state update.
      const targetColumn = localColumns.find((c) => c.id === targetColumnId);
      const appendIndex = targetColumn
        ? targetColumn.cards.filter((c) => c.id !== cardId).length
        : 0;

      // Optimistic: move card in localColumns immediately
      setLocalColumns((prev) => {
        let movedCard: KanbanCard | undefined;
        const updated = prev.map((col) => {
          const cardIdx = col.cards.findIndex((c) => c.id === cardId);
          if (cardIdx >= 0) {
            movedCard = col.cards[cardIdx];
            return { ...col, cards: col.cards.filter((c) => c.id !== cardId) };
          }
          return col;
        });
        if (!movedCard) return prev;
        return updated.map((col) => {
          if (col.id === targetColumnId) {
            const newPosition = col.cards.length;
            return { ...col, cards: [...col.cards, { ...movedCard!, position: newPosition }] };
          }
          return col;
        });
      });

      // Persist to backend
      setIsMoveInFlight(true);
      mutations.moveCard.mutate(
        { cardId, toColumnId: targetColumnId, position: appendIndex },
        { onSettled: () => setIsMoveInFlight(false) },
      );
    },
    [localColumns, mutations.moveCard],
  );
```

- [ ] **Step 4 — Sostituire il sentinella nel bulk move**

In `frontend/src/features/kanban/KanbanBoardPage.tsx`, rimpiazzare le righe 356-365 — il blocco che comincia con `// Optimistic UI + silent REST calls (bypass sync queue notifications)` e finisce con il `}` del secondo `for (const move of moves)` — con:

```ts
    // Optimistic UI + silent REST calls (bypass sync queue notifications).
    // The requests are fired in parallel, so each card gets its own append
    // index: sending 999 for all of them made the server pile every card onto
    // the same out-of-range position.
    const targetColumn = board.columns.find(c => c.id === targetColumnId);
    const appendBase = targetColumn ? targetColumn.cards.length : 0;

    for (const move of moves) {
      dnd.handleMoveCardToColumn(move.cardId, move.toColumnId);
    }
    moves.forEach((move, i) => {
      api.put(`/kanban/cards/${move.cardId}/move?silent=true`, {
        toColumnId: move.toColumnId,
        position: appendBase + i,
      }).catch(() => {});
    });
```

> `moves` contiene solo card che stanno in **altre** colonne (filtro `col.id !== targetColumnId` alla riga 346), quindi `targetColumn.cards.length` è già l'indice di append corretto. Le richieste partono in parallelo: se il server le processa fuori ordine l'ordine finale fra queste card può differire, ma resta comunque contiguo e senza duplicati — è `computeColumnOrder` a garantirlo, non l'ordine di arrivo. L'array di dipendenze di `handleBulkMove` (`[marquee, board, dnd]`) resta corretto: `board.columns` è già coperto da `board`.

- [ ] **Step 5 — Vedere il test passare**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useBoardDnD.test.ts`
Atteso: PASS — `Test Files  1 passed (1)` e `Tests  3 passed (3)`.

- [ ] **Step 6 — Verifica: il sentinella non esiste più**

Il percorso bulk di `KanbanBoardPage` non è coperto da unit test (richiederebbe il render dell'intera pagina con react-query, DnD e router). Provalo per grep:

Run: `cd frontend && grep -rn "position: 999" src/`
Atteso: **nessun output**, exit code 1.

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Atteso: nessun output da `tsc`; da `lint` la riga finale `✖ N problems (0 errors, N warnings)` — zero `error` (i 52 warning preesistenti, per lo più `react-hooks/set-state-in-effect` e `no-unused-vars`, restano).

Verifica manuale del bulk: aprire una board, selezionare 3 card con la marquee selection in una colonna, spostarle in un'altra colonna dal menu, aprire il tab Network di DevTools e controllare le tre `PUT /api/kanban/cards/<id>/move?silent=true` — i body devono avere `position` consecutive (es. 2, 3, 4), mai 999.

- [ ] **Step 7 — Commit**

```bash
git add frontend/src/features/kanban/hooks/useBoardDnD.ts frontend/src/features/kanban/KanbanBoardPage.tsx frontend/src/features/kanban/hooks/__tests__/useBoardDnD.test.ts
git commit -m "fix(kanban): send the real append index instead of the 999 position sentinel"
```

---

### Task 2.5: Rispecchiare insert-and-shift nella scrittura Dexie

**Perché:** `kanbanService.moveCard` scrive solo la card spostata in IndexedDB e lascia i fratelli fermi: offline (o nella finestra fra il drag e il prossimo `syncPull`) la colonna locale mostra due card sulla stessa `position`, quindi in ordine arbitrario — esattamente il bug che 2.2 ha appena tolto dal server, ma sul mirror locale.
**Severità:** high · **Effort:** S · **Rischio:** none — `kanbanService.ts` non è TIER 1, e né `frontend/src/lib/db.ts` né `frontend/src/features/sync/syncService.ts` vengono toccati (nessuna nuova versione Dexie, nessun campo nuovo). È comunque una scrittura su dati utente: un commit solo per questa modifica.

**File:**
- Crea: `frontend/src/features/kanban/position.ts`
- Crea: `frontend/src/features/kanban/__tests__/position.test.ts`
- Modifica: `frontend/src/features/kanban/kanbanService.ts:5` (import) e `frontend/src/features/kanban/kanbanService.ts:372-385` (`moveCard`)
- Modifica: `frontend/src/features/kanban/__tests__/kanbanService.test.ts:50` (import) e coda del file (dopo la riga 149)

**Sulla duplicazione — decisione, non svista.** Il frontend **non può** importare da `backend/`: sono due workspace npm separati (alla root del repo **non esiste** un `package.json`, quindi nessun `workspaces`), `frontend/tsconfig.app.json` ha `"include": ["src"]` e nessun `paths` verso l'esterno, e l'unico alias in `frontend/vite.config.ts` è `@ → frontend/src`. Le opzioni erano: (a) creare un package condiviso `shared/` — un nuovo workspace, un build step, una entry in due tsconfig, due `package.json` e un vincolo di versione per **10 righe senza dipendenze**; (b) copiare le 10 righe e la tabella di test. Si copia. La funzione è pura, ha zero dipendenze e la sua tabella di test la blocca da entrambi i lati: se qualcuno cambia un comportamento su un lato, la tabella dell'altro lato resta a documentare la divergenza. Un package condiviso qui costa più manutenzione di quanta ne risparmi.

**Interfacce:**
- Consuma: `computeColumnOrder(cardIds: string[], cardId: string, newIndex: number): string[]` — copia locale, stessa firma di Task 2.1
- Produce: `moveCard(cardId: string, toColumnId: string, position: number): Promise<void>` — firma invariata; il payload in `syncQueue` resta `{ columnId, position }` con la position **richiesta dal chiamante**

- [ ] **Step 1 — Copiare la funzione e la sua tabella di test (il test fallisce: il modulo non esiste)**

Crea `frontend/src/features/kanban/position.ts`:

```ts
/**
 * Pure ordering helper for a kanban column.
 *
 * DUPLICATE of backend/src/services/kanban/position.ts. frontend/ and backend/
 * are separate npm workspaces with no shared package and no cross-workspace
 * tsconfig path, so these ten dependency-free lines are copied rather than
 * extracted: a shared workspace would cost a build step and a version
 * constraint for less code than it carries. The table test in
 * __tests__/position.test.ts is copied along with it — if one side ever
 * changes, the other side's table still documents the divergence.
 *
 * Given the current order of a column (card ids, position-ascending) it returns
 * the order after `cardId` has been placed at `newIndex`. The card is removed
 * first and re-inserted — exactly what @dnd-kit's `arrayMove` does — so client
 * and server agree on what "index 2" means.
 *
 * The returned array IS the new position mapping: index i → position i.
 */
export function computeColumnOrder(
  cardIds: string[],
  cardId: string,
  newIndex: number
): string[] {
  const rest = cardIds.filter((id) => id !== cardId);
  const index = Math.min(Math.max(newIndex, 0), rest.length);
  rest.splice(index, 0, cardId);
  return rest;
}
```

Crea `frontend/src/features/kanban/__tests__/position.test.ts` (stessa tabella del backend, verbatim):

```ts
import { describe, it, expect } from 'vitest';
import { computeColumnOrder } from '../position';

// Same table as backend/src/services/kanban/__tests__/position.test.ts.
// The two copies of computeColumnOrder must behave identically: the Dexie
// mirror and the database have to agree on what "index 2" means.
describe('computeColumnOrder', () => {
  const cases: {
    name: string;
    cardIds: string[];
    cardId: string;
    newIndex: number;
    expected: string[];
  }[] = [
    {
      name: 'moves a card down',
      cardIds: ['a', 'b', 'c', 'd'],
      cardId: 'a',
      newIndex: 2,
      expected: ['b', 'c', 'a', 'd'],
    },
    {
      name: 'moves a card up',
      cardIds: ['a', 'b', 'c', 'd'],
      cardId: 'd',
      newIndex: 1,
      expected: ['a', 'd', 'b', 'c'],
    },
    {
      name: 'moves a card to the first index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'c',
      newIndex: 0,
      expected: ['c', 'a', 'b'],
    },
    {
      name: 'moves a card to the last index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'a',
      newIndex: 2,
      expected: ['b', 'c', 'a'],
    },
    {
      name: 'is a no-op when the card is already at that index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'b',
      newIndex: 1,
      expected: ['a', 'b', 'c'],
    },
    {
      name: 'inserts a card coming from another column',
      cardIds: ['x', 'y'],
      cardId: 'new',
      newIndex: 1,
      expected: ['x', 'new', 'y'],
    },
    {
      name: 'clamps an index past the end (the 999 sentinel) to an append',
      cardIds: ['a', 'b'],
      cardId: 'a',
      newIndex: 999,
      expected: ['b', 'a'],
    },
    {
      name: 'appends a foreign card when the index is past the end',
      cardIds: ['x', 'y'],
      cardId: 'z',
      newIndex: 999,
      expected: ['x', 'y', 'z'],
    },
    {
      name: 'clamps a negative index to the front',
      cardIds: ['a', 'b'],
      cardId: 'b',
      newIndex: -3,
      expected: ['b', 'a'],
    },
    {
      name: 'inserts into an empty column',
      cardIds: [],
      cardId: 'only',
      newIndex: 4,
      expected: ['only'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(computeColumnOrder(c.cardIds, c.cardId, c.newIndex)).toEqual(c.expected);
    });
  }

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    computeColumnOrder(input, 'a', 2);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2 — Scrivere i test del mirror Dexie**

In `frontend/src/features/kanban/__tests__/kanbanService.test.ts`, sostituire la riga 50:

```ts
import { deleteCard, createCard, splitTextForCard, CARD_TITLE_MAX, CARD_DESCRIPTION_MAX } from '../kanbanService';
```

con:

```ts
import { deleteCard, createCard, moveCard, splitTextForCard, CARD_TITLE_MAX, CARD_DESCRIPTION_MAX } from '../kanbanService';
```

e aggiungere in coda al file (dopo la riga 149, la chiusura di `describe('kanbanService.deleteCard')`):

```ts

describe('kanbanService.moveCard', () => {
  type StoredCard = { id: string; columnId: string; position: number; createdAt: string };
  type UpdateCall = [string, { position?: number; columnId?: string }];

  const iso = (n: number) => new Date(1700000000000 + n).toISOString();
  let cardsByColumn: Record<string, StoredCard[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    cardsByColumn = {};
    // where('columnId').equals(id).toArray(), routed per column id.
    // NOTE: mockImplementation survives vi.clearAllMocks(), so this block stays
    // last in the file; unknown columns resolve to [] and stay harmless.
    mockDb.kanbanCards.where.mockImplementation((field: string) => ({
      equals: (value: string) => ({
        toArray: async () => (field === 'columnId' ? cardsByColumn[value] ?? [] : []),
      }),
    }));
  });

  function positionWrites() {
    return (mockDb.kanbanCards.update.mock.calls as UpdateCall[]).map(([id, patch]) => ({
      id,
      position: patch.position,
    }));
  }

  it('shifts the siblings instead of stacking two cards on the same position', async () => {
    cardsByColumn['col-1'] = [
      { id: 'A', columnId: 'col-1', position: 0, createdAt: iso(1) },
      { id: 'B', columnId: 'col-1', position: 1, createdAt: iso(2) },
      { id: 'C', columnId: 'col-1', position: 2, createdAt: iso(3) },
      { id: 'D', columnId: 'col-1', position: 3, createdAt: iso(4) },
    ];
    mockDb.kanbanCards.get.mockResolvedValue(cardsByColumn['col-1'][0]);

    await moveCard('A', 'col-1', 2);

    const writes = positionWrites();
    expect(writes).toEqual([
      { id: 'B', position: 0 },
      { id: 'C', position: 1 },
      { id: 'A', position: 2 },
    ]);
    // D never moves: rewriting it would bump updatedAt for nothing.
    expect(writes.map((w) => w.id)).not.toContain('D');
  });

  it('closes the hole in the source column on a cross-column move', async () => {
    cardsByColumn['col-src'] = [
      { id: 'S0', columnId: 'col-src', position: 0, createdAt: iso(1) },
      { id: 'M', columnId: 'col-src', position: 1, createdAt: iso(2) },
      { id: 'S2', columnId: 'col-src', position: 2, createdAt: iso(3) },
    ];
    cardsByColumn['col-dst'] = [{ id: 'X', columnId: 'col-dst', position: 0, createdAt: iso(4) }];
    mockDb.kanbanCards.get.mockResolvedValue(cardsByColumn['col-src'][1]);

    await moveCard('M', 'col-dst', 0);

    expect(positionWrites()).toEqual([
      { id: 'S2', position: 1 }, // source: 2 -> 1, closes the hole M left behind
      { id: 'X', position: 1 },  // target: 0 -> 1, makes room at the top
      { id: 'M', position: 0 },  // the moved card lands at index 0
    ]);
  });

  it('sends the position the caller asked for to the sync queue, not the local one', async () => {
    // Dexie hydration is best-effort: the local column can be empty while the
    // server column is full. The queue must carry the user's intent — the
    // server clamps it itself (moveCard in backend/src/services/kanban/card.service.ts).
    mockDb.kanbanCards.get.mockResolvedValue(undefined);

    await moveCard('ghost', 'col-9', 7);

    expect(mockDb.syncQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'UPDATE',
        entity: 'KANBAN_CARD',
        entityId: 'ghost',
        data: { columnId: 'col-9', position: 7 },
      }),
    );
  });
});
```

- [ ] **Step 3 — Vedere i test fallire**

Run: `cd frontend && npx vitest run src/features/kanban/__tests__/position.test.ts src/features/kanban/__tests__/kanbanService.test.ts`
Atteso: FAIL —
- per `position.test.ts`: `Error: Cannot find module '../position' imported from 'D:/Develop/AI/Notiq/frontend/src/features/kanban/__tests__/position.test.ts'`;
- per `kanbanService.test.ts`: `Tests  2 failed | 9 passed (11)` con
  `AssertionError: expected [ { id: 'A', position: 2 } ] to deeply equal [ { id: 'B', position: +0 }, …(2) ]` e
  `AssertionError: expected [ { id: 'M', position: +0 } ] to deeply equal [ { id: 'S2', position: 1 }, …(2) ]`.
  (Il terzo test passa già: il payload della queue non cambia.)

- [ ] **Step 4 — Riscrivere `moveCard` in `kanbanService.ts`**

Aggiungere l'import in cima a `frontend/src/features/kanban/kanbanService.ts`, subito dopo la riga 5 (`import api from '../../lib/api';`):

```ts
import { computeColumnOrder } from './position';
```

Poi rimpiazzare integralmente le righe 372-385 con:

```ts
/** Sibling ordering, identical to the server's [{position asc}, {createdAt asc}]. */
function byPosition(a: LocalKanbanCard, b: LocalKanbanCard): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

export async function moveCard(cardId: string, toColumnId: string, position: number): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  // [BACKUP] 2026-08-31 — previously this wrote ONLY the moved card:
  //   await db.kanbanCards.update(cardId, { columnId: toColumnId, position, ... });
  // The siblings kept their old positions, so offline (and between the drag and
  // the next syncPull) two cards shared a position and the column rendered in
  // arbitrary order. Mirror the server's insert-and-shift instead.
  await db.transaction('rw', db.kanbanCards, db.syncQueue, async () => {
    const card = await db.kanbanCards.get(cardId);

    // Source column: close the hole the card leaves behind.
    if (card && card.columnId !== toColumnId) {
      const source = (await db.kanbanCards.where('columnId').equals(card.columnId).toArray())
        .filter((c) => c.id !== cardId)
        .sort(byPosition);
      for (let i = 0; i < source.length; i++) {
        if (source[i].position === i) continue;
        await db.kanbanCards.update(source[i].id, { position: i });
      }
    }

    // Target column: insert-and-shift, exactly like moveCard in
    // backend/src/services/kanban/card.service.ts.
    const target = (await db.kanbanCards.where('columnId').equals(toColumnId).toArray()).sort(byPosition);
    const order = computeColumnOrder(target.map((c) => c.id), cardId, position);
    // The explicit <string, number> generic is required: without it TS types the
    // .map() result as (string | number)[][] and the Map constructor rejects it.
    const currentPosition = new Map<string, number>(target.map((c) => [c.id, c.position]));

    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      if (id === cardId) continue; // the moved card is written last, with its sync flags
      if (currentPosition.get(id) === i) continue; // unchanged sibling: leave it alone
      await db.kanbanCards.update(id, { position: i });
    }

    // Always written, even when the card is not cached locally (Dexie update on
    // a missing key is a no-op) — same contract as deleteCard.
    await db.kanbanCards.update(cardId, {
      columnId: toColumnId,
      position: order.indexOf(cardId),
      updatedAt: now,
      syncStatus: 'updated',
    });

    // The queue carries the position the USER asked for, NOT the locally
    // computed one: Dexie hydration is best-effort, so the local column can be
    // empty while the server column is full — clamping here would send 0 for a
    // drop meant for index 3. The server resequences with its own data.
    await db.syncQueue.add({
      type: 'UPDATE',
      entity: 'KANBAN_CARD',
      entityId: cardId,
      userId,
      data: { columnId: toColumnId, position },
      createdAt: Date.now(),
    });
  });
}
```

> `LocalKanbanCard` è già importato come type alla riga 3 di `kanbanService.ts`, e `kanbanCards` è indicizzato su `columnId` (`frontend/src/lib/db.ts:255`, versione 14): la `where('columnId')` usa l'indice esistente, nessuna nuova versione Dexie serve.

- [ ] **Step 5 — Vedere i test passare**

Run: `cd frontend && npx vitest run src/features/kanban/__tests__/position.test.ts src/features/kanban/__tests__/kanbanService.test.ts`
Atteso: PASS — `Test Files  2 passed (2)` e `Tests  22 passed (22)` (11 della tabella + 11 di kanbanService: 8 preesistenti + 3 nuovi).

- [ ] **Step 6 — Typecheck e lint**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Atteso: nessun output da `tsc`; da `lint` la riga finale `✖ N problems (0 errors, N warnings)` — zero `error`.

- [ ] **Step 7 — Commit**

```bash
git add frontend/src/features/kanban/position.ts frontend/src/features/kanban/__tests__/position.test.ts frontend/src/features/kanban/kanbanService.ts frontend/src/features/kanban/__tests__/kanbanService.test.ts
git commit -m "fix(kanban): mirror insert-and-shift in the Dexie moveCard write"
```

---

### Task 2.6: Atomizzare `aggregate` + `create` in `createCard` e `createColumn`

**Perché:** Entrambe leggono la `position` massima e poi creano la riga con `max + 1` fuori da qualsiasi transazione. Due creazioni concorrenti sulla stessa colonna (due utenti su una board condivisa, o un batch di conversione da task list) leggono lo stesso max e atterrano sulla stessa `position` — la stessa collisione che 2.2 ha appena tolto da `moveCard`, per un'altra strada.
**Severità:** low · **Effort:** S · **Rischio:** none

**File:**
- Modifica: `backend/src/services/kanban/card.service.ts:23-32`
- Modifica: `backend/src/services/kanban/column.service.ts:7-20`
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts` (dentro `describe('createCard')`, che chiude alla riga 253)
- Modifica: `backend/src/services/kanban/__tests__/column.service.test.ts` (dentro `describe('createColumn')`, che chiude alla riga 78)

**Interfacce:**
- Consuma: nessuna
- Produce: `createCard(columnId, title, description?, actorId?, id?)` e `createColumn(boardId, title, id?)` — firme invariate

- [ ] **Step 1 — Aggiungere i due test (falliscono)**

In `backend/src/services/kanban/__tests__/card.service.test.ts`, dentro `describe('createCard')`, dopo la chiusura dell'ultimo `it` (`broadcasts card:created event`, riga 252) e prima della chiusura del `describe` alla riga 253:

```ts

  it('computes the max position and creates the card inside one transaction', async () => {
    prismaMock.kanbanColumn.findUnique.mockResolvedValue({
      boardId: board.id,
      title: column.title,
    });
    prismaMock.kanbanCard.aggregate.mockResolvedValue({ _max: { position: 3 } });
    prismaMock.kanbanCard.create.mockResolvedValue({
      id: 'card-tx',
      title: 'Tx Card',
      description: null,
      position: 4,
      columnId: column.id,
      assigneeId: null,
      dueDate: null,
      priority: null,
      noteId: null,
      noteLinkedById: null,
      archivedAt: null,
      taskItemId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignee: null,
      note: null,
      _count: { comments: 0 },
    });

    await createCard(column.id, 'Tx Card');

    // read-then-write outside a transaction lets two concurrent creates read
    // the same max and land on the same position.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.kanbanCard.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 4 }) }),
    );
  });
```

In `backend/src/services/kanban/__tests__/column.service.test.ts`, dentro `describe('createColumn')`, come ultimo `it` (dopo `sets position to 0 when board has no columns`, che chiude alla riga 77):

```ts

  it('computes the max position and creates the column inside one transaction', async () => {
    const board = makeKanbanBoard();
    prismaMock.kanbanColumn.aggregate.mockResolvedValue({ _max: { position: 1 } });
    prismaMock.kanbanColumn.create.mockResolvedValue(makeKanbanColumn({ boardId: board.id, position: 2 }));

    await createColumn(board.id, 'Review');

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.kanbanColumn.create).toHaveBeenCalledWith({
      data: { boardId: board.id, title: 'Review', position: 2 },
    });
  });
```

> Entrambi i file hanno già tutto il necessario: `makeKanbanBoard`/`makeKanbanColumn` sono importati da `../../../__tests__/factories`, `prismaMock.kanbanCard.aggregate` è ricreato nel `beforeEach` globale di `card.service.test.ts` (righe 87-92) e `prismaMock.kanbanColumn.aggregate` in quello di `column.service.test.ts` (righe 21-40), che re-stubba anche `$transaction`.

- [ ] **Step 2 — Vedere i test fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts src/services/kanban/__tests__/column.service.test.ts -t "inside one transaction"`
Atteso: FAIL — `Tests  2 failed | 41 skipped (43)`, entrambi con `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times`.

- [ ] **Step 3 — Avvolgere `createCard`**

Sostituire le righe 23-32 di `backend/src/services/kanban/card.service.ts` con:

```ts
  // aggregate + create in ONE transaction: a read-then-write split across two
  // round trips lets two concurrent creates read the same max and write the
  // same position.
  // NOTE: this makes the pair atomic, not serialized — at PostgreSQL's default
  // READ COMMITTED two transactions can still read the same max. Upgrade path
  // if it ever bites in production: @@unique([columnId, position]) on
  // KanbanCard plus a retry, or isolationLevel: 'Serializable'.
  const card = await prisma.$transaction(async (tx) => {
    const maxPos = await tx.kanbanCard.aggregate({
      where: { columnId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    return tx.kanbanCard.create({
      data: { ...(id ? { id } : {}), columnId, title, description, position },
      select: cardWithAssigneeSelect,
    });
  });
```

- [ ] **Step 4 — Avvolgere `createColumn`**

Sostituire le righe 7-20 di `backend/src/services/kanban/column.service.ts` con:

```ts
export async function createColumn(boardId: string, title: string, id?: string) {
  // aggregate + create in ONE transaction — see createCard in card.service.ts
  // for the isolation-level caveat.
  const column = await prisma.$transaction(async (tx) => {
    const maxPos = await tx.kanbanColumn.aggregate({
      where: { boardId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    return tx.kanbanColumn.create({
      data: { ...(id ? { id } : {}), boardId, title, position },
    });
  });

  broadcast(boardId, { type: 'column:created', boardId, column });
  return column;
}
```

- [ ] **Step 5 — Vedere tutta la suite kanban passare**

Run: `cd backend && npx vitest run src/services/kanban`
Atteso: PASS — `Test Files  6 passed (6)`, `Tests  132 passed (132)` (115 di baseline + 11 di `position.test.ts` + 3 di 2.2 + 1 di 2.3 + 2 di questo task). Per file: `position.test.ts` 11, `column.service.test.ts` 10, `linking.service.test.ts` 39, `card.service.test.ts` 33, `board.service.test.ts` 18, `comments-chat.service.test.ts` 21.

- [ ] **Step 6 — Typecheck e lint backend**

Run: `cd backend && npx tsc --noEmit && npm run lint`
Atteso: nessun output da `tsc`; da `lint` la riga finale `✖ N problems (0 errors, N warnings)` — zero `error` (i 63 warning preesistenti restano).

- [ ] **Step 7 — Commit**

```bash
git add backend/src/services/kanban/card.service.ts backend/src/services/kanban/column.service.ts backend/src/services/kanban/__tests__/card.service.test.ts backend/src/services/kanban/__tests__/column.service.test.ts
git commit -m "fix(kanban): create card and column position atomically"
```

- [ ] **Step 8 — Verifica end-to-end dello stage (manuale, dopo tutti i commit)**

Gli E2E Playwright non coprono il drag-and-drop (`frontend/e2e/kanban.spec.ts` ha 6 test: navigazione, crea board, colonne di default, aggiungi card, aggiungi colonna, elimina board), quindi la regressione va provata a mano una volta:

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts`
Atteso: PASS — `6 passed`. Serve a provare che nulla di preesistente è rotto, non a coprire il fix.

Poi, con `backend` e `frontend` in dev (e i container Docker fermi, altrimenti il backend su :3001 intercetta il proxy Vite): creare una colonna con 4 card, trascinare la prima in terza posizione, ricaricare la pagina. L'ordine deve restare quello lasciato. Infine, contro il DB di sviluppo (container `notiq-db`, porta 5433) — la connection string va letta da `backend/.env`, non inventata:

```bash
cd backend && psql "$(grep '^DATABASE_URL=' .env | cut -d'"' -f2)" -c 'SELECT "columnId", position, count(*) FROM "KanbanCard" WHERE "archivedAt" IS NULL GROUP BY 1,2 HAVING count(*) > 1;'
```

Atteso: `(0 rows)` — nessuna coppia (colonna, position) duplicata.

---

The draft is verified against the real code. Every line number, API, test-mock shape, and expected output below was checked by opening the file or by actually running the change and capturing the output.

## Stage 3 — Sync e offline (TIER 1)

`frontend/src/features/sync/syncService.ts` è un file TIER 1: un errore qui non rompe una schermata, perde dati dell'utente. Questo stage tocca quel file in sei task su sette, più `db.ts` (solo l'interfaccia TypeScript, senza bump di versione) e due hook kanban. Prima di iniziare: Stage 1 e 2 devono essere mergiati, e a HEAD (`141e6af`) `cd frontend && npx vitest run` deve chiudere con **`Test Files  9 passed (9)` / `Tests  131 passed (131)`**, di cui `src/features/sync/__tests__/syncService.test.ts (45 tests)`. Il DB dev (`docker compose up notiq-db`, porta 5433) deve essere in piedi per gli e2e.

**Baseline verificati a HEAD — usali come metro di paragone, non fidarti della memoria:**

| Comando | Output a HEAD |
|---|---|
| `cd frontend && npx vitest run` | `Test Files  9 passed (9)` · `Tests  131 passed (131)` |
| `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts` | `Tests  45 passed (45)` |
| `cd frontend && npx tsc --noEmit` | nessun output, exit 0 |
| `cd frontend && npm run lint` | `✖ 52 problems (0 errors, 52 warnings)`, **exit 0** |

Le 52 warning di `eslint` sono preesistenti (regole `react-hooks/*` configurate a `warn` in `frontend/eslint.config.js`). **La soglia di questo stage è: zero errori e nessuna warning nuova.** Un task che introduce anche un solo `error` non si committa.

**Protocollo obbligatorio per questo stage — non negoziabile:**

1. **UN task = UN commit.** Mai raggruppare due task nello stesso commit, nemmeno 3.2 e 3.3 che toccano righe adiacenti. Se un task va in rollback, deve poter tornare indietro da solo. L'unica eccezione è dichiarata dentro il task 3.6, che per costruzione contiene due modifiche inseparabili.
2. Dopo **ogni** task, in quest'ordine: `cd frontend && npx vitest run` (suite completa, non solo il file toccato) → `npx tsc --noEmit` → `npm run lint` → lo spec Playwright indicato nel task. Solo dopo si committa.
3. Se la suite completa mostra un test rosso che il task non nomina esplicitamente, **fermarsi**: è una regressione, non un test da aggiornare.
4. **I numeri di riga in questo stage sono quelli del file a HEAD (commit `141e6af`).** Ogni task sposta le righe successive. Ancorarsi SEMPRE al blocco "PRIMA" citato nel task, mai al numero di riga.
5. Ordine dei task obbligatorio: **3.6 va dopo 3.1** (3.6 cancella uno dei due write site che 3.1 ha modificato), **3.5 va dopo 3.4** (3.5 consuma la firma di `syncPush` stabilita in 3.4). Gli altri sono indipendenti ma vanno committati nell'ordine dato, perché i test si accodano l'uno dopo l'altro dentro gli stessi `describe`.
6. Il conteggio atteso di `syncService.test.ts` cresce così, task per task: 45 (HEAD) → **46** (3.1) → **47** (3.2) → **48** (3.3) → **49** (3.4) → **50** (3.5) → **51** (3.6) → **52** (3.7).

---

### Task 3.1: Scope `useKanbanBoards` all'utente corrente e stampa `viewerId` in pull

**Perché:** Dexie è un unico IndexedDB per profilo browser e non viene ripulito al logout. Chi fa logout e login con un altro account sulla stessa macchina vede nella lista kanban le board del proprietario precedente, con i nomi e le email dei suoi collaboratori nel modale "condivisa con", e se prova a cancellarle riceve un banner di sync rosso permanente.
**Severità:** critical · **Effort:** M · **Rischio:** TIER 1 — tocca due write site di `syncPull` e l'interfaccia `LocalKanbanBoard` in `db.ts` (solo tipo TS, nessuno schema change, nessuna nuova versione Dexie).

**File:**
- Modifica: `frontend/src/lib/db.ts:103-120` (interfaccia `LocalKanbanBoard`; il campo va inserito dopo `permission?` a riga 116)
- Modifica: `frontend/src/features/kanban/hooks/useKanbanBoards.ts:1-16` (riscrittura integrale)
- Modifica: `frontend/src/features/sync/syncService.ts:295-316` e `:423-438`
- Crea: `frontend/src/features/kanban/hooks/__tests__/useKanbanBoards.test.tsx`
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` — aggiunta di un test dentro `describe('kanban boards', …)` (righe 526-591), subito dopo `pulls kanban boards and their details (columns + cards)` che finisce a riga 590

**Interfacce:**
- Consuma: nessuna
- Produce: `LocalKanbanBoard.viewerId?: string` — stampato da `syncPull` su ogni riga board che scrive; `useKanbanBoards(): { data: LocalKanbanBoard[] | undefined; isLoading: boolean }` (firma invariata, risultato filtrato)

**Vincolo da rispettare alla lettera: NIENTE bump di versione Dexie.** `viewerId` non è un indice. In IndexedDB lo store salva l'oggetto intero: solo le chiavi dichiarate in `.stores()` diventano indici, e `kanbanBoards` è dichiarato `'id, ownerId, updatedAt, syncStatus, ownership'` (`db.ts:253`). Aggiungere una proprietà non indicizzata non richiede una migration. **Non creare una v16** — `db.ts` resta a v15 (`this.version(15).stores({` è a riga 259).

**Conseguenza fail-closed da accettare consapevolmente:** le righe board già in Dexie prima del deploy non hanno `viewerId`. Per le board possedute non cambia nulla (il filtro accetta anche `ownerId === userId`, e `kanbanService.createBoard` a `frontend/src/features/kanban/kanbanService.ts:79` scrive proprio `ownerId: userId`), ma **le board condivise spariscono dalla lista finché il primo pull riuscito non le riscrive**. Un utente che apre l'app offline subito dopo l'aggiornamento vede la sezione kanban con le sole board proprie. È la degradazione accettabile: meglio una lista temporaneamente incompleta che la lista di un altro account.

**Sei finding di audit chiusi da questo solo task:**
1. Lista board non filtrata: `frontend/src/features/kanban/hooks/useKanbanBoards.ts:7` fa `db.kanbanBoards.orderBy('updatedAt').reverse().toArray()`, cioè una scansione integrale dello store.
2. Disclosure email in `SharedUsersModal`: `frontend/src/features/kanban/KanbanPage.tsx:46-54` mappa `viewSharesBoard.shares[].user.email` prendendo la board da `boards` (`KanbanPage.tsx:25`, `useKanbanBoards()`), quindi anche da board di un altro account.
3. `frontend/src/components/editor/TransformToKanbanModal.tsx:37` legge la stessa lista (`const { data: boards, isLoading: boardsLoading } = useKanbanBoards();`) e offre come destinazione una board altrui.
4. `frontend/src/features/tasks/ConvertTaskListToKanbanModal.tsx:45`, identico.
5. Delete con 403 permanente: `frontend/src/features/kanban/components/BoardCard.tsx:25` calcola `const isOwned = board.ownership === 'owned';` e `:76` renderizza il menu con il delete sotto `{isOwned && (`. Su una board residua di un altro account `ownership` è `'owned'`, quindi il menu compare; il DELETE finisce in coda; il backend risponde 403 (`backend/src/routes/kanban.ts:156-164`, il 403 esplicito è a `:159-161`); `syncService.ts:797-806` marca l'item `failed` per sempre e `SyncStatusIndicator` mostra il banner rosso che il retry non pulisce mai.
6. "Dirty ghost": il prune del pull agisce solo su `syncStatus === 'synced'` (`syncService.ts:319`), quindi una board creata offline da un altro account resta in Dexie per sempre, e `syncPush` non la spinge mai perché filtra la coda per `userId` (`syncService.ts:566`).

---

- [ ] **Step 1 — Scrivere il test dell'hook (fallisce)**

Crea `frontend/src/features/kanban/hooks/__tests__/useKanbanBoards.test.tsx`. Il file è verificato lint-clean: `_predicate` e il callback di `filter` sono tipizzati `Record<string, unknown>` (un `any` lì è un **errore** ESLint, non una warning), e la chiamata all'hook fuori da un componente ha il suo `eslint-disable-next-line react-hooks/rules-of-hooks`.

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Chainable Dexie collection mock that ACTUALLY applies the .filter() predicate,
// so the test asserts on rows and not on call shapes.
const { mockDb, rows } = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vitest mock: Dexie collection is a self-referential chain
  const table: any = {
    _predicate: null as null | ((row: Record<string, unknown>) => boolean),
    orderBy: vi.fn(() => table),
    reverse: vi.fn(() => table),
    filter: vi.fn((fn: (row: Record<string, unknown>) => boolean) => { table._predicate = fn; return table; }),
    toArray: vi.fn(async () => (table._predicate ? rows.filter(table._predicate) : [...rows])),
  };
  return { mockDb: { kanbanBoards: table }, rows };
});

// useLiveQuery is replaced by a plain capture, so the hook can be called as an
// ordinary function — no React renderer, no waitFor.
const { captured } = vi.hoisted(() => ({
  captured: { querier: null as null | (() => Promise<unknown>) },
}));

vi.mock('../../../../lib/db', () => ({ db: mockDb }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>) => { captured.querier = querier; return undefined; },
}));
vi.mock('../../../../store/authStore', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zustand selector signature
  useAuthStore: (selector: (s: any) => unknown) => selector({ user: { id: 'user-1' } }),
}));

import { useKanbanBoards } from '../useKanbanBoards';

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vitest mock internals
  (mockDb.kanbanBoards as any)._predicate = null;
  rows.length = 0;
  captured.querier = null;
});

async function runQuerier(): Promise<{ id: string }[]> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useLiveQuery is mocked away, so the hook is a plain function here
  useKanbanBoards();
  if (!captured.querier) throw new Error('useLiveQuery was never called');
  return (await captured.querier()) as { id: string }[];
}

describe('useKanbanBoards scoping', () => {
  it('returns boards owned by the current user', async () => {
    rows.push({ id: 'kb-mine', ownerId: 'user-1', ownership: 'owned', syncStatus: 'synced', updatedAt: '2026-01-02' });
    const result = await runQuerier();
    expect(result.map(b => b.id)).toEqual(['kb-mine']);
  });

  it('returns a shared board stamped with the current viewerId', async () => {
    rows.push({ id: 'kb-shared', ownerId: 'user-2', viewerId: 'user-1', ownership: 'shared', syncStatus: 'synced', updatedAt: '2026-01-02' });
    const result = await runQuerier();
    expect(result.map(b => b.id)).toEqual(['kb-shared']);
  });

  it('hides boards left behind in Dexie by another account on this browser', async () => {
    rows.push({ id: 'kb-other-owned', ownerId: 'user-2', ownership: 'owned', syncStatus: 'synced', updatedAt: '2026-01-02' });
    rows.push({ id: 'kb-other-shared', ownerId: 'user-3', viewerId: 'user-2', ownership: 'shared', syncStatus: 'synced', updatedAt: '2026-01-01' });
    const result = await runQuerier();
    expect(result).toEqual([]);
  });

  it('hides a dirty board created offline by another account (the pull never prunes it)', async () => {
    rows.push({ id: 'kb-ghost', ownerId: 'user-2', ownership: 'owned', syncStatus: 'created', updatedAt: '2026-01-02' });
    const result = await runQuerier();
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanBoards.test.tsx`
Atteso: FAIL — `Tests  2 failed | 2 passed (4)`. I due rossi sono `hides boards left behind in Dexie by another account on this browser` e `hides a dirty board created offline by another account (the pull never prunes it)`. Il secondo stampa testualmente:

```
AssertionError: expected [ { id: 'kb-ghost', …(4) } ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "id": "kb-ghost",
+     …
```

L'hook a HEAD non chiama mai `.filter`, quindi `toArray` restituisce tutte le righe. I due verdi passano per caso: senza filtro tutto viene restituito.

- [ ] **Step 3 — Aggiungere `viewerId` all'interfaccia `LocalKanbanBoard`**

In `frontend/src/lib/db.ts`, PRIMA (righe 115-119):

```ts
  ownership: 'owned' | 'shared';
  permission?: 'READ' | 'WRITE';
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
```

DOPO:

```ts
  ownership: 'owned' | 'shared';
  permission?: 'READ' | 'WRITE';
  // Id of the user syncPull ran for when it wrote this row. Owned rows are already
  // identified by ownerId, but on a SHARED row ownerId is the OTHER user's id, so
  // without this there is no way to tell whose list a shared board belongs to.
  // NOT an index: IndexedDB stores whole objects and only the keys declared in
  // .stores() become indexes — this needs NO Dexie version bump, db stays at v15.
  viewerId?: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
```

- [ ] **Step 4 — Filtrare l'hook**

Sostituisci l'intero contenuto di `frontend/src/features/kanban/hooks/useKanbanBoards.ts` (16 righe) con:

```ts
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../../lib/db';
import type { LocalKanbanBoard } from '../../../lib/db';
import { useAuthStore } from '../../../store/authStore';

export function useKanbanBoards() {
  const userId = useAuthStore((s) => s.user?.id);

  const boards = useLiveQuery(async () => {
    if (!userId) return [];
    // Fail closed. Dexie is one IndexedDB per browser profile and survives logout,
    // so rows written for a previous account are still here. Owned rows carry the
    // current user in ownerId (including boards created offline by kanbanService,
    // which never sets viewerId); shared rows carry the OWNER in ownerId, so the
    // pull stamps viewerId on them. A row matching neither belongs to someone else.
    return db.kanbanBoards
      .orderBy('updatedAt')
      .reverse()
      .filter((b) => b.ownerId === userId || b.viewerId === userId)
      .toArray();
  }, [userId]);

  return {
    data: boards,
    isLoading: boards === undefined,
  };
}

export type { LocalKanbanBoard };
```

- [ ] **Step 5 — Vedere il test dell'hook passare**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanBoards.test.tsx`
Atteso: PASS — `Test Files  1 passed (1)` / `Tests  4 passed (4)`.

- [ ] **Step 6 — Test del pull che prova lo stamp di `viewerId` (fallisce)**

In `frontend/src/features/sync/__tests__/syncService.test.ts`, dentro il `describe('kanban boards', …)` che inizia a riga 526, aggiungi questo test subito dopo la chiusura del test esistente `pulls kanban boards and their details (columns + cards)` (la `});` a riga 590), quindi prima della `});` che chiude il describe a riga 591:

```ts
    it('stamps viewerId on every board row it writes (list scoping)', async () => {
      const boardsList = [
        {
          id: 'kb-owned', title: 'Mine', description: null, coverImage: null,
          avatarUrl: null, ownerId: 'user-1', columnCount: 0, cardCount: 0,
          ownership: 'owned' as const, createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
        {
          id: 'kb-shared', title: 'Theirs', description: null, coverImage: null,
          avatarUrl: null, ownerId: 'user-2', columnCount: 0, cardCount: 0,
          ownership: 'shared' as const, permission: 'WRITE' as const,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/kanban/boards') return Promise.resolve({ data: boardsList });
        if (url === '/kanban/boards/kb-owned') return Promise.resolve({ data: { id: 'kb-owned', columns: [] } });
        if (url === '/kanban/boards/kb-shared') return Promise.resolve({ data: { id: 'kb-shared', columns: [] } });
        return Promise.resolve({ data: [] });
      });

      mockDb.kanbanBoards.toArray.mockResolvedValue([]);
      mockDb.kanbanColumns.toArray.mockResolvedValue([]);
      mockDb.kanbanCards.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      expect(mockDb.kanbanBoards.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'kb-owned', viewerId: 'user-1' }),
          expect.objectContaining({ id: 'kb-shared', viewerId: 'user-1' }),
        ]),
      );
    });
```

Il mock di `useAuthStore` è già in questo file (`mockAuthStore.getState` → `{ user: { id: 'user-1' } }`, riga 70-72, ri-armato in `beforeEach` da `resetAllTableMocks` a riga 127): non serve aggiungere niente.

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "stamps viewerId"`
Atteso: FAIL — `Tests  1 failed | 45 skipped (46)`, con:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ ArrayContaining{…} ]

Received:

  1st vi.fn() call:

  [
-   ArrayContaining [
-     ObjectContaining {
+   [
+     {
+       …
        "id": "kb-owned",
-       "viewerId": "user-1",
+       "ownerId": "user-1",
```

(Vitest 4 nomina gli spy anonimi `"vi.fn()"`, non `"bulkPut"`.)

- [ ] **Step 7 — Stampare `viewerId` nel pull board principale**

In `frontend/src/features/sync/syncService.ts`, PRIMA (righe 295-316):

```ts
    // --- Kanban Boards Pull ---
    try {
      const boardsRes = await api.get<KanbanBoardListItem[]>('/kanban/boards');
      const serverBoards = boardsRes.data;

      await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
        const dirtyBoards = await db.kanbanBoards.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyBoards.map(b => b.id));

        // Zombie prevention: check for pending board deletes
        const pendingBoardDeletes = await db.syncQueue
          .where('entity').equals('KANBAN_BOARD')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingBoardDeleteIds = new Set(pendingBoardDeletes.map(i => i.entityId));

        const boardsToPut: LocalKanbanBoard[] = serverBoards
          .filter(b => !dirtyIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => ({
            ...b,
            syncStatus: 'synced' as const,
          }));
```

DOPO:

```ts
    // --- Kanban Boards Pull ---
    try {
      const boardsRes = await api.get<KanbanBoardListItem[]>('/kanban/boards');
      const serverBoards = boardsRes.data;
      // The `import { useAuthStore }` statement sits further down this file (below
      // syncPull, at line 496) — ES module imports are hoisted, so the binding is
      // available here.
      const viewerId = useAuthStore.getState().user?.id;

      await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
        const dirtyBoards = await db.kanbanBoards.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyBoards.map(b => b.id));

        // Zombie prevention: check for pending board deletes
        const pendingBoardDeletes = await db.syncQueue
          .where('entity').equals('KANBAN_BOARD')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingBoardDeleteIds = new Set(pendingBoardDeletes.map(i => i.entityId));

        const boardsToPut: LocalKanbanBoard[] = serverBoards
          .filter(b => !dirtyIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => ({
            ...b,
            // Whose list this row belongs to. On a shared board ownerId is the
            // OWNER, so useKanbanBoards has nothing else to scope by.
            viewerId,
            syncStatus: 'synced' as const,
          }));
```

- [ ] **Step 8 — Stampare `viewerId` anche nel blocco shared boards**

PRIMA (righe 423-438):

```ts
    // --- Shared Kanban Boards Pull ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharedKanbanRes = await api.get<any[]>('/share/kanbans/accepted');
      const sharedBoards = sharedKanbanRes.data;

      await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sharedBoardsMapped: LocalKanbanBoard[] = sharedBoards.map((b: any) => ({
          ...b,
          ownership: 'shared' as const,
          permission: b._sharedPermission as 'READ' | 'WRITE' | undefined,
          syncStatus: 'synced' as const,
          columnCount: b._count?.columns ?? b.columns?.length ?? 0,
          cardCount: b.columns?.reduce((acc: number, col: { cards?: unknown[] }) => acc + (col.cards?.length ?? 0), 0) ?? 0,
        }));
```

DOPO:

```ts
    // --- Shared Kanban Boards Pull ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharedKanbanRes = await api.get<any[]>('/share/kanbans/accepted');
      const sharedBoards = sharedKanbanRes.data;
      const sharedViewerId = useAuthStore.getState().user?.id;

      await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sharedBoardsMapped: LocalKanbanBoard[] = sharedBoards.map((b: any) => ({
          ...b,
          ownership: 'shared' as const,
          viewerId: sharedViewerId,
          permission: b._sharedPermission as 'READ' | 'WRITE' | undefined,
          syncStatus: 'synced' as const,
          columnCount: b._count?.columns ?? b.columns?.length ?? 0,
          cardCount: b.columns?.reduce((acc: number, col: { cards?: unknown[] }) => acc + (col.cards?.length ?? 0), 0) ?? 0,
        }));
```

(Questo blocco verrà cancellato in 3.6. Va comunque stampato ora: fra 3.1 e 3.6 il codice deve essere corretto a ogni commit intermedio, altrimenti le righe condivise scritte da qui restano senza `viewerId` e spariscono dalla lista.)

- [ ] **Step 9 — Suite completa, typecheck, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Atteso: PASS su tutti e tre. Vitest: zero `failed`, con `src/features/sync/__tests__/syncService.test.ts (46 tests)` e `src/features/kanban/hooks/__tests__/useKanbanBoards.test.tsx (4 tests)`. `tsc --noEmit` non stampa nulla ed esce 0. `eslint .` stampa `✖ 52 problems (0 errors, 52 warnings)` ed esce 0 — **stesso identico conteggio del baseline**. Se compaiono `errors`, sono tuoi: le due trappole note sono un `any` non coperto da `eslint-disable-next-line` nel file di test e la chiamata all'hook dentro `runQuerier` senza il disable di `react-hooks/rules-of-hooks`.

- [ ] **Step 10 — Verifica manuale della degradazione fail-closed** (non copribile da unit test: riguarda IndexedDB reale e due sessioni)

Con `npm run dev` attivo su entrambi i workspace: login con l'utente A, apri `/kanban`, verifica che la lista sia quella di A. Logout, login con l'utente B: la lista deve contenere SOLO le board di B. Poi, come B, vai offline (DevTools → Network → Offline) e ricarica: le board possedute restano (hanno `ownerId === B`), le condivise possono mancare finché non torni online e parte un pull — è il comportamento atteso descritto sopra, non un bug.

- [ ] **Step 11 — E2E kanban**

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts`
Atteso: PASS — tutti i test dello spec verdi (`X passed`). In particolare `should create a new board` (`frontend/e2e/kanban.spec.ts:19`) deve restare verde: prova che una board creata offline con `ownerId = utente corrente` e senza `viewerId` resta visibile.

- [ ] **Step 12 — Commit**

```bash
git add frontend/src/lib/db.ts frontend/src/features/kanban/hooks/useKanbanBoards.ts frontend/src/features/kanban/hooks/__tests__/useKanbanBoards.test.tsx frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "fix(kanban): scope the board list to the current user"
```

---

### Task 3.2: Risolvere il `columnId` della card CREATE da Dexie invece che dal payload in coda

**Perché:** una card creata offline in una board a sua volta creata offline non arriva mai al server: la POST va in 404, l'item viene tolto dalla coda con un `console.warn`, la card resta in Dexie con `syncStatus: 'created'` e sembra salvata. È perdita di dati silenziosa.
**Severità:** critical · **Effort:** S · **Rischio:** TIER 1 — due righe nel branch `KANBAN_CARD` / `CREATE` di `syncPush`.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:684-687`
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` — aggiunta di un test dentro `describe('kanban push', …)` (riga 856), subito dopo `pushes CREATE kanban card with column-based URL` che finisce a riga 949

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

**Perché una riga sola basta, e perché è preferibile riaprire la riconciliazione.** Il branch `KANBAN_BOARD` / `CREATE` (`syncService.ts:639-669`) fa questo: manda la board al server, riceve le colonne che il backend ha creato lui, e in una transazione Dexie **riscrive gli id delle colonne locali con quelli del server**, aggiornando anche `columnId` di tutte le card che le referenziavano (`syncService.ts:657-660`). Quella transazione (aperta a `:651`) tocca `db.kanbanColumns` e `db.kanbanCards` — **non tocca `db.syncQueue`**. Quindi la card CREATE già accodata continua a portare nel suo `data.columnId` l'UUID locale ormai morto: `kanbanService.createCard` accoda testualmente `data: { id, columnId, title, description }` (`frontend/src/features/kanban/kanbanService.ts:340`). Al suo turno, `syncPush` legge `item.data.columnId` (`syncService.ts:686`), fa `POST /kanban/columns/<uuid-morto>/cards`, il backend chiama `getColumnWithAccess` (`backend/src/services/kanbanPermissions.ts:27-39`) che lancia `NotFoundError('errors.kanban.columnNotFound')` a riga 36 → 404 → `syncService.ts:780-784` cancella l'item.

Estendere la riconciliazione perché riscriva anche i payload in coda significherebbe: aggiungere `db.syncQueue` alla transazione di `:651`, scandire la coda cercando gli item `KANBAN_CARD` con `data.columnId` fra quelli rimappati, e fare `update` su ciascuno — dentro una transazione TIER 1 che oggi gestisce già una delete+put di colonne. Più codice, più superficie di rottura, e comunque non copre la coda scritta *dopo* la riconciliazione. Leggere il `columnId` da Dexie al momento del push copre entrambi i casi, perché Dexie è già la fonte riconciliata. Una riga.

Nota sul payload: mandare `{ ...item.data, id: item.entityId }` con dentro il `columnId` vecchio è innocuo. La rotta è `backend/src/routes/kanban.ts:445-450` e `createCardSchema` (`backend/src/routes/kanban.ts:41-45`) è `z.object({ id: z.string().uuid().optional(), title: z.string().min(1).max(500), description: z.string().max(5000).optional() })`: Zod per default scarta le chiavi sconosciute senza lanciare, e la colonna viene presa dall'URL (`getColumnWithAccess(id, …)` a `:447`).

---

- [ ] **Step 1 — Scrivere il test (fallisce)**

In `frontend/src/features/sync/__tests__/syncService.test.ts`, dentro `describe('kanban push', …)`, subito dopo la chiusura del test `pushes CREATE kanban card with column-based URL` (riga 949) e prima della `});` che chiude il describe a riga 950:

```ts
    it('resolves the card CREATE columnId from Dexie, not from the stale queued payload', async () => {
      const queueItem = {
        id: 61, type: 'CREATE' as const, entity: 'KANBAN_CARD' as const, entityId: 'card-orphan',
        userId: 'user-1',
        // Queued while the board was still offline: this column id died when the
        // board CREATE round-tripped and syncPush rewrote the Dexie column ids.
        data: { id: 'card-orphan', columnId: 'local-col-uuid', title: 'Orphan' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.kanbanCards.get.mockResolvedValue({
        id: 'card-orphan',
        columnId: 'server-col-uuid',
        updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });
      mockApi.post.mockResolvedValue({ data: {} });

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith(
        '/kanban/columns/server-col-uuid/cards',
        expect.objectContaining({ id: 'card-orphan', title: 'Orphan' }),
      );
    });
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "resolves the card CREATE columnId"`
Atteso: FAIL — `Tests  1 failed | 46 skipped (47)`, con:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ …(2) ]

Received:

  1st vi.fn() call:

  [
-   "/kanban/columns/server-col-uuid/cards",
+   "/kanban/columns/local-col-uuid/cards",
```

- [ ] **Step 3 — Implementare**

PRIMA (righe 684-687):

```ts
        } else if (item.entity === 'KANBAN_CARD') {
          if (item.type === 'CREATE') {
            const columnId = (item.data as Record<string, unknown> | undefined)?.columnId as string | undefined;
            await api.post(`/kanban/columns/${columnId}/cards`, { ...item.data, id: item.entityId });
```

DOPO:

```ts
        } else if (item.entity === 'KANBAN_CARD') {
          if (item.type === 'CREATE') {
            // The queued payload can point at a DEAD column id. When a board is
            // created offline, the KANBAN_BOARD/CREATE branch above rewrites the
            // Dexie column ids to the server ones after the round-trip (and
            // repoints the cards), but it never rewrites payloads already sitting
            // in the queue. Dexie holds the reconciled id — read it from there and
            // keep the queued value only as the fallback for cards whose board
            // never went through a reconciliation.
            // The stale columnId left in the body is harmless: createCardSchema
            // (backend/src/routes/kanban.ts:41-45) strips unknown keys and the
            // column comes from the URL.
            const queuedColumnId = (item.data as Record<string, unknown> | undefined)?.columnId as string | undefined;
            const columnId = (await db.kanbanCards.get(item.entityId))?.columnId ?? queuedColumnId;
            await api.post(`/kanban/columns/${columnId}/cards`, { ...item.data, id: item.entityId });
```

- [ ] **Step 4 — Vedere il test passare**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Atteso: PASS — `Tests  47 passed (47)`. In particolare deve restare verde anche `pushes CREATE kanban card with column-based URL` (riga 930): lì il mock di `kanbanCards.get` è `{ id: 'card-new', updatedAt: … }` senza `columnId` (righe 940-942), quindi il `??` cade sul payload e l'URL resta `/kanban/columns/col-1/cards`.

- [ ] **Step 5 — Suite completa, typecheck, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Atteso: PASS su tutti e tre. Vitest zero `failed`. `tsc` nessun output, exit 0. `eslint .` → `✖ 52 problems (0 errors, 52 warnings)`, exit 0.

- [ ] **Step 6 — Verifica manuale end-to-end del bug reale** (non copribile da unit test: serve il vero round-trip board→colonne del backend)

Con backend e frontend in dev: DevTools → Network → **Offline**. Crea una board nuova dalla pagina kanban, aggiungi una card in "To Do". Torna **Online** e aspetta ~30s (il pull periodico di `frontend/src/hooks/useSync.ts:55`, `setInterval(runSync, 30000)`) o ricarica. La card deve esistere sul server: apri la board da una finestra in incognito con lo stesso utente e verifica che ci sia. Prima del fix la card era visibile solo nel browser originale e in console compariva `Sync Push: Removing item (server returned 404): KANBAN_CARD <uuid>`.

- [ ] **Step 7 — E2E kanban**

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts`
Atteso: PASS — tutti i test dello spec verdi.

- [ ] **Step 8 — Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "fix(kanban): resolve queued card columnId from dexie at push time"
```

---

### Task 3.3: Non scartare più in silenzio una CREATE che va in 404

**Perché:** oggi qualunque 404 cancella l'item dalla coda. Per una UPDATE o una DELETE è giusto (la risorsa non c'è più), per una CREATE significa buttare via una riga che l'utente ha scritto e che non esiste da nessuna parte sul server: nessun toast, nessun banner, solo un `console.warn` che nessuno legge.
**Severità:** high · **Effort:** S · **Rischio:** TIER 1 — un branch nel gestore errori di `syncPush`.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:778-784` (il ramo 404/410; il blocco "PRIMA" qui sotto arriva fino a riga 785 per mostrare il confine col ramo 400/422)
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` — aggiunta di un test dentro `describe('error handling', …)` di `syncPush` (riga 955), subito dopo `handles 410 gracefully — removes item from queue` che finisce a riga 985

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

**Dove lo vede l'utente.** Il componente è `frontend/src/components/layout/SyncStatusIndicator.tsx`, montato in `frontend/src/components/layout/AppLayout.tsx:93`. Legge la coda con una `useLiveQuery` su `db.syncQueue` filtrata per `userId` (`SyncStatusIndicator.tsx:22-25`), conta gli item con `status === 'failed'` (`:27`), mostra `toast.error(t('sync.failedToast'))` alla prima transizione da 0 a >0 (`:44-49`) e, quando `failedCount > 0`, renderizza la barra rossa `bg-red-50 dark:bg-red-950/40` con `t('sync.failed', { count: failedCount })` e un bottone che chiama `handleRetry` → `retryFailedSyncItems` (`:64-71` e `:73-88`). Le chiavi `sync.failed`, `sync.failedToast` e `sync.retry` esistono già in `frontend/src/locales/en.json` e `frontend/src/locales/it.json`: **questo task non aggiunge nessuna chiave i18n.** Dopo questo task un CREATE orfano finisce lì invece di sparire.

Questo task è il complemento di 3.2: 3.2 elimina la causa più comune del 404 su CREATE, 3.3 fa sì che se ne resta un'altra l'utente la veda.

---

- [ ] **Step 1 — Scrivere il test (fallisce)**

In `frontend/src/features/sync/__tests__/syncService.test.ts`, dentro il `describe('error handling', …)` di `syncPush` (che inizia a riga 955), subito dopo la chiusura di `handles 410 gracefully — removes item from queue` (riga 985):

```ts
    it('marks an orphaned CREATE failed on 404 instead of dropping it silently', async () => {
      const queueItem = {
        id: 105, type: 'CREATE' as const, entity: 'KANBAN_CARD' as const, entityId: 'card-orphan',
        userId: 'user-1', data: { columnId: 'dead-col', title: 'Orphan' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockRejectedValue({ response: { status: 404 } });

      await syncPush();

      // Dropping a CREATE destroys data: the row stays in Dexie looking saved and
      // never reaches the server. SyncStatusIndicator surfaces status:'failed'.
      expect(mockDb.syncQueue.update).toHaveBeenCalledWith(105, expect.objectContaining({ status: 'failed' }));
      expect(mockDb.syncQueue.delete).not.toHaveBeenCalledWith(105);
    });
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "marks an orphaned CREATE failed"`
Atteso: FAIL — `Tests  1 failed | 47 skipped (48)`, con:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ 105, ObjectContaining{…} ]

Number of calls: 0
```

- [ ] **Step 3 — Implementare**

PRIMA (righe 778-785):

```ts
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 404 || status === 410) {
          // Resource no longer exists on server — remove from queue to stop infinite retries
          console.warn(`Sync Push: Removing item (server returned ${status}):`, item.entity, item.entityId);
          if (item.id) await db.syncQueue.delete(item.id);
          clearFailure(item.id);
        } else if (status === 400 || status === 422) {
```

DOPO:

```ts
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if ((status === 404 || status === 410) && item.type !== 'CREATE') {
          // Resource no longer exists on server — remove from queue to stop infinite retries
          console.warn(`Sync Push: Removing item (server returned ${status}):`, item.entity, item.entityId);
          if (item.id) await db.syncQueue.delete(item.id);
          clearFailure(item.id);
        } else if (status === 404 || status === 410) {
          // A CREATE that 404s means its PARENT is missing (e.g. a card queued for
          // a column id the server never saw). Dropping it silently destroys user
          // data: the row stays in Dexie, looks saved, and never reaches the
          // server. Mark it 'failed' so SyncStatusIndicator shows it with a retry.
          console.error('Sync Push: CREATE target missing on server, marking failed:', item.entity, item.entityId);
          if (item.id) {
            await db.syncQueue.update(item.id, { status: 'failed' as const, lastError: `parent-missing-${status}` });
          }
          clearFailure(item.id);
        } else if (status === 400 || status === 422) {
```

- [ ] **Step 4 — Vedere il test passare**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Atteso: PASS — `Tests  48 passed (48)`. Restano verdi anche `handles 404 gracefully — removes item from queue` (riga 956, item di tipo `DELETE`) e `handles 410 gracefully — removes item from queue` (riga 972, tipo `UPDATE`): entrambi continuano a cadere nel primo ramo.

- [ ] **Step 5 — Suite completa, typecheck, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Atteso: PASS su tutti e tre. Vitest zero `failed`. `tsc` nessun output, exit 0. `eslint .` → `✖ 52 problems (0 errors, 52 warnings)`, exit 0.

- [ ] **Step 6 — Verifica manuale della resa a schermo** (non copribile da unit test: riguarda il rendering di `SyncStatusIndicator` con Dexie reale)

In dev, con l'utente loggato, esegui in console DevTools:

```js
const { db } = await import('/src/lib/db.ts');
await db.syncQueue.add({ type: 'CREATE', entity: 'KANBAN_CARD', entityId: crypto.randomUUID(), userId: JSON.parse(localStorage.getItem('auth-storage')).state.user.id, data: { columnId: crypto.randomUUID(), title: 'orphan probe' }, createdAt: Date.now(), attempts: 0, status: 'pending' });
```

La `useLiveQuery` su `db.syncQueue.count()` (`frontend/src/hooks/useSync.ts:11`) scatta subito e fa partire il push; la POST verso una colonna inesistente torna 404. Atteso entro pochi secondi: toast rosso `sync.failedToast` e barra rossa in cima con il conteggio e il bottone `sync.retry`. Ripulisci con `await db.syncQueue.clear()`.

- [ ] **Step 7 — Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "fix(sync): surface orphaned CREATE items instead of dropping them on 404"
```

---

### Task 3.4: Far restituire a `syncPush` la promise in volo e incatenare il refresh della board

**Perché:** trascinando due card in rapida successione la seconda torna visivamente al punto di partenza per qualche secondo. `await syncPush()` non aspetta niente quando un push è già in corso, quindi la board viene rifetchata dal server prima che la mossa ci sia arrivata.
**Severità:** high · **Effort:** M · **Rischio:** TIER 1 — riscrive il guard di concorrenza di `syncPush`, il punto in cui passa ogni scrittura offline dell'app.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:498-499`, `:550-558`, `:813-821`
- Modifica: `frontend/src/features/kanban/hooks/useKanbanMutations.ts:16-129`
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts:1041-1080` — il `describe('concurrency guard', …)` esistente va **sostituito** integralmente, non affiancato

**Interfacce:**
- Consuma: nessuna
- Produce: `syncPush(): Promise<void>` — la promise ora si risolve quando il push è realmente finito, inclusa l'eventuale passata di follow-up richiesta mentre era in corso

- [ ] **Step 1 — RIPRODURRE IL BUG PRIMA DI TOCCARE CODICE. Non saltare questo step: senza averlo visto non puoi verificare il fix.**

Avvia backend e frontend in dev, apri una board kanban con almeno tre card in "To Do" e due colonne. Apri DevTools → Network → throttling **Slow 3G** (serve a rendere il push abbastanza lento da vedere la finestra). Poi, in meno di un secondo: trascina la card 1 da "To Do" a "In Progress", e subito dopo trascina la card 2 nello stesso modo.
Atteso (bug): la **seconda** card torna per un istante in "To Do" e poi risale. Nel Network vedi la sequenza `GET /api/kanban/boards/<id>` che parte *prima* della `PUT /api/kanban/cards/<id>/move` della seconda card. Se non lo riproduci, aumenta il throttling o aggiungi card, ma **non procedere finché non lo hai visto**.

Il perché: `useKanbanMutations.ts:16-19` è

```ts
  // Trigger sync after Dexie write (fire-and-forget)
  function flushSync(): void {
    syncPush().catch(() => {});
  }
```

e ogni `onSuccess` chiama `flushSync(); invalidateBoard();` in sequenza (es. `moveCard`, `useKanbanMutations.ts:109-112`). La board si renderizza dai dati del server (`useKanbanBoard` → `kanbanService.getBoard` → `GET /kanban/boards/:id`, `frontend/src/features/kanban/kanbanService.ts:129-132`), quindi invalidare prima che il push sia atterrato rifetcha lo stato pre-mossa. E anche volendo aspettare non si potrebbe: `syncPush` a `syncService.ts:551-555` mette `syncPushScheduled = true` e ritorna subito se un push è già in corso.

- [ ] **Step 2 — Sostituire il test di concorrenza esistente (fallisce)**

Il test attuale `guards against concurrent sync — only one runs at a time` (righe 1042-1079) fa `const second = syncPush(); await second;` **prima** di sbloccare la prima chiamata: dopo il fix quella `await` va in deadlock e il test va in timeout. Va sostituito, non modificato a metà. Rimpiazza l'intero `describe('concurrency guard', () => { … });` (righe 1041-1080) con:

```ts
  describe('concurrency guard', () => {
    it('never runs two pushes concurrently — the second call joins the first', async () => {
      let resolveFirst!: () => void;
      const firstCallPromise = new Promise<void>(resolve => { resolveFirst = resolve; });

      const queueItem = {
        id: 200, type: 'CREATE' as const, entity: 'NOTE' as const, entityId: 'note-slow',
        userId: 'user-1', data: { id: 'note-slow', title: 'Slow' },
        createdAt: Date.now(),
      };

      let postCallCount = 0;
      let concurrent = 0;
      let maxConcurrent = 0;

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockImplementation(() => {
        postCallCount++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const gate = postCallCount === 1 ? firstCallPromise : Promise.resolve();
        return gate.then(() => { concurrent--; return { data: {} }; });
      });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.notes.get.mockResolvedValue({
        id: 'note-slow', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      const first = syncPush();
      const second = syncPush(); // joins `first` — must NOT be awaited before unblocking it

      resolveFirst();
      await Promise.all([first, second]);

      // Two overlapping calls never produced two overlapping runs...
      expect(maxConcurrent).toBe(1);
      // ...but the second call was not dropped either: the run loop went round again.
      expect(postCallCount).toBe(2);
    });

    it('returns the in-flight promise so a concurrent caller can await the real push', async () => {
      let resolvePut!: () => void;
      const hang = new Promise<void>(resolve => { resolvePut = resolve; });

      const queueItem = {
        id: 201, type: 'UPDATE' as const, entity: 'KANBAN_CARD' as const, entityId: 'card-1',
        userId: 'user-1', data: { columnId: 'col-2', position: 0 },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.kanbanCards.get.mockResolvedValue({
        id: 'card-1', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });
      mockApi.put.mockImplementation(() => hang.then(() => ({ data: {} })));

      const first = syncPush();
      let secondSettled = false;
      const second = syncPush().then(() => { secondSettled = true; });

      // Give the microtask + macrotask queues a chance to settle a broken
      // implementation that resolves immediately.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(secondSettled).toBe(false);

      resolvePut();
      await Promise.all([first, second]);
      expect(secondSettled).toBe(true);
    });
  });
```

(Il `setTimeout(…, 0)` è reale: la suite non usa fake timer — `frontend/vitest.config.ts` non li abilita e `frontend/src/__tests__/setup.ts` monta solo `@testing-library/jest-dom` e un mock di `localStorage`.)

- [ ] **Step 3 — Vedere i test fallire**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "concurrency"`
Atteso: FAIL — `Tests  2 failed | 47 skipped (49)`.
Il primo fallisce con `AssertionError: expected 1 to be 2 // Object.is equality` (il follow-up oggi è un `setTimeout` da 1s che il test non aspetta).
Il secondo fallisce con `AssertionError: expected true to be false // Object.is equality`, ancorato alla riga `expect(secondSettled).toBe(false);`.

- [ ] **Step 4 — Riscrivere il guard di `syncPush`**

PRIMA (righe 498-499):

```ts
let isSyncing = false;
let syncPushScheduled = false;
```

DOPO:

```ts
let inFlight: Promise<void> | null = null;
let syncPushScheduled = false;
```

PRIMA (righe 550-558):

```ts
export const syncPush = async () => {
  if (isSyncing) {
    // Instead of silently dropping, schedule a follow-up push
    syncPushScheduled = true;
    return;
  }
  isSyncing = true;
  syncPushScheduled = false;
  try {
```

DOPO:

```ts
// [BACKUP] 2026-08-31 — syncPush used to be `async () => { if (isSyncing) { syncPushScheduled = true; return; } ... }`,
// i.e. it resolved IMMEDIATELY when a push was already running. Every caller that
// chained on it (useKanbanMutations.flushSync) therefore acted on pre-push state:
// the kanban board refetched from the server before the queued move had been sent,
// and the card visibly snapped back. The wrapper below hands concurrent callers the
// promise of the run that will actually carry their queue item.
export const syncPush = (): Promise<void> => {
  if (inFlight) {
    // A push is already running: flag a follow-up pass. The run loop picks the flag
    // up, so the promise returned here also covers that pass — a caller who queued
    // an item a moment ago is awaiting a run that includes it.
    syncPushScheduled = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      syncPushScheduled = false;
      await pushOnce();
    } while (syncPushScheduled);
  })().finally(() => { inFlight = null; });
  return inFlight;
};

const pushOnce = async () => {
  try {
```

(`pushOnce` è dichiarato **dopo** `syncPush` ma referenziato dentro il suo corpo: nessun problema di TDZ, perché `syncPush` viene invocata solo a runtime, quando il modulo è già valutato. Verificato: `tsc --noEmit` esce 0.)

PRIMA (righe 813-821, la coda della funzione):

```ts
  } finally {
    isSyncing = false;
    // If a push was requested while we were busy, run it now
    if (syncPushScheduled) {
      syncPushScheduled = false;
      setTimeout(() => syncPush(), 1000);
    }
  }
};
```

DOPO:

```ts
  } finally {
    // Re-entry, the follow-up pass and the in-flight promise are all handled by the
    // run loop in syncPush — nothing to schedule here.
  }
};
```

(Un `finally` che contiene solo un commento **non** viola `no-empty`: la regola ignora i blocchi con commenti. Verificato con `npx eslint` su questo esatto snippet, exit 0.)

- [ ] **Step 5 — Vedere i test di concorrenza passare**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Atteso: PASS — `Tests  49 passed (49)`, `concurrency guard` incluso con 2 test.

- [ ] **Step 6 — Incatenare l'invalidate al push in `useKanbanMutations`**

Sostituisci le righe 16-129 di `frontend/src/features/kanban/hooks/useKanbanMutations.ts` (dal commento `// Trigger sync after Dexie write (fire-and-forget)` fino alla `});` che chiude `duplicateCard`, esclusa la riga 131 `// Server-only mutations (no Dexie, no syncPush)`) con:

```ts
  // Push the Dexie write to the server, THEN refresh the board query. The board view
  // renders SERVER data (useKanbanBoard → GET /kanban/boards/:id), so invalidating
  // before the push lands refetches the pre-mutation state and the card snaps back.
  // syncPush resolves only when the run carrying this queue item is done.
  function flushSync(): void {
    void syncPush().catch(() => {}).then(invalidateBoard);
  }

  const createBoard = useMutation({
    mutationFn: kanbanService.createBoard,
    onSuccess: () => flushSync(),
  });

  const deleteBoard = useMutation({
    mutationFn: kanbanService.deleteBoard,
    onSuccess: (_data, deletedId) => {
      flushSync();
      queryClient.removeQueries({ queryKey: queryKeys.kanban.board(deletedId) });
      queryClient.removeQueries({ queryKey: queryKeys.kanban.boardChat(deletedId) });
    },
  });

  const updateBoard = useMutation({
    mutationFn: ({ id, ...data }: { id: string; title?: string; description?: string | null }) =>
      kanbanService.updateBoard(id, data),
    onSuccess: () => flushSync(),
  });

  const createColumn = useMutation({
    mutationFn: ({ boardId: bid, title }: { boardId: string; title: string }) =>
      kanbanService.createColumn(bid, title),
    onSuccess: () => flushSync(),
  });

  const updateColumn = useMutation({
    mutationFn: ({ columnId, ...data }: { columnId: string; title?: string; isCompleted?: boolean }) =>
      kanbanService.updateColumn(columnId, data),
    onSuccess: () => flushSync(),
  });

  const deleteColumn = useMutation({
    mutationFn: kanbanService.deleteColumn,
    onSuccess: () => flushSync(),
  });

  const reorderColumns = useMutation({
    mutationFn: ({ boardId: bid, columns }: { boardId: string; columns: { id: string; position: number }[] }) =>
      kanbanService.reorderColumns(bid, columns),
    onSuccess: () => flushSync(),
  });

  const createCard = useMutation({
    mutationFn: ({ columnId, ...data }: { columnId: string; title: string; description?: string }) =>
      kanbanService.createCard(columnId, data),
    onSuccess: () => flushSync(),
  });

  const updateCard = useMutation({
    mutationFn: ({
      cardId,
      ...data
    }: {
      cardId: string;
      title?: string;
      description?: string | null;
      assigneeId?: string | null;
      dueDate?: string | null;
      priority?: KanbanCardPriority | null;
    }) => kanbanService.updateCard(cardId, data),
    onSuccess: () => flushSync(),
  });

  const moveCard = useMutation({
    mutationFn: ({ cardId, toColumnId, position }: { cardId: string; toColumnId: string; position: number }) =>
      kanbanService.moveCard(cardId, toColumnId, position),
    onSuccess: () => flushSync(),
  });

  const deleteCard = useMutation({
    mutationFn: kanbanService.deleteCard,
    onSuccess: () => flushSync(),
  });

  const duplicateCard = useMutation({
    mutationFn: kanbanService.duplicateCard,
    onSuccess: () => flushSync(),
  });
```

Nota: le mutation "server-only" più sotto (`uploadCover`, `deleteCover`, `linkNote`, `unlinkNote`, `linkBoardNote`, `unlinkBoardNote`, `uploadAvatar`, `deleteAvatar`, `unarchiveCard`, `linkTaskList`, `unlinkTaskList`) restano com'erano, con `onSuccess: invalidateBoard` — non passano da Dexie né dalla coda. Anche il blocco `return { … }` finale resta invariato.

- [ ] **Step 7 — Suite completa, typecheck, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Atteso: PASS su tutti e tre. `tsc` non deve segnalare `'isSyncing' is declared but its value is never read`: se lo fa, è rimasto un riferimento a `isSyncing` da rimuovere. `eslint .` → `✖ 52 problems (0 errors, 52 warnings)`, exit 0.

- [ ] **Step 8 — Verificare che il bug dello Step 1 sia sparito**

Ripeti esattamente la sequenza dello Step 1 (Slow 3G, due drag in rapida successione).
Atteso: nessuno snap-back. Nel Network la `GET /api/kanban/boards/<id>` parte **dopo** la `PUT /api/kanban/cards/<id>/move` corrispondente. La card può restare un istante senza aggiornarsi, ma non torna mai indietro.

- [ ] **Step 9 — E2E kanban**

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts`
Atteso: PASS — tutti i test dello spec verdi.

- [ ] **Step 10 — Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts frontend/src/features/kanban/hooks/useKanbanMutations.ts
git commit -m "fix(kanban): await the real push before refetching the board"
```

---

### Task 3.5: Rimuovere il guard "non pushare mai le board condivise"

**Perché:** un collaboratore con permesso WRITE che rinomina o modifica la descrizione di una board condivisa perde la modifica senza accorgersene: resta scritta in Dexie e l'item viene cancellato dalla coda prima ancora di provare a mandarlo.
**Severità:** high · **Effort:** S · **Rischio:** TIER 1 — rimuove un controllo di sicurezza lato client; l'autorità resta il server.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:631-638` (il guard; il blocco "PRIMA" arriva a riga 639 per mostrare il confine con il ramo CREATE)
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts:894-910` — il test `skips shared kanban boards — removes from queue without API call` va **sostituito**

**Interfacce:**
- Consuma: `syncPush(): Promise<void>` (firma stabilita in 3.4, invariata)
- Produce: nessuna

**Perché è sicuro togliere il guard.** Il server già decide. `PUT /kanban/boards/:id` (`backend/src/routes/kanban.ts:149-154`) chiama `await assertBoardAccess(id, request.user.id, 'WRITE')`, che per un non-proprietario cerca lo share e lancia `ForbiddenError` se manca, non è `ACCEPTED`, o è `READ` (`backend/src/services/kanbanPermissions.ts:16-23`). E un 403 non viene più ritentato all'infinito: `syncService.ts:797-806` lo tratta come permanente —

```ts
        } else if (status === 403) {
          // Forbidden is permanent (insufficient permission) — retrying will never
          // succeed. Mark the item 'failed' IMMEDIATELY (instead of ~5 backoff
          // retries over ~10 min) so SyncStatusIndicator surfaces it to the user
          // right away (error toast + retry banner) rather than failing silently.
          console.error('Sync Push: forbidden (permission denied), marking failed:', item.entity, item.entityId);
          if (item.id) {
            await db.syncQueue.update(item.id, { status: 'failed' as const, lastError: 'forbidden' });
          }
          clearFailure(item.id);
```

Quindi un collaboratore READ che tenta una modifica riceve un errore visibile, che è il comportamento corretto; un collaboratore WRITE vede la sua modifica arrivare. Il guard lato client rendeva i due casi indistinguibili e silenziosi.

**Rischio residuo, contenuto:** senza guard anche una DELETE su board condivisa arriverebbe al server, che risponde 403 (`backend/src/routes/kanban.ts:156-164`: `const { isOwner } = await assertBoardAccess(id, request.user.id, 'WRITE'); if (!isOwner) return reply.status(403).send({ message: 'errors.kanban.onlyOwnerCanDelete' });`) e l'item verrebbe marcato `failed` con banner rosso. In pratica non è raggiungibile dalla UI: `frontend/src/features/kanban/components/BoardCard.tsx:25` calcola `isOwned = board.ownership === 'owned'` e il menu col delete è renderizzato solo sotto `{isOwned && (` a `:76`.

---

- [ ] **Step 1 — Sostituire il test esistente (fallisce)**

Rimpiazza il test `skips shared kanban boards — removes from queue without API call` (righe 894-910, dentro `describe('kanban push', …)`) con questi due:

```ts
    it('pushes a shared board UPDATE — the server decides, not the client', async () => {
      const queueItem = {
        id: 41, type: 'UPDATE' as const, entity: 'KANBAN_BOARD' as const, entityId: 'kb-shared',
        userId: 'user-1', data: { title: 'Edit' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.kanbanBoards.get.mockResolvedValue({
        id: 'kb-shared', ownership: 'shared', permission: 'WRITE',
        updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });
      mockApi.put.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);

      await syncPush();

      // A WRITE collaborator's rename must reach the server, not be thrown away.
      expect(mockApi.put).toHaveBeenCalledWith('/kanban/boards/kb-shared', { title: 'Edit' });
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(41);
    });

    it('marks a shared board UPDATE failed when the server refuses it (READ collaborator)', async () => {
      const queueItem = {
        id: 42, type: 'UPDATE' as const, entity: 'KANBAN_BOARD' as const, entityId: 'kb-readonly',
        userId: 'user-1', data: { title: 'Edit' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.kanbanBoards.get.mockResolvedValue({ id: 'kb-readonly', ownership: 'shared', permission: 'READ' });
      mockApi.put.mockRejectedValue({ response: { status: 403 } });

      await syncPush();

      expect(mockDb.syncQueue.update).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'failed' }));
    });
```

- [ ] **Step 2 — Vedere i test fallire**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "shared board UPDATE"`
Atteso: FAIL — `Tests  2 failed | 48 skipped (50)`. Il primo con:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ '/kanban/boards/kb-shared', …(1) ]

Number of calls: 0
```

il secondo con:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ 42, ObjectContaining{…} ]

Number of calls: 0
```

- [ ] **Step 3 — Rimuovere il guard**

PRIMA (righe 631-639):

```ts
        } else if (item.entity === 'KANBAN_BOARD') {
          // Safety: never push shared boards to REST API
          const localBoard = await db.kanbanBoards.get(item.entityId);
          if (localBoard?.ownership === 'shared') {
            if (item.id) await db.syncQueue.delete(item.id);
            clearFailure(item.id);
            continue;
          }
          if (item.type === 'CREATE') {
```

DOPO:

```ts
        } else if (item.entity === 'KANBAN_BOARD') {
          // [BACKUP] 2026-08-31 — a guard here used to drop every queued change to a
          // board with ownership==='shared' (delete from queue, continue), which threw
          // away a WRITE collaborator's rename with no feedback at all. The server is
          // the authority: PUT /kanban/boards/:id runs assertBoardAccess(...,'WRITE')
          // (backend/src/routes/kanban.ts:149-154) and a refusal comes back as 403,
          // which the 403 branch below marks 'failed' so the user actually sees it.
          if (item.type === 'CREATE') {
```

- [ ] **Step 4 — Vedere i test passare**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Atteso: PASS — `Tests  50 passed (50)`. Nota che il test `skips shared notes — removes from queue without API call` (riga 729) resta verde: il guard analogo per le NOTE (`syncService.ts:576-582`) **non** viene toccato da questo task.

- [ ] **Step 5 — Suite completa, typecheck, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Atteso: PASS su tutti e tre. `eslint .` deve restare a `✖ 52 problems (0 errors, 52 warnings)` con exit 0: se compare l'errore `'localBoard' is assigned a value but never used`, la `const localBoard = await db.kanbanBoards.get(item.entityId);` è rimasta.

- [ ] **Step 6 — E2E sharing**

Run: `cd frontend && npx playwright test e2e/sharing.spec.ts`
Atteso: PASS — tutti i test dello spec verdi.

- [ ] **Step 7 — Verifica manuale a due utenti** (non copribile da unit test: serve un vero share ACCEPTED nel DB)

Utente A crea una board e la condivide con B in WRITE (modale `frontend/src/features/kanban/components/ShareBoardModal.tsx`); B accetta. B rinomina la board dal titolo nella pagina board. Atteso: dopo qualche secondo A ricarica e vede il nuovo titolo, e in `SyncStatusIndicator` non compare nessun banner rosso. Ripeti condividendo in READ: B tenta la rinomina, atteso banner rosso `sync.failed` con bottone `sync.retry` (il server rifiuta con 403, ed è giusto che si veda).

- [ ] **Step 8 — Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "fix(kanban): let shared board edits reach the server"
```

---

### Task 3.6: Eliminare il pull duplicato delle board condivise e allargare il prune (stesso commit)

**Perché:** ogni ciclo di sync fa una chiamata in più (`/share/kanbans/accepted`) per riscrivere righe che il pull principale ha già scritto, e le riscrive **peggio**: quella rotta restituisce l'albero completo `columns → cards`, che finisce spalmato dentro la riga della board in IndexedDB, senza `shares` né `shareCount`.
**Severità:** medium · **Effort:** M · **Rischio:** TIER 1 — cancella l'unico punto che oggi elimina da Dexie le board condivise revocate.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:318-324` (rilassamento del filtro del prune) e `:423-488` (cancellazione integrale del blocco shared)
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` — aggiunta di un test dentro `describe('kanban boards', …)`, dopo il test aggiunto in 3.1

**Interfacce:**
- Consuma: lo stamp di `viewerId` introdotto in 3.1 (il write site cancellato qui è uno dei due che 3.1 ha toccato; l'altro, il pull principale, resta ed è quello che continua a stampare `viewerId` sulle righe condivise)
- Produce: nessuna

**LA TRAPPOLA, per esteso — leggerla prima di toccare qualsiasi cosa.** `GET /kanban/boards` restituisce già board possedute **e** condivise-ACCEPTED: `listBoards` in `backend/src/services/kanban/board.service.ts:9-109` fa due query in parallelo (`prisma.kanbanBoard.findMany({ where: { ownerId: userId } })` e `prisma.sharedKanbanBoard.findMany({ where: { userId, status: 'ACCEPTED' } })`) e ritorna `[...ownedBoards, ...sharedBoards]` (riga 108), dove le condivise portano `ownership: 'shared'` (`:104`), `permission` (`:105`), `owner` (`:97`), `shares` (`:103`) e `shareCount` (`:102`). Anche colonne e card delle condivise arrivano già: il loop di dettaglio a `syncService.ts:342` cicla su **tutte** le `serverBoards` e la rotta `GET /kanban/boards/:id` ammette i collaboratori (`await assertBoardAccess(id, request.user.id, 'READ');`, `backend/src/routes/kanban.ts:143-147`). E non si perde nessun campo: `getBoard` mappa ogni card con `transformCard` (`board.service.ts:247`), che produce `commentCount` da `_count.comments` (`backend/src/services/kanban/helpers.ts:51-54`), e `cardWithAssigneeSelect` (`helpers.ts:30-48`) include `columnId` — esattamente i due campi che il blocco cancellato aggiungeva a mano. Il blocco `:423-488` è quindi ridondante per i dati.

**Ma non è ridondante per le cancellazioni.** Il prune del pull principale a `syncService.ts:319-320` esclude esplicitamente le righe condivise (`.filter(b => b.ownership !== 'shared')`, con il commento "shared handled below"), e le uniche righe condivise che oggi vengono eliminate lo sono a `:441-450`, dentro il blocco che stai per cancellare. **Cancellare il blocco da solo lascerebbe in Dexie per sempre ogni board la cui condivisione è stata revocata**, visibile nella lista e apribile fino al 403. Per questo le due modifiche devono stare nello stesso commit: separarle vuol dire pubblicare una revisione intermedia che perde le revoche.

---

- [ ] **Step 1 — Baseline e2e PRIMA di modificare**

Run: `cd frontend && npx playwright test e2e/sharing.spec.ts e2e/dexie.spec.ts`
Atteso: PASS — entrambi gli spec verdi. Annota il numero di test passati: dopo la modifica deve essere identico. Se qualcosa è già rosso a baseline, fermati e sistemalo prima: non puoi attribuire il rosso a questo task.

- [ ] **Step 2 — Scrivere il test (fallisce)**

In `frontend/src/features/sync/__tests__/syncService.test.ts`, dentro `describe('kanban boards', …)`, subito dopo la chiusura del test `stamps viewerId on every board row it writes (list scoping)` aggiunto in 3.1:

```ts
    it('no longer calls /share/kanbans/accepted and prunes shared rows in the main block', async () => {
      mockApi.get.mockImplementation((url: string) => {
        // Empty list = the user has lost access to everything they had locally.
        if (url === '/kanban/boards') return Promise.resolve({ data: [] });
        return Promise.resolve({ data: [] });
      });

      mockDb.kanbanBoards.toArray.mockResolvedValue([]);
      mockDb.kanbanColumns.toArray.mockResolvedValue([]);
      mockDb.kanbanCards.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      // GET /kanban/boards already returns owned AND shared-ACCEPTED boards
      // (backend listBoards concatenates both), so the second round-trip is dead weight.
      expect(mockApi.get).not.toHaveBeenCalledWith('/share/kanbans/accepted');
      // ...and the prune no longer filters shared rows out before deleting.
      expect(mockDb.kanbanBoards.filter).not.toHaveBeenCalled();
    });
```

**Onestà sul limite di questo test:** il mock di tabella condiviso in questo file (`createTable`, righe 16-43) registra il predicato di `.filter()` in `table._filterFn` ma non lo applica in `toArray()`, quindi un'asserzione a livello di righe ("la board revocata è stata cancellata") passerebbe **anche prima** del fix e non proverebbe nulla. Per questo il test asserisce sulla forma delle chiamate — che cambia davvero — e il comportamento reale del prune è verificato dallo Step 6 (sequenza manuale accept/revoke) e dagli e2e. La seconda asserzione è valida perché `db.kanbanBoards.filter` è chiamato una sola volta in tutto `syncPull`, proprio nella riga del prune che questo task riscrive.

- [ ] **Step 3 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "no longer calls /share/kanbans/accepted"`
Atteso: FAIL — `Tests  1 failed | 50 skipped (51)`, con:

```
AssertionError: expected "vi.fn()" to not be called with arguments: [ '/share/kanbans/accepted' ]

Number of calls: 8
```

(`Number of calls: 8` è il totale delle `api.get` del ciclo di pull, non il numero di chiamate a quell'URL.)

- [ ] **Step 4 — Rilassare il filtro del prune**

PRIMA (righe 318-324):

```ts
        // Remove boards no longer on server (owned only — shared handled below)
        const allLocalSyncedBoards = await db.kanbanBoards.where('syncStatus').equals('synced')
          .filter(b => b.ownership !== 'shared').toArray();
        const serverIds = new Set(serverBoards.map(b => b.id));
        const toDeleteIds = allLocalSyncedBoards
          .filter(b => !serverIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => b.id);
```

DOPO:

```ts
        // Remove boards no longer on the server — OWNED AND SHARED alike.
        // GET /kanban/boards returns both (backend listBoards concatenates the owned
        // query and the ACCEPTED-shares query), so a board missing from this response
        // is a board the user has lost access to: deleted, or share revoked. The
        // ownership!=='shared' exclusion that used to sit here was only correct while
        // a second pull block pruned shared rows; that block is gone as of this commit.
        const allLocalSyncedBoards = await db.kanbanBoards.where('syncStatus').equals('synced').toArray();
        const serverIds = new Set(serverBoards.map(b => b.id));
        const toDeleteIds = allLocalSyncedBoards
          .filter(b => !serverIds.has(b.id) && !pendingBoardDeleteIds.has(b.id))
          .map(b => b.id);
```

- [ ] **Step 5 — Cancellare il blocco shared, nello stesso commit**

Cancella integralmente le righe 423-488, cioè da `    // --- Shared Kanban Boards Pull ---` fino a e inclusa la `    }` che chiude il `catch (e) { console.error('syncPull shared kanban boards failed', e); }`. Il testo da eliminare, per intero (già comprensivo dello stamp `sharedViewerId` aggiunto in 3.1):

```ts
    // --- Shared Kanban Boards Pull ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharedKanbanRes = await api.get<any[]>('/share/kanbans/accepted');
      const sharedBoards = sharedKanbanRes.data;
      const sharedViewerId = useAuthStore.getState().user?.id;

      await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sharedBoardsMapped: LocalKanbanBoard[] = sharedBoards.map((b: any) => ({
          ...b,
          ownership: 'shared' as const,
          viewerId: sharedViewerId,
          permission: b._sharedPermission as 'READ' | 'WRITE' | undefined,
          syncStatus: 'synced' as const,
          columnCount: b._count?.columns ?? b.columns?.length ?? 0,
          cardCount: b.columns?.reduce((acc: number, col: { cards?: unknown[] }) => acc + (col.cards?.length ?? 0), 0) ?? 0,
        }));

        // Remove stale shared boards no longer in server response
        const localSharedBoards = await db.kanbanBoards.where('ownership').equals('shared').toArray();
        const sharedServerIds = new Set(sharedBoardsMapped.map(b => b.id));
        const staleIds = localSharedBoards.filter(b => !sharedServerIds.has(b.id)).map(b => b.id);
        if (staleIds.length > 0) {
          await db.kanbanBoards.bulkDelete(staleIds);
          for (const boardId of staleIds) {
            await db.kanbanColumns.where('boardId').equals(boardId).delete();
            await db.kanbanCards.where('boardId').equals(boardId).delete();
          }
        }

        if (sharedBoardsMapped.length > 0) await db.kanbanBoards.bulkPut(sharedBoardsMapped);

        // Sync columns and cards for each shared board
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const board of sharedBoards as any[]) {
          if (board.columns) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const columns: LocalKanbanColumn[] = board.columns.map((col: any) => ({
              id: col.id,
              title: col.title,
              position: col.position,
              boardId: board.id,
              isCompleted: col.isCompleted ?? false,
              syncStatus: 'synced' as const,
            }));
            if (columns.length > 0) await db.kanbanColumns.bulkPut(columns);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const col of board.columns as any[]) {
              if (col.cards && col.cards.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const cards: LocalKanbanCard[] = col.cards.map((card: any) => ({
                  ...card,
                  columnId: col.id,
                  boardId: board.id,
                  commentCount: card._count?.comments ?? 0,
                  syncStatus: 'synced' as const,
                }));
                await db.kanbanCards.bulkPut(cards);
              }
            }
          }
        }
      });
    } catch (e) {
      console.error('syncPull shared kanban boards failed', e);
    }
```

Dopo la cancellazione, la fine di `syncPull` deve leggersi esattamente così — la chiusura del `catch` del loop di dettaglio, poi la chiusura del `try` del pull board principale, poi il `catch` esterno:

```ts
        } catch (e) {
          console.error(`syncPull kanban board ${board.id} details failed`, e);
        }
      }
    } catch (e) {
      console.error('syncPull kanban boards failed', e);
    }

  } catch (error) {
    console.error('Sync Pull Failed:', error);
  }
};
```

- [ ] **Step 6 — Vedere il test passare e controllare gli import inutilizzati**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts && npx tsc --noEmit && npm run lint`
Atteso: `Tests  51 passed (51)`; `tsc` nessun output, exit 0; `eslint .` → `✖ 52 problems (0 errors, 52 warnings)`, exit 0. Se `eslint` segnala l'errore `'LocalKanbanColumn' is defined but never used` o `'LocalKanbanCard' is defined but never used` sull'import di riga 6, **non rimuoverli**: sono ancora usati dal loop di dettaglio (`syncService.ts:371` e `:394`). Se la segnalazione compare davvero, hai cancellato più del dovuto — rileggi lo Step 5.

- [ ] **Step 7 — Suite completa**

Run: `cd frontend && npx vitest run`
Atteso: PASS, zero `failed`. Resta verde anche `continues pulling other entities when shared notes fail` (riga 635), che nel suo mock gestisce ancora `/share/kanbans/accepted` (riga 644): quel ramo semplicemente non viene più raggiunto.

- [ ] **Step 8 — E2E dopo, da confrontare con lo Step 1**

Run: `cd frontend && npx playwright test e2e/sharing.spec.ts e2e/dexie.spec.ts`
Atteso: PASS con lo **stesso** numero di test passati registrato allo Step 1. Qualsiasi differenza va indagata prima di committare.

- [ ] **Step 9 — Verifica manuale obbligatoria della sequenza accept / revoke** (non copribile da unit test: il mock di tabella non applica i predicati di `.filter()`, quindi solo IndexedDB reale prova la cancellazione)

Due utenti, A e B, in due browser (o uno in incognito).
1. A crea una board e la condivide con B. B accetta l'invito.
2. B apre `/kanban`: la board condivisa compare in lista. In DevTools → Application → IndexedDB → `NotiqDB` → `kanbanBoards` la riga esiste, con `ownership: 'shared'` e `viewerId` uguale all'id di B.
3. A revoca la condivisione (`ShareBoardModal` sulla board).
4. B aspetta al massimo un ciclo di pull (30s, `frontend/src/hooks/useSync.ts:55`) senza ricaricare.

Atteso: la board sparisce dalla lista **e** la riga sparisce da `db.kanbanBoards` in IndexedDB entro quel singolo ciclo. Se resta in IndexedDB, il filtro dello Step 4 non è stato applicato: il commit non va fatto.

- [ ] **Step 10 — Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "perf(kanban): drop the duplicate shared-board pull and prune shared rows in the main block"
```

---

### Task 3.7: Isolare notebooks, tags e notes in `syncPull` con try/catch propri

**Perché:** se `/notebooks` risponde 500, l'utente non perde solo i taccuini: perde l'intero giro di sync. Tag, note, task list e kanban non vengono nemmeno chiesti, e soprattutto non gira il prune delle board — quindi board cancellate o revocate restano visibili finché la chiamata rotta non guarisce.
**Severità:** medium · **Effort:** M · **Rischio:** TIER 1 — modifica strutturale (indentazione) sulla prima metà di `syncPull`; nessun cambio di logica dentro le transazioni.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:11-130`
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` — aggiunta di un test dentro `describe('error handling', …)` di `syncPull` (riga 627), dopo `continues pulling other entities when shared notes fail` che finisce a riga 659

**Interfacce:**
- Consuma: nessuna
- Produce: nessuna

Le sezioni successive hanno già il loro `try/catch` (shared notes: `try {` a `syncService.ts:133`; task lists: `:191`; shared task lists: `:255`; kanban boards: `:296`); queste tre sono le uniche scoperte, e stanno per prime, quindi sono esattamente quelle che possono far saltare tutto il resto. Il diff è pesante di sola indentazione: `git diff -w` mostra che le righe realmente aggiunte sono sei (tre `try {` e tre `} catch (e) { console.error(...) }`) più il commento di tre righe sul primo catch.

---

- [ ] **Step 1 — Scrivere il test (fallisce)**

In `frontend/src/features/sync/__tests__/syncService.test.ts`, dentro il `describe('error handling', …)` di `syncPull` (riga 627), subito dopo la chiusura di `continues pulling other entities when shared notes fail` (riga 659):

```ts
    it('still reaches tags, notes and the kanban prune when the notebooks pull throws', async () => {
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notebooks') return Promise.reject(new Error('boom'));
        return Promise.resolve({ data: [] });
      });

      mockDb.notebooks.toArray.mockResolvedValue([]);
      mockDb.tags.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.kanbanBoards.toArray.mockResolvedValue([]);

      await expect(syncPull()).resolves.toBeUndefined();

      // One failing endpoint must not cost the user the whole sync cycle — the
      // kanban prune in particular is what removes deleted and revoked boards.
      expect(mockApi.get).toHaveBeenCalledWith('/tags');
      expect(mockApi.get).toHaveBeenCalledWith('/notes?includeTrashed=true');
      expect(mockApi.get).toHaveBeenCalledWith('/kanban/boards');
    });
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "still reaches tags, notes and the kanban prune"`
Atteso: FAIL — `Tests  1 failed | 51 skipped (52)`, con:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ '/tags' ]

Number of calls: 1
```

(l'unica chiamata è `/notebooks`, che ha rigettato e ha fatto saltare tutto il resto).

- [ ] **Step 3 — Sostituire le righe 11-130 con la versione protetta**

Sostituisci l'intero blocco dalla riga 11 (`    // Pull Notebooks`) alla riga 130 (la `    });` che chiude la transazione delle note) con:

```ts
    // Pull Notebooks
    try {
      const notebooksRes = await api.get<Notebook[]>('/notebooks');
      await db.transaction('rw', db.notebooks, async () => {
        const dirtyNotebooks = await db.notebooks.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyNotebooks.map(n => n.id));

        const serverNotebooks = notebooksRes.data.map(n => ({
          ...n,
          syncStatus: 'synced' as const
        }));

        const notebooksToPut = serverNotebooks.filter(n => !dirtyIds.has(n.id));

        const allLocalSyncedNotebooks = await db.notebooks.where('syncStatus').equals('synced').toArray();
        const serverIds = new Set(serverNotebooks.map(n => n.id));
        const toDeleteIds = allLocalSyncedNotebooks.filter(n => !serverIds.has(n.id)).map(n => n.id);

        await db.notebooks.bulkDelete(toDeleteIds);
        await db.notebooks.bulkPut(notebooksToPut);
      });
    } catch (e) {
      // Scoped catch: these three sections run FIRST, so an unguarded throw here used
      // to abort the whole pull — including the kanban prune, the only thing that
      // removes deleted and revoked boards from Dexie.
      console.error('syncPull notebooks failed', e);
    }

    // Pull Tags
    try {
      const tagsRes = await api.get<Tag[]>('/tags');
      await db.transaction('rw', db.tags, async () => {
        const dirtyTags = await db.tags.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyTags.map(t => t.id));

        const serverTags = tagsRes.data.map(t => ({
          ...t,
          // userId should come from server. If not, use 'current-user' as fallback?
          // Actually, backend returns userId.
          syncStatus: 'synced' as const
        }));

        const tagsToPut = serverTags.filter(t => !dirtyIds.has(t.id));

        const allLocalSyncedTags = await db.tags.where('syncStatus').equals('synced').toArray();
        const serverIds = new Set(serverTags.map(t => t.id));
        const toDeleteIds = allLocalSyncedTags.filter(t => !serverIds.has(t.id)).map(t => t.id);

        await db.tags.bulkDelete(toDeleteIds);
        await db.tags.bulkPut(tagsToPut);
      });
    } catch (e) {
      console.error('syncPull tags failed', e);
    }

    // Pull Notes
    try {
      const notesRes = await api.get<Note[]>('/notes?includeTrashed=true');
      await db.transaction('rw', db.notes, db.syncQueue, async () => {
        // We need to be careful not to overwrite dirty notes
        // For MVP, let's just overwrite everything that is 'synced'
        // But wait, if we clear, we lose dirty notes.
        // Better: Get all dirty notes IDs.
        const dirtyNotes = await db.notes.where('syncStatus').notEqual('synced').toArray();
        const dirtyIds = new Set(dirtyNotes.map(n => n.id));

        const serverNotes = notesRes.data.map(n => ({
          ...n,
          tags: n.tags || [], // Ensure array
          attachments: n.attachments || [], // Ensure array
          ownership: 'owned' as const,
          sharedPermission: null,
          sharedByUser: null,
          syncStatus: 'synced' as const
        }));

        // Filter out server notes that conflict with local dirty notes (local wins temporarily until push)
        const notesToPut = serverNotes.filter(n => !dirtyIds.has(n.id));

        // CRITICAL FIX: ZOMBIE RESURRECTION
        // We must check if any of these "server notes" are actually queued for DELETION locally.
        // If a note is in serverNotes but we have a pending DELETE in syncQueue, we MUST NOT re-insert it.
        // The `dirtyIds` check handles UPDATEs (where syncStatus='updated'), but hard deletes use DELETE queue type
        // and checking db.notes might fail if it was already deleted.

        const pendingDeletes = await db.syncQueue
          .where('entity').equals('NOTE')
          .and(item => item.type === 'DELETE')
          .toArray();

        const pendingDeleteIds = new Set(pendingDeletes.map(i => i.entityId));

        const filteredNotesToPut = notesToPut.filter(n => !pendingDeleteIds.has(n.id));

        // We also need to handle deletions. If a note is in DB but not in serverNotes, and it's synced, delete it.
        // Exclude shared notes — they are managed by the shared notes pull block below.
        const allLocalSyncedNotes = await db.notes.where('syncStatus').equals('synced')
          .filter(n => n.ownership !== 'shared').toArray();
        // Self-Healing Strategy:
        // If we have local notes that are 'synced' but missing from the server, 
        // instead of deleting them locally, we should assume the server lost them and re-push.
        // This protects against accidental server wipes and "disappearing notes".

        const serverIds = new Set(serverNotes.map(n => n.id));
        // Notes missing from server are considered deleted — remove from local DB
        const toDeleteIds = allLocalSyncedNotes
          .filter(n => !serverIds.has(n.id) && !pendingDeleteIds.has(n.id))
          .map(n => n.id);

        if (toDeleteIds.length > 0) {
          await db.notes.bulkDelete(toDeleteIds);
        }

        // Preserve local 'content' field: GET /notes doesn't return it to keep responses lightweight.
        // Without this, bulkPut would wipe content (critical for encrypted vault/credential notes).
        const existingNoteIds = filteredNotesToPut.map(n => n.id);
        const existingNotes = await db.notes.bulkGet(existingNoteIds);
        const localContentMap = new Map<string, string>();
        for (const existing of existingNotes) {
          if (existing?.content) {
            localContentMap.set(existing.id, existing.content);
          }
        }

        const notesWithPreservedContent = filteredNotesToPut.map(n => ({
          ...n,
          content: n.content ?? localContentMap.get(n.id) ?? '',
        }));

        // Update local DB with server notes (wins over synced)
        await db.notes.bulkPut(notesWithPreservedContent);
      });
    } catch (e) {
      console.error('syncPull notes failed', e);
    }
```

- [ ] **Step 4 — Vedere il test passare**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`
Atteso: PASS — `Tests  52 passed (52)`, compresi i test di pull di notebooks (righe 143, 170, 199), note (233, 268, 308) e tag (597), che devono restare invariati: la logica dentro le transazioni non è cambiata di una riga.

- [ ] **Step 5 — Verificare che il diff sia davvero solo indentazione + sei righe**

Run: `cd frontend && git diff -w -- src/features/sync/syncService.ts`
Atteso: il diff ignorando gli spazi mostra **solo** l'aggiunta di tre `try {`, tre `} catch (e) { console.error('syncPull <sezione> failed', e); }` e le tre righe di commento sul primo catch. Se compare qualunque altra riga modificata dentro le transazioni, è un errore di trascrizione: annulla con `git checkout -- src/features/sync/syncService.ts` e rifai lo Step 3.

- [ ] **Step 6 — Suite completa, typecheck, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Atteso: PASS su tutti e tre. Vitest zero `failed`. `tsc` nessun output, exit 0. `eslint .` → `✖ 52 problems (0 errors, 52 warnings)`, exit 0.

- [ ] **Step 7 — E2E di regressione sui flussi di pull**

Run: `cd frontend && npx playwright test e2e/notes.spec.ts e2e/notebooks.spec.ts e2e/tags.spec.ts e2e/kanban.spec.ts`
Atteso: PASS — tutti e quattro gli spec verdi.

- [ ] **Step 8 — Commit**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "fix(sync): isolate the notebooks, tags and notes pulls behind their own catch"
```

---

## Stage 4 — Chokepoint SSE (dopo lo Stage 1)

Tutti gli eventi kanban real-time passano da una sola funzione, `broadcast()` in `backend/src/services/kanbanSSE.ts:102`, e da un solo handler, `handleEvent` in `frontend/src/features/kanban/hooks/useKanbanRealtime.ts:29`. Oggi quel canale perde il titolo delle note collegate verso utenti che non hanno accesso alla nota, rimanda a ogni utente l'eco delle sue stesse azioni, continua a servire un collaboratore appena revocato, non emette nulla quando la board cambia (titolo, cover, avatar, cancellazione) e butta via l'evento `connected` che sarebbe l'unico momento utile per recuperare ciò che si è perso mentre la connessione era caduta. Questo stage sistema tutte e cinque le cose ai due chokepoint invece che nei 21 punti chiamanti.

**Ordine vincolante:** `4.1 → 4.2 → 4.5 → 4.6`. La 4.1 introduce `actorId` su `KanbanEvent` e lo popola — senza, il filtro della 4.2 non ha nulla da filtrare. La 4.6 dipende dal tipo introdotto dalla 4.2 e dai numeri di riga prodotti dalla 4.5 (il file `useKanbanRealtime.ts` cresce di 4 righe con la 4.2 e di 1 con la 4.5: i numeri di riga citati nella 4.6 sono già quelli post-4.2+4.5). Le task **4.3** e **4.4** sono indipendenti da tutto il resto e si possono fare in qualsiasi momento. Prima di iniziare deve essere mergiato lo Stage 1: la 4.2 dà per assodato che le mutation card/column invalidino già la board query in `onSuccess` (`useKanbanMutations.ts:10-14`, chiamata da `moveCard` a `:110-111`).

**Baseline verificata su tree pulito al commit `141e6af`, da rieseguire prima di iniziare:**

```bash
cd backend  && npx vitest run --sequence.concurrent=false   # Test Files 61 passed (61) / Tests 1083 passed (1083)
cd backend  && npm run lint                                  # ✖ 63 problems (0 errors, 63 warnings)
cd frontend && npx vitest run                                # Test Files  9 passed  (9) / Tests  131 passed (131)
cd frontend && npm run lint                                  # ✖ 52 problems (0 errors, 52 warnings)
```

> **Comandi di typecheck — attenzione, il default non funziona.**
> `frontend/tsconfig.json` contiene `"files": []` + project references: **`npx tsc --noEmit` nel frontend non controlla nulla ed esce sempre 0**. Il comando corretto è `npx tsc -p tsconfig.app.json --noEmit`.
> Nel backend `npx tsc --noEmit` è corretto, ma `backend/tsconfig.json` ha `"exclude": ["node_modules", "src/**/__tests__/**"]`: valida i service e le route, **non** i file di test.
> La suite backend è saltuariamente flaky in parallelo (`kanbanReminder.service.test.ts`); in caso di rosso inatteso rilanciare con `--sequence.concurrent=false` prima di indagare.

---

### Task 4.1: Aggiungere `actorId` a `KanbanEvent` e togliere la nota collegata dentro `broadcast()`

**Perché:** `cardWithAssigneeSelect` (`backend/src/services/kanban/helpers.ts:30-48`, il campo `note` è a riga 46) include `note: { id, title, userId }`. `getBoard` filtra quel campo per utente richiedente (`board.service.ts:197-238`, azzera `card.note` per le note a cui l'utente non ha accesso), ma `broadcast()` scrive lo stesso identico payload su **tutti** i socket della board: chi non ha accesso alla nota ne riceve comunque il titolo appena qualcuno crea o modifica una card collegata. Lo strip va fatto nell'unico chokepoint — `broadcast()` — e non nei 21 call site (`card.service.ts:34,85,234,349,441`, `column.service.ts:18,46,67,80`, `comments-chat.service.ts:57,113,179`, `linking.service.ts:122,165,213,235,453,475`, `kanbanSSE.ts:62`, `tasklist.service.ts:295`): una funzione invece di ventuno diff, e nessun call site futuro può dimenticarsene.

**Severità:** critical · **Effort:** M · **Rischio:** none — `kanbanSSE.ts` non è in TIER 1/2, ma è il chokepoint di ogni evento kanban: un errore qui rompe il real-time di tutta la feature (non i dati).

**File:**
- Modifica: `backend/src/services/kanbanSSE.ts:28` (type union) e `:102-113` (broadcast)
- Modifica: `backend/src/services/kanban/card.service.ts:34-38`, `:85`, `:234-240`, `:349`
- Modifica: `backend/src/services/kanban/linking.service.ts:122`, `:165`
- Modifica: `backend/src/services/__tests__/kanbanSSE.test.ts` — append in coda (file di 392 righe, ultimo `});` a riga 392)
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts:454-460`

**Interfacce:**
- Consuma: nessuna
- Produce: `export type KanbanEvent = KanbanEventBody & { actorId?: string }` — l'`actorId` opzionale su ogni evento SSE, consumato dalla 4.2. `disconnectUser` arriva nella 4.3, non qui.

- [ ] **Step 1 — Scrivere i test che falliscono, in coda a `backend/src/services/__tests__/kanbanSSE.test.ts`**

Appendere in fondo al file, dopo la chiusura di `describe('connection lifecycle', ...)` a riga 392:

```ts
// ---------------------------------------------------------------------------
// broadcast: linked-note stripping
// ---------------------------------------------------------------------------
describe('broadcast note stripping', () => {
  function parsePayload(res: { write: ReturnType<typeof vi.fn> }) {
    const call = res.write.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('data:')
    );
    return JSON.parse((call![0] as string).replace('data: ', '').trim());
  }

  it('removes the linked note from a card:created payload', () => {
    const res = createMockResponse();
    addConnection('board-note-c', res as any, createUser('user-1'));
    res.write.mockClear();

    broadcast('board-note-c', {
      type: 'card:created',
      boardId: 'board-note-c',
      card: {
        id: 'card-1',
        title: 'Card',
        noteId: 'note-1',
        note: { id: 'note-1', title: 'Secret note title', userId: 'other-user' },
      },
    });

    const parsed = parsePayload(res);
    expect(parsed.card).not.toHaveProperty('note');
    expect(parsed.card.noteId).toBe('note-1');
    expect(parsed.card.title).toBe('Card');
  });

  it('removes the linked note from a card:updated payload', () => {
    const res = createMockResponse();
    addConnection('board-note-u', res as any, createUser('user-1'));
    res.write.mockClear();

    broadcast('board-note-u', {
      type: 'card:updated',
      boardId: 'board-note-u',
      card: { id: 'card-2', note: { id: 'note-2', title: 'Secret' } },
    });

    expect(parsePayload(res).card).not.toHaveProperty('note');
  });

  it('keeps actorId on the serialized payload', () => {
    const res = createMockResponse();
    addConnection('board-actor', res as any, createUser('user-1'));
    res.write.mockClear();

    broadcast('board-actor', {
      type: 'card:deleted',
      boardId: 'board-actor',
      cardId: 'card-3',
      actorId: 'user-7',
    });

    expect(parsePayload(res).actorId).toBe('user-7');
  });
});
```

Il file ha già `beforeEach(() => vi.useFakeTimers())` a riga 25-27: il `setTimeout(…, 50)` di presence dentro `addConnection` non parte mai in questi test, quindi l'unica write `data:` è quella del `broadcast` sotto esame.

- [ ] **Step 2 — Vedere i test fallire**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanSSE.test.ts`

Atteso: FAIL. `Test Files 1 failed (1)` / `Tests 2 failed | 21 passed (23)`, con esattamente:

```
 FAIL  src/services/__tests__/kanbanSSE.test.ts > broadcast note stripping > removes the linked note from a card:created payload
AssertionError: expected { id: 'card-1', title: 'Card', …(2) } to not have property "note"
 FAIL  src/services/__tests__/kanbanSSE.test.ts > broadcast note stripping > removes the linked note from a card:updated payload
AssertionError: expected { id: 'card-2', …(1) } to not have property "note"
```

Il terzo test (`keeps actorId on the serialized payload`) passa già: `JSON.stringify` serializza qualunque proprietà extra anche se il tipo non la dichiara, e il tsconfig del backend esclude `src/**/__tests__/**` quindi nemmeno il typecheck si lamenta.

- [ ] **Step 3 — Cambiare il tipo `KanbanEvent` in `backend/src/services/kanbanSSE.ts`**

Sostituire la sola riga 28 (`export type KanbanEvent =`) con quattro righe, lasciando intatti i 14 membri della union alle righe 29-42:

```ts
/** `actorId` = the user who caused the event; clients drop their own echo. */
export type KanbanEvent = KanbanEventBody & { actorId?: string };

type KanbanEventBody =
```

Risultato: `type KanbanEventBody =` seguito da `  | { type: 'card:moved'; … }` (ex riga 29) fino a `  | { type: 'presence:update'; boardId: string; users: BoardUser[] };` (ex riga 42), indentazione compresa.

- [ ] **Step 4 — Aggiungere `stripNote` e usarla in `broadcast()`**

Sostituire integralmente `broadcast` (righe 102-113 nel file originale) con:

```ts
/**
 * `cardWithAssigneeSelect` includes the linked note (id + title). getBoard filters
 * that per requesting user; a broadcast cannot - it writes one payload to every
 * socket on the board. Strip it here, at the single chokepoint, instead of at each
 * of the 21 broadcast call sites.
 */
function stripNote(event: KanbanEvent): KanbanEvent {
  if (event.type === 'card:created' || event.type === 'card:updated') {
    const { note: _note, ...card } = event.card;
    return { ...event, card };
  }
  return event;
}

export function broadcast(boardId: string, event: KanbanEvent): void {
  const connections = boardConnections.get(boardId);
  if (!connections) return;
  const data = `data: ${JSON.stringify(stripNote(event))}\n\n`;
  for (const conn of connections.values()) {
    try {
      conn.res.write(data);
    } catch {
      /* will be cleaned up on close */
    }
  }
}
```

Lo spread preserva l'ordine delle chiavi rimanenti, quindi i test esistenti che confrontano `JSON.stringify(event)` esatto (righe 226-228, 260-261, 337-339, 358-359, 385) continuano a passare: le loro card non hanno la chiave `note`.

- [ ] **Step 5 — Vedere i test passare**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanSSE.test.ts`

Atteso: PASS. `Test Files 1 passed (1)` / `Tests 23 passed (23)`.

- [ ] **Step 6 — Popolare `actorId` dove l'attore è già in scope (`backend/src/services/kanban/card.service.ts`)**

Quattro modifiche puntuali.

`createCard`, righe 34-38 → :

```ts
  broadcast(column.boardId, {
    type: 'card:created',
    boardId: column.boardId,
    card,
    actorId,
  });
```

`updateCard`, riga 85 → :

```ts
  broadcast(boardId, { type: 'card:updated', boardId, card, actorId });
```

`moveCard`, righe 234-240 → :

```ts
  broadcast(boardId, {
    type: 'card:moved',
    boardId,
    cardId,
    toColumnId,
    position: newPosition,
    actorId,
  });
```

`deleteCard`, riga 349 → :

```ts
  broadcast(boardId, { type: 'card:deleted', boardId, cardId, actorId });
```

`actorId` è già un parametro di tutte e quattro le funzioni (`card.service.ts:14`, `:57`, `:179`, `:325`), quindi non serve toccare né le firme né le route.

- [ ] **Step 7 — Popolare `actorId` nei due `card:updated` di `backend/src/services/kanban/linking.service.ts`**

Le righe 122 e 165 sono identiche; sostituire entrambe con:

```ts
    broadcast(boardId, { type: 'card:updated', boardId, card: updatedCard, actorId });
```

`actorId` è già parametro di `linkNoteToCard` (`linking.service.ts:72`) e `unlinkNoteFromCard` (`:132`).

**Non** aggiungere `actorId` a `chat:message` (`comments-chat.service.ts:179`), `comment:added` (`:57`) e `comment:deleted` (`:113`): il client non ha una riconciliazione locale di chat e commenti, quindi sopprimere l'eco dell'autore gli nasconderebbe il proprio messaggio. Le colonne (`column.service.ts:18,46,67,80`) non ricevono affatto un attore nelle loro firme: aggiungerlo vorrebbe dire toccare 4 firme + 4 route per risparmiare un refetch — non vale.

- [ ] **Step 8 — Aggiornare l'assert esatto di `card:moved` in `backend/src/services/kanban/__tests__/card.service.test.ts`**

Righe 454-460: è un match esatto dell'oggetto e la chiamata sotto test è `await moveCard(card.id, targetColumn.id, 0, actor.id)`, quindi ora fallirebbe. Sostituire:

```ts
    expect(broadcast).toHaveBeenCalledWith(board.id, {
      type: 'card:moved',
      boardId: board.id,
      cardId: card.id,
      toColumnId: targetColumn.id,
      position: 0,
      actorId: actor.id,
    });
```

Gli altri assert su `broadcast` non richiedono modifiche: riga 412 usa `expect.objectContaining`, e le chiamate testate a riga 247 (`createCard(column.id, 'Broadcast Card')`), 621 (`deleteCard('card-del')`) e 732 (`unarchiveCard('card-arch')`) non passano un attore — `toHaveBeenCalledWith` usa la semantica di `toEqual`, che ignora le proprietà con valore `undefined`.

- [ ] **Step 9 — Verificare tutta l'area kanban**

Run: `cd backend && npx vitest run src/services/kanban src/services/__tests__/kanbanSSE.test.ts`

Atteso: PASS. `Test Files 6 passed (6)` / `Tests 141 passed (141)` — 138 di baseline (kanbanSSE 20, column 9, card 29, linking 39, board 17, comments-chat 24) più i 3 nuovi test di kanbanSSE.

- [ ] **Step 10 — Typecheck e lint**

Run: `cd backend && npx tsc --noEmit && npm run lint`

Atteso: `tsc` nessun output, exit 0. `npm run lint` termina con `✖ 63 problems (0 errors, 63 warnings)` — invariato rispetto alla baseline (il `_note` scartato nella destrutturazione non produce warning).

- [ ] **Step 11 — Commit**

```bash
git add backend/src/services/kanbanSSE.ts backend/src/services/kanban/card.service.ts backend/src/services/kanban/linking.service.ts backend/src/services/__tests__/kanbanSSE.test.ts backend/src/services/kanban/__tests__/card.service.test.ts
git commit -m "fix(kanban): strip linked note from SSE payloads and tag card events with actorId"
```

---

### Task 4.2: Filtrare lato client l'eco dei propri eventi

**Perché:** oggi chi muove una card riceve indietro il proprio `card:moved`: il client fa un GET completo della board in più (quello della mutation `onSuccess` a `useKanbanMutations.ts:110-111` + quello dell'evento SSE) e si accende addosso il pulse di highlight di 2 secondi (`useKanbanRealtime.ts:39-56`) pensato per segnalare le modifiche *degli altri*. Su una board condivisa attiva significa il doppio delle richieste e un flash visivo su ogni propria azione.

**Severità:** medium · **Effort:** S · **Rischio:** none

**File:**
- Modifica: `frontend/src/features/kanban/hooks/useKanbanRealtime.ts:29-31` (testa di `handleEvent`)
- Modifica: `frontend/src/features/kanban/types.ts:170` (aggiunta di `actorId` alla union)
- Crea: `frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`

**Interfacce:**
- Consuma: `actorId?: string` su ogni evento SSE (Task 4.1)
- Produce: `frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx` con l'helper `sseStream(payloads: unknown[]): ReadableStream<Uint8Array>` e i mock hoisted `mockDb` / `mockAuthStore` / `mockQueryClient`, estesi dalla 4.5

- [ ] **Step 1 — Creare il file di test (fallisce)**

L'hook prende l'utente corrente dallo stesso store da cui prende già il token: `useAuthStore` è importato a `useKanbanRealtime.ts:4` e usato come `useAuthStore.getState().token` a riga 76. Si legge `.user?.id` allo stesso modo, dentro `handleEvent`, così non cambiano le dipendenze della `useCallback` (riga 70: `[boardId, queryClient]`) e la connessione SSE non si ricrea.

Creare `frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockDb, mockAuthStore, mockQueryClient } = vi.hoisted(() => {
  const createTable = () => ({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(1),
    where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: vi.fn().mockResolvedValue(0) })) })),
  });
  return {
    mockDb: { kanbanCards: createTable(), kanbanColumns: createTable() },
    mockAuthStore: { getState: vi.fn(() => ({ token: 'test-token', user: { id: 'user-1' } })) },
    mockQueryClient: { invalidateQueries: vi.fn() },
  };
});

vi.mock('../../../../lib/db', () => ({ db: mockDb }));
vi.mock('../../../../store/authStore', () => ({ useAuthStore: mockAuthStore }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));

import { useKanbanRealtime } from '../useKanbanRealtime';

/** Feeds the hook's fetch-based SSE reader one `data: {...}` frame per payload. */
function sseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of payloads) controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthStore.getState.mockReturnValue({ token: 'test-token', user: { id: 'user-1' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useKanbanRealtime', () => {
  it('invalidates the board query on an event from another user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream([{ type: 'card:deleted', boardId: 'board-1', cardId: 'card-9', actorId: 'user-2' }]),
    }));

    renderHook(() => useKanbanRealtime('board-1'));

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['kanban-board', 'board-1'],
      });
    });
  });

  it('ignores the echo of an event this user caused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream([{ type: 'card:deleted', boardId: 'board-1', cardId: 'card-9', actorId: 'user-1' }]),
    }));

    renderHook(() => useKanbanRealtime('board-1'));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(mockDb.kanbanCards.delete).not.toHaveBeenCalled();
  });
});
```

> **Se il file esiste già** perché lo Stage 0.4 (reconnect SSE) lo ha creato per i suoi test: l'harness sopra (import, `vi.hoisted`, i tre `vi.mock`, `sseStream`, `beforeEach`, `afterEach`) è identico a quello — **non riscriverlo**. Tieni i suoi `describe` e appendi in coda solo questo blocco, poi aggiusta i conteggi degli Step 2 e 5 di `+2` sul totale che il file ha già:
> ```tsx
> describe('useKanbanRealtime echo filter', () => {
>   it('invalidates the board query on an event from another user', async () => {
>     vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
>       ok: true,
>       body: sseStream([{ type: 'card:deleted', boardId: 'board-1', cardId: 'card-9', actorId: 'user-2' }]),
>     }));
>
>     renderHook(() => useKanbanRealtime('board-1'));
>
>     await waitFor(() => {
>       expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
>         queryKey: ['kanban-board', 'board-1'],
>       });
>     });
>   });
>
>   it('ignores the echo of an event this user caused', async () => {
>     vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
>       ok: true,
>       body: sseStream([{ type: 'card:deleted', boardId: 'board-1', cardId: 'card-9', actorId: 'user-1' }]),
>     }));
>
>     renderHook(() => useKanbanRealtime('board-1'));
>     await new Promise((r) => setTimeout(r, 50));
>
>     expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
>     expect(mockDb.kanbanCards.delete).not.toHaveBeenCalled();
>   });
> });
> ```

- [ ] **Step 2 — Vedere il secondo test fallire**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`

Atteso: FAIL. `Test Files 1 failed (1)` / `Tests 1 failed | 1 passed (2)`, con esattamente:

```
 FAIL  src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx > useKanbanRealtime > ignores the echo of an event this user caused
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 2 times
```

Le due chiamate sono `['kanban-board','board-1']` e `['kanban-card-activities','card-9']`.

- [ ] **Step 3 — Dichiarare `actorId` nella union frontend**

In `frontend/src/features/kanban/types.ts`, sostituire la sola riga 170 (`export type KanbanSSEEvent =`) con:

```ts
export type KanbanSSEEvent = KanbanSSEEventBody & { actorId?: string };

type KanbanSSEEventBody =
```

I 13 membri della union (righe 171-183) restano invariati. L'allineamento completo con la union backend è la Task 4.6.

- [ ] **Step 4 — Aggiungere il filtro in testa a `handleEvent`**

In `frontend/src/features/kanban/hooks/useKanbanRealtime.ts`, sostituire le righe 29-31 con:

```ts
  const handleEvent = useCallback(
    (event: KanbanSSEEvent) => {
      // Skip events this user caused: the mutation already updated the cache
      const currentUserId = useAuthStore.getState().user?.id;
      if (event.actorId && event.actorId === currentUserId) return;

      if (event.type === 'presence:update') {
```

Il resto del corpo non cambia. Il guard sta *prima* di `presence:update` di proposito: nessun evento con `actorId` è un presence (la 4.1 lo mette solo sugli eventi card), quindi la presenza non viene mai filtrata.

- [ ] **Step 5 — Vedere i test passare**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`

Atteso: PASS. `Test Files 1 passed (1)` / `Tests 2 passed (2)`.

- [ ] **Step 6 — Typecheck e lint**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit && npm run lint`

Atteso: `tsc` nessun output. `npm run lint` termina con `✖ 52 problems (0 errors, 52 warnings)` — invariato rispetto alla baseline.

- [ ] **Step 7 — Commit**

```bash
git add frontend/src/features/kanban/hooks/useKanbanRealtime.ts frontend/src/features/kanban/types.ts frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx
git commit -m "perf(kanban): drop self-echo SSE events using actorId"
```

---

### Task 4.3: `disconnectUser()` e chiusura degli stream sul revoke della board

**Perché:** `revokeKanbanBoardShare` (`backend/src/services/sharing.service.ts:620-650`) cancella la riga `SharedKanbanBoard` ma non tocca la connessione SSE già aperta. Finché il collaboratore revocato lascia la tab aperta continua a ricevere in tempo reale card, commenti e chat della board — indefinitamente, perché lo stream ha un heartbeat ogni 30s (`kanbanSSE.ts:72-78`) e non riverifica mai i permessi dopo il connect.

**Severità:** high · **Effort:** S · **Rischio:** none — `sharing.service.ts` non è in TIER 1/2; la chiamata è additiva e non tocca il flusso di cancellazione dello share.

**File:**
- Modifica: `backend/src/services/kanbanSSE.ts` (nuova export prima di `broadcast`)
- Modifica: `backend/src/services/sharing.service.ts:9` (import) e `:640` (call, fra il `}` del catch a riga 639 e il commento a riga 641)
- Modifica: `backend/src/services/__tests__/kanbanSSE.test.ts:3-8` (import), `:14-19` (helper) + append in coda
- Modifica: `backend/src/services/__tests__/sharing.service.test.ts:3-13` (import), `:28-34` (mock), append in coda (file di 820 righe)

**Interfacce:**
- Consuma: nessuna
- Produce: `export function disconnectUser(boardId: string, userId: string): void`

- [ ] **Step 1 — Dare un `end()` realistico al mock di ServerResponse**

In `backend/src/services/__tests__/kanbanSSE.test.ts`, sostituire l'helper alle righe 14-19 con:

```ts
/** Creates a mock ServerResponse that tracks writes and supports 'close' event. */
function createMockResponse(): EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  (emitter as any).write = vi.fn();
  // A real ServerResponse emits 'close' when ended
  (emitter as any).end = vi.fn(() => emitter.emit('close'));
  return emitter as any;
}
```

E aggiungere `disconnectUser` all'import delle righe 3-8, che diventa:

```ts
import {
  addConnection,
  broadcast,
  disconnectUser,
  getPresenceUsers,
} from '../kanbanSSE';
```

- [ ] **Step 2 — Scrivere i test che falliscono, in coda allo stesso file**

```ts
// ---------------------------------------------------------------------------
// disconnectUser
// ---------------------------------------------------------------------------
describe('disconnectUser', () => {
  it('ends every connection belonging to the user and leaves the others open', () => {
    const revokedTab1 = createMockResponse();
    const revokedTab2 = createMockResponse();
    const otherUser = createMockResponse();

    addConnection('board-kick', revokedTab1 as any, createUser('user-revoked'));
    addConnection('board-kick', revokedTab2 as any, createUser('user-revoked'));
    addConnection('board-kick', otherUser as any, createUser('user-stays'));

    disconnectUser('board-kick', 'user-revoked');

    expect(revokedTab1.end).toHaveBeenCalled();
    expect(revokedTab2.end).toHaveBeenCalled();
    expect(otherUser.end).not.toHaveBeenCalled();

    const remaining = getPresenceUsers('board-kick');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('user-stays');
  });

  it('no longer writes broadcasts to the disconnected user', () => {
    const revoked = createMockResponse();
    const staying = createMockResponse();

    addConnection('board-kick2', revoked as any, createUser('user-revoked'));
    addConnection('board-kick2', staying as any, createUser('user-stays'));

    disconnectUser('board-kick2', 'user-revoked');
    revoked.write.mockClear();
    staying.write.mockClear();

    broadcast('board-kick2', { type: 'board:updated', boardId: 'board-kick2' });

    expect(revoked.write).not.toHaveBeenCalled();
    expect(staying.write).toHaveBeenCalled();
  });

  it('does nothing for a board with no connections', () => {
    expect(() => disconnectUser('board-none', 'user-x')).not.toThrow();
  });
});
```

- [ ] **Step 3 — Vedere i test fallire**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanSSE.test.ts`

Atteso: FAIL. `Test Files 1 failed (1)` / `Tests 3 failed | 23 passed (26)` (se la 4.1 è già fatta; altrimenti `5 failed | 21 passed (26)`, con in più i 2 rossi della 4.1). I tre rossi nuovi sono:

```
 FAIL  src/services/__tests__/kanbanSSE.test.ts > disconnectUser > ends every connection belonging to the user and leaves the others open
TypeError: (0 , __vite_ssr_import_2__.disconnectUser) is not a function
 FAIL  src/services/__tests__/kanbanSSE.test.ts > disconnectUser > no longer writes broadcasts to the disconnected user
TypeError: (0 , __vite_ssr_import_2__.disconnectUser) is not a function
 FAIL  src/services/__tests__/kanbanSSE.test.ts > disconnectUser > does nothing for a board with no connections
AssertionError: expected [Function] to not throw an error but 'TypeError: (0 , __vite_ssr_import_2__…' was thrown
```

- [ ] **Step 4 — Implementare `disconnectUser` in `backend/src/services/kanbanSSE.ts`**

Inserire subito prima di `export function broadcast(...)`:

```ts
/** Kick every open stream of a user who just lost access to the board. */
export function disconnectUser(boardId: string, userId: string): void {
  const connections = boardConnections.get(boardId);
  if (!connections) return;
  for (const conn of [...connections.values()]) {
    // res.end() fires 'close', whose handler clears the heartbeat and the map entry
    if (conn.user.id === userId) conn.res.end();
  }
}
```

Otto righe e nessuna gestione di cleanup duplicata: l'handler `res.on('close')` registrato in `addConnection` (righe 83-95) già ferma l'heartbeat, rimuove l'entry dalla mappa, elimina la board quando resta a zero connessioni e ribroadcasta la presence. Lo snapshot `[...connections.values()]` serve perché `res.end()` muta la mappa durante l'iterazione.

- [ ] **Step 5 — Vedere i test passare**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanSSE.test.ts`

Atteso: PASS. `Test Files 1 passed (1)` / `Tests 26 passed (26)` (20 di baseline + 3 dalla 4.1 + 3 nuovi).

- [ ] **Step 6 — Scrivere i test del wiring in `backend/src/services/__tests__/sharing.service.test.ts`**

`revokeKanbanBoardShare` non è oggi coperta da nessun test. Tre modifiche più un append.

(a) Aggiungere il mock subito dopo quello di `notification.service` (righe 28-30):

```ts
vi.mock('../kanbanSSE', () => ({
  disconnectUser: vi.fn(),
}));
```

(b) Aggiungere `revokeKanbanBoardShare` all'import block (righe 3-13), che diventa:

```ts
import {
  shareNote,
  revokeNoteShare,
  getAcceptedSharedNotes,
  getSharedNotes,
  shareNotebook,
  revokeNotebookShare,
  getSharedNotebooks,
  respondToShareById,
  updateSharedNoteContent,
  revokeKanbanBoardShare,
} from '../sharing.service';
```

(c) Aggiungere l'import del mock subito sopra riga 32 (`import * as auditService from '../audit.service';`):

```ts
import { disconnectUser } from '../kanbanSSE';
```

(d) Appendere in coda al file:

```ts
// ===========================================================================
// revokeKanbanBoardShare
// ===========================================================================

describe('revokeKanbanBoardShare', () => {
  const BOARD_ID = 'board-id-1';

  it('disconnects the revoked user open SSE streams on that board', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: OWNER_ID });
    prismaMock.sharedKanbanBoard.delete.mockResolvedValue({ id: 'share-1' });
    prismaMock.kanbanReminder.deleteMany.mockResolvedValue({ count: 0 });

    await revokeKanbanBoardShare(OWNER_ID, BOARD_ID, TARGET_USER_ID);

    expect(disconnectUser).toHaveBeenCalledWith(BOARD_ID, TARGET_USER_ID);
  });

  it('does not disconnect anyone when the caller is not the owner', async () => {
    prismaMock.kanbanBoard.findUnique.mockResolvedValue({ ownerId: 'someone-else' });

    await expect(
      revokeKanbanBoardShare(OWNER_ID, BOARD_ID, TARGET_USER_ID)
    ).rejects.toThrow('errors.common.notTheOwner');

    expect(disconnectUser).not.toHaveBeenCalled();
  });
});
```

`OWNER_ID` (`'owner-id-1'`) e `TARGET_USER_ID` (`'target-user-id-2'`) sono già definiti a riga 42-43; `beforeEach(() => vi.clearAllMocks())` a riga 67-69 azzera i contatori fra un test e l'altro. `prismaMock` (riga 36) espone già `kanbanBoard.findUnique`, `sharedKanbanBoard.delete` e `kanbanReminder.deleteMany` dal mock base di `backend/src/__tests__/setup.ts` (righe 190-198, 237-247, 257-268): nessuna augmentation necessaria.

- [ ] **Step 7 — Vedere il primo dei due fallire**

Run: `cd backend && npx vitest run src/services/__tests__/sharing.service.test.ts`

Atteso: FAIL. `Test Files 1 failed (1)` / `Tests 1 failed | 44 passed (45)`, con:

```
 FAIL  src/services/__tests__/sharing.service.test.ts > revokeKanbanBoardShare > disconnects the revoked user open SSE streams on that board
AssertionError: expected "disconnectUser" to be called with arguments: [ 'board-id-1', 'target-user-id-2' ]
Number of calls: 0
```

Il secondo test passa già: il `ForbiddenError('errors.common.notTheOwner')` esiste da prima (`sharing.service.ts:630`, e `ForbiddenError` in `utils/errors.ts:12-14` usa la chiave come `message`).

- [ ] **Step 8 — Wirare la chiamata in `backend/src/services/sharing.service.ts`**

Aggiungere l'import statico subito dopo riga 9 (`import { createFriendship, getFriendship } from './friendship.service';`):

```ts
import { disconnectUser } from './kanbanSSE';
```

Import statico e non dinamico: `kanbanSSE.ts` importa solo `http`, nessun rischio di ciclo (il `await import('./kanbanReminder.service')` a riga 643 resta dinamico com'è).

Poi, dentro `revokeKanbanBoardShare`, inserire fra la `}` che chiude il `catch` del delete (riga 639) e il commento `// Clean up kanban reminders for the revoked user` (riga 641):

```ts
  // Kick any SSE stream the revoked user still has open on this board
  disconnectUser(boardId, targetUserId);
```

Dopo il delete e non prima: se il delete lancia qualcosa di inatteso, l'utente non deve venire disconnesso da una board che ha ancora.

- [ ] **Step 9 — Vedere i test passare**

Run: `cd backend && npx vitest run src/services/__tests__/sharing.service.test.ts src/services/__tests__/kanbanSSE.test.ts`

Atteso: PASS. `Test Files 2 passed (2)` / `Tests 71 passed (71)` (45 sharing + 26 kanbanSSE).

- [ ] **Step 10 — Typecheck**

Run: `cd backend && npx tsc --noEmit`

Atteso: nessun output, exit 0.

- [ ] **Step 11 — Commit**

```bash
git add backend/src/services/kanbanSSE.ts backend/src/services/sharing.service.ts backend/src/services/__tests__/kanbanSSE.test.ts backend/src/services/__tests__/sharing.service.test.ts
git commit -m "fix(kanban): close SSE streams of a user whose board share is revoked"
```

---

### Task 4.4: Emettere `board:updated` da update, delete e dalle quattro route cover/avatar

**Perché:** cambiare titolo, descrizione, cover o avatar di una board condivisa — o cancellarla — non produce nessun evento SSE. Gli altri collaboratori vedono il vecchio titolo e la vecchia copertina finché non ricaricano, e su una board cancellata restano su una pagina fantasma con card che non esistono più.

**Severità:** medium · **Effort:** M · **Rischio:** none

Verificato prima di scrivere: **il tipo `board:updated` esiste già** nella union backend a `backend/src/services/kanbanSSE.ts:41` ed è già prodotto da `linking.service.ts:213`, `:235`, `:453`, `:475`. **Il client lo gestisce già**: non ha un `case` dedicato, cade nel ramo `else` di `useKanbanRealtime.ts:37-68`, non trova un `case` in `updateDexieFromSSE` (switch alle righe 137-238) e finisce sulla `invalidateQueries` della board query a riga 62 — esattamente il comportamento voluto. `board.service.ts` invece **non importa `broadcast`**: verificato, gli import sono le righe 1-5 e sono `prisma`, `logger`, gli errori, `./helpers`, `./card.service`.

Le quattro route cover/avatar in `backend/src/routes/kanban.ts` scrivono su Prisma direttamente, senza passare da `board.service.ts`:

| Route | Righe handler | Update Prisma | `return` |
|---|---|---|---|
| `POST /boards/:id/cover` | 168-222 | 216-219 | 221 |
| `DELETE /boards/:id/cover` | 224-245 | 239-242 | 244 |
| `POST /boards/:id/avatar` | 249-303 | 297-300 | 302 |
| `DELETE /boards/:id/avatar` | 305-326 | 320-323 | 325 |

**Decisione su `board:deleted`:** non lo aggiungo, riuso `board:updated`. `board:deleted` non esiste in nessuna delle due union, e il ramo `else` del client su `board:updated` fa un solo lavoro: invalidare la board query. Il refetch su una board cancellata torna 404, `useKanbanBoard` ha `retry: false` (`useKanbanBoard.ts:73`) quindi `isError` diventa `true`, e `KanbanBoardPage.tsx:65-69` fa già `navigate('/kanban', { replace: true })`. Il collaboratore viene quindi buttato fuori correttamente senza un nuovo tipo di evento, un nuovo `case` e una nuova chiave i18n.

**File:**
- Modifica: `backend/src/services/kanban/board.service.ts:4` (import), `:252-269` (updateBoard), `:271-273` (deleteBoard)
- Modifica: `backend/src/routes/kanban.ts:8` (import), `:153`, `:162`, `:215-221`, `:239-244`, `:296-302`, `:320-325`
- Modifica: `backend/src/services/kanban/__tests__/board.service.test.ts:13-15` (mock), `:26` (import), `:317-352` (updateBoard), `:354-380` (deleteBoard)

**Interfacce:**
- Consuma: `broadcast(boardId: string, event: KanbanEvent): void` da `../kanbanSSE`; `actorId?: string` su `KanbanEvent` (Task 4.1)
- Produce: `updateBoard(boardId: string, data: { title?: string; description?: string | null }, actorId?: string)` e `deleteBoard(boardId: string, actorId?: string)`

- [ ] **Step 1 — Aggiungere il mock di kanbanSSE e i test che falliscono**

In `backend/src/services/kanban/__tests__/board.service.test.ts`, subito dopo il mock di `../card.service` (righe 13-15):

```ts
vi.mock('../../kanbanSSE', () => ({
  broadcast: vi.fn(),
}));
```

E l'import, subito prima del blocco `import { makeUser, makeKanbanBoard, ... } from '../../../__tests__/factories';` che inizia a riga 26:

```ts
import { broadcast } from '../../kanbanSSE';
```

Aggiungere un test dentro `describe('updateBoard', ...)` (apre a riga 317), prima di `it('propagates Prisma error when board not found', ...)` (riga 340):

```ts
    it('broadcasts board:updated with the actor', async () => {
      const board = makeKanbanBoard();
      m(prisma.kanbanBoard.update).mockResolvedValue({
        ...board,
        shares: [],
        owner: { id: board.ownerId, name: 'User', email: 'user@test.com', color: null, avatarUrl: null },
        note: null,
      } as any);

      await updateBoard(board.id, { title: 'New Title' }, 'actor-1');

      expect(broadcast).toHaveBeenCalledWith(board.id, {
        type: 'board:updated',
        boardId: board.id,
        actorId: 'actor-1',
      });
    });
```

E uno dentro `describe('deleteBoard', ...)` (apre a riga 354), prima di `it('propagates Prisma error when board not found', ...)` (riga 368):

```ts
    it('broadcasts board:updated so collaborators refetch and get routed out', async () => {
      const board = makeKanbanBoard();
      m(prisma.kanbanBoard.delete).mockResolvedValue(board);

      await deleteBoard(board.id, 'actor-1');

      expect(broadcast).toHaveBeenCalledWith(board.id, {
        type: 'board:updated',
        boardId: board.id,
        actorId: 'actor-1',
      });
    });
```

`m` è `vi.mocked` (alias definito a riga 40 del file) e `makeKanbanBoard` viene da `backend/src/__tests__/factories.ts`, già importato a riga 28.

- [ ] **Step 2 — Vedere i test fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts`

Atteso: FAIL. `Test Files 1 failed (1)` / `Tests 2 failed | 17 passed (19)`, con su entrambi i nuovi test:

```
AssertionError: expected "broadcast" to be called with arguments: [ 'board-…', { type: 'board:updated', … } ]
Number of calls: 0
```

- [ ] **Step 3 — Implementare in `backend/src/services/kanban/board.service.ts`**

Aggiungere l'import subito prima di quello di `./helpers` (riga 4):

```ts
import { broadcast } from '../kanbanSSE';
```

Sostituire integralmente `updateBoard` e `deleteBoard` (righe 252-273):

```ts
export async function updateBoard(
  boardId: string,
  data: { title?: string; description?: string | null },
  actorId?: string
) {
  const board = await prisma.kanbanBoard.update({
    where: { id: boardId },
    data,
    include: {
      shares: {
        include: {
          user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      },
      owner: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
      note: { select: { id: true, title: true, userId: true } },
    },
  });

  broadcast(boardId, { type: 'board:updated', boardId, actorId });

  return board;
}

export async function deleteBoard(boardId: string, actorId?: string) {
  const board = await prisma.kanbanBoard.delete({ where: { id: boardId } });

  // Collaborators still on the board refetch, get a 404 and are routed back to the list
  broadcast(boardId, { type: 'board:updated', boardId, actorId });

  return board;
}
```

Se una stage precedente ha già esteso `deleteBoard` (per esempio con l'unlink dei file cover/avatar da disco), **non sostituire il corpo**: aggiungere solo il parametro `actorId?: string` alla firma e la riga `broadcast(boardId, { type: 'board:updated', boardId, actorId });` dopo la `prisma.kanbanBoard.delete`, prima del `return`.

- [ ] **Step 4 — Vedere i test passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts`

Atteso: PASS. `Test Files 1 passed (1)` / `Tests 19 passed (19)`.

- [ ] **Step 5 — Passare l'attore dalle due route board in `backend/src/routes/kanban.ts`**

Estendere l'import di riga 8:

```ts
import { addConnection, broadcast } from '../services/kanbanSSE';
```

Riga 153 → :

```ts
    return await kanbanService.updateBoard(id, data, request.user.id);
```

Riga 162 → :

```ts
    await kanbanService.deleteBoard(id, request.user.id);
```

- [ ] **Step 6 — Emettere l'evento dalle quattro route cover/avatar**

`POST /boards/:id/cover`, sostituire le righe 215-221 con:

```ts
    const coverUrl = `/uploads/kanban/${filename}`;
    await prisma.kanbanBoard.update({
      where: { id },
      data: { coverImage: coverUrl },
    });
    broadcast(id, { type: 'board:updated', boardId: id, actorId: request.user.id });

    return { coverImage: coverUrl };
```

`DELETE /boards/:id/cover`, sostituire le righe 239-244 con:

```ts
    await prisma.kanbanBoard.update({
      where: { id },
      data: { coverImage: null },
    });
    broadcast(id, { type: 'board:updated', boardId: id, actorId: request.user.id });

    return { success: true };
```

`POST /boards/:id/avatar`, sostituire le righe 296-302 con:

```ts
    const avatarUrl = `/uploads/kanban/avatars/${filename}`;
    await prisma.kanbanBoard.update({
      where: { id },
      data: { avatarUrl },
    });
    broadcast(id, { type: 'board:updated', boardId: id, actorId: request.user.id });

    return { avatarUrl };
```

`DELETE /boards/:id/avatar`, sostituire le righe 320-325 con:

```ts
    await prisma.kanbanBoard.update({
      where: { id },
      data: { avatarUrl: null },
    });
    broadcast(id, { type: 'board:updated', boardId: id, actorId: request.user.id });

    return { success: true };
```

- [ ] **Step 7 — Verifica delle route (non coperte da unit test: sono handler Fastify inline che scrivono su disco)**

**Verifica:**

Run: `cd backend && grep -c "broadcast(id, { type: 'board:updated', boardId: id, actorId: request.user.id });" src/routes/kanban.ts`

Atteso: `4`.

Run: `cd backend && npx tsc --noEmit`

Atteso: nessun output, exit 0 — conferma che `request.user.id` è tipato in tutte e quattro le route (le due `DELETE` hanno firma `async (request)`, le due `POST` `async (request, reply)`) e che le nuove firme di `updateBoard`/`deleteBoard` combaciano con i chiamanti.

- [ ] **Step 8 — Regressione backend completa**

Run: `cd backend && npx vitest run --sequence.concurrent=false`

Atteso: PASS. `Test Files 61 passed (61)` / `Tests 1093 passed (1093)` — 1083 di baseline + 3 (4.1 kanbanSSE) + 3 (4.3 kanbanSSE) + 2 (4.3 sharing) + 2 (4.4 board). Se la 4.1 e/o la 4.3 non sono ancora state fatte, sottrarre i rispettivi delta.

- [ ] **Step 9 — Commit**

```bash
git add backend/src/services/kanban/board.service.ts backend/src/routes/kanban.ts backend/src/services/kanban/__tests__/board.service.test.ts
git commit -m "feat(kanban): broadcast board:updated on board edit, delete, cover and avatar changes"
```

---

### Task 4.5: Fare invalidare la board query all'evento `connected`

**Perché:** `useKanbanRealtime.ts:35-37` gestisce `connected` con un commento `// No action needed`. Ogni riconnessione (rete che cade, laptop che si sveglia, deploy del backend) riparte quindi con lo stato che aveva prima della caduta: tutte le card mosse, create o cancellate nel frattempo restano invisibili finché l'utente non ricarica la pagina o non arriva un altro evento. È il pezzo che rende utile il reconnect dello Stage 0.4: senza questo, riconnettersi bene serve a poco perché si riprende comunque da uno stato vecchio. Funziona anche da solo con il retry a 5 secondi già presente a `useKanbanRealtime.ts:116-119` (`reconnectTimeout = setTimeout(connect, 5000)` nel `catch`).

**Severità:** high · **Effort:** S · **Rischio:** none

**File:**
- Modifica: `frontend/src/features/kanban/hooks/useKanbanRealtime.ts:35-37`
- Modifica: `frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx` (creato nella 4.2)

**Interfacce:**
- Consuma: l'helper `sseStream(payloads: unknown[]): ReadableStream<Uint8Array>` e i mock hoisted `mockQueryClient` / `mockAuthStore` / `mockDb` del file di test creato nella 4.2
- Produce: nessuna

- [ ] **Step 1 — Aggiungere il test che fallisce**

Dentro il `describe('useKanbanRealtime', ...)` di `frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`, in coda agli altri `it`:

```tsx
  it('invalidates the board query when the stream reconnects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream([{ type: 'connected' }]),
    }));

    renderHook(() => useKanbanRealtime('board-1'));

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['kanban-board', 'board-1'],
      });
    });
  });
```

- [ ] **Step 2 — Vedere il test fallire**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`

Atteso: FAIL. `Test Files 1 failed (1)` / `Tests 1 failed | 2 passed (3)`, con:

```
 FAIL  src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx > useKanbanRealtime > invalidates the board query when the stream reconnects
AssertionError: expected "vi.fn()" to be called with arguments: [ { queryKey: [ …(2) ] } ]
Number of calls: 0
```

- [ ] **Step 3 — Sostituire il no-op in `frontend/src/features/kanban/hooks/useKanbanRealtime.ts`**

Le righe 35-37 diventano:

```ts
      } else if (event.type === 'connected') {
        // Recover anything missed while disconnected
        queryClient.invalidateQueries({ queryKey: queryKeys.kanban.board(boardId!) });
      } else {
```

Nessun import nuovo: `queryKeys` è già importato a riga 3 e `queryClient` è già nelle dipendenze della `useCallback` (riga 70).

- [ ] **Step 4 — Vedere il test passare**

Run: `cd frontend && npx vitest run src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx`

Atteso: PASS. `Test Files 1 passed (1)` / `Tests 3 passed (3)`.

- [ ] **Step 5 — Verifica manuale end-to-end (nessun unit test copre il ciclo drop/reconnect reale)**

**Verifica:** avviare backend (`cd backend && npm run dev`) e frontend (`cd frontend && npm run dev`), aprire la stessa board kanban in due browser diversi con due utenti che la condividono. Nel browser A: DevTools → Network → Offline. Nel browser B spostare una card in un'altra colonna. Rimettere online il browser A e attendere il retry (fino a 5s). Atteso: la card in A si riposiziona da sola senza refresh manuale, e nel tab Network di A compare una `GET /api/kanban/boards/<id>` subito dopo la nuova `GET /api/kanban/boards/<id>/events`.

- [ ] **Step 6 — Commit**

```bash
git add frontend/src/features/kanban/hooks/useKanbanRealtime.ts frontend/src/features/kanban/hooks/__tests__/useKanbanRealtime.test.tsx
git commit -m "fix(kanban): refetch the board on SSE reconnect to recover missed events"
```

---

### Task 4.6: Allineare la union di eventi frontend a quella backend

**Perché:** le due union sono state scritte a mano e sono divergute. Un evento che il backend manda ma il frontend non dichiara arriva comunque a runtime (è `JSON.parse` più un cast a `useKanbanRealtime.ts:137`), quindi il bug non si vede: si vede solo quando qualcuno legge il tipo, si fida, e scrive codice sbagliato. Peggio, dopo la 4.1 il tipo frontend *mente*: dichiara `card.note` presente su un payload da cui `broadcast()` lo ha appena tolto.

**Severità:** low · **Effort:** S · **Rischio:** none

**Prerequisiti:** la 4.2 (che introduce `KanbanSSEEventBody`) e la 4.5 (che aggiunge una riga in `handleEvent`) devono essere già fatte — i numeri di riga di `useKanbanRealtime.ts` citati sotto sono quelli **dopo** entrambe.

Diff campo per campo fra `backend/src/services/kanbanSSE.ts:28-42` (numerazione pre-4.1) e `frontend/src/features/kanban/types.ts:170-183`:

| Evento | Backend | Frontend | Discrepanza |
|---|---|---|---|
| `connected` | assente | `{ type: 'connected' }` | solo FE — corretto: la route lo scrive a mano a `routes/kanban.ts:384`, non passa da `broadcast()`. Resta. |
| `card:moved` | `boardId, cardId, toColumnId, position` | idem | nessuna |
| `card:created` | `card: Record<string, unknown>` | `card: KanbanCard` | il FE dichiara `note: {...} \| null` (`types.ts:70`) ma dopo la 4.1 la chiave non è più sul filo |
| `card:updated` | `card: Record<string, unknown>` | `card: KanbanCard` | idem |
| `card:deleted` | `boardId, cardId` | idem | nessuna |
| `card:unarchived` | presente (`kanbanSSE.ts:33`, emesso da `card.service.ts:441`) | **assente** | da aggiungere |
| `column:created` | `column: Record<string, unknown>` | `column: KanbanColumn` | nessuna: `KanbanColumn` non ha campi ad accesso ristretto |
| `column:updated` | idem | idem | nessuna |
| `column:deleted` | `boardId, columnId` | idem | nessuna |
| `columns:reordered` | `columns: { id, position }[]` | idem | nessuna |
| `comment:added` | `comment: Record<string, unknown>` | `comment: KanbanComment` | nessuna |
| `comment:deleted` | `boardId, cardId, commentId` | idem | nessuna |
| `chat:message` | `message: Record<string, unknown>` | `message: KanbanBoardChatMessage` | nessuna |
| `board:updated` | presente (`kanbanSSE.ts:41`, emesso da `linking.service.ts:213,235,453,475` e, dopo la 4.4, da `board.service.ts` e dalle 4 route) | **assente** | da aggiungere |
| `presence:update` | `users: BoardUser[]` | `users: BoardPresenceUser[]` | nessuna: i due tipi hanno gli stessi 4 campi con gli stessi tipi (`kanbanSSE.ts:5-10` vs `types.ts:117-122`) |

**Lo switch dell'handler non ha bisogno di nuovi `case`.** `card:unarchived` e `board:updated` cadono entrambi nel ramo `else` di `useKanbanRealtime.ts:37`, che invalida la board query: per `board:updated` è tutto quel che serve, e per `card:unarchived` la card riappare col refetch, che riscrive comunque anche Dexie (`useKanbanBoard.ts:48-59`). Nessun `case` nuovo in `updateDexieFromSSE` (switch alle righe 137-238 pre-4.2/4.5).

**File:**
- Modifica: `frontend/src/features/kanban/types.ts:170-185` (il blocco già toccato dalla 4.2)
- Modifica: `frontend/src/features/kanban/hooks/useKanbanRealtime.ts:158`, `:184` (le uniche due occorrenze di `note: card.note,` nel file; a HEAD erano 153 e 179, la 4.2 aggiunge 4 righe e la 4.5 una)

**Interfacce:**
- Consuma: `export type KanbanSSEEvent = KanbanSSEEventBody & { actorId?: string }` (Task 4.2)
- Produce: `type SSECard = Omit<KanbanCard, 'note'>` (interno a `types.ts`, non esportato)

- [ ] **Step 1 — Riscrivere la union in `frontend/src/features/kanban/types.ts`**

Sostituire integralmente il blocco che inizia a riga 170 (`export type KanbanSSEEvent = KanbanSSEEventBody & { actorId?: string };` dopo la 4.2) e finisce con `| { type: 'presence:update'; boardId: string; users: BoardPresenceUser[] };`, con:

```ts
/** broadcast() strips the linked note: it cannot be access-filtered per socket. */
type SSECard = Omit<KanbanCard, 'note'>;

export type KanbanSSEEvent = KanbanSSEEventBody & { actorId?: string };

type KanbanSSEEventBody =
  | { type: 'connected' }
  | { type: 'card:moved'; boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created'; boardId: string; card: SSECard }
  | { type: 'card:updated'; boardId: string; card: SSECard }
  | { type: 'card:deleted'; boardId: string; cardId: string }
  | { type: 'card:unarchived'; boardId: string; cardId: string }
  | { type: 'column:created'; boardId: string; column: KanbanColumn }
  | { type: 'column:updated'; boardId: string; column: KanbanColumn }
  | { type: 'column:deleted'; boardId: string; columnId: string }
  | { type: 'columns:reordered'; boardId: string; columns: { id: string; position: number }[] }
  | { type: 'comment:added'; boardId: string; cardId: string; comment: KanbanComment }
  | { type: 'comment:deleted'; boardId: string; cardId: string; commentId: string }
  | { type: 'chat:message'; boardId: string; message: KanbanBoardChatMessage }
  | { type: 'board:updated'; boardId: string }
  | { type: 'presence:update'; boardId: string; users: BoardPresenceUser[] };
```

- [ ] **Step 2 — Vedere il compilatore trovare la bugia**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`

Atteso: FAIL, esattamente due errori (uno per `card:created`, uno per `card:updated`):

```
src/features/kanban/hooks/useKanbanRealtime.ts(158,20): error TS2339: Property 'note' does not exist on type 'SSECard'.
src/features/kanban/hooks/useKanbanRealtime.ts(184,20): error TS2339: Property 'note' does not exist on type 'SSECard'.
```

> Nota: `tsc -p tsconfig.app.json` scrive gli errori su stdout ma **esce 0** in questa configurazione — leggere l'output, non l'exit code.

È lo scopo dello step: `LocalKanbanCard.note` è una chiave obbligatoria di tipo `{ id: string; title: string; userId: string } | null` (`frontend/src/lib/db.ts:144`) — `undefined` non le è assegnabile — quindi il compilatore costringe a decidere cosa scrivere in Dexie invece di lasciarci silenziosamente un `undefined`.

- [ ] **Step 3 — Sistemare le due scritture Dexie in `frontend/src/features/kanban/hooks/useKanbanRealtime.ts`**

Riga 158 (dentro `case 'card:created'`) e riga 184 (dentro `case 'card:updated'`) sono identiche — sono le uniche due occorrenze di `note: card.note,` nel file; sostituirle entrambe con:

```ts
        note: null, // not on the wire; the board refetch restores it
```

La `invalidateQueries` sulla board (riga 62 post-4.2/4.5: 67) parte nello stesso giro di `handleEvent`, e il `queryFn` di `useKanbanBoard` riscrive card e colonne su Dexie (`useKanbanBoard.ts:54-59`) con la `note` filtrata per utente: il `null` dura il tempo del refetch e riguarda solo le letture offline, non la UI (che rende dai dati server).

- [ ] **Step 4 — Typecheck e lint**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit && npm run lint`

Atteso: `tsc` nessun output. `npm run lint` termina con `✖ 52 problems (0 errors, 52 warnings)`.

- [ ] **Step 5 — Verifica del diff fra le due union (non testabile a unit: è una dichiarazione di tipi)**

**Verifica** (da Git Bash, non da PowerShell):

```bash
cd /d/Develop/AI/Notiq \
  && grep -o "type: '[a-z:]*'" backend/src/services/kanbanSSE.ts | sort -u > /tmp/be.txt \
  && grep -o "type: '[a-z:]*'" frontend/src/features/kanban/types.ts | sort -u > /tmp/fe.txt \
  ; diff /tmp/be.txt /tmp/fe.txt
```

Atteso: esattamente due righe di output, e `diff` esce 1:

```
13a14
> type: 'connected'
```

`connected` è l'unica voce presente solo lato frontend, come da tabella sopra. Nessuna riga che inizia con `<`: se ne compare una, il backend emette un evento che il frontend non dichiara.

- [ ] **Step 6 — Regressione frontend completa**

Run: `cd frontend && npx vitest run`

Atteso: PASS. `Test Files 10 passed (10)` / `Tests 134 passed (134)` — 9 file / 131 test di baseline più il nuovo `useKanbanRealtime.test.tsx` con 2 test (4.2) + 1 (4.5). La suite impiega ~80s: `crypto.test.ts` da solo ne prende ~80 (PBKDF2 reale), è normale.

- [ ] **Step 7 — E2E kanban (non in CI, va lanciato a mano)**

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts`

Atteso: PASS su tutti gli spec. Questo stage tocca il percorso real-time della board: se qualcosa qui fallisce, il colpevole più probabile è la 4.2 (self-echo filtrato dove non doveva) o la 4.4 (`board:updated` sul delete che manda via dalla pagina prima del previsto).

- [ ] **Step 8 — Commit**

```bash
git add frontend/src/features/kanban/types.ts frontend/src/features/kanban/hooks/useKanbanRealtime.ts
git commit -m "fix(kanban): align the frontend SSE event union with the backend one"
```

---

## Stage 5 — Carico (dopo la 0.4)

Questo stage toglie lavoro inutile dai percorsi caldi: scritture DB dentro una GET, un fan-out di richieste ogni 30 secondi, un poll a 3 secondi, paginazione che restituisce la pagina sbagliata, una `findUnique` per destinatario più una SMTP dentro il request path, e un doppio invio di ogni card in bulk move. **Prerequisito assoluto: la Task 0.4 (riconnessione SSE su `/events`) deve essere già mergiata e verificata**, perché la 5.3 rimuove l'unico fallback che oggi tiene viva la chat quando l'SSE muore. Le altre task non dipendono dalla 0.4 e possono partire subito.

> **I numeri di riga qui sotto sono quelli verificati sul working tree al momento della scrittura, con gli stage precedenti già applicati.** Ogni stage che ti ha preceduto sposta le righe di questi stessi file (es. lo stage sugli upload ha aggiunto due import a `board.service.ts` e ~17 righe a `deleteBoard`). Per questo **ogni modifica a un file di produzione inizia con uno step di localizzazione**: un `grep -n` con un'ancora testuale unica. Il numero che stampa quel grep è il numero vero; se non coincide con quello citato nel blocco **File**, vince il grep. Il testo "prima/dopo" dei blocchi di codice è invece esatto e verbatim.

Fatti verificati che valgono per tutto lo stage (non riverificarli):

- `backend/prisma/schema.prisma:480` — `model KanbanBoard { ... updatedAt DateTime @updatedAt }`. `@updatedAt` scatta **solo** su un update di quel model: creare/spostare/modificare card o colonne **non** tocca `board.updatedAt`. Gli unici `prisma.kanbanBoard.update(...)` sono in `board.service.ts` (`updateBoard`), `linking.service.ts` (4 call site) e `routes/kanban.ts` (4 call site: cover/avatar upload+delete).
- `frontend/src/hooks/useSync.ts:55` — `const intervalId = setInterval(runSync, 30000);`, dove `runSync` fa `await syncPull()` e poi `await syncPush()`.
- Nel backend **non esiste alcun cron/scheduler**: `grep -rn "setInterval" backend/src --include=*.ts` restituisce solo `chatWebSocket.ts:130` (heartbeat WS), `kanbanSSE.ts:15` + `:72` (heartbeat SSE) e `utils/metrics.ts:55` + `:58` (prune metriche). `kanbanReminder.service.ts` è un insieme di funzioni chiamate dai service, non un poller. Il pattern esistente per un timer di manutenzione è `utils/metrics.ts:57-61`:
  ```ts
  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Don't prevent process exit
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }
  ```
- **Typecheck frontend:** `npx tsc --noEmit` lanciato in `frontend/` è un **no-op** — `frontend/tsconfig.json` è `{ "files": [], "references": [...] }`, quindi tsc non compila nulla ed esce 0 sempre. Il comando vero è `npx tsc -p tsconfig.app.json` (quel progetto ha già `noEmit: true` e include `src`, test compresi). In `backend/` invece `npx tsc --noEmit` funziona, ma `backend/tsconfig.json` ha `"exclude": ["node_modules", "src/**/__tests__/**"]`: **i test backend non sono type-checked**, né da tsc né da Vitest (esbuild transpila senza type-check).
- **Lint:** `backend/eslint.config.mjs` ignora `**/__tests__/**` e `**/*.test.ts`, e non abilita regole type-aware (niente `no-floating-promises`). Nei test backend `any` e parametri inutilizzati non producono warning.
- Il mock Prisma globale (`backend/src/__tests__/setup.ts`) definisce, tra gli altri: `user.{findUnique,findFirst,findMany,create,update,delete,count}`, `kanbanBoard.{findUnique,findFirst,findMany,create,update,updateMany,delete,count}`, `kanbanColumn.{findUnique,findFirst,findMany,create,update,delete,count}` (**niente `updateMany`**), `kanbanCard.{findUnique,findFirst,findMany,create,update,updateMany,delete,count}` (**niente `aggregate`**), `kanbanComment.*`, `kanbanBoardChat.*`, `kanbanReminder.*`, più `$transaction` che invoca la callback con il mock stesso.

---

### Task 5.1: Togliere le scritture da `getBoard`

**Perché:** oggi ogni `GET /api/kanban/boards/:id` scrive sul DB. Conseguenza visibile: se togli il flag "completed" da una colonna, il flag **torna da solo entro la stessa interazione** — la mutation invalida la query, il refetch passa da `getBoard`, che trova zero colonne con `isCompleted` e ri-marca l'ultima. L'utente vede la sua modifica annullarsi senza errori. In più ogni GET esegue `archiveCompletedCards`, cioè una `findMany` di colonne più una `updateMany` di card per ogni lettura di board.
**Severità:** high · **Effort:** M · **Rischio:** TIER 2 — si tocca `backend/src/app.ts` per registrare il job orario (un import + 8 righe dentro `start()`, nessuna modifica all'ordine di registrazione di route/plugin).

**File:**
- Modifica: `backend/src/services/kanban/board.service.ts:5` (import) e `:142-165` (testa di `getBoard`)
- Modifica: `backend/src/services/kanban/card.service.ts:370-401` (`archiveCompletedCards`)
- Modifica: `backend/src/app.ts:316` (import) e `:347-349` (dentro `start()`)
- Modifica: `backend/src/services/kanban/__tests__/board.service.test.ts:16-18` (mock) e `:245-278` (test da sostituire)
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts` (in coda al `describe('archiveCompletedCards')`)

**Interfacce:**
- Consuma: nessuna
- Produce: `archiveCompletedCards(boardId?: string): Promise<number>` — senza argomento archivia su **tutti** i board

---

- [ ] **Step 1 — Verificare che il default `isCompleted` sia già garantito alla creazione (il blocco di auto-heal è un backfill travestito da invariante)**

Run: `cd backend && grep -n "isCompleted: true" src/services/kanban/board.service.ts`

Atteso — quattro righe. Le due dentro `getBoard` (il `select` e il `data` dell'auto-heal, che stiamo per cancellare) e **una per ciascun percorso di creazione board**:

```
130:            { title: cols.done, position: 2, isCompleted: true },
151:      select: { id: true, isCompleted: true },
157:        data: { isCompleted: true },
326:            { title: columnTitles?.done || 'DONE', position: 1, isCompleted: true },
```

Run: `cd backend && grep -rn "kanbanBoard.create" src --include=*.ts | grep -v __tests__`

Atteso — esattamente due percorsi di creazione, entrambi coperti sopra (`createBoard` e `createBoardFromTaskList`):

```
src/services/kanban/board.service.ts:120:    const board = await tx.kanbanBoard.create({
src/services/kanban/board.service.ts:317:    const board = await tx.kanbanBoard.create({
```

Conclusione: ogni board nasce con una colonna `isCompleted: true`. Il blocco in `getBoard` non difende nessuna invariante nuova — ripara solo board legacy, a ogni singola GET, per sempre. Va cancellato.

- [ ] **Step 2 — Sostituire il test che asserisce l'auto-heal con un test che asserisce l'assenza di scritture**

Localizza il test da cancellare.

Run: `cd backend && grep -n "auto-marks last column as completed" src/services/kanban/__tests__/board.service.test.ts`

Atteso:
```
245:    it('auto-marks last column as completed if none have isCompleted set', async () => {
```

Cancella **per intero** quel test (dalla riga dell'`it(` fino al `});` che lo chiude, righe 245-278) e inserisci al suo posto questo:

```ts
    it('performs NO writes — getBoard is a pure read', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id });
      const col1 = makeKanbanColumn({ boardId: board.id, position: 0, isCompleted: false });
      const col2 = makeKanbanColumn({ boardId: board.id, position: 1, isCompleted: false });

      // Deliberately the exact shape that used to trigger the auto-heal write:
      // two columns, NEITHER marked completed.
      m(prisma.kanbanColumn.findMany).mockResolvedValue([
        { id: col1.id, isCompleted: false },
        { id: col2.id, isCompleted: false },
      ] as any);
      m(prisma.kanbanColumn.update).mockResolvedValue({} as any);

      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        ...board,
        noteId: null,
        taskListId: null,
        columns: [],
        shares: [],
        owner: { id: user.id, name: user.name, email: user.email, color: user.color, avatarUrl: user.avatarUrl },
        note: null,
        taskList: null,
      } as any);

      m(prisma.kanbanCard.count).mockResolvedValue(0);

      // No requestingUserId → the note-visibility branch is skipped entirely.
      await getBoard(board.id);

      // No write of any kind on a GET.
      expect(prisma.kanbanColumn.update).not.toHaveBeenCalled();
      expect(prisma.kanbanCard.update).not.toHaveBeenCalled();
      expect(prisma.kanbanCard.updateMany).not.toHaveBeenCalled();
      expect(prisma.kanbanBoard.update).not.toHaveBeenCalled();

      // And the read that only existed to feed the auto-heal is gone too.
      expect(prisma.kanbanColumn.findMany).not.toHaveBeenCalled();
    });
```

Nello stesso file, cancella il mock del sibling che dopo lo Step 7 non sarà più importato da `board.service.ts`.

Run: `cd backend && grep -n "vi.mock('../card.service'" src/services/kanban/__tests__/board.service.test.ts`

Atteso:
```
16:vi.mock('../card.service', () => ({
```

Cancella le tre righe 16-18:

```ts
vi.mock('../card.service', () => ({
  archiveCompletedCards: vi.fn().mockResolvedValue(0),
}));
```

Non toccare gli altri `vi.mock` del file (helpers, fs): servono ad altri test.

- [ ] **Step 3 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts -t "performs NO writes"`

Atteso — FAIL:
```
AssertionError: expected "update" to not be called at all, but actually been called 1 times
```

- [ ] **Step 4 — Aggiungere il test per l'archiviazione globale (senza `boardId`)**

Localizza il blocco.

Run: `cd backend && grep -n "describe('archiveCompletedCards'\|returns 0 when no completed columns exist" src/services/kanban/__tests__/card.service.test.ts`

Atteso — due righe, la prima è l'apertura del `describe`, la seconda è l'ultimo test esistente del blocco:
```
813:describe('archiveCompletedCards', () => {
837:  it('returns 0 when no completed columns exist', async () => {
```

Aggiungi questo test **dopo** il `});` che chiude `'returns 0 when no completed columns exist'` e **prima** del `});` che chiude il `describe`:

```ts
  it('archives across ALL boards when called with no boardId', async () => {
    prismaMock.kanbanColumn.findMany.mockResolvedValue([{ id: 'col-a' }, { id: 'col-b' }]);
    prismaMock.kanbanCard.updateMany.mockResolvedValue({ count: 5 });

    const result = await archiveCompletedCards();

    // toHaveBeenCalledWith ignores undefined-valued keys, so assert on the key set:
    // the boardId filter must be ABSENT, not present-and-undefined.
    const whereArg = prismaMock.kanbanColumn.findMany.mock.calls[0][0].where;
    expect(Object.keys(whereArg)).toEqual(['isCompleted']);
    expect(whereArg.isCompleted).toBe(true);

    expect(prismaMock.kanbanCard.updateMany).toHaveBeenCalledWith({
      where: {
        columnId: { in: ['col-a', 'col-b'] },
        archivedAt: null,
        updatedAt: { lte: expect.any(Date) },
      },
      data: { archivedAt: expect.any(Date) },
    });
    expect(result).toBe(5);
  });
```

Nota: `archiveCompletedCards()` senza argomenti è, in questo momento, una chiamata che non rispetta la firma `(boardId: string)`. Non è un problema: `backend/tsconfig.json` esclude `src/**/__tests__/**` e Vitest transpila con esbuild senza type-check, quindi il test gira lo stesso e fallisce sull'asserzione, non sulla compilazione.

- [ ] **Step 5 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "archives across ALL boards"`

Atteso — FAIL (la chiamata attuale produce `where: { boardId: undefined, isCompleted: true }`):
```
AssertionError: expected [ 'boardId', 'isCompleted' ] to deeply equal [ 'isCompleted' ]
```

- [ ] **Step 6 — Rendere `boardId` opzionale in `archiveCompletedCards`**

Run: `cd backend && grep -n "export async function archiveCompletedCards" src/services/kanban/card.service.ts`

Atteso:
```
374:export async function archiveCompletedCards(boardId: string): Promise<number> {
```

Sostituisci il blocco che va dal commento JSDoc (3 righe sopra, riga 370) fino al `}` che chiude la funzione (riga 401). Testo attuale da sostituire:

```ts
/**
 * Lazy archive: find cards in completed columns that haven't been updated
 * in ≥7 days and set archivedAt = now().
 */
export async function archiveCompletedCards(boardId: string): Promise<number> {
  const cutoffDate = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Find completed columns for this board
  const completedColumns = await prisma.kanbanColumn.findMany({
    where: { boardId, isCompleted: true },
    select: { id: true },
  });

  if (completedColumns.length === 0) return 0;

  const completedColumnIds = completedColumns.map((c) => c.id);

  const result = await prisma.kanbanCard.updateMany({
    where: {
      columnId: { in: completedColumnIds },
      archivedAt: null,
      updatedAt: { lte: cutoffDate },
    },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info({ boardId, count: result.count }, 'Lazy-archived completed cards');
  }

  return result.count;
}
```

Testo nuovo:

```ts
/**
 * Archive cards sitting in completed columns that haven't been updated in ≥7 days.
 * Called hourly from app.ts. Pass a boardId to scope it to a single board.
 *
 * [BACKUP] 2026-08-31 — previously this was invoked from getBoard() on every read,
 * making GET /api/kanban/boards/:id a write endpoint. Moved to a scheduled job.
 */
export async function archiveCompletedCards(boardId?: string): Promise<number> {
  const cutoffDate = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Find completed columns (optionally scoped to one board)
  const completedColumns = await prisma.kanbanColumn.findMany({
    where: boardId ? { boardId, isCompleted: true } : { isCompleted: true },
    select: { id: true },
  });

  if (completedColumns.length === 0) return 0;

  const completedColumnIds = completedColumns.map((c) => c.id);

  const result = await prisma.kanbanCard.updateMany({
    where: {
      columnId: { in: completedColumnIds },
      archivedAt: null,
      updatedAt: { lte: cutoffDate },
    },
    data: { archivedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info({ boardId: boardId ?? 'ALL', count: result.count }, 'Archived completed cards');
  }

  return result.count;
}
```

- [ ] **Step 7 — Rimuovere le scritture da `getBoard`**

Run: `cd backend && grep -n "export async function getBoard" src/services/kanban/board.service.ts`

Atteso:
```
142:export async function getBoard(boardId: string, requestingUserId?: string) {
```

Sostituisci dalla riga della firma fino alla riga vuota che precede `const board = await prisma.kanbanBoard.findUnique({` (righe 142-165). Testo attuale da sostituire:

```ts
export async function getBoard(boardId: string, requestingUserId?: string) {
  // Run lazy archive before returning board data
  await archiveCompletedCards(boardId);

  // Auto-mark last column as "completed" if no column has isCompleted set
  try {
    const columns = await prisma.kanbanColumn.findMany({
      where: { boardId },
      orderBy: { position: 'asc' },
      select: { id: true, isCompleted: true },
    });
    if (columns.length > 0 && !columns.some(c => c.isCompleted)) {
      const lastColumn = columns[columns.length - 1];
      await prisma.kanbanColumn.update({
        where: { id: lastColumn.id },
        data: { isCompleted: true },
      });
    }
  } catch (err) {
    logger.error(err, 'Failed to auto-set last column as completed');
  }

```

Testo nuovo (firma + solo commento, poi si prosegue con la `findUnique` già presente):

```ts
export async function getBoard(boardId: string, requestingUserId?: string) {
  // [BACKUP] 2026-08-31 — questa GET faceva due scritture:
  //   await archiveCompletedCards(boardId);              → ora job orario in app.ts
  //   try { ...kanbanColumn.update({ isCompleted: true }) } catch { ... }
  // Il secondo blocco era un backfill per board legacy, eseguito a ogni lettura:
  // riattivava "completed" sull'ultima colonna subito dopo che l'utente lo aveva
  // tolto, perché la invalidate della mutation rifaceva il fetch da qui.
  // createBoard (:130) e createBoardFromTaskList (:326) creano già una colonna
  // con isCompleted: true, quindi l'invariante è garantita alla creazione.

```

Poi rimuovi **solo** l'import di `archiveCompletedCards` (riga 5):

```ts
import { archiveCompletedCards } from './card.service';
```

**Non rimuovere `import logger from '../../utils/logger';`**: dopo questa modifica `logger` resta usato da `deleteBoard`, che logga i fallimenti di unlink dei file cover/avatar. Verificalo:

Run: `cd backend && grep -n "logger\." src/services/kanban/board.service.ts`

Atteso — dopo la modifica resta **una sola** riga, quella in `deleteBoard`:
```
270:      logger.warn({ err, boardId, filepath }, 'Failed to delete kanban board image file');
```
(il numero esatto dipende da quanto ha spostato lo stage precedente; ciò che conta è che ci sia ancora almeno un uso di `logger`, e che non sia più quello dentro `getBoard`).

- [ ] **Step 8 — Eseguire i due file di test e vederli passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts src/services/kanban/__tests__/card.service.test.ts`

Atteso — PASS, nessun test fallito:
```
 Test Files  2 passed (2)
```

- [ ] **Step 9 — Schedulare il job orario in `app.ts`**

Run: `cd backend && grep -n "from './chatWebSocket'" src/app.ts`

Atteso:
```
316:import { chatWss, authenticateFromUrl } from './chatWebSocket';
```

Subito dopo quella riga aggiungi:

```ts
import { archiveCompletedCards } from './services/kanban/card.service';
```

Poi, dentro `start()`, sostituisci le tre righe di log finali:

```ts
    server.log.info('Server running on port 3001');
    server.log.info('Hocuspocus attached to /ws');
    server.log.info('Chat WebSocket attached to /chat-ws');
```

con:

```ts
    // Hourly maintenance: archive cards left ≥7 days in a completed column.
    // Was previously run inside every GET /api/kanban/boards/:id (a write on a read path).
    // ponytail: plain unref'd setInterval, same pattern as utils/metrics.ts:57-61.
    // Move to a real scheduler only if a second periodic job appears.
    const archiveTimer = setInterval(() => {
      archiveCompletedCards().catch((err) =>
        server.log.error({ err }, 'Scheduled kanban card archive failed')
      );
    }, 60 * 60 * 1000);
    if (archiveTimer.unref) archiveTimer.unref(); // never hold the process open

    server.log.info('Server running on port 3001');
    server.log.info('Hocuspocus attached to /ws');
    server.log.info('Chat WebSocket attached to /chat-ws');
    server.log.info('Kanban archive job scheduled (hourly)');
```

- [ ] **Step 10 — Verifica: nessuna scrittura residua sul percorso di lettura + job registrato**

Questo step non è testabile a unità (registrazione di un timer nel bootstrap: `app.ts` non è importato da nessun test), quindi si verifica con grep e con l'avvio reale.

Run: `cd backend && grep -n "archiveCompletedCards\|kanbanColumn.update" src/services/kanban/board.service.ts`

Atteso — **nessun output**, exit code 1. Entrambe le scritture, e l'import che le portava, sono sparite da `board.service.ts`.

Run: `cd backend && npm run dev` e leggere il log di avvio.

Atteso — tra le righe di boot compare:
```
Kanban archive job scheduled (hourly)
```
Fermare con Ctrl+C.

- [ ] **Step 11 — Lint e typecheck**

Run: `cd backend && npx tsc --noEmit && npm run lint`

Atteso — nessun errore e nessun warning `'archiveCompletedCards' is defined but never used`. (Se compare `'logger' is defined but never used` hai cancellato un import di troppo: rimettilo, `deleteBoard` lo usa.)

- [ ] **Step 12 — Commit**

```bash
git add backend/src/services/kanban/board.service.ts backend/src/services/kanban/card.service.ts backend/src/app.ts backend/src/services/kanban/__tests__/board.service.test.ts backend/src/services/kanban/__tests__/card.service.test.ts
git commit -m "fix(kanban): make getBoard a pure read, move card archiving to an hourly job"
```

---

### Task 5.2: Saltare il fetch di dettaglio per board in `syncPull` quando non serve

**Perché:** `syncPull` gira ogni 30 secondi (`frontend/src/hooks/useSync.ts:55`) e, dopo la lista board, fa un `GET /kanban/boards/:id` **per ogni board restituito da `/kanban/boards`** — che sono i board posseduti **più** quelli condivisi accettati, perché `listBoards` concatena `ownedBoards` e `sharedBoards` (`board.service.ts:108`). Con 20 board sono 21 richieste ogni 30 secondi, cioè circa 2500 richieste all'ora per utente attivo, ciascuna con una `findUnique` a 7 include più il count degli archiviati. E finché la 5.1 non è mergiata, ognuna di quelle 20 richieste di dettaglio è anche una **scrittura**.
**Severità:** critical · **Effort:** M · **Rischio:** TIER 1 — `frontend/src/features/sync/syncService.ts` è il motore di sync offline: commit isolato, nessun'altra modifica insieme a questa.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:296-299` e `:341-344`
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` (due test dentro `describe('kanban boards')`, che apre alla riga 526)

**Interfacce:**
- Consuma: `getBoard` come pura lettura (Task 5.1) — non è un prerequisito tecnico, ma è ciò che rende questo cambio un guadagno netto e non solo uno spostamento di carico
- Produce: nessuna

---

- [ ] **Step 1 — Verificare che la lista board restituisca davvero `updatedAt` su entrambi i lati**

Run: `cd backend && grep -n "updatedAt: true" src/services/kanban/board.service.ts`

Atteso — esattamente due righe: il `select` dei board posseduti e quello dei board condivisi dentro `listBoards`:
```
22:        updatedAt: true,
52:            updatedAt: true,
```

Run: `cd backend && grep -n "updatedAt: b.updatedAt\|updatedAt: s.board.updatedAt" src/services/kanban/board.service.ts`

Atteso — il campo sopravvive fino all'oggetto restituito, in entrambi i map:
```
81:    updatedAt: b.updatedAt,
99:    updatedAt: s.board.updatedAt,
```

Run: `cd frontend && grep -n "updatedAt: string;" src/features/kanban/types.ts src/lib/db.ts`

Atteso — `KanbanBoardListItem` (types.ts) e `LocalKanbanBoard` (db.ts) dichiarano entrambi `updatedAt: string`, quindi il confronto è stringa-contro-stringa fra due valori che arrivano dallo stesso JSON. Fra le righe stampate devono comparire almeno:
```
src/features/kanban/types.ts:44:  updatedAt: string;
src/lib/db.ts:124:  updatedAt: string;
```

**Limite noto, da mettere in chiaro prima di scrivere il codice:** `board.updatedAt` è `@updatedAt` sul model `KanbanBoard`, quindi cambia **solo** quando si aggiorna il board stesso (titolo, descrizione, cover, avatar, link nota/task list). Creare, modificare, spostare o cancellare una card **non** lo tocca. Il gate quindi degenera, nella pratica, in "scarica il dettaglio solo dei board di cui non ho ancora colonne in cache". Questo è accettabile perché il dettaglio del board che l'utente **apre davvero** viene già riscritto in Dexie da `useKanbanBoard` (`frontend/src/features/kanban/hooks/useKanbanBoard.ts:11-68`, la `queryFn` fa `getBoard` e poi `db.kanbanColumns.put` / `db.kanbanCards.put` per ogni riga `synced`) e tenuto aggiornato in tempo reale da `updateDexieFromSSE` (`frontend/src/features/kanban/hooks/useKanbanRealtime.ts:167-270`). Il costo è che un board mai riaperto può restare indietro in Dexie fino alla prossima apertura: si perde freschezza offline su board che nessuno sta guardando, si guadagnano ~20 richieste ogni 30 secondi.

- [ ] **Step 2 — Aggiungere i due test (il primo fallirà)**

Run: `cd frontend && grep -n "pulls kanban boards and their details" src/features/sync/__tests__/syncService.test.ts`

Atteso:
```
527:    it('pulls kanban boards and their details (columns + cards)', async () => {
```

Aggiungi questi due test subito dopo il `});` che chiude quel test (riga 590) e prima del `});` che chiude `describe('kanban boards')` (riga 591):

```ts
    it('skips the per-board detail fetch when updatedAt is unchanged and columns are cached', async () => {
      const boardsList = [
        {
          id: 'kb-1', title: 'Project Board', description: null, coverImage: null,
          avatarUrl: null, ownerId: 'user-1', columnCount: 1, cardCount: 1,
          ownership: 'owned' as const, createdAt: '2026-01-01', updatedAt: '2026-01-05T10:00:00.000Z',
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/kanban/boards') return Promise.resolve({ data: boardsList });
        return Promise.resolve({ data: [] });
      });

      // Same updatedAt already in Dexie...
      mockDb.kanbanBoards.toArray.mockResolvedValue([
        { id: 'kb-1', updatedAt: '2026-01-05T10:00:00.000Z', ownership: 'owned', syncStatus: 'synced' },
      ]);
      // ...and columns already cached for it.
      mockDb.kanbanColumns.count.mockResolvedValue(3);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      expect(mockApi.get).toHaveBeenCalledWith('/kanban/boards');
      expect(mockApi.get).not.toHaveBeenCalledWith('/kanban/boards/kb-1');
    });

    it('still fetches the detail when the board updatedAt changed on the server', async () => {
      const boardsList = [
        {
          id: 'kb-1', title: 'Project Board', description: null, coverImage: null,
          avatarUrl: null, ownerId: 'user-1', columnCount: 1, cardCount: 1,
          ownership: 'owned' as const, createdAt: '2026-01-01', updatedAt: '2026-01-09T08:00:00.000Z',
        },
      ];

      const boardDetail = {
        id: 'kb-1', title: 'Project Board', description: null, coverImage: null,
        avatarUrl: null, ownerId: 'user-1',
        columns: [
          { id: 'col-1', title: 'Todo', position: 0, boardId: 'kb-1', isCompleted: false, cards: [] },
        ],
        createdAt: '2026-01-01', updatedAt: '2026-01-09T08:00:00.000Z',
      };

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/kanban/boards') return Promise.resolve({ data: boardsList });
        if (url === '/kanban/boards/kb-1') return Promise.resolve({ data: boardDetail });
        return Promise.resolve({ data: [] });
      });

      // Stale updatedAt in Dexie, columns cached — must refetch anyway.
      mockDb.kanbanBoards.toArray.mockResolvedValue([
        { id: 'kb-1', updatedAt: '2026-01-05T10:00:00.000Z', ownership: 'owned', syncStatus: 'synced' },
      ]);
      mockDb.kanbanColumns.count.mockResolvedValue(3);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      expect(mockApi.get).toHaveBeenCalledWith('/kanban/boards/kb-1');
    });
```

Il mock Dexie del file è una tabella auto-referenziale (`where()`/`equals()` restituiscono la tabella stessa), quindi `mockDb.kanbanColumns.count` copre sia `db.kanbanColumns.count()` sia `db.kanbanColumns.where('boardId').equals(id).count()`, e `mockDb.kanbanBoards.toArray` copre sia la `toArray()` nuda sia quelle in coda a `where(...)`.

- [ ] **Step 3 — Eseguire i test e vedere fallire il primo**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "skips the per-board detail fetch"`

Atteso — FAIL:
```
AssertionError: expected "spy" to not be called with arguments: [ '/kanban/boards/kb-1' ]
```

Il secondo test (`still fetches the detail when...`) passa già oggi: serve come rete di sicurezza contro un gate troppo aggressivo.

- [ ] **Step 4 — Catturare gli `updatedAt` locali PRIMA che il bulkPut li sovrascriva**

Run: `cd frontend && grep -n "Kanban Boards Pull" src/features/sync/syncService.ts`

Atteso:
```
295:    // --- Kanban Boards Pull ---
```

Sostituisci le righe 296-299:

```ts
    try {
      const boardsRes = await api.get<KanbanBoardListItem[]>('/kanban/boards');
      const serverBoards = boardsRes.data;

```

con:

```ts
    try {
      const boardsRes = await api.get<KanbanBoardListItem[]>('/kanban/boards');
      const serverBoards = boardsRes.data;

      // Snapshot of what we already know, taken BEFORE the bulkPut below overwrites it.
      // Used by the detail-fetch gate further down.
      const localBoardUpdatedAt = new Map(
        (await db.kanbanBoards.toArray()).map((b) => [b.id, b.updatedAt]),
      );

```

- [ ] **Step 5 — Mettere il gate sul loop di dettaglio**

Run: `cd frontend && grep -n "Pull full board details" src/features/sync/syncService.ts`

Atteso:
```
341:      // Pull full board details (columns + cards) for each board
```

Sostituisci le righe 341-344:

```ts
      // Pull full board details (columns + cards) for each board
      for (const board of serverBoards) {
        try {
          const boardRes = await api.get<KanbanBoard>(`/kanban/boards/${board.id}`);
```

con:

```ts
      // Pull full board details (columns + cards) for each board.
      //
      // [BACKUP] 2026-08-31 — prima questo loop faceva un GET /kanban/boards/:id per OGNI
      // board a ogni pull (useSync: ogni 30s). /kanban/boards restituisce posseduti +
      // condivisi accettati, quindi con 20 board erano 21 richieste ogni 30 secondi.
      //
      // Gate: salta i board il cui updatedAt di lista non è cambiato E che hanno già colonne
      // in cache. Nota: board.updatedAt è @updatedAt sul model KanbanBoard, quindi NON cambia
      // quando cambiano card o colonne — in pratica il gate scarica il dettaglio solo dei board
      // mai aperti. È voluto: il dettaglio del board aperto lo riscrive useKanbanBoard e lo
      // mantiene updateDexieFromSSE via SSE. Un board mai riaperto può restare indietro in
      // Dexie fino alla prossima apertura.
      for (const board of serverBoards) {
        const knownUpdatedAt = localBoardUpdatedAt.get(board.id);
        if (knownUpdatedAt === board.updatedAt) {
          const cachedColumns = await db.kanbanColumns.where('boardId').equals(board.id).count();
          if (cachedColumns > 0) continue;
        }

        try {
          const boardRes = await api.get<KanbanBoard>(`/kanban/boards/${board.id}`);
```

- [ ] **Step 6 — Eseguire l'intera suite di `syncService` e vederla passare**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts`

Atteso — PASS, incluso il test preesistente `'pulls kanban boards and their details (columns + cards)'` (lì `kanbanBoards.toArray` è mockata a `[]`, quindi `knownUpdatedAt` è `undefined ≠ '2026-01-01'` e il dettaglio viene scaricato come prima):
```
 Test Files  1 passed (1)
```

- [ ] **Step 7 — Typecheck e lint**

Run: `cd frontend && npx tsc -p tsconfig.app.json && npm run lint`

Atteso — nessun errore. (`npx tsc --noEmit` da solo NON verifica nulla in questo workspace: `tsconfig.json` ha `files: []`.)

- [ ] **Step 8 — Verifica manuale sul traffico reale**

Avvia `cd frontend && npm run dev` (con il backend su :3001), fai login, apri DevTools → Network, filtra `kanban/boards`, e lascia l'app ferma sulla lista board per 2 minuti (4 cicli di sync).

Atteso — dopo il primo ciclo (che popola la cache) i cicli successivi mostrano **una sola** richiesta `GET /api/kanban/boards` ciascuno, e **nessuna** `GET /api/kanban/boards/<uuid>`. Aprendo poi un board: compare una singola `GET /api/kanban/boards/<uuid>`, innescata da `useKanbanBoard`, non dal sync.

- [ ] **Step 9 — E2E di regressione sul percorso offline**

Run: `cd frontend && npx playwright test e2e/dexie.spec.ts e2e/kanban.spec.ts`

Atteso — tutti gli spec passano. Questi due coprono la persistenza Dexie e il flusso kanban toccati dal gate.

- [ ] **Step 10 — Commit (isolato: file TIER 1)**

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "perf(kanban): gate syncPull per-board detail fetch on updatedAt + cached columns"
```

---

### Task 5.3: Rimuovere il poll a 3 secondi dalla chat di board

**Perché:** `useKanbanChat` rifà `GET /api/kanban/boards/:id/chat` ogni 3 secondi finché la sidebar chat è montata — 1200 richieste all'ora per utente con un board aperto, per un canale che ha già il push via SSE (`useKanbanRealtime.ts:33-34` invalida `queryKeys.kanban.boardChat` sull'evento `chat:message`).
**Severità:** high · **Effort:** S · **Rischio:** none sul codice; il rischio è tutto nella dipendenza dichiarata sotto.

> **⚠️ QUESTA TASK È BLOCCATA DALLA TASK 0.4. NON ESEGUIRLA PRIMA.**
> Prima della 0.4, `useKanbanRealtime` faceva `if (!response.ok || !response.body) return;` — su una risposta non-OK da `/events` la funzione `connect()` usciva **e non riprovava mai**, perché il `setTimeout(connect, 5000)` esisteva solo nel ramo `catch`, che intercetta gli errori di rete, non un 401/500/502 con corpo. Un riavvio del backend, un deploy IIS o un 429 lasciavano l'SSE morto per tutta la vita della pagina. Finché la 0.4 non aggiunge la riconnessione anche sul ramo non-OK e sull'EOF pulito, **il poll a 3 secondi è l'unica via di aggiornamento residua**: toglierlo prima renderebbe la chat di board permanentemente morta dopo qualsiasi risposta non-OK, senza alcun segnale per l'utente.

**File:**
- Modifica: `frontend/src/features/kanban/hooks/useKanbanChat.ts:8-13`

**Interfacce:**
- Consuma: la riconnessione SSE della Task 0.4 in `frontend/src/features/kanban/hooks/useKanbanRealtime.ts`
- Produce: nessuna

---

- [ ] **Step 1 — Confermare che la 0.4 è dentro (gate di ingresso)**

Run: `cd frontend && grep -n "response.ok\|scheduleReconnect" src/features/kanban/hooks/useKanbanRealtime.ts`

Atteso — il ramo non-OK **non** deve più essere un `return` nudo, e devono esistere una funzione `scheduleReconnect` e almeno tre chiamate (non-OK, EOF pulito, catch):
```
 89:    //   if (!response.ok || !response.body) return;
 99:    function scheduleReconnect(): void {
113:        if (!response.ok || !response.body) {
114:          scheduleReconnect();
146:        scheduleReconnect();
149:        scheduleReconnect();
```
(La riga 89 è dentro il commento `[BACKUP]` della 0.4, non codice attivo.)

Se invece l'unico match è una riga di codice `if (!response.ok || !response.body) return;` e non esiste `scheduleReconnect`, **fermati**: la Task 0.4 non è stata applicata e questa task va rimandata.

- [ ] **Step 2 — Rimuovere `refetchInterval`**

In `frontend/src/features/kanban/hooks/useKanbanChat.ts`, sostituisci le righe 8-13:

```ts
  const { data: messages = [], isLoading } = useQuery({
    queryKey: queryKeys.kanban.boardChat(boardId!),
    queryFn: () => getBoardChat(boardId!),
    enabled: !!boardId,
    refetchInterval: 3000,
  });
```

con:

```ts
  // [BACKUP] 2026-08-31 — c'era `refetchInterval: 3000`: 1200 richieste/ora per utente
  // con un board aperto. Gli aggiornamenti arrivano dall'SSE, che invalida questa
  // stessa query key (useKanbanRealtime.ts, evento 'chat:message'); i messaggi inviati
  // da questo utente li invalida la mutation `sendMessage` qui sotto.
  const { data: messages = [], isLoading } = useQuery({
    queryKey: queryKeys.kanban.boardChat(boardId!),
    queryFn: () => getBoardChat(boardId!),
    enabled: !!boardId,
  });
```

- [ ] **Step 3 — Verifica statica (questa task non porta logica testabile a unità)**

Questa modifica è la cancellazione di una option di react-query. Non esiste un test unitario che possa asserire in modo onesto "l'SSE aggiorna la chat" senza reimplementare l'SSE dentro il mock — sarebbe un test che verifica il proprio mock. La verifica è quindi statica più manuale.

Run: `cd frontend && grep -n "refetchInterval" src/features/kanban/hooks/useKanbanChat.ts`

Atteso — **nessun output**, exit code 1.

Run: `cd frontend && npx tsc -p tsconfig.app.json && npm run lint`

Atteso — nessun errore.

- [ ] **Step 4 — Verifica manuale a due browser (aggiornamento push)**

Con backend e frontend in dev, apri lo stesso board in due browser (o due profili) autenticati con due utenti diversi che condividono il board. Apri la chat sidebar in entrambi. Scrivi un messaggio dall'utente A.

Atteso — il messaggio compare nella sidebar dell'utente B entro circa un secondo, senza reload. In DevTools → Network dell'utente B, filtrando `chat`, si vede **una sola** `GET .../chat` (quella innescata dalla invalidate dell'evento SSE) e nessuna richiesta periodica ogni 3 secondi.

- [ ] **Step 5 — Verifica manuale della riconnessione (il motivo del blocco sulla 0.4)**

Con le due sessioni ancora aperte e la chat visibile, **ferma il backend** (Ctrl+C su `npm run dev` in `backend/`), attendi 10 secondi, poi **riavvialo**. Non ricaricare nessuna delle due pagine.

Atteso — entro un intervallo di backoff (la 0.4 usa 2s, 4s, 8s, 16s, cap 30s) l'SSE si riaggancia; scrivendo un nuovo messaggio dall'utente A, l'utente B lo vede comparire **senza aver ricaricato la pagina**. Se non compare, la riconnessione della 0.4 non funziona: ripristina `refetchInterval: 3000` e riapri la 0.4 prima di ritentare questa task.

- [ ] **Step 6 — Commit**

```bash
git add frontend/src/features/kanban/hooks/useKanbanChat.ts
git commit -m "perf(kanban): drop 3s board-chat poll, rely on SSE invalidation"
```

---

### Task 5.4: Paginare chat e commenti dal più recente

**Perché:** `getComments` e `getBoardChat` fanno `orderBy: { createdAt: 'asc' }` con `take: 50` (default di `paginationSchema`, `backend/src/routes/kanban.ts:69-72`, `limit: z.coerce.number().int().positive().max(100).optional().default(50)`): la prima pagina sono i **50 messaggi più vecchi**. Oltre i 50 messaggi la chat di board è congelata sulla preistoria, e un messaggio appena inviato **sparisce** appena la mutation invalida la query, perché non rientra nella finestra restituita. Stesso difetto sui commenti di card oltre i 50.
**Severità:** critical · **Effort:** S · **Rischio:** none — nessuna modifica di schema, nessun contratto di API rotto (vedi Step 1).

**File:**
- Modifica: `backend/src/services/kanban/comments-chat.service.ts:17-31` (`getComments`) e `:171-185` (`getBoardChat`)
- Modifica: `backend/src/services/kanban/__tests__/comments-chat.service.test.ts:104-125` e `:394-415`

**Interfacce:**
- Consuma: nessuna
- Produce: `getComments(cardId: string, page: number, limit: number)` e `getBoardChat(boardId: string, page: number, limit: number)` restituiscono la finestra **più recente**, ordinata **ascendente al suo interno**

---

- [ ] **Step 1 — Verificare cosa assume il frontend sull'ordine**

Run: `cd frontend && sed -n '41,46p;56,58p' src/features/kanban/components/BoardChatSidebar.tsx`

Atteso — due assunzioni di ordinamento **ascendente**:
```
  // Auto-scroll on new messages (only when open)
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isOpen]);
    if (messages.length > prevMessageCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.authorId !== currentUser.id) {
```

Run: `cd frontend && grep -n "messagesEndRef" src/features/kanban/components/BoardChatSidebar.tsx`

Atteso — il sentinella di scroll sta **dopo** il `.map()` dei messaggi:
```
37:  const messagesEndRef = useRef<HTMLDivElement>(null);
44:      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
155:        <div ref={messagesEndRef} />
```

Run: `cd frontend && sed -n '526,529p' src/features/kanban/components/CardDetailModal.tsx`

Atteso — i commenti sono renderizzati nell'ordine dell'array, dall'alto in basso, senza alcun sort:
```
          ) : comments && comments.length > 0 ? (
            <div className="space-y-3 mb-3">
              {comments.map((comment) => (
                <div key={comment.id} className="flex gap-2">
```

Conclusione: il frontend assume **ordine ascendente all'interno della pagina**. La correzione non deve quindi restituire l'array in `desc`, ma prendere la finestra più recente con `orderBy: 'desc'` + `take`, e poi **invertirla** prima di restituirla. Nessun componente frontend va toccato.

- [ ] **Step 2 — Aggiornare i due test esistenti perché asseriscano il nuovo comportamento (falliranno)**

Run: `cd backend && grep -n "returns paginated comments with author info\|returns paginated chat messages with author info" src/services/kanban/__tests__/comments-chat.service.test.ts`

Atteso:
```
104:    it('returns paginated comments with author info', async () => {
394:    it('returns paginated chat messages with author info', async () => {
```

Sostituisci il test alle righe 104-125 con:

```ts
    it('returns the NEWEST page of comments, ascending within the page', async () => {
      const user = makeUser();
      const card = makeKanbanCard();
      const older = makeKanbanComment({ id: 'c-older', cardId: card.id, authorId: user.id });
      const newer = makeKanbanComment({ id: 'c-newer', cardId: card.id, authorId: user.id });

      // Prisma returns newest-first with orderBy desc
      mockedPrisma.kanbanComment.findMany.mockResolvedValue([
        commentWithAuthor(newer, user),
        commentWithAuthor(older, user),
      ]);

      const out = await getComments(card.id, 1, 10);

      // Reversed back to ascending for the UI (CardDetailModal renders top-to-bottom)
      expect(out.map((c: { id: string }) => c.id)).toEqual(['c-older', 'c-newer']);
      expect(mockedPrisma.kanbanComment.findMany).toHaveBeenCalledWith({
        where: { cardId: card.id },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 10,
        include: {
          author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      });
    });
```

E sostituisci il test alle righe 394-415 con:

```ts
    it('returns the NEWEST page of chat messages, ascending within the page', async () => {
      const user = makeUser();
      const boardId = 'board-chat-1';
      const older = makeKanbanBoardChat({ id: 'm-older', boardId, authorId: user.id });
      const newer = makeKanbanBoardChat({ id: 'm-newer', boardId, authorId: user.id });

      mockedPrisma.kanbanBoardChat.findMany.mockResolvedValue([
        chatWithAuthor(newer, user),
        chatWithAuthor(older, user),
      ]);

      const out = await getBoardChat(boardId, 1, 10);

      // BoardChatSidebar treats messages[length - 1] as the newest and scrolls to the
      // bottom, so the page must come back ascending.
      expect(out.map((m: { id: string }) => m.id)).toEqual(['m-older', 'm-newer']);
      expect(mockedPrisma.kanbanBoardChat.findMany).toHaveBeenCalledWith({
        where: { boardId },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 10,
        include: {
          author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      });
    });
```

`makeKanbanComment` e `makeKanbanBoardChat` sono già importati in testa al file (righe 8-9), e gli helper `commentWithAuthor` / `chatWithAuthor` sono definiti alle righe 52-76 dello stesso file: non serve aggiungere nulla.

- [ ] **Step 3 — Eseguire i test e vederli fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts -t "NEWEST page"`

Atteso — 2 FAIL:
```
AssertionError: expected [ 'c-newer', 'c-older' ] to deeply equal [ 'c-older', 'c-newer' ]
```

- [ ] **Step 4 — Invertire l'ordinamento di `getComments`**

Run: `cd backend && grep -n "export async function getComments" src/services/kanban/comments-chat.service.ts`

Atteso:
```
17:export async function getComments(
```

Sostituisci le righe 17-31:

```ts
export async function getComments(
  cardId: string,
  page: number,
  limit: number
) {
  return prisma.kanbanComment.findMany({
    where: { cardId },
    orderBy: { createdAt: 'asc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });
}
```

con:

```ts
export async function getComments(
  cardId: string,
  page: number,
  limit: number
) {
  // [BACKUP] 2026-08-31 — era `orderBy: { createdAt: 'asc' }`: page 1 restituiva i 50
  // commenti PIÙ VECCHI, quindi oltre i 50 un commento appena scritto spariva dopo la
  // invalidate. Prendiamo la finestra più recente (desc + take) e la rigiriamo in
  // ascendente, che è l'ordine in cui CardDetailModal la renderizza.
  const rows = await prisma.kanbanComment.findMany({
    where: { cardId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
    },
  });
  return rows.reverse();
}
```

- [ ] **Step 5 — Invertire l'ordinamento di `getBoardChat`**

Run: `cd backend && grep -n "export async function getBoardChat" src/services/kanban/comments-chat.service.ts`

Atteso:
```
171:export async function getBoardChat(
```

Sostituisci le righe 171-185:

```ts
export async function getBoardChat(
  boardId: string,
  page: number,
  limit: number
) {
  return prisma.kanbanBoardChat.findMany({
    where: { boardId },
    orderBy: { createdAt: 'asc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: chatAuthorSelect },
    },
  });
}
```

con:

```ts
export async function getBoardChat(
  boardId: string,
  page: number,
  limit: number
) {
  // [BACKUP] 2026-08-31 — era `orderBy: { createdAt: 'asc' }`: page 1 restituiva i 50
  // messaggi PIÙ VECCHI, quindi oltre i 50 la chat risultava congelata e il messaggio
  // appena inviato spariva dopo la invalidate della mutation. Finestra più recente
  // (desc + take), rigirata in ascendente perché BoardChatSidebar considera
  // messages[length - 1] il più nuovo e scrolla in fondo.
  const rows = await prisma.kanbanBoardChat.findMany({
    where: { boardId },
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: {
      author: { select: chatAuthorSelect },
    },
  });
  return rows.reverse();
}
```

`chatAuthorSelect` è la costante definita alle righe 7-13 dello stesso file (`{ id, name, email, color, avatarUrl }`), quindi l'asserzione del test sull'oggetto letterale continua a combaciare.

- [ ] **Step 6 — Eseguire l'intera suite del service e vederla passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/comments-chat.service.test.ts`

Atteso — PASS su tutti i test del file. In particolare restano verdi i due `'calculates skip correctly for page > 1'` (righe 135-143 e 425-433), che asseriscono solo `skip`/`take` e non l'ordinamento, e i due `'returns empty array...'` (righe 127-133 e 417-423), perché `[].reverse()` è `[]`:
```
 Test Files  1 passed (1)
```

- [ ] **Step 7 — Lint e typecheck**

Run: `cd backend && npx tsc --noEmit && npm run lint`

Atteso — nessun errore.

- [ ] **Step 8 — Verifica manuale con più di 50 messaggi**

Con backend e frontend in dev, apri un board, apri la chat sidebar e invia messaggi finché il totale supera 50 (o usa un board con storico). Invia poi un messaggio nuovo.

Atteso — il messaggio appena inviato resta visibile in fondo alla lista dopo la invalidate, e riaprendo la sidebar la chat mostra gli ultimi messaggi, non i primi. Stessa verifica su una card con più di 50 commenti nel `CardDetailModal`.

- [ ] **Step 9 — Commit**

```bash
git add backend/src/services/kanban/comments-chat.service.ts backend/src/services/kanban/__tests__/comments-chat.service.test.ts
git commit -m "fix(kanban): paginate board chat and card comments newest-first"
```

---

### Task 5.5: Batchare la lookup dei destinatari e togliere l'SMTP dal request path

**Perché:** `notifyBoardUsersTiered` fa un `prisma.user.findUnique` **per ogni destinatario** dentro il loop (`notifications.ts:104-107`) e, per i destinatari offline, **attende** l'invio SMTP (`:121-126`) — il tutto mentre la richiesta HTTP dell'utente che ha mosso la card è ancora aperta, perché il chiamante in `card.service.ts:280` fa `await`. Su un board con 8 partecipanti offline, spostare una card blocca l'utente per la durata di 8 invii SMTP in sequenza. Sintomo utente: la card "si incolla" per secondi dopo il drop.
**Severità:** high · **Effort:** M · **Rischio:** none — nessun contratto cambia; l'unica differenza semantica è che l'esito delle notifiche non fa più parte della risposta HTTP.

**File:**
- Modifica: `backend/src/services/kanban/notifications.ts:93-137`
- Modifica: `backend/src/services/kanban/card.service.ts:280` e `:312`
- Crea: `backend/src/services/kanban/__tests__/notifications.test.ts`

**Interfacce:**
- Consuma: nessuna
- Produce: `notifyBoardUsersTiered(...)` mantiene esattamente la stessa firma e continua a restituire `Promise<void>`; cambia solo il fatto che `moveCard` non la attende più

---

- [ ] **Step 1 — Rilevare il conteggio reale delle query e il pattern fire-and-forget già in uso**

Run: `cd backend && sed -n '99,108p' src/services/kanban/notifications.ts`

Atteso — dentro il loop per destinatario c'è **una** `prisma.user.findUnique` (riga 104); il costo è `1 + N` query utente per notifica, più N insert di notifica:
```
  for (const uid of recipientIds) {
    // Tier 1: User is viewing board → skip
    if (activeOnBoard.has(uid)) continue;

    try {
      const recipient = await prisma.user.findUnique({
        where: { id: uid },
        select: { lastActiveAt: true, email: true, locale: true, emailNotificationsEnabled: true },
      });
      if (!recipient) continue;
```

Nota che il `select` attuale **non** include `id`: la versione batch dovrà aggiungerlo, perché serve a costruire la Map.

Run: `cd backend && grep -rn "\.catch(" src/services/*.ts | grep -v __tests__`

Atteso — il pattern fire-and-forget del codebase, da replicare (catch esplicito con log, mai una promise fluttuante nuda):
```
src/services/announcement.service.ts:70:        sendPushNotification(user.id, payload).catch((err) => {
src/services/announcement.service.ts:75:    .catch((err) => {
src/services/push.service.ts:63:      .catch(async (error: unknown) => {
src/services/sharing.service.ts:198:        ).catch((e) => logger.error(e, 'Failed to send auto-share email'));
```

- [ ] **Step 2 — Creare il file di test (fallirà)**

Crea `backend/src/services/kanban/__tests__/notifications.test.ts` con questo contenuto completo:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock sibling services BEFORE imports ────────────────────
// notifications.ts loads these via dynamic `await import(...)`; vi.mock intercepts
// dynamic imports too (same shape as comments-chat.service.test.ts).

vi.mock('../../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
}));

vi.mock('../../email.service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../kanbanSSE', () => ({
  getPresenceUsers: vi.fn().mockReturnValue([]),
}));

// ─── Imports ──────────────────────────────────────────────────

import prisma from '../../../plugins/prisma';
import { notifyBoardUsersTiered, cardActionEmailDebounce } from '../notifications';
import { getPresenceUsers } from '../../kanbanSSE';
import { createNotification } from '../../notification.service';
import { makeUser, makeKanbanBoard } from '../../../__tests__/factories';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = prisma as any;

const emailTemplate = {
  type: 'KANBAN_CARD_MOVED' as const,
  data: (_email: string, locale: string) => ({ locale }),
};

beforeEach(() => {
  vi.clearAllMocks();
  cardActionEmailDebounce.clear();
  // Deterministic default: nobody is watching the board.
  vi.mocked(getPresenceUsers).mockReturnValue([]);
});

describe('notifyBoardUsersTiered', () => {
  it('looks up every recipient in ONE findMany, not one findUnique each', async () => {
    const board = makeKanbanBoard();
    const owner = makeUser();
    const shared1 = makeUser();
    const shared2 = makeUser();
    const actor = makeUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      title: board.title,
      ownerId: owner.id,
      shares: [{ userId: shared1.id }, { userId: shared2.id }],
    });

    prismaMock.user.findMany.mockResolvedValue([
      { id: owner.id, lastActiveAt: new Date(), email: owner.email, locale: 'en', emailNotificationsEnabled: false },
      { id: shared1.id, lastActiveAt: new Date(), email: shared1.email, locale: 'en', emailNotificationsEnabled: false },
      { id: shared2.id, lastActiveAt: new Date(), email: shared2.email, locale: 'en', emailNotificationsEnabled: false },
    ]);

    await notifyBoardUsersTiered(
      actor.id,
      board.id,
      'KANBAN_CARD_MOVED',
      'Card Moved',
      'someone moved a card',
      { boardId: board.id },
      emailTemplate,
    );

    expect(prismaMock.user.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();

    const whereArg = prismaMock.user.findMany.mock.calls[0][0].where;
    expect(whereArg.id.in).toHaveLength(3);
    expect(whereArg.id.in).toEqual(expect.arrayContaining([owner.id, shared1.id, shared2.id]));

    expect(createNotification).toHaveBeenCalledTimes(3);
  });

  it('excludes users active on the board from the batched lookup', async () => {
    const board = makeKanbanBoard();
    const owner = makeUser();
    const watching = makeUser();
    const actor = makeUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      title: board.title,
      ownerId: owner.id,
      shares: [{ userId: watching.id }],
    });

    vi.mocked(getPresenceUsers).mockReturnValue([
      { id: watching.id, name: watching.name, color: watching.color, avatarUrl: watching.avatarUrl },
    ]);

    prismaMock.user.findMany.mockResolvedValue([
      { id: owner.id, lastActiveAt: new Date(), email: owner.email, locale: 'en', emailNotificationsEnabled: false },
    ]);

    await notifyBoardUsersTiered(
      actor.id,
      board.id,
      'KANBAN_CARD_MOVED',
      'Card Moved',
      'someone moved a card',
      { boardId: board.id },
      emailTemplate,
    );

    const whereArg = prismaMock.user.findMany.mock.calls[0][0].where;
    expect(whereArg.id.in).toEqual([owner.id]);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does not query users at all when every recipient is on the board', async () => {
    const board = makeKanbanBoard();
    const owner = makeUser();
    const actor = makeUser();

    prismaMock.kanbanBoard.findUnique.mockResolvedValue({
      title: board.title,
      ownerId: owner.id,
      shares: [],
    });

    vi.mocked(getPresenceUsers).mockReturnValue([
      { id: owner.id, name: owner.name, color: owner.color, avatarUrl: owner.avatarUrl },
    ]);

    await notifyBoardUsersTiered(
      actor.id,
      board.id,
      'KANBAN_CARD_MOVED',
      'Card Moved',
      'someone moved a card',
      { boardId: board.id },
      emailTemplate,
    );

    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
```

`prisma.user.findMany` è già definito nel mock globale (`backend/src/__tests__/setup.ts:9`), quindi non serve alcuna riga di augmentation come quella per `kanbanCard.aggregate` in `card.service.test.ts`. `getPresenceUsers` restituisce `BoardUser[]` = `{ id, name, color, avatarUrl }` (`backend/src/services/kanbanSSE.ts:5-10`), che è la forma usata nei mock qui sopra.

- [ ] **Step 3 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/notifications.test.ts`

Atteso — FAIL sul primo test:
```
AssertionError: expected "findMany" to be called 1 times, but got 0 times
```

- [ ] **Step 4 — Sostituire la lookup per destinatario con una sola `findMany`**

Run: `cd backend && grep -n "Users currently connected" src/services/kanban/notifications.ts`

Atteso:
```
93:  // Users currently connected to this board via SSE
```

Sostituisci dal commento di riga 93 fino al `}` di riga 137 che chiude la funzione (cioè **tutta** la coda di `notifyBoardUsersTiered`, loop e chiusura funzione compresi). Testo attuale da sostituire:

```ts
  // Users currently connected to this board via SSE
  const activeOnBoard = new Set(getPresenceUsers(boardId).map((u) => u.id));

  const { createNotification } = await import('../notification.service');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  for (const uid of recipientIds) {
    // Tier 1: User is viewing board → skip
    if (activeOnBoard.has(uid)) continue;

    try {
      const recipient = await prisma.user.findUnique({
        where: { id: uid },
        select: { lastActiveAt: true, email: true, locale: true, emailNotificationsEnabled: true },
      });
      if (!recipient) continue;

      const isOnlineInApp = recipient.lastActiveAt && recipient.lastActiveAt > fiveMinutesAgo;

      // Always create DB notification (Tier 2 & 3)
      await createNotification(uid, type, title, message, data);

      // Tier 3: Offline → also send email (debounced)
      if (!isOnlineInApp && recipient.emailNotificationsEnabled) {
        const debounceKey = `card:${type}:${uid}:${boardId}`;
        const lastSent = cardActionEmailDebounce.get(debounceKey) || 0;
        if (Date.now() - lastSent >= debounceMs) {
          try {
            const emailService = await import('../email.service');
            await emailService.sendNotificationEmail(
              recipient.email,
              emailTemplate.type,
              emailTemplate.data(recipient.email, recipient.locale)
            );
            cardActionEmailDebounce.set(debounceKey, Date.now());
          } catch {
            // Email send failure is non-critical
          }
        }
      }
    } catch {
      // Silently continue
    }
  }
}
```

Testo nuovo:

```ts
  // Users currently connected to this board via SSE
  const activeOnBoard = new Set(getPresenceUsers(boardId).map((u) => u.id));

  // Tier 1: chi sta guardando la board non riceve nulla dal backend — si scartano
  // PRIMA di toccare il DB, così su una board tutta "presente" non parte nemmeno una query.
  const targetIds = Array.from(recipientIds).filter((uid) => !activeOnBoard.has(uid));
  if (targetIds.length === 0) return;

  // [BACKUP] 2026-08-31 — prima c'era una prisma.user.findUnique DENTRO il loop:
  // 1 + N query utente per ogni notifica. Ora una sola findMany, letta via Map.
  const recipients = await prisma.user.findMany({
    where: { id: { in: targetIds } },
    select: {
      id: true,
      lastActiveAt: true,
      email: true,
      locale: true,
      emailNotificationsEnabled: true,
    },
  });
  const recipientById = new Map(recipients.map((r) => [r.id, r]));

  const { createNotification } = await import('../notification.service');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  for (const uid of targetIds) {
    const recipient = recipientById.get(uid);
    if (!recipient) continue;

    try {
      const isOnlineInApp = recipient.lastActiveAt && recipient.lastActiveAt > fiveMinutesAgo;

      // Always create DB notification (Tier 2 & 3)
      await createNotification(uid, type, title, message, data);

      // Tier 3: Offline → also send email (debounced)
      if (!isOnlineInApp && recipient.emailNotificationsEnabled) {
        const debounceKey = `card:${type}:${uid}:${boardId}`;
        const lastSent = cardActionEmailDebounce.get(debounceKey) || 0;
        if (Date.now() - lastSent >= debounceMs) {
          try {
            const emailService = await import('../email.service');
            await emailService.sendNotificationEmail(
              recipient.email,
              emailTemplate.type,
              emailTemplate.data(recipient.email, recipient.locale)
            );
            cardActionEmailDebounce.set(debounceKey, Date.now());
          } catch {
            // Email send failure is non-critical
          }
        }
      }
    } catch {
      // Silently continue
    }
  }
}
```

Il blocco sostitutivo include la `}` finale della funzione: dopo l'incollaggio la riga successiva nel file deve essere quella vuota che precede `export { BOARD_CHAT_EMAIL_DEBOUNCE_MS };`. Verificalo con `cd backend && tail -3 src/services/kanban/notifications.ts`, che deve stampare:
```
}

export { BOARD_CHAT_EMAIL_DEBOUNCE_MS };
```

Non toccare `notifyBoardUsers` (righe 20-58): è la notifica semplice per l'assegnazione card, non ha né tiering né email.

- [ ] **Step 5 — Eseguire il test e vederlo passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/notifications.test.ts`

Atteso — PASS:
```
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

- [ ] **Step 6 — Togliere l'`await` dal call site in `moveCard`**

Run: `cd backend && grep -n "await notifyBoardUsersTiered(" src/services/kanban/card.service.ts`

Atteso — una sola occorrenza, dentro `moveCard`:
```
280:      await notifyBoardUsersTiered(
```

Sostituisci la riga 280:

```ts
      await notifyBoardUsersTiered(
```

con:

```ts
      // [BACKUP] 2026-08-31 — era `await notifyBoardUsersTiered(...)`: la richiesta HTTP
      // del move restava aperta per tutta la durata degli invii SMTP ai partecipanti
      // offline. Fire-and-forget con catch esplicito (stesso pattern di
      // sharing.service.ts:198 e announcement.service.ts:75).
      notifyBoardUsersTiered(
```

e sostituisci la riga 312, cioè il `);` che chiude quella chiamata (subito prima del `}` di riga 313 che chiude `if (!skipNotification) {`):

```ts
      );
```

con:

```ts
      ).catch((err) =>
        logger.error({ err, cardId, boardId }, 'Failed to notify board users of card move')
      );
```

`logger` è già importato in `card.service.ts` (riga 2) e già usato altrove nel file: non aggiungere import.

Attenzione: **non** toccare l'altra chiamata `await notifyBoardUsersTiered(` che sta più in basso (dentro `bulkMoveNotify`, intorno a riga 540). Quella è già fuori dal percorso caldo del drag&drop ed è l'unico punto che emette la notifica raggruppata su cui si appoggia la Task 5.6.

- [ ] **Step 7 — Eseguire i test di `card.service` e vederli passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`

Atteso — PASS. Il test che asserisce `expect(notifyBoardUsersTiered).toHaveBeenCalledWith(...)` continua a valere: la funzione viene invocata in modo sincrono, cambia solo il fatto che non se ne attende la risoluzione, e il mock in testa al file è `notifyBoardUsersTiered: vi.fn().mockResolvedValue(undefined)`, quindi il `.catch` non scatta.
```
 Test Files  1 passed (1)
```

- [ ] **Step 8 — Lint e typecheck**

Run: `cd backend && npx tsc --noEmit && npm run lint`

Atteso — nessun errore. (Nota: `backend/eslint.config.mjs` non abilita regole type-aware, quindi `@typescript-eslint/no-floating-promises` non esiste in questo progetto: il `.catch` va messo comunque, perché senza di esso un fallimento SMTP diventa una unhandled rejection sul processo Node.)

- [ ] **Step 9 — Verifica manuale della latenza del move**

Con backend e frontend in dev e un board condiviso con almeno due utenti offline (con `emailNotificationsEnabled` a true), sposta una card fra colonne guardando DevTools → Network.

Atteso — `PUT /api/kanban/cards/<id>/move` risponde nell'ordine delle decine di millisecondi, non attende gli invii SMTP. Nei log del backend le righe relative agli invii email compaiono **dopo** che la risposta è stata scritta.

- [ ] **Step 10 — Commit**

```bash
git add backend/src/services/kanban/notifications.ts backend/src/services/kanban/card.service.ts backend/src/services/kanban/__tests__/notifications.test.ts
git commit -m "perf(kanban): batch tiered-notification recipient lookup, unblock move from SMTP"
```

---

### Task 5.6: Eliminare il doppio invio di ogni card in `handleBulkMove`

**Perché:** selezionando 20 card con la marquee e spostandole, il frontend manda **40** richieste di move: 20 dalla coda di sync (via `dnd.handleMoveCardToColumn` → `mutations.moveCard` → `kanbanService.moveCard` → `syncQueue`) e 20 come `api.put(...?silent=true)` grezze con `.catch(() => {})`. Le seconde sono silenziose, le prime no — quindi arrivano anche 20 notifiche individuali "X ha spostato la card Y", che è esattamente ciò che l'endpoint di notifica raggruppata `POST /kanban/boards/:boardId/bulk-move-notify` (`backend/src/routes/kanban.ts:476`) esisteva per evitare. Inoltre ogni card viene mossa due volte lato server con `position: 999`, riordinando la colonna di destinazione due volte.
**Severità:** high · **Effort:** M · **Rischio:** TIER 1 — una delle cinque modifiche è in `frontend/src/features/sync/syncService.ts`, che va in un commit separato (Step 5) prima del resto.

> **⚠️ AVVISO MULTI-FILE (>3 file).** Questa task tocca 5 file di produzione più 2 di test:
> - `frontend/src/features/sync/syncService.ts` — supporto al flag `silent` in `syncPush` (TIER 1, commit isolato)
> - `frontend/src/features/sync/__tests__/syncService.test.ts` — due test per il ramo sopra (stesso commit TIER 1)
> - `frontend/src/features/kanban/kanbanService.ts` — `moveCard` accetta e propaga `silent`
> - `frontend/src/features/kanban/hooks/useKanbanMutations.ts` — la mutation `moveCard` inoltra `silent`
> - `frontend/src/features/kanban/hooks/useBoardDnD.ts` — `handleMoveCardToColumn` accetta un terzo parametro opzionale
> - `frontend/src/features/kanban/KanbanBoardPage.tsx` — cancella il loop di PUT duplicati
> - `frontend/src/features/kanban/__tests__/kanbanService.test.ts` — test
>
> Leggi questo avviso prima di iniziare; se il revisore preferisce accettare N notifiche individuali invece di questa catena, l'alternativa minima è cancellare **sia** il loop di PUT **sia** la POST `bulk-move-notify` (1 solo file), rinunciando alla notifica raggruppata e lasciando morto l'endpoint backend. Il piano qui sotto **non** sceglie quella strada.

**File:**
- Modifica: `frontend/src/features/sync/syncService.ts:688-698`
- Modifica: `frontend/src/features/sync/__tests__/syncService.test.ts` (due test in `describe('kanban push')`, che apre alla riga 856)
- Modifica: `frontend/src/features/kanban/kanbanService.ts:372-385`
- Modifica: `frontend/src/features/kanban/hooks/useKanbanMutations.ts:106-113`
- Modifica: `frontend/src/features/kanban/hooks/useBoardDnD.ts:269-270` e `:294-297`
- Modifica: `frontend/src/features/kanban/KanbanBoardPage.tsx:356-365`
- Modifica: `frontend/src/features/kanban/__tests__/kanbanService.test.ts:50` (import) e in coda al file

**Interfacce:**
- Consuma: nessuna
- Produce: `moveCard(cardId: string, toColumnId: string, position: number, silent?: boolean): Promise<void>` in `kanbanService`; `handleMoveCardToColumn(cardId: string, targetColumnId: string, silent?: boolean): void` in `useBoardDnD`; la mutation `moveCard` di `useKanbanMutations` accetta `{ cardId: string; toColumnId: string; position: number; silent?: boolean }`

---

- [ ] **Step 1 — Leggere i due percorsi e stabilire quale sopravvive**

Run: `cd frontend && sed -n '292,297p' src/features/kanban/hooks/useBoardDnD.ts`

Atteso — `handleMoveCardToColumn` **già persiste** il move, non fa solo l'update ottimistico:
```
      // Persist to backend
      setIsMoveInFlight(true);
      mutations.moveCard.mutate(
        { cardId, toColumnId: targetColumnId, position: 999 },
        { onSettled: () => setIsMoveInFlight(false) },
      );
```

Run: `cd frontend && sed -n '376,384p' src/features/kanban/kanbanService.ts && sed -n '690,695p' src/features/sync/syncService.ts`

Atteso — il percorso A (coda di sync) scrive in Dexie e accoda, e `syncPush` traduce l'item in una PUT **senza** `?silent=true`:
```
  await db.kanbanCards.update(cardId, { columnId: toColumnId, position, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_CARD',
    entityId: cardId,
    userId,
    data: { columnId: toColumnId, position },
    createdAt: Date.now(),
  });
            if (cardData?.columnId) {
              // Move operation — route to dedicated move endpoint
              await api.put(`/kanban/cards/${item.entityId}/move`, {
                toColumnId: cardData.columnId,
                position: cardData.position ?? 0,
              });
            } else {
```

**Sopravvive il percorso A, la coda di sync.** Motivi: (1) scrive in Dexie, quindi la board resta corretta offline e dopo un reload; (2) è ritentata con backoff e marcata `failed` su 4xx non recuperabili, e i suoi errori vengono mostrati dal `SyncStatusIndicator`, mentre il PUT grezzo li ingoia con `.catch(() => {})`; (3) è lo stesso percorso di ogni altro move dell'app, quindi non ci sono due semantiche da mantenere. Il percorso B contribuisce **solo** il flag `?silent=true` — che il backend legge davvero, `backend/src/routes/kanban.ts:463`: `const silent = (request.query as { silent?: string }).silent === 'true';`. Quel flag va portato dentro il percorso A, e il percorso B cancellato.

- [ ] **Step 2 — Scrivere i due test sul ramo `syncPush` (falliranno)**

Run: `cd frontend && grep -n "pushes CREATE kanban card with column-based URL" src/features/sync/__tests__/syncService.test.ts`

Atteso:
```
930:    it('pushes CREATE kanban card with column-based URL', async () => {
```

Aggiungi questi due test subito dopo il `});` che chiude quel test (riga 949) e prima del `});` che chiude `describe('kanban push')` (riga 950):

```ts
    it('appends ?silent=true to a card move whose queue item carries the silent flag', async () => {
      const queueItem = {
        id: 45, type: 'UPDATE' as const, entity: 'KANBAN_CARD' as const, entityId: 'card-bulk',
        userId: 'user-1', data: { columnId: 'col-2', position: 999, silent: true },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);

      await syncPush();

      // `silent` is a queue-local flag: it rides in the URL, never in the body.
      expect(mockApi.put).toHaveBeenCalledWith('/kanban/cards/card-bulk/move?silent=true', {
        toColumnId: 'col-2',
        position: 999,
      });
    });

    it('leaves a normal card move without the silent query param', async () => {
      const queueItem = {
        id: 46, type: 'UPDATE' as const, entity: 'KANBAN_CARD' as const, entityId: 'card-plain',
        userId: 'user-1', data: { columnId: 'col-2', position: 3 },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);

      await syncPush();

      expect(mockApi.put).toHaveBeenCalledWith('/kanban/cards/card-plain/move', {
        toColumnId: 'col-2',
        position: 3,
      });
    });
```

- [ ] **Step 3 — Eseguire i test e vedere fallire il primo**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts -t "appends ?silent=true"`

Atteso — FAIL (l'URL prodotto oggi non ha il query param):
```
AssertionError: expected "spy" to be called with arguments: [ '/kanban/cards/card-bulk/move?silent=true', … ]
Received: "/kanban/cards/card-bulk/move"
```

Il secondo test (`leaves a normal card move without...`) passa già oggi: è la rete di sicurezza contro un suffisso applicato sempre.

- [ ] **Step 4 — Insegnare a `syncPush` a propagare il flag (TIER 1, prima e da solo)**

Run: `cd frontend && grep -n "Move operation — route to dedicated move endpoint" src/features/sync/syncService.ts`

Atteso:
```
691:              // Move operation — route to dedicated move endpoint
```

Sostituisci le righe 688-698:

```ts
          } else if (item.type === 'UPDATE') {
            const cardData = item.data as Record<string, unknown> | undefined;
            if (cardData?.columnId) {
              // Move operation — route to dedicated move endpoint
              await api.put(`/kanban/cards/${item.entityId}/move`, {
                toColumnId: cardData.columnId,
                position: cardData.position ?? 0,
              });
            } else {
              await api.put(`/kanban/cards/${item.entityId}`, item.data);
            }
```

con:

```ts
          } else if (item.type === 'UPDATE') {
            const cardData = item.data as Record<string, unknown> | undefined;
            if (cardData?.columnId) {
              // Move operation — route to dedicated move endpoint.
              // `silent` is a queue-local flag (never part of the request body): bulk
              // moves suppress the per-card notification because KanbanBoardPage sends
              // one grouped notification via POST /kanban/boards/:id/bulk-move-notify.
              const suffix = cardData.silent ? '?silent=true' : '';
              await api.put(`/kanban/cards/${item.entityId}/move${suffix}`, {
                toColumnId: cardData.columnId,
                position: cardData.position ?? 0,
              });
            } else {
              await api.put(`/kanban/cards/${item.entityId}`, item.data);
            }
```

`SyncQueueItem.data` è tipizzata `Record<string, unknown>` (`frontend/src/lib/db.ts`), quindi la chiave `silent` non richiede alcun cambio di tipo.

- [ ] **Step 5 — Verificare e committare da solo la modifica TIER 1**

Run: `cd frontend && npx vitest run src/features/sync/__tests__/syncService.test.ts && npx tsc -p tsconfig.app.json`

Atteso — PASS su tutta la suite di sync, i due nuovi test compresi:
```
 Test Files  1 passed (1)
```

```bash
git add frontend/src/features/sync/syncService.ts frontend/src/features/sync/__tests__/syncService.test.ts
git commit -m "feat(kanban): honour a silent flag on queued card moves in syncPush"
```

- [ ] **Step 6 — Scrivere il test sul flag `silent` in `kanbanService` (fallirà)**

In `frontend/src/features/kanban/__tests__/kanbanService.test.ts`, aggiorna l'import di riga 50:

```ts
import { deleteCard, createCard, splitTextForCard, CARD_TITLE_MAX, CARD_DESCRIPTION_MAX } from '../kanbanService';
```

in:

```ts
import { deleteCard, createCard, moveCard, splitTextForCard, CARD_TITLE_MAX, CARD_DESCRIPTION_MAX } from '../kanbanService';
```

e aggiungi in fondo al file (dopo l'ultimo `});`):

```ts
describe('moveCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a plain move without a silent flag by default', async () => {
    await moveCard('card-1', 'col-2', 3);

    const queued = mockDb.syncQueue.add.mock.calls[0][0];
    expect(queued).toEqual(
      expect.objectContaining({
        type: 'UPDATE',
        entity: 'KANBAN_CARD',
        entityId: 'card-1',
        data: { columnId: 'col-2', position: 3 },
      }),
    );
    expect('silent' in queued.data).toBe(false);
  });

  it('marks the queued move as silent when asked (bulk move: one grouped notification)', async () => {
    await moveCard('card-1', 'col-2', 999, true);

    const queued = mockDb.syncQueue.add.mock.calls[0][0];
    expect(queued.data).toEqual({ columnId: 'col-2', position: 999, silent: true });
  });
});
```

- [ ] **Step 7 — Eseguire il test e vederlo fallire**

Run: `cd frontend && npx vitest run src/features/kanban/__tests__/kanbanService.test.ts -t "marks the queued move as silent"`

Atteso — FAIL:
```
AssertionError: expected { columnId: 'col-2', position: 999 } to deeply equal { columnId: 'col-2', position: 999, silent: true }
```

- [ ] **Step 8 — Propagare `silent` in `kanbanService.moveCard`**

Run: `cd frontend && grep -n "export async function moveCard" src/features/kanban/kanbanService.ts`

Atteso:
```
372:export async function moveCard(cardId: string, toColumnId: string, position: number): Promise<void> {
```

Sostituisci le righe 372-385:

```ts
export async function moveCard(cardId: string, toColumnId: string, position: number): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.kanbanCards.update(cardId, { columnId: toColumnId, position, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_CARD',
    entityId: cardId,
    userId,
    data: { columnId: toColumnId, position },
    createdAt: Date.now(),
  });
}
```

con:

```ts
/**
 * Move a card. `silent` suppresses the per-card backend notification — used by bulk
 * move, which sends one grouped notification instead. The flag rides in the queue
 * item's data and is turned into `?silent=true` by syncPush; it is never sent in the body.
 */
export async function moveCard(
  cardId: string,
  toColumnId: string,
  position: number,
  silent?: boolean,
): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.kanbanCards.update(cardId, { columnId: toColumnId, position, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_CARD',
    entityId: cardId,
    userId,
    data: silent
      ? { columnId: toColumnId, position, silent: true }
      : { columnId: toColumnId, position },
    createdAt: Date.now(),
  });
}
```

- [ ] **Step 9 — Eseguire il test e vederlo passare**

Run: `cd frontend && npx vitest run src/features/kanban/__tests__/kanbanService.test.ts`

Atteso — PASS su tutto il file (i test preesistenti su `splitTextForCard`, `createCard` e `deleteCard` compresi):
```
 Test Files  1 passed (1)
```

- [ ] **Step 10 — Inoltrare `silent` attraverso mutation e hook DnD**

Run: `cd frontend && grep -n "const moveCard = useMutation" src/features/kanban/hooks/useKanbanMutations.ts`

Atteso:
```
106:  const moveCard = useMutation({
```

Sostituisci le righe 106-113:

```ts
  const moveCard = useMutation({
    mutationFn: ({ cardId, toColumnId, position }: { cardId: string; toColumnId: string; position: number }) =>
      kanbanService.moveCard(cardId, toColumnId, position),
    onSuccess: () => {
      flushSync();
      invalidateBoard();
    },
  });
```

con:

```ts
  const moveCard = useMutation({
    mutationFn: ({ cardId, toColumnId, position, silent }: { cardId: string; toColumnId: string; position: number; silent?: boolean }) =>
      kanbanService.moveCard(cardId, toColumnId, position, silent),
    onSuccess: () => {
      flushSync();
      invalidateBoard();
    },
  });
```

Run: `cd frontend && grep -n "const handleMoveCardToColumn = useCallback" src/features/kanban/hooks/useBoardDnD.ts`

Atteso:
```
269:  const handleMoveCardToColumn = useCallback(
```

Sostituisci le righe 269-270:

```ts
  const handleMoveCardToColumn = useCallback(
    (cardId: string, targetColumnId: string) => {
```

con:

```ts
  // `silent` (bulk move) suppresses the per-card backend notification.
  // Optional with a default on purpose: the 2-arg prop signatures in KanbanCard
  // (`onMoveToColumn?: (cardId: string, targetColumnId: string) => void`),
  // KanbanColumn and CardContextMenu stay assignable without touching them.
  const handleMoveCardToColumn = useCallback(
    (cardId: string, targetColumnId: string, silent = false) => {
```

e sostituisci le righe 294-297:

```ts
      mutations.moveCard.mutate(
        { cardId, toColumnId: targetColumnId, position: 999 },
        { onSettled: () => setIsMoveInFlight(false) },
      );
```

con:

```ts
      mutations.moveCard.mutate(
        { cardId, toColumnId: targetColumnId, position: 999, silent },
        { onSettled: () => setIsMoveInFlight(false) },
      );
```

- [ ] **Step 11 — Cancellare il loop di PUT duplicati**

Run: `cd frontend && grep -n "Optimistic UI + silent REST calls" src/features/kanban/KanbanBoardPage.tsx`

Atteso:
```
356:    // Optimistic UI + silent REST calls (bypass sync queue notifications)
```

Sostituisci le righe 356-365:

```ts
    // Optimistic UI + silent REST calls (bypass sync queue notifications)
    for (const move of moves) {
      dnd.handleMoveCardToColumn(move.cardId, move.toColumnId);
    }
    for (const move of moves) {
      api.put(`/kanban/cards/${move.cardId}/move?silent=true`, {
        toColumnId: move.toColumnId,
        position: 999,
      }).catch(() => {});
    }
```

con:

```ts
    // [BACKUP] 2026-08-31 — qui c'era un SECONDO loop che rimandava ogni card come
    // `api.put('/kanban/cards/:id/move?silent=true').catch(() => {})`. Ogni card partiva
    // due volte (una dalla coda di sync, una raw), il server la spostava due volte con
    // position 999, e la PUT della coda NON era silent → arrivava anche una notifica per
    // card, annullando la notifica raggruppata qui sotto. Ora il flag silent viaggia
    // dentro l'item di coda (kanbanService.moveCard → syncPush → ?silent=true), quindi
    // resta un solo invio per card, ritentabile e con errori visibili nel SyncStatusIndicator.
    for (const move of moves) {
      dnd.handleMoveCardToColumn(move.cardId, move.toColumnId, true);
    }
```

La POST `bulk-move-notify` due righe sotto resta invariata: è ora l'unica notifica emessa per l'operazione.

- [ ] **Step 12 — Typecheck e lint**

Run: `cd frontend && npx tsc -p tsconfig.app.json && npm run lint`

Atteso — nessun errore. In particolare nessun `'api' is declared but its value is never read`: `api` resta usato in `KanbanBoardPage.tsx` per la POST `bulk-move-notify` (`api.post(\`/kanban/boards/${board.id}/bulk-move-notify\`, { moves })`).

- [ ] **Step 13 — Verifica manuale del conteggio richieste**

Con backend e frontend in dev, apri un board con almeno 5 card, selezionane 5 con la marquee, spostale in un'altra colonna, guardando DevTools → Network filtrato su `kanban/cards`.

Atteso — esattamente **5** `PUT /api/kanban/cards/<id>/move?silent=true` (non 10, e tutte con il query param) più **1** `POST /api/kanban/boards/<id>/bulk-move-notify`. Nella campanella notifiche di un secondo utente che condivide il board compare **una sola** notifica raggruppata (il testo lo compone `bulkMoveNotify` in `card.service.ts`, raggruppando i move per coppia colonna-origine → colonna-destinazione), non cinque notifiche individuali.

- [ ] **Step 14 — E2E kanban**

Run: `cd frontend && npx playwright test e2e/kanban.spec.ts`

Atteso — tutti gli spec passano.

- [ ] **Step 15 — Commit**

```bash
git add frontend/src/features/kanban/kanbanService.ts frontend/src/features/kanban/hooks/useKanbanMutations.ts frontend/src/features/kanban/hooks/useBoardDnD.ts frontend/src/features/kanban/KanbanBoardPage.tsx frontend/src/features/kanban/__tests__/kanbanService.test.ts
git commit -m "fix(kanban): send each bulk-moved card once, keep the grouped notification"
```

---

## Stage 6 — Rinviabile (nessuna dipendenza, eseguibile quando c'è tempo)

Questo stage è rinviabile perché **nulla qui sblocca o nasconde un altro difetto**: nessun task di Stage 0–5 dipende da questi cambiamenti, e nessuno di questi cambiamenti maschera un bug che gli altri stage devono vedere. Sono cinque interventi indipendenti fra loro (accessibilità, chiarezza dei filtri, hardening degli upload, query limitate, CI e2e) che si possono prendere in qualsiasi ordine e in qualsiasi momento. Prerequisito unico: il branch deve essere pulito e i test verdi (`cd backend && npm test`, `cd frontend && npm test`). Il Task 6.5 in particolare va fatto **dopo** che Stage 3 si è assestato, perché la suite Playwright interroga la UI e un refactor in corso la farebbe fallire per motivi non diagnostici.

> **Nota sui numeri di riga.** Tutti i numeri qui sotto sono verificati contro `HEAD` (`141e6af`). Stage 2, 3 e 5 toccano `KanbanBoardPage.tsx`, `card.service.ts`, `routes/kanban.ts` e i loro test: se esegui Stage 6 **dopo** quelli, i numeri slittano. In ogni step è riportato anche il **testo esatto** da cercare, che resta valido a prescindere. Stessa cosa dentro lo stage: il Task 6.1 aggiunge 11 righe a `en.json`/`it.json` prima della chiave `kanban.filters`, quindi eseguire 6.1 prima di 6.2/6.4 sposta in giù i riferimenti a quelle due chiavi.

> **Nota sul typecheck frontend.** `cd frontend && npx tsc --noEmit` **esce 0 senza compilare niente**: `frontend/tsconfig.json` ha `"files": []` e due sole `references`. Il typecheck reale è `npx tsc -p tsconfig.app.json --noEmit` (equivalente al `tsc -b` di `npm run build`), ed è quello usato in tutti gli step qui sotto. `tsconfig.app.json` ha `"include": ["src"]`, quindi typecheck anche i file `*.test.ts(x)`.

> **Baseline lint (verificata su `HEAD`).** `cd frontend && npm run lint` → `✖ 52 problems (0 errors, 52 warnings)`, exit 0. `cd backend && npm run lint` → `✖ 63 problems (0 errors, 63 warnings)`, exit 0. In tutti gli step "Atteso" significa **0 errors** e conteggio warning invariato: non introdurre nuovi warning, non pretendere di azzerare quelli esistenti.

---

### Task 6.1: Sweep di accessibilità sul kanban (label, tastiera, hover-trap)

**Perché:** Oggi su tutta la superficie kanban 15 pulsanti icona vengono annunciati da uno screen reader come "button" senza altro; le card (sia le card del board sia le board nella lista) si aprono solo col mouse; i tre sottomenu del context menu si aprono solo con `onMouseEnter` e sono quindi irraggiungibili da tastiera; e tre controlli (menu della BoardCard, controlli cover, rimozione avatar) sono `opacity-0` fino all'hover, quindi su touch semplicemente non esistono. `frontend/CLAUDE.md` ("Accessibilità mobile") prescrive già `aria-label` obbligatorio su tutti i bottoni icon-only e un equivalente touch per ogni interazione hover-only: questo task porta il kanban in regola.
**Severità:** medium · **Effort:** M · **Rischio:** none — nessun file TIER 1/TIER 2 coinvolto.

**File:**
- Modifica: `frontend/src/features/kanban/KanbanPage.tsx:76-81`
- Modifica: `frontend/src/features/kanban/KanbanBoardPage.tsx:409`, `:437-442`, `:444-449`, `:469`, `:610-613`
- Modifica: `frontend/src/features/kanban/components/KanbanColumn.tsx:135-141`, `:184-189`
- Modifica: `frontend/src/features/kanban/components/KanbanCard.tsx:152-157`, `:174-180`
- Modifica: `frontend/src/features/kanban/components/BoardCard.tsx:59-62`, `:78-88`
- Modifica: `frontend/src/features/kanban/components/CardContextMenu.tsx:236-273`
- Modifica: `frontend/src/features/kanban/components/CardDetailModal.tsx:549-554`
- Modifica: `frontend/src/features/kanban/components/KanbanFilterBar.tsx:181-183`, `:370-375`
- Modifica: `frontend/src/features/kanban/components/NoteLinkPicker.tsx:61-66`
- Modifica: `frontend/src/features/kanban/components/TaskListLinkPicker.tsx:61-66`
- Modifica: `frontend/src/features/kanban/components/BoardChatSidebar.tsx:173-179`, `:214-219`
- Modifica: `frontend/src/locales/en.json:971` (inserimento prima di `"filters": {`), `frontend/src/locales/it.json:1226` (idem)
- Crea: `frontend/src/features/kanban/components/__tests__/kanbanA11y.test.tsx`

**Interfacce:**
- Consuma: nessuna
- Produce: chiavi i18n `kanban.a11y.*` (`backToBoards`, `boardMenu`, `boardCardMenu`, `columnMenu`, `dragColumn`, `dragCard`, `deleteComment`, `clearSearch`, `closeChat` — 9 chiavi); riuso di `common.menu`, `common.send` (già presenti in entrambi i locale)

---

- [ ] **Step 1 — Scrivere il test che fallisce**

Crea `frontend/src/features/kanban/components/__tests__/kanbanA11y.test.tsx`. Il mock i18n restituisce la chiave verbatim (stessa forma di `CardContextMenu.test.tsx`, che sta nella stessa cartella), quindi `t('kanban.a11y.columnMenu', { title })` ritorna la stringa `kanban.a11y.columnMenu`. `BoardCard` legge anche `i18n.language`, quindi il mock deve esporre `i18n: { language: 'en' }` — `CardContextMenu.test.tsx` non lo fa perché quel componente non lo usa.

Verificato: `KanbanColumn` e `BoardCard` si montano in jsdom **senza** `DndContext`/`SortableContext` (dnd-kit ha context di default) e senza `QueryClientProvider`. `LocalKanbanBoard` è un `import type` in `BoardCard`, quindi Dexie non viene mai istanziato: niente `fake-indexeddb`.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// i18n: return the key verbatim so we can query by accessible name
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

import KanbanColumn from '../KanbanColumn';
import BoardCard from '../BoardCard';
import type { KanbanColumn as KanbanColumnType, KanbanCard as KanbanCardType } from '../../types';
import type { LocalKanbanBoard } from '../../../../lib/db';

const card = {
  id: 'c1',
  title: 'Card One',
  position: 0,
  columnId: 'col-1',
  commentCount: 0,
  description: null,
  assignee: null,
  assigneeId: null,
  dueDate: null,
  priority: null,
  noteId: null,
} as unknown as KanbanCardType;

const column = {
  id: 'col-1',
  title: 'Todo',
  position: 0,
  isCompleted: false,
  boardId: 'b1',
  cards: [card],
} as unknown as KanbanColumnType;

const board = {
  id: 'b1',
  title: 'My Board',
  ownership: 'owned',
  columnCount: 1,
  cardCount: 0,
  description: null,
  coverImage: null,
  avatarUrl: null,
  shareCount: 0,
  updatedAt: new Date().toISOString(),
} as unknown as LocalKanbanBoard;

describe('kanban a11y — icon-only buttons have accessible names', () => {
  it('KanbanColumn labels the drag handle and the column menu', () => {
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={vi.fn()}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'kanban.a11y.dragColumn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kanban.a11y.columnMenu' })).toBeInTheDocument();
  });

  it('KanbanCard labels its drag handle', () => {
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={vi.fn()}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
      />
    );

    // The handle is a <div>; dnd-kit's {...attributes} already gives it role="button".
    expect(screen.getByRole('button', { name: 'kanban.a11y.dragCard' })).toBeInTheDocument();
  });

  it('BoardCard labels its context-menu button', () => {
    render(<BoardCard board={board} onSelect={vi.fn()} onShare={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'kanban.a11y.boardCardMenu' })).toBeInTheDocument();
  });
});

describe('kanban a11y — cards are operable from the keyboard', () => {
  it('KanbanCard body opens the card on Enter', () => {
    const onCardSelect = vi.fn();
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={onCardSelect}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
      />
    );

    const body = screen.getByRole('button', { name: 'Card One' });
    fireEvent.keyDown(body, { key: 'Enter' });

    expect(onCardSelect).toHaveBeenCalledWith('c1');
  });

  it('BoardCard opens the board on Space', () => {
    const onSelect = vi.fn();
    render(<BoardCard board={board} onSelect={onSelect} onShare={vi.fn()} onDelete={vi.fn()} />);

    const root = screen.getByRole('button', { name: /My Board/ });
    fireEvent.keyDown(root, { key: ' ' });

    expect(onSelect).toHaveBeenCalledWith('b1');
  });
});
```

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd frontend && npx vitest run src/features/kanban/components/__tests__/kanbanA11y.test.tsx`
Atteso: **FAIL**, `Tests 5 failed (5)`. Il primo errore è testualmente:
`TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "kanban.a11y.dragColumn"`
Gli altri quattro sono lo stesso errore con i nomi `"kanban.a11y.dragCard"`, `"kanban.a11y.boardCardMenu"`, `"Card One"` e `` `/My Board/` ``.

- [ ] **Step 3 — Aggiungere le chiavi i18n in `en.json`**

In `frontend/src/locales/en.json` c'è `    "filters": {` a riga 971, dentro l'oggetto `"kanban"` (che inizia a riga 811). Inserisci **subito prima** di quella riga (indentazione 4 spazi):

```json
    "a11y": {
      "backToBoards": "Back to boards",
      "boardMenu": "Board menu",
      "boardCardMenu": "Menu for board {{title}}",
      "columnMenu": "Menu for column {{title}}",
      "dragColumn": "Drag column {{title}}",
      "dragCard": "Drag card {{title}}",
      "deleteComment": "Delete comment",
      "clearSearch": "Clear search",
      "closeChat": "Close chat"
    },
```

- [ ] **Step 4 — Aggiungere le stesse chiavi in `it.json`**

In `frontend/src/locales/it.json` c'è `    "filters": {` a riga 1226, dentro `"kanban"` (che inizia a riga 1066). Inserisci **subito prima** di quella riga:

```json
    "a11y": {
      "backToBoards": "Torna alle bacheche",
      "boardMenu": "Menu bacheca",
      "boardCardMenu": "Menu della bacheca {{title}}",
      "columnMenu": "Menu della colonna {{title}}",
      "dragColumn": "Trascina la colonna {{title}}",
      "dragCard": "Trascina la card {{title}}",
      "deleteComment": "Elimina commento",
      "clearSearch": "Cancella ricerca",
      "closeChat": "Chiudi chat"
    },
```

- [ ] **Step 5 — Verificare che i due file locale siano ancora JSON valido e allineati**

`frontend/package.json` ha `"type": "module"`, ma `node -e` valuta comunque in CommonJS: il `require` sotto funziona (verificato).

Run: `cd frontend && node -e "const en=require('./src/locales/en.json'),it=require('./src/locales/it.json');const a=Object.keys(en.kanban.a11y).sort(),b=Object.keys(it.kanban.a11y).sort();console.log(JSON.stringify(a)===JSON.stringify(b)?'KEYS MATCH: '+a.length:'MISMATCH')"`
Atteso: `KEYS MATCH: 9`

- [ ] **Step 6 — `KanbanColumn.tsx`: label sul drag handle (righe 135-141) e sul menu colonna (righe 184-189)**

`displayTitle` è già calcolato a riga 76 (`const displayTitle = translationKey ? t(translationKey) : column.title;`) e `t` è disponibile da riga 45. `{...attributes}` di dnd-kit fornisce già `role="button"` e `tabindex="0"` — manca solo il nome, quindi l'`aria-label` va **dopo** gli spread.

Sostituisci il blocco alle righe 135-141:

```tsx
          <button
            className="flex-shrink-0 cursor-grab active:cursor-grabbing text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors touch-none"
            {...attributes}
            {...listeners}
            aria-label={t('kanban.a11y.dragColumn', { title: displayTitle })}
          >
            <GripVertical size={16} />
          </button>
```

Sostituisci il blocco alle righe 184-189:

```tsx
            <button
              onClick={() => setShowMenu(!showMenu)}
              aria-label={t('kanban.a11y.columnMenu', { title: displayTitle })}
              aria-haspopup="menu"
              aria-expanded={showMenu}
              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 p-0.5 rounded transition-colors"
            >
              <MoreVertical size={16} />
            </button>
```

- [ ] **Step 7 — `KanbanCard.tsx`: label sul drag handle (righe 152-157) e apertura da tastiera del corpo card (righe 174-180)**

Il drag handle è largo 4px (`w-1`) e senza nome accessibile; dnd-kit gli dà già `role="button" tabindex="0"` (verificato in jsdom).

Sostituisci il blocco alle righe 152-157:

```tsx
            <div
              data-dnd-handle
              {...attributes}
              {...listeners}
              aria-label={t('kanban.a11y.dragCard', { title: card.title || t('kanban.card.untitled') })}
              className="flex-shrink-0 self-stretch w-1 rounded-full bg-neutral-200 dark:bg-neutral-700 hover:bg-neutral-400 dark:hover:bg-neutral-500 active:bg-neutral-500 dark:active:bg-neutral-400 cursor-grab active:cursor-grabbing touch-none transition-colors"
            />
```

Aggiungi il gestore tastiera subito **dopo** `handleCardClick` (che finisce a riga 125 con `}, [card.id, onSelect]);`). `useCallback` è già importato a riga 1:

```tsx
  const handleCardKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Let the inner three-dot button handle its own Enter/Space
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleCardClick();
  }, [handleCardClick]);
```

Sostituisci il blocco alle righe 174-180:

```tsx
          <div
            className="flex-1 min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:focus-visible:ring-emerald-400"
            role="button"
            tabIndex={0}
            onClick={handleCardClick}
            onKeyDown={handleCardKeyDown}
            onTouchStart={handleCardTouchStart}
            onTouchEnd={handleCardTouchEnd}
            onTouchMove={handleCardTouchMove}
          >
```

- [ ] **Step 8 — `BoardCard.tsx`: apertura da tastiera (righe 59-62), label sul menu e fine del touch-trap (righe 78-88)**

Aggiungi il gestore tastiera subito **dopo** `handleDelete` (che finisce a riga 56 con `}`), prima del `return (` di riga 58. `React.MouseEvent` è già usato nel file (righe 41/46/52), quindi il namespace `React` è disponibile anche per `React.KeyboardEvent`:

```tsx
  function handleCardKeyDown(e: React.KeyboardEvent): void {
    // Inner buttons (menu, shares) bubble their own Enter/Space — ignore those
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onSelect(board.id);
  }
```

Sostituisci il blocco alle righe 59-62 (il `<div>` radice, dal `<div` fino al `>` incluso):

```tsx
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(board.id)}
      onKeyDown={handleCardKeyDown}
      className="rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 hover:shadow-md transition-shadow cursor-pointer relative group hover-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:focus-visible:ring-emerald-400"
    >
```

Sostituisci il blocco alle righe 78-88. `[@media(hover:none)]:opacity-100` è una variante arbitraria supportata da Tailwind 3.4.18 (la versione installata): su dispositivi senza hover il menu è sempre visibile, quindi share e delete tornano raggiungibili su touch. `focus-visible:opacity-100` lo rende visibile anche quando ci arrivi con Tab.

```tsx
            <button
              onClick={handleMenuToggle}
              aria-label={t('kanban.a11y.boardCardMenu', { title: board.title })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={clsx(
                'p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity',
                board.coverImage
                  ? 'text-white hover:text-white bg-black/30 hover:bg-black/50'
                  : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300',
              )}
            >
              <MoreVertical size={16} />
            </button>
```

- [ ] **Step 9 — Eseguire il test e vederlo passare**

Run: `cd frontend && npx vitest run src/features/kanban/components/__tests__/kanbanA11y.test.tsx`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 5 passed (5)`.

- [ ] **Step 10 — `KanbanBoardPage.tsx`: label sui 3 pulsanti nudi + i 2 touch-trap**

Cerca `onClick={toggleSidebar}` (riga 438) e sostituisci il blocco 437-442:

```tsx
                <button
                  onClick={toggleSidebar}
                  aria-label={t('common.menu')}
                  className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
                >
                  <Menu size={20} />
                </button>
```

Cerca `onClick={() => navigate('/kanban')}` (riga 445) e sostituisci il blocco 444-449:

```tsx
              <button
                onClick={() => navigate('/kanban')}
                aria-label={t('kanban.a11y.backToBoards')}
                className="flex-shrink-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
```

Cerca `onClick={() => modals.setShowBoardMenu(!modals.showBoardMenu)}` (riga 611) e sostituisci le righe 610-613 (dal `<button` al `>`):

```tsx
                <button
                  onClick={() => modals.setShowBoardMenu(!modals.showBoardMenu)}
                  aria-label={t('kanban.a11y.boardMenu')}
                  aria-haspopup="menu"
                  aria-expanded={modals.showBoardMenu}
                  className="p-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors relative"
                >
```

Touch-trap dei controlli cover, riga 409. Sostituisci quella singola riga:

```tsx
              <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/cover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
```

Touch-trap della rimozione avatar, riga 469. Sostituisci quella singola riga:

```tsx
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center text-[8px] opacity-0 group-hover/avatar:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
```

- [ ] **Step 11 — I restanti 8 pulsanti icona nudi**

`frontend/src/features/kanban/KanbanPage.tsx`, righe 76-81:

```tsx
              <button
                onClick={toggleSidebar}
                aria-label={t('common.menu')}
                className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <Menu size={24} />
              </button>
```

`frontend/src/features/kanban/components/CardDetailModal.tsx`, righe 549-554:

```tsx
                        <button
                          onClick={() => removeComment.mutate(comment.id)}
                          aria-label={t('kanban.a11y.deleteComment')}
                          className="ml-auto text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <Trash2 size={13} />
                        </button>
```

`frontend/src/features/kanban/components/KanbanFilterBar.tsx`, righe 181-183 (variante mobile — è una sola riga di apertura `<button>`, sostituisci l'intero blocco di 3 righe):

```tsx
              <button onClick={() => updateFilter('search', '')} aria-label={t('kanban.a11y.clearSearch')} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
                <X size={12} />
              </button>
```

`frontend/src/features/kanban/components/KanbanFilterBar.tsx`, righe 370-375 (variante desktop):

```tsx
            <button
              onClick={() => updateFilter('search', '')}
              aria-label={t('kanban.a11y.clearSearch')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <X size={12} />
            </button>
```

`frontend/src/features/kanban/components/NoteLinkPicker.tsx`, righe 61-66:

```tsx
            <button
              onClick={() => setSearchQuery('')}
              aria-label={t('kanban.a11y.clearSearch')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <X size={14} />
            </button>
```

`frontend/src/features/kanban/components/TaskListLinkPicker.tsx`, righe 61-66 (blocco identico al precedente, va scritto anche qui):

```tsx
            <button
              onClick={() => setSearchQuery('')}
              aria-label={t('kanban.a11y.clearSearch')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <X size={14} />
            </button>
```

`frontend/src/features/kanban/components/BoardChatSidebar.tsx`, righe 173-179:

```tsx
          <button
            onClick={handleSend}
            disabled={!newMessage.trim() || sendMessage.isPending}
            aria-label={t('common.send')}
            className="p-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} />
          </button>
```

`frontend/src/features/kanban/components/BoardChatSidebar.tsx`, righe 214-219 (il close **desktop**; quello mobile a riga 190-196 ha già `aria-label={t('common.back')}` — non toccarlo):

```tsx
        <button
          onClick={onClose}
          aria-label={t('kanban.a11y.closeChat')}
          className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 rounded"
        >
          <X size={16} />
        </button>
```

- [ ] **Step 12 — `CardContextMenu.tsx`: sottomenu raggiungibili da tastiera (righe 236-273)**

Oggi i tre trigger sono `<div>` con solo `onMouseEnter`: non ricevono focus e non hanno modo di aprirsi. Diventano `<button>` che aprono il sottomenu anche su focus, Enter, Space e freccia destra. `activeSubmenu` (riga 63), `handleSubmenuEnter` (righe 113-119) e `handleSubmenuLeave` (righe 121-125) esistono già; `useCallback` è già importato a riga 1.

Aggiungi questo helper subito **dopo** `handleSubmenuLeave` (che finisce a riga 125 con `}, []);`):

```tsx
  const handleSubmenuKeyDown = useCallback((key: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault();
      handleSubmenuEnter(key);
    }
  }, [handleSubmenuEnter]);
```

Sostituisci l'intero blocco righe 236-273 (dal commento `{/* Move to */}` alla chiusura del terzo `</div>`, esclusa la riga 275 `{/* Due date */}`):

```tsx
        {/* Move to */}
        <button
          type="button"
          className={`${itemClass} justify-between`}
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === 'move'}
          onMouseEnter={() => handleSubmenuEnter('move')}
          onMouseLeave={handleSubmenuLeave}
          onFocus={() => handleSubmenuEnter('move')}
          onKeyDown={handleSubmenuKeyDown('move')}
        >
          <span className="flex items-center gap-2">
            <ArrowRight className="h-4 w-4" />
            {t('kanban.card.contextMenu.moveTo')}
          </span>
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        </button>

        {/* Assign to */}
        <button
          type="button"
          className={`${itemClass} justify-between`}
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === 'assign'}
          onMouseEnter={() => handleSubmenuEnter('assign')}
          onMouseLeave={handleSubmenuLeave}
          onFocus={() => handleSubmenuEnter('assign')}
          onKeyDown={handleSubmenuKeyDown('assign')}
        >
          <span className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            {t('kanban.card.contextMenu.assignTo')}
          </span>
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        </button>

        {/* Priority */}
        <button
          type="button"
          className={`${itemClass} justify-between`}
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === 'priority'}
          onMouseEnter={() => handleSubmenuEnter('priority')}
          onMouseLeave={handleSubmenuLeave}
          onFocus={() => handleSubmenuEnter('priority')}
          onKeyDown={handleSubmenuKeyDown('priority')}
        >
          <span className="flex items-center gap-2">
            <Flag className="h-4 w-4" />
            {t('kanban.card.contextMenu.priority')}
          </span>
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        </button>
```

- [ ] **Step 13 — Verifica: contare esattamente le label aggiunte**

Non è un unit test perché copre 11 file diversi. È un conteggio esatto: 11 label `kanban.a11y.*`, 2 riusi di `common.menu`, 1 riuso di `common.send`. Non usare euristiche che "cercano i bottoni senza nome": il kanban ha decine di `<button>` con testo visibile da variabile (`{col.title}`, `{note.title}`, `{board.note.title}`), e qualsiasi euristica del genere li segnala come falsi positivi.

Run:
```bash
cd frontend && echo "a11y: $(grep -ro "aria-label={t('kanban.a11y\." src/features/kanban/ | wc -l)" && echo "menu: $(grep -ro "aria-label={t('common.menu')}" src/features/kanban/ | wc -l)" && echo "send: $(grep -ro "aria-label={t('common.send')}" src/features/kanban/ | wc -l)"
```
Atteso, esattamente:
```
a11y: 11
menu: 2
send: 1
```

Run: `cd frontend && grep -rc "role=\"button\"" src/features/kanban/components/KanbanCard.tsx src/features/kanban/components/BoardCard.tsx`
Atteso:
```
src/features/kanban/components/KanbanCard.tsx:1
src/features/kanban/components/BoardCard.tsx:1
```

Run: `cd frontend && grep -c "onFocus={() => handleSubmenuEnter(" src/features/kanban/components/CardContextMenu.tsx`
Atteso: `3`

- [ ] **Step 14 — Verifica manuale del touch-trap e della tastiera**

1. `cd frontend && npm run dev`, apri `http://localhost:5173/kanban`.
2. DevTools → Device toolbar (emulazione mobile, che imposta `hover: none`): il pulsante `⋮` su ogni BoardCard deve essere **visibile senza hover**, e Share/Delete raggiungibili.
3. Torna a desktop, apri una board con cover: Tab fino ai controlli cover → devono comparire (`focus-within`).
4. Su una card: Tab fino al corpo card → premi Enter → si apre il CardDetailModal.
5. Tasto destro su una card → Tab fino a "Move to" → il sottomenu si apre al focus; freccia destra lo riapre.
6. Ripeti il punto 4 in dark mode (toggle tema): il ring `dark:focus-visible:ring-emerald-400` deve essere visibile.

- [ ] **Step 15 — Lint e typecheck**

Run: `cd frontend && npm run lint`
Atteso: `✖ 52 problems (0 errors, 52 warnings)`, exit code 0 (baseline invariata: nessun nuovo warning).

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Atteso: nessun output, exit code 0.

- [ ] **Step 16 — Suite frontend completa**

Run: `cd frontend && npm test`
Atteso: **PASS**, `Test Files` tutti passed, nessun file fallito. In particolare `CardContextMenu.test.tsx` resta verde: quel test seleziona per testo (`screen.getByText('kanban.card.contextMenu.delete')`) e copre il flusso di delete, che i `<div>` diventati `<button>` non toccano.

- [ ] **Step 17 — Commit**

```bash
git add frontend/src/features/kanban frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "fix(kanban): label icon-only buttons, make cards and submenus keyboard-operable"
```

---

### Task 6.2: Spiegare perché il board diventa read-only con i filtri attivi, e persistere i filtri

**Perché:** Basta digitare **un carattere** nella ricerca perché `readOnly={readOnly || filtersActive}` (`KanbanBoardPage.tsx:878` e `:920`) renda tutta la board di sola lettura: spariscono drag handle, menu colonna, pulsante "Add card". Nessun messaggio spiega il perché, e chi non ha capito il nesso pensa di aver perso i permessi. In più i filtri vivono in un `useState` locale, quindi si azzerano a ogni rimontaggio del componente (cambio pagina e ritorno) e vanno riapplicati ogni volta.
**Severità:** medium · **Effort:** M · **Rischio:** none — `uiStore.ts` non è TIER 1/2. È persistito su `localStorage` con chiave `ui-storage`: si **aggiunge** una chiave a `partialize`, non si modificano quelle esistenti, e lo store non definisce nessuna `version`/`migrate`, quindi lo stato persistito esistente fa merge senza migrazione (le installazioni vecchie partono con `kanbanFilters` dal default `{}`).

> **Interazione con la quick win `<KanbanBoardPage key={boardId} …>` (`KanbanPage.tsx:36`).** Quella fix serve a impedire che aprendo la board B da una notifica ci si porti dietro il filtro di A. Con la persistenza per-board introdotta qui il problema sparisce comunque, perché il filtro è indicizzato per `boardId`: aprire B mostra il filtro **di B**, non quello di A. Le due modifiche non confliggono; se la quick win è già stata fatta, non serve rifarla né toglierla.

**File:**
- Modifica: `frontend/src/store/uiStore.ts:1-2` (import), `:7-31` (interfaccia `UIState`), `:75` (stato, dopo `collapseAll`), `:79-86` (`partialize`)
- Modifica: `frontend/src/features/kanban/KanbanBoardPage.tsx:10` (import lucide), `:57` (store), `:118` (stato filtri), `:800-805` (banner sotto la filter bar)
- Modifica: `frontend/src/locales/en.json` (dentro `kanban.filters`, dopo `"clearAll"` a riga 989), `frontend/src/locales/it.json` (idem, riga 1244)
- Crea: `frontend/src/store/__tests__/uiStore.test.ts` (la cartella `src/store/__tests__/` non esiste ancora, va creata)

**Interfacce:**
- Consuma: `KanbanFilters` e `defaultKanbanFilters` da `frontend/src/features/kanban/components/KanbanFilterBar.tsx` (già esportati: interfaccia righe 12-18, costante righe 21-27); `onFiltersChange: (filters: KanbanFilters) => void` (props di `KanbanFilterBar`, riga 95)
- Produce: `useUIStore().kanbanFilters: Record<string, KanbanFilters>` e `useUIStore().setKanbanFilters(boardId: string, filters: KanbanFilters): void`

---

- [ ] **Step 1 — Scrivere il test che fallisce**

Crea `frontend/src/store/__tests__/uiStore.test.ts`.

**Attenzione, questo è il punto in cui il test non parte se lo scrivi ingenuamente:** `uiStore.ts` esegue `applyThemeClass(useUIStore.getState().theme)` a riga 92, al momento dell'import, e con `theme: 'system'` quella funzione chiama `window.matchMedia(...)`. jsdom **non implementa `matchMedia`** e `frontend/src/__tests__/setup.ts` non lo stubba (contiene solo un mock di `localStorage`). Senza lo stub il file fallisce con `TypeError: window.matchMedia is not a function` **prima ancora di collezionare i test**. `vi.hoisted` viene eseguito prima degli import, quindi è il posto giusto per lo stub.

`KanbanFilters` è importato con `import type` (erasato da `verbatimModuleSyntax`): il modulo `KanbanFilterBar.tsx` non viene caricato a runtime. Il filtro di default è ricostruito inline per la stessa ragione.

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// uiStore calls window.matchMedia at import time (applyThemeClass with theme 'system').
// jsdom does not implement it, so it must exist BEFORE the import below — vi.hoisted runs first.
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

import { useUIStore } from '../uiStore';
import type { KanbanFilters } from '../../features/kanban/components/KanbanFilterBar';

// Mirrors defaultKanbanFilters (KanbanFilterBar.tsx:21-27), inlined so the store test
// does not pull a React component (and lucide + date-fns) into its module graph.
const base: KanbanFilters = {
  search: '',
  assigneeIds: [],
  dueDate: 'all',
  hasNote: 'all',
  hasComments: 'all',
};

describe('uiStore — kanban filter persistence', () => {
  beforeEach(() => {
    useUIStore.setState({ kanbanFilters: {} });
  });

  it('starts with no stored filters', () => {
    expect(useUIStore.getState().kanbanFilters).toEqual({});
  });

  it('stores filters per board id', () => {
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'invoice' });
    useUIStore.getState().setKanbanFilters('board-2', { ...base, dueDate: 'overdue' });

    const stored = useUIStore.getState().kanbanFilters;
    expect(stored['board-1'].search).toBe('invoice');
    expect(stored['board-2'].dueDate).toBe('overdue');
    expect(stored['board-1'].dueDate).toBe('all');
  });

  it('overwrites the entry for the same board instead of appending', () => {
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'a' });
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'b' });

    expect(Object.keys(useUIStore.getState().kanbanFilters)).toHaveLength(1);
    expect(useUIStore.getState().kanbanFilters['board-1'].search).toBe('b');
  });

  it('drops the whole map once it exceeds 20 boards, keeping only the newest entry', () => {
    for (let i = 0; i < 20; i++) {
      useUIStore.getState().setKanbanFilters(`board-${i}`, { ...base, search: String(i) });
    }
    expect(Object.keys(useUIStore.getState().kanbanFilters)).toHaveLength(20);

    useUIStore.getState().setKanbanFilters('board-20', { ...base, search: '20' });

    const stored = useUIStore.getState().kanbanFilters;
    expect(Object.keys(stored)).toEqual(['board-20']);
    expect(stored['board-20'].search).toBe('20');
  });

  it('persists kanbanFilters into localStorage under ui-storage', () => {
    useUIStore.getState().setKanbanFilters('board-1', { ...base, search: 'persisted' });

    const raw = localStorage.getItem('ui-storage');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.kanbanFilters['board-1'].search).toBe('persisted');
  });
});
```

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd frontend && npx vitest run src/store/__tests__/uiStore.test.ts`
Atteso: **FAIL**, `Tests 5 failed (5)`. Il primo errore è `AssertionError: expected undefined to deeply equal {}` (il campo `kanbanFilters` non esiste ancora); i quattro successivi sono `TypeError: useUIStore.getState().setKanbanFilters is not a function`.

- [ ] **Step 3 — Aggiungere lo stato allo `uiStore`**

In `frontend/src/store/uiStore.ts`, aggiungi l'import di tipo subito dopo `import { persist } from 'zustand/middleware';` (riga 2). Deve essere `import type`: `verbatimModuleSyntax` lo erasa, quindi non nasce nessun ciclo store→feature a runtime.

```ts
import type { KanbanFilters } from '../features/kanban/components/KanbanFilterBar';
```

Dentro `interface UIState` (righe 7-31), aggiungi subito prima della graffa di chiusura, cioè dopo `closeNotificationPanel: () => void;` (riga 30):

```ts
  kanbanFilters: Record<string, KanbanFilters>;
  setKanbanFilters: (boardId: string, filters: KanbanFilters) => void;
```

Nella sezione "Persisted state", subito dopo `collapseAll: () => set({ isSidebarCollapsed: true, isListCollapsed: true }),` (riga 75), aggiungi:

```ts
      kanbanFilters: {},
      setKanbanFilters: (boardId, filters) =>
        set((state) => {
          // ponytail: hard reset past 20 boards instead of LRU bookkeeping — swap for a
          // real LRU only if users complain about losing filters on boards 21+.
          const base = Object.keys(state.kanbanFilters).length >= 20 ? {} : state.kanbanFilters;
          return { kanbanFilters: { ...base, [boardId]: filters } };
        }),
```

In `partialize` (righe 79-86), aggiungi come ultima voce dopo `isSidebarCollapsed: state.isSidebarCollapsed,`:

```ts
        kanbanFilters: state.kanbanFilters,
```

- [ ] **Step 4 — Eseguire il test e vederlo passare**

Run: `cd frontend && npx vitest run src/store/__tests__/uiStore.test.ts`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 5 passed (5)`.

- [ ] **Step 5 — Collegare `KanbanBoardPage` allo store**

In `frontend/src/features/kanban/KanbanBoardPage.tsx`, riga 57, sostituisci:

```tsx
  const { toggleSidebar } = useUIStore();
```

con:

```tsx
  const { toggleSidebar, kanbanFilters, setKanbanFilters } = useUIStore();
```

(La chiamata senza selettore era già sottoscritta all'intero store, quindi non cambia il profilo di re-render.)

Riga 118, sostituisci:

```tsx
  const [filters, setFilters] = useState<KanbanFilters>(defaultKanbanFilters);
```

con:

```tsx
  const filters = kanbanFilters[boardId] ?? defaultKanbanFilters;
  const setFilters = useCallback(
    (next: KanbanFilters) => setKanbanFilters(boardId, next),
    [boardId, setKanbanFilters],
  );
```

`useCallback` è già importato a riga 1. `setFilters` è usato in un solo punto, `onFiltersChange={setFilters}` a riga 802: la firma richiesta è `(filters: KanbanFilters) => void` (`KanbanFilterBar.tsx:95`) e combacia. `defaultKanbanFilters` è una costante di modulo, quindi l'identità di `filters` resta stabile fra render e il `useMemo` di riga 172-178 (che dipende da `filters`) non si invalida a vuoto.

- [ ] **Step 6 — Aggiungere le chiavi i18n del banner**

In `frontend/src/locales/en.json`, dentro `kanban.filters`, l'ultima chiave è `"clearAll": "Clear"` a riga 989. Aggiungi una virgola alla fine di quella riga e inserisci sotto:

```json
      "readOnlyTitle": "Board is read-only while filters are on",
      "readOnlyBody": "Cards are hidden by the current filters, so dragging and editing are disabled to avoid moving a card you can't see. Clear the filters to edit again."
```

In `frontend/src/locales/it.json`, dentro `kanban.filters`, l'ultima chiave è `"clearAll": "Pulisci"` a riga 1244. Aggiungi la virgola e inserisci sotto:

```json
      "readOnlyTitle": "Bacheca in sola lettura mentre i filtri sono attivi",
      "readOnlyBody": "I filtri nascondono parte delle card, quindi trascinamento e modifica sono disattivati per non spostare una card che non vedi. Rimuovi i filtri per tornare a modificare."
```

- [ ] **Step 7 — Verificare che i due locale abbiano le stesse chiavi**

Run: `cd frontend && node -e "const en=require('./src/locales/en.json'),it=require('./src/locales/it.json');const a=Object.keys(en.kanban.filters).sort(),b=Object.keys(it.kanban.filters).sort();console.log(JSON.stringify(a)===JSON.stringify(b)?'KEYS MATCH: '+a.length:'MISMATCH '+JSON.stringify(a)+' vs '+JSON.stringify(b))"`
Atteso: `KEYS MATCH: 20` (18 chiavi preesistenti + le 2 nuove)

- [ ] **Step 8 — Aggiungere il banner esplicativo**

In `frontend/src/features/kanban/KanbanBoardPage.tsx`, cerca il blocco `<KanbanFilterBar` (righe 800-805) e sostituiscilo con:

```tsx
        <KanbanFilterBar
          filters={filters}
          onFiltersChange={setFilters}
          assignees={allAssignees}
          onExport={handleExportGantt}
        />

        {/* Filters make the whole board read-only (see readOnly={readOnly || filtersActive}
            passed to KanbanColumn below, lines 878 and 920) — say so instead of silently
            removing every write affordance. */}
        {filtersActive && !readOnly && (
          <div className="flex-shrink-0 flex items-start gap-2 px-4 py-2 border-b border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/20">
            <Filter size={14} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                {t('kanban.filters.readOnlyTitle')}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400/80">
                {t('kanban.filters.readOnlyBody')}
              </p>
            </div>
            <button
              onClick={() => setFilters(defaultKanbanFilters)}
              className="flex-shrink-0 px-2 py-1 rounded-md text-xs font-medium text-amber-800 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
            >
              {t('kanban.filters.clearAll')}
            </button>
          </div>
        )}
```

`Filter` non è ancora importato. Sostituisci la riga 10:

```tsx
import { Archive, ArrowLeft, ListChecks, Plus, Share2, Trash2, MoreVertical, Menu, MessageSquare, ImagePlus, X, FileText, Link2, Unlink, Filter } from 'lucide-react';
```

- [ ] **Step 9 — Lint e typecheck**

Run: `cd frontend && npm run lint`
Atteso: `✖ 52 problems (0 errors, 52 warnings)`, exit code 0.

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Atteso: nessun output, exit code 0. In particolare `useState` non deve risultare unused (`noUnusedLocals: true` è attivo): dopo la rimozione della riga 118 resta usato alle righe 76, 109, 110, 111, 112, 113, 116, 119, 120, 140, 141, 144, 145.

- [ ] **Step 10 — Verifica manuale del banner (non copribile da unit test: richiede l'intera pagina con router + react-query + Dexie)**

1. `cd frontend && npm run dev`, apri una board kanban.
2. Digita un carattere nella ricerca → compare il banner ambra con titolo, spiegazione e pulsante "Clear"; le colonne perdono le affordance di scrittura.
3. Clicca "Clear" → banner sparisce, drag/edit tornano.
4. Riapplica un filtro, naviga su `/notes`, torna sulla board → **il filtro è ancora applicato** e il banner è ancora lì (questa è la persistenza).
5. Ricarica la pagina (F5) → il filtro sopravvive.
6. Apri una **seconda** board → deve avere il proprio filtro (nessuno, se non ne hai mai impostato uno lì), non quello della prima.
7. Attiva dark mode → banner leggibile (`dark:bg-amber-900/20`, `dark:text-amber-300`).
8. Apri una board condivisa in sola lettura e applica un filtro → il banner **non** deve comparire (`!readOnly`).

Nella console del browser, dopo il punto 4:
Run: `JSON.parse(localStorage.getItem('ui-storage')).state.kanbanFilters`
Atteso: un oggetto con la chiave dell'id della board e dentro il filtro applicato.

- [ ] **Step 11 — Suite frontend completa**

Run: `cd frontend && npm test`
Atteso: **PASS**, nessun file di test fallito.

- [ ] **Step 12 — Commit**

```bash
git add frontend/src/store/uiStore.ts frontend/src/store/__tests__/uiStore.test.ts frontend/src/features/kanban/KanbanBoardPage.tsx frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(kanban): explain filter-induced read-only mode and persist filters per board"
```

---

### Task 6.3: Hardening cover/avatar — estensione dal mimetype validato e cleanup su delete board

**Perché:** Due problemi sullo stesso codice. (1) Il nome del file salvato prende l'estensione dal **filename del client** (`path.extname(data.filename || '.jpg')`, `routes/kanban.ts:210` e `:291`), non dal mimetype validato: un upload con `Content-Type: image/png` (che passa l'allowlist) e nome `x.svg` finisce salvato come `.svg` e servito da `/uploads/kanban/<uuid>.svg` — URL same-origin, senza autenticazione — come documento attivo. (2) Cancellando una board, `deleteBoard` (`services/kanban/board.service.ts:271-273`) fa solo il `delete` della riga: cover e avatar restano su disco, pubblicamente leggibili per sempre, e il job di pulizia esistente (`backend/src/scripts/pruneAttachments.ts`) conosce solo `prisma.attachment` — quei file non li tocca nessuno.
**Severità:** high · **Effort:** M · **Rischio:** none — nessun file TIER 1/2. `board.service.ts` e `routes/kanban.ts` sono coperti da test esistenti che restano verdi.

**File:**
- Crea: `backend/src/utils/uploadPaths.ts`
- Crea: `backend/src/utils/__tests__/uploadPaths.test.ts` (la cartella esiste già: contiene `contentGuard.test.ts`, `extractText.test.ts`, `ydocIntegrity.test.ts`)
- Modifica: `backend/src/routes/kanban.ts:1-10` (import), `:74-81` (costanti), `:176-178`, `:202-207`, `:209-211`, `:232-237`, `:257-259`, `:283-288`, `:290-292`, `:313-318`
- Modifica: `backend/src/services/kanban/board.service.ts:5` (import), `:271-273` (`deleteBoard`)
- Modifica: `backend/src/services/kanban/__tests__/board.service.test.ts:2` (import), `:13-15` (mock fs), `:354-377` (`describe('deleteBoard')`)

**Interfacce:**
- Consuma: nessuna
- Produce: `backend/src/utils/uploadPaths.ts` esporta `UPLOADS_DIR: string`, `IMAGE_MIME_EXTENSIONS: Record<string, string>`, `extensionForImageMime(mimetype: string): string | null`, `resolveUploadPath(url: string | null | undefined): string | null`

---

- [ ] **Step 1 — Scrivere il test che fallisce**

Crea `backend/src/utils/__tests__/uploadPaths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'path';
import { UPLOADS_DIR, extensionForImageMime, resolveUploadPath } from '../uploadPaths';

describe('extensionForImageMime', () => {
  it('maps every allowed image mimetype to a canonical extension', () => {
    expect(extensionForImageMime('image/jpeg')).toBe('.jpg');
    expect(extensionForImageMime('image/png')).toBe('.png');
    expect(extensionForImageMime('image/gif')).toBe('.gif');
    expect(extensionForImageMime('image/webp')).toBe('.webp');
  });

  it('rejects mimetypes that are not on the allowlist', () => {
    expect(extensionForImageMime('image/svg+xml')).toBeNull();
    expect(extensionForImageMime('text/html')).toBeNull();
    expect(extensionForImageMime('application/octet-stream')).toBeNull();
    expect(extensionForImageMime('')).toBeNull();
  });

  it('never derives the extension from a client filename', () => {
    // The regression: `path.extname('payload.svg')` produced '.svg' even though the
    // declared (and validated) mimetype was image/png.
    expect(extensionForImageMime('image/png')).not.toBe('.svg');
  });
});

describe('resolveUploadPath', () => {
  it('resolves a stored public url to an absolute path under UPLOADS_DIR', () => {
    expect(resolveUploadPath('/uploads/kanban/abc.png')).toBe(path.join(UPLOADS_DIR, 'kanban', 'abc.png'));
  });

  it('resolves nested avatar urls', () => {
    expect(resolveUploadPath('/uploads/kanban/avatars/abc.webp')).toBe(
      path.join(UPLOADS_DIR, 'kanban', 'avatars', 'abc.webp')
    );
  });

  it('returns null for null, empty and non-upload urls', () => {
    expect(resolveUploadPath(null)).toBeNull();
    expect(resolveUploadPath(undefined)).toBeNull();
    expect(resolveUploadPath('')).toBeNull();
    expect(resolveUploadPath('https://evil.example/uploads/x.png')).toBeNull();
    expect(resolveUploadPath('/etc/passwd')).toBeNull();
  });

  it('returns null for traversal attempts that escape UPLOADS_DIR', () => {
    expect(resolveUploadPath('/uploads/../../../etc/passwd')).toBeNull();
    expect(resolveUploadPath('/uploads/kanban/../../../secrets.env')).toBeNull();
  });
});
```

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/utils/__tests__/uploadPaths.test.ts`
Atteso: **FAIL**, `Failed Suites 1` / `Tests no tests`. L'errore è testualmente:
`Error: Cannot find module '../uploadPaths' imported from 'D:/Develop/AI/Notiq/backend/src/utils/__tests__/uploadPaths.test.ts'`

- [ ] **Step 3 — Creare il modulo**

Crea `backend/src/utils/uploadPaths.ts`. Il backend è CommonJS (`backend/package.json` non ha `"type"`), quindi `__dirname` è disponibile anche sotto vitest (verificato: `routes/kanban.ts:76` lo usa già e i suoi test passano). Da `src/utils` (e da `dist/utils` dopo il build) `../../uploads` punta a `backend/uploads`, esattamente come fa oggi `routes/kanban.ts:76` da `src/routes`.

```ts
import path from 'path';

export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

/**
 * The ONLY image mimetypes an upload route may accept, each mapped to the extension
 * the file is stored with. Deriving the extension from the *validated mimetype* — never
 * from the client-supplied filename — is what stops a caller from parking a `.svg`
 * (an active document) on an unauthenticated same-origin /uploads URL.
 */
export const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function extensionForImageMime(mimetype: string): string | null {
  return IMAGE_MIME_EXTENSIONS[mimetype] ?? null;
}

/**
 * Map a stored public URL (`/uploads/...`) to an absolute path inside UPLOADS_DIR.
 * Returns null for anything that is not an uploads URL or that escapes the directory.
 */
export function resolveUploadPath(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/uploads/')) return null;
  const abs = path.resolve(UPLOADS_DIR, url.slice('/uploads/'.length));
  if (abs !== UPLOADS_DIR && !abs.startsWith(UPLOADS_DIR + path.sep)) return null;
  return abs;
}
```

- [ ] **Step 4 — Eseguire il test e vederlo passare**

Run: `cd backend && npx vitest run src/utils/__tests__/uploadPaths.test.ts`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 7 passed (7)`.

- [ ] **Step 5 — Usare il modulo nelle route di upload**

In `backend/src/routes/kanban.ts`, aggiungi l'import subito dopo la riga 10 (`import prisma from '../plugins/prisma';`):

```ts
import { UPLOADS_DIR, extensionForImageMime } from '../utils/uploadPaths';
```

Sostituisci il blocco costanti, righe 74-81 (dal commento `// ─── Upload helpers ───` fino a `MAX_AVATAR_SIZE`). `UPLOADS_DIR` e `ALLOWED_IMAGE_TYPES` locali spariscono; `UPLOADS_DIR` arriva ora dall'import:

```ts
// ─── Upload helpers ─────────────────────────────────────────

const KANBAN_UPLOADS_DIR = path.join(UPLOADS_DIR, 'kanban');
const KANBAN_AVATARS_DIR = path.join(UPLOADS_DIR, 'kanban', 'avatars');
const MAX_COVER_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB
```

Cover, sostituisci le righe 176-178 (il check `ALLOWED_IMAGE_TYPES.has`):

```ts
    const ext = extensionForImageMime(data.mimetype);
    if (!ext) {
      return reply.status(400).send({ message: 'errors.common.onlyImageFormatsAllowed' });
    }
```

Cover, sostituisci le righe 209-211 (il commento `// Save new file` e le due righe successive):

```ts
    // Save new file — extension comes from the validated mimetype, never from data.filename
    const filename = `${randomUUID()}${ext}`;
```

Avatar, sostituisci le righe 257-259 (il check `ALLOWED_IMAGE_TYPES.has`) con **lo stesso blocco** della cover:

```ts
    const ext = extensionForImageMime(data.mimetype);
    if (!ext) {
      return reply.status(400).send({ message: 'errors.common.onlyImageFormatsAllowed' });
    }
```

Avatar, sostituisci le righe 290-292:

```ts
    // Save new file — extension comes from the validated mimetype, never from data.filename
    const filename = `${randomUUID()}${ext}`;
```

La chiave i18n `errors.common.onlyImageFormatsAllowed` esiste già in `en.json` ("Only JPEG, PNG, GIF, WebP images are allowed") e in `it.json` ("Sono ammessi solo JPEG, PNG, GIF, WebP"): non va aggiunta.

- [ ] **Step 6 — Far passare anche le 4 cancellazioni del vecchio file dallo stesso helper**

`routes/kanban.ts` ricostruisce il path del file da sostituire in 4 punti con lo stesso `path.join(UPLOADS_DIR, url.replace(/^\/uploads\//, ''))`: è esattamente la logica che ora vive in `resolveUploadPath`, e la copia inline non ha il controllo di uscita dalla directory. Sostituiscili tutti e quattro.

Cover POST, righe 202-207:

```ts
    const oldFile = resolveUploadPath(currentBoard?.coverImage);
    if (oldFile && fs.existsSync(oldFile)) {
      fs.unlinkSync(oldFile);
    }
```

Cover DELETE, righe 232-237:

```ts
    const oldFile = resolveUploadPath(board?.coverImage);
    if (oldFile && fs.existsSync(oldFile)) {
      fs.unlinkSync(oldFile);
    }
```

Avatar POST, righe 283-288:

```ts
    const oldFile = resolveUploadPath(currentBoard?.avatarUrl);
    if (oldFile && fs.existsSync(oldFile)) {
      fs.unlinkSync(oldFile);
    }
```

Avatar DELETE, righe 313-318:

```ts
    const oldFile = resolveUploadPath(board?.avatarUrl);
    if (oldFile && fs.existsSync(oldFile)) {
      fs.unlinkSync(oldFile);
    }
```

Aggiorna l'import di riga 11 aggiungendo `resolveUploadPath`:

```ts
import { UPLOADS_DIR, extensionForImageMime, resolveUploadPath } from '../utils/uploadPaths';
```

`UPLOADS_DIR` resta necessario (lo usano `KANBAN_UPLOADS_DIR` e `KANBAN_AVATARS_DIR`), e `path` resta usato (righe 77, 78, 212, 293).

- [ ] **Step 7 — Verifica: nessun residuo del vecchio pattern**

Run: `cd backend && grep -n "path.extname\|ALLOWED_IMAGE_TYPES\|replace(/\^\\\\/uploads" src/routes/kanban.ts; echo "grep-exit=$?"`
Atteso: nessuna riga stampata e `grep-exit=1` (grep non trova nulla).

- [ ] **Step 8 — Aggiungere il test che fallisce per il cleanup su delete**

In `backend/src/services/kanban/__tests__/board.service.test.ts`, aggiungi il mock di `fs` subito **dopo** `vi.mock('../card.service', ...)` (che finisce a riga 15). Usa la forma con `importOriginal` (la stessa di `src/routes/__tests__/attachments.route.test.ts:27`): sostituire l'intero modulo `fs` con un oggetto di due funzioni romperebbe qualunque altra `fs.*` finisse nel grafo del test.

```ts
// Mock only the two fs calls deleteBoard makes; everything else stays real.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(), unlinkSync: vi.fn() },
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});
```

Aggiungi gli import subito dopo `import prisma from '../../../plugins/prisma'; // Auto-mocked by setup.ts` (riga 2):

```ts
import fs from 'fs';
import path from 'path';
import { UPLOADS_DIR } from '../../../utils/uploadPaths';
```

Poi, dentro `describe('deleteBoard', ...)` (che inizia a riga 354), aggiungi questi due casi **dopo** il test `'propagates Prisma error when board not found'` e prima della chiusura del describe (riga 377). `m` è lo shorthand di `vi.mocked` già definito a riga 40; `vi.clearAllMocks()` nel `beforeEach` (riga 48) azzera le chiamate ma non le implementazioni, per cui `existsSync` va riprogrammato in ogni test:

```ts
    it('unlinks the cover and avatar files from disk after deleting the row', async () => {
      const board = makeKanbanBoard({
        coverImage: '/uploads/kanban/cover-1.png',
        avatarUrl: '/uploads/kanban/avatars/avatar-1.webp',
      });

      m(fs.existsSync).mockReturnValue(true);
      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        coverImage: board.coverImage,
        avatarUrl: board.avatarUrl,
      } as never);
      m(prisma.kanbanBoard.delete).mockResolvedValue(board);

      await deleteBoard(board.id);

      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(UPLOADS_DIR, 'kanban', 'cover-1.png'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        path.join(UPLOADS_DIR, 'kanban', 'avatars', 'avatar-1.webp')
      );
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    });

    it('does not touch the disk when the board has no cover and no avatar', async () => {
      const board = makeKanbanBoard();

      m(fs.existsSync).mockReturnValue(true);
      m(prisma.kanbanBoard.findUnique).mockResolvedValue({
        coverImage: null,
        avatarUrl: null,
      } as never);
      m(prisma.kanbanBoard.delete).mockResolvedValue(board);

      await deleteBoard(board.id);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
```

`makeKanbanBoard` (`backend/src/__tests__/factories.ts:137`) accetta già `coverImage` e `avatarUrl` fra gli override (default `null` entrambi).

- [ ] **Step 9 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts -t "unlinks the cover and avatar files"`
Atteso: **FAIL** — `AssertionError: expected "unlinkSync" to be called with arguments: [ …'cover-1.png' ]` seguito da `Number of calls: 0`.

- [ ] **Step 10 — Implementare il cleanup**

In `backend/src/services/kanban/board.service.ts`, aggiungi agli import subito dopo la riga 5 (`import { archiveCompletedCards } from './card.service';`):

```ts
import fs from 'fs';
import { resolveUploadPath } from '../../utils/uploadPaths';
```

`logger` è già importato a riga 2 e già usato a riga 161.

Sostituisci le righe 271-273:

```ts
export async function deleteBoard(boardId: string) {
  // [BACKUP] 2026-08-31 — was a bare `return prisma.kanbanBoard.delete({ where: { id: boardId } });`.
  // That left the cover/avatar files on disk forever: they live under uploads/kanban/,
  // are served without authentication, and pruneAttachments.ts only knows about the
  // Attachment table, so nothing else ever reaped them.
  const board = await prisma.kanbanBoard.findUnique({
    where: { id: boardId },
    select: { coverImage: true, avatarUrl: true },
  });

  const deleted = await prisma.kanbanBoard.delete({ where: { id: boardId } });

  for (const url of [board?.coverImage, board?.avatarUrl]) {
    const filepath = resolveUploadPath(url);
    if (!filepath) continue;
    try {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (err) {
      // The row is already gone — a stuck file must not turn into a failed request.
      logger.warn({ err, boardId, filepath }, 'Failed to delete kanban board image file');
    }
  }

  return deleted;
}
```

- [ ] **Step 11 — Eseguire i test e vederli passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/board.service.test.ts`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 19 passed (19)` (17 preesistenti + 2 nuovi). I due test `deleteBoard` preesistenti restano verdi: `prisma.kanbanBoard.findUnique` non è stubbato lì, il mock ritorna `undefined`, quindi `board?.coverImage` è `undefined` e il loop non tocca il disco.

- [ ] **Step 12 — Lint, typecheck e suite backend**

Run: `cd backend && npm run lint`
Atteso: `✖ 63 problems (0 errors, 63 warnings)`, exit code 0.

Run: `cd backend && npx tsc --noEmit`
Atteso: nessun output, exit code 0. (`backend/tsconfig.json` ha `"exclude": ["src/**/__tests__/**"]`, quindi questo comando typecheck il codice applicativo ma **non** i file di test: la verifica dei test è l'esecuzione di vitest.)

Run: `cd backend && npm test`
Atteso: **PASS**, nessun file di test fallito.

- [ ] **Step 13 — Verifica manuale dell'estensione derivata**

Con backend in esecuzione (`cd backend && npm run dev`), il container `notiq-db` su, un `<JWT>` valido e un `<BOARD_ID>` di cui l'utente è owner. Da Git Bash (che ha `/tmp`):

```bash
printf '\x89PNG\r\n\x1a\n' > /tmp/payload.svg && \
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3001/api/kanban/boards/<BOARD_ID>/cover" \
  -H "Authorization: Bearer <JWT>" \
  -F "file=@/tmp/payload.svg;type=image/png"
```
Atteso: `200`

Run: `cd backend && ls -t uploads/kanban | head -1`
Atteso: un nome `<uuid>.png` — **mai** `.svg`.

Ripeti lo stesso curl cambiando `;type=image/png` in `;type=image/svg+xml`:
Atteso: `400`, e `ls -t uploads/kanban | head -1` restituisce ancora lo stesso `.png` di prima (nessun file nuovo).

Infine, cancella la board dalla UI e verifica che il file sparisca:
Run: `cd backend && ls uploads/kanban | wc -l`
Atteso: un file in meno rispetto a prima della cancellazione.

- [ ] **Step 14 — Commit**

```bash
git add backend/src/utils/uploadPaths.ts backend/src/utils/__tests__/uploadPaths.test.ts backend/src/routes/kanban.ts backend/src/services/kanban/board.service.ts backend/src/services/kanban/__tests__/board.service.test.ts
git commit -m "fix(kanban): derive upload extension from validated mimetype and delete board images on disk"
```

---

### Task 6.4: Query limitate — paginazione archivio, indice sui commenti, cap sui reminder

**Perché:** Tre query kanban crescono senza limite. `/kanban/boards/:id/archived` è l'unica rotta di lista kanban senza paginazione: su una board con anni di card archiviate la risposta è tutto l'archivio in un colpo. `KanbanComment` ha solo `@@index([cardId])` mentre la query ordina per `createdAt`, quindi Postgres ordina in memoria a ogni apertura di card. E `getUserKanbanReminders` non ha `take`: restituisce ogni reminder dell'utente su ogni board.

**Bonus non opzionale:** il payload dell'archivio è **già rotto oggi**. `getArchivedCards` (`card.service.ts:419-422`) destruttura via solo `_count`, quindi manda `column: { id, title }`; ma `ArchivedCard` (`frontend/.../types.ts:149-154`) dichiara `columnTitle: string` e `ArchivedCardsModal.tsx:55` renderizza `{card.columnTitle}` — cioè `undefined`, uno spazio vuoto sotto ogni titolo. La riscrittura di questo task lo appiattisce correttamente.

**Severità:** medium · **Effort:** M · **Rischio:** **TIER 1** — `backend/prisma/schema.prisma` va toccato per l'indice: una migration, un solo `@@index` aggiunto, nessuna colonna modificata. Commit separato dal resto (Step 21).

> ⛔ **AVVERTENZA DA NON IGNORARE.** Non aggiungere `isDone: false` al `where` di `getUserKanbanReminders` (`backend/src/services/kanbanReminder.service.ts:128-151`), per quanto "sembri" l'ottimizzazione ovvia. `frontend/src/features/reminders/RemindersPage.tsx:113` costruisce la sezione **Done** con `unified.filter((r) => r.isDone)` proprio da quelle righe e le renderizza barrate (`:164`). Filtrando i `isDone: true` lato server, i reminder spuntati sparirebbero dalla pagina e diventerebbero impossibili da de-spuntare. L'unico cambiamento ammesso qui è aggiungere `take`.

**File:**
- Modifica: `backend/prisma/schema.prisma:527-537` (modello `KanbanComment`, `@@index([cardId])` a riga 536)
- Crea: `backend/prisma/migrations/<timestamp>_add_kanban_comment_card_created_idx/migration.sql` (generata da Prisma)
- Modifica: `backend/src/services/kanban/card.service.ts:403-423` (`getArchivedCards`)
- Modifica: `backend/src/routes/kanban.ts:566-570` (rotta archived)
- Modifica: `backend/src/services/kanbanReminder.service.ts:149` (aggiunta `take`)
- Modifica: `backend/src/services/kanban/__tests__/card.service.test.ts` (nuovo `describe` in coda al file, che oggi finisce a riga 755)
- Modifica: `backend/src/services/__tests__/kanbanReminder.service.test.ts:249` (assert) e `:206-265` (describe `getUserKanbanReminders`)
- Modifica: `frontend/src/lib/queryKeys.ts:23`, `frontend/src/features/kanban/types.ts:149-154`, `frontend/src/features/kanban/kanbanService.ts:17` (import) e `:639-642`
- Modifica: `frontend/src/features/kanban/__tests__/kanbanService.test.ts:50` (import) + nuovo describe in coda (file di 149 righe)
- Riscrive: `frontend/src/features/kanban/components/ArchivedCardsModal.tsx` (85 righe)
- Modifica: `frontend/src/locales/en.json:1020`, `frontend/src/locales/it.json:1275` (dentro `kanban.archive`)

**Interfacce:**
- Consuma: `paginationSchema` già presente in `backend/src/routes/kanban.ts:69-72` (`page` default 1, `limit` default 50 con `.max(100)`, entrambi `z.coerce.number().int().positive()`)
- Produce: backend `getArchivedCards(boardId: string, page: number, limit: number): Promise<{ cards: Array<{ …card; columnTitle: string; commentCount: number }>; total: number; page: number; limit: number }>`; frontend `kanbanService.getArchivedCards(boardId: string, page?: number): Promise<ArchivedCardsPage>`; tipo `ArchivedCardsPage` in `frontend/src/features/kanban/types.ts`; query key `queryKeys.kanban.archivedCardsAll(boardId)`

---

- [ ] **Step 1 — Scrivere il test backend che fallisce (paginazione archivio)**

In `backend/src/services/kanban/__tests__/card.service.test.ts`, aggiungi in fondo al file (dopo il `describe('unarchiveCard')` che chiude a riga 755). `getArchivedCards` è già importato a riga 61; `prismaMock`, `makeKanbanBoard` e `makeKanbanColumn` sono già in scope (righe 78, 69, 70). `prismaMock.kanbanCard.count` esiste nel mock base di `src/__tests__/setup.ts:217`, quindi non serve nessuna augmentation.

```ts
// ═══════════════════════════════════════════════════════════════
//  getArchivedCards
// ═══════════════════════════════════════════════════════════════

describe('getArchivedCards', () => {
  const board = makeKanbanBoard();
  const column = makeKanbanColumn({ boardId: board.id });

  it('pages the query with skip/take and returns the total count', async () => {
    prismaMock.kanbanCard.findMany.mockResolvedValue([]);
    prismaMock.kanbanCard.count.mockResolvedValue(137);

    const result = await getArchivedCards(board.id, 3, 20);

    expect(prismaMock.kanbanCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { column: { boardId: board.id }, archivedAt: { not: null } },
        orderBy: { archivedAt: 'desc' },
        skip: 40,
        take: 20,
      })
    );
    expect(prismaMock.kanbanCard.count).toHaveBeenCalledWith({
      where: { column: { boardId: board.id }, archivedAt: { not: null } },
    });
    expect(result).toEqual({ cards: [], total: 137, page: 3, limit: 20 });
  });

  it('flattens column.title into columnTitle so the modal can render it', async () => {
    prismaMock.kanbanCard.findMany.mockResolvedValue([
      {
        id: 'card-1',
        title: 'Old card',
        archivedAt: new Date('2026-01-02T00:00:00Z'),
        _count: { comments: 2 },
        column: { id: column.id, title: 'Done' },
      },
    ]);
    prismaMock.kanbanCard.count.mockResolvedValue(1);

    const result = await getArchivedCards(board.id, 1, 50);

    expect(result.cards[0].columnTitle).toBe('Done');
    expect(result.cards[0].commentCount).toBe(2);
  });
});
```

- [ ] **Step 2 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts -t "pages the query with skip/take"`
Atteso: **FAIL** — `AssertionError: expected "findMany" to be called with arguments: [ ObjectContaining{…skip: 40, take: 20} ]`, con la chiamata registrata priva di `skip`/`take`.

- [ ] **Step 3 — Implementare la paginazione nel service**

In `backend/src/services/kanban/card.service.ts`, sostituisci le righe 403-423 (dal commento JSDoc `/** Get archived cards for a board. */` fino alla graffa di chiusura della funzione):

```ts
/**
 * Get archived cards for a board, one page at a time.
 * This is the only kanban list endpoint that used to be unbounded: a board with years
 * of archived cards returned the whole archive in one response. The mapper also flattens
 * `column.title` into `columnTitle` — the shape ArchivedCardsModal has always read.
 */
export async function getArchivedCards(boardId: string, page: number, limit: number) {
  const [cards, total] = await Promise.all([
    prisma.kanbanCard.findMany({
      where: { column: { boardId }, archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        ...cardWithAssigneeSelect,
        column: { select: { id: true, title: true } },
      },
    }),
    prisma.kanbanCard.count({
      where: { column: { boardId }, archivedAt: { not: null } },
    }),
  ]);

  return {
    cards: cards.map((card) => {
      const { _count, column, ...rest } = card;
      return { ...rest, columnTitle: column.title, commentCount: _count.comments };
    }),
    total,
    page,
    limit,
  };
}
```

- [ ] **Step 4 — Eseguire i test e vederli passare**

Run: `cd backend && npx vitest run src/services/kanban/__tests__/card.service.test.ts`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 31 passed (31)` (29 preesistenti + 2 nuovi).

- [ ] **Step 5 — Passare i parametri di paginazione dalla rotta**

In `backend/src/routes/kanban.ts`, sostituisci le righe 566-570:

```ts
  fastify.get('/boards/:id/archived', async (request) => {
    const { id } = request.params as { id: string };
    await assertBoardAccess(id, request.user.id, 'READ');
    const { page, limit } = paginationSchema.parse(request.query);
    return await kanbanService.getArchivedCards(id, page, limit);
  });
```

`paginationSchema` esiste già alle righe 69-72 con default `page: 1`, `limit: 50` e `.max(100)`.

Nessun test di rotta va toccato: `src/routes/__tests__/kanban.route.test.ts` mocka `../../services/kanban/index` in blocco (riga 34: `getArchivedCards: vi.fn()`) e non ha nessun caso sulla rotta `/archived`.

- [ ] **Step 6 — Aggiornare il test backend dei reminder perché richieda il `take`**

In `backend/src/services/__tests__/kanbanReminder.service.test.ts`, il primo `it` di `describe('getUserKanbanReminders')` (describe a riga 206, `it` a riga 207) chiude il suo `toHaveBeenCalledWith` con `      orderBy: { dueDate: 'asc' },` a **riga 249**. Sostituisci quella riga con:

```ts
      orderBy: { dueDate: 'asc' },
      take: 500,
```

E aggiungi un caso nuovo subito prima della chiusura del `describe` (riga 265, la riga `});` che segue il test `'should only return the requesting user\'s own reminders'`):

```ts
  it('never filters out done reminders — RemindersPage builds its Done section from them', async () => {
    prismaMock.kanbanReminder.findMany.mockResolvedValue([]);

    await getUserKanbanReminders(OWNER.id);

    const args = prismaMock.kanbanReminder.findMany.mock.calls[0][0];
    // Adding `isDone: false` here would make ticked reminders vanish from
    // RemindersPage (frontend/src/features/reminders/RemindersPage.tsx:113 builds
    // `done` from exactly these rows) and become impossible to un-tick.
    expect(args.where).toEqual({ userId: OWNER.id });
    expect(args.where).not.toHaveProperty('isDone');
  });
```

- [ ] **Step 7 — Eseguire il test e vederlo fallire**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanReminder.service.test.ts -t "should return reminders with card, column, and board info"`
Atteso: **FAIL** — `AssertionError: expected "findMany" to be called with arguments: [ …take: 500 ]`, con la chiamata registrata priva di `take`.

- [ ] **Step 8 — Aggiungere il cap (e SOLO il cap)**

In `backend/src/services/kanbanReminder.service.ts`, sostituisci la riga 149 (`    orderBy: { dueDate: 'asc' },`) con:

```ts
    orderBy: { dueDate: 'asc' },
    // ponytail: hard cap, no cursor. Sorted by dueDate asc, so the 500 most urgent
    // reminders win. Add real pagination only if someone actually hits the ceiling.
    // Do NOT add `isDone: false` here — RemindersPage renders its Done section from
    // exactly these rows; filtering them out makes ticked reminders un-untickable.
    take: 500,
```

- [ ] **Step 9 — Eseguire i test e vederli passare**

Run: `cd backend && npx vitest run src/services/__tests__/kanbanReminder.service.test.ts`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 16 passed (16)` (15 preesistenti + 1 nuovo).

- [ ] **Step 10 — Aggiungere l'indice composito allo schema (TIER 1)**

In `backend/prisma/schema.prisma`, dentro `model KanbanComment` (righe 527-537), sostituisci la riga 536 (`  @@index([cardId])`) con:

```prisma
  @@index([cardId])
  @@index([cardId, createdAt])
```

L'indice esistente resta: nessuna riga viene modificata, se ne aggiunge una.

- [ ] **Step 11 — Generare la migration**

`prisma.config.js` fa `require('dotenv').config()`, quindi **`backend/.env` deve esistere** con `DATABASE_URL` valorizzato prima di lanciare il comando; il container dev `notiq-db` deve essere su (porta 5433). Prisma 7.4.1: niente flag `--schema`.

Run: `cd backend && npx prisma migrate dev --name add_kanban_comment_card_created_idx`
Atteso: dopo una riga tipo `Applying migration '<timestamp>_add_kanban_comment_card_created_idx'`, l'output termina con `Your database is now in sync with your schema.`

- [ ] **Step 12 — Verifica: la migration contiene esattamente l'indice atteso e nulla d'altro**

Run: `cd backend && cat prisma/migrations/*_add_kanban_comment_card_created_idx/migration.sql`
Atteso, testualmente:
```
-- CreateIndex
CREATE INDEX "KanbanComment_cardId_createdAt_idx" ON "KanbanComment"("cardId", "createdAt");
```
Se compare qualsiasi `DROP`, `ALTER COLUMN` o `CREATE TABLE`: **fermati**, lo schema è stato toccato oltre l'indice — annulla e ricontrolla il diff di `schema.prisma`.

Run: `cd backend && git diff --stat prisma/schema.prisma`
Atteso: `1 file changed, 1 insertion(+)`

- [ ] **Step 13 — Aggiornare le query key e i tipi lato frontend**

In `frontend/src/lib/queryKeys.ts`, sostituisci la riga 23:

```ts
    archivedCards: (boardId: string, page = 1) => ['kanban-archived-cards', boardId, page] as const,
    archivedCardsAll: (boardId: string) => ['kanban-archived-cards', boardId] as const,
```

In `frontend/src/features/kanban/types.ts`, sostituisci le righe 149-154:

```ts
export interface ArchivedCard {
  id: string;
  title: string;
  columnTitle: string;
  archivedAt: string;
}

export interface ArchivedCardsPage {
  cards: ArchivedCard[];
  total: number;
  page: number;
  limit: number;
}
```

In `frontend/src/features/kanban/kanbanService.ts`, la lista di import di tipo contiene già `  ArchivedCard,` a riga 17: aggiungi subito sotto:

```ts
  ArchivedCardsPage,
```

Sostituisci le righe 639-642:

```ts
export async function getArchivedCards(boardId: string, page = 1): Promise<ArchivedCardsPage> {
  const res = await api.get<ArchivedCardsPage>(`/kanban/boards/${boardId}/archived`, {
    params: { page, limit: 50 },
  });
  return res.data;
}
```

- [ ] **Step 14 — Aggiungere il test frontend del service**

In `frontend/src/features/kanban/__tests__/kanbanService.test.ts`, sostituisci la riga 50:

```ts
import { deleteCard, createCard, splitTextForCard, CARD_TITLE_MAX, CARD_DESCRIPTION_MAX, getArchivedCards } from '../kanbanService';
import apiClient from '../../../lib/api';

// The api module is mocked above (line 45) with plain vi.fn()s; this cast gives them
// back with a mock type instead of AxiosInstance, so mockResolvedValue typechecks.
const mockApi = apiClient as unknown as { get: ReturnType<typeof vi.fn> };
```

E aggiungi in fondo al file (dopo il `describe('kanbanService.deleteCard')` che chiude a riga 149):

```ts
describe('kanbanService.getArchivedCards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends page and limit and returns the paged payload', async () => {
    const payload = { cards: [], total: 137, page: 3, limit: 50 };
    mockApi.get.mockResolvedValue({ data: payload });

    const result = await getArchivedCards('board-1', 3);

    expect(mockApi.get).toHaveBeenCalledWith('/kanban/boards/board-1/archived', {
      params: { page: 3, limit: 50 },
    });
    expect(result).toEqual(payload);
  });

  it('defaults to page 1', async () => {
    mockApi.get.mockResolvedValue({ data: { cards: [], total: 0, page: 1, limit: 50 } });

    await getArchivedCards('board-1');

    expect(mockApi.get).toHaveBeenCalledWith('/kanban/boards/board-1/archived', {
      params: { page: 1, limit: 50 },
    });
  });
});
```

- [ ] **Step 15 — Eseguire il test frontend e vederlo fallire, poi passare**

Se esegui questo comando **prima** delle modifiche dello Step 13:
Run: `cd frontend && npx vitest run src/features/kanban/__tests__/kanbanService.test.ts -t "sends page and limit"`
Atteso: **FAIL** — `AssertionError: expected "get" to be called with arguments: [ '/kanban/boards/board-1/archived', { params: { page: 3, limit: 50 } } ]`, con la chiamata registrata priva del secondo argomento.

Dopo lo Step 13, rieseguendo l'intero file:
Run: `cd frontend && npx vitest run src/features/kanban/__tests__/kanbanService.test.ts`
Atteso: **PASS** — `Test Files 1 passed (1)` / `Tests 10 passed (10)` (8 preesistenti + 2 nuovi).

- [ ] **Step 16 — Aggiungere le chiavi i18n della paginazione**

In `frontend/src/locales/en.json`, dentro `kanban.archive` (blocco righe 1016-1021), l'ultima chiave è `"archivedOn": "Archived on {{date}}"` a riga 1020. Aggiungi una virgola a quella riga e inserisci sotto:

```json
      "pageOf": "{{from}}–{{to}} of {{total}}"
```

In `frontend/src/locales/it.json`, dentro `kanban.archive` (blocco righe 1271-1276), l'ultima chiave è `"archivedOn": "Archiviata il {{date}}"` a riga 1275. Aggiungi la virgola e inserisci sotto:

```json
      "pageOf": "{{from}}–{{to}} di {{total}}"
```

- [ ] **Step 17 — Verificare che i due locale abbiano le stesse chiavi**

Run: `cd frontend && node -e "const en=require('./src/locales/en.json'),it=require('./src/locales/it.json');const a=Object.keys(en.kanban.archive).sort(),b=Object.keys(it.kanban.archive).sort();console.log(JSON.stringify(a)===JSON.stringify(b)?'KEYS MATCH: '+a.length:'MISMATCH '+JSON.stringify(a)+' vs '+JSON.stringify(b))"`
Atteso: `KEYS MATCH: 5` (4 chiavi preesistenti + `pageOf`)

- [ ] **Step 18 — Aggiungere i controlli di pagina al modale**

Sostituisci l'intero contenuto di `frontend/src/features/kanban/components/ArchivedCardsModal.tsx` (85 righe) con:

```tsx
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { format } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { Archive, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../components/ui/Modal';
import * as kanbanService from '../kanbanService';

const PAGE_SIZE = 50;

interface ArchivedCardsModalProps {
  isOpen: boolean;
  onClose: () => void;
  boardId: string;
  onUnarchive: () => void;
}

export default function ArchivedCardsModal({ isOpen, onClose, boardId, onUnarchive }: ArchivedCardsModalProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const dateLocale = i18n.language?.startsWith('it') ? itLocale : enUS;
  const [page, setPage] = useState(1);

  // Reopening the modal (or switching board) starts from the first page again
  useEffect(() => {
    if (isOpen) setPage(1);
  }, [isOpen, boardId]);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.kanban.archivedCards(boardId, page),
    queryFn: () => kanbanService.getArchivedCards(boardId, page),
    enabled: isOpen,
  });

  const cards = data?.cards ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const hasPrev = page > 1;
  const hasNext = to < total;

  async function handleUnarchive(cardId: string): Promise<void> {
    await kanbanService.unarchiveCard(cardId);
    // Prefix key: invalidates every cached page of this board's archive at once
    queryClient.invalidateQueries({ queryKey: queryKeys.kanban.archivedCardsAll(boardId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.kanban.board(boardId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.kanban.boards });
    onUnarchive();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kanban.archive.title')} size="md">
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : cards.length > 0 ? (
          cards.map((card) => (
            <div
              key={card.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 bg-neutral-50 dark:bg-neutral-800/50"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                  {card.title}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {card.columnTitle}
                  </span>
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">
                    {t('kanban.archive.archivedOn', {
                      date: format(new Date(card.archivedAt), 'dd MMM yyyy', { locale: dateLocale }),
                    })}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleUnarchive(card.id)}
                className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded-lg transition-colors"
                title={t('kanban.archive.unarchive')}
              >
                <RotateCcw size={12} />
                {t('kanban.archive.unarchive')}
              </button>
            </div>
          ))
        ) : (
          <div className="text-center py-12">
            <Archive className="mx-auto text-neutral-300 dark:text-neutral-600 mb-3" size={36} />
            <p className="text-sm text-neutral-400 dark:text-neutral-500">
              {t('kanban.archive.empty')}
            </p>
          </div>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-neutral-200/60 dark:border-neutral-700/40">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('kanban.archive.pageOf', { from, to, total })}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!hasPrev}
              aria-label={t('common.previous')}
              className="p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNext}
              aria-label={t('common.next')}
              className="p-1.5 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
```

`common.previous` ("Previous"/"Precedente") e `common.next` ("Next"/"Avanti") esistono già in entrambi i locale: non vanno aggiunti. `Modal` accetta `size` (`Modal.tsx:19`, default `'md'`) e più figli. Le props di `ArchivedCardsModal` restano identiche, quindi il call site in `KanbanBoardPage.tsx:1151-1158` non va toccato.

- [ ] **Step 19 — Lint, typecheck e suite completa su entrambi i workspace**

Run: `cd backend && npm run lint && npx tsc --noEmit && npm test`
Atteso: lint `0 errors, 63 warnings`; tsc nessun output; `npm test` **PASS**, nessun file fallito.

Run: `cd frontend && npm run lint && npx tsc -p tsconfig.app.json --noEmit && npm test`
Atteso: lint `0 errors, 52 warnings`; tsc nessun output; `npm test` **PASS**, nessun file fallito.

- [ ] **Step 20 — Verifica manuale (archivio paginato + reminder spuntati)**

1. `cd backend && npm run dev` e `cd frontend && npm run dev`.
2. Apri una board, menu `⋮` → "Archived Cards": sotto ogni titolo deve ora comparire **il nome della colonna** (prima era vuoto perché il backend mandava `column.title` e la modale leggeva `columnTitle`).
3. Su una board con più di 50 card archiviate: compaiono il contatore `1–50 of N` e le due frecce; "avanti" carica la pagina 2; "indietro" è disabilitato in pagina 1 e "avanti" in ultima pagina.
4. Ripristina una card da pagina 2 → sparisce dall'elenco (la invalidate a prefisso svuota tutte le pagine).
5. Apri `/reminders`, spunta un reminder kanban → si sposta nella sezione **Done** barrato.
6. Ricarica la pagina → deve **essere ancora lì**, barrato, e cliccabile per de-spuntarlo.
7. De-spuntalo → torna nella sezione Overdue/Today/Upcoming.

Se al punto 6 sparisce, qualcuno ha aggiunto `isDone` al `where`: rileggi l'avvertenza in testa al task.

- [ ] **Step 21 — Commit (uno per lo schema TIER 1, uno per il resto)**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "perf(kanban): add composite index on KanbanComment(cardId, createdAt)"
```

```bash
git add backend/src/services/kanban/card.service.ts backend/src/services/kanban/__tests__/card.service.test.ts backend/src/routes/kanban.ts backend/src/services/kanbanReminder.service.ts backend/src/services/__tests__/kanbanReminder.service.test.ts frontend/src/lib/queryKeys.ts frontend/src/features/kanban/types.ts frontend/src/features/kanban/kanbanService.ts frontend/src/features/kanban/__tests__/kanbanService.test.ts frontend/src/features/kanban/components/ArchivedCardsModal.tsx frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "perf(kanban): paginate archived cards and cap the reminder query"
```

---

### Task 6.5: Collegare la suite Playwright alla CI

**Perché:** `frontend/e2e/` contiene 16 spec (auth, collaboration, dexie, encryption, groups, import, kanban, notebooks, notes, profile-trash, sanity, search, sharing, tables, tags, tasks) ed è **l'unica copertura a livello di UI del progetto**. `.github/workflows/ci.yml` ha solo i job `backend` (righe 10-47) e `frontend` (righe 49-77), nessuno dei due la esegue: oggi è codice morto che nessuno lancia e che marcisce in silenzio.
**Severità:** medium · **Effort:** M · **Rischio:** none sul codice applicativo — si tocca solo il workflow.

> ⚠️ **Da fare DOPO che Stage 3 si è assestato.** Gli spec interrogano la UI per testo e placeholder; farli girare in mezzo a un refactor produce fallimenti che non dicono nulla di utile.
>
> ⚠️ **Gli spec possono essere marci.** Non girano da tempo: il compito del primo run è **scoprire quali passano**, non essere verdi al primo colpo. Per questo il job atterra con `continue-on-error: true` (Step 4) e lo si toglie in un secondo commit una volta noto lo stato reale (Step 8).

**File:**
- Modifica: `.github/workflows/ci.yml` (aggiunta di un terzo job dopo la riga 77, `        run: npm run build`)

**Interfacce:**
- Consuma: `frontend/playwright.config.ts` (`testDir: './e2e'` riga 4, `retries: process.env.CI ? 2 : 0` riga 7, `workers: 1` in CI riga 8, `reporter: 'html'` riga 9, `baseURL: 'http://localhost:5173'` riga 11, un solo project `chromium` righe 16-21, `webServer.command: 'npm run dev'` righe 23-27 con `reuseExistingServer: !process.env.CI`); `frontend/e2e/helpers.ts` (`API_BASE = 'http://localhost:3001'` riga 7, login superadmin `superadmin@notiq.ai` / `superadmin` righe 8-9 e 48-51)
- Produce: nessuna

---

- [ ] **Step 1 — Verificare i prerequisiti che il job deve soddisfare**

Il job deve replicare quello che l'app si aspetta in locale. Verificato nel codice:
- `backend/src/app.ts:321` — la porta è **hardcoded a 3001** (`await server.listen({ port: 3001, host: '0.0.0.0' });`), non configurabile via env.
- `backend/src/app.ts:114-117` — `JWT_SECRET` è obbligatorio, altrimenti `process.exit(1)`.
- `backend/src/app.ts:46` — CORS default `['http://localhost:5173']`, che è esattamente il `baseURL` di Playwright: nessuna env CORS da impostare.
- `backend/src/app.ts:130` — il rate limit globale (600/min) ha `allowList: ['127.0.0.1', '::1']`, quindi le richieste della CI (localhost) sono esenti.
- `backend/src/routes/health.ts:6` + `app.ts:239` — `healthRoutes` è registrato **senza prefisso**: l'endpoint è `http://localhost:3001/health` e risponde `{"status":"ok","db":"up",…}` (503 se il DB è giù).
- **`frontend/.env` è gitignored** (`.gitignore:18`): in CI non esiste, quindi `VITE_API_URL` è `undefined` e `frontend/src/lib/api.ts:5` cade sul fallback `http://localhost:3001/api`. Anche `VITE_WS_URL` (`NoteEditor.tsx:189` → `|| 'ws://localhost:3001/ws'`) e `VITE_VAPID_PUBLIC_KEY` (`usePushNotifications.ts:4`) hanno fallback. **Non serve creare nessun `.env` frontend nel job.**
- `frontend/e2e/helpers.ts:48-51` — serve il superadmin in DB, creato da `backend/src/scripts/create-superadmin.ts` (che crea proprio `superadmin@notiq.ai` / `superadmin`, `role: 'SUPERADMIN'`, `isVerified: true`).
- `frontend/e2e/helpers.ts:59-67` — la registrazione manda una mail: senza SMTP fallisce ma la riga utente viene creata; l'helper ignora l'errore per progetto.

Run: `grep -n "port: 3001" backend/src/app.ts && grep -n "allowList" backend/src/app.ts && grep -n "server.register(healthRoutes)" backend/src/app.ts`
Atteso, esattamente:
```
321:    await server.listen({ port: 3001, host: '0.0.0.0' });
130:  allowList: ['127.0.0.1', '::1'], // localhost exempt (health checks, internal)
239:server.register(healthRoutes);
```

- [ ] **Step 2 — Verificare che la suite parta in locale (baseline prima di toccare la CI)**

Con Docker `notiq-db` su, backend su :3001 e il superadmin creato (`cd backend && npx tsx src/scripts/create-superadmin.ts`):

Run: `cd frontend && npx playwright test e2e/sanity.spec.ts`
Atteso: o **PASS**, o un fallimento **con un errore leggibile** (es. `Error: expect(page).toHaveURL(…) failed`). Se invece l'errore è `browserType.launch: Executable doesn't exist`, esegui prima `npx playwright install chromium` e ripeti. Annota il risultato: è la baseline da confrontare col primo run in CI.

- [ ] **Step 3 — Verificare che il file di workflow abbia oggi solo due job**

Run:
```bash
node -e "
const fs=require('fs');
const t=fs.readFileSync('.github/workflows/ci.yml','utf8');
const body=t.slice(t.indexOf('\njobs:'));
const jobs=[...body.matchAll(/^  ([a-z0-9_-]+):\$/gm)].map(m=>m[1]);
console.log('JOBS: '+jobs.join(','));
console.log(/^    continue-on-error: true\$/m.test(t)?'NON-BLOCKING':'BLOCKING');
"
```
Atteso, esattamente:
```
JOBS: backend,frontend
BLOCKING
```
(Lo slice da `\njobs:` serve: senza, il match prenderebbe anche `  push:` dalla sezione `on:`.)

- [ ] **Step 4 — Aggiungere il job `e2e`**

Appendi in fondo a `.github/workflows/ci.yml` (dopo la riga 77, `        run: npm run build`), mantenendo l'indentazione a 2 spazi per il nome del job:

```yaml
  e2e:
    name: E2E (Playwright, chromium)
    runs-on: ubuntu-latest
    # The suite has not run in CI before: land it non-blocking, read the first report,
    # then remove this line in a follow-up commit once the real state is known.
    continue-on-error: true

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: ci
          POSTGRES_PASSWORD: ci
          POSTGRES_DB: ci
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci?schema=public"
      JWT_SECRET: "ci-dummy-secret"
      FRONTEND_URL: "http://localhost:5173"
      LOG_LEVEL: "warn"

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20.19.0'

      - name: Install backend dependencies
        working-directory: backend
        run: npm ci

      - name: Generate Prisma client
        working-directory: backend
        run: npx prisma generate

      - name: Apply migrations
        working-directory: backend
        run: npx prisma migrate deploy

      - name: Seed superadmin (e2e/helpers.ts logs in as superadmin@notiq.ai)
        working-directory: backend
        run: npx tsx src/scripts/create-superadmin.ts

      - name: Build backend
        working-directory: backend
        run: npm run build

      - name: Start backend on :3001
        working-directory: backend
        run: |
          node dist/app.js > backend.log 2>&1 &
          echo $! > backend.pid
          for i in $(seq 1 60); do
            if curl -sf http://localhost:3001/health > /dev/null; then
              echo "backend is up"
              curl -s http://localhost:3001/health
              exit 0
            fi
            sleep 1
          done
          echo "backend did not become healthy in 60s"
          cat backend.log
          exit 1

      - name: Install frontend dependencies
        working-directory: frontend
        run: npm ci

      - name: Install Playwright browser
        working-directory: frontend
        run: npx playwright install --with-deps chromium

      - name: Run Playwright tests
        working-directory: frontend
        run: npx playwright test

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            frontend/playwright-report
            frontend/test-results
          retention-days: 7

      - name: Upload backend log
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: backend-log
          path: backend/backend.log
          retention-days: 7
```

Note verificate: `prisma.config.js` fa `require('dotenv').config()`, che è un no-op se `backend/.env` non esiste — `DATABASE_URL` arriva dalle env del job, esattamente come già fa il job `backend`. `tsx` è una devDependency (`^4.21.0`), quindi `npx tsx` non scarica nulla. `create-superadmin.ts` importa `dotenv/config` per lo stesso motivo. Il server Vite **non** ha bisogno di uno step dedicato: `playwright.config.ts:23-27` avvia da sé `npm run dev` sulla 5173 e `reuseExistingServer: !process.env.CI` è `false` su GitHub Actions (`CI=true`).

- [ ] **Step 5 — Verifica: il workflow è YAML valido, ha tre job ed è non bloccante**

Run:
```bash
node -e "
const fs=require('fs');
const t=fs.readFileSync('.github/workflows/ci.yml','utf8');
const body=t.slice(t.indexOf('\njobs:'));
const jobs=[...body.matchAll(/^  ([a-z0-9_-]+):\$/gm)].map(m=>m[1]);
console.log('JOBS: '+jobs.join(','));
console.log(/^    continue-on-error: true\$/m.test(t)?'NON-BLOCKING':'BLOCKING');
"
```
Atteso, esattamente:
```
JOBS: backend,frontend,e2e
NON-BLOCKING
```

- [ ] **Step 6 — Commit e primo run in CI**

```bash
git add .github/workflows/ci.yml
git commit -m "chore(ci): run the Playwright e2e suite on push and pull_request"
```

Apri una PR verso `main`.
Atteso: sulla PR compaiono tre check. `E2E (Playwright, chromium)` **deve arrivare in fondo**: cioè lo step "Start backend on :3001" deve stampare `backend is up` seguito da un JSON che comincia con `{"status":"ok","db":"up"`. Se fallisce **prima** di quello step, il problema è l'infrastruttura del job, non gli spec — sistemalo prima di guardare i test.

- [ ] **Step 7 — Leggere il report e triagiare gli spec marci**

Scarica l'artifact `playwright-report` dalla run fallita (Actions → la run → Artifacts) e apri `index.html`.

Per ogni spec fallito, decidi:
- **selettore cambiato** (es. testo di un bottone rinominato) → aggiorna lo spec;
- **feature rimossa/spostata** → cancella o riscrivi lo spec;
- **flaky per timing** → il config ha già `retries: 2` in CI; se fallisce comunque, aggiungi un `await expect(locator).toBeVisible({ timeout: 10000 })` sull'elemento atteso invece di un `page.waitForTimeout(...)`.

Ogni correzione è un commit a sé:
```bash
git add frontend/e2e/<spec>.spec.ts
git commit -m "test(e2e): fix <spec> selectors after UI changes"
```

- [ ] **Step 8 — Rendere il job bloccante**

Una volta che il job è verde, in `.github/workflows/ci.yml` rimuovi queste tre righe dal job `e2e`:

```yaml
    # The suite has not run in CI before: land it non-blocking, read the first report,
    # then remove this line in a follow-up commit once the real state is known.
    continue-on-error: true
```

- [ ] **Step 9 — Verifica: il job è ora bloccante**

Run: `grep -c "continue-on-error" .github/workflows/ci.yml; echo "grep-exit=$?"`
Atteso: `0` e `grep-exit=1` (grep non trova occorrenze).

- [ ] **Step 10 — Commit finale**

```bash
git add .github/workflows/ci.yml
git commit -m "chore(ci): make the e2e job blocking now that the suite is green"
```

---
