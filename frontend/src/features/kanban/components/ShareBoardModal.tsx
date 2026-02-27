import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus, Orbit } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import Modal from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { shareBoard, revokeShare } from '../kanbanService';
import { getGroupsForSharing, shareKanbanBoardWithGroup } from '../../groups/groupService';
import type { SharedKanbanBoard } from '../types';

interface ShareBoardModalProps {
  isOpen: boolean;
  onClose: () => void;
  boardId: string;
  boardTitle: string;
  sharedWith?: SharedKanbanBoard[];
}

export default function ShareBoardModal({
  isOpen,
  onClose,
  boardId,
  boardTitle,
  sharedWith = [],
}: ShareBoardModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<'READ' | 'WRITE'>('READ');
  const [isLoading, setIsLoading] = useState(false);
  const [localSharedWith, setLocalSharedWith] = useState<SharedKanbanBoard[]>(sharedWith);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupPermission, setGroupPermission] = useState<'READ' | 'WRITE'>('READ');
  const [isGroupSharing, setIsGroupSharing] = useState(false);

  const { data: groups } = useQuery({
    queryKey: ['groups-for-sharing'],
    queryFn: getGroupsForSharing,
    staleTime: 5 * 60 * 1000,
    enabled: isOpen,
  });

  // Keep localSharedWith in sync when the prop updates (e.g. after query refetch)
  const sharedWithJson = JSON.stringify(sharedWith);
  useEffect(() => {
    setLocalSharedWith(sharedWith);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedWithJson]);

  async function handleShare(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim()) return;

    setIsLoading(true);
    try {
      const newShare = await shareBoard(boardId, email.trim(), permission);
      setLocalSharedWith((prev) => [...prev, newShare]);
      setEmail('');
      toast.success(t('kanban.share.shareSuccess'));
      queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
    } catch (error: unknown) {
      const axiosErr = error as { response?: { status?: number } };
      if (axiosErr.response?.status === 404) {
        toast.error(t('kanban.share.userNotFound'));
      } else {
        toast.error(t('kanban.share.shareFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRevoke(userId: string): Promise<void> {
    try {
      await revokeShare(boardId, userId);
      setLocalSharedWith((prev) => prev.filter((s) => s.userId !== userId));
      toast.success(t('kanban.share.revoked'));
      queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
    } catch {
      toast.error(t('kanban.share.revokeFailed'));
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kanban.share.title')}>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400 truncate">
        {boardTitle}
      </p>

      {/* Share with Group section */}
      {groups && groups.length > 0 && (
        <div className="mb-4 pb-4 border-b border-gray-200 dark:border-gray-700">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2 flex items-center gap-1.5">
            <Orbit size={14} />
            {t('sharing.shareWithGroup')}
          </label>
          <div className="flex gap-2">
            <select
              value={selectedGroupId}
              onChange={(e) => setSelectedGroupId(e.target.value)}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
            >
              <option value="">{t('sharing.selectGroup')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g._count?.members || g.members.length})
                </option>
              ))}
            </select>
            <select
              value={groupPermission}
              onChange={(e) => setGroupPermission(e.target.value as 'READ' | 'WRITE')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
            >
              <option value="READ">{t('kanban.share.permissions.READ')}</option>
              <option value="WRITE">{t('kanban.share.permissions.WRITE')}</option>
            </select>
            <Button
              type="button"
              disabled={!selectedGroupId || isGroupSharing}
              onClick={async () => {
                if (!selectedGroupId) return;
                setIsGroupSharing(true);
                try {
                  const result = await shareKanbanBoardWithGroup(boardId, selectedGroupId, groupPermission);
                  toast.success(t('sharing.shareGroupSuccess', { count: result.shared }));
                  setSelectedGroupId('');
                  queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
                } catch {
                  toast.error(t('sharing.shareGroupFailed'));
                } finally {
                  setIsGroupSharing(false);
                }
              }}
            >
              {isGroupSharing ? '...' : <Orbit size={18} />}
            </Button>
          </div>
        </div>
      )}

      {/* Share form */}
      <form onSubmit={handleShare} className="mb-6">
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('kanban.share.emailPlaceholder')}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
            required
          />
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as 'READ' | 'WRITE')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
          >
            <option value="READ">{t('kanban.share.permissions.READ')}</option>
            <option value="WRITE">{t('kanban.share.permissions.WRITE')}</option>
          </select>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? '...' : <UserPlus size={18} />}
          </Button>
        </div>
      </form>

      {/* Shared users list */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('kanban.share.sharedWith')}
        </h3>

        {localSharedWith.length === 0 ? (
          <p className="text-sm text-gray-500 italic">{t('kanban.share.noOne')}</p>
        ) : (
          <ul className="space-y-2">
            {localSharedWith.map((share) => (
              <li
                key={share.id}
                className="flex items-center justify-between rounded-lg bg-gray-50 p-2 dark:bg-gray-700"
              >
                <div className="flex items-center gap-3">
                  {share.user.avatarUrl ? (
                    <img src={share.user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')} alt="" className="h-8 w-8 rounded-full object-cover flex-shrink-0" loading="lazy" decoding="async" />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      {(share.user.name || share.user.email).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {share.user.name || share.user.email}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t(`kanban.share.permissions.${share.permission}`)}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(share.userId)}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                  title={t('common.delete')}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
