import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Search, UserPlus, MessageCircle, Users, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Modal from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import {
  getFriends,
  getFriendSuggestions,
  searchUsers,
  getPendingRequests,
  sendFriendRequest,
  getOrCreateDirectConversation,
  type ChatUser,
} from '../chatService';

interface FriendRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartChat: (conversationId: string) => void;
}

type Tab = 'friends' | 'find' | 'received' | 'sent';

function UserAvatar({ user, size = 'md' }: { user: ChatUser; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-9 h-9' : 'w-10 h-10';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center font-bold text-white ${textSize} flex-shrink-0 overflow-hidden`}
      style={{ backgroundColor: user.color || '#6b7280' }}
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
      ) : (
        (user.name || user.email || '?').charAt(0).toUpperCase()
      )}
    </div>
  );
}

export default function FriendRequestModal({ isOpen, onClose, onStartChat }: FriendRequestModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('find');
  const [search, setSearch] = useState('');
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab('friends');
      setSearch('');
      setDebouncedSearch('');
      setLoadingIds(new Set());
    }
  }, [isOpen]);

  const { data: friends = [] } = useQuery({
    queryKey: ['chat', 'friends'],
    queryFn: getFriends,
    enabled: isOpen,
  });

  const { data: suggestions = [] } = useQuery({
    queryKey: ['chat', 'friendSuggestions'],
    queryFn: getFriendSuggestions,
    enabled: isOpen && activeTab === 'find',
  });

  const { data: searchResults } = useQuery({
    queryKey: ['friends', 'search', debouncedSearch],
    queryFn: () => searchUsers(debouncedSearch),
    enabled: isOpen && activeTab === 'find' && debouncedSearch.length >= 2,
  });

  const { data: pendingRequests = [] } = useQuery({
    queryKey: ['chat', 'pendingRequests'],
    queryFn: getPendingRequests,
    enabled: isOpen,
  });

  const friendIds = new Set(friends.map(f => f.id));

  // Use search results when searching, suggestions when not
  const displayUsers = debouncedSearch.length >= 2 ? (searchResults || []) : suggestions;

  const withLoading = async (id: string, fn: () => Promise<void>) => {
    setLoadingIds(prev => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setLoadingIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const handleAddFriend = (userId: string) =>
    withLoading(userId, async () => {
      await sendFriendRequest(userId);
      toast.success(t('friends.requestSent'));
      queryClient.invalidateQueries({ queryKey: ['chat', 'sentRequests'] });
      queryClient.invalidateQueries({ queryKey: ['chat', 'friendSuggestions'] });
    });

  const handleStartChat = (userId: string) =>
    withLoading(userId, async () => {
      const conv = await getOrCreateDirectConversation(userId);
      onStartChat(conv.id);
      onClose();
    });

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'friends', label: t('friends.title'), count: friends.length },
    { key: 'find', label: t('friends.findFriends') },
    { key: 'received', label: t('friends.received'), count: pendingRequests.length },
    { key: 'sent', label: t('friends.sent') },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('friends.title')} size="lg" noPadding>
      {/* Tabs */}
      <div className="flex border-b border-neutral-200/60 dark:border-neutral-700/40 px-4">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`relative px-4 py-3 text-sm font-medium transition-colors min-h-[44px]
              ${activeTab === tab.key
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
              }`}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className="min-w-[20px] h-5 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[11px] font-bold px-1.5">
                  {tab.count}
                </span>
              )}
            </span>
            {activeTab === tab.key && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 dark:bg-emerald-400 rounded-t" />
            )}
          </button>
        ))}
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        {/* Friends list tab */}
        {activeTab === 'friends' && (
          <div className="px-2 py-3">
            {friends.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-neutral-400 dark:text-neutral-500">
                <Users size={36} strokeWidth={1.5} />
                <p className="text-sm mt-2">{t('friends.noFriends')}</p>
              </div>
            ) : (
              friends.map(friend => {
                const isLoading = loadingIds.has(friend.id);
                return (
                  <div
                    key={friend.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                  >
                    <UserAvatar user={friend} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                        {friend.name || friend.email}
                      </p>
                      {friend.name && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{friend.email}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleStartChat(friend.id)}
                      isLoading={isLoading}
                    >
                      <MessageCircle size={14} className="mr-1.5" />
                      {t('chat.startChat')}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Find Friends tab */}
        {activeTab === 'find' && (
          <div>
            {/* Search */}
            <div className="px-4 py-3">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('friends.searchPlaceholder')}
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-sm text-neutral-900 dark:text-white placeholder:text-neutral-400 border-0 focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>
            </div>

            {/* Results */}
            <div className="px-2 pb-4">
              {displayUsers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-neutral-400 dark:text-neutral-500">
                  <Users size={36} strokeWidth={1.5} />
                  <p className="text-sm mt-2">{t('friends.noSuggestions')}</p>
                </div>
              ) : (
                displayUsers.map(user => {
                  const isFriend = friendIds.has(user.id);
                  const isLoading = loadingIds.has(user.id);
                  return (
                    <div
                      key={user.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                    >
                      <UserAvatar user={user} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                          {user.name || user.email}
                        </p>
                        {user.name && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{user.email}</p>
                        )}
                      </div>
                      {isFriend ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleStartChat(user.id)}
                          isLoading={isLoading}
                        >
                          <MessageCircle size={14} className="mr-1.5" />
                          {t('chat.startChat')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => handleAddFriend(user.id)}
                          isLoading={isLoading}
                        >
                          <UserPlus size={14} className="mr-1.5" />
                          {t('friends.addFriend')}
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Received tab — summary + link to Sharing Center */}
        {activeTab === 'received' && (
          <div className="px-4 py-6">
            <div className="flex flex-col items-center justify-center py-6 text-neutral-500 dark:text-neutral-400">
              <Users size={36} strokeWidth={1.5} className="mb-3 opacity-50" />
              <p className="text-sm mb-1">
                {pendingRequests.length > 0
                  ? t('friends.pendingCount', { count: pendingRequests.length })
                  : t('friends.noPendingRequests')}
              </p>
              <button
                onClick={() => { onClose(); navigate('/shared?tab=friends'); }}
                className="mt-3 flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-colors min-h-[44px]"
              >
                <ExternalLink size={14} />
                {t('friends.viewInSharingCenter')}
              </button>
            </div>
          </div>
        )}

        {/* Sent tab — link to Sharing Center */}
        {activeTab === 'sent' && (
          <div className="px-4 py-6">
            <div className="flex flex-col items-center justify-center py-6 text-neutral-500 dark:text-neutral-400">
              <Users size={36} strokeWidth={1.5} className="mb-3 opacity-50" />
              <p className="text-sm mb-1">{t('friends.sentRequestsInfo')}</p>
              <button
                onClick={() => { onClose(); navigate('/shared?tab=friends'); }}
                className="mt-3 flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-colors min-h-[44px]"
              >
                <ExternalLink size={14} />
                {t('friends.viewInSharingCenter')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
