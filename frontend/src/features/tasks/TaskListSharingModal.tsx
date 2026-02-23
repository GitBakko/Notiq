import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, UserPlus, Trash2, Orbit } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { shareTaskList, revokeTaskListShare } from './taskListService';
import { getGroupsForSharing, shareTaskListWithGroup } from '../../features/groups/groupService';
import toast from 'react-hot-toast';

interface SharedUser {
  id: string;
  name: string | null;
  email: string;
  permission: 'READ' | 'WRITE';
}

interface TaskListSharingModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskListId: string;
  sharedWith?: SharedUser[];
}

export default function TaskListSharingModal({ isOpen, onClose, taskListId, sharedWith = [] }: TaskListSharingModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<'READ' | 'WRITE'>('READ');
  const [isLoading, setIsLoading] = useState(false);
  const [localSharedWith, setLocalSharedWith] = useState<SharedUser[]>(sharedWith);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupPermission, setGroupPermission] = useState<'READ' | 'WRITE'>('READ');
  const [isGroupSharing, setIsGroupSharing] = useState(false);

  // Keep localSharedWith in sync when the prop updates
  const sharedWithJson = JSON.stringify(sharedWith);
  useEffect(() => {
    setLocalSharedWith(sharedWith);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedWithJson]);

  const { data: groups } = useQuery({
    queryKey: ['groups-for-sharing'],
    queryFn: getGroupsForSharing,
    staleTime: 5 * 60 * 1000,
    enabled: isOpen,
  });

  if (!isOpen) return null;

  const handleShare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setIsLoading(true);
    try {
      await shareTaskList(taskListId, email, permission);
      toast.success(t('sharing.inviteSuccess'));
      setEmail('');
      queryClient.invalidateQueries({ queryKey: ['taskList', taskListId] });
    } catch (error: any) {
      console.error('Share failed', error);
      if (error.response?.status === 404) {
        toast.error(t('sharing.userNotFound'));
      } else {
        toast.error(t('sharing.failed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    try {
      await revokeTaskListShare(taskListId, userId);
      setLocalSharedWith(prev => prev.filter(u => u.id !== userId));
      toast.success(t('sharing.revoked'));
      queryClient.invalidateQueries({ queryKey: ['taskList', taskListId] });
    } catch (error) {
      console.error('Revoke failed', error);
      toast.error(t('sharing.revokeFailed'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900 dark:border dark:border-gray-800" onClick={e => e.stopPropagation()}>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">{t('sharing.titleTaskList')}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>

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
                <option value="READ">{t('sharing.read')}</option>
                <option value="WRITE">{t('sharing.write')}</option>
              </select>
              <Button
                type="button"
                disabled={!selectedGroupId || isGroupSharing}
                onClick={async () => {
                  if (!selectedGroupId) return;
                  setIsGroupSharing(true);
                  try {
                    const result = await shareTaskListWithGroup(taskListId, selectedGroupId, groupPermission);
                    toast.success(t('sharing.shareGroupSuccess', { count: result.shared }));
                    setSelectedGroupId('');
                    queryClient.invalidateQueries({ queryKey: ['taskList', taskListId] });
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

        <form onSubmit={handleShare} className="mb-6">
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('sharing.emailPlaceholder')}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
              required
            />
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value as 'READ' | 'WRITE')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
            >
              <option value="READ">{t('sharing.read')}</option>
              <option value="WRITE">{t('sharing.write')}</option>
            </select>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? '...' : <UserPlus size={18} />}
            </Button>
          </div>
        </form>

        <div className="space-y-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('sharing.sharedWith')}</h3>
          {localSharedWith.length === 0 ? (
            <p className="text-sm text-gray-500 italic">{t('sharing.noOne')}</p>
          ) : (
            <ul className="space-y-2">
              {localSharedWith.map(user => (
                <li key={user.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-2 dark:bg-gray-800">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      {user.name?.[0] || user.email[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900 dark:text-white">{user.name || user.email}</div>
                      <div className="text-xs text-gray-500">{user.permission}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(user.id)}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                    title={t('sharing.revoke')}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
