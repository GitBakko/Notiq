import { File, Download, Image as ImageIcon, FileText, Film, Music } from 'lucide-react';
import type { ChatFileDTO } from '../chatService';

interface ChatFilePreviewProps {
  file: ChatFileDTO;
  compact?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Film;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('pdf') || mimeType.includes('text')) return FileText;
  return File;
}

export default function ChatFilePreview({ file, compact }: ChatFilePreviewProps) {
  const isImage = file.mimeType.startsWith('image/');
  const Icon = getFileIcon(file.mimeType);

  if (isImage) {
    return (
      <div className="mt-1.5 rounded-lg overflow-hidden max-w-[280px]">
        <a href={file.url} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={file.thumbnailUrl || file.url}
            alt={file.filename}
            className="w-full h-auto max-h-[300px] object-cover rounded-lg"
            loading="lazy"
            decoding="async"
          />
        </a>
        {!compact && (
          <div className="flex items-center justify-between mt-1 text-[11px] text-neutral-400">
            <span className="truncate">{file.filename}</span>
            <span>{formatSize(file.size)}</span>
          </div>
        )}
      </div>
    );
  }

  // Non-image file
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2.5 mt-1.5 p-2.5 rounded-lg bg-white/10 dark:bg-neutral-700/30 hover:bg-white/20 dark:hover:bg-neutral-700/50 transition-colors max-w-[280px]"
    >
      <div className="p-2 rounded-lg bg-emerald-500/20 dark:bg-emerald-400/20 text-emerald-600 dark:text-emerald-400 flex-shrink-0">
        <Icon size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{file.filename}</p>
        <p className="text-[11px] text-neutral-400">{formatSize(file.size)}</p>
      </div>
      <Download size={16} className="text-neutral-400 flex-shrink-0" />
    </a>
  );
}
