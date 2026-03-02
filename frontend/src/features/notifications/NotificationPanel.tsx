import { useEffect, useRef } from 'react';
import { Bell, CheckCheck, Trash2, X } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationItem from './NotificationItem';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import clsx from 'clsx';

export default function NotificationPanel() {
  const { t } = useTranslation();
  const { notifications, unreadCount, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications } = useNotifications();
  const { isNotificationPanelOpen, closeNotificationPanel } = useUIStore();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isNotificationPanelOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNotificationPanel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isNotificationPanelOpen, closeNotificationPanel]);

  return (
    <>
      {/* Backdrop */}
      {isNotificationPanelOpen && (
        <div
          className="fixed inset-0 bg-neutral-950/30 dark:bg-neutral-950/50 z-40 transition-opacity"
          onClick={closeNotificationPanel}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        className={clsx(
          "fixed top-0 right-0 h-full w-full sm:w-96 bg-white dark:bg-neutral-900 border-l border-neutral-200/60 dark:border-neutral-800/40 shadow-2xl z-50 flex flex-col",
          "transition-transform duration-300 ease-in-out",
          isNotificationPanelOpen ? "translate-x-0" : "translate-x-full"
        )}
        role="dialog"
        aria-modal="true"
        aria-label={t('notifications.title')}
      >
        {/* Header */}
        <div className="p-4 border-b border-neutral-200/60 dark:border-neutral-800/40 flex items-center justify-between flex-shrink-0">
          <h2 className="font-semibold text-neutral-900 dark:text-white text-base">
            {t('notifications.title')}
            {unreadCount > 0 && (
              <span className="ml-2 text-xs font-medium text-white bg-red-500 rounded-full px-1.5 py-0.5">
                {unreadCount}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <button
                onClick={() => markAllAsRead()}
                className="p-1.5 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors"
                title={t('notifications.markAllAsRead')}
                aria-label={t('notifications.markAllAsRead')}
              >
                <CheckCheck size={18} />
              </button>
            )}
            {notifications && notifications.length > 0 && (
              <button
                onClick={() => deleteAllNotifications()}
                className="p-1.5 text-red-500 hover:text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                title={t('notifications.deleteAll')}
                aria-label={t('notifications.deleteAll')}
              >
                <Trash2 size={18} />
              </button>
            )}
            <button
              onClick={closeNotificationPanel}
              className="p-1.5 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-white rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ml-1"
              aria-label={t('common.close')}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Notification list */}
        <div className="flex-1 overflow-y-auto">
          {notifications && notifications.length > 0 ? (
            notifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onRead={markAsRead}
                onDelete={deleteNotification}
                onClose={closeNotificationPanel}
              />
            ))
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-neutral-400 dark:text-neutral-500">
              <Bell size={32} className="mb-3 opacity-30" />
              <p className="text-sm">{t('notifications.empty')}</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
