import { useState, useEffect, useRef } from 'react';
import { Send, X, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import toast from 'react-hot-toast';

interface ChatMessage {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
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
  };
  onNewMessage?: () => void;
}

// Simple notification sound (Beep)
const BEEP_SOUND = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';

export default function ChatSidebar({ noteId, isOpen, onClose, currentUser, onNewMessage }: ChatSidebarProps) {
  const { t } = useTranslation();
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
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
    // If loading, do nothing
    if (isLoading) return;

    // First load: just sync state, don't notify
    if (!isInitializedRef.current) {
      setPrevMessageCount(messages.length);
      isInitializedRef.current = true;
      return;
    }

    // Subsequent updates
    if (messages.length > prevMessageCount) {
      // Play sound
      const sound = new Audio(BEEP_SOUND);
      sound.volume = 0.5;
      sound.play().catch(e => console.warn('Audio play failed', e));

      // Notify parent if closed
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

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    const content = newMessage.trim();
    if (!content) return;

    setNewMessage(''); // Optimistic clear
    sendMutation.mutate(content);
  };

  // Helper for colors
  const getUserColor = (id: string, name: string) => {
    let hash = 0;
    const str = id + name;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - c.length) + c;
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div className="w-80 border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col h-full absolute right-0 top-0 z-20 shadow-xl">
      <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-800">
        <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <MessageSquare size={18} />
          {t('chat.title', 'Chat')}
        </h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => {
          const isMe = msg.userId === currentUser.id;
          const userName = msg.user.name || msg.user.email;
          const userColor = getUserColor(msg.userId, userName);

          return (
            <div key={msg.id} className={clsx("flex flex-col", isMe ? "items-end" : "items-start")}>
              <div className="flex items-center gap-1 mb-1">
                {!isMe && (
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white"
                    style={{ backgroundColor: userColor }}
                  >
                    {userName[0].toUpperCase()}
                  </div>
                )}
                <span className="text-xs text-gray-500 dark:text-gray-400">{userName}</span>
                <span className="text-[10px] text-gray-400 dark:text-gray-500">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div
                className={clsx(
                  "px-3 py-2 rounded-lg text-sm max-w-[85%]",
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

      <form onSubmit={handleSend} className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder={t('chat.placeholder', 'Type a message...')}
            className="flex-1 rounded-md border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:ring-emerald-500 focus:border-emerald-500"
            disabled={sendMutation.isPending}
          />
          <button
            type="submit"
            disabled={!newMessage.trim() || sendMutation.isPending}
            className="p-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
