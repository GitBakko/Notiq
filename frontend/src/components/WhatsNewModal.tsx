import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { changelog, CURRENT_VERSION } from '../data/changelog';
import TypeBadge from './changelog/TypeBadge';

interface WhatsNewModalProps {
  onClose: () => void;
}

export default function WhatsNewModal({ onClose }: WhatsNewModalProps) {
  const { t } = useTranslation();
  const latestVersion = changelog[0];

  function handleClose() {
    localStorage.setItem('lastSeenVersion', CURRENT_VERSION);
    onClose();
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              v{latestVersion.version}
            </span>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              {t('whatsNew.title')}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <ul className="space-y-3">
            {latestVersion.entries.map((entry) => (
              <li key={entry.titleKey} className="flex items-start gap-3">
                <TypeBadge type={entry.type} />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {t(entry.titleKey)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <Link
            to="/whats-new"
            onClick={handleClose}
            className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
          >
            {t('whatsNew.viewFullHistory')}
          </Link>
          <button
            onClick={handleClose}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            {t('whatsNew.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
