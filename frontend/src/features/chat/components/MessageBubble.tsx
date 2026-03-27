import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Reply,
  SmilePlus,
  Copy,
  Pencil,
  Trash2,
  CheckCheck,
} from 'lucide-react';
import type { DirectMessageDTO } from '../chatService';

interface MessageBubbleProps {
  message: DirectMessageDTO;
  isOwn: boolean;
  showSender: boolean;
  onReply: (message: DirectMessageDTO) => void;
  onReact: (messageId: string) => void;
  onEdit?: (message: DirectMessageDTO) => void;
  onDelete?: (messageId: string) => void;
}

// Group reactions by emoji
function groupReactions(reactions: DirectMessageDTO['reactions']) {
  const grouped = new Map<string, { emoji: string; count: number; userIds: string[] }>();
  for (const r of reactions) {
    const existing = grouped.get(r.emoji);
    if (existing) {
      existing.count++;
      existing.userIds.push(r.userId);
    } else {
      grouped.set(r.emoji, { emoji: r.emoji, count: 1, userIds: [r.userId] });
    }
  }
  return Array.from(grouped.values());
}

export default function MessageBubble({
  message,
  isOwn,
  showSender,
  onReply,
  onReact,
  onEdit,
  onDelete,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [contextMenu]);

  // Right-click (desktop)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (message.isDeleted) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [message.isDeleted]);

  // Long-press (mobile)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (message.isDeleted) return;
    const touch = e.touches[0];
    longPressTimerRef.current = setTimeout(() => {
      setContextMenu({ x: touch.clientX, y: touch.clientY });
    }, 500);
  }, [message.isDeleted]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).catch(() => { /* ignore */ });
    setContextMenu(null);
  }, [message.content]);

  const timestamp = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const canEdit = isOwn && onEdit && !message.isDeleted && (
    Date.now() - new Date(message.createdAt).getTime() < 5 * 60 * 1000
  );
  const canDelete = isOwn && onDelete && !message.isDeleted;

  const groupedReactions = groupReactions(message.reactions);

  // Deleted state
  if (message.isDeleted) {
    return (
      <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} px-3 py-0.5`}>
        <div className="max-w-[75%] px-3 py-2 rounded-2xl bg-neutral-100 dark:bg-neutral-800/50">
          <p className="text-sm italic text-neutral-400 dark:text-neutral-500">
            {t('chat.messageDeleted')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} px-3 py-0.5 group`}>
      <div className="max-w-[75%] flex flex-col">
        {/* Sender name for group chats */}
        {showSender && !isOwn && (
          <span
            className="text-xs font-semibold mb-0.5 ml-3"
            style={{ color: message.sender.color || '#6b7280' }}
          >
            {message.sender.name || message.sender.email}
          </span>
        )}

        {/* Bubble */}
        <div
          ref={bubbleRef}
          onContextMenu={handleContextMenu}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          className={`relative px-3 py-2 rounded-2xl select-text ${
            isOwn
              ? 'bg-emerald-600 dark:bg-emerald-700 text-white rounded-br-md'
              : 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-bl-md'
          }`}
        >
          {/* Reply quote */}
          {message.replyTo && (
            <div
              className={`mb-1.5 px-2.5 py-1.5 rounded-lg border-l-2 text-xs ${
                isOwn
                  ? 'bg-emerald-700/40 dark:bg-emerald-800/40 border-emerald-300/60 text-emerald-100'
                  : 'bg-neutral-100 dark:bg-neutral-700/50 border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300'
              }`}
            >
              <span className="font-semibold block truncate">
                {message.replyTo.sender.name || message.replyTo.sender.email}
              </span>
              <span className="line-clamp-2">{message.replyTo.content}</span>
            </div>
          )}

          {/* Text content */}
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>

          {/* File previews */}
          {message.files.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {message.files.map((file) => (
                <a
                  key={file.id}
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`block text-xs px-2 py-1 rounded ${
                    isOwn
                      ? 'bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100'
                      : 'bg-neutral-100 dark:bg-neutral-700/50 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300'
                  }`}
                >
                  <span className="truncate block">{file.filename}</span>
                  <span className="opacity-70">
                    {file.size < 1024
                      ? `${file.size} B`
                      : file.size < 1024 * 1024
                        ? `${(file.size / 1024).toFixed(1)} KB`
                        : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                  </span>
                </a>
              ))}
            </div>
          )}

          {/* Timestamp + edited + read receipt */}
          <div
            className={`flex items-center gap-1 mt-1 ${
              isOwn ? 'justify-end' : 'justify-end'
            }`}
          >
            {message.editedAt && (
              <span
                className={`text-[10px] italic ${
                  isOwn ? 'text-emerald-200/70' : 'text-neutral-400 dark:text-neutral-500'
                }`}
              >
                {t('chat.edited')}
              </span>
            )}
            <span
              className={`text-[10px] ${
                isOwn ? 'text-emerald-200/70' : 'text-neutral-400 dark:text-neutral-500'
              }`}
            >
              {timestamp}
            </span>
            {isOwn && (
              <span className="text-emerald-200/70 ml-0.5">
                <CheckCheck size={14} />
              </span>
            )}
          </div>
        </div>

        {/* Reactions bar */}
        {groupedReactions.length > 0 && (
          <div className={`flex flex-wrap gap-1 mt-0.5 ${isOwn ? 'justify-end mr-1' : 'ml-1'}`}>
            {groupedReactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(message.id)}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200/60 dark:border-neutral-700/40 transition-colors"
              >
                <span>{r.emoji}</span>
                <span className="text-neutral-600 dark:text-neutral-300">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] py-1 rounded-xl bg-white dark:bg-neutral-800 shadow-lg border border-neutral-200/60 dark:border-neutral-700/40 animate-in fade-in"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 180),
            top: Math.min(contextMenu.y, window.innerHeight - 250),
          }}
        >
          <ContextMenuItem
            icon={<Reply size={16} />}
            label={t('chat.reply')}
            onClick={() => { onReply(message); setContextMenu(null); }}
          />
          <ContextMenuItem
            icon={<SmilePlus size={16} />}
            label={t('chat.react')}
            onClick={() => { onReact(message.id); setContextMenu(null); }}
          />
          <ContextMenuItem
            icon={<Copy size={16} />}
            label={t('chat.copy')}
            onClick={handleCopy}
          />
          {canEdit && (
            <ContextMenuItem
              icon={<Pencil size={16} />}
              label={t('chat.edit')}
              onClick={() => { onEdit!(message); setContextMenu(null); }}
            />
          )}
          {canDelete && (
            <>
              <div className="my-1 border-t border-neutral-200/60 dark:border-neutral-700/40" />
              <ContextMenuItem
                icon={<Trash2 size={16} />}
                label={t('chat.delete')}
                onClick={() => { onDelete!(message.id); setContextMenu(null); }}
                danger
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ContextMenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm min-h-[44px] transition-colors ${
        danger
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 active:bg-red-100 dark:active:bg-red-900/30'
          : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/50 active:bg-neutral-200 dark:active:bg-neutral-700'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
