import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { getBoardChat, sendBoardChatMessage } from '../kanbanService';

export function useKanbanChat(boardId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: messages = [], isLoading } = useQuery({
    queryKey: queryKeys.kanban.boardChat(boardId!),
    queryFn: () => getBoardChat(boardId!),
    enabled: !!boardId,
    refetchInterval: 3000,
  });

  const sendMessage = useMutation({
    mutationFn: (content: string) => sendBoardChatMessage(boardId!, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.kanban.boardChat(boardId!) });
    },
  });

  return { messages, isLoading, sendMessage };
}
