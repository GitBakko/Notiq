import api from '../../lib/api';

export interface GroupMember {
  userId: string;
  joinedAt: string;
  user: { id: string; email: string; name: string | null };
}

export interface PendingInvite {
  id: string;
  email: string;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  description?: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  members: GroupMember[];
  pendingInvites?: PendingInvite[];
  owner?: { id: string; email: string; name: string | null };
  _count?: { members: number };
}

export interface MyGroupsResponse {
  owned: Group[];
  memberOf: Group[];
}

export const getMyGroups = async (): Promise<MyGroupsResponse> => {
  const res = await api.get<MyGroupsResponse>('/groups');
  return res.data;
};

export const getGroupsForSharing = async (): Promise<Group[]> => {
  const res = await api.get<Group[]>('/groups/for-sharing');
  return res.data;
};

export const getGroup = async (id: string): Promise<Group> => {
  const res = await api.get<Group>(`/groups/${id}`);
  return res.data;
};

export const createGroup = async (data: { name: string; description?: string }): Promise<Group> => {
  const res = await api.post<Group>('/groups', data);
  return res.data;
};

export const updateGroup = async (id: string, data: { name?: string; description?: string }): Promise<Group> => {
  const res = await api.put<Group>(`/groups/${id}`, data);
  return res.data;
};

export const deleteGroup = async (id: string): Promise<void> => {
  await api.delete(`/groups/${id}`);
};

export const addGroupMember = async (groupId: string, email: string) => {
  const res = await api.post(`/groups/${groupId}/members`, { email });
  return res.data;
};

export const removeGroupMember = async (groupId: string, userId: string) => {
  await api.delete(`/groups/${groupId}/members/${userId}`);
};

export const removePendingInvite = async (groupId: string, email: string) => {
  await api.delete(`/groups/${groupId}/pending`, { data: { email } });
};

export const shareNoteWithGroup = async (noteId: string, groupId: string, permission: 'READ' | 'WRITE' = 'READ') => {
  const res = await api.post(`/share/notes/${noteId}/group`, { groupId, permission });
  return res.data;
};

export const shareNotebookWithGroup = async (notebookId: string, groupId: string, permission: 'READ' | 'WRITE' = 'READ') => {
  const res = await api.post(`/share/notebooks/${notebookId}/group`, { groupId, permission });
  return res.data;
};
