# UX Audit — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve Notiq's mobile UX and desktop accessibility across editor, kanban, and shared components.

**Architecture:** Build 3 reusable foundation components (BottomSheet, Skeleton, useVisualViewport hook), then apply mobile-first improvements to editor toolbar, kanban board, and polish with accessibility/loading fixes. Desktop behavior is preserved via `md:` breakpoint guards.

**Tech Stack:** React 19, TailwindCSS 3, TipTap v2, clsx, react-i18next, lucide-react

**Branch:** `feature/ux-audit-mobile-desktop`

---

## Phase 1: Foundations

### Task 1: Safe Areas — viewport-fit and CSS padding

**Files:**
- Modify: `frontend/index.html` (line 5, meta viewport)
- Modify: `frontend/src/components/layout/AppLayout.tsx` (line 42, root div)
- Modify: `frontend/src/index.css` (add safe-area utility classes)

**Step 1: Add viewport-fit=cover to index.html**

In `frontend/index.html`, change the meta viewport from:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```
to:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

**Step 2: Add safe-area CSS utilities to index.css**

At the bottom of `frontend/src/index.css`, add:
```css
/* Safe Area Utilities for PWA (notch, Dynamic Island, gesture bar) */
.safe-area-top {
  padding-top: env(safe-area-inset-top);
}
.safe-area-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}
.safe-area-left {
  padding-left: env(safe-area-inset-left);
}
.safe-area-right {
  padding-right: env(safe-area-inset-right);
}
```

**Step 3: Apply safe-area padding to AppLayout**

In `frontend/src/components/layout/AppLayout.tsx`, line 42, change:
```tsx
<div className="flex h-screen bg-white dark:bg-gray-900 overflow-hidden">
```
to:
```tsx
<div className="flex h-screen bg-white dark:bg-gray-900 overflow-hidden safe-area-top safe-area-bottom">
```

Also, on the mobile sidebar overlay close button (line 61), add safe area:
```tsx
<button
  onClick={closeSidebar}
  className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 safe-area-top"
>
```

**Step 4: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors.

**Step 5: Commit**

```bash
git add frontend/index.html frontend/src/index.css frontend/src/components/layout/AppLayout.tsx
git commit -m "feat(ux): add PWA safe-area support for notch and gesture bar"
```

---

### Task 2: BottomSheet Component

**Files:**
- Create: `frontend/src/components/ui/BottomSheet.tsx`

**Step 1: Create the BottomSheet component**

Create `frontend/src/components/ui/BottomSheet.tsx`:

```tsx
import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import clsx from 'clsx';
import { useIsMobile } from '../../hooks/useIsMobile';
import Modal from './Modal';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export default function BottomSheet({ isOpen, onClose, title, children, size = 'md' }: BottomSheetProps) {
  const isMobile = useIsMobile();
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const currentTranslateY = useRef(0);

  // Desktop: delegate to standard Modal
  if (!isMobile) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title || ''} size={size}>
        {children}
      </Modal>
    );
  }

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent background scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Touch drag-to-dismiss handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    currentTranslateY.current = 0;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const deltaY = e.touches[0].clientY - dragStartY.current;
    if (deltaY < 0) return; // Only allow dragging down
    currentTranslateY.current = deltaY;
    sheetRef.current.style.transform = `translateY(${deltaY}px)`;
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!sheetRef.current) return;
    // If dragged more than 100px down, close
    if (currentTranslateY.current > 100) {
      onClose();
    }
    // Reset position
    sheetRef.current.style.transform = '';
    dragStartY.current = null;
    currentTranslateY.current = 0;
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-900',
          'rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col',
          'safe-area-bottom',
          'transition-transform duration-300 ease-out',
        )}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag Handle */}
        <div className="flex justify-center py-3 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
        </div>

        {/* Title */}
        {title && (
          <div className="px-4 pb-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add frontend/src/components/ui/BottomSheet.tsx
git commit -m "feat(ux): add BottomSheet component (mobile bottom sheet, desktop Modal fallback)"
```

---

### Task 3: Skeleton Component

**Files:**
- Create: `frontend/src/components/ui/Skeleton.tsx`

**Step 1: Create the Skeleton component**

Create `frontend/src/components/ui/Skeleton.tsx`:

```tsx
import clsx from 'clsx';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circle' | 'card' | 'rect';
  width?: string;
  height?: string;
}

function SkeletonBase({ className, variant = 'text', width, height }: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-pulse bg-gray-200 dark:bg-gray-700',
        variant === 'text' && 'h-4 rounded',
        variant === 'circle' && 'rounded-full',
        variant === 'card' && 'rounded-xl',
        variant === 'rect' && 'rounded-lg',
        className,
      )}
      style={{ width, height }}
    />
  );
}

/** Repeats N skeleton list items (title + subtitle + date) */
function SkeletonList({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={clsx('space-y-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-4 rounded-xl bg-white dark:bg-gray-800/50 space-y-2">
          <SkeletonBase variant="text" className="w-3/4 h-5" />
          <SkeletonBase variant="text" className="w-full h-3" />
          <SkeletonBase variant="text" className="w-1/2 h-3" />
          <SkeletonBase variant="text" className="w-1/4 h-3 mt-2" />
        </div>
      ))}
    </div>
  );
}

/** Repeats N skeleton cards in a responsive grid */
function SkeletonGrid({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={clsx('grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-4 rounded-xl bg-white dark:bg-gray-800/50 space-y-3">
          <SkeletonBase variant="text" className="w-2/3 h-5" />
          <SkeletonBase variant="text" className="w-full h-3" />
          <div className="flex items-center gap-2 mt-2">
            <SkeletonBase variant="circle" className="w-6 h-6" />
            <SkeletonBase variant="text" className="w-20 h-3" />
          </div>
        </div>
      ))}
    </div>
  );
}

const Skeleton = Object.assign(SkeletonBase, {
  List: SkeletonList,
  Grid: SkeletonGrid,
});

export default Skeleton;
```

**Step 2: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add frontend/src/components/ui/Skeleton.tsx
git commit -m "feat(ux): add Skeleton loading component with List and Grid variants"
```

---

### Task 4: Touch Target Size Bump

**Files:**
- Modify: `frontend/src/components/ui/Button.tsx` (line 18, icon size)
- Modify: `frontend/src/components/editor/EditorToolbar.tsx` (line 69, ToolbarButton min-w/min-h)

**Step 1: Bump Button icon size**

In `frontend/src/components/ui/Button.tsx`, change the `icon` size from:
```typescript
icon: 'h-9 w-9 p-0 flex items-center justify-center',
```
to:
```typescript
icon: 'h-10 w-10 p-0 flex items-center justify-center',
```

**Step 2: Bump ToolbarButton touch targets on mobile**

In `frontend/src/components/editor/EditorToolbar.tsx`, line 69, change:
```tsx
"p-2 sm:p-1.5 rounded transition-colors flex items-center justify-center min-w-[36px] min-h-[36px]",
```
to:
```tsx
"p-2 sm:p-1.5 rounded transition-colors flex items-center justify-center min-w-[40px] min-h-[40px] md:min-w-[36px] md:min-h-[36px]",
```

**Step 3: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/src/components/ui/Button.tsx frontend/src/components/editor/EditorToolbar.tsx
git commit -m "feat(ux): bump touch targets to 40px (WCAG accessible)"
```

---

## Phase 2: Editor Mobile

### Task 5: Two-Level Toolbar on Mobile

**Files:**
- Modify: `frontend/src/components/editor/EditorToolbar.tsx` (refactor toolbar layout)

**Step 1: Add mobile expand/collapse state and split toolbar into two rows**

At the top of the `EditorToolbar` component function (around line 185 where state is declared), add:
```tsx
const [isToolbarExpanded, setIsToolbarExpanded] = useState(false);
const isMobile = useIsMobile();
```

And add the import:
```tsx
import { useIsMobile } from '../../hooks/useIsMobile';
import { ChevronDown, ChevronUp } from 'lucide-react';
```

**Step 2: Wrap the toolbar return**

Replace the toolbar's outer `<div>` (line 238) wrapping pattern. The current single `flex-wrap` div becomes:

```tsx
<div className="border-b border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-800 sticky top-0 z-10">
  {/* Online Users — always visible */}
  {users.length > 0 && (
    <div className="flex -space-x-2 px-2 pt-2 border-b border-gray-100 dark:border-gray-800 pb-2">
      {/* ...existing users rendering... */}
    </div>
  )}

  {/* Primary toolbar row — always visible */}
  <div className="flex gap-1 p-2 items-center overflow-visible flex-wrap">
    {/* Bold, Italic, Underline, BulletList, OrderedList, Link, Undo, Redo */}
    {/* On mobile: + expand/collapse button */}
  </div>

  {/* Secondary toolbar row — hidden on mobile unless expanded, always visible on desktop */}
  {(isToolbarExpanded || !isMobile) && (
    <div className={clsx(
      "flex gap-1 px-2 pb-2 items-center",
      isMobile ? "overflow-x-auto" : "flex-wrap overflow-visible"
    )}>
      {/* Speech-to-text, Voice memo, Encrypted block, Emoji, Font family, Font size, Line height */}
      {/* Strikethrough, Code, Alignments, Blockquote, Table */}
    </div>
  )}
</div>
```

The primary row on mobile should contain: Bold, Italic, Underline, BulletList, OrderedList, Link, Undo, Redo, and an expand button:
```tsx
{isMobile && (
  <ToolbarButton
    onClick={() => setIsToolbarExpanded(!isToolbarExpanded)}
    title={isToolbarExpanded ? t('editor.collapseToolbar') : t('editor.expandToolbar')}
  >
    {isToolbarExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
  </ToolbarButton>
)}
```

On desktop (`!isMobile`), all buttons render in the same wrapping row as before — no behavioral change.

**Step 3: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/src/components/editor/EditorToolbar.tsx
git commit -m "feat(ux): two-level editor toolbar on mobile with expand/collapse"
```

---

### Task 6: useVisualViewport Hook

**Files:**
- Create: `frontend/src/hooks/useVisualViewport.ts`

**Step 1: Create the hook**

Create `frontend/src/hooks/useVisualViewport.ts`:

```tsx
import { useState, useEffect } from 'react';

interface VisualViewportState {
  /** True when virtual keyboard is likely open (viewport height decreased significantly) */
  isKeyboardOpen: boolean;
  /** Height of the keyboard in pixels (0 when closed) */
  keyboardHeight: number;
}

/**
 * Detects virtual keyboard open/close via window.visualViewport API.
 * Falls back to { isKeyboardOpen: false, keyboardHeight: 0 } when unsupported.
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>({
    isKeyboardOpen: false,
    keyboardHeight: 0,
  });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const fullHeight = window.innerHeight;

    function handleResize() {
      if (!vv) return;
      const currentHeight = vv.height;
      const diff = fullHeight - currentHeight;
      // Consider keyboard open if viewport shrunk by more than 150px
      const isOpen = diff > 150;
      setState({
        isKeyboardOpen: isOpen,
        keyboardHeight: isOpen ? diff : 0,
      });
    }

    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  return state;
}
```

**Step 2: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add frontend/src/hooks/useVisualViewport.ts
git commit -m "feat(ux): add useVisualViewport hook for virtual keyboard detection"
```

---

### Task 7: Integrate useVisualViewport into Editor Toolbar

**Files:**
- Modify: `frontend/src/components/editor/EditorToolbar.tsx` (toolbar positioning)

**Step 1: Import and use the hook**

At the top of `EditorToolbar` component, add:
```tsx
import { useVisualViewport } from '../../hooks/useVisualViewport';
```

Inside the component:
```tsx
const { isKeyboardOpen, keyboardHeight } = useVisualViewport();
```

**Step 2: Conditionally change toolbar positioning**

Change the toolbar's outer `<div>` classes to:

```tsx
<div
  className={clsx(
    "border-b border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-800 z-10",
    isMobile && isKeyboardOpen
      ? "fixed left-0 right-0 shadow-lg"
      : "sticky top-0"
  )}
  style={isMobile && isKeyboardOpen ? { bottom: `${keyboardHeight}px` } : undefined}
>
```

This moves the toolbar from `sticky top-0` to `fixed` at the bottom, just above the keyboard, on mobile when the keyboard opens.

**Step 3: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/src/components/editor/EditorToolbar.tsx
git commit -m "feat(ux): reposition editor toolbar above virtual keyboard on mobile"
```

---

### Task 8: Replace window.prompt for Link Insertion

**Files:**
- Modify: `frontend/src/components/editor/EditorToolbar.tsx` (link button handler, ~line 473-481)

**Step 1: Add link popover state**

Inside the EditorToolbar component, add state:
```tsx
const [showLinkInput, setShowLinkInput] = useState(false);
const [linkUrl, setLinkUrl] = useState('');
const linkInputRef = useRef<HTMLInputElement>(null);
```

**Step 2: Replace window.prompt with inline popover**

Replace the link button's `onClick` (around line 473):
```tsx
onClick={() => {
  const previousUrl = editor.getAttributes('link').href;
  setLinkUrl(previousUrl || '');
  setShowLinkInput(true);
}}
```

**Step 3: Add the inline link input popover after the link button**

After the link ToolbarButton, add:
```tsx
{showLinkInput && (
  <div className="absolute left-0 right-0 top-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 mx-2 z-20 flex items-center gap-2">
    <input
      ref={linkInputRef}
      type="url"
      value={linkUrl}
      onChange={(e) => setLinkUrl(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (linkUrl.trim()) {
            editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl.trim() }).run();
          } else {
            (editor.chain().focus().extendMarkRange('link') as any).unsetLink().run();
          }
          setShowLinkInput(false);
          setLinkUrl('');
        }
        if (e.key === 'Escape') {
          setShowLinkInput(false);
          setLinkUrl('');
          editor.commands.focus();
        }
      }}
      placeholder={t('editor.linkUrl')}
      className="flex-1 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-sm text-gray-900 dark:text-white outline-none focus:border-emerald-500"
      autoFocus
    />
    <button
      onClick={() => {
        if (linkUrl.trim()) {
          editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl.trim() }).run();
        } else {
          (editor.chain().focus().extendMarkRange('link') as any).unsetLink().run();
        }
        setShowLinkInput(false);
        setLinkUrl('');
      }}
      className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 transition-colors flex-shrink-0"
    >
      {t('editor.linkConfirm')}
    </button>
    <button
      onClick={() => {
        setShowLinkInput(false);
        setLinkUrl('');
        editor.commands.focus();
      }}
      className="px-2 py-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-sm flex-shrink-0"
    >
      {t('editor.linkCancel')}
    </button>
  </div>
)}
```

The outer toolbar div needs `relative` added to its className for the popover to position correctly.

**Step 4: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add frontend/src/components/editor/EditorToolbar.tsx
git commit -m "feat(ux): replace window.prompt with inline link input popover"
```

---

### Task 9: Table Selector Touch Fix

**Files:**
- Modify: `frontend/src/components/editor/EditorToolbar.tsx` (table selector, ~line 500-530)

**Step 1: Add table selector toggle state**

Add state inside EditorToolbar:
```tsx
const [showTableSelector, setShowTableSelector] = useState(false);
```

**Step 2: Replace group-hover with state-based toggle**

Find the table selector area (around line 500). The current pattern uses `group-hover:block`.

Change the table button wrapper to:
```tsx
<div className="relative">
  <ToolbarButton
    onClick={() => setShowTableSelector(!showTableSelector)}
    title={t('editor.insertTable')}
  >
    <Table size={18} />
  </ToolbarButton>
  {showTableSelector && (
    <div className="absolute top-full left-0 mt-1 z-20">
      {/* ...existing table size grid... */}
    </div>
  )}
</div>
```

Add a click-outside handler via useEffect or by detecting a click on the overlay to close the table selector.

**Step 3: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/src/components/editor/EditorToolbar.tsx
git commit -m "fix(ux): table selector works on touch via click toggle instead of hover"
```

---

### Task 10: i18n Keys for Phase 1-2

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add all new i18n keys to en.json**

In the `editor` section of `en.json`, add:
```json
"expandToolbar": "More tools",
"collapseToolbar": "Fewer tools",
"linkUrl": "Enter URL...",
"linkConfirm": "Apply",
"linkCancel": "Cancel",
"insertTable": "Insert table"
```

In the `common` section, verify `close` and `back` exist (they already do per the file read).

**Step 2: Add the same keys to it.json**

In the `editor` section of `it.json`, add:
```json
"expandToolbar": "Altri strumenti",
"collapseToolbar": "Meno strumenti",
"linkUrl": "Inserisci URL...",
"linkConfirm": "Applica",
"linkCancel": "Annulla",
"insertTable": "Inserisci tabella"
```

**Step 3: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(i18n): add editor toolbar i18n keys (EN + IT)"
```

---

## Phase 3: Kanban Mobile

### Task 11: Single-Column Mobile View with Tab Navigation

**Files:**
- Modify: `frontend/src/features/kanban/KanbanBoardPage.tsx` (board content area, ~line 816-880)

**Step 1: Add mobile active column state**

Inside KanbanBoardPage, after the `filters` state (line 112), add:
```tsx
const [mobileActiveColumnIndex, setMobileActiveColumnIndex] = useState(0);
```

**Step 2: Add mobile column tab bar**

Before the board content `<div className="flex-1 overflow-x-auto overflow-y-hidden">` (line 817), when `isMobile`, render a tab bar:

```tsx
{/* Mobile column tabs */}
{isMobile && displayColumns.length > 0 && (
  <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 overflow-x-auto">
    <div className="flex">
      {displayColumns.map((col, index) => (
        <button
          key={col.id}
          onClick={() => setMobileActiveColumnIndex(index)}
          className={clsx(
            'flex-shrink-0 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap',
            index === mobileActiveColumnIndex
              ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          )}
        >
          {col.title} ({col.cards.length})
        </button>
      ))}
    </div>
  </div>
)}
```

**Step 3: Conditionally render single column on mobile**

Replace the board content area. On mobile, show only the active column full-width. On desktop, keep the existing multi-column horizontal scroll:

```tsx
{/* Board content */}
{isMobile ? (
  // Mobile: single column, full width
  <div className="flex-1 overflow-y-auto p-4">
    {displayColumns[mobileActiveColumnIndex] && (
      <KanbanColumn
        key={displayColumns[mobileActiveColumnIndex].id}
        column={displayColumns[mobileActiveColumnIndex]}
        boardId={boardId}
        onCardSelect={(cardId) => setSelectedCardId(cardId)}
        onRenameColumn={handleRenameColumn}
        onDeleteColumn={handleDeleteColumn}
        onAddCard={handleAddCard}
        readOnly={readOnly || filtersActive}
        highlightedCardIds={highlightedCardIds}
        fullWidth
      />
    )}
  </div>
) : (
  // Desktop: existing multi-column layout with DnD
  <div className="flex-1 overflow-x-auto overflow-y-hidden">
    <DndContext ...existing props...>
      {/* ...existing column rendering... */}
    </DndContext>
  </div>
)}
```

Note: The `DndContext` wrapping should remain only around the desktop layout. On mobile, we skip cross-column DnD since it's impractical on touch.

**Step 4: Ensure mobileActiveColumnIndex stays in bounds**

Add a useEffect to clamp the index when columns change:
```tsx
useEffect(() => {
  if (mobileActiveColumnIndex >= displayColumns.length && displayColumns.length > 0) {
    setMobileActiveColumnIndex(displayColumns.length - 1);
  }
}, [displayColumns.length, mobileActiveColumnIndex]);
```

**Step 5: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add frontend/src/features/kanban/KanbanBoardPage.tsx
git commit -m "feat(ux): kanban single-column mobile view with tab navigation"
```

---

### Task 12: Compact Filter Bar on Mobile

**Files:**
- Modify: `frontend/src/features/kanban/components/KanbanFilterBar.tsx` (mobile layout)

**Step 1: Import dependencies**

Add to imports:
```tsx
import { useIsMobile } from '../../../hooks/useIsMobile';
import { Filter } from 'lucide-react';
import BottomSheet from '../../../components/ui/BottomSheet';
```

**Step 2: Add mobile state and isMobile**

Inside the component:
```tsx
const isMobile = useIsMobile();
const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
```

**Step 3: Render compact mobile filter bar**

Wrap the return statement to show different layouts:

```tsx
if (isMobile) {
  const activeCount = [
    filters.assigneeIds.length > 0,
    filters.dueDate !== 'all',
    filters.hasNote !== 'all',
    filters.hasComments !== 'all',
  ].filter(Boolean).length;

  return (
    <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 px-4 py-2">
      <div className="flex items-center gap-2">
        {/* Search — always visible */}
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={14} />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
            placeholder={t('kanban.filters.searchPlaceholder')}
            className="w-full pl-8 pr-7 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-emerald-500 dark:focus:border-emerald-400 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none transition-colors"
          />
          {filters.search && (
            <button onClick={() => updateFilter('search', '')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={12} />
            </button>
          )}
        </div>

        {/* Filter button */}
        <button
          onClick={() => setIsFilterSheetOpen(true)}
          className={clsx(
            'relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
            active
              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
          )}
        >
          <Filter size={14} />
          {t('kanban.filters.title')}
          {activeCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-emerald-600 text-white">
              {activeCount}
            </span>
          )}
        </button>

        {/* Export button */}
        <button onClick={onExport} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title={t('kanban.filters.exportGantt')}>
          <Download size={14} />
        </button>
      </div>

      {/* Filter BottomSheet */}
      <BottomSheet isOpen={isFilterSheetOpen} onClose={() => setIsFilterSheetOpen(false)} title={t('kanban.filters.title')}>
        <div className="space-y-4">
          {/* Assignee filters */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kanban.filters.assignee')}</h4>
            <div className="space-y-2">
              {/* ...render assignee checkboxes vertically... */}
            </div>
          </div>

          {/* Due date filters */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kanban.filters.dueDate')}</h4>
            <div className="space-y-2">
              {dueDateOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateFilter('dueDate', opt.value)}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                    filters.dueDate === opt.value
                      ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                  )}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Has Note / Has Comments toggles */}
          {/* ...vertical layout with buttons... */}

          {/* Clear filters */}
          {active && (
            <button
              onClick={() => onFiltersChange(defaultKanbanFilters)}
              className="w-full py-2.5 text-sm font-medium text-red-600 dark:text-red-400 rounded-lg border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              {t('kanban.filters.clearAll')}
            </button>
          )}
        </div>
      </BottomSheet>
    </div>
  );
}

// Desktop: existing layout unchanged
return (
  <div className="flex-shrink-0 border-b ...">
    {/* ...existing desktop filter bar... */}
  </div>
);
```

**Step 4: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add frontend/src/features/kanban/components/KanbanFilterBar.tsx
git commit -m "feat(ux): compact kanban filter bar on mobile with BottomSheet"
```

---

### Task 13: Fullscreen Chat on Mobile

**Files:**
- Modify: `frontend/src/features/kanban/components/BoardChatSidebar.tsx`

**Step 1: Import useIsMobile**

Add:
```tsx
import { useIsMobile } from '../../../hooks/useIsMobile';
import { ArrowLeft } from 'lucide-react';
```

**Step 2: Add mobile detection inside component**

```tsx
const isMobile = useIsMobile();
```

**Step 3: Render fullscreen overlay on mobile**

Change the root `<div>` rendering. On mobile, use a fixed fullscreen overlay:

```tsx
if (!isOpen) return null;

const chatContent = (
  <>
    {/* Messages */}
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {/* ...existing messages rendering... */}
    </div>

    {/* Input */}
    <div className={clsx("px-4 py-3 border-t border-gray-200 dark:border-gray-700", isMobile && "safe-area-bottom")}>
      {/* ...existing input rendering... */}
    </div>
  </>
);

if (isMobile) {
  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 flex flex-col">
      {/* Mobile Header with back button */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 safe-area-top">
        <button
          onClick={onClose}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          aria-label={t('common.back')}
        >
          <ArrowLeft size={20} />
        </button>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {chatTitle}
        </h3>
      </div>
      {chatContent}
    </div>
  );
}

// Desktop: existing sidebar layout
return (
  <div className="w-80 flex-shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col h-full">
    {/* ...existing desktop header... */}
    {chatContent}
  </div>
);
```

**Step 4: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add frontend/src/features/kanban/components/BoardChatSidebar.tsx
git commit -m "feat(ux): fullscreen chat overlay on mobile with back button"
```

---

### Task 14: i18n Keys for Phase 3

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add kanban mobile i18n keys to en.json**

In the `kanban.filters` section:
```json
"title": "Filters",
"clearAll": "Clear all filters"
```

**Step 2: Add the same to it.json**

```json
"title": "Filtri",
"clearAll": "Rimuovi tutti i filtri"
```

**Step 3: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(i18n): add kanban mobile filter i18n keys (EN + IT)"
```

---

## Phase 4: Polish (Desktop + Accessibility)

### Task 15: aria-label Audit

**Files:**
- Modify: `frontend/src/components/ui/Modal.tsx` (close button)
- Modify: `frontend/src/components/ui/Dialog.tsx` (close button)
- Modify: `frontend/src/components/layout/AppLayout.tsx` (mobile sidebar close)
- Modify: `frontend/src/components/layout/Sidebar.tsx` (action buttons)

**Step 1: Add aria-labels to Modal close button**

In `frontend/src/components/ui/Modal.tsx`, find the close button `<button onClick={onClose}` and add:
```tsx
aria-label={t('common.close')}
```

Import `useTranslation`:
```tsx
import { useTranslation } from 'react-i18next';
```

And inside the component:
```tsx
const { t } = useTranslation();
```

**Step 2: Add aria-labels to Dialog close button**

Same pattern in `frontend/src/components/ui/Dialog.tsx`.

**Step 3: Add aria-label to AppLayout mobile sidebar close**

In `frontend/src/components/layout/AppLayout.tsx`, the mobile close button (line 61):
```tsx
<button
  onClick={closeSidebar}
  aria-label={t('common.close')}
  className="..."
>
```

**Step 4: Add aria-labels to Sidebar action buttons**

In `frontend/src/components/layout/Sidebar.tsx`, add `aria-label` to:
- Theme toggle button
- Logout button
- New note button
- Delete notebook buttons
- Share notebook buttons

Pattern: `aria-label={t('sidebar.theme')}`, `aria-label={t('sidebar.logout')}`, etc.

**Step 5: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add frontend/src/components/ui/Modal.tsx frontend/src/components/ui/Dialog.tsx frontend/src/components/layout/AppLayout.tsx frontend/src/components/layout/Sidebar.tsx
git commit -m "feat(a11y): add aria-labels to all icon-only buttons"
```

---

### Task 16: Focus Trap on Modals

**Files:**
- Create: `frontend/src/hooks/useFocusTrap.ts`
- Modify: `frontend/src/components/ui/Modal.tsx`
- Modify: `frontend/src/components/ui/Dialog.tsx`

**Step 1: Create useFocusTrap hook**

Create `frontend/src/hooks/useFocusTrap.ts`:

```tsx
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps focus within the given container element.
 * Auto-focuses the first focusable element on mount.
 * Restores focus to the previously focused element on unmount.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, isActive: boolean): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    // Save current focus
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus first focusable element
    const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length > 0) {
      focusable[0].focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !containerRef.current) return;

      const focusableEls = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusableEls.length === 0) return;

      const first = focusableEls[0];
      const last = focusableEls[focusableEls.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    };
  }, [isActive, containerRef]);
}
```

**Step 2: Integrate into Modal.tsx**

In `frontend/src/components/ui/Modal.tsx`, add:
```tsx
import { useFocusTrap } from '../../hooks/useFocusTrap';
```

Add a ref to the modal content div and call the hook:
```tsx
const modalRef = useRef<HTMLDivElement>(null);
useFocusTrap(modalRef, isOpen);
```

Apply `ref={modalRef}` to the modal's inner content `<div>`.

**Step 3: Integrate into Dialog.tsx**

Same pattern in `frontend/src/components/ui/Dialog.tsx`.

**Step 4: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add frontend/src/hooks/useFocusTrap.ts frontend/src/components/ui/Modal.tsx frontend/src/components/ui/Dialog.tsx
git commit -m "feat(a11y): add focus trap to Modal and Dialog components"
```

---

### Task 17: Skeleton Loading on Lists

**Files:**
- Modify: `frontend/src/features/notes/NoteList.tsx` (or parent page loading state)
- Modify: `frontend/src/features/tasks/TaskListsPage.tsx`
- Modify: `frontend/src/features/kanban/KanbanPage.tsx`
- Modify: `frontend/src/features/groups/GroupsPage.tsx`

**Step 1: Replace spinner in NoteList's parent with Skeleton**

Find where NoteList receives data (NotesPage). When `isLoading` is true, render:
```tsx
import Skeleton from '../../components/ui/Skeleton';

// In loading state:
<Skeleton.List count={5} />
```

**Step 2: Replace spinner in TaskListsPage**

Find the loading state in TaskListsPage and replace with:
```tsx
<Skeleton.Grid count={3} />
```

**Step 3: Replace spinner in KanbanPage (board list)**

Find the loading state in KanbanPage and replace with:
```tsx
<Skeleton.Grid count={3} />
```

**Step 4: Replace spinner in GroupsPage**

Find the loading state in GroupsPage and replace with:
```tsx
<Skeleton.List count={2} />
```

**Step 5: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add frontend/src/features/notes/ frontend/src/features/tasks/TaskListsPage.tsx frontend/src/features/kanban/KanbanPage.tsx frontend/src/features/groups/GroupsPage.tsx
git commit -m "feat(ux): skeleton loading on note, task, kanban, and group lists"
```

---

### Task 18: Inline Form Validation

**Files:**
- Modify: `frontend/src/features/auth/LoginPage.tsx`
- Modify: `frontend/src/features/auth/RegisterPage.tsx`

**Step 1: Add field-level errors to LoginPage**

Replace the single `error` state with field-level validation:

```tsx
const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

// Pre-submit validation
function validate(): boolean {
  const errors: Record<string, string> = {};
  if (!email.trim()) errors.email = t('auth.errors.emailRequired');
  if (!password) errors.password = t('auth.errors.passwordRequired');
  setFieldErrors(errors);
  return Object.keys(errors).length === 0;
}
```

In `handleSubmit`, call `validate()` first:
```tsx
if (!validate()) return;
```

On API error, set the general error and also field-specific if applicable.

**Step 2: Add inline error display below each field**

Below each input field:
```tsx
{fieldErrors.email && (
  <p className="text-red-500 text-xs mt-1">{fieldErrors.email}</p>
)}
```

And add conditional `ring-red-500` on the input:
```tsx
className={clsx(
  "relative block w-full ...",
  fieldErrors.email && "ring-red-500"
)}
```

**Step 3: Apply same pattern to RegisterPage**

Same `fieldErrors` pattern for email, password, and name fields.

**Step 4: Verify the build compiles**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add frontend/src/features/auth/LoginPage.tsx frontend/src/features/auth/RegisterPage.tsx
git commit -m "feat(ux): inline form validation on Login and Register pages"
```

---

### Task 19: i18n Keys for Phase 4

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add aria and validation i18n keys to en.json**

```json
"sidebar": {
  "theme": "Toggle theme",
  "logout": "Log out",
  "newNote": "New note",
  "newNotebook": "New notebook",
  "deleteNotebook": "Delete notebook",
  "shareNotebook": "Share notebook"
}
```

In `auth.errors`:
```json
"emailRequired": "Email is required",
"passwordRequired": "Password is required",
"nameRequired": "Name is required"
```

**Step 2: Add the same to it.json**

```json
"sidebar": {
  "theme": "Cambia tema",
  "logout": "Esci",
  "newNote": "Nuova nota",
  "newNotebook": "Nuovo taccuino",
  "deleteNotebook": "Elimina taccuino",
  "shareNotebook": "Condividi taccuino"
}
```

In `auth.errors`:
```json
"emailRequired": "Email obbligatoria",
"passwordRequired": "Password obbligatoria",
"nameRequired": "Nome obbligatorio"
```

**Step 3: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/it.json
git commit -m "feat(i18n): add aria-label and validation i18n keys (EN + IT)"
```

---

### Task 20: Final Build Verification + Summary Commit

**Step 1: Run full build**

```bash
cd frontend && npm run build
```
Expected: Build succeeds with no errors.

**Step 2: Run lint**

```bash
cd frontend && npm run lint
```
Expected: No new lint errors introduced.

**Step 3: Create a summary commit if any loose changes remain**

If any files were not yet committed:
```bash
git add -A
git commit -m "feat(ux): UX audit phase 1-4 complete — mobile + accessibility improvements"
```

---

## Summary

| Task | Phase | What |
|------|-------|------|
| 1 | 1 | Safe areas (viewport-fit, CSS utilities, AppLayout) |
| 2 | 1 | BottomSheet component (mobile bottom sheet, desktop Modal fallback) |
| 3 | 1 | Skeleton component (List and Grid variants) |
| 4 | 1 | Touch target size bump (Button icon, ToolbarButton) |
| 5 | 2 | Two-level editor toolbar on mobile |
| 6 | 2 | useVisualViewport hook |
| 7 | 2 | Integrate useVisualViewport into toolbar |
| 8 | 2 | Replace window.prompt with inline link input |
| 9 | 2 | Table selector touch fix |
| 10 | 2 | i18n keys for Phase 1-2 |
| 11 | 3 | Kanban single-column mobile view with tabs |
| 12 | 3 | Compact filter bar on mobile with BottomSheet |
| 13 | 3 | Fullscreen chat overlay on mobile |
| 14 | 3 | i18n keys for Phase 3 |
| 15 | 4 | aria-label audit on icon buttons |
| 16 | 4 | Focus trap on Modal and Dialog |
| 17 | 4 | Skeleton loading on all list pages |
| 18 | 4 | Inline form validation (Login + Register) |
| 19 | 4 | i18n keys for Phase 4 |
| 20 | 4 | Final build verification |
