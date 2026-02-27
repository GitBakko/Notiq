import api from '../../lib/api';

export interface Notification {
  id: string;
  userId: string;
  type: 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'SYSTEM' | 'REMINDER' | 'CHAT_MESSAGE' | 'GROUP_INVITE' | 'GROUP_REMOVE' | 'TASK_ITEM_ADDED' | 'TASK_ITEM_CHECKED' | 'TASK_ITEM_REMOVED' | 'TASK_LIST_SHARED' | 'KANBAN_BOARD_SHARED' | 'KANBAN_CARD_ASSIGNED' | 'KANBAN_COMMENT_ADDED' | 'KANBAN_COMMENT_DELETED' | 'KANBAN_CARD_MOVED';
  title: string;
  message: string;
  data?: any;
  isRead: boolean;
  createdAt: string;
}

export const getNotifications = async (): Promise<Notification[]> => {
  const response = await api.get('/notifications');
  return response.data;
};

export const markAsRead = async (id: string): Promise<void> => {
  await api.put(`/notifications/${id}/read`);
};

export const markAllAsRead = async (): Promise<void> => {
  await api.put('/notifications/read-all');
};

export const deleteNotification = async (id: string): Promise<void> => {
  await api.delete(`/notifications/${id}`);
};

export const deleteAllNotifications = async (): Promise<void> => {
  await api.delete('/notifications/all');
};
