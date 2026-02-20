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
import { useState, useRef } from 'react';
import { Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import axios from 'axios';
import { CURRENT_VERSION } from '../../data/changelog';

const ImportSection = () => {
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.enex')) {
      toast.error(t('settings.importError'));
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    const toastId = toast.loading(t('settings.importing'));

    try {
      const token = localStorage.getItem('token');
      const response = await axios.post(`${import.meta.env.VITE_API_URL || '/api'}/import/evernote`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${token}`
        }
      });

      toast.success(t('settings.importSuccess', { count: response.data.importedCount }));
    } catch (error) {
      console.error(error);
      toast.error(t('settings.importError'));
    } finally {
      setIsUploading(false);
      toast.dismiss(toastId);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div>
      <input
        type="file"
        accept=".enex"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileChange}
      />
      <Button
        variant="secondary"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="flex items-center gap-2"
      >
        <Upload size={18} />
        {isUploading ? t('settings.importing') : t('settings.selectFile')}
      </Button>
    </div>
  );
};

export default function SettingsPage() {
  const { t } = useTranslation();
  const { theme, setTheme, toggleSidebar, notificationSoundEnabled, setNotificationSoundEnabled } = useUIStore();
  const { user, logout } = useAuthStore();

  const isMobile = useIsMobile();
  const { isSubscribed, subscribe, unsubscribe, isSupported } = usePushNotifications();

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
        {isSupported && (
          <section>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('notifications.title')}</h2>
            <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
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
            </Card>
          </section>
        )}

        {/* Notification Sound */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.notificationSound')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
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
          </Card>
        </section>

        {/* Account */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('settings.account')}</h2>
          <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
            <div className="flex items-center gap-4 mb-6">
              <div className="h-16 w-16 rounded-full bg-emerald-600 flex items-center justify-center text-white text-2xl font-bold">
                {user?.name?.[0] || user?.email?.[0] || 'U'}
              </div>
              <div>
                <h3 className="text-xl font-medium text-gray-900 dark:text-white">{user?.name || t('common.user')}</h3>
                <p className="text-gray-500 dark:text-gray-400">{user?.email}</p>
              </div>
            </div>

            <Button variant="danger" onClick={logout} className="flex items-center gap-2">
              <LogOut size={18} />
              {t('auth.logout')}
            </Button>
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

            <ImportSection />
          </Card>
        </section>
      </div>
    </div>
  );
}
