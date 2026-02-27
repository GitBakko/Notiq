import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow, isPast, startOfDay, isToday, format } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { Send, Trash2, X, Calendar, User, FileText, Activity, Link2, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import Modal from '../../../components/ui/Modal';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { useKanbanComments } from '../hooks/useKanbanComments';
import { useKanbanMutations } from '../hooks/useKanbanMutations';
import { useAuthStore } from '../../../store/authStore';
import * as kanbanService from '../kanbanService';
import type { KanbanCard, KanbanCardActivity, NoteSearchResult, NoteSharingCheck } from '../types';
import { DEFAULT_COLUMN_KEYS } from '../types';
import NoteLinkPicker from './NoteLinkPicker';
import SharingGapModal from './SharingGapModal';

interface CardDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: KanbanCard | null;
  boardId: string;
  readOnly?: boolean;
}

function isDueOverdue(dueDate: string): boolean {
  const due = startOfDay(new Date(dueDate));
  return isPast(due) && !isToday(due);
}

function formatDueDate(dueDate: string): string {
  return new Date(dueDate).toISOString().split('T')[0];
}

export default function CardDetailModal({
  isOpen,
  onClose,
  card,
  boardId,
  readOnly = false,
}: CardDetailModalProps) {
  const { t, i18n } = useTranslation();
  const currentUser = useAuthStore((s) => s.user);
  const dateLocale = i18n.language?.startsWith('it') ? itLocale : enUS;

  const { updateCard, deleteCard, linkNote, unlinkNote } = useKanbanMutations(boardId);
  const { comments, isLoading: commentsLoading, addComment, removeComment } = useKanbanComments(card?.id);

  const { data: activities, isLoading: activitiesLoading } = useQuery({
    queryKey: ['kanban-card-activities', card?.id],
    queryFn: () => kanbanService.getCardActivities(card!.id),
    enabled: isOpen && !!card?.id,
  });

  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [commentText, setCommentText] = useState('');

  // Note linking state
  const [isNotePickerOpen, setIsNotePickerOpen] = useState(false);
  const [sharingCheck, setSharingCheck] = useState<NoteSharingCheck | null>(null);
  const [pendingNote, setPendingNote] = useState<NoteSearchResult | null>(null);
  const [isSharingGapOpen, setIsSharingGapOpen] = useState(false);
  const [showDeleteCardConfirm, setShowDeleteCardConfirm] = useState(false);

  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Sync local state when card changes
  useEffect(() => {
    if (card) {
      setEditTitle(card.title);
      setEditDescription(card.description ?? '');
    }
  }, [card?.id, card?.title, card?.description]);

  // Auto-resize description textarea
  useEffect(() => {
    const textarea = descriptionRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [editDescription]);

  if (!card) return null;

  function handleTitleBlur(): void {
    if (!card) return;
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== card.title) {
      updateCard.mutate({ cardId: card.id, title: trimmed });
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }

  function handleDescriptionBlur(): void {
    if (!card) return;
    const newDescription = editDescription.trim() || null;
    if (newDescription !== (card.description ?? null)) {
      updateCard.mutate({ cardId: card.id, description: newDescription });
    }
  }

  function handleDueDateChange(e: React.ChangeEvent<HTMLInputElement>): void {
    if (!card) return;
    const value = e.target.value;
    updateCard.mutate({
      cardId: card.id,
      dueDate: value || null,
    });
  }

  function handleClearAssignee(): void {
    if (!card) return;
    updateCard.mutate({ cardId: card.id, assigneeId: null });
  }

  function handleUnlinkNote(): void {
    if (!card) return;
    unlinkNote.mutate(card.id, {
      onSuccess: () => setSharingCheck(null),
    });
  }

  async function handleNoteSelected(note: NoteSearchResult): Promise<void> {
    if (!card) return;
    setIsNotePickerOpen(false);
    setPendingNote(note);

    try {
      const check = await kanbanService.checkNoteSharing(card.id, note.id);
      if (check.alreadyFullyShared) {
        // No sharing gap — link directly
        linkNote.mutate({ cardId: card.id, noteId: note.id });
        setPendingNote(null);
      } else {
        // Show sharing gap modal
        setSharingCheck(check);
        setIsSharingGapOpen(true);
      }
    } catch {
      setPendingNote(null);
    }
  }

  function handleSharingConfirm(selectedUserIds: string[]): void {
    if (!card || !pendingNote) return;
    linkNote.mutate(
      { cardId: card.id, noteId: pendingNote.id, shareWithUserIds: selectedUserIds },
      {
        onSuccess: () => {
          setIsSharingGapOpen(false);
          setSharingCheck(null);
          setPendingNote(null);
        },
      },
    );
  }

  function handleDeleteCard(): void {
    if (!card) return;
    setShowDeleteCardConfirm(true);
  }

  function handleSendComment(): void {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    addComment.mutate(trimmed, {
      onSuccess: () => setCommentText(''),
    });
  }

  function handleCommentKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendComment();
    }
  }

  function translateColumnTitle(title: string): string {
    const key = DEFAULT_COLUMN_KEYS[title];
    return key ? t(key) : title;
  }

  function getActivityText(activity: KanbanCardActivity): string {
    const meta = activity.metadata as Record<string, string> | null;
    switch (activity.action) {
      case 'CREATED':
        return t('kanban.activity.CREATED', { column: translateColumnTitle(activity.toColumnTitle || '') });
      case 'MOVED':
        return t('kanban.activity.MOVED', {
          from: translateColumnTitle(activity.fromColumnTitle || ''),
          to: translateColumnTitle(activity.toColumnTitle || ''),
        });
      case 'ASSIGNED':
        return t('kanban.activity.ASSIGNED', { assignee: meta?.assigneeName || '?' });
      case 'UNASSIGNED':
        return t('kanban.activity.UNASSIGNED');
      case 'DUE_DATE_SET':
        return t('kanban.activity.DUE_DATE_SET', {
          date: meta?.dueDate ? format(new Date(meta.dueDate), 'dd/MM/yyyy') : '?',
        });
      case 'DUE_DATE_REMOVED':
        return t('kanban.activity.DUE_DATE_REMOVED');
      case 'UPDATED': {
        const field = meta?.field === 'title' ? t('kanban.activity.fieldTitle') : t('kanban.activity.fieldDescription');
        return t('kanban.activity.UPDATED', { field });
      }
      case 'NOTE_LINKED':
        return t('kanban.activity.NOTE_LINKED', { noteTitle: meta?.noteTitle || '?' });
      case 'NOTE_UNLINKED':
        return t('kanban.activity.NOTE_UNLINKED', { noteTitle: meta?.noteTitle || '?' });
      case 'DELETED':
        return t('kanban.activity.DELETED');
      default:
        return activity.action;
    }
  }

  const overdue = card.dueDate ? isDueOverdue(card.dueDate) : false;

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={card.title || t('kanban.card.untitled')}
      size="lg"
    >
      <div className="max-h-[70vh] overflow-y-auto space-y-6">
        {/* Title */}
        <div>
          {readOnly ? (
            <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
              {card.title || t('kanban.card.untitled')}
            </h4>
          ) : (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              className="w-full text-lg font-semibold text-gray-900 dark:text-white bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none pb-1 transition-colors"
              placeholder={t('kanban.card.cardTitle')}
            />
          )}
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            {t('kanban.card.description')}
          </label>
          {readOnly ? (
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
              {card.description || t('kanban.card.noDescription')}
            </p>
          ) : (
            <textarea
              ref={descriptionRef}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              onBlur={handleDescriptionBlur}
              placeholder={t('kanban.card.noDescription')}
              rows={2}
              className="w-full text-sm text-gray-700 dark:text-gray-300 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg p-2 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none resize-none transition-colors"
            />
          )}
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-4">
          {/* Assignee */}
          <div>
            <label className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              <User size={12} />
              {t('kanban.card.assignee')}
            </label>
            {card.assignee ? (
              <div className="flex items-center gap-2">
                {card.assignee.avatarUrl ? (
                  <img src={card.assignee.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" loading="lazy" decoding="async" />
                ) : (
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: card.assignee.color || '#6b7280' }}
                  >
                    {(card.assignee.name || card.assignee.email).charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                  {card.assignee.name || card.assignee.email}
                </span>
                {!readOnly && (
                  <button
                    onClick={handleClearAssignee}
                    className="ml-auto text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
                    title={t('common.delete')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-500 italic">
                {t('kanban.card.unassigned')}
              </p>
            )}
          </div>

          {/* Due date */}
          <div>
            <label className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              <Calendar size={12} />
              {t('kanban.card.dueDate')}
            </label>
            {readOnly ? (
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'text-sm',
                  overdue
                    ? 'text-red-600 dark:text-red-400 font-medium'
                    : 'text-gray-700 dark:text-gray-300'
                )}>
                  {card.dueDate ? formatDueDate(card.dueDate) : '-'}
                </span>
                {overdue && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    {t('kanban.card.overdue')}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={card.dueDate ? formatDueDate(card.dueDate) : ''}
                  onChange={handleDueDateChange}
                  className="text-sm text-gray-700 dark:text-gray-300 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none transition-colors"
                />
                {overdue && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    {t('kanban.card.overdue')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Linked note */}
          <div className="col-span-2">
            <label className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              <FileText size={12} />
              {t('kanban.card.linkedNote')}
            </label>
            {card.note ? (
              <div className="flex items-center gap-2">
                <a
                  href={`/notes?noteId=${card.note.id}`}
                  className="text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
                >
                  {card.note.title}
                </a>
                {/* Only the linker can unlink */}
                {!readOnly && currentUser?.id === card.noteLinkedById && (
                  <button
                    onClick={handleUnlinkNote}
                    disabled={unlinkNote.isPending}
                    className="ml-auto text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors flex-shrink-0 disabled:opacity-50"
                    title={t('kanban.noteLink.unlink')}
                  >
                    <Unlink size={14} />
                  </button>
                )}
              </div>
            ) : card.noteId ? (
              // Card has a linked note but user has no access
              <p className="text-sm text-gray-400 dark:text-gray-500 italic">-</p>
            ) : !readOnly ? (
              <button
                onClick={() => setIsNotePickerOpen(true)}
                className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
              >
                <Link2 size={14} />
                {t('kanban.noteLink.linkNote')}
              </button>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-500 italic">-</p>
            )}
          </div>
        </div>

        {/* Comments section */}
        <div>
          <h5 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
            {t('kanban.comment.comments')}
            {comments && comments.length > 0 && (
              <span className="ml-1 text-gray-400 dark:text-gray-500">({comments.length})</span>
            )}
          </h5>

          {commentsLoading ? (
            <div className="flex justify-center py-4">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : comments && comments.length > 0 ? (
            <div className="space-y-3 mb-3">
              {comments.map((comment) => (
                <div key={comment.id} className="flex gap-2">
                  {comment.author.avatarUrl ? (
                    <img src={comment.author.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0 mt-0.5" loading="lazy" decoding="async" />
                  ) : (
                    <span
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: comment.author.color || '#6b7280' }}
                    >
                      {(comment.author.name || comment.author.email).charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {comment.author.name || comment.author.email}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
                        {formatDistanceToNow(new Date(comment.createdAt), {
                          addSuffix: true,
                          locale: dateLocale,
                        })}
                      </span>
                      {currentUser?.id === comment.author.id && (
                        <button
                          onClick={() => removeComment.mutate(comment.id)}
                          className="ml-auto text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words mt-0.5">
                      {comment.content}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic mb-3">
              {t('kanban.comment.noComments')}
            </p>
          )}

          {/* Compose comment */}
          {!readOnly && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={handleCommentKeyDown}
                placeholder={t('kanban.comment.placeholder')}
                className="flex-1 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-500"
              />
              <button
                onClick={handleSendComment}
                disabled={!commentText.trim() || addComment.isPending}
                className="p-2 text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={t('kanban.comment.send')}
              >
                <Send size={18} />
              </button>
            </div>
          )}
        </div>

        {/* Activity section */}
        <div>
          <h5 className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
            <Activity size={12} />
            {t('kanban.activity.title')}
          </h5>

          {activitiesLoading ? (
            <div className="flex justify-center py-4">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : activities && activities.length > 0 ? (
            <div className="space-y-2.5 max-h-48 overflow-y-auto">
              {activities.map((activity) => (
                <div key={activity.id} className="flex gap-2 items-start">
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0 mt-0.5 overflow-hidden relative"
                    style={{ backgroundColor: activity.user.color || '#6b7280' }}
                  >
                    {activity.user.avatarUrl && (
                      <img
                        src={activity.user.avatarUrl}
                        alt=""
                        className="w-full h-full object-cover absolute inset-0"
                      />
                    )}
                    <span className="relative z-10" style={{ textShadow: '0 0 3px rgba(0,0,0,0.6)' }}>
                      {(activity.user.name || activity.user.email).charAt(0).toUpperCase()}
                    </span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      <span className="font-medium text-gray-800 dark:text-white">
                        {activity.user.name || activity.user.email.split('@')[0]}
                      </span>
                      {' '}
                      {getActivityText(activity)}
                    </p>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
                      {formatDistanceToNow(new Date(activity.createdAt), {
                        addSuffix: true,
                        locale: dateLocale,
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic">
              {t('kanban.activity.noActivity')}
            </p>
          )}
        </div>

        {/* Delete card button */}
        {!readOnly && (
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleDeleteCard}
              className="text-sm text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors"
            >
              {t('kanban.card.deleteCard')}
            </button>
          </div>
        )}
      </div>

      {/* Note Link Picker */}
      <NoteLinkPicker
        isOpen={isNotePickerOpen}
        onClose={() => setIsNotePickerOpen(false)}
        onSelect={handleNoteSelected}
      />

      {/* Sharing Gap Modal */}
      {sharingCheck && (
        <SharingGapModal
          isOpen={isSharingGapOpen}
          onClose={() => {
            setIsSharingGapOpen(false);
            setSharingCheck(null);
            setPendingNote(null);
          }}
          sharingCheck={sharingCheck}
          onConfirm={handleSharingConfirm}
          isPending={linkNote.isPending}
        />
      )}
    </Modal>

    <ConfirmDialog
      isOpen={showDeleteCardConfirm}
      onClose={() => setShowDeleteCardConfirm(false)}
      onConfirm={() => {
        if (card) {
          deleteCard.mutate(card.id);
          onClose();
        }
      }}
      title={t('kanban.card.deleteCard')}
      message={t('kanban.card.deleteConfirm')}
      confirmText={t('common.delete')}
      variant="danger"
    />
    </>
  );
}
