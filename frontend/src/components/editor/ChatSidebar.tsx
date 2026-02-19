import { useState, useEffect, useRef, useMemo } from 'react';
import { Send, X, MessageSquare, Smile } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import toast from 'react-hot-toast';
import EmojiPicker, { Theme } from 'emoji-picker-react';

interface ChatMessage {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    color: string | null;
    avatarUrl: string | null;
  }
}

interface ChatSidebarProps {
  noteId: string;
  isOpen: boolean;
  onClose: () => void;
  currentUser: {
    id: string;
    name: string;
    color: string;
    avatarUrl?: string | null;
  };
  onNewMessage?: () => void;
  participants?: { id: string; name: string | null; email: string }[];
  noteOwner?: { id: string };
}

// Simple notification sound (Beep)
const BEEP_SOUND = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';

export default function ChatSidebar({ noteId, isOpen, onClose, currentUser, onNewMessage, participants = [], noteOwner }: ChatSidebarProps) {
  const { t } = useTranslation();
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const chatTitle = useMemo(() => {
    // Build list of "other" participants (exclude current user)
    const others = participants.filter(p => p.id !== currentUser.id);
    // If current user is not the owner, the owner is also a participant
    if (noteOwner && noteOwner.id !== currentUser.id && !others.some(p => p.id === noteOwner.id)) {
      // Owner info comes from sharedWith users or messages — we may not have name here
      // We'll count them but can't show name; this edge case is rare since owner always has a share entry
      others.push({ id: noteOwner.id, name: null, email: '' });
    }
    if (others.length === 0) return t('chat.title');
    if (others.length === 1) {
      return t('chat.chatWith', { name: others[0].name || others[0].email || t('chat.title') });
    }
    return t('chat.chatWithMany', { count: others.length });
  }, [participants, currentUser.id, noteOwner, t]);

  // Helper to detect theme (simple version)
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [prevMessageCount, setPrevMessageCount] = useState(0);
  const isInitializedRef = useRef(false);

  // Fetch messages
  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['chat', noteId],
    queryFn: async () => {
      const res = await api.get<ChatMessage[]>(`/chat/${noteId}`);
      return res.data;
    },
    enabled: !!noteId,
    refetchInterval: 3000,
  });

  // Sound and Notification Logic
  useEffect(() => {
    if (isLoading) return;

    if (!isInitializedRef.current) {
      setPrevMessageCount(messages.length);
      isInitializedRef.current = true;
      return;
    }

    if (messages.length > prevMessageCount) {
      const sound = new Audio(BEEP_SOUND);
      sound.volume = 0.5;
      sound.play().catch(e => console.warn('Audio play failed', e));

      if (!isOpen && onNewMessage) {
        onNewMessage();
      }
    }
    setPrevMessageCount(messages.length);
  }, [messages.length, isOpen, onNewMessage, prevMessageCount, isLoading]);

  // Send message
  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      await api.post('/chat', { noteId, content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat', noteId] });
    },
    onError: () => {
      toast.error(t('chat.sendFailed', 'Failed to send message'));
    }
  });

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const content = newMessage.trim();
    if (!content) return;

    setIsSending(true);
    setNewMessage('');
    setShowEmojiPicker(false);

    try {
      await sendMutation.mutateAsync(content);
    } catch (err) {
      // Error handled in mutation
    } finally {
      setIsSending(false);
    }
  };

  const onEmojiClick = (emojiData: any) => {
    setNewMessage(prev => prev + emojiData.emoji);
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="w-[350px] border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col fixed right-0 top-[60px] bottom-0 z-20 shadow-xl print:hidden">
      <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-800">
        <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <MessageSquare size={18} />
          {chatTitle}
        </h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" title={t('common.close')}>
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => {
          const isMe = msg.userId === currentUser.id;
          const userName = msg.user.name || msg.user.email;
          const msgColor = isMe ? currentUser.color : (msg.user.color || '#319795');
          const msgAvatarUrl = isMe ? currentUser.avatarUrl : msg.user.avatarUrl;
          const initial = isMe ? 'ME' : (userName[0]?.toUpperCase() || '?');

          return (
            <div key={msg.id} className={clsx("flex flex-col", isMe ? "items-end" : "items-start")}>
              <div className="flex items-center gap-1 mb-1">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white overflow-hidden relative flex-shrink-0"
                  style={{ backgroundColor: msgColor }}
                >
                  {msgAvatarUrl ? (
                    <>
                      <img src={msgAvatarUrl} alt="" className="w-full h-full object-cover absolute inset-0" />
                      <span className="relative z-10 text-[7px] font-bold text-white" style={{ textShadow: '0 0 2px rgba(0,0,0,0.9)' }}>{initial}</span>
                    </>
                  ) : (
                    <span>{initial}</span>
                  )}
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400">{isMe ? t('collaboration.you') : userName}</span>
                <span className="text-[10px] text-gray-400 dark:text-gray-500">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div
                className={clsx(
                  "px-3 py-2 rounded-lg text-sm max-w-[85%] break-words",
                  isMe
                    ? "bg-emerald-600 text-white rounded-tr-none"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-tl-none"
                )}
              >
                {msg.content}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 relative">
        <div className="flex gap-2">
          <textarea
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t('chat.placeholder', 'Type a message...')}
            rows={1}
            className="flex-1 rounded-md border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:ring-emerald-500 focus:border-emerald-500 disabled:opacity-50 px-4 py-2 resize-none overflow-hidden min-h-[40px] max-h-[120px]"
            style={{ height: newMessage.split('\n').length > 1 ? 'auto' : '40px' }}
            disabled={isSending || sendMutation.isPending}
            // Auto-grow logic
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
            }}
          />

          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700"
            title={t('chat.addEmoji')}
          >
            <Smile size={20} />
          </button>

          {showEmojiPicker && (
            <div className="absolute bottom-16 right-4 z-50 shadow-2xl">
              <div className="fixed inset-0 z-40" onClick={() => setShowEmojiPicker(false)}></div>
              <div className="relative z-50">
                <EmojiPicker
                  onEmojiClick={onEmojiClick}
                  theme={isDark ? Theme.DARK : Theme.LIGHT}
                  width={300}
                  height={400}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={!newMessage.trim() || isSending || sendMutation.isPending}
            className="p-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title={t('chat.send')}
          >
            {isSending ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <Send size={18} />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
