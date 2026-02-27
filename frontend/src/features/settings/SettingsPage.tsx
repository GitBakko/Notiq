import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';
import { Moon, Sun, Monitor, LogOut, Menu } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { useIsMobile } from '../../hooks/useIsMobile';
import clsx from 'clsx';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { CURRENT_VERSION } from '../../data/changelog';
import { useImport } from '../../hooks/useImport';

export default function SettingsPage() {
  const { t } = useTranslation();
  const { theme, setTheme, toggleSidebar, notificationSoundEnabled, setNotificationSoundEnabled } = useUIStore();
  const { user, logout, updateUser } = useAuthStore();

  const isMobile = useIsMobile();
  const { isSubscribed, subscribe, unsubscribe, isSupported } = usePushNotifications();

  const { isUploading: isUploadingEvernote, importFile: importEvernote, hiddenInput: hiddenInputEvernote, notebookPickerModal: notebookPickerEvernote } = useImport({ source: 'evernote' });
  const { isUploading: isUploadingOneNote, importFile: importOneNote, hiddenInput: hiddenInputOneNote, notebookPickerModal: notebookPickerOneNote } = useImport({ source: 'onenote' });

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-4 sm:px-8 sm:py-6 flex items-center gap-3">
        {isMobile && (
          <button onClick={toggleSidebar} className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
            <Menu size={24} />
          </button>
        )}
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('sidebar.settings')}</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-6">
        {/* Appearance */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.appearance')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <button
                onClick={() => setTheme('light')}
                className={clsx(
                  "flex items-center gap-3 p-4 rounded-lg border-2 transition-all",
                  theme === 'light'
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                )}
              >
                <div className="p-2 bg-orange-100 text-orange-600 rounded-full">
                  <Sun size={20} />
                </div>
                <span className="font-medium text-gray-900 dark:text-gray-100">{t('settings.light')}</span>
              </button>

              <button
                onClick={() => setTheme('dark')}
                className={clsx(
                  "flex items-center gap-3 p-4 rounded-lg border-2 transition-all",
                  theme === 'dark'
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                )}
              >
                <div className="p-2 bg-indigo-100 text-indigo-600 rounded-full">
                  <Moon size={20} />
                </div>
                <span className="font-medium text-gray-900 dark:text-gray-100">{t('settings.dark')}</span>
              </button>

              <button
                onClick={() => setTheme('system')}
                className={clsx(
                  "flex items-center gap-3 p-4 rounded-lg border-2 transition-all",
                  theme === 'system'
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                )}
              >
                <div className="p-2 bg-gray-100 text-gray-600 rounded-full">
                  <Monitor size={20} />
                </div>
                <span className="font-medium text-gray-900 dark:text-gray-100">{t('settings.system')}</span>
              </button>
            </div>
          </Card>
        </section>

        {/* Notifications */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('notifications.title')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700 space-y-5">
            {/* Notification Sound Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-900 dark:text-white">{t('settings.notificationSoundToggle')}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.notificationSoundDescription')}</p>
              </div>
              <button
                onClick={() => setNotificationSoundEnabled(!notificationSoundEnabled)}
                className={clsx(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2",
                  notificationSoundEnabled ? "bg-emerald-600" : "bg-gray-200 dark:bg-gray-700"
                )}
              >
                <span
                  className={clsx(
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                    notificationSoundEnabled ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>

            {/* Push Notifications Toggle */}
            {isSupported && (
              <>
                <div className="border-t border-gray-200 dark:border-gray-700" />
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-white">{t('notifications.pushNotifications')}</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('notifications.pushDescription')}</p>
                  </div>
                  <button
                    onClick={isSubscribed ? unsubscribe : subscribe}
                    className={clsx(
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2",
                      isSubscribed ? "bg-emerald-600" : "bg-gray-200 dark:bg-gray-700"
                    )}
                  >
                    <span
                      className={clsx(
                        "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                        isSubscribed ? "translate-x-6" : "translate-x-1"
                      )}
                    />
                  </button>
                </div>
              </>
            )}

            {/* Email Notifications Toggle */}
            <div className="border-t border-gray-200 dark:border-gray-700" />
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-900 dark:text-white">{t('settings.emailNotificationsToggle')}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.emailNotificationsDescription')}</p>
              </div>
              <button
                onClick={() => updateUser({ emailNotificationsEnabled: !(user?.emailNotificationsEnabled ?? true) })}
                className={clsx(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2",
                  (user?.emailNotificationsEnabled ?? true) ? "bg-emerald-600" : "bg-gray-200 dark:bg-gray-700"
                )}
              >
                <span
                  className={clsx(
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                    (user?.emailNotificationsEnabled ?? true) ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>
          </Card>
        </section>

        {/* Account */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.account')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 rounded-full bg-emerald-600 flex-shrink-0 flex items-center justify-center text-white text-2xl font-bold overflow-hidden">
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                    alt={user?.name || ''}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  user?.name?.[0] || user?.email?.[0] || 'U'
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-xl font-medium text-gray-900 dark:text-white">{user?.name || t('common.user')}</h3>
                <p className="text-gray-500 dark:text-gray-400">{user?.email}</p>
              </div>
              <Button variant="danger" onClick={logout} className="flex items-center gap-2 flex-shrink-0">
                <LogOut size={18} />
                {t('auth.logout')}
              </Button>
            </div>
          </Card>
        </section>

        {/* About */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.about')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <p className="text-gray-600 dark:text-gray-300 mb-2">
              Notiq v{CURRENT_VERSION}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              {t('settings.techStack')}
            </p>
            <Link
              to="/whats-new"
              className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
            >
              {t('settings.whatsNew')}
            </Link>
          </Card>
        </section>

        {/* Import */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.import')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <h3 className="font-medium text-gray-900 dark:text-white mb-2">{t('settings.importTitle')}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('settings.importDesc')}</p>

            <div className="flex flex-col gap-3">
              {/* Evernote Import */}
              <button
                onClick={() => importEvernote()}
                disabled={isUploadingEvernote}
                className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-50 text-left"
              >
                <svg width="20" height="20" viewBox="0 0 32 32" fill="#7fce2c" className="flex-shrink-0">
                  <path d="M29.343 16.818c.1 1.695-.08 3.368-.305 5.045-.225 1.712-.508 3.416-.964 5.084-.3 1.067-.673 2.1-1.202 3.074-.65 1.192-1.635 1.87-2.992 1.924l-3.832.036c-.636-.017-1.278-.146-1.9-.297-1.192-.3-1.862-1.1-2.06-2.3-.186-1.08-.173-2.187.04-3.264.252-1.23 1-1.96 2.234-2.103.817-.1 1.65-.077 2.476-.1.205-.007.275.098.203.287-.196.53-.236 1.07-.098 1.623.053.207-.023.307-.26.305a7.77 7.77 0 0 0-1.123.053c-.636.086-.96.47-.96 1.112 0 .205.026.416.066.622.103.507.45.78.944.837 1.123.127 2.247.138 3.37-.05.675-.114 1.08-.54 1.16-1.208.152-1.3.155-2.587-.228-3.845-.33-1.092-1.006-1.565-2.134-1.7l-3.36-.54c-1.06-.193-1.7-.887-1.92-1.9-.13-.572-.14-1.17-.214-1.757-.013-.106-.074-.208-.1-.3-.04.1-.106.212-.117.326-.066.68-.053 1.373-.185 2.04-.16.8-.404 1.566-.67 2.33-.185.535-.616.837-1.205.8a37.76 37.76 0 0 1-7.123-1.353l-.64-.207c-.927-.26-1.487-.903-1.74-1.787l-1-3.853-.74-4.3c-.115-.755-.2-1.523-.083-2.293.154-1.112.914-1.903 2.04-1.964l3.558-.062c.127 0 .254.003.373-.026a1.23 1.23 0 0 0 1.01-1.255l-.05-3.036c-.048-1.576.8-2.38 2.156-2.622a10.58 10.58 0 0 1 4.91.26c.933.275 1.467.923 1.715 1.83.058.22.146.3.37.287l2.582.01 3.333.37c.686.095 1.364.25 2.032.42 1.165.298 1.793 1.112 1.962 2.256l.357 3.355.3 5.577.01 2.277zm-4.534-1.155c-.02-.666-.07-1.267-.444-1.784a1.66 1.66 0 0 0-2.469-.15c-.364.4-.494.88-.564 1.4-.008.034.106.126.16.126l.8-.053c.768.007 1.523.113 2.25.393.066.026.136.04.265.077zM8.787 1.154a3.82 3.82 0 0 0-.278 1.592l.05 2.934c.005.357-.075.45-.433.45L5.1 6.156c-.583 0-1.143.1-1.554.278l5.2-5.332c.02.013.04.033.06.053z"/>
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{t('sidebar.importEvernote')}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">.enex</p>
                </div>
              </button>

              {/* OneNote Import */}
              <button
                onClick={() => importOneNote()}
                disabled={isUploadingOneNote}
                className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-50 text-left"
              >
                <img src="/oneNote.png" alt="OneNote" width="20" height="20" className="flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{t('sidebar.importOneNote')}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">.mht, .mhtml, .html, .zip</p>
                </div>
              </button>
            </div>

            {hiddenInputEvernote}
            {hiddenInputOneNote}
            {notebookPickerEvernote}
            {notebookPickerOneNote}
          </Card>
        </section>
      </div>
    </div>
  );
}
