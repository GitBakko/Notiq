import { X, Paperclip, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Button } from '../../components/ui/Button';
import AttachmentList from '../../components/editor/AttachmentList';

interface AttachmentSidebarProps {
  noteId: string;
  attachments: { id: string; url: string; filename: string; mimeType: string; size: number }[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}

export default function AttachmentSidebar({ noteId, attachments, onClose, onDelete, onAdd }: AttachmentSidebarProps) {
  const { t } = useTranslation();
  const token = localStorage.getItem('auth-storage') ? JSON.parse(localStorage.getItem('auth-storage') || '{}').state?.token : null;

  return (
    <div className="fixed inset-y-0 right-0 w-80 bg-white shadow-xl border-l border-gray-200 transform transition-transform duration-300 ease-in-out z-40 flex flex-col dark:bg-gray-900 dark:border-gray-800">
      <div className="p-4 border-b border-gray-200 flex items-center justify-between dark:border-gray-800">
        <div className="flex items-center gap-2">
          <Paperclip size={20} className="text-gray-500 dark:text-gray-400" />
          <h2 className="font-semibold text-lg text-gray-900 dark:text-white">{t('notes.attachments')}</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={20} />
        </Button>
      </div>

      {attachments.length > 1 && (
        <div className="px-4 pt-4">
          {/* Using a direct link styled as button for download */}
          <a
            href={`/api/attachments/download-all/${noteId}?token=${token}`}
            className="flex items-center justify-center w-full gap-2 px-4 py-2 text-sm font-medium text-white transition-colors bg-emerald-600 rounded-md hover:bg-emerald-700"
            download
          >
            <Upload className="w-4 h-4 rotate-180" />
            {t('actions.downloadAll', 'Download All')}
          </a>
        </div>
      )}

      {/* Quota Indicator */}
      <div className="px-4 mt-4">
        {(() => {
          const QUOTA_MB = import.meta.env.VITE_NOTE_ATTACHMENT_QUOTA_MB ? parseInt(import.meta.env.VITE_NOTE_ATTACHMENT_QUOTA_MB) : 10;
          const currentSize = attachments.reduce((acc, curr) => acc + curr.size, 0);
          const totalBytes = QUOTA_MB * 1024 * 1024;
          const percentage = Math.min((currentSize / totalBytes) * 100, 100);
          const isWarning = percentage > 75;

          return (
            <div>
              <div className="flex justify-between text-xs mb-1 text-gray-500 dark:text-gray-400">
                <span>{t('actions.quotaWarning', 'Storage')}</span>
                <span>{(currentSize / (1024 * 1024)).toFixed(2)}MB / {QUOTA_MB}MB</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-700 overflow-hidden">
                <div
                  className={clsx("h-1.5 rounded-full transition-all duration-500", isWarning ? "bg-red-500" : "bg-emerald-500")}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          );
        })()}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {attachments.length === 0 ? (
          <div className="text-center py-10 text-gray-500 dark:text-gray-400">
            <Upload size={48} className="mx-auto mb-3 opacity-50" />
            <p className="mb-4">{t('notes.noAttachments')}</p>
            <Button onClick={onAdd} variant="secondary" size="sm">
              {t('notes.addAttachment')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Button onClick={onAdd} variant="secondary" size="sm" className="w-full mb-4">
              {t('notes.addAttachment')}
            </Button>
            <AttachmentList
              attachments={attachments}
              onDelete={onDelete}
              onAdd={onAdd} // Not used in list mode usually, but passing for compatibility
            />
          </div>
        )}
      </div>
    </div>
  );
}
