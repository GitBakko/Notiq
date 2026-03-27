import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/authStore';
import { getConversations, type ConversationSummary, type ChatUser } from '../chatService';
import { Plus, Search, MessageCircle, Users } from 'lucide-react';
import clsx from 'clsx';

interface ConversationListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat?: () => void;
  onNewGroup?: () => void;
}

function getOtherUser(conv: ConversationSummary, currentUserId: string): ChatUser | null {
  if (conv.type !== 'DIRECT') return null;
  return conv.participants.find(p => p.userId !== currentUserId)?.user || null;
}

function getDisplayName(conv: ConversationSummary, currentUserId: string): string {
  if (conv.type === 'GROUP') return conv.title || 'Group';
  const other = getOtherUser(conv, currentUserId);
  return other?.name || other?.email || 'Unknown';
}

function getAvatar(conv: ConversationSummary, currentUserId: string) {
  if (conv.type === 'GROUP') return { initial: (conv.title || 'G').charAt(0).toUpperCase(), color: '#6b7280', avatarUrl: conv.avatarUrl };
  const other = getOtherUser(conv, currentUserId);
  return { initial: (other?.name || other?.email || '?').charAt(0).toUpperCase(), color: other?.color || '#6b7280', avatarUrl: other?.avatarUrl || null };
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  if (diffHours < 48) return 'Yesterday';
  return date.toLocaleDateString();
}

export default function ConversationList({ selectedId, onSelect, onNewChat, onNewGroup }: ConversationListProps) {
  const { t } = useTranslation();
  const user = useAuthStore(s => s.user);
  const [search, setSearch] = useState('');

  const { data: conversations } = useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: getConversations,
    refetchInterval: 30000,
  });

  const filtered = (conversations || []).filter(conv => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const name = getDisplayName(conv, user?.id || '').toLowerCase();
    const lastMsg = conv.lastMessage?.content?.toLowerCase() || '';
    return name.includes(q) || lastMsg.includes(q);
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header - hidden on mobile (ChatPage handles it) */}
      <div className="hidden sm:flex items-center justify-between px-4 py-3 border-b border-neutral-200/60 dark:border-neutral-800/40">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">{t('chat.title')}</h2>
        <div className="flex items-center gap-1">
          {onNewGroup && (
            <button onClick={onNewGroup} className="p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-300" aria-label={t('chat.newGroup')}>
              <Users size={18} />
            </button>
          )}
          {onNewChat && (
            <button onClick={onNewChat} className="p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-300" aria-label={t('chat.newChat')}>
              <Plus size={20} />
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('chat.search')}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-sm text-neutral-900 dark:text-white placeholder:text-neutral-400 border-0 focus:ring-2 focus:ring-emerald-500/40"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6">
            <MessageCircle size={40} className="text-neutral-300 dark:text-neutral-600 mb-3" />
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('chat.noConversations')}</p>
          </div>
        ) : (
          filtered.map(conv => {
            const avatar = getAvatar(conv, user?.id || '');
            const displayName = getDisplayName(conv, user?.id || '');
            const isSelected = conv.id === selectedId;
            const lastMsg = conv.lastMessage;

            return (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={clsx(
                  'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors min-h-[68px]',
                  isSelected
                    ? 'bg-emerald-50 dark:bg-emerald-900/20'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                )}
              >
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  <div className="w-11 h-11 rounded-full flex items-center justify-center font-bold text-white text-sm overflow-hidden"
                       style={{ backgroundColor: avatar.color }}>
                    {avatar.avatarUrl ? (
                      <img src={avatar.avatarUrl} alt="" className="w-full h-full object-cover" />
                    ) : avatar.initial}
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-neutral-900 dark:text-white truncate">{displayName}</span>
                    {lastMsg && (
                      <span className="text-[11px] text-neutral-400 dark:text-neutral-500 flex-shrink-0 ml-2">
                        {formatTime(lastMsg.createdAt)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                      {lastMsg ? (
                        lastMsg.isDeleted ? <em>{t('chat.messageDeleted')}</em> : lastMsg.content
                      ) : t('chat.noMessages')}
                    </p>
                    {conv.unreadCount > 0 && (
                      <span className="flex-shrink-0 ml-2 min-w-[20px] h-5 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[11px] font-bold px-1.5">
                        {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
