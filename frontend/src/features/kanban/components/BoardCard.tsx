import { useState, useRef, useEffect } from 'react';
import { timeAgo } from '../../../utils/format';
import { it as itLocale, enUS } from 'date-fns/locale';
import { MoreVertical, Share2, Trash2, Columns3, CreditCard, Kanban, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import type { KanbanBoardListItem } from '../types';

interface BoardCardProps {
  board: KanbanBoardListItem;
  onSelect: (boardId: string) => void;
  onShare: (boardId: string) => void;
  onDelete: (boardId: string) => void;
  onViewShares?: (boardId: string) => void;
}

export default function BoardCard({ board, onSelect, onShare, onDelete, onViewShares }: BoardCardProps) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const dateLocale = i18n.language.startsWith('it') ? itLocale : enUS;
  const isOwned = board.ownership === 'owned';

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;

    function handleClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  function handleMenuToggle(e: React.MouseEvent): void {
    e.stopPropagation();
    setMenuOpen((prev) => !prev);
  }

  function handleShare(e: React.MouseEvent): void {
    e.stopPropagation();
    setMenuOpen(false);
    onShare(board.id);
  }

  function handleDelete(e: React.MouseEvent): void {
    e.stopPropagation();
    setMenuOpen(false);
    setShowDeleteConfirm(true);
  }

  return (
    <div
      onClick={() => onSelect(board.id)}
      className="rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 hover:shadow-md transition-shadow cursor-pointer relative group hover-lift"
    >
      {/* Cover Image */}
      {board.coverImage && (
        <div className="h-32 w-full overflow-hidden rounded-t-xl">
          <img
            src={board.coverImage}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="p-4">
        {/* Context menu button */}
        {isOwned && (
          <div ref={menuRef} className="absolute top-3 right-3 z-10">
            <button
              onClick={handleMenuToggle}
              className={clsx(
                'p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 opacity-0 group-hover:opacity-100 transition-opacity',
                board.coverImage
                  ? 'text-white hover:text-white bg-black/30 hover:bg-black/50'
                  : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300',
              )}
            >
              <MoreVertical size={16} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 w-40 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 shadow-lg py-1">
                <button
                  onClick={handleShare}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  <Share2 size={14} />
                  {t('kanban.shareBoard')}
                </button>
                <button
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                >
                  <Trash2 size={14} />
                  {t('common.delete')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Title row with avatar */}
        <div className="flex items-center gap-2 pr-8">
          {board.avatarUrl ? (
            <img
              src={board.avatarUrl}
              alt=""
              className="w-6 h-6 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
              <Kanban size={12} className="text-emerald-600 dark:text-emerald-400" />
            </div>
          )}
          <h3 className="text-sm font-bold text-neutral-900 dark:text-white truncate">
            {board.title}
          </h3>
        </div>

        {/* Description */}
        {board.description ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
            {board.description}
          </p>
        ) : (
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-400 italic">
            {t('kanban.card.noDescription')}
          </p>
        )}

        {/* Shared badge + owner */}
        {board.ownership === 'shared' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
              {t('kanban.sharedBoard')}
            </span>
            {board.owner && (
              <span className="text-[10px] text-neutral-400 dark:text-neutral-400 truncate">
                {t('kanban.ownerLabel', { name: board.owner.name || board.owner.email })}
              </span>
            )}
          </div>
        )}

        {/* Footer stats */}
        <div className="mt-3 flex items-center gap-3 text-xs text-neutral-400 dark:text-neutral-400">
          <span className="flex items-center gap-1">
            <Columns3 size={12} />
            {t('kanban.stats.columns', { count: board.columnCount })}
          </span>
          <span className="flex items-center gap-1">
            <CreditCard size={12} />
            {t('kanban.stats.cards', { count: board.cardCount })}
          </span>
          {board.shareCount != null && board.shareCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onViewShares?.(board.id); }}
              className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
              title={t('sharing.sharedWithCount', { count: board.shareCount })}
            >
              <Users size={12} />
              <span className="text-[10px] font-medium">{board.shareCount}</span>
            </button>
          )}
          <span className="ml-auto">
            {timeAgo(board.updatedAt, dateLocale)}
          </span>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => onDelete(board.id)}
        title={t('kanban.deleteBoard')}
        message={t('kanban.deleteBoardConfirm')}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </div>
  );
}
