import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Menu, Search } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import ConversationView from './components/ConversationView';

import ConversationList from './components/ConversationList';

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

  if (isMobile) {
    return (
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
              className="min-h-[44px] min-w-[44px] flex items-center justify-center -mr-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700"
              aria-label={t('common.search')}
            >
              <Search size={20} />
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
          />
        )}
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="flex h-full">
      {/* Left: Conversation list */}
      <div className="w-80 border-r border-neutral-200/60 dark:border-neutral-800/40 flex flex-col bg-white dark:bg-neutral-950">
        <ConversationList
          selectedId={selectedConversationId}
          onSelect={setSelectedConversationId}
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
    </div>
  );
}
