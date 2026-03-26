import api from '../../lib/api';

export interface Announcement {
  id: string;
  title: string;
  content: string; // TipTap JSON string
  category: 'MAINTENANCE' | 'FEATURE' | 'URGENT';
  isActive: boolean;
  createdBy: { id: string; name: string | null; email: string };
  createdAt: string;
  _count?: { dismissals: number };
}

export interface CreateAnnouncementInput {
  title: string;
  content: string;
  category: 'MAINTENANCE' | 'FEATURE' | 'URGENT';
}

export const getActiveAnnouncements = () =>
  api.get<Announcement[]>('/announcements/active').then(r => r.data);

export const dismissAnnouncement = (id: string) =>
  api.post(`/announcements/${id}/dismiss`);

export const getAnnouncementHistory = (page: number = 1, limit: number = 20) =>
  api.get<{ data: Announcement[]; total: number }>('/announcements/history', { params: { page, limit } }).then(r => r.data);

export const createAnnouncement = (data: CreateAnnouncementInput) =>
  api.post<Announcement>('/admin/announcements', data).then(r => r.data);

export const deactivateAnnouncement = (id: string) =>
  api.put(`/admin/announcements/${id}/deactivate`);

export const deleteAnnouncementApi = (id: string) =>
  api.delete(`/admin/announcements/${id}`);
