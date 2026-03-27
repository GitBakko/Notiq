import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Menu, UserPlus, Users } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ChatProvider } from './ChatContext';
import ConversationView from './components/ConversationView';
import ConversationList from './components/ConversationList';
import FriendRequestModal from './components/FriendRequestModal';
import GroupChatModal from './components/GroupChatModal';

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-400 dark:text-neutral-500">
      <MessageCircle size={48} strokeWidth={1.5} />
      <p className="text-sm">{t('chat.selectConversation')}</p>
    </div>
  );
}

export default function ChatPage() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [showFriendModal, setShowFriendModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);

  const handleStartChat = (conversationId: string) => {
    setSelectedConversationId(conversationId);
  };

  if (isMobile) {
    return (
      <ChatProvider>
      <div className="flex flex-col h-full bg-white dark:bg-neutral-950">
        {/* Mobile header — only show when viewing conversation list */}
        {!selectedConversationId && (
          <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-200/60 dark:border-neutral-800/40">
            <button
              onClick={toggleSidebar}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center -ml-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700"
              aria-label={t('common.menu', 'Menu')}
            >
              <Menu size={20} />
            </button>
            <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex-1">
              {t('chat.title')}
            </h1>
            <button
              onClick={() => setShowGroupModal(true)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700"
              aria-label={t('chat.newGroup')}
            >
              <Users size={20} />
            </button>
            <button
              onClick={() => setShowFriendModal(true)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center -mr-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700"
              aria-label={t('friends.findFriends')}
            >
              <UserPlus size={20} />
            </button>
          </div>
        )}

        {/* Mobile: show list or conversation */}
        {selectedConversationId ? (
          <ConversationView
            conversationId={selectedConversationId}
            onBack={() => setSelectedConversationId(null)}
          />
        ) : (
          <ConversationList
            selectedId={null}
            onSelect={setSelectedConversationId}
            onNewChat={() => setShowFriendModal(true)}
            onNewGroup={() => setShowGroupModal(true)}
          />
        )}

        <FriendRequestModal
          isOpen={showFriendModal}
          onClose={() => setShowFriendModal(false)}
          onStartChat={handleStartChat}
        />
        <GroupChatModal
          isOpen={showGroupModal}
          onClose={() => setShowGroupModal(false)}
          onCreated={handleStartChat}
        />
      </div>
      </ChatProvider>
    );
  }

  // Desktop layout
  return (
    <ChatProvider>
    <div className="flex h-full">
      {/* Left: Conversation list */}
      <div className="w-80 border-r border-neutral-200/60 dark:border-neutral-800/40 flex flex-col bg-white dark:bg-neutral-950">
        <ConversationList
          selectedId={selectedConversationId}
          onSelect={setSelectedConversationId}
          onNewChat={() => setShowFriendModal(true)}
        />
      </div>
      {/* Right: Conversation view or empty state */}
      <div className="flex-1 flex flex-col bg-neutral-50 dark:bg-neutral-900">
        {selectedConversationId ? (
          <ConversationView
            conversationId={selectedConversationId}
            onBack={() => setSelectedConversationId(null)}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      <FriendRequestModal
        isOpen={showFriendModal}
        onClose={() => setShowFriendModal(false)}
        onStartChat={handleStartChat}
      />
      <GroupChatModal
        isOpen={showGroupModal}
        onClose={() => setShowGroupModal(false)}
        onCreated={handleStartChat}
      />
    </div>
    </ChatProvider>
  );
}
