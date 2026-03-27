import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '../../store/authStore';

// WS event types from server
export interface ChatWsEvent {
  type: string;
  [key: string]: unknown;
}

type EventHandler = (event: ChatWsEvent) => void;

export function useChatWebSocket() {
  const token = useAuthStore(s => s.token);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Map<string, Set<EventHandler>>());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!token || wsRef.current?.readyState === WebSocket.OPEN) return;

    // Build WS URL from current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = import.meta.env.VITE_WS_URL
      ? import.meta.env.VITE_WS_URL.replace('/ws', '/chat-ws') + `?token=${token}`
      : `${protocol}//${window.location.host}/chat-ws?token=${token}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setIsConnected(true);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ChatWsEvent;
        const handlers = handlersRef.current.get(data.type);
        if (handlers) {
          for (const handler of handlers) handler(data);
        }
        // Also fire wildcard handlers
        const wildcardHandlers = handlersRef.current.get('*');
        if (wildcardHandlers) {
          for (const handler of wildcardHandlers) handler(data);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      wsRef.current = null;

      // Exponential backoff reconnect: 1s, 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
      reconnectAttemptRef.current++;
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, [token]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Send a message through WS
  const send = useCallback((event: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  // Subscribe to an event type
  const on = useCallback((type: string, handler: EventHandler) => {
    if (!handlersRef.current.has(type)) {
      handlersRef.current.set(type, new Set());
    }
    handlersRef.current.get(type)!.add(handler);
  }, []);

  // Unsubscribe from an event type
  const off = useCallback((type: string, handler: EventHandler) => {
    handlersRef.current.get(type)?.delete(handler);
  }, []);

  return { isConnected, send, on, off };
}
