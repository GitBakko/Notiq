import { useState, useRef, useEffect } from 'react';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationItem from './NotificationItem';
import { useTranslation } from 'react-i18next';


export default function NotificationDropdown() {
  const { t } = useTranslation();
  const { notifications, unreadCount, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white transition-colors rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
        title={t('notifications.title')}
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white dark:border-neutral-900" />
        )}
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-80 bg-white dark:bg-neutral-900 border border-neutral-200/60 dark:border-neutral-700/40 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col max-h-[400px]">
          <div className="p-3 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold text-neutral-900 dark:text-white text-sm">
              {t('notifications.title')}
            </h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllAsRead()}
                  className="p-1 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 rounded hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors"
                  title={t('notifications.markAllAsRead')}
                >
                  <CheckCheck size={16} />
                </button>
              )}
              {notifications && notifications.length > 0 && (
                <button
                  onClick={() => deleteAllNotifications()}
                  className="p-1 text-red-500 hover:text-red-600 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                  title={t('notifications.deleteAll')}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {notifications && notifications.length > 0 ? (
              notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onRead={markAsRead}
                  onDelete={deleteNotification}
                  onClose={() => setIsOpen(false)}
                />
              ))
            ) : (
              <div className="p-8 text-center text-neutral-500 dark:text-neutral-400 text-sm">
                <Bell size={24} className="mx-auto mb-2 opacity-20" />
                {t('notifications.empty')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
