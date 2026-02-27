# Notiq Technical Debt Roadmap — Design Document

**Date:** 2026-02-25 (original) | **Updated:** 2026-02-27
**Baseline:** v1.6.9 — full codebase re-audit
**Scope:** 34 active items (7 resolved since original analysis), P0-P3
**Approach:** 4 phases, each independently deployable

---

## Context

Original codebase analysis on v1.6.1 identified 41 findings across 4 priority levels.
Re-audit on v1.6.9 confirms 7 items resolved, 3 new items discovered, 34 active.

**Current state:** 30 Prisma models, 21 migrations, 10 enums, 12 E2E specs.
**Key gap:** Kanban boards (v1.4.0+) are the largest feature but lack offline sync and group sharing.

### Resolved since v1.6.1

| Item | Resolution | Version |
|------|-----------|---------|
| Hocuspocus WebSocket auth (was 2B) | JWT + note ownership validated in `onAuthenticate` | Already present |
| Kanban write permissions (was 2C) | All 17 mutation endpoints enforce WRITE permission | Already present |
| TaskList group sharing (was 1B partial) | Full group picker UI in TaskListSharingModal | v1.6.5 |
| Card priority system | KanbanCardPriority enum (5 levels), UI + backend | v1.6.9 |
| Tiered notification delivery | SSE → push → email cascade via lastActiveAt check | v1.6.9 |
| User email notification preference | `emailNotificationsEnabled` field on User model | v1.6.9 |
| Comment/move notifications | KANBAN_COMMENT_ADDED, KANBAN_CARD_MOVED notification types | v1.6.9 |

---

## Phase 1: Kanban Offline + Group Sharing (P0)

### 1A. Kanban Dexie Offline Sync

**Problem:** Kanban boards are real-time only. No offline support despite being the largest feature (8 models, SSE, comments, activity).

**Solution:**
- Add Dexie v14 with tables: `kanbanBoards`, `kanbanColumns`, `kanbanCards`
- Extend `syncPull()` to fetch kanban entities from server
- Extend `syncPush()` to push local CRUD changes
- Add zombie prevention for all 3 kanban entity types
- Backend: new sync-specific endpoints for kanban data

**Scope limitation:** Only boards/columns/cards synced offline. Comments, chat, activity, reminders, SSE presence are real-time by nature and excluded.

**Files impacted (TIER 1):**
- `frontend/src/lib/db.ts` — New Dexie version 14
- `frontend/src/features/sync/syncService.ts` — syncPull + syncPush extensions
- `backend/src/routes/sync.ts` or `kanban.ts` — New sync endpoints

**Pattern:** Follow TaskList sync implementation (Dexie v13) as reference.

### 1B. Kanban Board Group Sharing

**Problem:** Kanban boards only support individual email sharing. Notes, Notebooks, and TaskLists all support group sharing. Inconsistent UX.

**Status update:** TaskList group sharing was completed in v1.6.5. Only Kanban boards remain.

**Solution:**
- Backend: `POST /api/share/kanban/:id/group` (mirror notes/notebooks/tasklists pattern)
- Frontend: Add group picker dropdown to `ShareBoardModal.tsx`
- Reuse existing `getGroupsForSharing()` (already fixed in v1.6.1 to include member groups)

**Files impacted:**
- `backend/src/services/sharing.service.ts` — New `shareKanbanBoardWithGroup()` function
- `backend/src/routes/sharing.ts` — New endpoint
- `frontend/src/features/kanban/components/ShareBoardModal.tsx` — Group picker UI
- `frontend/src/locales/en.json`, `it.json` — i18n keys

---

## Phase 2: Security & Data Integrity (P1)

### 2A. Database Indexes

**Problem:** Missing indexes cause performance degradation at scale.

**Indexes to add (3 confirmed missing):**
- `GroupMember`: `@@index([userId])` — reverse lookups for group membership
- `KanbanBoardChat`: `@@index([boardId, createdAt])` — chat pagination
- `AuditLog`: `@@index([userId, createdAt])` — user audit trails

**Note:** Notification table already has adequate indexes (`@@index([userId, isRead])`). Removed from original list.

**Impact:** Single Prisma migration, no code changes.

### 2B. Rate Limiting Fix

**Problem:** Global rate limiting is **disabled** (`global: false` in app.ts). Only 4 auth endpoints (login, register, forgot-password, reset-password) have per-route limits. All other routes — sharing, uploads, kanban CRUD, AI chat — are unprotected.

**Root cause:** Behind IIS ARR reverse proxy, `request.ip` always returns the proxy IP (all clients appear as one). Rate limiting per-IP was ineffective → disabled.

**Fix:** Add `trustProxy: true` to Fastify config. IIS ARR already forwards `X-Forwarded-For` headers. With `trustProxy`, Fastify reads the real client IP from `X-Forwarded-For`, making per-IP rate limiting work correctly behind the proxy.

```ts
const server = fastify({
  logger: true,
  trustProxy: true  // reads X-Forwarded-For from IIS ARR
});
```

**Solution (after trustProxy fix):**

| Route group | Limit | Scope |
|-------------|-------|-------|
| Auth (login, register, reset) | 5 req/min | Per IP (already done) |
| Sharing | 10 req/min | Per user |
| Upload | 3 req/min | Per user |
| AI chat | 5 req/min | Per user |
| General API | 60 req/min | Per IP (global) |

**Files impacted:**

- `backend/src/app.ts` — Add `trustProxy: true`, re-enable global rate limiter
- `backend/src/routes/sharing.ts`, `kanban.ts`, `ai.ts` — Per-route overrides where needed

### 2C. Quick Security Fixes

| Fix | File | Change | Status |
|-----|------|--------|--------|
| lastActiveAt error logging | `app.ts` | Replace `.catch(() => {})` with `logger.warn` | **Pending** |
| Invite locale | `invite.service.ts` | Read user locale from DB | **Pending** |
| FRONTEND_URL hard fail | `email.service.ts` | Throw if not set in production (currently warns only) | **Pending** |
| ai.ts Zod validation | `routes/ai.ts` | Add Zod schema to POST body (only route missing it) | **New** |
| ~~Kanban write permissions~~ | ~~`routes/kanban.ts`~~ | ~~All 17 endpoints already enforce WRITE~~ | **Resolved** |
| ~~Hocuspocus WebSocket auth~~ | ~~`hocuspocus.ts`~~ | ~~JWT + note access validated~~ | **Resolved** |

---

## Phase 3: Quality & Testing (P1+P2)

### 3A. E2E Tests for Kanban

**Problem:** 12 E2E specs exist (notes, auth, vault, tasks, etc.) but zero for Kanban — the largest feature.

New `frontend/e2e/kanban.spec.ts` covering:
- Board CRUD (create, rename, delete)
- Column management (add, reorder, delete)
- Card CRUD (create, move, assign, due date, priority)
- Board sharing + acceptance
- Note linking with auto-share
- Board chat (basic send/receive)

### 3B. Backend `any` Type Cleanup

**Updated count:** ~136 total (108 backend + 28 frontend `as any` casts). Down from ~170 at original audit.

Replace `any` usages with proper types:
- Create typed error interfaces (`AppError`, `PrismaError`)
- Use `unknown` + type guards for catch blocks
- Focus on high-risk files: `kanban.service.ts` (17 any), `sharing.service.ts` (12 any), `routes/*.ts` (scattered)
- Frontend: replace 28 `as any` casts across 9 files

### 3C. Vault KDF Migration

Replace direct PIN-as-key with PBKDF2:
- Generate random salt per user (stored in vaultStore)
- Derive key via PBKDF2(PIN, salt, 100000 iterations)
- Migration: re-encrypt on first unlock with new key
- **TIER 1 risk:** Must preserve backward compatibility

### 3D. Sharing Modal Unification

Merge 4 separate sharing modals into one:
- `SharingModal.tsx` (notes)
- `NotebookSharingModal.tsx`
- `TaskListSharingModal.tsx`
- `ShareBoardModal.tsx` (kanban)
→ Single `UnifiedSharingModal.tsx` with `entityType: 'NOTE' | 'NOTEBOOK' | 'TASK_LIST' | 'KANBAN_BOARD'`

**Note:** After Phase 1B adds group sharing to Kanban, all 4 entities will have identical sharing capabilities, making unification natural.

---

## Phase 4: Backlog & Polish (P2+P3)

### 4A. Schema Improvements
- Add `isTrashed Boolean @default(false)` to KanbanCard (soft delete)
- Kanban column default titles: use enum keys, let frontend i18n translate (currently hardcoded English: "To Do", "In Progress", "Done")
- Remove unused Attachment fields (version, hash, isLatest) or document future use
- Add `@@index([authorId])` to KanbanBoardChat if chat volume grows

### 4B. Lint & Type Cleanup
- Run ESLint `--fix` for auto-fixable issues
- Manual fix for remaining lint errors (no-explicit-any, no-unused-vars)
- Frontend: address 28 `as any` casts (overlap with 3B)

### 4C. Backend Unit Tests
- Currently: 4 test files only (2 unit + 2 integration) — minimal coverage
- Setup vitest with test database
- Test suites for: auth.service, sharing.service, kanban.service, notification.service

### 4D. Chat Model Normalization (Optional)
- Evaluate unifying ChatMessage + KanbanBoardChat into polymorphic model
- Both have: content, authorId, createdAt; differ in parent (noteId vs boardId)
- Only if benefits outweigh migration complexity

---

## Decisions & Trade-offs

1. **Kanban offline is read-heavy:** Sync focuses on CRUD, not real-time collab (SSE/drag-drop). Those remain online-only.
2. **Group sharing covers all 4 entities** after Phase 1B: Notes, Notebooks, TaskLists, KanbanBoards.
3. **Rate limiting elevated to P1:** Global limiter disabled is a security gap, not just quality debt.
4. **Vault KDF is backward-compatible:** Old vaults re-encrypted on first unlock, no data loss.
5. **Sharing modal unification depends on 1B:** Unify after all 4 entities have identical sharing capabilities.
6. **Chat normalization is optional:** Only worth doing if schema complexity becomes a maintenance burden.
7. **Each phase is independently deployable** with its own version bump and deploy package.

---

## Phase → Version Mapping

| Phase | Version | Content |
|-------|---------|---------|
| Phase 1 | v1.7.0 | Kanban offline + Kanban group sharing |
| Phase 2 | v1.7.1 | Rate limiting + indexes + security fixes |
| Phase 3 | v1.8.0 | E2E tests + type cleanup + vault KDF + modal unification |
| Phase 4 | v1.8.1 | Schema polish + lint + backend tests |
