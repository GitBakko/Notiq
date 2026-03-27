import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Users, ArrowLeft } from 'lucide-react';
import Modal from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { getFriends, createGroupConversation, type ChatUser } from '../chatService';

interface GroupChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}

function UserAvatar({ user }: { user: ChatUser }) {
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-white text-xs flex-shrink-0 overflow-hidden"
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

export default function GroupChatModal({ isOpen, onClose, onCreated }: GroupChatModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2>(1);
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isCreating, setIsCreating] = useState(false);

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setGroupName('');
      setSelectedIds(new Set());
      setIsCreating(false);
    }
  }, [isOpen]);

  const { data: friends = [] } = useQuery({
    queryKey: ['chat', 'friends'],
    queryFn: getFriends,
    enabled: isOpen && step === 2,
  });

  const toggleUser = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (selectedIds.size === 0) return;
    setIsCreating(true);
    try {
      const conv = await createGroupConversation(groupName.trim(), Array.from(selectedIds));
      toast.success(t('chat.groupCreated'));
      onCreated(conv.id);
      onClose();
    } catch {
      toast.error(t('common.error'));
    } finally {
      setIsCreating(false);
    }
  };

  const title = step === 1 ? t('chat.newGroup') : t('chat.selectParticipants');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md" noPadding>
      {/* Step 1: Group name */}
      {step === 1 && (
        <div className="p-6">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
            {t('chat.groupName')}
          </label>
          <input
            type="text"
            value={groupName}
            onChange={e => setGroupName(e.target.value)}
            maxLength={100}
            placeholder={t('chat.groupName')}
            className="w-full px-3 py-2.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-sm text-neutral-900 dark:text-white placeholder:text-neutral-400 border-0 focus:ring-2 focus:ring-emerald-500/40"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && groupName.trim()) setStep(2);
            }}
          />
          <div className="flex justify-end mt-6">
            <Button
              onClick={() => setStep(2)}
              disabled={!groupName.trim()}
            >
              {t('chat.next')}
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Select participants */}
      {step === 2 && (
        <div>
          {/* Back + selected count */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200/60 dark:border-neutral-700/40">
            <button
              onClick={() => setStep(1)}
              className="flex items-center gap-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 min-h-[44px] min-w-[44px] transition-colors"
              aria-label={t('common.back')}
            >
              <ArrowLeft size={16} />
              {groupName}
            </button>
            {selectedIds.size > 0 && (
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-2.5 py-1 rounded-full">
                {t('chat.selected', { count: selectedIds.size })}
              </span>
            )}
          </div>

          {/* Friend list */}
          <div className="max-h-[50vh] overflow-y-auto px-2 py-2">
            {friends.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-neutral-400 dark:text-neutral-500">
                <Users size={36} strokeWidth={1.5} />
                <p className="text-sm mt-2">{t('friends.noSuggestions')}</p>
              </div>
            ) : (
              friends.map(friend => {
                const isSelected = selectedIds.has(friend.id);
                return (
                  <button
                    key={friend.id}
                    onClick={() => toggleUser(friend.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors min-h-[44px]
                      ${isSelected
                        ? 'bg-emerald-50 dark:bg-emerald-900/20'
                        : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                      }`}
                  >
                    {/* Checkbox */}
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors
                      ${isSelected
                        ? 'bg-emerald-500 border-emerald-500 dark:bg-emerald-500 dark:border-emerald-500'
                        : 'border-neutral-300 dark:border-neutral-600'
                      }`}
                    >
                      {isSelected && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <UserAvatar user={friend} />
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                        {friend.name || friend.email}
                      </p>
                      {friend.name && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{friend.email}</p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Create button */}
          <div className="px-4 py-3 border-t border-neutral-200/60 dark:border-neutral-700/40">
            <Button
              className="w-full"
              onClick={handleCreate}
              disabled={selectedIds.size === 0}
              isLoading={isCreating}
            >
              {t('chat.createGroup')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
