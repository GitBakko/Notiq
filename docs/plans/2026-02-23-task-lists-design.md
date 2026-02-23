# Task Lists Feature — Design Document

**Data:** 2026-02-23
**Versione target:** 1.3.0
**Stato:** Approvato

---

## Obiettivo

Aggiungere a Notiq un sistema di task list (liste di cose da fare / lista della spesa) come entita indipendente. Le task list possono essere condivise con altri utenti, che ricevono notifiche real-time per ogni modifica agli item.

La sezione "Attivita" esistente viene rinominata in "Promemoria" (note con scadenza). La nuova sezione "Task" ospita le task list.

---

## Decisioni architetturali

| Decisione | Scelta | Motivazione |
|-----------|--------|-------------|
| Architettura | Entita indipendente (TaskList + TaskItem) | Massima flessibilita, separazione di responsabilita |
| Organizzazione | Indipendenti dai taccuini | UX semplice, meno complessita |
| Layout | Sezione separata "Task" nella sidebar | Separazione netta da "Promemoria" (ex Attivita) |
| Notifiche | Tutti gli eventi (aggiunta, spunta, rimozione) | Collaborazione trasparente |
| Collaborazione | REST sync (pull/push) | Coerente con il pattern offline-first, no WebSocket |
| Item features | Testo + checkbox + priorita + scadenza | Bilanciamento tra semplicita e utilita |
| Offline | Full Dexie sync | Coerente con il resto dell'app |

---

## Schema dati

### Nuovi enum Prisma

```prisma
enum TaskPriority {
  LOW
  MEDIUM
  HIGH
}
```

### Nuovi tipi NotificationType (estensione enum esistente)

```prisma
enum NotificationType {
  // ... esistenti ...
  TASK_ITEM_ADDED
  TASK_ITEM_CHECKED
  TASK_ITEM_REMOVED
  TASK_LIST_SHARED
}
```

### Nuovi modelli Prisma

```prisma
model TaskList {
  id          String           @id @default(uuid())
  title       String
  userId      String
  user        User             @relation(fields: [userId], references: [id])
  items       TaskItem[]
  sharedWith  SharedTaskList[]
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  isTrashed   Boolean          @default(false)

  @@index([userId, isTrashed])
}

model TaskItem {
  id          String        @id @default(uuid())
  taskListId  String
  taskList    TaskList      @relation(fields: [taskListId], references: [id], onDelete: Cascade)
  text        String
  isChecked   Boolean       @default(false)
  priority    TaskPriority  @default(MEDIUM)
  dueDate     DateTime?
  position    Int           @default(0)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  @@index([taskListId])
}

model SharedTaskList {
  id          String      @id @default(uuid())
  taskListId  String
  taskList    TaskList    @relation(fields: [taskListId], references: [id], onDelete: Cascade)
  userId      String
  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  permission  Permission  @default(READ)
  status      ShareStatus @default(PENDING)
  createdAt   DateTime    @default(now())

  @@unique([taskListId, userId])
  @@index([userId, status])
}
```

### Dexie (versione 13)

```typescript
// Nuove tabelle
taskLists: 'id, userId, updatedAt, syncStatus, isTrashed'
taskItems: 'id, taskListId, updatedAt, syncStatus, position'
```

Interfacce TypeScript:

```typescript
interface LocalTaskList {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  isTrashed: boolean;
  syncStatus: 'synced' | 'pending' | 'error';
}

interface LocalTaskItem {
  id: string;
  taskListId: string;
  text: string;
  isChecked: boolean;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  dueDate?: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'pending' | 'error';
}
```

---

## API Routes

### Task List CRUD (`/api/tasklists`)

| Method | Path | Descrizione | Auth |
|--------|------|-------------|------|
| `GET` | `/tasklists` | Lista task list utente + condivise accettate | JWT |
| `GET` | `/tasklists/:id` | Dettaglio con items | JWT |
| `POST` | `/tasklists` | Crea nuova task list | JWT |
| `PUT` | `/tasklists/:id` | Aggiorna titolo | JWT (owner o WRITE) |
| `DELETE` | `/tasklists/:id` | Soft-delete (isTrashed) | JWT (owner) |

### Task Items (`/api/tasklists/:id/items`)

| Method | Path | Descrizione | Auth |
|--------|------|-------------|------|
| `POST` | `/tasklists/:id/items` | Aggiungi item | JWT (owner o WRITE) |
| `PUT` | `/tasklists/:id/items/:itemId` | Aggiorna item | JWT (owner o WRITE) |
| `DELETE` | `/tasklists/:id/items/:itemId` | Rimuovi item | JWT (owner o WRITE) |
| `PUT` | `/tasklists/:id/items/reorder` | Riordina posizioni (batch) | JWT (owner o WRITE) |

### Sharing (`/api/share/tasklists`)

| Method | Path | Descrizione |
|--------|------|-------------|
| `POST` | `/share/tasklists/:id` | Condividi lista per email |
| `DELETE` | `/share/tasklists/:id/:userId` | Revoca condivisione |
| `GET` | `/share/tasklists` | Liste condivise con l'utente |

### Sync (estensione route esistenti)

`GET /sync/pull` e `POST /sync/push` estesi per includere `taskLists` e `taskItems`.

---

## Notifiche

### Eventi notificati

| Evento | Tipo notifica | Destinatari |
|--------|---------------|-------------|
| Item aggiunto | `TASK_ITEM_ADDED` | Tutti i collaboratori tranne chi ha fatto l'azione |
| Item spuntato/despuntato | `TASK_ITEM_CHECKED` | Tutti i collaboratori tranne chi ha fatto l'azione |
| Item rimosso | `TASK_ITEM_REMOVED` | Tutti i collaboratori tranne chi ha fatto l'azione |
| Lista condivisa | `TASK_LIST_SHARED` | Utente destinatario della condivisione |

### Flusso

```
Collaboratore modifica item
  -> Backend salva modifica
  -> Trova tutti i collaboratori della lista (SharedTaskList con status ACCEPTED + owner)
  -> Per ogni collaboratore (escluso chi ha agito):
     -> createNotification(userId, type, title, message, data)
       -> DB insert
       -> Se utente inattivo > 5min: web push
```

### Dati notifica (campo `data`)

```json
{
  "taskListId": "uuid",
  "taskListTitle": "Lista della spesa",
  "taskItemText": "Pane",
  "actionBy": "Mario Rossi",
  "localizationKey": "notifications.taskItemAdded",
  "localizationArgs": { "userName": "Mario", "itemText": "Pane", "listTitle": "Lista della spesa" }
}
```

---

## Frontend — UI

### Sidebar

```
📝 Note
📓 Taccuini
🔔 Promemoria    (rinominata da "Attivita", route /reminders)
✅ Task           (NUOVA, route /tasks)
🏷️ Tag
🔒 Vault
👥 Gruppi
📤 Condivise con me
🗑️ Cestino
```

### Pagina `/reminders` (ex `/tasks`)

`TasksPage.tsx` rinominata in `RemindersPage.tsx`. Route cambiata da `/tasks` a `/reminders`. Nessuna modifica funzionale.

### Pagina `/tasks` — TaskListsPage

Layout: tutte le task list visualizzate come card espandibili in una singola pagina scrollabile.

```
┌──────────────────────────────────────────────────┐
│  ✅ Task                          [+ Nuova Lista] │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─ Lista della spesa ──────── 3/5 ─── 🔗 ──┐  │
│  │ ☑ Pane       ▪ media                      │  │
│  │ ☑ Latte      ▪ media                      │  │
│  │ ☐ Uova       ▪ alta     📅 24 feb         │  │
│  │ ☐ Frutta     ▪ bassa                      │  │
│  │ ☑ Pasta      ▪ media                      │  │
│  │ [+ Aggiungi elemento]                     │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌─ TODO Progetto ──────────── 1/4 ─── 🔗 ──┐  │
│  │ ☐ Design mockup   ▪ alta   📅 25 feb      │  │
│  │ ☐ API endpoints   ▪ alta                  │  │
│  │ ☐ Frontend        ▪ media                 │  │
│  │ ☑ Setup repo      ▪ bassa                 │  │
│  │ [+ Aggiungi elemento]                     │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Componenti

| Componente | Path | Ruolo |
|-----------|------|-------|
| `TaskListsPage.tsx` | `features/tasks/TaskListsPage.tsx` | Pagina principale |
| `TaskListCard.tsx` | `features/tasks/TaskListCard.tsx` | Card espandibile singola lista |
| `TaskItemRow.tsx` | `features/tasks/TaskItemRow.tsx` | Riga singolo item |
| `NewTaskListModal.tsx` | `features/tasks/NewTaskListModal.tsx` | Modal creazione lista |
| `TaskListSharingModal.tsx` | `features/tasks/TaskListSharingModal.tsx` | Modal condivisione |
| `TaskPriorityBadge.tsx` | `features/tasks/TaskPriorityBadge.tsx` | Badge priorita colorato |
| `taskListService.ts` | `features/tasks/taskListService.ts` | Operazioni Dexie + API |
| `useTaskLists.ts` | `hooks/useTaskLists.ts` | Hook Dexie live query |

### Interazioni

- **Aggiungere item:** input inline in fondo alla lista, Enter per confermare
- **Spuntare item:** click sulla checkbox, item completati vanno in fondo con stile barrato
- **Priorita:** dropdown inline (verde=LOW, giallo=MEDIUM, rosso=HIGH)
- **Scadenza:** date picker inline opzionale
- **Riordinamento:** drag & drop (campo `position`)
- **Condivisione:** icona link nell'header della lista -> `TaskListSharingModal`
- **Eliminazione lista:** menu contestuale con conferma (soft-delete)

---

## Sync offline

### syncPull (estensione)

```typescript
// In syncPull, dopo le note:
const taskListsResponse = await api.get('/tasklists');
const sharedTaskListsResponse = await api.get('/share/tasklists/accepted');
// Merge e salva in Dexie db.taskLists e db.taskItems
```

### syncPush (estensione)

```typescript
// In syncPush, dopo le note:
const pendingTaskLists = await db.taskLists.where('syncStatus').equals('pending').toArray();
const pendingTaskItems = await db.taskItems.where('syncStatus').equals('pending').toArray();
// Push via API, aggiorna syncStatus a 'synced'
```

---

## i18n

Chiavi da aggiungere in `en.json` e `it.json`:

- `sidebar.reminders` / `sidebar.tasks`
- `tasks.title`, `tasks.newList`, `tasks.addItem`, `tasks.deleteList`, `tasks.deleteListConfirm`
- `tasks.priority.low`, `tasks.priority.medium`, `tasks.priority.high`
- `tasks.progress` (es. "3/5 completati")
- `tasks.share`, `tasks.shared`, `tasks.noLists`, `tasks.emptyList`
- `notifications.taskItemAdded`, `notifications.taskItemChecked`, `notifications.taskItemRemoved`
- `notifications.taskListShared`

---

## File impattati (riepilogo)

### Nuovi file

| File | Tipo |
|------|------|
| `backend/src/routes/tasklists.ts` | Route Fastify |
| `backend/src/services/tasklist.service.ts` | Business logic |
| `frontend/src/features/tasks/TaskListsPage.tsx` | Pagina principale |
| `frontend/src/features/tasks/TaskListCard.tsx` | Componente card |
| `frontend/src/features/tasks/TaskItemRow.tsx` | Componente item |
| `frontend/src/features/tasks/NewTaskListModal.tsx` | Modal creazione |
| `frontend/src/features/tasks/TaskListSharingModal.tsx` | Modal sharing |
| `frontend/src/features/tasks/TaskPriorityBadge.tsx` | Badge priorita |
| `frontend/src/features/tasks/taskListService.ts` | Service Dexie + API |
| `frontend/src/hooks/useTaskLists.ts` | Hook dati |

### File modificati

| File | Tipo modifica |
|------|---------------|
| `backend/prisma/schema.prisma` | +3 modelli, +1 enum, +4 NotificationType |
| `backend/src/app.ts` | Registrazione nuove route |
| `backend/src/services/notification.service.ts` | Supporto nuovi tipi |
| `frontend/src/lib/db.ts` | Versione 13, +2 tabelle |
| `frontend/src/features/sync/syncService.ts` | Estensione pull/push |
| `frontend/src/features/tasks/TasksPage.tsx` | Rinomina in RemindersPage.tsx |
| `frontend/src/App.tsx` | Nuove route /tasks e /reminders |
| `frontend/src/components/layout/Sidebar.tsx` | Nuove voci menu |
| `frontend/src/features/sharing/SharedWithMePage.tsx` | Tab task list condivise |
| `frontend/src/features/notifications/NotificationItem.tsx` | Icone nuovi tipi |
| `frontend/src/locales/en.json` | Chiavi i18n |
| `frontend/src/locales/it.json` | Chiavi i18n |

**Totale: ~10 nuovi file, ~12 file modificati.**

---

## Rischi e mitigazioni

| Rischio | Mitigazione |
|---------|-------------|
| Sync conflict su item condivisi | Last-write-wins con `updatedAt`, sufficiente per task list |
| Complessita drag & drop | Usare libreria `@dnd-kit/core` (gia usata in altri progetti React) |
| Migration Prisma in prod | Testare con `prisma migrate dev` locale, poi `migrate deploy` in prod |
| Dexie versione 13 | Solo aggiunta nuove tabelle, nessuna modifica a versioni precedenti |
| Sync service (TIER 1) | Proporre diff prima di applicare, test manuali approfonditi |
