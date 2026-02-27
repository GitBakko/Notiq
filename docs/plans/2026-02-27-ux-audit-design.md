# UX Audit — Full Mobile + Desktop Design

**Date:** 2026-02-27
**Branch:** `feature/ux-audit-mobile-desktop`
**Approach:** B — Foundation + Fixes (build reusable components, then apply everywhere)

---

## Phase 1: Foundations

### 1.1 Safe Areas (PWA notch/gesture bar support)

**Problem:** No `viewport-fit=cover` or `env(safe-area-inset-*)` CSS. Content renders under system bars on iPhone (notch/Dynamic Island) and Android gesture bar.

**Changes:**
- `frontend/index.html`: add `viewport-fit=cover` to meta viewport
- `frontend/src/components/layout/AppLayout.tsx`: add `padding-top: env(safe-area-inset-top)`, `padding-bottom: env(safe-area-inset-bottom)` to main layout
- Mobile sidebar: respect `safe-area-inset-left`
- Editor/chat input areas: respect `safe-area-inset-bottom`

### 1.2 BottomSheet Component

**Problem:** All modals are centered — unnatural for mobile confirmations, menus, sharing.

**New file:** `frontend/src/components/ui/BottomSheet.tsx`
- Mobile (`< md`): slide-up from bottom, drag handle, `rounded-t-2xl`, `max-h-[85vh]`, dark overlay, swipe-down to close
- Desktop (`>= md`): falls back to standard centered Modal (zero desktop impact)
- Props: `isOpen`, `onClose`, `title`, `children`, `snapPoints?`
- Consumers: ConfirmDialog, SharingModal, SharedUsersModal, InputDialog (on mobile)

### 1.3 Skeleton Component

**Problem:** Lists show only spinners or nothing during loading.

**New file:** `frontend/src/components/ui/Skeleton.tsx`
- Variants: `text`, `circle`, `card`, `list-item`
- `animate-pulse` with gradient
- Composable: `<Skeleton.List count={5} />`

### 1.4 Touch Targets

**Problem:** Many icon buttons are 36px, below WCAG 44px minimum.

**Changes:**
- `Button.tsx`: size `icon` from `h-9 w-9` → `h-10 w-10` (40px)
- `EditorToolbar.tsx`: `min-w-[36px] min-h-[36px]` → `min-w-[40px] min-h-[40px]` on mobile, `sm:min-w-[36px] sm:min-h-[36px]` on desktop
- Sidebar nav items: add `min-h-[44px]` on mobile

---

## Phase 2: Editor Mobile

### 2.1 Two-Level Toolbar

**Problem:** ~30 toolbar buttons in a single wrapping row. On mobile this becomes 3-4 rows of icons taking too much vertical space.

**Mobile (`< md`):**
- **Primary row (always visible):** Bold, Italic, Underline, List, Link, Undo, Redo + "..." expand button
- **Secondary row (expandable):** alignment, strikethrough, code, quote, font family/size, line height, table, emoji, speech-to-text, encrypted block
- "..." toggles expansion (ChevronDown/ChevronUp icon)
- Secondary row: horizontal scroll (`overflow-x-auto`) if needed

**Desktop (`>= md`):** unchanged, current wrapping layout stays.

### 2.2 Toolbar Sticky Above Virtual Keyboard

**Problem:** `sticky top-0` toolbar stays at the top when virtual keyboard opens — far from typing area.

**New hook:** `frontend/src/hooks/useVisualViewport.ts`
- Listens to `window.visualViewport` resize/scroll events
- When keyboard opens (viewport height decreases): toolbar repositions to bottom, just above keyboard
- Transition: `sticky top-0` → `fixed bottom-[keyboardHeight]`
- Fallback: if `visualViewport` unsupported, keep `sticky top-0`

### 2.3 Link Insertion Fix

**Problem:** `window.prompt('URL')` is ugly and problematic on mobile.

**Solution:** Replace with inline mini-dialog below toolbar (small popover with URL input + Confirm/Cancel buttons). Reuses InputDialog pattern but positioned contextually.

### 2.4 Table Selector Fix

**Problem:** `group-hover:block` doesn't work on touch.

**Solution:** Mobile: click toggles table selector (state-based). `group-hover:block` only on desktop via `md:group-hover:block`.

---

## Phase 3: Kanban Mobile

### 3.1 Single-Column View with Tab Navigation

**Problem:** 280px columns with horizontal scroll. Hard to navigate, DnD cross-column nearly impossible on touch.

**Mobile (`< md`):**
- One column visible at a time, full-width
- Horizontal tab bar at top with column names (scrollable if >3 columns)
- Active tab: emerald underline + bold font
- Card count per column visible in tab: `To Do (3)`
- Cards fill full width

**Desktop (`>= md`):** multi-column layout unchanged.

### 3.2 Compact Filter Bar on Mobile

**Problem:** KanbanFilterBar has too many controls in a row for mobile.

**Mobile solution:**
- Collapse to a single `Filter` button with active filter count badge
- Tap opens BottomSheet (from Phase 1) with all filters laid out vertically
- Search stays always visible above column tabs

### 3.3 Chat Sidebar Mobile

**Problem:** `BoardChatSidebar` is `w-80` fixed — covers entire screen on mobile without optimization.

**Mobile solution:**
- Chat becomes full-screen overlay with header and back button (ArrowLeft)
- Chat input respects `safe-area-inset-bottom`

---

## Phase 4: Polish (Desktop + Accessibility)

### 4.1 aria-label Audit

**Problem:** Many icon-only buttons (X close, Trash, Share, Sort, Theme toggle) lack `aria-label`.

**Systematic addition of `aria-label={t('...')}` to:**
- All close buttons (X) in modals and sidebar
- Action buttons (Trash2, Share2, Pencil, Plus) in sidebar and lists
- Theme toggle, logout, notification bell in sidebar footer
- Toolbar editor buttons (already have `title`, add `aria-label` too)
- Drag handles: add `aria-roledescription="draggable"`

### 4.2 Focus Trap on Modals

**Problem:** When modal is open, Tab navigates outside to elements under overlay.

**Solution:** Add focus trap to `Dialog.tsx` and `Modal.tsx`:
- Lightweight custom implementation (no new dependency): intercept Tab/Shift+Tab, cycle through focusable elements inside modal
- Auto-focus first interactive element on open
- Restore focus to previous element on close

### 4.3 Skeleton Loading on Lists

**Apply Skeleton component (Phase 1) to:**
- **NoteList:** 5 skeleton cards (title + 2 text lines + date)
- **TaskListsPage:** 3 skeleton task list cards
- **KanbanPage:** 3 skeleton board cards (responsive grid)
- **GroupsPage:** 2 skeleton group cards
- **SharedWithMePage:** skeleton tabs + skeleton list items

### 4.4 Form Validation Inline

**Problem:** Login, Register, sharing forms show errors only in a generic block at top.

**Solution:**
- Errors below specific field: `<p className="text-red-500 text-xs mt-1">{error}</p>`
- Red border on error field: `ring-red-500` instead of `ring-gray-300`
- Apply to: LoginPage, RegisterPage, ForgotPasswordPage, SharingModal (email field)
- Pattern: `fieldErrors: Record<string, string>` state with pre-submit validation

### 4.5 Hover-Only Fixes

**Problem:** Some interactions are hover-only — notebook actions, table selector.

**Fixes:**
- Table selector: `group-hover:block` → click toggle on mobile (see Phase 2.4)
- Notebook actions on mobile: show MoreVertical (`...`) button always visible for share/delete (long-press already handles rename)

### 4.6 GPU-Only Animation Audit

**Verify no animations use `height`, `width`, `top`, `left` — only `transform` and `opacity`.**
- Sidebar slide: `translate-x` ✅
- Modal open: `zoom-in-95` + `fade-in` ✅
- BottomSheet (new): `translate-y` ✅
- No critical fixes expected.

---

## Files Impact Summary

### New Files
| File | Purpose |
|------|---------|
| `components/ui/BottomSheet.tsx` | Mobile bottom sheet (falls back to Modal on desktop) |
| `components/ui/Skeleton.tsx` | Loading skeleton variants |
| `hooks/useVisualViewport.ts` | Virtual keyboard detection for editor toolbar |

### Modified Files (by phase)

**Phase 1 (Foundations):**
- `index.html` — viewport-fit=cover
- `components/layout/AppLayout.tsx` — safe area padding
- `components/ui/Button.tsx` — icon size bump
- `components/editor/EditorToolbar.tsx` — touch target sizes

**Phase 2 (Editor):**
- `components/editor/EditorToolbar.tsx` — two-level toolbar, link dialog, table click
- `components/editor/Editor.tsx` — integrate useVisualViewport

**Phase 3 (Kanban):**
- `features/kanban/KanbanBoardPage.tsx` — single-column mobile view + tab nav
- `features/kanban/components/KanbanFilterBar.tsx` — compact mobile filter
- `features/kanban/components/BoardChatSidebar.tsx` — fullscreen mobile overlay

**Phase 4 (Polish):**
- `components/ui/Dialog.tsx` — focus trap
- `components/ui/Modal.tsx` — focus trap
- `components/layout/Sidebar.tsx` — aria-labels, mobile action menu
- `features/notes/NoteList.tsx` — skeleton loading
- `features/tasks/TaskListsPage.tsx` — skeleton loading
- `features/kanban/KanbanPage.tsx` — skeleton loading
- `features/groups/GroupsPage.tsx` — skeleton loading
- `features/auth/LoginPage.tsx` — inline validation
- `features/auth/RegisterPage.tsx` — inline validation
- `locales/en.json` + `locales/it.json` — new i18n keys

### i18n Keys Needed
- `editor.expandToolbar` / `editor.collapseToolbar`
- `editor.linkUrl` / `editor.linkConfirm` / `editor.linkCancel`
- `kanban.mobile.filterButton` / `kanban.mobile.filterCount`
- `common.close` / `common.back`
- `aria.*` labels for icon buttons
- Skeleton/loading text keys if needed
