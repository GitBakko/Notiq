import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useChatWebSocket, type ChatWsEvent } from './useChatWebSocket';

interface ChatContextValue {
  isConnected: boolean;
  send: (event: Record<string, unknown>) => void;
  on: (type: string, handler: (event: ChatWsEvent) => void) => void;
  off: (type: string, handler: (event: ChatWsEvent) => void) => void;
  isUserOnline: (userId: string) => boolean;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { isConnected, send, on, off } = useChatWebSocket();
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handleInit = (event: ChatWsEvent) => {
      if (event.type === 'presence:init') {
        setOnlineUsers(new Set(event.onlineFriends as string[]));
      }
    };
    const handleUpdate = (event: ChatWsEvent) => {
      if (event.type === 'presence:update') {
        setOnlineUsers(prev => {
          const next = new Set(prev);
          if (event.isOnline) next.add(event.userId as string);
          else next.delete(event.userId as string);
          return next;
        });
      }
    };

    on('presence:init', handleInit);
    on('presence:update', handleUpdate);

    return () => {
      off('presence:init', handleInit);
      off('presence:update', handleUpdate);
    };
  }, [on, off]);

  const isUserOnline = useCallback(
    (userId: string) => onlineUsers.has(userId),
    [onlineUsers],
  );

  return (
    <ChatContext.Provider value={{ isConnected, send, on, off, isUserOnline }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}
