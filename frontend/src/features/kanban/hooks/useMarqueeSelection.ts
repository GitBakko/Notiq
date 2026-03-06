import { useCallback, useEffect, useRef, useState } from 'react';

interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseMarqueeSelectionOptions {
  containerEl: HTMLElement | null;
  enabled?: boolean;
}

interface UseMarqueeSelectionReturn {
  selectedCardIds: Set<string>;
  marqueeRect: MarqueeRect | null;
  menuPosition: { x: number; y: number } | null;
  clearSelection: () => void;
}

const MIN_DRAG_DISTANCE = 5;

const IGNORED_SELECTORS = [
  '[data-kanban-card]',
  '[data-dnd-handle]',
  'button',
  'input',
  'textarea',
  '[role="dialog"]',
];

function isIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  return IGNORED_SELECTORS.some(
    (sel) => target.matches(sel) || target.closest(sel) !== null
  );
}

function rectsIntersect(a: MarqueeRect, b: DOMRect): boolean {
  return (
    a.x < b.right &&
    a.x + a.width > b.left &&
    a.y < b.bottom &&
    a.y + a.height > b.top
  );
}

function computeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): MarqueeRect {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

function getIntersectedCardIds(rect: MarqueeRect): Set<string> {
  const ids = new Set<string>();
  const cards = document.querySelectorAll<HTMLElement>('[data-kanban-card]');
  for (const card of cards) {
    const cardRect = card.getBoundingClientRect();
    if (rectsIntersect(rect, cardRect)) {
      const id = card.getAttribute('data-kanban-card');
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function useMarqueeSelection({
  containerEl,
  enabled = true,
}: UseMarqueeSelectionOptions): UseMarqueeSelectionReturn {
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(
    () => new Set()
  );
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const isDrawingRef = useRef(false);
  const startPointRef = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);

  const clearSelection = useCallback(() => {
    setSelectedCardIds(new Set());
    setMarqueeRect(null);
    setMenuPosition(null);
    isDrawingRef.current = false;
    hasDraggedRef.current = false;
  }, []);

  // Desktop-only check
  const isDesktop =
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: fine)').matches;

  useEffect(() => {
    if (!enabled || !isDesktop || !containerEl) return;

    const container = containerEl;

    const handleMouseDown = (e: MouseEvent) => {
      // Left button only
      if (e.button !== 0) return;
      if (isIgnoredTarget(e.target)) return;

      e.preventDefault(); // Prevent text selection while drawing marquee
      isDrawingRef.current = true;
      hasDraggedRef.current = false;
      startPointRef.current = { x: e.clientX, y: e.clientY };

      // Clear previous selection when starting a new drag
      setSelectedCardIds(new Set());
      setMenuPosition(null);
      setMarqueeRect(null);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault(); // Prevent text selection during drag

      const dx = e.clientX - startPointRef.current.x;
      const dy = e.clientY - startPointRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < MIN_DRAG_DISTANCE) return;

      hasDraggedRef.current = true;

      const rect = computeRect(
        startPointRef.current.x,
        startPointRef.current.y,
        e.clientX,
        e.clientY
      );
      setMarqueeRect(rect);

      const ids = getIntersectedCardIds(rect);
      setSelectedCardIds(ids);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      setMarqueeRect(null);

      if (!hasDraggedRef.current) return;

      const rect = computeRect(
        startPointRef.current.x,
        startPointRef.current.y,
        e.clientX,
        e.clientY
      );
      const ids = getIntersectedCardIds(rect);
      setSelectedCardIds(ids);

      if (ids.size > 0) {
        setMenuPosition({ x: e.clientX, y: e.clientY });
      } else {
        setMenuPosition(null);
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, isDesktop, containerEl]);

  // Escape key listener — only active when there are selections
  useEffect(() => {
    if (selectedCardIds.size === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedCardIds.size, clearSelection]);

  return {
    selectedCardIds,
    marqueeRect,
    menuPosition,
    clearSelection,
  };
}
