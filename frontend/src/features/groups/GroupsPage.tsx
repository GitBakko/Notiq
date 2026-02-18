import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronDown, ChevronRight, UserMinus, Trash2, Clock, Menu, Edit3, X, Orbit } from 'lucide-react';
import { getMyGroups, createGroup, updateGroup, deleteGroup, addGroupMember, removeGroupMember, removePendingInvite } from './groupService';
import type { Group } from './groupService';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import toast from 'react-hot-toast';

export default function GroupsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [addEmailMap, setAddEmailMap] = useState<Record<string, string>>({});
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['groups'],
    queryFn: getMyGroups,
  });

  const createMutation = useMutation({
    mutationFn: (d: { name: string; description?: string }) => createGroup(d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.created'));
      setIsCreating(false);
      setNewGroupName('');
      setNewGroupDescription('');
    },
    onError: () => toast.error(t('groups.createFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.deleted'));
      setExpandedGroupId(null);
    },
    onError: () => toast.error(t('groups.deleteFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data: d }: { id: string; data: { name?: string } }) => updateGroup(id, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.updated'));
      setEditingGroupId(null);
    },
    onError: () => toast.error(t('groups.updateFailed')),
  });

  const addMemberMutation = useMutation({
    mutationFn: ({ groupId, email }: { groupId: string; email: string }) => addGroupMember(groupId, email),
    onSuccess: (result, { groupId }) => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      if (result.type === 'pending') {
        toast.success(t('groups.memberAddedPending'));
      } else {
        toast.success(t('groups.memberAdded'));
      }
      setAddEmailMap((prev) => ({ ...prev, [groupId]: '' }));
    },
    onError: (error: any) => {
      const msg = error.response?.data?.message || '';
      if (msg === 'User is already a member') {
        toast.error(t('groups.alreadyMember'));
      } else if (msg === 'Cannot add yourself to a group') {
        toast.error(t('groups.cannotAddSelf'));
      } else {
        toast.error(t('groups.memberAddFailed'));
      }
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) => removeGroupMember(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.memberRemoved'));
    },
    onError: () => toast.error(t('groups.memberRemoveFailed')),
  });

  const removePendingMutation = useMutation({
    mutationFn: ({ groupId, email }: { groupId: string; email: string }) => removePendingInvite(groupId, email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.inviteCancelled'));
    },
    onError: () => toast.error(t('groups.inviteCancelFailed')),
  });

  const handleCreate = () => {
    if (!newGroupName.trim()) return;
    createMutation.mutate({ name: newGroupName.trim(), description: newGroupDescription.trim() || undefined });
  };

  const handleAddMember = (groupId: string) => {
    const email = addEmailMap[groupId]?.trim();
    if (!email) return;
    addMemberMutation.mutate({ groupId, email });
  };

  const renderOwnedGroup = (group: Group) => {
    const isExpanded = expandedGroupId === group.id;
    const isEditing = editingGroupId === group.id;
    const emailValue = addEmailMap[group.id] || '';

    return (
      <div key={group.id} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        {/* Header */}
        <div
          className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750 rounded-t-lg"
          onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}
        >
          <div className="flex items-center gap-3 min-w-0">
            {isExpanded ? <ChevronDown size={18} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={18} className="text-gray-400 flex-shrink-0" />}
            <div className="min-w-0">
              {isEditing ? (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="text-sm font-medium px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editName.trim()) {
                        updateMutation.mutate({ id: group.id, data: { name: editName.trim() } });
                      }
                      if (e.key === 'Escape') setEditingGroupId(null);
                    }}
                    autoFocus
                  />
                  <button onClick={() => setEditingGroupId(null)} className="text-gray-400 hover:text-gray-600">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">{group.name}</h3>
              )}
              {group.description && !isEditing && (
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{group.description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
              {t('groups.memberCount', { count: group.members.length })}
            </span>
          </div>
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-4">
            {/* Actions row */}
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={(e) => { e.stopPropagation(); setEditingGroupId(group.id); setEditName(group.name); }}
                className="text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1"
              >
                <Edit3 size={12} /> {t('common.rename')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(t('groups.deleteConfirm'))) {
                    deleteMutation.mutate(group.id);
                  }
                }}
                className="text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
              >
                <Trash2 size={12} /> {t('common.delete')}
              </button>
            </div>

            {/* Add member form */}
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1 block">{t('groups.addMember')}</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={emailValue}
                  onChange={(e) => setAddEmailMap((prev) => ({ ...prev, [group.id]: e.target.value }))}
                  placeholder={t('groups.addMemberPlaceholder')}
                  className="flex-1 text-sm px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddMember(group.id); }}
                />
                <button
                  onClick={() => handleAddMember(group.id)}
                  disabled={!emailValue.trim() || addMemberMutation.isPending}
                  className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            {/* Members list */}
            <div>
              <h4 className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">{t('groups.members')}</h4>
              {group.members.length === 0 ? (
                <p className="text-xs text-gray-400 italic">{t('groups.noMembers')}</p>
              ) : (
                <div className="space-y-1">
                  {group.members.map((member) => (
                    <div key={member.userId} className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-750 rounded-lg">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center text-xs font-medium flex-shrink-0">
                          {(member.user.name || member.user.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 dark:text-white truncate">{member.user.name || member.user.email}</p>
                          {member.user.name && <p className="text-xs text-gray-500 truncate">{member.user.email}</p>}
                        </div>
                      </div>
                      <button
                        onClick={() => removeMemberMutation.mutate({ groupId: group.id, userId: member.userId })}
                        className="p-1 text-gray-400 hover:text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/30 flex-shrink-0"
                        title={t('groups.memberRemoved')}
                      >
                        <UserMinus size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pending invites */}
            {group.pendingInvites && group.pendingInvites.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-2">{t('groups.pendingInvites')}</h4>
                <div className="space-y-1">
                  {group.pendingInvites.map((invite) => (
                    <div key={invite.id} className="flex items-center justify-between px-3 py-2 bg-yellow-50 dark:bg-yellow-900/10 rounded-lg border border-yellow-200 dark:border-yellow-800/30">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-yellow-600 dark:text-yellow-400" />
                        <span className="text-sm text-gray-700 dark:text-gray-300">{invite.email}</span>
                      </div>
                      <button
                        onClick={() => removePendingMutation.mutate({ groupId: group.id, email: invite.email })}
                        className="p-1 text-gray-400 hover:text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/30"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderMemberOfGroup = (group: Group) => (
    <div key={group.id} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">{group.name}</h3>
          {group.owner && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('groups.owner')}: {group.owner.name || group.owner.email}
            </p>
          )}
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full flex-shrink-0">
          {t('groups.memberCount', { count: group.members.length })}
        </span>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="p-1 text-gray-500 hover:text-gray-700">
              <Menu size={20} />
            </button>
          )}
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{t('groups.title')}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('groups.subtitle')}</p>
          </div>
        </div>
        {!isCreating && (
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition-colors"
          >
            <Plus size={16} />
            {t('groups.create')}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Create form */}
        {isCreating && (
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-emerald-200 dark:border-emerald-800 p-4 space-y-3">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder={t('groups.namePlaceholder')}
              className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setIsCreating(false); }}
            />
            <input
              type="text"
              value={newGroupDescription}
              onChange={(e) => setNewGroupDescription(e.target.value)}
              placeholder={t('groups.descriptionPlaceholder')}
              className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsCreating(false)} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreate}
                disabled={!newGroupName.trim() || createMutation.isPending}
                className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50"
              >
                {t('common.create')}
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
          </div>
        ) : (
          <>
            {/* My Groups (owned) */}
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <Orbit size={16} />
                {t('groups.ownedGroups')}
              </h2>
              {data?.owned && data.owned.length > 0 ? (
                <div className="space-y-2">
                  {data.owned.map(renderOwnedGroup)}
                </div>
              ) : (
                <p className="text-sm text-gray-400 dark:text-gray-500 italic py-4">{t('groups.empty')}</p>
              )}
            </div>

            {/* Groups I belong to */}
            {data?.memberOf && data.memberOf.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                  <Orbit size={16} />
                  {t('groups.memberOfGroups')}
                </h2>
                <div className="space-y-2">
                  {data.memberOf.map(renderMemberOfGroup)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
