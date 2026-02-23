import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotifications, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications } from '../features/notifications/notificationService';
import { playNotificationSound } from '../utils/notificationSound';

export const useNotifications = () => {
  const queryClient = useQueryClient();
  const prevUnreadCountRef = useRef<number>(0);
  const isInitializedRef = useRef(false);

  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: getNotifications,
    refetchInterval: 30000, // Poll every 30 seconds
  });

  const markAsReadMutation = useMutation({
    mutationFn: markAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllAsReadMutation = useMutation({
    mutationFn: markAllAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteNotification,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: deleteAllNotifications,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const unreadCount = notifications?.filter((n) => !n.isRead).length || 0;

  // Play sound when new unread notifications arrive
  useEffect(() => {
    if (!notifications) return;

    if (!isInitializedRef.current) {
      prevUnreadCountRef.current = unreadCount;
      isInitializedRef.current = true;
      return;
    }

    if (unreadCount > prevUnreadCountRef.current) {
      playNotificationSound();
    }

    prevUnreadCountRef.current = unreadCount;
  }, [notifications, unreadCount]);

  return {
    notifications,
    isLoading,
    unreadCount,
    markAsRead: markAsReadMutation.mutate,
    markAllAsRead: markAllAsReadMutation.mutate,
    deleteNotification: deleteMutation.mutate,
    deleteAllNotifications: deleteAllMutation.mutate,
  };
};
