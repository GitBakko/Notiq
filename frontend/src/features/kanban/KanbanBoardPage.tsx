import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { Archive, ArrowLeft, ListChecks, Plus, Share2, Trash2, MoreVertical, Menu, MessageSquare, ImagePlus, X, FileText, Link2, Unlink } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { useKanbanBoard } from './hooks/useKanbanBoard';
import { useKanbanMutations } from './hooks/useKanbanMutations';
import { useKanbanRealtime } from './hooks/useKanbanRealtime';
import { useBoardModals } from './hooks/useBoardModals';
import { useBoardDnD } from './hooks/useBoardDnD';
import { useBoardMobileSwipe } from './hooks/useBoardMobileSwipe';
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
import ArchivedCardsModal from './components/ArchivedCardsModal';
import TaskListLinkPicker from './components/TaskListLinkPicker';
import { useMarqueeSelection } from './hooks/useMarqueeSelection';
import CardContextMenu from './components/CardContextMenu';
import BulkMoveMenu from './components/BulkMoveMenu';
import type { PriorityLevel } from '../../utils/priorityConfig';
import api from '../../lib/api';
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

  // ── Modal/overlay states (extracted hook) ──
  const modals = useBoardModals();

  // ── DnD state & handlers (extracted hook) ──
  const dnd = useBoardDnD({ board, boardId, mutations });

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [boardContainerEl, setBoardContainerEl] = useState<HTMLDivElement | null>(null);

  const [filters, setFilters] = useState<KanbanFilters>(defaultKanbanFilters);
  const [boardSharingCheck, setBoardSharingCheck] = useState<NoteSharingCheck | null>(null);
  const [pendingBoardNote, setPendingBoardNote] = useState<NoteSearchResult | null>(null);
  const filtersActive = isFiltersActive(filters);

  const isOwner = board?.ownerId === user?.id;
  const readOnly = !isOwner && board?.shares?.every((s) => s.permission === 'READ');
  const isShared = board && (board.shares?.some((s) => s.status === 'ACCEPTED') || false);

  // ── Marquee selection (desktop only) ──
  const marquee = useMarqueeSelection({
    containerEl: boardContainerEl,
    enabled: !readOnly,
  });

  // ── Context menu state ──
  const [contextMenu, setContextMenu] = useState<{ card: import('./types').KanbanCard; columnId: string; position: { x: number; y: number } } | null>(null);
  const [noteLinkCardId, setNoteLinkCardId] = useState<string | null>(null);

  // Find selected card across all columns
  const selectedCard = useMemo(() => {
    if (!selectedCardId || !board) return null;
    for (const col of board.columns) {
      const card = col.cards.find((c) => c.id === selectedCardId);
      if (card) return card;
    }
    return null;
  }, [selectedCardId, board]);

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
    if (!filtersActive) return dnd.sortedColumns;
    return dnd.sortedColumns.map((col) => ({
      ...col,
      cards: col.cards.filter((card) => cardMatchesFilters(card, filters)),
    }));
  }, [dnd.sortedColumns, filtersActive, filters]);

  // ── Mobile swipe (extracted hook) ──
  const swipe = useBoardMobileSwipe({ displayColumns, isMobile });

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

  function handleToggleColumnCompletion(columnId: string, isCompleted: boolean): void {
    mutations.updateColumn.mutate({ columnId, isCompleted });
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
    modals.setShowDeleteBoardConfirm(true);
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
    modals.setIsNoteLinkPickerOpen(false);
    setPendingBoardNote(note);
    try {
      const check = await kanbanService.checkBoardNoteSharing(boardId, note.id);
      if (check.alreadyFullyShared) {
        mutations.linkBoardNote.mutate({ boardId, noteId: note.id });
        setPendingBoardNote(null);
      } else {
        setBoardSharingCheck(check);
        modals.setIsBoardSharingGapOpen(true);
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
          modals.setIsBoardSharingGapOpen(false);
          setBoardSharingCheck(null);
          setPendingBoardNote(null);
        },
      },
    );
  }

  function handleUnlinkBoardNote(): void {
    mutations.unlinkBoardNote.mutate(boardId);
  }

  function handleLinkTaskList(taskListId: string): void {
    modals.setIsTaskListPickerOpen(false);
    mutations.linkTaskList.mutate({ boardId, taskListId });
  }

  function handleUnlinkTaskList(): void {
    mutations.unlinkTaskList.mutate(boardId);
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

  // ── Context menu handler ──
  const handleCardContextMenu = useCallback((cardId: string, e: React.MouseEvent) => {
    if (readOnly) return;
    const card = board?.columns.flatMap(c => c.cards).find(c => c.id === cardId);
    const col = board?.columns.find(c => c.cards.some(ca => ca.id === cardId));
    if (!card || !col) return;
    setContextMenu({ card, columnId: col.id, position: { x: e.clientX, y: e.clientY } });
  }, [board, readOnly]);

  // ── Context menu action handlers ──
  const handleContextAssign = useCallback((cardId: string, assigneeId: string | null) => {
    mutations.updateCard.mutate({ cardId, assigneeId });
  }, [mutations]);

  const handleContextPriority = useCallback((cardId: string, priority: PriorityLevel | null) => {
    mutations.updateCard.mutate({ cardId, priority });
  }, [mutations]);

  const handleContextDueDate = useCallback((cardId: string, dueDate: string | null) => {
    mutations.updateCard.mutate({ cardId, dueDate });
  }, [mutations]);

  const handleContextLinkNote = useCallback((cardId: string) => {
    setNoteLinkCardId(cardId);
  }, []);

  const handleContextDuplicate = useCallback((cardId: string) => {
    mutations.duplicateCard.mutate(cardId);
  }, [mutations]);

  const handleContextDelete = useCallback((cardId: string) => {
    mutations.deleteCard.mutate(cardId);
  }, [mutations]);

  // ── Bulk move handler ──
  const handleBulkMove = useCallback(async (targetColumnId: string) => {
    if (!board) return;

    const moves: { cardId: string; fromColumnId: string; toColumnId: string }[] = [];
    for (const cardId of marquee.selectedCardIds) {
      const col = board.columns.find(c => c.cards.some(ca => ca.id === cardId));
      if (col && col.id !== targetColumnId) {
        moves.push({ cardId, fromColumnId: col.id, toColumnId: targetColumnId });
      }
    }

    if (moves.length === 0) {
      marquee.clearSelection();
      return;
    }

    // Optimistic UI + silent REST calls (bypass sync queue notifications)
    for (const move of moves) {
      dnd.handleMoveCardToColumn(move.cardId, move.toColumnId);
    }
    for (const move of moves) {
      api.put(`/kanban/cards/${move.cardId}/move?silent=true`, {
        toColumnId: move.toColumnId,
        position: 999,
      }).catch(() => {});
    }

    // Grouped notification
    api.post(`/kanban/boards/${board.id}/bulk-move-notify`, { moves }).catch(() => {});

    marquee.clearSelection();
  }, [marquee, board, dnd]);

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
                  {presenceUsers.slice(0, isMobile ? 3 : 5).map((u) => {
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
                  {presenceUsers.length > (isMobile ? 3 : 5) && (
                    <div className="w-7 h-7 rounded-full border-2 border-white dark:border-neutral-950 bg-neutral-300 dark:bg-neutral-600 flex items-center justify-center text-[9px] font-bold text-neutral-700 dark:text-neutral-200">
                      +{presenceUsers.length - (isMobile ? 3 : 5)}
                    </div>
                  )}
                </div>
              )}

              {/* Desktop-only action buttons — hidden on mobile (merged into three-dot menu) */}
              {!isMobile && (
                <>
                  {/* Chat toggle */}
                  {(isOwner || isShared) && (
                    <button
                      onClick={modals.handleChatToggle}
                      className={clsx(
                        'p-2 rounded-lg transition-colors relative',
                        modals.isChatOpen
                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                          : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      )}
                      title={t('kanban.chat.title')}
                    >
                      <MessageSquare size={18} />
                      {modals.unreadCount > 0 && (
                        <span className="absolute top-0 right-0 -mt-1 -mr-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
                          {modals.unreadCount > 9 ? '9+' : modals.unreadCount}
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

                  {/* Archive button */}
                  <button
                    onClick={() => modals.setIsArchiveOpen(true)}
                    className="p-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors relative"
                    title={t('kanban.archive.title')}
                  >
                    <Archive size={18} />
                    {board.archivedCardsCount > 0 && (
                      <span className="absolute top-0 right-0 -mt-1 -mr-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neutral-500 dark:bg-neutral-600 text-[10px] text-white px-1">
                        {board.archivedCardsCount}
                      </span>
                    )}
                  </button>

                  {isOwner && (
                    <button
                      onClick={() => modals.setIsShareOpen(true)}
                      className="p-2 text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                      title={t('kanban.share.title')}
                    >
                      <Share2 size={18} />
                    </button>
                  )}
                </>
              )}

              {/* Three-dot menu — on mobile contains all actions, on desktop only board management */}
              <div className="relative">
                <button
                  onClick={() => modals.setShowBoardMenu(!modals.showBoardMenu)}
                  className="p-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors relative"
                >
                  <MoreVertical size={18} />
                  {/* Unread badge on mobile (chat is inside menu) */}
                  {isMobile && modals.unreadCount > 0 && (
                    <span className="absolute top-0 right-0 -mt-1 -mr-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
                      {modals.unreadCount > 9 ? '9+' : modals.unreadCount}
                    </span>
                  )}
                </button>
                {modals.showBoardMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => modals.setShowBoardMenu(false)} />
                    <div className="absolute right-0 top-10 z-20 w-56 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-800 shadow-lg py-1">
                      {/* Mobile-only items — actions moved from header */}
                      {isMobile && (
                        <>
                          {(isOwner || isShared) && (
                            <button
                              onClick={() => {
                                modals.setShowBoardMenu(false);
                                modals.handleChatToggle();
                              }}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                              <MessageSquare size={14} />
                              {t('kanban.chat.title')}
                              {modals.unreadCount > 0 && (
                                <span className="ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 text-[10px] text-white px-1">
                                  {modals.unreadCount}
                                </span>
                              )}
                            </button>
                          )}
                          {!readOnly && !board.coverImage && (
                            <button
                              onClick={() => {
                                modals.setShowBoardMenu(false);
                                coverInputRef.current?.click();
                              }}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                              <ImagePlus size={14} />
                              {t('kanban.cover.add')}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              modals.setShowBoardMenu(false);
                              modals.setIsArchiveOpen(true);
                            }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                          >
                            <Archive size={14} />
                            {t('kanban.archive.title')}
                            {board.archivedCardsCount > 0 && (
                              <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500">
                                {board.archivedCardsCount}
                              </span>
                            )}
                          </button>
                          {isOwner && (
                            <button
                              onClick={() => {
                                modals.setShowBoardMenu(false);
                                modals.setIsShareOpen(true);
                              }}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                              <Share2 size={14} />
                              {t('kanban.share.title')}
                            </button>
                          )}
                          <div className="border-t border-neutral-200/60 dark:border-neutral-700/40 my-1" />
                        </>
                      )}
                      {/* Common items — always visible */}
                      {isOwner && (
                        <>
                          {board.taskListId ? (
                            <button
                              onClick={() => {
                                modals.setShowBoardMenu(false);
                                handleUnlinkTaskList();
                              }}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                              <Unlink size={14} />
                              {t('kanban.linking.unlinkTaskList')}
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                modals.setShowBoardMenu(false);
                                modals.setIsTaskListPickerOpen(true);
                              }}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                              <ListChecks size={14} />
                              {t('kanban.linking.linkTaskList')}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              modals.setShowBoardMenu(false);
                              handleDeleteBoard();
                            }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            <Trash2 size={14} />
                            {t('kanban.deleteBoard')}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
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
                onClick={() => modals.setIsNoteLinkPickerOpen(true)}
                className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
              >
                <Link2 size={14} />
                {t('kanban.boardNote.link')}
              </button>
            ) : null}
          </div>
        )}

        {/* Board-linked task list */}
        {board.taskList && (
          <div className="flex-shrink-0 border-b border-neutral-200/60 dark:border-neutral-800/40 px-4 py-2">
            <div className="flex items-center gap-2 text-sm">
              <ListChecks size={14} className="text-blue-500 flex-shrink-0" />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('kanban.linking.linkedTo')}:</span>
              <button
                onClick={() => navigate('/tasks')}
                className="text-blue-600 dark:text-blue-400 hover:underline truncate text-sm"
              >
                {board.taskList.title}
              </button>
              {!readOnly && (
                <button
                  onClick={handleUnlinkTaskList}
                  className="ml-auto flex-shrink-0 p-1 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  title={t('kanban.linking.unlinkTaskList')}
                >
                  <Unlink size={14} />
                </button>
              )}
            </div>
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
          <div
            ref={swipe.mobileTabBarRef}
            className="flex-shrink-0 bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 overflow-x-auto scrollbar-none"
          >
            <div className="flex">
              {displayColumns.map((col, index) => (
                <button
                  key={col.id}
                  ref={(el) => {
                    if (el) swipe.mobileTabRefs.current.set(index, el);
                    else swipe.mobileTabRefs.current.delete(index);
                  }}
                  onClick={() => swipe.selectTab(index)}
                  className={clsx(
                    'flex-shrink-0 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap min-h-[44px] flex items-center gap-1.5',
                    index === swipe.mobileActiveColumnIndex
                      ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                      : 'border-transparent text-neutral-500 dark:text-neutral-400 active:text-neutral-700 dark:active:text-neutral-300'
                  )}
                >
                  {col.title}
                  <span
                    className={clsx(
                      'inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold',
                      index === swipe.mobileActiveColumnIndex
                        ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400'
                    )}
                  >
                    {col.cards.length}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Board content */}
        {isMobile ? (
          // Mobile: sliding column carousel with smooth swipe
          <div
            className="flex-1 overflow-hidden"
            onTouchStart={swipe.handleTouchStart}
            onTouchMove={swipe.handleTouchMove}
            onTouchEnd={swipe.handleTouchEnd}
          >
            {displayColumns.length > 0 ? (
              <div
                ref={swipe.swipeContainerRef}
                className="flex h-full"
                style={{
                  transform: `translateX(calc(-${swipe.mobileActiveColumnIndex * 100}% + ${swipe.swipeOffset}px))`,
                  transition: swipe.isSwipeTransitioning ? 'transform 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94)' : 'none',
                  willChange: 'transform',
                }}
              >
                {displayColumns.map((col) => (
                  <div key={col.id} className="w-full flex-shrink-0 overflow-y-auto p-4 [&>div]:!w-full [&>div]:!min-w-0">
                    <KanbanColumn
                      column={col}
                      boardId={boardId}
                      onCardSelect={(cardId) => setSelectedCardId(cardId)}
                      onRenameColumn={handleRenameColumn}
                      onDeleteColumn={handleDeleteColumn}
                      onAddCard={handleAddCard}
                      onToggleCompletion={!readOnly ? handleToggleColumnCompletion : undefined}
                      readOnly={readOnly || filtersActive}
                      highlightedCardIds={highlightedCardIds}
                      allColumns={displayColumns}
                      onMoveCardToColumn={dnd.handleMoveCardToColumn}
                    />
                  </div>
                ))}
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
          <div ref={setBoardContainerEl} className="flex-1 overflow-x-auto overflow-y-hidden">
            <DndContext
              sensors={dnd.sensors}
              collisionDetection={dnd.kanbanCollisionDetection}
              onDragStart={dnd.handleDragStart}
              onDragOver={dnd.handleDragOver}
              onDragEnd={dnd.handleDragEnd}
            >
              <div className="flex gap-4 p-4 h-full items-start">
                <SortableContext items={dnd.columnIds} strategy={horizontalListSortingStrategy}>
                  {displayColumns.map((column) => (
                    <KanbanColumn
                      key={column.id}
                      column={column}
                      boardId={boardId}
                      onCardSelect={(cardId) => setSelectedCardId(cardId)}
                      onRenameColumn={handleRenameColumn}
                      onDeleteColumn={handleDeleteColumn}
                      onAddCard={handleAddCard}
                      onToggleCompletion={!readOnly ? handleToggleColumnCompletion : undefined}
                      readOnly={readOnly || filtersActive}
                      highlightedCardIds={highlightedCardIds}
                      allColumns={displayColumns}
                      onMoveCardToColumn={dnd.handleMoveCardToColumn}
                      selectedCardIds={marquee.selectedCardIds}
                      onCardContextMenu={handleCardContextMenu}
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
                {dnd.activeCard ? (
                  <div className="opacity-90">
                    <KanbanCard
                      card={dnd.activeCard}
                      onSelect={() => {}}
                      readOnly
                    />
                  </div>
                ) : dnd.activeColumn ? (
                  <div className="opacity-90">
                    <KanbanColumn
                      column={dnd.activeColumn}
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

            {/* Marquee selection rectangle */}
            {marquee.marqueeRect && (
              <div
                className="fixed pointer-events-none border border-blue-500/50 bg-blue-500/10 rounded-sm z-50"
                style={{
                  left: marquee.marqueeRect.x,
                  top: marquee.marqueeRect.y,
                  width: marquee.marqueeRect.width,
                  height: marquee.marqueeRect.height,
                }}
              />
            )}

            {/* Bulk move menu after marquee selection */}
            {marquee.menuPosition && marquee.selectedCardIds.size > 0 && board && (
              <BulkMoveMenu
                selectedCount={marquee.selectedCardIds.size}
                position={marquee.menuPosition}
                columns={board.columns}
                onMove={handleBulkMove}
                onCancel={marquee.clearSelection}
              />
            )}

            {/* Card context menu (right-click) */}
            {contextMenu && board && (
              <CardContextMenu
                card={contextMenu.card}
                position={contextMenu.position}
                board={board}
                currentColumnId={contextMenu.columnId}
                onClose={() => setContextMenu(null)}
                onMoveToColumn={dnd.handleMoveCardToColumn}
                onAssign={handleContextAssign}
                onSetPriority={handleContextPriority}
                onSetDueDate={handleContextDueDate}
                onLinkNote={handleContextLinkNote}
                onDuplicate={handleContextDuplicate}
                onDelete={handleContextDelete}
              />
            )}

            {/* NoteLinkPicker for context menu "Link note" action */}
            {noteLinkCardId && (
              <NoteLinkPicker
                isOpen={!!noteLinkCardId}
                onClose={() => setNoteLinkCardId(null)}
                onSelect={(note) => {
                  mutations.linkNote.mutate({ cardId: noteLinkCardId, noteId: note.id });
                  setNoteLinkCardId(null);
                }}
              />
            )}
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
          isOpen={modals.isChatOpen}
          onClose={() => modals.setIsChatOpen(false)}
          currentUser={{
            id: user?.id || 'anon',
            name: user?.name || 'User',
            color: userColor,
            avatarUrl: user?.avatarUrl || null,
          }}
          onNewMessage={modals.incrementUnread}
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
        columns={board.columns}
      />

      {/* Share Modal */}
      {isOwner && (
        <ShareBoardModal
          isOpen={modals.isShareOpen}
          onClose={() => modals.setIsShareOpen(false)}
          boardId={boardId}
          boardTitle={board.title}
          sharedWith={board.shares?.filter((s) => s.status === 'ACCEPTED')}
        />
      )}

      {/* Board note picker + sharing gap modal */}
      <NoteLinkPicker
        isOpen={modals.isNoteLinkPickerOpen}
        onClose={() => modals.setIsNoteLinkPickerOpen(false)}
        onSelect={handleBoardNoteSelected}
      />
      {boardSharingCheck && (
        <SharingGapModal
          isOpen={modals.isBoardSharingGapOpen}
          onClose={() => {
            modals.setIsBoardSharingGapOpen(false);
            setBoardSharingCheck(null);
            setPendingBoardNote(null);
          }}
          sharingCheck={boardSharingCheck}
          onConfirm={handleBoardNoteSharingConfirm}
          isPending={mutations.linkBoardNote.isPending}
        />
      )}

      <ConfirmDialog
        isOpen={modals.showDeleteBoardConfirm}
        onClose={() => modals.setShowDeleteBoardConfirm(false)}
        onConfirm={() => mutations.deleteBoard.mutate(boardId, { onSuccess: () => navigate('/kanban') })}
        title={t('kanban.deleteBoard')}
        message={t('kanban.deleteBoardConfirm')}
        confirmText={t('common.delete')}
        variant="danger"
      />

      {/* Archived cards modal */}
      <ArchivedCardsModal
        isOpen={modals.isArchiveOpen}
        onClose={() => modals.setIsArchiveOpen(false)}
        boardId={boardId}
        onUnarchive={() => {
          // Board data will be refetched via invalidateBoard in the mutation
        }}
      />

      {/* Task list link picker */}
      <TaskListLinkPicker
        isOpen={modals.isTaskListPickerOpen}
        onClose={() => modals.setIsTaskListPickerOpen(false)}
        onSelect={handleLinkTaskList}
      />
    </div>
  );
}
