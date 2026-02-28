import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronDown, ChevronRight, UserMinus, Trash2, Clock, Menu, Edit3, X, Orbit, Camera } from 'lucide-react';
import { getMyGroups, createGroup, updateGroup, deleteGroup, addGroupMember, removeGroupMember, removePendingInvite, uploadGroupAvatar } from './groupService';
import type { Group } from './groupService';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import toast from 'react-hot-toast';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import Skeleton from '../../components/ui/Skeleton';

export default function GroupsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [expandedMemberGroupId, setExpandedMemberGroupId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [addEmailMap, setAddEmailMap] = useState<Record<string, string>>({});
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploadGroupId, setAvatarUploadGroupId] = useState<string | null>(null);
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);
  const createAvatarInputRef = useRef<HTMLInputElement>(null);
  const [newGroupAvatarFile, setNewGroupAvatarFile] = useState<File | null>(null);
  const [newGroupAvatarPreview, setNewGroupAvatarPreview] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['groups'],
    queryFn: getMyGroups,
  });

  const createMutation = useMutation({
    mutationFn: async (d: { name: string; description?: string }) => {
      const group = await createGroup(d);
      if (newGroupAvatarFile) {
        await uploadGroupAvatar(group.id, newGroupAvatarFile);
      }
      return group;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.created'));
      setIsCreating(false);
      setNewGroupName('');
      setNewGroupDescription('');
      setNewGroupAvatarFile(null);
      if (newGroupAvatarPreview) { URL.revokeObjectURL(newGroupAvatarPreview); setNewGroupAvatarPreview(null); }
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
    onError: (error: unknown) => {
      const axiosErr = error as { response?: { data?: { message?: string } } };
      const msg = axiosErr.response?.data?.message || '';
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

  const avatarMutation = useMutation({
    mutationFn: ({ groupId, file }: { groupId: string; file: File }) => uploadGroupAvatar(groupId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      toast.success(t('groups.avatarUpdated'));
    },
    onError: () => toast.error(t('groups.avatarUpdateFailed')),
  });

  const handleAvatarClick = (groupId: string) => {
    setAvatarUploadGroupId(groupId);
    avatarInputRef.current?.click();
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && avatarUploadGroupId) {
      avatarMutation.mutate({ groupId: avatarUploadGroupId, file });
    }
    e.target.value = '';
  };

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
      <div key={group.id} className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40">
        {/* Header */}
        <div
          className="flex items-center justify-between p-4 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/50 rounded-t-lg"
          onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}
        >
          <div className="flex items-center gap-3 min-w-0">
            {isExpanded ? <ChevronDown size={18} className="text-neutral-400 flex-shrink-0" /> : <ChevronRight size={18} className="text-neutral-400 flex-shrink-0" />}
            <div
              className="relative group/avatar flex-shrink-0 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); handleAvatarClick(group.id); }}
            >
              <div className="h-9 w-9 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center overflow-hidden">
                {group.avatarUrl ? (
                  <img src={group.avatarUrl} alt={group.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-sm">
                    {group.name[0]?.toUpperCase()}
                  </span>
                )}
              </div>
              <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover/avatar:opacity-100 flex items-center justify-center transition-opacity">
                <Camera size={14} className="text-white" />
              </div>
            </div>
            <div className="min-w-0">
              {isEditing ? (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="text-sm font-medium px-2 py-1 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editName.trim()) {
                        updateMutation.mutate({ id: group.id, data: { name: editName.trim() } });
                      }
                      if (e.key === 'Escape') setEditingGroupId(null);
                    }}
                    autoFocus
                  />
                  <button onClick={() => setEditingGroupId(null)} className="text-neutral-400 hover:text-neutral-600">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <h3 className="text-sm font-medium text-neutral-900 dark:text-white truncate">{group.name}</h3>
              )}
              {group.description && !isEditing && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{group.description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-700 px-2 py-0.5 rounded-full">
              {t('groups.memberCount', { count: group.members.length })}
            </span>
          </div>
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div className="border-t border-neutral-200/60 dark:border-neutral-700/40 p-4 space-y-4">
            {/* Actions row */}
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={(e) => { e.stopPropagation(); setEditingGroupId(group.id); setEditName(group.name); }}
                className="text-xs text-neutral-500 hover:text-blue-600 flex items-center gap-1"
              >
                <Edit3 size={12} /> {t('common.rename')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteGroupId(group.id);
                }}
                className="text-xs text-neutral-500 hover:text-red-600 flex items-center gap-1"
              >
                <Trash2 size={12} /> {t('common.delete')}
              </button>
            </div>

            {/* Add member form */}
            <div>
              <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1 block">{t('groups.addMember')}</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={emailValue}
                  onChange={(e) => setAddEmailMap((prev) => ({ ...prev, [group.id]: e.target.value }))}
                  placeholder={t('groups.addMemberPlaceholder')}
                  className="flex-1 text-sm px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white placeholder-neutral-400"
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
              <h4 className="text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-2">{t('groups.members')}</h4>
              {group.members.length === 0 ? (
                <p className="text-xs text-neutral-400 italic">{t('groups.noMembers')}</p>
              ) : (
                <div className="space-y-1">
                  {group.members.map((member) => (
                    <div key={member.userId} className="flex items-center justify-between px-3 py-2 bg-neutral-50 dark:bg-neutral-700/50 rounded-lg">
                      <div className="flex items-center gap-2 min-w-0">
                        {member.user.avatarUrl ? (
                          <img
                            src={member.user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                            alt=""
                            className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center text-xs font-medium flex-shrink-0">
                            {(member.user.name || member.user.email).charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-sm text-neutral-900 dark:text-white truncate">{member.user.name || member.user.email}</p>
                          {member.user.name && <p className="text-xs text-neutral-500 truncate">{member.user.email}</p>}
                        </div>
                      </div>
                      <button
                        onClick={() => removeMemberMutation.mutate({ groupId: group.id, userId: member.userId })}
                        className="p-1 text-neutral-400 hover:text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/30 flex-shrink-0"
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
                <h4 className="text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-2">{t('groups.pendingInvites')}</h4>
                <div className="space-y-1">
                  {group.pendingInvites.map((invite) => (
                    <div key={invite.id} className="flex items-center justify-between px-3 py-2 bg-yellow-50 dark:bg-yellow-900/10 rounded-lg border border-yellow-200 dark:border-yellow-800/30">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-yellow-600 dark:text-yellow-400" />
                        <span className="text-sm text-neutral-700 dark:text-neutral-300">{invite.email}</span>
                      </div>
                      <button
                        onClick={() => removePendingMutation.mutate({ groupId: group.id, email: invite.email })}
                        className="p-1 text-neutral-400 hover:text-red-600 rounded-full hover:bg-red-50 dark:hover:bg-red-900/30"
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

  const renderMemberOfGroup = (group: Group) => {
    const isExpanded = expandedMemberGroupId === group.id;

    return (
      <div key={group.id} className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40">
        {/* Header */}
        <div
          className="flex items-center justify-between p-4 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/50 rounded-t-lg"
          onClick={() => setExpandedMemberGroupId(isExpanded ? null : group.id)}
        >
          <div className="flex items-center gap-3 min-w-0">
            {isExpanded ? <ChevronDown size={18} className="text-neutral-400 flex-shrink-0" /> : <ChevronRight size={18} className="text-neutral-400 flex-shrink-0" />}
            <div className="h-9 w-9 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center overflow-hidden flex-shrink-0">
              {group.avatarUrl ? (
                <img src={group.avatarUrl} alt={group.name} className="w-full h-full object-cover" />
              ) : (
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-sm">
                  {group.name[0]?.toUpperCase()}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-neutral-900 dark:text-white truncate">{group.name}</h3>
              {group.owner && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('groups.owner')}: {group.owner.name || group.owner.email}
                </p>
              )}
            </div>
          </div>
          <span className="text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-700 px-2 py-0.5 rounded-full flex-shrink-0">
            {t('groups.memberCount', { count: group.members.length })}
          </span>
        </div>

        {/* Expanded content — read-only member list */}
        {isExpanded && (
          <div className="border-t border-neutral-200/60 dark:border-neutral-700/40 p-4">
            <h4 className="text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-2">{t('groups.members')}</h4>
            {group.members.length === 0 ? (
              <p className="text-xs text-neutral-400 italic">{t('groups.noMembers')}</p>
            ) : (
              <div className="space-y-1">
                {group.members.map((member) => (
                  <div key={member.userId} className="flex items-center px-3 py-2 bg-neutral-50 dark:bg-neutral-700/50 rounded-lg">
                    <div className="flex items-center gap-2 min-w-0">
                      {member.user.avatarUrl ? (
                        <img
                          src={member.user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                          alt=""
                          className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center text-xs font-medium flex-shrink-0">
                          {(member.user.name || member.user.email).charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm text-neutral-900 dark:text-white truncate">{member.user.name || member.user.email}</p>
                        {member.user.name && <p className="text-xs text-neutral-500 truncate">{member.user.email}</p>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-950">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="p-1 text-neutral-500 hover:text-neutral-700">
              <Menu size={20} />
            </button>
          )}
          <div>
            <h1 className="text-lg font-semibold text-neutral-900 dark:text-white">{t('groups.title')}</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('groups.subtitle')}</p>
          </div>
        </div>
        {!isCreating && (
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition-colors"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{t('groups.create')}</span>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Create form */}
        {isCreating && (
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-emerald-200 dark:border-emerald-800 p-4 space-y-3">
            <div className="flex items-start gap-4">
              {/* Avatar picker */}
              <div
                className="relative group/create-avatar flex-shrink-0 cursor-pointer"
                onClick={() => createAvatarInputRef.current?.click()}
              >
                <div className="h-14 w-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center overflow-hidden border-2 border-dashed border-emerald-300 dark:border-emerald-700">
                  {newGroupAvatarPreview ? (
                    <img src={newGroupAvatarPreview} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Camera size={20} className="text-emerald-400 dark:text-emerald-600" />
                  )}
                </div>
                <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover/create-avatar:opacity-100 flex items-center justify-center transition-opacity">
                  <Camera size={16} className="text-white" />
                </div>
                <input
                  type="file"
                  ref={createAvatarInputRef}
                  className="hidden"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setNewGroupAvatarFile(file);
                      if (newGroupAvatarPreview) URL.revokeObjectURL(newGroupAvatarPreview);
                      setNewGroupAvatarPreview(URL.createObjectURL(file));
                    }
                    e.target.value = '';
                  }}
                />
              </div>
              {/* Name + Description */}
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder={t('groups.namePlaceholder')}
                  className="w-full text-sm px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white placeholder-neutral-400"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setIsCreating(false); }}
                />
                <input
                  type="text"
                  value={newGroupDescription}
                  onChange={(e) => setNewGroupDescription(e.target.value)}
                  placeholder={t('groups.descriptionPlaceholder')}
                  className="w-full text-sm px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white placeholder-neutral-400"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsCreating(false)} className="px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg">
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
          <Skeleton.List count={3} />
        ) : (
          <>
            {/* My Groups (owned) */}
            <div>
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3 flex items-center gap-2">
                <Orbit size={16} />
                {t('groups.ownedGroups')}
              </h2>
              {data?.owned && data.owned.length > 0 ? (
                <div className="space-y-2">
                  {data.owned.map(renderOwnedGroup)}
                </div>
              ) : (
                <p className="text-sm text-neutral-400 dark:text-neutral-400 italic py-4">{t('groups.empty')}</p>
              )}
            </div>

            {/* Groups I belong to */}
            {data?.memberOf && data.memberOf.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3 flex items-center gap-2">
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
      <input
        type="file"
        ref={avatarInputRef}
        className="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={handleAvatarChange}
      />

      <ConfirmDialog
        isOpen={!!deleteGroupId}
        onClose={() => setDeleteGroupId(null)}
        onConfirm={() => {
          if (deleteGroupId) deleteMutation.mutate(deleteGroupId);
        }}
        title={t('groups.deleteTitle')}
        message={t('groups.deleteConfirm')}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </div>
  );
}
