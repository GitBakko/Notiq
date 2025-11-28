import { useState, useEffect, useRef } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Send, X, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  content: string;
  timestamp: number;
}

interface ChatSidebarProps {
  provider: HocuspocusProvider | null;
  isOpen: boolean;
  onClose: () => void;
  currentUser: {
    id: string;
    name: string;
    color: string;
  };
}

export default function ChatSidebar({ provider, isOpen, onClose, currentUser }: ChatSidebarProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!provider) return;

    const chatArray = provider.document.getArray<ChatMessage>('chat');

    const updateMessages = () => {
      setMessages(chatArray.toArray());
    };

    chatArray.observe(updateMessages);
    updateMessages();

    return () => {
      chatArray.unobserve(updateMessages);
    };
  }, [provider]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!newMessage.trim() || !provider) return;

    const chatArray = provider.document.getArray<ChatMessage>('chat');
    const message: ChatMessage = {
      id: Math.random().toString(36).substr(2, 9),
      userId: currentUser.id,
      userName: currentUser.name,
      userColor: currentUser.color,
      content: newMessage.trim(),
      timestamp: Date.now(),
    };

    chatArray.push([message]);
    setNewMessage('');
  };

  if (!isOpen) return null;

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
          return (
            <div key={msg.id} className={clsx("flex flex-col", isMe ? "items-end" : "items-start")}>
              <div className="flex items-center gap-1 mb-1">
                {!isMe && (
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white"
                    style={{ backgroundColor: msg.userColor }}
                  >
                    {msg.userName[0]}
                  </div>
                )}
                <span className="text-xs text-gray-500 dark:text-gray-400">{msg.userName}</span>
                <span className="text-[10px] text-gray-400 dark:text-gray-500">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
          />
          <button
            type="submit"
            disabled={!newMessage.trim()}
            className="p-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
