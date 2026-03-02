import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import type { KanbanBoard, KanbanColumn, KanbanCard } from '../types';

interface UseBoardDnDParams {
  board: KanbanBoard | undefined;
  boardId: string;
  mutations: {
    moveCard: {
      mutate: (
        vars: { cardId: string; toColumnId: string; position: number },
        opts?: { onSettled?: () => void },
      ) => void;
    };
    reorderColumns: {
      mutate: (
        vars: { boardId: string; columns: { id: string; position: number }[] },
        opts?: { onSettled?: () => void },
      ) => void;
    };
  };
}

/**
 * Extracts all drag-and-drop logic for the Kanban board:
 * - localColumns state (optimistic copy of server columns)
 * - DnD sensors, collision detection
 * - handleDragStart, handleDragOver, handleDragEnd
 * - handleMoveCardToColumn (menu-driven card move)
 */
export function useBoardDnD({ board, boardId, mutations }: UseBoardDnDParams) {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [localColumns, setLocalColumns] = useState<KanbanColumn[]>(board?.columns ?? []);
  const [isMoveInFlight, setIsMoveInFlight] = useState(false);

  // Sync local columns with server data when not dragging and no mutation in progress
  useEffect(() => {
    if (board?.columns && !activeCardId && !activeColumnId && !isMoveInFlight) {
      setLocalColumns(board.columns);
    }
  }, [board?.columns, activeCardId, activeColumnId, isMoveInFlight]);

  const columnIds = useMemo(() => localColumns.map((c) => c.id), [localColumns]);

  /** Find which column contains the given card or column ID */
  const findColumnId = useCallback(
    (id: string): string | undefined => {
      if (columnIds.includes(id)) return id;
      return localColumns.find((col) => col.cards.some((c) => c.id === id))?.id;
    },
    [localColumns, columnIds],
  );

  /** Custom collision detection: pointer-based for columns, closest-center for cards */
  const kanbanCollisionDetection: CollisionDetection = useCallback(
    (args) => {
      // When dragging a column, only detect collisions with other columns
      const isDraggingColumn = columnIds.includes(args.active.id as string);
      if (isDraggingColumn) {
        const columnContainers = args.droppableContainers.filter((c) =>
          columnIds.includes(c.id as string),
        );
        return closestCenter({ ...args, droppableContainers: columnContainers });
      }

      // Card dragging: find columns the pointer is inside
      const columnContainers = args.droppableContainers.filter((c) =>
        columnIds.includes(c.id as string),
      );
      const pointerCollisions = pointerWithin({
        ...args,
        droppableContainers: columnContainers,
      });

      if (pointerCollisions.length > 0) {
        const targetColumnId = pointerCollisions[0].id as string;
        // Find the closest card within that column
        const targetColumn = localColumns.find((c) => c.id === targetColumnId);
        const cardContainers = args.droppableContainers.filter((c) =>
          targetColumn?.cards.some((card) => card.id === c.id),
        );

        if (cardContainers.length > 0) {
          const cardCollisions = closestCenter({
            ...args,
            droppableContainers: cardContainers,
          });
          if (cardCollisions.length > 0) return cardCollisions;
        }
        // Empty column — return column itself
        return pointerCollisions;
      }

      // Fallback: closest center across all droppables
      return closestCenter(args);
    },
    [columnIds, localColumns],
  );

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = event.active.id as string;
      if (columnIds.includes(id)) {
        setActiveColumnId(id);
      } else {
        setActiveCardId(id);
      }
    },
    [columnIds],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;

      // Skip cross-column card logic when dragging a column
      if (columnIds.includes(active.id as string)) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const activeColId = findColumnId(activeId);
      const overColId = findColumnId(overId);

      // Only handle cross-column moves (same-column reorder is handled by SortableContext)
      if (!activeColId || !overColId || activeColId === overColId) return;

      setLocalColumns((prev) => {
        const srcCol = prev.find((c) => c.id === activeColId);
        const dstCol = prev.find((c) => c.id === overColId);
        if (!srcCol || !dstCol) return prev;

        const card = srcCol.cards.find((c) => c.id === activeId);
        if (!card) return prev;

        // Build destination cards list without the active card
        const dstCards = [...dstCol.cards]
          .filter((c) => c.id !== activeId)
          .sort((a, b) => a.position - b.position);

        // Insert at the over-item position, or at end for column drop target
        let insertIdx: number;
        if (overId === overColId) {
          insertIdx = dstCards.length;
        } else {
          const idx = dstCards.findIndex((c) => c.id === overId);
          insertIdx = idx >= 0 ? idx : dstCards.length;
        }
        dstCards.splice(insertIdx, 0, card);

        return prev.map((col) => {
          if (col.id === activeColId) {
            return { ...col, cards: col.cards.filter((c) => c.id !== activeId) };
          }
          if (col.id === overColId) {
            return { ...col, cards: dstCards.map((c, i) => ({ ...c, position: i })) };
          }
          return col;
        });
      });
    },
    [columnIds, findColumnId],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveCardId(null);
      setActiveColumnId(null);

      if (!over || !board) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      // ── Column reorder ──
      if (columnIds.includes(activeId)) {
        if (activeId === overId) return;
        const oldIdx = localColumns.findIndex((c) => c.id === activeId);
        const newIdx = localColumns.findIndex((c) => c.id === overId);
        if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) return;

        const reordered = arrayMove(localColumns, oldIdx, newIdx);
        setLocalColumns(reordered);

        const columnsPayload = reordered.map((col, i) => ({ id: col.id, position: i }));
        setIsMoveInFlight(true);
        mutations.reorderColumns.mutate(
          { boardId, columns: columnsPayload },
          { onSettled: () => setIsMoveInFlight(false) },
        );
        return;
      }

      // ── Card reorder / cross-column move ──
      const cardId = activeId;

      // Find the column the card is in now (localColumns, after any onDragOver moves)
      const currentColId = findColumnId(cardId);
      if (!currentColId) return;

      const currentCol = localColumns.find((c) => c.id === currentColId);
      if (!currentCol) return;

      const sortedCards = [...currentCol.cards].sort((a, b) => a.position - b.position);

      // Same-column reorder (onDragOver didn't fire — same container)
      const overColId = findColumnId(overId);
      if (currentColId === overColId && overId !== currentColId) {
        const oldIdx = sortedCards.findIndex((c) => c.id === cardId);
        const newIdx = sortedCards.findIndex((c) => c.id === overId);

        if (oldIdx >= 0 && newIdx >= 0 && oldIdx !== newIdx) {
          const reordered = arrayMove(sortedCards, oldIdx, newIdx);
          setLocalColumns((prev) =>
            prev.map((col) =>
              col.id === currentColId
                ? { ...col, cards: reordered.map((c, i) => ({ ...c, position: i })) }
                : col,
            ),
          );
          setIsMoveInFlight(true);
          mutations.moveCard.mutate(
            { cardId, toColumnId: currentColId, position: newIdx },
            { onSettled: () => setIsMoveInFlight(false) },
          );
          return;
        }
      }

      // Cross-column move — card was already transferred in onDragOver
      const position = sortedCards.findIndex((c) => c.id === cardId);

      // Verify something actually changed
      const origCol = board.columns.find((col) => col.cards.some((c) => c.id === cardId));
      const origCard = origCol?.cards.find((c) => c.id === cardId);
      if (origCol?.id === currentColId && origCard?.position === position) return;

      setIsMoveInFlight(true);
      mutations.moveCard.mutate(
        { cardId, toColumnId: currentColId, position: position >= 0 ? position : sortedCards.length },
        { onSettled: () => setIsMoveInFlight(false) },
      );
    },
    [board, boardId, localColumns, columnIds, findColumnId, mutations.moveCard, mutations.reorderColumns],
  );

  // Move card to a different column via menu (mobile & desktop)
  const handleMoveCardToColumn = useCallback(
    (cardId: string, targetColumnId: string) => {
      // Optimistic: move card in localColumns immediately
      setLocalColumns((prev) => {
        let movedCard: KanbanCard | undefined;
        const updated = prev.map((col) => {
          const cardIdx = col.cards.findIndex((c) => c.id === cardId);
          if (cardIdx >= 0) {
            movedCard = col.cards[cardIdx];
            return { ...col, cards: col.cards.filter((c) => c.id !== cardId) };
          }
          return col;
        });
        if (!movedCard) return prev;
        return updated.map((col) => {
          if (col.id === targetColumnId) {
            const newPosition = col.cards.length;
            return { ...col, cards: [...col.cards, { ...movedCard!, position: newPosition }] };
          }
          return col;
        });
      });

      // Persist to backend
      setIsMoveInFlight(true);
      mutations.moveCard.mutate(
        { cardId, toColumnId: targetColumnId, position: 999 },
        { onSettled: () => setIsMoveInFlight(false) },
      );
    },
    [mutations.moveCard],
  );

  // Sorted columns for display
  const sortedColumns = useMemo(
    () => [...localColumns].sort((a, b) => a.position - b.position),
    [localColumns],
  );

  // Find active card for DragOverlay (search localColumns so it works during cross-column drag)
  const activeCard = useMemo(() => {
    if (!activeCardId) return null;
    for (const col of localColumns) {
      const card = col.cards.find((c) => c.id === activeCardId);
      if (card) return card;
    }
    return null;
  }, [activeCardId, localColumns]);

  // Find active column for DragOverlay
  const activeColumn = useMemo(() => {
    if (!activeColumnId) return null;
    return localColumns.find((c) => c.id === activeColumnId) ?? null;
  }, [activeColumnId, localColumns]);

  return {
    // State
    activeCardId,
    activeColumnId,
    localColumns,
    columnIds,
    sortedColumns,

    // Computed
    activeCard,
    activeColumn,

    // DnD config
    sensors,
    kanbanCollisionDetection,

    // Handlers
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleMoveCardToColumn,
  };
}
