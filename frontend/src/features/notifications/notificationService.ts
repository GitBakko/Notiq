import api from '../../lib/api';

export interface Notification {
  id: string;
  userId: string;
  type: 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'SYSTEM' | 'REMINDER' | 'CHAT_MESSAGE' | 'GROUP_INVITE' | 'GROUP_REMOVE';
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
