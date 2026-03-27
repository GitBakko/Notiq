import api from '../../lib/api';

// ─── Types ──────────────────────────────────────────────────

export interface ChatUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  color: string | null;
}

export interface FriendWithStatus extends ChatUser {
  isOnline?: boolean;
}

export interface FriendRequest {
  id: string;
  from: ChatUser;
  to: ChatUser;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  createdAt: string;
}

export interface MessageReaction {
  messageId: string;
  userId: string;
  user: ChatUser;
  emoji: string;
}

export interface ChatFileDTO {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  mimeType: string;
  size: number;
}

export interface DirectMessageDTO {
  id: string;
  conversationId: string;
  senderId: string;
  sender: ChatUser;
  content: string;
  replyTo: { id: string; content: string; sender: ChatUser } | null;
  reactions: MessageReaction[];
  files: ChatFileDTO[];
  editedAt: string | null;
  isDeleted: boolean;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  type: 'DIRECT' | 'GROUP';
  title: string | null;
  avatarUrl: string | null;
  participants: { userId: string; user: ChatUser; lastReadAt: string; joinedAt: string }[];
  lastMessage: (DirectMessageDTO & { sender: { id: string; name: string | null } }) | null;
  unreadCount: number;
  updatedAt: string;
}

// ─── Friend API ─────────────────────────────────────────────

export const getFriends = () => api.get<ChatUser[]>('/friends').then(r => r.data);
export const getFriendSuggestions = () => api.get<ChatUser[]>('/friends/suggestions').then(r => r.data);
export const searchUsers = (query: string) => api.get<ChatUser[]>('/friends/search', { params: { q: query } }).then(r => r.data);
export const getPendingRequests = () => api.get<FriendRequest[]>('/friends/requests').then(r => r.data);
export const getSentRequests = () => api.get<FriendRequest[]>('/friends/requests/sent').then(r => r.data);
export const sendFriendRequest = (userId: string) => api.post('/friends/request', { userId });
export const acceptFriendRequest = (id: string) => api.post(`/friends/request/${id}/accept`);
export const declineFriendRequest = (id: string) => api.post(`/friends/request/${id}/decline`);
export const blockFriend = (id: string) => api.post(`/friends/${id}/block`);
export const unblockFriend = (id: string) => api.post(`/friends/${id}/unblock`);

// ─── Conversation API ───────────────────────────────────────

export const getConversations = () => api.get<ConversationSummary[]>('/chat-direct/conversations').then(r => r.data);
export const getOrCreateDirectConversation = (userId: string) => api.post<ConversationSummary>('/chat-direct/conversations/direct', { userId }).then(r => r.data);
export const createGroupConversation = (title: string, participantIds: string[]) => api.post<ConversationSummary>('/chat-direct/conversations/group', { title, participantIds }).then(r => r.data);
export const getMessages = (conversationId: string, page: number = 1, limit: number = 50) => api.get<DirectMessageDTO[]>(`/chat-direct/conversations/${conversationId}/messages`, { params: { page, limit } }).then(r => r.data);
export const searchMessages = (conversationId: string, query: string) => api.get<DirectMessageDTO[]>(`/chat-direct/conversations/${conversationId}/search`, { params: { q: query } }).then(r => r.data);
export const getUnreadCount = () => api.get<{ count: number }>('/chat-direct/unread').then(r => r.data.count);

export const uploadChatFile = (conversationId: string, file: File, message?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  if (message) formData.append('message', message);
  return api.post<{ message: DirectMessageDTO }>(`/chat-direct/conversations/${conversationId}/files`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data.message);
};
