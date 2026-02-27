import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Send, ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useKanbanChat } from '../hooks/useKanbanChat';
import { playNotificationSound } from '../../../utils/notificationSound';
import type { KanbanBoardChatMessage, BoardPresenceUser } from '../types';

interface BoardChatSidebarProps {
  boardId: string;
  isOpen: boolean;
  onClose: () => void;
  currentUser: {
    id: string;
    name: string;
    color: string;
    avatarUrl?: string | null;
  };
  onNewMessage?: () => void;
  participants?: BoardPresenceUser[];
}

export default function BoardChatSidebar({
  boardId,
  isOpen,
  onClose,
  currentUser,
  onNewMessage,
  participants = [],
}: BoardChatSidebarProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  // Always fetch chat — sound/badge must work even when sidebar is closed
  const { messages, isLoading, sendMessage } = useKanbanChat(boardId);
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const isInitializedRef = useRef(false);

  // Auto-scroll on new messages (only when open)
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isOpen]);

  // Sound + badge notification on new messages
  useEffect(() => {
    if (isLoading) return;
    if (!isInitializedRef.current) {
      prevMessageCountRef.current = messages.length;
      isInitializedRef.current = true;
      return;
    }
    if (messages.length > prevMessageCountRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.authorId !== currentUser.id) {
        // Always play sound (chat open or closed)
        playNotificationSound();
        // Badge only when chat is closed
        if (!isOpen && onNewMessage) onNewMessage();
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isOpen, onNewMessage, currentUser.id, isLoading, messages]);

  // Chat title based on participants
  const chatTitle = useMemo(() => {
    const others = participants.filter((p) => p.id !== currentUser.id);
    if (others.length === 0) return t('kanban.chat.title');
    if (others.length === 1)
      return t('kanban.chat.chatWith', { name: others[0].name || '?' });
    return t('kanban.chat.chatWithMany', { count: others.length });
  }, [participants, currentUser.id, t]);

  function handleSend(): void {
    const trimmed = newMessage.trim();
    if (!trimmed) return;
    sendMessage.mutate(trimmed, {
      onSuccess: () => setNewMessage(''),
    });
  }

  if (!isOpen) return null;

  const chatContent = (
    <>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-emerald-600" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-center text-xs text-gray-400 dark:text-gray-500 py-8">
            {t('kanban.chat.empty')}
          </p>
        ) : (
          messages.map((msg: KanbanBoardChatMessage) => {
            const isMe = msg.authorId === currentUser.id;
            const msgColor = isMe
              ? currentUser.color
              : msg.author.color || '#319795';
            const initial = isMe
              ? (currentUser.name?.charAt(0)?.toUpperCase() || '?')
              : (msg.author.name?.charAt(0)?.toUpperCase() || msg.author.email?.charAt(0)?.toUpperCase() || '?');

            return (
              <div
                key={msg.id}
                className={clsx('flex flex-col', isMe ? 'items-end' : 'items-start')}
              >
                <div className="flex items-center gap-1 mb-1">
                  {(isMe ? currentUser.avatarUrl : msg.author.avatarUrl) ? (
                    <img
                      src={(isMe ? currentUser.avatarUrl! : msg.author.avatarUrl!).replace(/^https?:\/\/localhost:\d+/, '')}
                      alt=""
                      className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white flex-shrink-0"
                      style={{ backgroundColor: msgColor }}
                    >
                      {initial}
                    </div>
                  )}
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {isMe ? t('kanban.chat.you') : (msg.author.name || msg.author.email)}
                  </span>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div
                  className={clsx(
                    'px-3 py-2 rounded-lg text-sm max-w-[85%] break-words',
                    isMe
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100',
                  )}
                >
                  {msg.content}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className={clsx("px-4 py-3 border-t border-gray-200 dark:border-gray-700", isMobile && "safe-area-bottom")}>
        <div className="flex items-center gap-2">
          <input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t('kanban.chat.placeholder')}
            className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none focus:border-emerald-500"
          />
          <button
            onClick={handleSend}
            disabled={!newMessage.trim() || sendMessage.isPending}
            className="p-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 flex flex-col">
        {/* Mobile Header with back button */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 safe-area-top">
          <button
            onClick={onClose}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label={t('common.back')}
          >
            <ArrowLeft size={20} />
          </button>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
            {chatTitle}
          </h3>
        </div>
        {chatContent}
      </div>
    );
  }

  // Desktop: existing sidebar layout
  return (
    <div className="w-80 flex-shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {chatTitle}
        </h3>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
        >
          <X size={16} />
        </button>
      </div>
      {chatContent}
    </div>
  );
}
