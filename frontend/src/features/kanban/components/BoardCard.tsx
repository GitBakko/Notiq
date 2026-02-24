import { useState, useRef, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { MoreVertical, Share2, Trash2, Columns3, CreditCard, Kanban } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { KanbanBoardListItem } from '../types';

interface BoardCardProps {
  board: KanbanBoardListItem;
  onSelect: (boardId: string) => void;
  onShare: (boardId: string) => void;
  onDelete: (boardId: string) => void;
}

export default function BoardCard({ board, onSelect, onShare, onDelete }: BoardCardProps) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
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

    if (window.confirm(t('kanban.deleteBoardConfirm'))) {
      onDelete(board.id);
    }
  }

  return (
    <div
      onClick={() => onSelect(board.id)}
      className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow cursor-pointer relative group overflow-hidden"
    >
      {/* Cover Image */}
      {board.coverImage && (
        <div className="h-32 w-full overflow-hidden">
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
                'p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity',
                board.coverImage
                  ? 'text-white hover:text-white bg-black/30 hover:bg-black/50'
                  : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300',
              )}
            >
              <MoreVertical size={16} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 w-40 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg py-1">
                <button
                  onClick={handleShare}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <Share2 size={14} />
                  {t('sharing.title')}
                </button>
                <button
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
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
          <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate">
            {board.title}
          </h3>
        </div>

        {/* Description */}
        {board.description ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
            {board.description}
          </p>
        ) : (
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 italic">
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
              <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                {t('kanban.ownerLabel', { name: board.owner.name || board.owner.email })}
              </span>
            )}
          </div>
        )}

        {/* Footer stats */}
        <div className="mt-3 flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
          <span className="flex items-center gap-1">
            <Columns3 size={12} />
            {t('kanban.stats.columns', { count: board.columnCount })}
          </span>
          <span className="flex items-center gap-1">
            <CreditCard size={12} />
            {t('kanban.stats.cards', { count: board.cardCount })}
          </span>
          <span className="ml-auto">
            {formatDistanceToNow(new Date(board.updatedAt), { addSuffix: true, locale: dateLocale })}
          </span>
        </div>
      </div>
    </div>
  );
}
