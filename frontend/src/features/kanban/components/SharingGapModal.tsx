import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, UserPlus } from 'lucide-react';
import Modal from '../../../components/ui/Modal';
import type { NoteSharingCheck } from '../types';

interface SharingGapModalProps {
  isOpen: boolean;
  onClose: () => void;
  sharingCheck: NoteSharingCheck;
  onConfirm: (selectedUserIds: string[]) => void;
  isPending?: boolean;
}

export default function SharingGapModal({
  isOpen,
  onClose,
  sharingCheck,
  onConfirm,
  isPending,
}: SharingGapModalProps) {
  const { t } = useTranslation();
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    () => new Set(sharingCheck.usersWithoutAccess.map((u) => u.id)),
  );

  function toggleUser(userId: string): void {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function handleConfirm(): void {
    onConfirm(Array.from(selectedUserIds));
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('kanban.noteLink.sharingGapTitle')}
      size="md"
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('kanban.noteLink.sharingGapDescription', { noteTitle: sharingCheck.noteTitle })}
        </p>

        {/* Users who already have access */}
        {sharingCheck.usersWithAccess.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              {t('kanban.noteLink.usersWithAccess')}
            </h4>
            <div className="space-y-1">
              {sharingCheck.usersWithAccess.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-sm"
                >
                  <Check size={14} className="text-emerald-500" />
                  <span className="text-gray-700 dark:text-gray-300">
                    {user.name || user.email}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Users without access (selectable) */}
        {sharingCheck.usersWithoutAccess.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              {t('kanban.noteLink.usersWithoutAccess')}
            </h4>
            <div className="space-y-1">
              {sharingCheck.usersWithoutAccess.map((user) => (
                <button
                  key={user.id}
                  onClick={() => toggleUser(user.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      selectedUserIds.has(user.id)
                        ? 'bg-emerald-500 border-emerald-500'
                        : 'border-gray-300 dark:border-gray-600'
                    }`}
                  >
                    {selectedUserIds.has(user.id) && (
                      <Check size={10} className="text-white" />
                    )}
                  </div>
                  <UserPlus size={14} className="text-gray-400" />
                  <span className="text-gray-700 dark:text-gray-300">
                    {user.name || user.email}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? t('common.loading') : t('kanban.noteLink.confirmLink')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
