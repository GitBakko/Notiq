import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DndContext,
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
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { ArrowLeft, Plus, Share2, Trash2, MoreVertical, Menu, MessageSquare, ImagePlus, X, FileText, Link2, Unlink } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useKanbanBoard } from './hooks/useKanbanBoard';
import { useKanbanMutations } from './hooks/useKanbanMutations';
import { useKanbanRealtime } from './hooks/useKanbanRealtime';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import * as kanbanService from './kanbanService';
import type { NoteSharingCheck, NoteSearchResult } from './types';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import KanbanColumn from './components/KanbanColumn';
import KanbanCard from './components/KanbanCard';
import CardDetailModal from './components/CardDetailModal';
import ShareBoardModal from './components/ShareBoardModal';
import BoardChatSidebar from './components/BoardChatSidebar';
import NoteLinkPicker from './components/NoteLinkPicker';
import SharingGapModal from './components/SharingGapModal';
import KanbanFilterBar, {
  type KanbanFilters,
  defaultKanbanFilters,
  isFiltersActive,
  cardMatchesFilters,
} from './components/KanbanFilterBar';
// ganttExport loaded lazily on demand (exceljs ~500KB)

interface KanbanBoardPageProps {
  boardId: string;
}

export default function KanbanBoardPage({ boardId }: KanbanBoardPageProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();
  const user = useAuthStore((s) => s.user);

  const { data: board, isLoading, isError } = useKanbanBoard(boardId);
  const mutations = useKanbanMutations(boardId);

  // Navigate back to list if board was deleted or doesn't exist
  useEffect(() => {
    if (!isLoading && (isError || !board)) {
      navigate('/kanban', { replace: true });
    }
  }, [isLoading, isError, board, navigate]);

  // Subscribe to SSE real-time updates + presence (only after board is confirmed to exist)
  const { presenceUsers, highlightedCardIds: realtimeHighlights } = useKanbanRealtime(board ? boardId : undefined);

  // Parse ?highlightCards=id1,id2 from URL (used when navigating from NoteEditor)
  const [searchParams, setSearchParams] = useSearchParams();
  const [urlHighlightIds, setUrlHighlightIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const raw = searchParams.get('highlightCards');
    if (!raw) return;
    const ids = raw.split(',').filter(Boolean);
    if (ids.length === 0) return;

    setUrlHighlightIds(new Set(ids));

    // Remove param from URL so it doesn't persist on refresh
    searchParams.delete('highlightCards');
    setSearchParams(searchParams, { replace: true });

    // Auto-clear after 3s
    const timer = setTimeout(() => setUrlHighlightIds(new Set()), 3000);
    return () => clearTimeout(timer);
  }, []); // Run once on mount

  // Merge SSE highlights + URL-based highlights
  const highlightedCardIds = useMemo(() => {
    if (urlHighlightIds.size === 0) return realtimeHighlights;
    const merged = new Set(realtimeHighlights);
    for (const id of urlHighlightIds) merged.add(id);
    return merged;
  }, [realtimeHighlights, urlHighlightIds]);

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [showBoardMenu, setShowBoardMenu] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<KanbanFilters>(defaultKanbanFilters);
  const [isNoteLinkPickerOpen, setIsNoteLinkPickerOpen] = useState(false);
  const [boardSharingCheck, setBoardSharingCheck] = useState<NoteSharingCheck | null>(null);
  const [pendingBoardNote, setPendingBoardNote] = useState<NoteSearchResult | null>(null);
  const [isBoardSharingGapOpen, setIsBoardSharingGapOpen] = useState(false);
  const [showDeleteBoardConfirm, setShowDeleteBoardConfirm] = useState(false);
  const filtersActive = isFiltersActive(filters);
  const [mobileActiveColumnIndex, setMobileActiveColumnIndex] = useState(0);

  // ── DnD multi-container state ──────────────────────────────────
  // Local copy of columns that can be mutated during drag for smooth cross-column moves
  const [localColumns, setLocalColumns] = useState(board?.columns ?? []);
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
  // ── End DnD multi-container state ──────────────────────────────

  const isOwner = board?.ownerId === user?.id;
  const readOnly = !isOwner && board?.shares?.every((s) => s.permission === 'READ');
  const isShared = board && (board.shares?.some((s) => s.status === 'ACCEPTED') || false);

  // Clear unread when chat opens
  const handleChatToggle = useCallback(() => {
    setIsChatOpen((prev) => {
      if (!prev) setUnreadCount(0);
      return !prev;
    });
  }, []);

  // Find selected card across all columns
  const selectedCard = useMemo(() => {
    if (!selectedCardId || !board) return null;
    for (const col of board.columns) {
      const card = col.cards.find((c) => c.id === selectedCardId);
      if (card) return card;
    }
    return null;
  }, [selectedCardId, board]);

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

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    if (columnIds.includes(id)) {
      setActiveColumnId(id);
    } else {
      setActiveCardId(id);
    }
  }, [columnIds]);

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

  // Board title editing
  function handleStartEditTitle(): void {
    if (readOnly || !board) return;
    setEditTitle(board.title);
    setIsEditingTitle(true);
  }

  function handleSaveTitle(): void {
    setIsEditingTitle(false);
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== board?.title) {
      mutations.updateBoard.mutate({ id: boardId, title: trimmed });
    }
  }

  // Column handlers
  function handleRenameColumn(columnId: string, title: string): void {
    mutations.updateColumn.mutate({ columnId, title });
  }

  function handleDeleteColumn(columnId: string): void {
    mutations.deleteColumn.mutate(columnId, {
      onError: () => toast.error(t('kanban.column.hasCards')),
    });
  }

  function handleAddCard(columnId: string, title: string): void {
    mutations.createCard.mutate({ columnId, title });
  }

  function handleAddColumn(): void {
    const trimmed = newColumnTitle.trim();
    if (!trimmed) return;
    mutations.createColumn.mutate(
      { boardId, title: trimmed },
      {
        onSuccess: () => {
          setNewColumnTitle('');
          setIsAddingColumn(false);
        },
      },
    );
  }

  function handleDeleteBoard(): void {
    setShowDeleteBoardConfirm(true);
  }

  // Cover image
  function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    mutations.uploadCover.mutate(
      { bid: boardId, file },
      { onError: () => toast.error(t('kanban.cover.uploadError')) },
    );
    e.target.value = '';
  }

  function handleRemoveCover(): void {
    mutations.deleteCover.mutate(boardId);
  }

  // Board note linking
  async function handleBoardNoteSelected(note: NoteSearchResult): Promise<void> {
    setIsNoteLinkPickerOpen(false);
    setPendingBoardNote(note);
    try {
      const check = await kanbanService.checkBoardNoteSharing(boardId, note.id);
      if (check.alreadyFullyShared) {
        mutations.linkBoardNote.mutate({ boardId, noteId: note.id });
        setPendingBoardNote(null);
      } else {
        setBoardSharingCheck(check);
        setIsBoardSharingGapOpen(true);
      }
    } catch {
      setPendingBoardNote(null);
    }
  }

  function handleBoardNoteSharingConfirm(selectedUserIds: string[]): void {
    if (!pendingBoardNote) return;
    mutations.linkBoardNote.mutate(
      { boardId, noteId: pendingBoardNote.id, shareWithUserIds: selectedUserIds },
      {
        onSuccess: () => {
          setIsBoardSharingGapOpen(false);
          setBoardSharingCheck(null);
          setPendingBoardNote(null);
        },
      },
    );
  }

  function handleUnlinkBoardNote(): void {
    mutations.unlinkBoardNote.mutate(boardId);
  }

  function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    mutations.uploadAvatar.mutate(
      { bid: boardId, file },
      { onError: () => toast.error(t('common.genericError')) },
    );
    e.target.value = '';
  }

  // ── These useMemo hooks MUST be above early returns to satisfy React hook rules ──
  const sortedColumns = useMemo(
    () => [...localColumns].sort((a, b) => a.position - b.position),
    [localColumns],
  );

  // Unique assignees from all cards for the filter dropdown
  const allAssignees = useMemo(() => {
    if (!board) return [];
    const map = new Map<string, { id: string; name: string | null; email: string; color: string | null; avatarUrl: string | null }>();
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.assignee && !map.has(card.assignee.id)) {
          map.set(card.assignee.id, card.assignee);
        }
      }
    }
    return Array.from(map.values());
  }, [board]);

  // Filtered columns for display (DnD uses localColumns unfiltered)
  const displayColumns = useMemo(() => {
    if (!filtersActive) return sortedColumns;
    return sortedColumns.map((col) => ({
      ...col,
      cards: col.cards.filter((card) => cardMatchesFilters(card, filters)),
    }));
  }, [sortedColumns, filtersActive, filters]);

  // Clamp mobile active column index when columns change
  useEffect(() => {
    if (mobileActiveColumnIndex >= displayColumns.length && displayColumns.length > 0) {
      setMobileActiveColumnIndex(displayColumns.length - 1);
    }
  }, [displayColumns.length, mobileActiveColumnIndex]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    );
  }

  if (!board) {
    // useEffect above will navigate back to /kanban
    return (
      <div className="flex-1 flex items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
      </div>
    );
  }

  const userColor = user?.color || '#319795';

  // Gantt XLSX export (lazy-loaded)
  async function handleExportGantt(): Promise<void> {
    if (!board) return;
    const { exportGanttXLSX } = await import('./ganttExport');
    await exportGanttXLSX(board, t, i18n.language);
  }

  return (
    <div className="flex-1 flex h-full bg-neutral-50 dark:bg-neutral-950">
      {/* Main board area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Cover Image */}
        {board.coverImage && (
          <div className="relative h-40 flex-shrink-0 overflow-hidden group/cover">
            <img
              src={board.coverImage}
              alt=""
              className="w-full h-full object-cover"
            />
            {!readOnly && (
              <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/cover:opacity-100 transition-opacity">
                <button
                  onClick={() => coverInputRef.current?.click()}
                  className="p-1.5 rounded-md bg-black/40 hover:bg-black/60 text-white text-xs transition-colors"
                  title={t('kanban.cover.change')}
                >
                  <ImagePlus size={14} />
                </button>
                <button
                  onClick={handleRemoveCover}
                  className="p-1.5 rounded-md bg-black/40 hover:bg-black/60 text-white text-xs transition-colors"
                  title={t('kanban.cover.remove')}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Header */}
        <div className="flex-shrink-0 border-b border-neutral-200/60 dark:border-neutral-800/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {isMobile && (
                <button
                  onClick={toggleSidebar}
                  className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
                >
                  <Menu size={20} />
                </button>
              )}
              <button
                onClick={() => navigate('/kanban')}
                className="flex-shrink-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
              >
                <ArrowLeft size={20} />
              </button>

              {/* Board Avatar */}
              <div className="relative group/avatar flex-shrink-0">
                {board.avatarUrl ? (
                  <img
                    src={board.avatarUrl}
                    alt=""
                    className="w-8 h-8 rounded-full object-cover cursor-pointer"
                    onClick={() => !readOnly && avatarInputRef.current?.click()}
                  />
                ) : !readOnly ? (
                  <button
                    onClick={() => avatarInputRef.current?.click()}
                    className="w-8 h-8 rounded-full bg-neutral-100 dark:bg-neutral-700 flex items-center justify-center text-neutral-400 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors"
                    title={t('kanban.avatar.upload')}
                  >
                    <ImagePlus size={14} />
                  </button>
                ) : null}
                {!readOnly && board.avatarUrl && (
                  <button
                    onClick={() => mutations.deleteAvatar.mutate(boardId)}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center text-[8px] opacity-0 group-hover/avatar:opacity-100 transition-opacity"
                    title={t('kanban.avatar.remove')}
                  >
                    <X size={8} />
                  </button>
                )}
              </div>

              {isEditingTitle ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={handleSaveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveTitle();
                    if (e.key === 'Escape') setIsEditingTitle(false);
                  }}
                  className="text-lg font-bold bg-transparent border-b-2 border-emerald-500 text-neutral-900 dark:text-white outline-none min-w-0"
                />
              ) : (
                <h1
                  onDoubleClick={handleStartEditTitle}
                  className={clsx(
                    'text-lg font-bold text-neutral-900 dark:text-white truncate',
                    !readOnly && 'cursor-pointer',
                  )}
                >
                  {board.title}
                </h1>
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Presence avatars */}
              {presenceUsers.length > 0 && (
                <div className="flex items-center -space-x-2 mr-2">
                  {presenceUsers.slice(0, 5).map((u) => {
                    const isMe = u.id === user?.id;
                    const initial = isMe
                      ? 'ME'
                      : u.name?.charAt(0)?.toUpperCase() || '?';
                    return (
                      <div
                        key={u.id}
                        className="w-7 h-7 rounded-full border-2 border-white dark:border-neutral-950 flex items-center justify-center text-[9px] font-bold text-white shadow-sm overflow-hidden relative"
                        style={{ backgroundColor: u.color || '#319795' }}
                        title={isMe ? t('kanban.presence.you') : (u.name || '?')}
                      >
                        {u.avatarUrl ? (
                          <>
                            <img
                              src={u.avatarUrl}
                              alt=""
                              className="w-full h-full object-cover absolute inset-0"
                            />
                            <span
                              className="relative z-10 text-[8px] font-bold text-white"
                              style={{ textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
                            >
                              {initial}
                            </span>
                          </>
                        ) : (
                          <span>{initial}</span>
                        )}
                      </div>
                    );
                  })}
                  {presenceUsers.length > 5 && (
                    <div className="w-7 h-7 rounded-full border-2 border-white dark:border-neutral-950 bg-neutral-300 dark:bg-neutral-600 flex items-center justify-center text-[9px] font-bold text-neutral-700 dark:text-neutral-200">
                      +{presenceUsers.length - 5}
                    </div>
                  )}
                </div>
              )}

              {/* Chat toggle */}
              {(isOwner || isShared) && (
                <button
                  onClick={handleChatToggle}
                  className={clsx(
                    'p-2 rounded-lg transition-colors relative',
                    isChatOpen
                      ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                      : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                  )}
                  title={t('kanban.chat.title')}
                >
                  <MessageSquare size={18} />
                  {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 -mt-1 -mr-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </button>
              )}

              {/* Cover image button (no cover yet) */}
              {!readOnly && !board.coverImage && (
                <button
                  onClick={() => coverInputRef.current?.click()}
                  className="p-2 text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                  title={t('kanban.cover.add')}
                >
                  <ImagePlus size={18} />
                </button>
              )}

              {isOwner && (
                <button
                  onClick={() => setIsShareOpen(true)}
                  className="p-2 text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                  title={t('kanban.share.title')}
                >
                  <Share2 size={18} />
                </button>
              )}

              {isOwner && (
                <div className="relative">
                  <button
                    onClick={() => setShowBoardMenu(!showBoardMenu)}
                    className="p-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                  >
                    <MoreVertical size={18} />
                  </button>
                  {showBoardMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowBoardMenu(false)} />
                      <div className="absolute right-0 top-10 z-20 w-48 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-800 shadow-lg py-1">
                        <button
                          onClick={() => {
                            setShowBoardMenu(false);
                            handleDeleteBoard();
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          <Trash2 size={14} />
                          {t('kanban.deleteBoard')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Board-linked note */}
        {(board.noteId || !readOnly) && (
          <div className="flex-shrink-0 border-b border-neutral-200/60 dark:border-neutral-800/40 px-4 py-2">
            {board.note ? (
              <div className="flex items-center gap-2 text-sm">
                <FileText size={14} className="text-emerald-500 flex-shrink-0" />
                <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('kanban.boardNote.linkedNote')}:</span>
                <button
                  onClick={() => navigate(`/notes?noteId=${board.note!.id}`)}
                  className="text-emerald-600 dark:text-emerald-400 hover:underline truncate text-sm"
                >
                  {board.note.title}
                </button>
                {!readOnly && user?.id === board.noteLinkedById && (
                  <button
                    onClick={handleUnlinkBoardNote}
                    className="ml-auto flex-shrink-0 p-1 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    title={t('kanban.boardNote.unlink')}
                  >
                    <Unlink size={14} />
                  </button>
                )}
              </div>
            ) : board.noteId ? (
              <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-neutral-400 italic">
                <FileText size={14} />
                {t('kanban.boardNote.noAccess')}
              </div>
            ) : !readOnly ? (
              <button
                onClick={() => setIsNoteLinkPickerOpen(true)}
                className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
              >
                <Link2 size={14} />
                {t('kanban.boardNote.link')}
              </button>
            ) : null}
          </div>
        )}

        {/* Filter bar */}
        <KanbanFilterBar
          filters={filters}
          onFiltersChange={setFilters}
          assignees={allAssignees}
          onExport={handleExportGantt}
        />

        {/* Mobile column tabs */}
        {isMobile && displayColumns.length > 0 && (
          <div className="flex-shrink-0 border-b border-neutral-200/60 dark:border-neutral-800/40 overflow-x-auto">
            <div className="flex">
              {displayColumns.map((col, index) => (
                <button
                  key={col.id}
                  onClick={() => setMobileActiveColumnIndex(index)}
                  className={clsx(
                    'flex-shrink-0 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap',
                    index === mobileActiveColumnIndex
                      ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                      : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
                  )}
                >
                  {col.title} ({col.cards.length})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Board content */}
        {isMobile ? (
          // Mobile: single column, full width
          <div className="flex-1 overflow-y-auto p-4">
            {displayColumns[mobileActiveColumnIndex] ? (
              <div className="w-full [&>div]:!w-full [&>div]:!min-w-0">
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
                />
              </div>
            ) : !readOnly ? (
              <div className="flex items-center justify-center p-8">
                <button
                  onClick={() => setIsAddingColumn(true)}
                  className="flex items-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-neutral-300 dark:border-neutral-700/40 text-neutral-400 dark:text-neutral-400 hover:border-emerald-400 hover:text-emerald-600 transition-colors text-sm font-medium"
                >
                  <Plus size={16} />
                  {t('kanban.column.addColumn')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          // Desktop: multi-column layout with DnD
          <div className="flex-1 overflow-x-auto overflow-y-hidden">
            <DndContext
              sensors={sensors}
              collisionDetection={kanbanCollisionDetection}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
            >
              <div className="flex gap-4 p-4 h-full items-start">
                <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
                  {displayColumns.map((column) => (
                    <KanbanColumn
                      key={column.id}
                      column={column}
                      boardId={boardId}
                      onCardSelect={(cardId) => setSelectedCardId(cardId)}
                      onRenameColumn={handleRenameColumn}
                      onDeleteColumn={handleDeleteColumn}
                      onAddCard={handleAddCard}
                      readOnly={readOnly || filtersActive}
                      highlightedCardIds={highlightedCardIds}
                    />
                  ))}
                </SortableContext>

                {/* Add Column button / inline input */}
                {!readOnly && (
                  <div className="min-w-[280px] w-[280px] flex-shrink-0">
                    {isAddingColumn ? (
                      <div className="bg-neutral-100 dark:bg-neutral-800/50 rounded-xl p-3 space-y-2">
                        <input
                          autoFocus
                          value={newColumnTitle}
                          onChange={(e) => setNewColumnTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddColumn();
                            if (e.key === 'Escape') {
                              setIsAddingColumn(false);
                              setNewColumnTitle('');
                            }
                          }}
                          onBlur={() => {
                            if (!newColumnTitle.trim()) {
                              setIsAddingColumn(false);
                              setNewColumnTitle('');
                            }
                          }}
                          placeholder={t('kanban.column.columnTitle')}
                          className="w-full bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-600 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-400 outline-none focus:border-emerald-500"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => setIsAddingColumn(true)}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-neutral-300 dark:border-neutral-700/40 text-neutral-400 dark:text-neutral-400 hover:border-emerald-400 hover:text-emerald-600 dark:hover:border-emerald-600 dark:hover:text-emerald-400 transition-colors text-sm font-medium"
                      >
                        <Plus size={16} />
                        {t('kanban.column.addColumn')}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Drag overlay */}
              <DragOverlay>
                {activeCard ? (
                  <div className="opacity-90">
                    <KanbanCard
                      card={activeCard}
                      onSelect={() => {}}
                      readOnly
                    />
                  </div>
                ) : activeColumn ? (
                  <div className="opacity-90">
                    <KanbanColumn
                      column={activeColumn}
                      boardId={boardId}
                      onCardSelect={() => {}}
                      onRenameColumn={() => {}}
                      onDeleteColumn={() => {}}
                      onAddCard={() => {}}
                      readOnly
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        )}

        {/* Hidden cover image input */}
        <input
          ref={coverInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleCoverUpload}
        />
        {/* Hidden avatar input */}
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleAvatarUpload}
        />
      </div>

      {/* Chat Sidebar */}
      {(isOwner || isShared) && (
        <BoardChatSidebar
          boardId={boardId}
          isOpen={isChatOpen}
          onClose={() => setIsChatOpen(false)}
          currentUser={{
            id: user?.id || 'anon',
            name: user?.name || 'User',
            color: userColor,
            avatarUrl: user?.avatarUrl || null,
          }}
          onNewMessage={() => setUnreadCount((prev) => prev + 1)}
          participants={presenceUsers}
        />
      )}

      {/* Card Detail Modal */}
      <CardDetailModal
        isOpen={!!selectedCardId}
        onClose={() => setSelectedCardId(null)}
        card={selectedCard}
        boardId={boardId}
        readOnly={readOnly}
      />

      {/* Share Modal */}
      {isOwner && (
        <ShareBoardModal
          isOpen={isShareOpen}
          onClose={() => setIsShareOpen(false)}
          boardId={boardId}
          boardTitle={board.title}
          sharedWith={board.shares?.filter((s) => s.status === 'ACCEPTED')}
        />
      )}

      {/* Board note picker + sharing gap modal */}
      <NoteLinkPicker
        isOpen={isNoteLinkPickerOpen}
        onClose={() => setIsNoteLinkPickerOpen(false)}
        onSelect={handleBoardNoteSelected}
      />
      {boardSharingCheck && (
        <SharingGapModal
          isOpen={isBoardSharingGapOpen}
          onClose={() => {
            setIsBoardSharingGapOpen(false);
            setBoardSharingCheck(null);
            setPendingBoardNote(null);
          }}
          sharingCheck={boardSharingCheck}
          onConfirm={handleBoardNoteSharingConfirm}
          isPending={mutations.linkBoardNote.isPending}
        />
      )}

      <ConfirmDialog
        isOpen={showDeleteBoardConfirm}
        onClose={() => setShowDeleteBoardConfirm(false)}
        onConfirm={() => mutations.deleteBoard.mutate(boardId, { onSuccess: () => navigate('/kanban') })}
        title={t('kanban.deleteBoard')}
        message={t('kanban.deleteBoardConfirm')}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </div>
  );
}
