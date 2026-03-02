# Notiq Codebase Audit — Full Report & Evolution Plan

**Date:** 2026-03-02
**Scope:** Full-stack TypeScript monorepo (~27,000 LOC)
**Method:** 5 parallel analysis agents covering backend, frontend, database/sync, testing, architecture/infra

## Executive Summary

The app is at a **solid maturity state**. Security posture is excellent (JWT+tokenVersion, Zod on all routes, IDOR protection). TypeScript quality is strong (0 `any` in production backend). i18n is comprehensive (1246 keys, EN/IT aligned). PWA is complete.

**Key risks:** Missing CASCADE deletes (orphan data), incomplete zombie prevention in sync, logout state leaks, zero security headers, 73% of backend services untested.

## Evolution Plan — 6 Phases

### Phase 0: Critical Stabilization (Week 1)
- CASCADE on Notebook→Note
- Zombie prevention for all entities in sync
- Centralized logout handler
- Security headers
- Axios timeout
- Version alignment

### Phase 1: Sync & Offline Hardening (Weeks 2-3)
- Shared kanban boards in syncPull
- Content pull strategy
- TAG UPDATE sync
- FK fixes on schema
- Dexie v15

### Phase 2: Architectural Refactoring (Weeks 4-6)
- Custom error types
- Split kanban.service.ts
- Split KanbanBoardPage + EditorToolbar
- uiStore migration to persist()
- queryKeys factory

### Phase 3: Testing Foundation (Weeks 7-10)
- Sync engine tests
- Kanban service tests
- Group service tests
- E2E collaboration, groups, import

### Phase 4: Performance & Bundle (Weeks 11-12)
- Lazy-load Yjs, @dnd-kit, recharts
- Route-based code splitting
- React.memo on list items
- Bundle analyzer

### Phase 5: Monitoring & Production (Weeks 13-14)
- Prometheus metrics
- Sentry integration
- Per-route rate limiting
- HSTS + CSP

### Phase 6: Accessibility & Polish (Week 15)
- aria-labels on 40+ buttons
- Keyboard navigation
- Hardcoded strings → i18n
