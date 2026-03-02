import { useState, useCallback, useRef, useEffect } from 'react';
import type { KanbanColumn } from '../types';

interface UseBoardMobileSwipeParams {
  displayColumns: KanbanColumn[];
  isMobile: boolean;
}

/**
 * Manages mobile swipe navigation between Kanban columns:
 * - mobileActiveColumnIndex tracking
 * - Touch start/move/end handlers with smooth swipe offset
 * - Swipe transition animation state
 * - Auto-scroll tab bar to active tab
 * - Clamping index when columns change
 */
export function useBoardMobileSwipe({ displayColumns, isMobile }: UseBoardMobileSwipeParams) {
  const [mobileActiveColumnIndex, setMobileActiveColumnIndex] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwipeTransitioning, setIsSwipeTransitioning] = useState(false);

  // Refs for touch tracking
  const touchStartRef = useRef<number>(0);
  const touchDeltaRef = useRef<number>(0);
  const mobileTabBarRef = useRef<HTMLDivElement>(null);
  const mobileTabRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  // Clamp mobile active column index when columns change
  useEffect(() => {
    if (mobileActiveColumnIndex >= displayColumns.length && displayColumns.length > 0) {
      setMobileActiveColumnIndex(displayColumns.length - 1);
    }
  }, [displayColumns.length, mobileActiveColumnIndex]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!isMobile) return;
    const tabEl = mobileTabRefs.current.get(mobileActiveColumnIndex);
    if (tabEl) {
      tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [mobileActiveColumnIndex, isMobile]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = e.touches[0].clientX;
    touchDeltaRef.current = 0;
    setIsSwipeTransitioning(false);
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const delta = e.touches[0].clientX - touchStartRef.current;
      touchDeltaRef.current = delta;
      // Dampen overscroll at edges
      const atStart = mobileActiveColumnIndex === 0 && delta > 0;
      const atEnd = mobileActiveColumnIndex >= displayColumns.length - 1 && delta < 0;
      setSwipeOffset(atStart || atEnd ? delta * 0.25 : delta);
    },
    [mobileActiveColumnIndex, displayColumns.length],
  );

  const handleTouchEnd = useCallback(() => {
    setIsSwipeTransitioning(true);
    if (Math.abs(touchDeltaRef.current) > 50) {
      if (touchDeltaRef.current < 0 && mobileActiveColumnIndex < displayColumns.length - 1) {
        setMobileActiveColumnIndex((prev) => prev + 1);
      } else if (touchDeltaRef.current > 0 && mobileActiveColumnIndex > 0) {
        setMobileActiveColumnIndex((prev) => prev - 1);
      }
    }
    setSwipeOffset(0);
    touchDeltaRef.current = 0;
    // Remove transition flag after animation completes
    setTimeout(() => setIsSwipeTransitioning(false), 300);
  }, [mobileActiveColumnIndex, displayColumns.length]);

  /** Programmatic tab selection with animated transition */
  const selectTab = useCallback((index: number) => {
    setIsSwipeTransitioning(true);
    setMobileActiveColumnIndex(index);
    setTimeout(() => setIsSwipeTransitioning(false), 300);
  }, []);

  return {
    mobileActiveColumnIndex,
    swipeOffset,
    isSwipeTransitioning,

    // Refs (for JSX binding)
    mobileTabBarRef,
    mobileTabRefs,
    swipeContainerRef,

    // Handlers
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    selectTab,
  };
}
