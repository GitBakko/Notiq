import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { getBoardChat, sendBoardChatMessage } from '../kanbanService';

export function useKanbanChat(boardId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: messages = [], isLoading } = useQuery({
    queryKey: queryKeys.kanban.boardChat(boardId!),
    queryFn: () => getBoardChat(boardId!),
    enabled: !!boardId,
    // No polling (5.3): useKanbanRealtime invalidates this query on every SSE
    // chat:message and on every (re)connection, which covers messages sent while the
    // stream was down. It used to refetch every 3 s on top of that.
  });

  const sendMessage = useMutation({
    mutationFn: (content: string) => sendBoardChatMessage(boardId!, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.kanban.boardChat(boardId!) });
    },
  });

  return { messages, isLoading, sendMessage };
}
