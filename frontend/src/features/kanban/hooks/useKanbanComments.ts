import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getComments, createComment, deleteComment } from '../kanbanService';

export function useKanbanComments(cardId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: comments, isLoading } = useQuery({
    queryKey: ['kanban-comments', cardId],
    queryFn: () => getComments(cardId!),
    enabled: !!cardId,
  });

  const addComment = useMutation({
    mutationFn: (content: string) => createComment(cardId!, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban-comments', cardId] });
      queryClient.invalidateQueries({ queryKey: ['kanban-board'] });
    },
  });

  const removeComment = useMutation({
    mutationFn: deleteComment,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-comments', cardId] }),
  });

  return { comments, isLoading, addComment, removeComment };
}
