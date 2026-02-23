import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../store/authStore';
import type { KanbanSSEEvent, BoardPresenceUser } from '../types';

interface UseKanbanRealtimeResult {
  presenceUsers: BoardPresenceUser[];
  highlightedCardIds: Set<string>;
}

export function useKanbanRealtime(boardId: string | undefined): UseKanbanRealtimeResult {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const [presenceUsers, setPresenceUsers] = useState<BoardPresenceUser[]>([]);
  const [highlightedCardIds, setHighlightedCardIds] = useState<Set<string>>(new Set());
  const highlightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clean up highlight timers on unmount
  useEffect(() => {
    const timers = highlightTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const handleEvent = useCallback(
    (event: KanbanSSEEvent) => {
      if (event.type === 'presence:update') {
        setPresenceUsers(event.users);
      } else if (event.type === 'chat:message') {
        queryClient.invalidateQueries({ queryKey: ['kanban-board-chat', boardId] });
      } else {
        // Highlight moved cards with a 2s pulse
        if (event.type === 'card:moved') {
          const cardId = event.cardId;
          setHighlightedCardIds((prev) => new Set(prev).add(cardId));

          const existing = highlightTimers.current.get(cardId);
          if (existing) clearTimeout(existing);
          highlightTimers.current.set(
            cardId,
            setTimeout(() => {
              setHighlightedCardIds((prev) => {
                const next = new Set(prev);
                next.delete(cardId);
                return next;
              });
              highlightTimers.current.delete(cardId);
            }, 2000),
          );
        }

        if (event.type !== 'connected') {
          queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });

          // Invalidate card activities so the detail modal stays in sync
          if ('cardId' in event && event.cardId) {
            queryClient.invalidateQueries({ queryKey: ['kanban-card-activities', event.cardId] });
          }
        }
      }
    },
    [boardId, queryClient],
  );

  useEffect(() => {
    if (!boardId) return;

    const token = useAuthStore.getState().token;
    if (!token) return;

    const abortController = new AbortController();
    abortRef.current = abortController;

    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    async function connect(): Promise<void> {
      try {
        const response = await fetch(`/api/kanban/boards/${boardId}/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const event: KanbanSSEEvent = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch {
              // Ignore malformed SSE data
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        reconnectTimeout = setTimeout(connect, 5000);
      }
    }

    connect();

    return () => {
      abortController.abort();
      abortRef.current = null;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      setPresenceUsers([]);
    };
  }, [boardId, handleEvent]);

  return { presenceUsers, highlightedCardIds };
}
