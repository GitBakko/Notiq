import { Paperclip, X, FileText, Image, FileCode, FileSpreadsheet, File, Music, Video, FileArchive } from 'lucide-react';
import api from '../../lib/api';

interface Attachment {
  id: string;
  url: string;
  filename: string;
  size: number;
  version?: number;
}

interface AttachmentListProps {
  attachments: Attachment[];
  onDelete?: (id: string) => void;
  onAdd?: () => void;
  readOnly?: boolean;
}

const getFileIconInfo = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'pdf':
      return { icon: FileText, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30' };
    case 'doc':
    case 'docx':
      return { icon: FileText, color: 'text-blue-600', bg: 'bg-blue-100 dark:bg-blue-900/30' };
    case 'xls':
    case 'xlsx':
    case 'csv':
      return { icon: FileSpreadsheet, color: 'text-green-600', bg: 'bg-green-100 dark:bg-green-900/30' };
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp':
    case 'svg':
      return { icon: Image, color: 'text-purple-600', bg: 'bg-purple-100 dark:bg-purple-900/30' };
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      return { icon: FileArchive, color: 'text-orange-600', bg: 'bg-orange-100 dark:bg-orange-900/30' };
    case 'mp3':
    case 'wav':
    case 'ogg':
      return { icon: Music, color: 'text-pink-600', bg: 'bg-pink-100 dark:bg-pink-900/30' };
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'webm':
      return { icon: Video, color: 'text-indigo-600', bg: 'bg-indigo-100 dark:bg-indigo-900/30' };
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'html':
    case 'css':
    case 'json':
    case 'py':
      return { icon: FileCode, color: 'text-yellow-600', bg: 'bg-yellow-100 dark:bg-yellow-900/30' };
    default:
      return { icon: File, color: 'text-gray-500', bg: 'bg-gray-200 dark:bg-gray-700' };
  }
};

import { useTranslation } from 'react-i18next';

export default function AttachmentList({ attachments, onDelete, onAdd, readOnly = false }: AttachmentListProps) {
  const { t } = useTranslation();
  if (!attachments && !onAdd) return null;

  const getBaseUrl = () => {
    const apiUrl = import.meta.env.VITE_API_URL || '/api';
    try {
      if (apiUrl.startsWith('http')) {
        return new URL(apiUrl).origin;
      }
    } catch (e) {
      console.warn('Invalid API_URL for attachments', e);
    }
    return '';
  };
  const BASE_URL = getBaseUrl();

  const handleDownload = async (attachmentId: string, filename: string) => {
    try {
      const response = await api.get(`/attachments/download/${attachmentId}`, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download failed', e);
    }
  };

  return (
    <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 dark:text-gray-400">
          <Paperclip size={12} />
          {t('notes.attachments')} ({attachments?.length || 0})
        </h4>
      </div>
      <ul className="space-y-2">
        {attachments?.map((att) => {
          const { icon: Icon, color, bg } = getFileIconInfo(att.filename);
          const isAudio = ['mp3', 'wav', 'ogg', 'webm'].includes(att.filename.split('.').pop()?.toLowerCase() || '');

          return (
            <li key={att.id} className="flex flex-col bg-gray-50 p-2 rounded border border-gray-100 group dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className={`h-8 w-8 rounded flex items-center justify-center ${bg}`}>
                    <Icon size={16} className={color} />
                  </div>
                  <div className="flex flex-col overflow-hidden">
                    <button
                      onClick={() => handleDownload(att.id, att.filename)}
                      className="text-sm font-medium text-gray-700 truncate hover:text-emerald-600 hover:underline dark:text-gray-200 dark:hover:text-emerald-400 text-left"
                    >
                      {att.filename}
                    </button>

                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {(att.size / 1024).toFixed(1)} KB {att.version && `• v${att.version}`}
                    </span>
                  </div>
                </div>
                {!readOnly && onDelete && (
                  <button
                    onClick={() => onDelete(att.id)}
                    className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity dark:text-gray-500 dark:hover:text-red-400"
                    title={t('common.deleteAttachment')}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              {isAudio && (
                <div className="mt-2 w-full">
                  <audio controls src={`${BASE_URL}${att.url}`} className="w-full h-8" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
