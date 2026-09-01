import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { useAuthStore } from '../../../store/authStore';
import { db } from '../../../lib/db';
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
        queryClient.invalidateQueries({ queryKey: queryKeys.kanban.boardChat(boardId!) });
      } else if (event.type === 'connected') {
        // No action needed
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

        // Write SSE events to Dexie for offline-first consistency
        updateDexieFromSSE(event, boardId!).catch(() => {});

        // Still invalidate React Query for the board detail view (shares, notes, etc.)
        queryClient.invalidateQueries({ queryKey: queryKeys.kanban.board(boardId!) });

        // Invalidate card activities so the detail modal stays in sync
        if ('cardId' in event && event.cardId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.kanban.cardActivities(event.cardId) });
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
    let attempt = 0;

    // [BACKUP] 2026-08-31 — the old code only retried from the catch block, with a
    // flat setTimeout(connect, 5000). A non-OK response (401/403/502) and a clean
    // stream end both returned bare, killing realtime for the whole session:
    //
    //   if (!response.ok || !response.body) return;
    //   ...
    //   } catch (err: unknown) {
    //     if (err instanceof Error && err.name === 'AbortError') return;
    //     reconnectTimeout = setTimeout(connect, 5000);
    //   }
    //
    // Now every exit path schedules a reconnect except a deliberate abort.
    // Bounded exponential backoff: 2s, 4s, 8s, 16s, capped at 30s, retried for as
    // long as the board stays mounted. The cleanup's abort() stops it for good.
    function scheduleReconnect(): void {
      if (abortController.signal.aborted) return;
      const delay = Math.min(30_000, 2000 * 2 ** attempt);
      attempt += 1;
      reconnectTimeout = setTimeout(connect, delay);
    }

    async function connect(): Promise<void> {
      try {
        const response = await fetch(`/api/kanban/boards/${boardId}/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          scheduleReconnect();
          return;
        }

        // Connected: reset the backoff so the next drop retries quickly.
        attempt = 0;

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

        // Clean EOF: the server closed the stream. Reconnect.
        scheduleReconnect();
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        scheduleReconnect();
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

/** Write SSE events directly to Dexie so offline reads stay current */
async function updateDexieFromSSE(event: KanbanSSEEvent, boardId: string): Promise<void> {
  switch (event.type) {
    case 'card:created': {
      const { card } = event;
      await db.kanbanCards.put({
        id: card.id,
        title: card.title,
        description: card.description,
        position: card.position,
        columnId: card.columnId,
        boardId,
        assigneeId: card.assigneeId,
        assignee: card.assignee,
        dueDate: card.dueDate,
        priority: card.priority,
        noteId: card.noteId,
        noteLinkedById: card.noteLinkedById,
        note: card.note,
        commentCount: card.commentCount,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        syncStatus: 'synced',
      });
      break;
    }
    case 'card:updated': {
      const { card } = event;
      const local = await db.kanbanCards.get(card.id);
      // Don't clobber dirty local changes
      if (local && local.syncStatus !== 'synced') break;
      await db.kanbanCards.put({
        id: card.id,
        title: card.title,
        description: card.description,
        position: card.position,
        columnId: card.columnId,
        boardId,
        assigneeId: card.assigneeId,
        assignee: card.assignee,
        dueDate: card.dueDate,
        priority: card.priority,
        noteId: card.noteId,
        noteLinkedById: card.noteLinkedById,
        note: card.note,
        commentCount: card.commentCount,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        syncStatus: 'synced',
      });
      break;
    }
    case 'card:deleted':
      await db.kanbanCards.delete(event.cardId);
      break;
    case 'card:moved': {
      const local = await db.kanbanCards.get(event.cardId);
      if (local && local.syncStatus !== 'synced') break;
      await db.kanbanCards.update(event.cardId, {
        columnId: event.toColumnId,
        position: event.position,
        syncStatus: 'synced',
      });
      break;
    }
    case 'column:created': {
      const { column } = event;
      await db.kanbanColumns.put({
        id: column.id,
        title: column.title,
        position: column.position,
        boardId,
        isCompleted: column.isCompleted ?? false,
        syncStatus: 'synced',
      });
      break;
    }
    case 'column:updated': {
      const { column } = event;
      const localCol = await db.kanbanColumns.get(column.id);
      if (localCol && localCol.syncStatus !== 'synced') break;
      await db.kanbanColumns.put({
        id: column.id,
        title: column.title,
        position: column.position,
        boardId,
        isCompleted: column.isCompleted ?? false,
        syncStatus: 'synced',
      });
      break;
    }
    case 'column:deleted':
      await db.kanbanColumns.delete(event.columnId);
      // Also remove cards in this column
      await db.kanbanCards.where('columnId').equals(event.columnId).delete();
      break;
    case 'columns:reordered':
      for (const { id, position } of event.columns) {
        const localCol = await db.kanbanColumns.get(id);
        if (localCol && localCol.syncStatus !== 'synced') continue;
        await db.kanbanColumns.update(id, { position });
      }
      break;
  }
}
