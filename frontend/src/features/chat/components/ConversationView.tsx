import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search, X, Loader2 } from 'lucide-react';
import { useAuthStore } from '../../../store/authStore';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { getMessages, getConversations, searchMessages, type DirectMessageDTO, type ConversationSummary } from '../chatService';
import { useChatContext } from '../ChatContext';
import type { ChatWsEvent } from '../useChatWebSocket';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';

interface ConversationViewProps {
  conversationId: string;
  onBack: () => void;
}

// ─── Date grouping helpers ──────────────────────────────────

function isSameDay(d1: Date, d2: Date) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function getDateLabel(date: Date, t: (key: string) => string): string {
  const now = new Date();
  if (isSameDay(date, now)) return t('chat.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) return t('chat.yesterday');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Main component ────────────────────────────────────────

export default function ConversationView({ conversationId, onBack }: ConversationViewProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const currentUser = useAuthStore(s => s.user);
  const queryClient = useQueryClient();
  const { isConnected, send, on, off } = useChatContext();

  // ─── State ─────────────────────────────────────────────
  const [allMessages, setAllMessages] = useState<DirectMessageDTO[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; content: string; senderName: string } | null>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DirectMessageDTO[] | null>(null);
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastTypingSentRef = useRef(0);

  // ─── Conversation metadata ─────────────────────────────
  const { data: conversations } = useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: getConversations,
    staleTime: 30000,
  });

  const conversation = useMemo(
    () => conversations?.find((c: ConversationSummary) => c.id === conversationId),
    [conversations, conversationId],
  );

  const otherParticipant = useMemo(() => {
    if (!conversation || conversation.type !== 'DIRECT' || !currentUser) return null;
    const p = conversation.participants.find(p => p.userId !== currentUser.id);
    return p?.user ?? null;
  }, [conversation, currentUser]);

  const headerTitle = useMemo(() => {
    if (!conversation) return '';
    if (conversation.type === 'DIRECT') {
      return otherParticipant?.name || otherParticipant?.email || '';
    }
    return conversation.title || t('chat.chatWithMany', { count: conversation.participants.length });
  }, [conversation, otherParticipant, t]);

  // ─── Initial messages load ─────────────────────────────
  const { data: initialMessages } = useQuery({
    queryKey: ['chat', 'messages', conversationId, 1],
    queryFn: () => getMessages(conversationId, 1),
  });

  useEffect(() => {
    if (initialMessages) {
      setAllMessages(initialMessages);
      setPage(1);
      setHasMore(initialMessages.length === 50);
      shouldAutoScrollRef.current = true;
    }
  }, [initialMessages]);

  // Auto-scroll to bottom on initial load and new own messages
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [allMessages]);

  // ─── Load more ────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const olderMessages = await getMessages(conversationId, nextPage);
      if (olderMessages.length === 0) {
        setHasMore(false);
      } else {
        setAllMessages(prev => {
          // Deduplicate by id
          const existingIds = new Set(prev.map(m => m.id));
          const newMsgs = olderMessages.filter(m => !existingIds.has(m.id));
          return [...newMsgs, ...prev];
        });
        setPage(nextPage);
        setHasMore(olderMessages.length === 50);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [conversationId, page, loadingMore, hasMore]);

  // ─── WebSocket event handlers ─────────────────────────
  useEffect(() => {
    const handleNewMessage = (event: ChatWsEvent) => {
      const msg = event.message as DirectMessageDTO;
      if (msg.conversationId !== conversationId) return;

      setAllMessages(prev => {
        // Deduplicate
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg];
      });

      // Auto-scroll if at bottom
      const container = messagesContainerRef.current;
      if (container) {
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        shouldAutoScrollRef.current = atBottom || msg.senderId === currentUser?.id;
      }

      // Send read receipt
      if (msg.senderId !== currentUser?.id) {
        send({ type: 'read:update', conversationId });
      }

      // Remove typing indicator for this sender
      setTypingUsers(prev => {
        const next = new Map(prev);
        next.delete(msg.senderId);
        return next;
      });

      // Refresh conversation list (last message, unread count)
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    };

    const handleEditMessage = (event: ChatWsEvent) => {
      const msg = event.message as DirectMessageDTO;
      if (msg.conversationId !== conversationId) return;
      setAllMessages(prev => prev.map(m => m.id === msg.id ? msg : m));
    };

    const handleDeleteMessage = (event: ChatWsEvent) => {
      const messageId = event.messageId as string;
      const eventConversationId = event.conversationId as string;
      if (eventConversationId !== conversationId) return;
      setAllMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, isDeleted: true, content: '' } : m,
      ));
    };

    const handleTyping = (event: ChatWsEvent) => {
      const eventConversationId = event.conversationId as string;
      const userId = event.userId as string;
      const userName = event.userName as string;
      if (eventConversationId !== conversationId || userId === currentUser?.id) return;

      setTypingUsers(prev => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      // Clear typing after 3s
      const existingTimer = typingTimersRef.current.get(userId);
      if (existingTimer) clearTimeout(existingTimer);
      typingTimersRef.current.set(userId, setTimeout(() => {
        setTypingUsers(prev => {
          const next = new Map(prev);
          next.delete(userId);
          return next;
        });
      }, 3000));
    };

    const handleReaction = (event: ChatWsEvent) => {
      const messageId = event.messageId as string;
      const reactions = event.reactions as DirectMessageDTO['reactions'];
      setAllMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, reactions } : m,
      ));
    };

    const handleReadReceipt = (event: ChatWsEvent) => {
      // Could update read status on messages — for now just invalidate conversations
      void event;
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    };

    // Handle own message acknowledgement (sender sees their message appear)
    const handleAck = (event: ChatWsEvent) => {
      const msg = event.message as DirectMessageDTO;
      if (!msg || msg.conversationId !== conversationId) return;
      setAllMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      shouldAutoScrollRef.current = true;
      // Refresh conversation list (last message, updatedAt)
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    };

    on('message:ack', handleAck);
    on('message:new', handleNewMessage);
    on('message:edited', handleEditMessage);
    on('message:deleted', handleDeleteMessage);
    on('typing:indicator', handleTyping);
    on('reaction:updated', handleReaction);
    on('read:receipt', handleReadReceipt);

    return () => {
      off('message:ack', handleAck);
      off('message:new', handleNewMessage);
      off('message:edited', handleEditMessage);
      off('message:deleted', handleDeleteMessage);
      off('typing:indicator', handleTyping);
      off('reaction:updated', handleReaction);
      off('read:receipt', handleReadReceipt);
    };
  }, [conversationId, currentUser?.id, on, off, send, queryClient]);

  // Send read receipt on open
  useEffect(() => {
    if (isConnected) {
      send({ type: 'read:update', conversationId });
    }
  }, [conversationId, isConnected, send]);

  // Clean up typing timers
  useEffect(() => {
    return () => {
      for (const timer of typingTimersRef.current.values()) clearTimeout(timer);
    };
  }, []);

  // Reset state when conversationId changes
  useEffect(() => {
    setSearchMode(false);
    setSearchQuery('');
    setSearchResults(null);
    setTypingUsers(new Map());
    setReplyTo(null);
  }, [conversationId]);

  // ─── Search ────────────────────────────────────────────
  useEffect(() => {
    if (!searchMode || !searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const results = await searchMessages(conversationId, searchQuery.trim());
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchMode, conversationId]);

  // ─── Typing indicator send (throttled) ─────────────────
  const handleTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current > 2000) {
      send({ type: 'typing:start', conversationId });
      lastTypingSentRef.current = now;
    }
  }, [conversationId, send]);

  // ─── Send message ─────────────────────────────────────
  const handleSend = useCallback((content: string, replyToId?: string) => {
    send({
      type: 'message:send',
      conversationId,
      content,
      replyToId,
      tempId: crypto.randomUUID(),
    });
    shouldAutoScrollRef.current = true;
  }, [conversationId, send]);

  // ─── Message action handlers ──────────────────────────
  const handleReply = useCallback((message: DirectMessageDTO) => {
    setReplyTo({
      id: message.id,
      content: message.content,
      senderName: message.sender.name || message.sender.email,
    });
  }, []);

  const handleReact = useCallback((_messageId: string) => {
    // Will be implemented with emoji picker
  }, []);

  const handleEdit = useCallback((_message: DirectMessageDTO) => {
    // Will be implemented with MessageInput component
  }, []);

  const handleDelete = useCallback((messageId: string) => {
    send({ type: 'message:delete', conversationId, messageId });
  }, [conversationId, send]);

  // ─── Displayed messages (all or search results) ───────
  const displayedMessages = searchResults ?? allMessages;

  // ─── Group messages by date ───────────────────────────
  const messageGroups = useMemo(() => {
    const groups: { label: string; messages: DirectMessageDTO[] }[] = [];
    let currentLabel = '';

    for (const msg of displayedMessages) {
      const date = new Date(msg.createdAt);
      const label = getDateLabel(date, t);

      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [displayedMessages, t]);

  // ─── Typing indicator text ────────────────────────────
  const typingText = useMemo(() => {
    const names = Array.from(typingUsers.values());
    if (names.length === 0) return null;
    if (names.length === 1) return t('chat.typing', { name: names[0] });
    return t('chat.typingMany', { count: names.length });
  }, [typingUsers, t]);

  // ─── Avatar helper ────────────────────────────────────
  const avatarUrl = conversation?.type === 'DIRECT'
    ? otherParticipant?.avatarUrl
    : conversation?.avatarUrl;

  const avatarFallback = headerTitle.charAt(0).toUpperCase();

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-neutral-900">
      {/* ─── Header ──────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-neutral-200/60 dark:border-neutral-800/40 bg-white dark:bg-neutral-950 shrink-0">
        {/* Back button — always on mobile, hidden on desktop */}
        <button
          onClick={onBack}
          className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700 ${
            isMobile ? '' : 'hidden'
          }`}
          aria-label={t('common.back')}
        >
          <ArrowLeft size={20} />
        </button>

        {/* Avatar */}
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-9 h-9 rounded-full object-cover shrink-0"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0"
            style={{ backgroundColor: otherParticipant?.color || '#6b7280' }}
          >
            {avatarFallback}
          </div>
        )}

        {/* Title + status */}
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {headerTitle}
          </h2>
          {conversation?.type === 'DIRECT' && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
              {isConnected ? t('chat.online') : t('chat.offline')}
            </p>
          )}
        </div>

        {/* Search toggle */}
        <button
          onClick={() => {
            setSearchMode(prev => !prev);
            setSearchQuery('');
            setSearchResults(null);
          }}
          className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg transition-colors ${
            searchMode
              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
              : 'hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700'
          }`}
          aria-label={t('common.search')}
        >
          {searchMode ? <X size={20} /> : <Search size={20} />}
        </button>
      </div>

      {/* ─── Search bar ──────────────────────────────────── */}
      {searchMode && (
        <div className="px-3 py-2 border-b border-neutral-200/60 dark:border-neutral-800/40 bg-white dark:bg-neutral-950">
          <input
            type="text"
            autoFocus
            placeholder={t('chat.searchMessages')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-sm border-0 focus:ring-2 focus:ring-emerald-500/40 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
          />
        </div>
      )}

      {/* ─── Messages area ───────────────────────────────── */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {/* Load more */}
        {hasMore && !searchResults && (
          <div className="flex justify-center py-3">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-50 min-h-[44px] flex items-center"
            >
              {loadingMore ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                t('chat.loadMore')
              )}
            </button>
          </div>
        )}

        {/* Message groups */}
        <div className="py-2">
          {messageGroups.map((group) => (
            <div key={group.label}>
              {/* Date separator */}
              <div className="flex items-center justify-center py-2">
                <span className="px-3 py-0.5 rounded-full text-xs bg-neutral-200/70 dark:bg-neutral-800/70 text-neutral-500 dark:text-neutral-400">
                  {group.label}
                </span>
              </div>
              {/* Messages */}
              {group.messages.map((msg, idx) => {
                const prevMsg = idx > 0 ? group.messages[idx - 1] : null;
                const showSender =
                  conversation?.type === 'GROUP' &&
                  msg.senderId !== currentUser?.id &&
                  (!prevMsg || prevMsg.senderId !== msg.senderId);

                return (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isOwn={msg.senderId === currentUser?.id}
                    showSender={showSender}
                    onReply={handleReply}
                    onReact={handleReact}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* Typing indicator */}
        {typingText && (
          <div className="px-4 py-1.5">
            <span className="text-xs text-neutral-400 dark:text-neutral-500 italic">
              {typingText}
              <span className="inline-flex ml-1">
                <span className="animate-bounce [animation-delay:0ms]">.</span>
                <span className="animate-bounce [animation-delay:150ms]">.</span>
                <span className="animate-bounce [animation-delay:300ms]">.</span>
              </span>
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ─── Input area ──────────────────────────────────── */}
      <MessageInput
        conversationId={conversationId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={handleSend}
        onTyping={handleTyping}
        disabled={!isConnected}
      />
    </div>
  );
}
