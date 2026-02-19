import { formatDistanceToNow } from 'date-fns';
import { Share2, Info, Calendar, Trash2, Check, Orbit, MessageSquare } from 'lucide-react';
import type { Notification } from './notificationService';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

interface NotificationItemProps {
  notification: Notification;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function NotificationItem({ notification, onRead, onDelete }: NotificationItemProps) {
  const { t } = useTranslation();

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
      case 'SYSTEM':
      default:
        return <Info size={16} className="text-gray-500" />;
    }
  };

  return (
    <div className={clsx(
      "p-3 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group relative",
      !notification.isRead && "bg-blue-50/50 dark:bg-blue-900/10"
    )}>
      <div className="flex gap-3">
        <div className="mt-1 flex-shrink-0">
          {getIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {notification.data?.localizationKey ? t(notification.data.localizationKey + '_TITLE', notification.data.localizationArgs) as string : notification.title}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
            {notification.data?.localizationKey ? t(notification.data.localizationKey, notification.data.localizationArgs) as string : notification.message}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
          </p>
        </div>
        <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!notification.isRead && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRead(notification.id);
              }}
              className="p-1 text-gray-400 hover:text-emerald-600 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
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
            className="p-1 text-gray-400 hover:text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/30"
            title={t('common.delete')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
