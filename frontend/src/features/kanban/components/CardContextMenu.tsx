import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  UserPlus,
  Flag,
  Calendar,
  FileText,
  Copy,
  Trash2,
  ChevronRight,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { PRIORITY_CONFIG, type PriorityLevel } from '../../../utils/priorityConfig';
import type { KanbanCard, KanbanBoard } from '../types';

interface CardContextMenuProps {
  card: KanbanCard;
  position: { x: number; y: number };
  board: KanbanBoard;
  currentColumnId: string;
  onClose: () => void;
  onMoveToColumn: (cardId: string, columnId: string) => void;
  onAssign: (cardId: string, assigneeId: string | null) => void;
  onSetPriority: (cardId: string, priority: PriorityLevel | null) => void;
  onSetDueDate: (cardId: string, dueDate: string | null) => void;
  onLinkNote: (cardId: string) => void;
  onDuplicate: (cardId: string) => void;
  onDelete: (cardId: string) => void;
}

interface BoardMember {
  id: string;
  name: string | null;
  email: string;
  color: string | null;
  avatarUrl: string | null;
}

const MENU_WIDTH = 220;
const MENU_ITEM_HEIGHT = 36;
const SUBMENU_WIDTH = 240;

export default function CardContextMenu({
  card,
  position,
  board,
  currentColumnId,
  onClose,
  onMoveToColumn,
  onAssign,
  onSetPriority,
  onSetDueDate,
  onLinkNote,
  onDuplicate,
  onDelete,
}: CardContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [menuPos, setMenuPos] = useState(position);
  const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute viewport-bounded position
  useEffect(() => {
    const menuHeight = 7 * MENU_ITEM_HEIGHT + 2 * 8 + 2; // items + separators + padding
    const x = Math.min(position.x, window.innerWidth - MENU_WIDTH - 8);
    const y = Math.min(position.y, window.innerHeight - menuHeight - 8);
    setMenuPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [position]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Use setTimeout to avoid the context menu's own right-click from closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  const handleSubmenuEnter = useCallback((key: string) => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
    setActiveSubmenu(key);
  }, []);

  const handleSubmenuLeave = useCallback(() => {
    submenuTimeoutRef.current = setTimeout(() => {
      setActiveSubmenu(null);
    }, 150);
  }, []);

  // Board members: owner + accepted shared users
  const boardMembers: BoardMember[] = (() => {
    const members: BoardMember[] = [];
    if (board.owner) {
      members.push({
        id: board.owner.id,
        name: board.owner.name,
        email: board.owner.email,
        color: board.owner.color,
        avatarUrl: board.owner.avatarUrl,
      });
    }
    if (board.shares) {
      for (const share of board.shares) {
        if (share.status === 'ACCEPTED') {
          members.push({
            id: share.user.id,
            name: share.user.name,
            email: share.user.email,
            color: null,
            avatarUrl: share.user.avatarUrl ?? null,
          });
        }
      }
    }
    return members;
  })();

  // Other columns (exclude current)
  const otherColumns = board.columns.filter((col) => col.id !== currentColumnId);

  // Priority levels
  const priorityLevels: PriorityLevel[] = ['STANDBY', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  const handleDueDateClick = () => {
    if (card.dueDate) {
      onSetDueDate(card.id, null);
      onClose();
    } else {
      // Create hidden date input and trigger picker
      const input = dateInputRef.current;
      if (input) {
        input.value = '';
        input.showPicker();
      }
    }
  };

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value) {
      onSetDueDate(card.id, new Date(value).toISOString());
      onClose();
    }
  };

  const computeSubmenuPosition = (itemIndex: number) => {
    const rightSpace = window.innerWidth - (menuPos.x + MENU_WIDTH);
    const submenuX =
      rightSpace >= SUBMENU_WIDTH + 8
        ? menuPos.x + MENU_WIDTH + 2
        : menuPos.x - SUBMENU_WIDTH - 2;
    const submenuY = menuPos.y + itemIndex * MENU_ITEM_HEIGHT;
    // Clamp vertically
    const clampedY = Math.max(8, Math.min(submenuY, window.innerHeight - 300));
    return { x: submenuX, y: clampedY };
  };

  const avatarCircle = (member: BoardMember) => {
    const initial = (member.name || member.email)[0].toUpperCase();
    if (member.avatarUrl) {
      return (
        <img
          src={member.avatarUrl}
          alt=""
          className="h-6 w-6 rounded-full object-cover"
          loading="lazy"
          decoding="async"
        />
      );
    }
    return (
      <div
        className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium text-white"
        style={{ backgroundColor: member.color || '#6b7280' }}
      >
        {initial}
      </div>
    );
  };

  const itemClass =
    'flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors cursor-pointer';
  const activeItemClass = 'bg-neutral-100 dark:bg-neutral-700';
  const deleteItemClass =
    'flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer';
  const separator = 'my-1 border-t border-neutral-200 dark:border-neutral-700';

  const submenuContainerClass =
    'fixed z-[101] min-w-[200px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 shadow-xl rounded-lg py-1 overflow-y-auto max-h-[60vh]';

  return createPortal(
    <>
      {/* Main menu */}
      <div
        ref={menuRef}
        className="fixed z-[100] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 shadow-xl rounded-lg py-1"
        style={{ left: menuPos.x, top: menuPos.y, width: MENU_WIDTH }}
      >
        {/* Move to */}
        <div
          className={`${itemClass} justify-between`}
          onMouseEnter={() => handleSubmenuEnter('move')}
          onMouseLeave={handleSubmenuLeave}
        >
          <span className="flex items-center gap-2">
            <ArrowRight className="h-4 w-4" />
            {t('kanban.card.contextMenu.moveTo')}
          </span>
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        </div>

        {/* Assign to */}
        <div
          className={`${itemClass} justify-between`}
          onMouseEnter={() => handleSubmenuEnter('assign')}
          onMouseLeave={handleSubmenuLeave}
        >
          <span className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            {t('kanban.card.contextMenu.assignTo')}
          </span>
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        </div>

        {/* Priority */}
        <div
          className={`${itemClass} justify-between`}
          onMouseEnter={() => handleSubmenuEnter('priority')}
          onMouseLeave={handleSubmenuLeave}
        >
          <span className="flex items-center gap-2">
            <Flag className="h-4 w-4" />
            {t('kanban.card.contextMenu.priority')}
          </span>
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        </div>

        {/* Due date */}
        <button className={itemClass} onClick={handleDueDateClick}>
          <Calendar className="h-4 w-4" />
          {card.dueDate
            ? t('kanban.card.contextMenu.clearDueDate')
            : t('kanban.card.contextMenu.setDueDate')}
        </button>

        {/* Link note */}
        <button
          className={itemClass}
          onClick={() => {
            onLinkNote(card.id);
            onClose();
          }}
        >
          <FileText className="h-4 w-4" />
          {t('kanban.card.contextMenu.linkNote')}
        </button>

        <div className={separator} />

        {/* Duplicate */}
        <button
          className={itemClass}
          onClick={() => {
            onDuplicate(card.id);
            onClose();
          }}
        >
          <Copy className="h-4 w-4" />
          {t('kanban.card.contextMenu.duplicate')}
        </button>

        <div className={separator} />

        {/* Delete */}
        <button
          className={deleteItemClass}
          onClick={() => setShowDeleteConfirm(true)}
        >
          <Trash2 className="h-4 w-4" />
          {t('kanban.card.contextMenu.delete')}
        </button>

        {/* Hidden date input */}
        <input
          ref={dateInputRef}
          type="date"
          className="absolute opacity-0 pointer-events-none h-0 w-0"
          tabIndex={-1}
          onChange={handleDateChange}
        />
      </div>

      {/* Move to submenu */}
      {activeSubmenu === 'move' && otherColumns.length > 0 && (
        <div
          className={submenuContainerClass}
          style={{
            left: computeSubmenuPosition(0).x,
            top: computeSubmenuPosition(0).y,
            width: SUBMENU_WIDTH,
          }}
          onMouseEnter={() => handleSubmenuEnter('move')}
          onMouseLeave={handleSubmenuLeave}
        >
          {otherColumns.map((col) => (
            <button
              key={col.id}
              className={`${itemClass} justify-between`}
              onClick={() => {
                onMoveToColumn(card.id, col.id);
                onClose();
              }}
            >
              <span className="truncate">{col.title}</span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500 ml-2 shrink-0">
                {col.cards.length}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Assign to submenu */}
      {activeSubmenu === 'assign' && (
        <div
          className={submenuContainerClass}
          style={{
            left: computeSubmenuPosition(1).x,
            top: computeSubmenuPosition(1).y,
            width: SUBMENU_WIDTH,
          }}
          onMouseEnter={() => handleSubmenuEnter('assign')}
          onMouseLeave={handleSubmenuLeave}
        >
          {/* Unassigned option */}
          <button
            className={`${itemClass} ${card.assigneeId === null ? activeItemClass : ''}`}
            onClick={() => {
              onAssign(card.id, null);
              onClose();
            }}
          >
            <X className="h-4 w-4 text-neutral-400" />
            <span>{t('kanban.card.contextMenu.unassigned')}</span>
          </button>
          {boardMembers.map((member) => (
            <button
              key={member.id}
              className={`${itemClass} ${card.assigneeId === member.id ? activeItemClass : ''}`}
              onClick={() => {
                onAssign(card.id, member.id);
                onClose();
              }}
            >
              {avatarCircle(member)}
              <span className="truncate">
                {member.name || member.email}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Priority submenu */}
      {activeSubmenu === 'priority' && (
        <div
          className={submenuContainerClass}
          style={{
            left: computeSubmenuPosition(2).x,
            top: computeSubmenuPosition(2).y,
            width: SUBMENU_WIDTH,
          }}
          onMouseEnter={() => handleSubmenuEnter('priority')}
          onMouseLeave={handleSubmenuLeave}
        >
          {/* No priority */}
          <button
            className={`${itemClass} ${card.priority === null ? activeItemClass : ''}`}
            onClick={() => {
              onSetPriority(card.id, null);
              onClose();
            }}
          >
            <X className="h-4 w-4 text-neutral-400" />
            <span>{t('kanban.card.contextMenu.noPriority')}</span>
          </button>
          {priorityLevels.map((level) => {
            const config = PRIORITY_CONFIG[level];
            const Icon = config.icon;
            return (
              <button
                key={level}
                className={`${itemClass} ${card.priority === level ? activeItemClass : ''}`}
                onClick={() => {
                  onSetPriority(card.id, level);
                  onClose();
                }}
              >
                <Icon className={`h-4 w-4 ${config.color}`} />
                <span>{t(`kanban.priority.${level}`)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => {
          setShowDeleteConfirm(false);
          onClose();
        }}
        onConfirm={() => {
          onDelete(card.id);
          onClose();
        }}
        title={t('kanban.card.deleteCard')}
        message={t('kanban.card.deleteConfirm')}
        variant="danger"
      />
    </>,
    document.body,
  );
}
