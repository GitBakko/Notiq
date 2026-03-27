import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useChatWebSocket, type ChatWsEvent } from './useChatWebSocket';
import { useAuthStore } from '../../store/authStore';
import { playNotificationSound } from '../../utils/notificationSound';
import { useQueryClient } from '@tanstack/react-query';

interface ChatContextValue {
  isConnected: boolean;
  send: (event: Record<string, unknown>) => void;
  on: (type: string, handler: (event: ChatWsEvent) => void) => void;
  off: (type: string, handler: (event: ChatWsEvent) => void) => void;
  isUserOnline: (userId: string) => boolean;
  /** Currently focused conversation ID (set by ConversationView) */
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { isConnected, send, on, off } = useChatWebSocket();
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const activeConvRef = useRef<string | null>(null);
  const currentUserId = useAuthStore(s => s.user?.id);
  const queryClient = useQueryClient();

  // Keep ref in sync for use in event handlers (avoid stale closures)
  useEffect(() => { activeConvRef.current = activeConversationId; }, [activeConversationId]);

  useEffect(() => {
    const handleInit = (event: ChatWsEvent) => {
      setOnlineUsers(new Set(event.onlineFriends as string[]));
    };
    const handlePresence = (event: ChatWsEvent) => {
      setOnlineUsers(prev => {
        const next = new Set(prev);
        if (event.isOnline) next.add(event.userId as string);
        else next.delete(event.userId as string);
        return next;
      });
    };

    // Tier 2 notification: sound + badge refresh for messages in OTHER conversations
    const handleNewMessage = (event: ChatWsEvent) => {
      const msg = event.message as { conversationId?: string; senderId?: string };
      if (!msg?.conversationId || msg.senderId === currentUserId) return;

      // If message is NOT for the currently focused conversation → play sound
      if (msg.conversationId !== activeConvRef.current) {
        playNotificationSound();
      }

      // Always refresh conversation list (for unread badges + last message)
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    };

    on('presence:init', handleInit);
    on('presence:update', handlePresence);
    on('message:new', handleNewMessage);

    return () => {
      off('presence:init', handleInit);
      off('presence:update', handlePresence);
      off('message:new', handleNewMessage);
    };
  }, [on, off, currentUserId, queryClient]);

  const isUserOnline = useCallback(
    (userId: string) => onlineUsers.has(userId),
    [onlineUsers],
  );

  return (
    <ChatContext.Provider value={{ isConnected, send, on, off, isUserOnline, activeConversationId, setActiveConversationId }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}
