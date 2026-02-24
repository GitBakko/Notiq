import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

export interface KanbanReminderItem {
  id: string;
  cardId: string;
  boardId: string;
  dueDate: string;
  isDone: boolean;
  cardTitle: string;
  boardTitle: string;
  columnTitle: string;
  boardAvatarUrl: string | null;
}

export function useKanbanReminders() {
  return useQuery({
    queryKey: ['kanban-reminders'],
    queryFn: async () => {
      const res = await api.get<KanbanReminderItem[]>('/kanban/reminders');
      return res.data;
    },
  });
}

export function useToggleKanbanReminder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isDone }: { id: string; isDone: boolean }) =>
      api.put(`/kanban/reminders/${id}`, { isDone }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kanban-reminders'] });
    },
  });
}
