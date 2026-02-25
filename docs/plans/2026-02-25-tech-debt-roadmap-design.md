# Notiq Technical Debt Roadmap — Design Document

**Date:** 2026-02-25
**Scope:** Full codebase analysis findings (41 items, P0-P3)
**Approach:** 4 phases, each independently deployable

---

## Context

Codebase analysis on v1.6.1 identified 41 findings across 4 priority levels.
Current state: 30 Prisma models, 20 migrations, 9 enums, 12 E2E specs.
Key gap: Kanban boards (v1.4.0+) are the largest feature but lack offline sync and group sharing.

---

## Phase 1: Kanban Offline + Group Sharing (P0)

### 1A. Kanban Dexie Offline Sync

**Problem:** Kanban boards are real-time only. No offline support despite being a major feature.

**Solution:**
- Add Dexie v14 with tables: `kanbanBoards`, `kanbanColumns`, `kanbanCards`
- Extend `syncPull()` to fetch kanban entities from server
- Extend `syncPush()` to push local CRUD changes
- Add zombie prevention for all 3 kanban entity types
- Backend: new sync-specific endpoints for kanban data

**Scope limitation:** Only boards/columns/cards synced offline. Comments, chat, activity, reminders are real-time by nature and excluded.

**Files impacted (TIER 1):**
- `frontend/src/lib/db.ts` — New Dexie version 14
- `frontend/src/features/sync/syncService.ts` — syncPull + syncPush extensions
- `backend/src/routes/sync.ts` or `kanban.ts` — New sync endpoints

**Pattern:** Follow TaskList sync implementation (Dexie v13) as reference.

### 1B. Kanban + TaskList Group Sharing

**Problem:** Kanban boards and TaskLists only support individual email sharing. Notes and Notebooks support group sharing. Inconsistent UX.

**Solution:**
- Backend: `POST /api/share/kanban/:id/group` (mirror notes/notebooks pattern)
- Backend: `POST /api/share/tasklists/:id/group` (same)
- Frontend: Add group picker dropdown to `ShareBoardModal.tsx` and `TaskListSharingModal.tsx`
- Reuse existing `getGroupsForSharing()` (already fixed in v1.6.1 to include member groups)

**Files impacted:**
- `backend/src/services/sharing.service.ts` — New functions
- `backend/src/routes/sharing.ts` — New endpoints
- `frontend/src/features/kanban/components/ShareBoardModal.tsx` — Group picker UI
- `frontend/src/features/tasks/TaskListSharingModal.tsx` — Group picker UI
- `frontend/src/locales/en.json`, `it.json` — i18n keys

---

## Phase 2: Security & Data Integrity (P1)

### 2A. Database Indexes

**Problem:** Missing indexes cause performance degradation at scale.

**Indexes to add:**
- `GroupMember`: `@@index([userId])` — reverse lookups
- `KanbanBoardChat`: `@@index([boardId, createdAt])` — pagination
- `AuditLog`: `@@index([userId, createdAt])` — user audit trails
- `Notification`: `@@index([createdAt])` — recent notifications

**Impact:** Single Prisma migration, no code changes.

### 2B. Hocuspocus WebSocket Auth

**Problem:** WebSocket connections may not verify user has access to the note.

**Solution:** Validate JWT + note ownership in Hocuspocus `onAuthenticate` hook.

**Files impacted (TIER 1):** `backend/src/hocuspocus.ts`

### 2C. Quick Security Fixes

| Fix | File | Change |
|-----|------|--------|
| lastActiveAt error logging | `app.ts` | Add `logger.warn` in catch |
| Invite locale | `invite.service.ts` | Read user locale from DB |
| Kanban write permissions | `routes/kanban.ts` | Audit + add explicit checks |
| FRONTEND_URL hard fail | `email.service.ts` | Throw if not set in production |

---

## Phase 3: Quality & Testing (P1+P2)

### 3A. E2E Tests for Kanban

New `frontend/e2e/kanban.spec.ts` covering:
- Board CRUD (create, rename, delete)
- Column management (add, reorder, delete)
- Card CRUD (create, move, assign, due date)
- Board sharing + acceptance
- Note linking with auto-share

### 3B. Backend `any` Type Cleanup

Replace ~170 `any` usages with proper types:
- Create typed error interfaces
- Use `unknown` + type guards
- Focus on high-risk: `kanban.service.ts`, `sharing.service.ts`, `routes/*.ts`

### 3C. Rate Limiting Per-Route

| Route group | Limit | Scope |
|-------------|-------|-------|
| Auth (login, register, reset) | 5 req/min | Per IP |
| Sharing | 10 req/min | Per user |
| Upload | 3 req/min | Per user |

### 3D. Vault KDF Migration

Replace direct PIN-as-key with PBKDF2:
- Generate random salt per user (stored in vaultStore)
- Derive key via PBKDF2(PIN, salt, 100000 iterations)
- Migration: re-encrypt on first unlock with new key
- **TIER 1 risk:** Must preserve backward compatibility

### 3E. Sharing Modal Unification

Merge 3 separate modals into one:
- `SharingModal.tsx` (notes)
- `NotebookSharingModal.tsx`
- `TaskListSharingModal.tsx`
→ Single `SharingModal.tsx` with `entityType: 'NOTE' | 'NOTEBOOK' | 'TASK_LIST' | 'KANBAN_BOARD'`

---

## Phase 4: Backlog & Polish (P2+P3)

### 4A. Schema Improvements
- Add `isTrashed Boolean @default(false)` to KanbanCard (soft delete)
- Kanban column default titles: use enum keys, let frontend i18n translate
- Remove unused Attachment fields (version, hash, isLatest) or document future use

### 4B. Lint & Type Cleanup
- Run ESLint `--fix` for auto-fixable issues
- Manual fix for remaining ~106 errors (no-explicit-any, no-unused-vars)

### 4C. Backend Unit Tests
- Setup vitest with test database
- Test suites for: auth.service, sharing.service, kanban.service, notification.service

### 4D. Chat Model Normalization (Optional)
- Evaluate unifying ChatMessage + KanbanBoardChat into polymorphic model
- Only if benefits outweigh migration complexity

---

## Decisions & Trade-offs

1. **Kanban offline is read-heavy:** Sync focuses on CRUD, not real-time collab (SSE/drag-drop). Those remain online-only.
2. **Group sharing covers all 4 entities** after this work: Notes, Notebooks, TaskLists, KanbanBoards.
3. **Vault KDF is backward-compatible:** Old vaults re-encrypted on first unlock, no data loss.
4. **Chat normalization is optional:** Only worth doing if schema complexity becomes a maintenance burden.
5. **Each phase is independently deployable** with its own version bump and deploy package.

---

## Phase → Version Mapping

| Phase | Version | Content |
|-------|---------|---------|
| Phase 1 | v1.7.0 | Kanban offline + group sharing |
| Phase 2 | v1.7.1 | Security fixes + indexes |
| Phase 3 | v1.8.0 | Testing + quality + vault KDF |
| Phase 4 | v1.8.1 | Polish + backlog |
