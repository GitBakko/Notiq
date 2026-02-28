import { timeAgo } from '../../utils/format';
import { it as itLocale, enUS } from 'date-fns/locale';
import { Share2, Info, Calendar, Trash2, Check, Orbit, MessageSquare, ListChecks, Kanban } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Notification } from './notificationService';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

interface NotificationItemProps {
  notification: Notification;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
  onClose?: () => void;
}

/** Resolve a contextual URL for the notification, or null if no navigation target */
function getNotificationUrl(notification: Notification): string | null {
  const data = (notification.data || {}) as Record<string, string>;

  switch (notification.type) {
    case 'SHARE_NOTE':
      return data.noteId ? `/shared?tab=notes&highlight=${data.noteId}` : '/shared';
    case 'SHARE_NOTEBOOK':
      return data.notebookId ? `/shared?tab=notebooks&highlight=${data.notebookId}` : '/shared';
    case 'CHAT_MESSAGE':
      return data.noteId ? `/notes?noteId=${data.noteId}` : null;
    case 'GROUP_INVITE':
    case 'GROUP_REMOVE':
      return '/groups';
    case 'TASK_LIST_SHARED':
      return data.taskListId ? `/shared?tab=taskLists&highlight=${data.taskListId}` : '/shared?tab=taskLists';
    case 'TASK_ITEM_ADDED':
    case 'TASK_ITEM_CHECKED':
    case 'TASK_ITEM_REMOVED':
      return '/tasks';
    case 'KANBAN_BOARD_SHARED':
      return data.boardId ? `/shared?tab=kanbanBoards&highlight=${data.boardId}` : '/shared?tab=kanbanBoards';
    case 'KANBAN_CARD_ASSIGNED':
    case 'KANBAN_COMMENT_ADDED':
    case 'KANBAN_COMMENT_DELETED':
    case 'KANBAN_CARD_MOVED':
      return data.boardId ? `/kanban?boardId=${data.boardId}` : '/kanban';
    case 'SYSTEM': {
      // Share responses
      if (data.localizationKey?.includes('shareResponse')) {
        if (data.type === 'NOTE' && data.itemId) return `/notes?noteId=${data.itemId}`;
        if (data.type === 'NOTEBOOK' && data.itemId) return `/notes?notebookId=${data.itemId}`;
        if (data.type === 'TASKLIST') return '/tasks';
        if (data.type === 'KANBAN' && data.itemId) return `/kanban?boardId=${data.itemId}`;
      }
      // Group events
      if (data.localizationKey?.includes('group')) return '/groups';
      return null;
    }
    default:
      return null;
  }
}

/** Map notification type → i18n key (for old notifications without localizationKey) */
const TYPE_TO_KEY: Record<string, string> = {
  SHARE_NOTE: 'notifications.shareNote',
  SHARE_NOTEBOOK: 'notifications.shareNotebook',
  TASK_LIST_SHARED: 'notifications.taskListShared',
  TASK_ITEM_ADDED: 'notifications.taskItemAdded',
  TASK_ITEM_CHECKED: 'notifications.taskItemChecked',
  TASK_ITEM_REMOVED: 'notifications.taskItemRemoved',
  GROUP_INVITE: 'notifications.groupInvite',
  GROUP_REMOVE: 'notifications.groupRemove',
  KANBAN_BOARD_SHARED: 'notifications.kanbanBoardShared',
  KANBAN_CARD_ASSIGNED: 'notifications.kanbanCardAssigned',
  KANBAN_COMMENT_ADDED: 'notifications.kanbanCommentAdded',
  KANBAN_COMMENT_DELETED: 'notifications.kanbanCommentDeleted',
  KANBAN_CARD_MOVED: 'notifications.kanbanCardMoved',
};

/** Normalize localization args — handles old notifications with mismatched field names */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildArgs(data: Record<string, any>): Record<string, string> {
  const args: Record<string, string> = {};
  const src = { ...(data.localizationArgs || {}), ...data };

  // sharerName — used by shareNote, shareNotebook, taskListShared
  if (src.sharerName) args.sharerName = src.sharerName;

  // itemName — used by shareNote, shareNotebook, shareResponse
  if (src.itemName) args.itemName = src.itemName;
  if (!args.itemName && src.noteTitle) args.itemName = src.noteTitle;
  if (!args.itemName && src.notebookName) args.itemName = src.notebookName;
  if (!args.itemName && src.taskListTitle) args.itemName = src.taskListTitle;

  // listTitle — used by taskListShared, taskItem*
  if (src.listTitle) args.listTitle = src.listTitle;
  if (!args.listTitle && src.taskListTitle) args.listTitle = src.taskListTitle;
  if (!args.listTitle && src.itemName) args.listTitle = src.itemName;

  // userName — used by taskItem*
  if (src.userName) args.userName = src.userName;
  if (!args.userName && src.actorName) args.userName = src.actorName;

  // itemText — used by taskItem*
  if (src.itemText) args.itemText = src.itemText;

  // responderName, action — used by shareResponse
  if (src.responderName) args.responderName = src.responderName;
  if (src.action) args.action = src.action;

  // ownerName, groupName — used by group*
  if (src.ownerName) args.ownerName = src.ownerName;
  if (src.groupName) args.groupName = src.groupName;

  // memberEmail — used by groupMemberJoined
  if (src.memberEmail) args.memberEmail = src.memberEmail;

  // Kanban — assignerName, cardTitle, boardTitle, authorName, actorName, fromColumn, toColumn
  if (src.assignerName) args.assignerName = src.assignerName;
  if (src.cardTitle) args.cardTitle = src.cardTitle;
  if (src.boardTitle) args.boardTitle = src.boardTitle;
  if (src.authorName) args.authorName = src.authorName;
  if (src.actorName) args.actorName = src.actorName;
  if (src.fromColumn) args.fromColumn = src.fromColumn;
  if (src.toColumn) args.toColumn = src.toColumn;

  return args;
}

export default function NotificationItem({ notification, onRead, onDelete, onClose }: NotificationItemProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dateLocale = i18n.language?.startsWith('it') ? itLocale : enUS;
  const targetUrl = getNotificationUrl(notification);

  function handleClick(): void {
    if (!targetUrl) return;
    if (!notification.isRead) onRead(notification.id);
    onClose?.();
    navigate(targetUrl);
  }

  const getIcon = () => {
    switch (notification.type) {
      case 'SHARE_NOTE':
      case 'SHARE_NOTEBOOK':
        return <Share2 size={16} className="text-blue-500" />;
      case 'REMINDER':
        return <Calendar size={16} className="text-orange-500" />;
      case 'CHAT_MESSAGE':
        return <MessageSquare size={16} className="text-blue-500" />;
      case 'GROUP_INVITE':
      case 'GROUP_REMOVE':
        return <Orbit size={16} className="text-emerald-500" />;
      case 'TASK_ITEM_ADDED':
      case 'TASK_ITEM_CHECKED':
      case 'TASK_ITEM_REMOVED':
      case 'TASK_LIST_SHARED':
        return <ListChecks size={16} className="text-emerald-500" />;
      case 'KANBAN_BOARD_SHARED':
      case 'KANBAN_CARD_ASSIGNED':
      case 'KANBAN_COMMENT_ADDED':
      case 'KANBAN_COMMENT_DELETED':
      case 'KANBAN_CARD_MOVED':
        return <Kanban size={16} className="text-purple-500" />;
      case 'SYSTEM':
      default:
        return <Info size={16} className="text-neutral-500" />;
    }
  };

  // Resolve localization key: prefer explicit, fall back to type-based mapping
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (notification.data || {}) as Record<string, any>;
  const locKey: string | undefined = data.localizationKey || TYPE_TO_KEY[notification.type];
  const args = locKey ? buildArgs(data) : {};

  // Try localized title/message, fall back to raw DB values
  let title = notification.title;
  let message = notification.message;

  if (locKey) {
    const localizedTitle = t(locKey + '_TITLE', args) as string;
    // i18next returns the key itself if not found — detect and fall back
    if (localizedTitle && !localizedTitle.endsWith('_TITLE')) {
      title = localizedTitle;
    }

    const localizedMessage = t(locKey, args) as string;
    // If interpolation failed (still has {{), fall back to raw message
    if (localizedMessage && !localizedMessage.includes('{{') && localizedMessage !== locKey) {
      message = localizedMessage;
    }
  }

  return (
    <div
      onClick={handleClick}
      className={clsx(
        "p-3 border-b border-neutral-100 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors group relative",
        !notification.isRead && "bg-blue-50/50 dark:bg-blue-900/10",
        targetUrl && "cursor-pointer"
      )}
    >
      <div className="flex gap-3">
        <div className="mt-1 flex-shrink-0">
          {getIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
            {title}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 line-clamp-2">
            {message}
          </p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
            {timeAgo(notification.createdAt, dateLocale)}
          </p>
        </div>
        <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!notification.isRead && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRead(notification.id);
              }}
              className="p-1 text-neutral-400 hover:text-emerald-600 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
              title={t('notifications.markAsRead')}
            >
              <Check size={14} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(notification.id);
            }}
            className="p-1 text-neutral-400 hover:text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/30"
            title={t('common.delete')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
