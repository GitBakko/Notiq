# Note Content Persistence & Versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make destructive note-content writes impossible to lose silently — close the remaining empty-overwrite hole, harden Yjs↔content persistence, and add append-only note versioning with in-app restore.

**Architecture:** A single shared guard rejects empty-over-substantial content on every write path (REST owned, REST shared, Hocuspocus collab). Before any substantial content overwrite, the *previous* content is snapshotted into an append-only `NoteVersion` table (throttled, retained 50-or-30d). A `fetch()` integrity check stops a corrupt `ydocState` from rendering a note blank. Users restore any prior version from an in-app modal.

**Tech Stack:** Fastify 5, Prisma 7 (PostgreSQL 15), Hocuspocus v3 / Yjs, vitest (Prisma fully mocked), React 19 + TanStack Query + Axios, i18next (en/it).

---

## Context for the implementer (read once)

This plan exists because of a confirmed production data-loss incident: a personal note opened **completely blank**, and that empty state was already persisted in the DB with no rollback path. Root cause is three compounding fragilities — (1) `hocuspocus.ts fetch()` blindly prefers binary `ydocState` over good `content`, (2) two uncoordinated writers (REST + Yjs) hit `notes.content`, (3) zero version history. Two ad-hoc guards (`note.service.ts:210-223`, `hocuspocus.ts:280-292`) were added after the fact, but the **shared-note content endpoint has no guard** and **`ydocState` has no integrity check**.

**Critical-area rules (from CLAUDE.md — follow exactly):**
- `backend/prisma/schema.prisma`, `backend/src/hocuspocus.ts` are **TIER 1**. When a task modifies them, show the diff and get explicit owner confirmation before applying.
- On substantial logic changes, comment the old code with `// [BACKUP] 2026-06-10 — <reason>` before replacing. Pure additions/trivial fixes: skip the backup comment.
- All user-facing strings via `t('key')`, added to **both** `frontend/src/locales/en.json` and `it.json`.
- New UI must include `dark:` variants. Min touch target 44px. Never `window.confirm` — use `ConfirmDialog`.
- Never edit existing Dexie versions (not needed in this plan — no Dexie schema change).

**Test conventions (backend):** Prisma is mocked globally in `backend/src/__tests__/setup.ts`. Tests bind `const prismaMock = prisma as any;` and drive `prismaMock.note.findFirst.mockResolvedValue(...)`. New Prisma models must be added to the mock object in `setup.ts` or calls return `undefined`.

**Run a single backend test:** `cd backend && npx vitest run src/services/__tests__/<file>.test.ts`
**Run a single test by name:** `cd backend && npx vitest run -t "guard name"`
**Migration:** `cd backend && npx prisma migrate dev --name <name>` (reads `prisma.config.js` → needs `backend/.env`).

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `backend/src/utils/contentGuard.ts` | Pure `guardEmptyContentOverwrite()` — single source of the empty-overwrite rule | Create |
| `backend/src/utils/__tests__/contentGuard.test.ts` | Unit tests for the guard | Create |
| `backend/src/services/note.service.ts` | Use shared guard in `updateNote`; snapshot before overwrite | Modify |
| `backend/src/services/sharing.service.ts` | New `updateSharedNoteContent()` with guard | Modify |
| `backend/src/routes/sharing.ts` | Route delegates to service (no inline persistence logic) | Modify |
| `backend/src/services/noteVersion.service.ts` | Snapshot, prune, list, restore | Create |
| `backend/src/services/__tests__/noteVersion.service.test.ts` | Unit tests | Create |
| `backend/src/routes/notes.ts` | `GET /:id/versions`, `POST /:id/versions/:versionId/restore` | Modify |
| `backend/src/hocuspocus.ts` | **TIER 1** — try/catch store, shared guard, ydocState integrity, snapshot | Modify |
| `backend/prisma/schema.prisma` | **TIER 1** — `NoteVersion` model + relation | Modify |
| `backend/src/__tests__/setup.ts` | Add `noteVersion` to Prisma mock | Modify |
| `frontend/src/features/notes/noteService.ts` | `getNoteVersions`, `restoreNoteVersion` | Modify |
| `frontend/src/features/notes/VersionHistoryModal.tsx` | In-app version list + restore | Create |
| `frontend/src/features/notes/NoteEditor.tsx` | Wire modal open + button | Modify |
| `frontend/src/locales/en.json`, `it.json` | i18n keys | Modify |

---

## Task 1: Shared empty-overwrite guard helper

**Files:**
- Create: `backend/src/utils/contentGuard.ts`
- Create: `backend/src/utils/__tests__/contentGuard.test.ts`
- Modify: `backend/src/services/note.service.ts:210-232`

Extract the duplicated "don't overwrite substantial content with an empty TipTap doc" rule into one tested function, then make `updateNote` consume it (behavior unchanged).

- [ ] **Step 1: Write the failing test**

Create `backend/src/utils/__tests__/contentGuard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { guardEmptyContentOverwrite } from '../contentGuard';

const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}'; // ~46 chars
const SUBSTANTIAL = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' + 'A'.repeat(200) + '"}]}]}';

describe('guardEmptyContentOverwrite', () => {
  it('returns undefined (drop write) when new is empty and old is substantial', () => {
    expect(guardEmptyContentOverwrite(SUBSTANTIAL, EMPTY_DOC)).toBeUndefined();
  });

  it('allows the write when new content is substantial', () => {
    expect(guardEmptyContentOverwrite(EMPTY_DOC, SUBSTANTIAL)).toBe(SUBSTANTIAL);
  });

  it('allows empty->empty (no real content to protect)', () => {
    expect(guardEmptyContentOverwrite(EMPTY_DOC, EMPTY_DOC)).toBe(EMPTY_DOC);
  });

  it('allows write when old is null/missing', () => {
    expect(guardEmptyContentOverwrite(null, EMPTY_DOC)).toBe(EMPTY_DOC);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/utils/__tests__/contentGuard.test.ts`
Expected: FAIL — "Cannot find module '../contentGuard'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/utils/contentGuard.ts`:

```typescript
/**
 * Empty-overwrite guard. An empty TipTap doc serializes to ~46-93 chars
 * ({"type":"doc","content":[{"type":"paragraph"...}]}). Refuse to overwrite
 * substantial existing content with a near-empty doc — this is the class of
 * write that caused the blank-note data-loss incident (2026-06).
 *
 * @returns the content to persist, or `undefined` when the write must be dropped.
 */
const EMPTY_THRESHOLD = 150;

export function guardEmptyContentOverwrite(
  oldContent: string | null | undefined,
  newContent: string,
): string | undefined {
  const isNewEmpty = newContent.length < EMPTY_THRESHOLD;
  const isOldSubstantial = (oldContent?.length ?? 0) > EMPTY_THRESHOLD;
  if (isNewEmpty && isOldSubstantial) return undefined;
  return newContent;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/utils/__tests__/contentGuard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `updateNote` to use the helper**

In `backend/src/services/note.service.ts`, add the import near the other util imports at the top of the file:

```typescript
import { guardEmptyContentOverwrite } from '../utils/contentGuard';
```

Replace lines 210-223 (the inline guard block). Add a `// [BACKUP]` comment per the TIER-2 service rule:

```typescript
    // [BACKUP] 2026-06-10 — inline guard replaced by shared guardEmptyContentOverwrite()
    // Guard: prevent overwriting substantial content with an empty TipTap doc.
    const { content: contentField, ...restWithoutContent } = rest;
    let finalContent = contentField;
    if (contentField !== undefined) {
      finalContent = guardEmptyContentOverwrite(note.content, contentField);
    }
```

Leave lines 225-238 (searchText recompute + `tx.note.update`) unchanged.

- [ ] **Step 6: Run the existing note.service suite to confirm no regression**

Run: `cd backend && npx vitest run src/services/__tests__/note.service.test.ts`
Expected: PASS (existing `updateNote` empty-guard tests still green).

- [ ] **Step 7: Commit**

```bash
git add backend/src/utils/contentGuard.ts backend/src/utils/__tests__/contentGuard.test.ts backend/src/services/note.service.ts
git commit -m "refactor: extract shared empty-content-overwrite guard"
```

---

## Task 2: Guard the shared-note content endpoint (DL-2)

**Files:**
- Modify: `backend/src/services/sharing.service.ts` (add `updateSharedNoteContent`)
- Modify: `backend/src/routes/sharing.ts:132-175`
- Test: `backend/src/services/__tests__/sharing.service.test.ts`

The shared `/content` path (`sharing.ts:156-163`) writes content with **no guard** and nulls `ydocState`. This is the last open data-loss hole. Move logic into a tested service function and apply the guard; only null `ydocState` when the content write is actually accepted.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/services/__tests__/sharing.service.test.ts` (create the file with the standard header if it does not exist — mirror `note.service.test.ts`: import vitest, `import prisma from '../../plugins/prisma';`, `const prismaMock = prisma as any;`, mock `../../utils/extractText`):

```typescript
import { updateSharedNoteContent } from '../sharing.service';

describe('updateSharedNoteContent', () => {
  const SUBSTANTIAL = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"' + 'A'.repeat(200) + '"}]}]}';
  const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}';

  beforeEach(() => {
    prismaMock.sharedNote.findUnique.mockResolvedValue({ status: 'ACCEPTED', permission: 'WRITE' });
    prismaMock.note.findUnique.mockResolvedValue({ content: SUBSTANTIAL, title: 'Shared' });
    prismaMock.note.update.mockResolvedValue({});
  });

  it('DROPS an empty-over-substantial content write and does NOT null ydocState', async () => {
    await updateSharedNoteContent('user-2', 'note-1', { content: EMPTY_DOC });
    // update must not be called with content/ydocState (only title would, and there is none)
    expect(prismaMock.note.update).not.toHaveBeenCalled();
  });

  it('writes substantial content and nulls ydocState so fetch falls back to content', async () => {
    const newGood = SUBSTANTIAL.replace('A'.repeat(200), 'B'.repeat(200));
    await updateSharedNoteContent('user-2', 'note-1', { content: newGood });
    expect(prismaMock.note.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: newGood, ydocState: null }),
    }));
  });

  it('throws 403 when the share is not ACCEPTED+WRITE', async () => {
    prismaMock.sharedNote.findUnique.mockResolvedValue({ status: 'PENDING', permission: 'WRITE' });
    await expect(updateSharedNoteContent('user-2', 'note-1', { content: SUBSTANTIAL }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/__tests__/sharing.service.test.ts -t "updateSharedNoteContent"`
Expected: FAIL — `updateSharedNoteContent` is not exported.

- [ ] **Step 3: Write the service function**

Add to `backend/src/services/sharing.service.ts`. Reuse existing error classes already imported in that file (`ForbiddenError`/`NotFoundError` — match the file's existing imports; if it uses inline `reply.status`, instead import from `../utils/errors` like `note.service.ts` does):

```typescript
import { guardEmptyContentOverwrite } from '../utils/contentGuard';
import { ForbiddenError, NotFoundError } from '../utils/errors';

export const updateSharedNoteContent = async (
  userId: string,
  noteId: string,
  data: { content?: string; title?: string },
) => {
  const share = await prisma.sharedNote.findUnique({
    where: { noteId_userId: { noteId, userId } },
  });
  if (!share || share.status !== 'ACCEPTED' || share.permission !== 'WRITE') {
    throw new ForbiddenError('errors.sharing.forbidden');
  }

  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: { content: true, title: true },
  });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (data.content && data.content !== note.content) {
    const accepted = guardEmptyContentOverwrite(note.content, data.content);
    if (accepted !== undefined) {
      const { extractTextFromTipTapJson } = await import('../utils/extractText');
      updateData.content = accepted;
      updateData.searchText = extractTextFromTipTapJson(accepted);
      // Only null ydocState when we actually accept new content, so a dropped
      // empty write cannot also wipe the Yjs binary.
      updateData.ydocState = null;
    }
  }

  if (data.title && data.title !== note.title) {
    updateData.title = data.title;
  }

  if (Object.keys(updateData).length > 1) {
    await prisma.note.update({ where: { id: noteId }, data: updateData });
  }
  return { ok: true };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/__tests__/sharing.service.test.ts -t "updateSharedNoteContent"`
Expected: PASS (3 tests).

- [ ] **Step 5: Delegate the route to the service**

In `backend/src/routes/sharing.ts`, replace the handler body at lines 143-174 (keep the Zod param/body parsing at 133-141) with a delegating call. Add `// [BACKUP] 2026-06-10` over the removed inline block:

```typescript
    // [BACKUP] 2026-06-10 — inline persistence moved to sharingService.updateSharedNoteContent (adds empty-guard)
    try {
      return await sharingService.updateSharedNoteContent(request.user.id, noteId, { content, title });
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.status(403).send({ message: err.message });
      if (err instanceof NotFoundError) return reply.status(404).send({ message: err.message });
      throw err;
    }
```

Ensure `sharingService`, `ForbiddenError`, `NotFoundError` are imported at the top of `sharing.ts` (the file already imports `sharingService` for other routes; add the error classes from `../utils/errors` if absent).

- [ ] **Step 6: Run the route + service suites**

Run: `cd backend && npx vitest run src/routes/__tests__/sharing.route.test.ts src/services/__tests__/sharing.service.test.ts`
Expected: PASS. (If `sharing.route.test.ts` asserts the old inline behavior, update those assertions to expect the 403/404 codes the service now throws.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/sharing.service.ts backend/src/routes/sharing.ts backend/src/services/__tests__/sharing.service.test.ts
git commit -m "fix: guard shared-note content endpoint against empty-overwrite data loss"
```

---

## Task 3: Harden Hocuspocus store() — error handling + shared guard (M1-6)

**Files:**
- Modify: `backend/src/hocuspocus.ts:271-305` (**TIER 1 — show diff, get confirmation**)

`store()` has no try/catch around `prisma.note.update` (DB failure → unhandled rejection inside the extension) and the empty-guard silently `return`s. Make it use the shared guard and survive DB errors.

- [ ] **Step 1: Show the proposed diff to the owner and get confirmation (TIER 1)**

Present the Step 2 change. Wait for explicit "ok". Do not edit before confirmation.

- [ ] **Step 2: Replace the guard + wrap the update**

In `backend/src/hocuspocus.ts`, add at the import block:

```typescript
import { guardEmptyContentOverwrite } from './utils/contentGuard';
```

Replace lines 279-304 (from `// Guard: prevent...` through the `await prisma.note.update({...})`) with:

```typescript
        // [BACKUP] 2026-06-10 — inline <150 guard replaced by shared guard + try/catch
        const existing = await prisma.note.findUnique({
          where: { id: documentName },
          select: { content: true },
        });
        if (guardEmptyContentOverwrite(existing?.content, contentStr) === undefined) {
          logger.warn(
            { documentName, newLen: contentStr.length, oldLen: existing?.content?.length ?? 0 },
            'Hocuspocus store: blocked empty content overwrite',
          );
          return;
        }

        const searchText = extractTextFromTipTapJson(contentStr);

        try {
          await prisma.note.update({
            where: { id: documentName },
            data: { content: contentStr, ydocState: Buffer.from(state), searchText, updatedAt: new Date() },
          });
        } catch (err) {
          // Never let a persistence failure become an unhandled rejection inside
          // the extension — log loudly; the client keeps the edit in its Yjs doc
          // and the next change retries.
          logger.error({ err, documentName }, 'Hocuspocus store: prisma.note.update FAILED — edit not persisted');
        }
```

- [ ] **Step 3: Typecheck + build**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/hocuspocus.ts
git commit -m "fix: Hocuspocus store survives DB errors and uses shared empty-guard"
```

---

## Task 4: ydocState integrity on load + store (DL-3)

**Files:**
- Modify: `backend/src/hocuspocus.ts:232-269` (fetch) and store path (**TIER 1 — show diff, get confirmation**)

A corrupt-but-present `ydocState` makes a note render blank because `fetch()` returns it verbatim. Validate it; if it decodes to a degenerate doc while `content` is substantial, rebuild from `content` instead. Also stop `store()` from persisting a degenerate `ydocState` over good content.

- [ ] **Step 1: Add a degeneracy helper (tested in isolation)**

Create `backend/src/utils/ydocIntegrity.ts`:

```typescript
/**
 * A TipTap JSON doc is "degenerate" when it has no real text — an empty doc or
 * a single empty paragraph. Used to detect a corrupt ydocState that would render
 * a note blank.
 */
export function isDegenerateTipTapJson(json: unknown): boolean {
  if (!json || typeof json !== 'object') return true;
  const doc = json as { content?: unknown[] };
  if (!Array.isArray(doc.content) || doc.content.length === 0) return true;
  const text = JSON.stringify(doc.content);
  // No "text" leaf anywhere → no actual content.
  return !/"type"\s*:\s*"text"/.test(text);
}
```

Create `backend/src/utils/__tests__/ydocIntegrity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isDegenerateTipTapJson } from '../ydocIntegrity';

describe('isDegenerateTipTapJson', () => {
  it('flags empty doc', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [] })).toBe(true);
  });
  it('flags single empty paragraph', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
  });
  it('passes a doc with text', () => {
    expect(isDegenerateTipTapJson({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })).toBe(false);
  });
  it('flags null/garbage', () => {
    expect(isDegenerateTipTapJson(null)).toBe(true);
    expect(isDegenerateTipTapJson('nope')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `cd backend && npx vitest run src/utils/__tests__/ydocIntegrity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Show the fetch()/store() diff to the owner (TIER 1) and get confirmation**

- [ ] **Step 4: Make fetch() validate ydocState**

In `backend/src/hocuspocus.ts`, replace the `if (note.ydocState) { return new Uint8Array(note.ydocState); }` block (lines 240-243) with:

```typescript
        // If we have stored Yjs binary state, use it — but only if it decodes to
        // a non-degenerate doc. A corrupt ydocState over good content is exactly
        // what rendered notes blank (2026-06 incident); fall through to content.
        if (note.ydocState) {
          try {
            const probe = new Y.Doc();
            Y.applyUpdate(probe, new Uint8Array(note.ydocState));
            // @ts-ignore — TiptapTransformer API types incomplete
            const probeJson = TiptapTransformer.fromYdoc(probe, 'default', extensions);
            const ydocLooksEmpty = isDegenerateTipTapJson(probeJson);
            const contentSubstantial = (note.content?.length ?? 0) > 150;
            if (!(ydocLooksEmpty && contentSubstantial)) {
              return new Uint8Array(note.ydocState);
            }
            logger.warn({ documentName }, 'Hocuspocus fetch: degenerate ydocState over substantial content — rebuilding from content');
          } catch (err) {
            logger.error({ err, documentName }, 'Hocuspocus fetch: ydocState failed to decode — rebuilding from content');
          }
        }
```

Add the import at the top: `import { isDegenerateTipTapJson } from './utils/ydocIntegrity';` (`Y` and `TiptapTransformer` are already imported in this file).

- [ ] **Step 5: Guard store() against persisting a degenerate ydoc over good content**

In the `store()` change from Task 3, immediately after computing `contentStr` and `const doc = ...; Y.applyUpdate(...)`, before the empty-guard, add:

```typescript
        // Extra integrity layer: never replace a good ydocState with a degenerate one.
        // @ts-ignore — TiptapTransformer API types incomplete
        const parsedNew = (() => { try { return JSON.parse(contentStr); } catch { return null; } })();
        if (isDegenerateTipTapJson(parsedNew)) {
          const prior = await prisma.note.findUnique({ where: { id: documentName }, select: { content: true } });
          if ((prior?.content?.length ?? 0) > 150) {
            logger.warn({ documentName }, 'Hocuspocus store: degenerate doc over substantial content — skipping ydoc write');
            return;
          }
        }
```

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/utils/ydocIntegrity.ts backend/src/utils/__tests__/ydocIntegrity.test.ts backend/src/hocuspocus.ts
git commit -m "fix: validate ydocState integrity on load/store to prevent blank-note loss"
```

---

## Task 5: NoteVersion model + migration + test mock (DL-1a)

**Files:**
- Modify: `backend/prisma/schema.prisma` (**TIER 1 — show diff, get confirmation**)
- Modify: `backend/src/__tests__/setup.ts`

- [ ] **Step 1: Show the schema diff to the owner (TIER 1) and get confirmation**

- [ ] **Step 2: Add the model + relation**

In `backend/prisma/schema.prisma`, add inside the `Note` model (after the `kanbanBoards` relation line ~157):

```prisma
  versions      NoteVersion[]
```

Add the new model after the `Note` model's closing brace (after line 162):

```prisma
model NoteVersion {
  id        String   @id @default(uuid())
  noteId    String
  note      Note     @relation(fields: [noteId], references: [id], onDelete: Cascade)
  content   String
  title     String
  createdAt DateTime @default(now())

  @@index([noteId, createdAt])
}
```

- [ ] **Step 3: Generate the migration**

Run: `cd backend && npx prisma migrate dev --name add_note_version`
Expected: creates `backend/prisma/migrations/<ts>_add_note_version/` and regenerates the client. Confirm migration SQL only `CREATE TABLE "NoteVersion"` + index + FK — no destructive ALTER on `Note`.

- [ ] **Step 4: Add `noteVersion` to the Prisma test mock**

In `backend/src/__tests__/setup.ts`, inside the `mockPrisma` object (alongside `note: {...}`), add:

```typescript
    noteVersion: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
```

- [ ] **Step 5: Verify the suite still loads**

Run: `cd backend && npx vitest run src/services/__tests__/note.service.test.ts`
Expected: PASS (no behavior change yet).

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/__tests__/setup.ts
git commit -m "feat: add NoteVersion model for note content history"
```

---

## Task 6: Snapshot-before-overwrite + retention (DL-1b)

**Files:**
- Create: `backend/src/services/noteVersion.service.ts`
- Create: `backend/src/services/__tests__/noteVersion.service.test.ts`
- Modify: `backend/src/services/note.service.ts` (`updateNote`)
- Modify: `backend/src/hocuspocus.ts` store (**TIER 1 — show diff, get confirmation**)

Snapshot captures the **previous** good content *before* an overwrite, throttled to avoid one row per keystroke. Retention: keep ≤50 versions per note AND drop anything older than 30 days.

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/__tests__/noteVersion.service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { snapshotPreviousVersion, pruneNoteVersions } from '../noteVersion.service';

const prismaMock = prisma as any;
const NOW = new Date('2026-06-10T12:00:00Z').getTime();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  prismaMock.noteVersion.findFirst.mockReset();
  prismaMock.noteVersion.create.mockReset();
  prismaMock.noteVersion.deleteMany.mockReset();
  prismaMock.noteVersion.findMany.mockReset();
});

describe('snapshotPreviousVersion', () => {
  it('creates a version when there is no prior snapshot', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    await snapshotPreviousVersion(prismaMock, 'note-1', 'old content', 'Old title');
    expect(prismaMock.noteVersion.create).toHaveBeenCalledWith({
      data: { noteId: 'note-1', content: 'old content', title: 'Old title' },
    });
  });

  it('skips when the latest snapshot is younger than the throttle window', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 30_000) }); // 30s ago
    await snapshotPreviousVersion(prismaMock, 'note-1', 'old', 'T');
    expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
  });

  it('snapshots when the latest snapshot is older than the throttle window', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue({ createdAt: new Date(NOW - 5 * 60_000) }); // 5m ago
    await snapshotPreviousVersion(prismaMock, 'note-1', 'old', 'T');
    expect(prismaMock.noteVersion.create).toHaveBeenCalled();
  });

  it('does not snapshot empty/short previous content', async () => {
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    await snapshotPreviousVersion(prismaMock, 'note-1', 'x', 'T');
    expect(prismaMock.noteVersion.create).not.toHaveBeenCalled();
  });
});

describe('pruneNoteVersions', () => {
  it('deletes versions older than 30 days and beyond the 50 newest', async () => {
    prismaMock.noteVersion.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({ id: `v${i}` })),
    );
    prismaMock.noteVersion.deleteMany.mockResolvedValue({ count: 1 });
    await pruneNoteVersions(prismaMock, 'note-1');
    // first call: age-based
    expect(prismaMock.noteVersion.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ noteId: 'note-1' }) }),
    );
    // second call: count-based (ids beyond the newest 50)
    expect(prismaMock.noteVersion.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['v50'] } } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/__tests__/noteVersion.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Create `backend/src/services/noteVersion.service.ts`:

```typescript
import prisma from '../plugins/prisma';

type Db = typeof prisma;

const SNAPSHOT_THROTTLE_MS = 2 * 60 * 1000; // at most one snapshot / 2 min / note
const MAX_VERSIONS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_SNAPSHOT_LEN = 150; // don't archive empty/near-empty content

/**
 * Save the PREVIOUS content of a note as a version, BEFORE it gets overwritten.
 * Throttled per-note. Accepts a prisma client or a transaction client.
 */
export async function snapshotPreviousVersion(
  db: Db,
  noteId: string,
  previousContent: string | null | undefined,
  previousTitle: string,
): Promise<void> {
  if (!previousContent || previousContent.length < MIN_SNAPSHOT_LEN) return;

  const latest = await db.noteVersion.findFirst({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (latest && Date.now() - new Date(latest.createdAt).getTime() < SNAPSHOT_THROTTLE_MS) {
    return;
  }

  await db.noteVersion.create({
    data: { noteId, content: previousContent, title: previousTitle },
  });
  await pruneNoteVersions(db, noteId);
}

/** Retention: drop versions older than 30 days, then any beyond the newest 50. */
export async function pruneNoteVersions(db: Db, noteId: string): Promise<void> {
  await db.noteVersion.deleteMany({
    where: { noteId, createdAt: { lt: new Date(Date.now() - MAX_AGE_MS) } },
  });

  const keepNewest = await db.noteVersion.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    skip: MAX_VERSIONS,
  });
  if (keepNewest.length > 0) {
    await db.noteVersion.deleteMany({ where: { id: { in: keepNewest.map((v) => v.id) } } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/services/__tests__/noteVersion.service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire snapshot into `updateNote`**

In `backend/src/services/note.service.ts`, add the import:

```typescript
import { snapshotPreviousVersion } from './noteVersion.service';
```

Inside the `updateNote` transaction, immediately before `return tx.note.update({...})` (around line 234), snapshot the OLD content when we are accepting a real content change:

```typescript
    if (finalContent !== undefined && finalContent !== note.content) {
      await snapshotPreviousVersion(tx as unknown as typeof prisma, id, note.content, note.title);
    }
```

- [ ] **Step 6: Wire snapshot into Hocuspocus store (TIER 1 — show diff, confirm)**

In `backend/src/hocuspocus.ts` store(), in the accepted-write branch (just before the `try { await prisma.note.update(...) }` from Task 3), snapshot the prior content. Reuse the `existing` lookup from Task 3 (it already selected `content`); extend that select to include `title`:

```typescript
        // existing was fetched above with select: { content: true } — extend to title.
        await snapshotPreviousVersion(prisma, documentName, existing?.content, existing?.title ?? '');
```

Add `import { snapshotPreviousVersion } from './services/noteVersion.service';` and change the Task-3 `existing` select to `select: { content: true, title: true }`.

- [ ] **Step 7: Run note.service suite + typecheck**

Run: `cd backend && npx vitest run src/services/__tests__/note.service.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. (If `updateNote` tests now assert `noteVersion.create`, set `prismaMock.noteVersion.findFirst.mockResolvedValue(null)` in those tests' setup.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/noteVersion.service.ts backend/src/services/__tests__/noteVersion.service.test.ts backend/src/services/note.service.ts backend/src/hocuspocus.ts
git commit -m "feat: snapshot previous note content before overwrite (throttled + retained)"
```

---

## Task 7: Version list + restore endpoints (DL-1c)

**Files:**
- Modify: `backend/src/services/noteVersion.service.ts` (add `listNoteVersions`, `restoreNoteVersion`)
- Modify: `backend/src/services/__tests__/noteVersion.service.test.ts`
- Modify: `backend/src/routes/notes.ts`

- [ ] **Step 1: Write the failing service test**

Append to `backend/src/services/__tests__/noteVersion.service.test.ts`:

```typescript
import { listNoteVersions, restoreNoteVersion } from '../noteVersion.service';

describe('listNoteVersions', () => {
  it('returns versions for an owned note (newest first), without full content in the list', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1' });
    prismaMock.noteVersion.findMany.mockResolvedValue([
      { id: 'v2', title: 'B', createdAt: new Date(NOW), contentLength: 300 },
    ]);
    const out = await listNoteVersions('u1', 'note-1');
    expect(prismaMock.note.findFirst).toHaveBeenCalledWith({ where: { id: 'note-1', userId: 'u1' } });
    expect(out).toHaveLength(1);
  });

  it('throws when the note is not owned by the user', async () => {
    prismaMock.note.findFirst.mockResolvedValue(null);
    await expect(listNoteVersions('u1', 'note-1')).rejects.toThrow();
  });
});

describe('restoreNoteVersion', () => {
  it('snapshots current content, writes the version content back, and nulls ydocState', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1', content: 'C'.repeat(200), title: 'now' });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'note-1', content: 'D'.repeat(200), title: 'old' });
    prismaMock.noteVersion.findFirst.mockResolvedValue(null);
    prismaMock.note.update.mockResolvedValue({});
    await restoreNoteVersion('u1', 'note-1', 'v1');
    expect(prismaMock.note.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: 'D'.repeat(200), ydocState: null }),
    }));
  });

  it('throws when the version does not belong to the note', async () => {
    prismaMock.note.findFirst.mockResolvedValue({ id: 'note-1', userId: 'u1', content: 'x', title: 't' });
    prismaMock.noteVersion.findUnique.mockResolvedValue({ id: 'v1', noteId: 'OTHER', content: 'y', title: 't' });
    await expect(restoreNoteVersion('u1', 'note-1', 'v1')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && npx vitest run src/services/__tests__/noteVersion.service.test.ts -t "listNoteVersions"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement list + restore**

Append to `backend/src/services/noteVersion.service.ts`:

```typescript
import { extractTextFromTipTapJson } from '../utils/extractText';
import { NotFoundError } from '../utils/errors';

/** List versions of a note the user OWNS. Returns metadata + content for preview. */
export async function listNoteVersions(userId: string, noteId: string) {
  const note = await prisma.note.findFirst({ where: { id: noteId, userId } });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  return prisma.noteVersion.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, content: true, createdAt: true },
  });
}

/** Restore a version: archive current content first, then write the old content back. */
export async function restoreNoteVersion(userId: string, noteId: string, versionId: string) {
  const note = await prisma.note.findFirst({ where: { id: noteId, userId } });
  if (!note) throw new NotFoundError('errors.notes.notFound');

  const version = await prisma.noteVersion.findUnique({ where: { id: versionId } });
  if (!version || version.noteId !== noteId) throw new NotFoundError('errors.notes.versionNotFound');

  // Archive what we're about to overwrite so a restore is itself undoable.
  await snapshotPreviousVersion(prisma, noteId, note.content, note.title);

  const searchText = note.isEncrypted ? null : extractTextFromTipTapJson(version.content);
  await prisma.note.update({
    where: { id: noteId },
    // Null ydocState so the next Hocuspocus fetch rebuilds the Yjs doc from restored content.
    data: { content: version.content, title: version.title, searchText, ydocState: null, updatedAt: new Date() },
  });
  return { ok: true };
}
```

Note: `note.findFirst` returns the full row, so `note.isEncrypted` is available. If TypeScript complains the select is narrowed, change the lookup to `prisma.note.findFirst({ where: { id: noteId, userId }, select: { content: true, title: true, isEncrypted: true } })`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && npx vitest run src/services/__tests__/noteVersion.service.test.ts`
Expected: PASS (all version tests).

- [ ] **Step 5: Add routes**

In `backend/src/routes/notes.ts`, import the service near the top:

```typescript
import { listNoteVersions, restoreNoteVersion } from '../services/noteVersion.service';
```

Add two routes inside the plugin (after the `/:id/size` route ~line 90). All authenticated routes in this file already inherit `fastify.authenticate`; match the existing style (the file's routes use `request.user.id`):

```typescript
  fastify.get('/:id/versions', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return listNoteVersions(request.user.id, id);
  });

  fastify.post('/:id/versions/:versionId/restore', async (request) => {
    const { id, versionId } = z.object({
      id: z.string().uuid(),
      versionId: z.string().uuid(),
    }).parse(request.params);
    return restoreNoteVersion(request.user.id, id, versionId);
  });
```

If the file's routes are guarded individually (check `notes.ts:47-90` — they call services directly, suggesting a route-level `onRequest` is applied at registration in `app.ts`), match whatever the sibling routes do; do not leave these two unauthenticated.

- [ ] **Step 6: Add the i18n error key**

In `backend/` there is no i18n catalog (services throw keys consumed by the frontend). Add `notes.versionNotFound` to the FRONTEND catalogs in Task 8 alongside the UI keys.

- [ ] **Step 7: Typecheck + route test**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/routes/__tests__/notes.route.test.ts`
Expected: PASS. (Add a minimal inject test for `GET /:id/versions` if the route test file exists; mirror the existing `GET /:id/size` test there.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/noteVersion.service.ts backend/src/services/__tests__/noteVersion.service.test.ts backend/src/routes/notes.ts
git commit -m "feat: note version list + restore endpoints"
```

---

## Task 8: In-app version history modal (DL-1d)

**Files:**
- Modify: `frontend/src/features/notes/noteService.ts`
- Create: `frontend/src/features/notes/VersionHistoryModal.tsx`
- Modify: `frontend/src/features/notes/NoteEditor.tsx`
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/it.json`

- [ ] **Step 1: Add the frontend service functions**

In `frontend/src/features/notes/noteService.ts`, add:

```typescript
export interface NoteVersionDto {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

export const getNoteVersions = async (noteId: string): Promise<NoteVersionDto[]> => {
  const { data } = await api.get<NoteVersionDto[]>(`/notes/${noteId}/versions`);
  return data;
};

export const restoreNoteVersion = async (noteId: string, versionId: string): Promise<void> => {
  await api.post(`/notes/${noteId}/versions/${versionId}/restore`);
};
```

(`api` is already imported in this file — confirm; if not, `import api from '../../lib/api';`.)

- [ ] **Step 2: Create the modal**

Create `frontend/src/features/notes/VersionHistoryModal.tsx` (modeled on `NoteSizeModal.tsx`; uses `ConfirmDialog`; full `dark:` variants; 44px touch targets):

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, History, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getNoteVersions, restoreNoteVersion, type NoteVersionDto } from './noteService';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { formatDateTime } from '../../utils/format';

interface VersionHistoryModalProps {
  noteId: string;
  onClose: () => void;
  onRestored: () => void;
}

function plainPreview(content: string): string {
  try {
    const json = JSON.parse(content);
    const walk = (node: { text?: string; content?: unknown[] }): string => {
      if (node.text) return node.text;
      if (Array.isArray(node.content)) return node.content.map((c) => walk(c as never)).join(' ');
      return '';
    };
    return walk(json).slice(0, 160);
  } catch {
    return content.replace(/<[^>]*>/g, ' ').slice(0, 160);
  }
}

export default function VersionHistoryModal({ noteId, onClose, onRestored }: VersionHistoryModalProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<NoteVersionDto[] | null>(null);
  const [error, setError] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getNoteVersions(noteId)
      .then((v) => { if (!cancelled) setVersions(v); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [noteId]);

  const doRestore = async () => {
    if (!confirmId) return;
    setRestoring(true);
    try {
      await restoreNoteVersion(noteId, confirmId);
      toast.success(t('notes.versions.restored'));
      setConfirmId(null);
      onRestored();
    } catch {
      toast.error(t('notes.versions.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
            <History size={18} /> {t('notes.versions.title')}
          </h2>
          <button onClick={onClose} aria-label={t('common.close')}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <X size={18} />
          </button>
        </div>

        <div className="p-5">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{t('notes.versions.loadFailed')}</p>}
          {!error && versions === null && (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin text-neutral-400" /></div>
          )}
          {versions !== null && versions.length === 0 && (
            <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{t('notes.versions.empty')}</p>
          )}
          {versions !== null && versions.length > 0 && (
            <ul className="space-y-2">
              {versions.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{formatDateTime(v.createdAt)}</p>
                    <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{plainPreview(v.content) || v.title}</p>
                  </div>
                  <button onClick={() => setConfirmId(v.id)}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 px-3 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700">
                    <RotateCcw size={14} /> {t('notes.versions.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {confirmId && (
        <ConfirmDialog
          title={t('notes.versions.confirmTitle')}
          message={t('notes.versions.confirmMessage')}
          confirmLabel={t('notes.versions.restore')}
          loading={restoring}
          onConfirm={doRestore}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}
```

> Gotcha: match `ConfirmDialog`'s real prop names — open `frontend/src/components/ui/ConfirmDialog.tsx` and adapt (`confirmLabel`/`loading` may be named differently). Same for `formatDateTime` in `utils/format.ts` (use whatever date formatter exists; if none, `new Date(v.createdAt).toLocaleString()`).

- [ ] **Step 3: Wire into NoteEditor**

In `frontend/src/features/notes/NoteEditor.tsx`:

Add the import (near line 19 with `NoteSizeModal`):

```tsx
import VersionHistoryModal from './VersionHistoryModal';
```

Add state (near line 75 with `isSizeModalOpen`):

```tsx
const [isVersionsOpen, setIsVersionsOpen] = useState(false);
```

Add a trigger button in the same menu/toolbar group as the size button (mirror the `setIsSizeModalOpen(true)` button at lines ~486 and the mobile-more entry ~640), with an icon-only `aria-label`:

```tsx
<button onClick={() => setIsVersionsOpen(true)} aria-label={t('notes.versions.title')}
  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
  <History size={18} />
</button>
```

(Import `History` from `lucide-react` in NoteEditor if not already.) Render the modal next to the size modal (~line 761):

```tsx
{isVersionsOpen && (
  <VersionHistoryModal
    noteId={note.id}
    onClose={() => setIsVersionsOpen(false)}
    onRestored={() => { setIsVersionsOpen(false); window.location.reload(); }}
  />
)}
```

> Gotcha: `window.location.reload()` is the pragmatic choice for an infrequent recovery action — it forces a clean Dexie hydration and a fresh Hocuspocus `fetch()` (which now rebuilds from the restored content). A surgical refetch would risk the in-memory Yjs doc re-pushing the old content over the restore.

- [ ] **Step 4: Add i18n keys**

In `frontend/src/locales/en.json`, under the `notes` object add:

```json
"versions": {
  "title": "Version history",
  "empty": "No previous versions yet.",
  "loadFailed": "Could not load versions.",
  "restore": "Restore",
  "restored": "Version restored.",
  "restoreFailed": "Restore failed.",
  "confirmTitle": "Restore this version?",
  "confirmMessage": "The current content is saved as a new version first, so this is reversible."
},
"versionNotFound": "Version not found."
```

In `frontend/src/locales/it.json`, under `notes` add:

```json
"versions": {
  "title": "Cronologia versioni",
  "empty": "Nessuna versione precedente.",
  "loadFailed": "Impossibile caricare le versioni.",
  "restore": "Ripristina",
  "restored": "Versione ripristinata.",
  "restoreFailed": "Ripristino non riuscito.",
  "confirmTitle": "Ripristinare questa versione?",
  "confirmMessage": "Il contenuto attuale viene prima salvato come nuova versione, quindi l'operazione è reversibile."
},
"versionNotFound": "Versione non trovata."
```

(Place `versionNotFound` at the same nesting level the backend throws it — it throws `errors.notes.versionNotFound`, so put it under `errors.notes` in both catalogs, not under `notes`. Verify where `errors.notes.notFound` already lives and match that path.)

- [ ] **Step 5: Lint + typecheck the frontend**

Run: `cd frontend && npm run lint && npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/notes/noteService.ts frontend/src/features/notes/VersionHistoryModal.tsx frontend/src/features/notes/NoteEditor.tsx frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat: in-app note version history with restore"
```

---

## Task 9: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the stack**

Run: `cd backend && npm run dev` (separate terminal: `cd frontend && npm run dev`). Ensure Docker `notiq-db` is up and no other backend holds :3001.

- [ ] **Step 2: Verify versioning + restore (personal note — the incident case)**

1. Create a note, type a substantial paragraph (>150 chars), wait ~2s for sync.
2. Edit it again (different substantial text), wait.
3. Open the ⟳ history button → confirm ≥1 version listed.
4. Restore the first version → page reloads → note shows the restored content.

Expected: restored content correct; a NEW version row captured the pre-restore content (re-open history to confirm reversibility).

- [ ] **Step 3: Verify the empty-overwrite guard (shared note)**

1. Share a substantial note WRITE to a second account; accept.
2. As the recipient, select-all + delete in the editor; let it sync.
3. Reload as owner.

Expected: content NOT blanked (guard dropped the empty write); backend log shows "blocked empty content overwrite".

- [ ] **Step 4: Verify ydocState integrity rebuild**

1. On a collab note with content, manually corrupt `ydocState` via Prisma Studio (`npx prisma studio` → set `ydocState` to a 1-byte value) while `content` stays intact.
2. `pm2 restart notiq-backend` locally is not applicable in dev — restart `npm run dev`.
3. Reopen the note.

Expected: note renders from `content` (not blank); log shows "degenerate ydocState ... rebuilding from content".

- [ ] **Step 5: Run the full backend suite once**

Run: `cd backend && npm test`
Expected: all green (including new contentGuard, ydocIntegrity, noteVersion suites).

- [ ] **Step 6: Commit any test fixups; tag the milestone**

```bash
git add -A
git commit -m "test: note data-loss protection verification fixups" || echo "nothing to commit"
```

---

## Self-Review (completed by author)

- **Spec coverage:** DL-2 → Task 2. M1-6 → Task 3. DL-3 → Task 4. DL-1 (model→Task 5, snapshot/retention→Task 6, endpoints→Task 7, UI→Task 8, retention "50 OR 30d"→Task 6 `pruneNoteVersions`, in-app restore→Task 8). Shared guard extraction → Task 1. Manual verification → Task 9. ✅
- **Out of scope (separate plans):** M1-7 `ws.on('error')`, M1-8 screenshot auth, commit `recover-note.ts` (trivial standalone quick wins); DL-4 single-writer + DL-5 extension parity (Plan 2 — editor/collab wiring); CI + backup verification (Plan 0); sync surfacing/perf/polish (later plans).
- **Type consistency:** `guardEmptyContentOverwrite(old, new)→string|undefined` used identically in Tasks 1/2/3. `snapshotPreviousVersion(db, noteId, prevContent, prevTitle)` and `pruneNoteVersions(db, noteId)` consistent across Tasks 6/7. `NoteVersionDto` fields (`id,title,content,createdAt`) match the `listNoteVersions` select (Task 7) and the frontend service (Task 8). ✅
- **Known adapt-points flagged inline:** `ConfirmDialog` prop names, `formatDateTime` existence, where `errors.notes.*` keys nest, and whether `notes.ts` routes are guarded individually vs at registration. The implementer must verify these against the live files (gotchas noted at each site).

---

## Follow-up plans (not in this document)

1. **Plan 0 — CI & backup safety net:** GitHub Actions (lint + `tsc` + unit tests + build, both packages) on push/PR; verify `npm run backup` runs scheduled in prod and a restore actually works; commit & document `recover-note.ts`; guard `emergency-fix-db.ts` against non-prod.
2. **Plan 2 — Editor/collab wiring:** DL-4 (single-writer: suppress REST `saveSharedNoteData` while Hocuspocus provider is synced) + DL-5 (align `Link` and custom table-cell extensions between `Editor.tsx` and `hocuspocus.ts` so `fromYdoc` stops dropping nodes). Then the TipTap v2→v3 frontend upgrade.
3. **Plan 3 — Sync surfacing:** terminal `failed` state in syncQueue (Dexie v15, additive), UI badge + retry, prune `failureCounts`; shared-notes pending-DELETE guard; column/tag `updatedAt`; backoff jitter.
4. **Quick wins (no plan needed):** `ws.on('error')` handler + chat message rate limit; auth on `/url-metadata/screenshot`.
