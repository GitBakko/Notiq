# Phase 0: Critical Stabilization — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate data-loss risks, security gaps, and state leaks identified in the codebase audit.

**Architecture:** Seven targeted fixes across backend schema, sync engine, frontend state, and server middleware. Each task is independent — no ordering dependency except Task 1 (migration) should run first. All work on branch `feature/phase0-stabilization`.

**Tech Stack:** Prisma 7 (migration), Dexie.js v4 (sync), Zustand (stores), Fastify 5 (middleware), Axios, TypeScript.

---

### Task 1: Add CASCADE on Notebook → Note FK

**Files:**
- Modify: `backend/prisma/schema.prisma:119`
- Create: New Prisma migration via CLI

**Step 1: Modify the FK relationship**

In `backend/prisma/schema.prisma`, line 119, change:
```prisma
  notebook    Notebook @relation(fields: [notebookId], references: [id])
```
to:
```prisma
  notebook    Notebook @relation(fields: [notebookId], references: [id], onDelete: Cascade)
```

**Step 2: Create the migration**

Run:
```bash
cd backend && npx prisma migrate dev --name notebook_note_cascade_delete
```
Expected: Migration created successfully, `prisma generate` runs automatically.

**Step 3: Verify migration SQL**

Check the generated migration file in `backend/prisma/migrations/` — it should contain:
```sql
ALTER TABLE "Note" DROP CONSTRAINT "Note_notebookId_fkey";
ALTER TABLE "Note" ADD CONSTRAINT "Note_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "fix: add CASCADE delete on Notebook→Note FK to prevent orphan notes"
```

---

### Task 2: Extend zombie prevention in syncService.ts

**Files:**
- Modify: `frontend/src/features/sync/syncService.ts:161-207` (Task Lists Pull section)

**Context:** Zombie prevention exists for NOTE (lines 84-91) and KANBAN_BOARD/COLUMN/CARD (lines 260-314). The pattern: before putting server data into Dexie, check the syncQueue for pending DELETE entries and filter them out. Also filter them from the `toDeleteIds` cleanup set.

The Task List pull (lines 161-207) and its child Task Items are missing this protection. If a user deletes a task list offline, syncPull would re-insert it.

**Step 1: Add zombie prevention to Task Lists Pull**

In `frontend/src/features/sync/syncService.ts`, inside the task list pull transaction (after line 169, which has `const dirtyIds = new Set(dirtyTaskLists.map(tl => tl.id));`), add zombie prevention:

```typescript
        // Zombie prevention: check for pending task list deletes
        const pendingTaskListDeletes = await db.syncQueue
          .where('entity').equals('TASK_LIST')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingTaskListDeleteIds = new Set(pendingTaskListDeletes.map(i => i.entityId));

        // Zombie prevention: check for pending task item deletes
        const pendingTaskItemDeletes = await db.syncQueue
          .where('entity').equals('TASK_ITEM')
          .and(item => item.type === 'DELETE')
          .toArray();
        const pendingTaskItemDeleteIds = new Set(pendingTaskItemDeletes.map(i => i.entityId));
```

Then modify the `taskListsToPut` filter (line 171-177) to also exclude pending deletes:

```typescript
        const taskListsToPut: LocalTaskList[] = serverTaskLists
          .filter((tl: { id: string }) => !dirtyIds.has(tl.id) && !pendingTaskListDeleteIds.has(tl.id))
          .map((tl: Omit<LocalTaskList, 'ownership' | 'syncStatus'>) => ({
            ...tl,
            ownership: 'owned' as const,
            syncStatus: 'synced' as const,
          }));
```

Then modify the `toDeleteIds` filter (line 182-184) to also exclude pending deletes:

```typescript
        const toDeleteIds = allLocalSynced
          .filter(tl => !serverIds.has(tl.id) && !pendingTaskListDeleteIds.has(tl.id))
          .map(tl => tl.id);
```

Finally, filter task items through pending deletes when syncing items (around line 197):

```typescript
        for (const tl of taskListsToPut) {
          if (tl.items && tl.items.length > 0) {
            const itemsToPut = tl.items
              .filter((item: { id: string }) => !pendingTaskItemDeleteIds.has(item.id))
              .map((item: Omit<LocalTaskItem, 'syncStatus'>) => ({
                ...item,
                syncStatus: 'synced' as const,
              }));
            await db.taskItems.bulkPut(itemsToPut);
          }
        }
```

**IMPORTANT:** Also add `db.syncQueue` to the transaction tables list at line 167:

```typescript
      await db.transaction('rw', db.taskLists, db.taskItems, db.syncQueue, async () => {
```

**Step 2: Build and verify**

Run:
```bash
cd frontend && npm run build
```
Expected: No TypeScript errors.

**Step 3: Commit**

```bash
git add frontend/src/features/sync/syncService.ts
git commit -m "fix: add zombie prevention for task lists and items in syncPull"
```

---

### Task 3: Centralized logout handler

**Files:**
- Create: `frontend/src/lib/queryClient.ts`
- Modify: `frontend/src/main.tsx:9-16` (extract QueryClient)
- Modify: `frontend/src/store/authStore.ts:72` (enhance logout)

**Step 1: Extract QueryClient to shared module**

Create `frontend/src/lib/queryClient.ts`:
```typescript
import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

export default queryClient;
```

**Step 2: Update main.tsx to import from shared module**

In `frontend/src/main.tsx`, replace lines 3 and 9-16 with:
```typescript
import { QueryClientProvider } from '@tanstack/react-query'
// ... (other imports)
import queryClient from './lib/queryClient'
```

Remove the `const queryClient = new QueryClient(...)` block entirely (lines 9-16).

**Step 3: Enhance logout in authStore.ts**

In `frontend/src/store/authStore.ts`, add imports and enhance the logout function:

Add at top:
```typescript
import queryClient from '../lib/queryClient';
import { useVaultStore } from './vaultStore';
```

Replace line 72 (`logout: () => set({ user: null, token: null }),`) with:
```typescript
    logout: () => {
      set({ user: null, token: null });
      // Clear vault state (prevent PIN leak between sessions)
      useVaultStore.getState().resetVault();
      // Invalidate all cached API data
      queryClient.clear();
    },
```

**Step 4: Build and verify**

Run:
```bash
cd frontend && npm run build
```
Expected: No TypeScript errors.

**Step 5: Commit**

```bash
git add frontend/src/lib/queryClient.ts frontend/src/main.tsx frontend/src/store/authStore.ts
git commit -m "fix: centralize logout handler — clear vault, invalidate QueryClient cache"
```

---

### Task 4: Add security headers middleware

**Files:**
- Modify: `backend/src/app.ts:39` (add hook before CORS)

**Step 1: Add security headers hook**

In `backend/src/app.ts`, add the following AFTER the CORS registration (line 44) and BEFORE JWT registration (line 46):

```typescript
// Security headers
server.addHook('onSend', (request, reply, payload, done) => {
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-XSS-Protection', '1; mode=block');
  done();
});
```

**Step 2: Build and verify**

Run:
```bash
cd backend && npm run build
```
Expected: No TypeScript errors.

**Step 3: Commit**

```bash
git add backend/src/app.ts
git commit -m "fix: add security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy)"
```

---

### Task 5: Fix health endpoint — register route with DB check

**Files:**
- Modify: `backend/src/app.ts:200-203` (remove inline health), `backend/src/app.ts:107+` (add route import)

**Step 1: Import and register healthRoutes**

In `backend/src/app.ts`, add an import at the top (alongside other route imports):

```typescript
import healthRoutes from './routes/health';
```

Then add the route registration in the Routes section (around line 128, after the last `server.register`):

```typescript
server.register(healthRoutes, { prefix: '/api' });
```

**Step 2: Remove inline health endpoint**

Remove lines 200-203:
```typescript
// Health Check
server.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});
```

**Step 3: Update health route path**

In `backend/src/routes/health.ts`, change the route path from `/health` to just `/health` but since we're registering with prefix `/api`, the full path will be `/api/health`. If external monitors hit `/health` directly, we need the route at root level instead. Change the registration:

Actually, register WITHOUT prefix to keep `/health` at root:
```typescript
server.register(healthRoutes);
```

**Step 4: Build and verify**

Run:
```bash
cd backend && npm run build
```
Expected: No errors. The health check is now at `/health` with DB validation.

**Step 5: Commit**

```bash
git add backend/src/app.ts
git commit -m "fix: use health route with DB check, remove duplicate inline endpoint"
```

---

### Task 6: Add axios request timeout

**Files:**
- Modify: `frontend/src/lib/api.ts:4-6`

**Step 1: Add timeout to axios config**

In `frontend/src/lib/api.ts`, change lines 4-6 from:
```typescript
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001/api',
});
```
to:
```typescript
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001/api',
  timeout: 30000, // 30 seconds — prevents app hang on slow/dead connections
});
```

**Step 2: Build and verify**

Run:
```bash
cd frontend && npm run build
```

**Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "fix: add 30s request timeout to axios to prevent app hang on slow networks"
```

---

### Task 7: Align backend version to 1.7.3

**Files:**
- Modify: `backend/package.json:3`

**Step 1: Update version**

In `backend/package.json`, change:
```json
"version": "1.6.4",
```
to:
```json
"version": "1.7.3",
```

**Step 2: Commit**

```bash
git add backend/package.json
git commit -m "chore: align backend version to 1.7.3 (match frontend)"
```

---

## Build & Deploy Verification

After all tasks are committed:

```bash
# Backend build
cd backend && npm run build

# Frontend build
cd ../frontend && npm run build

# Rebuild deploy packages
cd ..
rm -f _deploy/backend.zip _deploy/frontend.zip
cd backend && powershell -Command "Compress-Archive -Path dist, prisma, package.json, package-lock.json, prisma.config.js, .env -DestinationPath ../_deploy/backend.zip -Force"
cd ../frontend && powershell -Command "Compress-Archive -Path dist -DestinationPath ../_deploy/frontend.zip -Force"
```

## Files Changed Summary

| File | Change Type | Task |
|------|------------|------|
| `backend/prisma/schema.prisma` | Modify | T1 |
| `backend/prisma/migrations/...` | Create | T1 |
| `frontend/src/features/sync/syncService.ts` | Modify | T2 |
| `frontend/src/lib/queryClient.ts` | Create | T3 |
| `frontend/src/main.tsx` | Modify | T3 |
| `frontend/src/store/authStore.ts` | Modify | T3 |
| `backend/src/app.ts` | Modify | T4, T5 |
| `frontend/src/lib/api.ts` | Modify | T6 |
| `backend/package.json` | Modify | T7 |
