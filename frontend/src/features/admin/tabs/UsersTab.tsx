import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Search, Check, Trash2, FlaskConical } from 'lucide-react';
import { format } from 'date-fns';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import LoadingOverlay from '../../../components/ui/LoadingOverlay';
import type { UserData } from '../types';

export default function UsersTab() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserData[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [userTotalPages, setUserTotalPages] = useState(1);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get(`/admin/users?page=${userPage}&limit=10&search=${userSearch}`);
      setUsers(res.data.users);
      setUserTotalPages(res.data.pages);
    } catch (e) { console.error(e); }
  }, [userPage, userSearch]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    const timer = setTimeout(() => { setUserPage(1); fetchUsers(); }, 500);
    return () => clearTimeout(timer);
  }, [userSearch]);

  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  const updateUserRole = async (userId: string, action: string) => {
    try {
      const payload = action === 'VERIFY' ? { isVerified: true } : { role: action };
      await api.put(`/admin/users/${userId}`, payload);
      toast.success(t('admin.users.updated', 'User updated'));
      fetchUsers();
    } catch { toast.error(t('admin.updateFailed')); }
  };

  const handleDeleteUser = async () => {
    if (!deleteUserId) return;
    setIsDeleting(true);
    try {
      await api.delete(`/admin/users/${deleteUserId}`);
      toast.success(t('admin.users.deleted', 'User deleted'));
      setDeleteUserId(null);
      fetchUsers();
    } catch { toast.error(t('admin.updateFailed')); }
    setIsDeleting(false);
  };

  const handleCleanupTestUsers = async () => {
    setIsCleaningUp(true);
    try {
      const res = await api.delete('/admin/users/cleanup/test-users');
      const { deleted } = res.data;
      toast.success(t('admin.users.cleanupDone', { count: deleted, defaultValue: `Deleted ${deleted} test users` }));
      setShowCleanupConfirm(false);
      fetchUsers();
    } catch { toast.error(t('admin.updateFailed')); }
    setIsCleaningUp(false);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
          <input
            type="text"
            placeholder={t('admin.users.searchPlaceholder')}
            className="pl-10 pr-4 py-2 w-full border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
          />
        </div>
        <Button size="sm" variant="secondary" className="text-amber-600 gap-2" onClick={() => setShowCleanupConfirm(true)}>
          <FlaskConical size={14} />
          {t('admin.users.cleanupTestUsers', 'Cleanup test users')}
        </Button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden dark:bg-neutral-800 dark:border-neutral-700/40">
        <table className="w-full text-sm text-left">
          <thead className="bg-neutral-50 text-neutral-500 uppercase font-medium dark:bg-neutral-900/50">
            <tr>
              <th className="px-6 py-3">{t('admin.users.user')}</th>
              <th className="px-6 py-3">{t('admin.users.role')}</th>
              <th className="px-6 py-3">{t('admin.users.stats')}</th>
              <th className="px-6 py-3">{t('admin.users.joined')}</th>
              <th className="px-6 py-3 text-right">{t('admin.users.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-700">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                <td className="px-6 py-4">
                  <div className="font-medium text-neutral-900 dark:text-white">{user.name || t('admin.users.anonymous')}</div>
                  <div className="text-neutral-500">{user.email}</div>
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${user.role === 'SUPERADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300'}`}>
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-neutral-500">
                  {t('admin.users.notesCount', { count: user._count?.notes || 0 })}
                </td>
                <td className="px-6 py-4 text-neutral-500">
                  {format(new Date(user.createdAt), 'MMM d, yyyy')}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    {!user.isVerified && (
                      <Button size="sm" variant="secondary" className="text-blue-600" title={t('admin.users.manualVerification')} onClick={() => updateUserRole(user.id, 'VERIFY')}>
                        <Check size={16} />
                      </Button>
                    )}
                    {user.role === 'USER' ? (
                      <Button size="sm" variant="secondary" className="text-emerald-600" onClick={() => updateUserRole(user.id, 'SUPERADMIN')}>
                        {t('admin.users.promote')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" className="text-red-500" onClick={() => updateUserRole(user.id, 'USER')}>
                        {t('admin.users.demote')}
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" className="text-red-500" onClick={() => setDeleteUserId(user.id)} title={t('admin.users.delete', 'Delete')}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {userTotalPages > 1 && (
        <div className="flex items-center justify-between p-4 bg-white rounded-xl border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <Button variant="secondary" size="sm" onClick={() => setUserPage(p => Math.max(1, p - 1))} disabled={userPage === 1}>
            {t('admin.users.previous')}
          </Button>
          <span className="text-sm text-neutral-500">
            {t('admin.users.pageOf', { page: userPage, total: userTotalPages })}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setUserPage(p => Math.min(userTotalPages, p + 1))} disabled={userPage === userTotalPages}>
            {t('admin.users.next')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleteUserId}
        onClose={() => setDeleteUserId(null)}
        onConfirm={handleDeleteUser}
        title={t('admin.users.deleteTitle', 'Delete User')}
        message={t('admin.users.deleteMessage', 'This will permanently delete this user and all their data. This action cannot be undone.')}
        confirmText={t('common.delete', 'Delete')}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={showCleanupConfirm}
        onClose={() => setShowCleanupConfirm(false)}
        onConfirm={handleCleanupTestUsers}
        title={t('admin.users.cleanupTitle', 'Cleanup Test Users')}
        message={t('admin.users.cleanupMessage', 'This will permanently delete all users with @example.com email addresses and all their data. This action cannot be undone.')}
        confirmText={isCleaningUp ? t('common.loading', 'Loading...') : t('common.delete', 'Delete')}
        variant="danger"
      />

      <LoadingOverlay isVisible={isDeleting || isCleaningUp} message={isCleaningUp ? t('admin.users.cleaningUp', 'Deleting test users...') : t('admin.users.deletingUser', 'Deleting user...')} />
    </div>
  );
}
