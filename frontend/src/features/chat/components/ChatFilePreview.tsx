import { Download, Image as ImageIcon, FileText, Film, Music, FileArchive, FileSpreadsheet, File } from 'lucide-react';
import type { ChatFileDTO } from '../chatService';

interface ChatFilePreviewProps {
  file: ChatFileDTO;
  compact?: boolean;
  isOwn?: boolean; // sender's message = different color scheme
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileTypeInfo(mimeType: string, filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  if (mimeType.startsWith('image/')) return { icon: ImageIcon, color: '#3b82f6', bg: 'bg-blue-500/15', label: 'Image' };
  if (mimeType.startsWith('video/')) return { icon: Film, color: '#8b5cf6', bg: 'bg-violet-500/15', label: 'Video' };
  if (mimeType.startsWith('audio/')) return { icon: Music, color: '#f59e0b', bg: 'bg-amber-500/15', label: 'Audio' };
  if (mimeType.includes('pdf')) return { icon: FileText, color: '#ef4444', bg: 'bg-red-500/15', label: 'PDF' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: FileArchive, color: '#f97316', bg: 'bg-orange-500/15', label: 'Archive' };
  if (['xlsx', 'xls', 'csv'].includes(ext)) return { icon: FileSpreadsheet, color: '#10b981', bg: 'bg-emerald-500/15', label: 'Spreadsheet' };
  if (['doc', 'docx', 'txt', 'rtf'].includes(ext)) return { icon: FileText, color: '#3b82f6', bg: 'bg-blue-500/15', label: 'Document' };
  return { icon: File, color: '#6b7280', bg: 'bg-neutral-500/15', label: ext.toUpperCase() || 'File' };
}

export default function ChatFilePreview({ file, compact, isOwn }: ChatFilePreviewProps) {
  const isImage = file.mimeType.startsWith('image/');
  const typeInfo = getFileTypeInfo(file.mimeType, file.filename);
  const Icon = typeInfo.icon;

  // ─── Image preview ──────────────────────────────────────
  if (isImage) {
    return (
      <div className="mt-1.5 max-w-[280px] group/img">
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          download={file.filename}
          className="block relative rounded-xl overflow-hidden"
        >
          <img
            src={file.thumbnailUrl || file.url}
            alt={file.filename}
            className="w-full h-auto max-h-[300px] object-cover transition-transform duration-200 group-hover/img:scale-[1.02]"
            loading="lazy"
            decoding="async"
          />
          {/* Hover overlay with download hint */}
          <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors duration-200 flex items-center justify-center">
            <div className="opacity-0 group-hover/img:opacity-100 transition-opacity duration-200 p-2 rounded-full bg-black/50 backdrop-blur-sm">
              <Download size={20} className="text-white" />
            </div>
          </div>
        </a>
        {!compact && (
          <div className="flex items-center justify-between mt-1.5 px-0.5">
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate">{file.filename}</span>
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500 flex-shrink-0 ml-2">{formatSize(file.size)}</span>
          </div>
        )}
      </div>
    );
  }

  // ─── Non-image file card ────────────────────────────────
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      download={file.filename}
      className={`group/file flex items-center gap-3 mt-1.5 px-3 py-2.5 rounded-xl max-w-[300px] transition-all duration-150 border ${
        isOwn
          ? 'bg-emerald-700/30 border-emerald-500/20 hover:bg-emerald-700/40'
          : 'bg-neutral-100 dark:bg-neutral-800/60 border-neutral-200/60 dark:border-neutral-700/30 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/50'
      }`}
    >
      {/* File type icon */}
      <div
        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${typeInfo.bg}`}
      >
        <Icon size={20} style={{ color: typeInfo.color }} />
      </div>

      {/* File info */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${
          isOwn ? 'text-white' : 'text-neutral-900 dark:text-neutral-100'
        }`}>
          {file.filename}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`text-[11px] ${
            isOwn ? 'text-emerald-200/70' : 'text-neutral-500 dark:text-neutral-400'
          }`}>
            {formatSize(file.size)}
          </span>
          <span className={`text-[11px] ${
            isOwn ? 'text-emerald-200/50' : 'text-neutral-400 dark:text-neutral-500'
          }`}>
            •
          </span>
          <span className={`text-[11px] uppercase tracking-wider font-medium ${
            isOwn ? 'text-emerald-200/70' : 'text-neutral-500 dark:text-neutral-400'
          }`}>
            {typeInfo.label}
          </span>
        </div>
      </div>

      {/* Download icon */}
      <div className={`flex-shrink-0 p-1.5 rounded-full opacity-60 group-hover/file:opacity-100 transition-opacity ${
        isOwn ? 'text-emerald-200' : 'text-neutral-400 dark:text-neutral-500'
      }`}>
        <Download size={16} />
      </div>
    </a>
  );
}
