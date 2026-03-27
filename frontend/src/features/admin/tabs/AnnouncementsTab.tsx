import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import {
  Megaphone, Plus, Bold, Italic, Link as LinkIcon,
  PowerOff, Trash2, ChevronLeft, ChevronRight,
  AlertTriangle, Wrench, Sparkles, Bell, Info, Shield, Zap, Heart, Star, Gift,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import Modal from '../../../components/ui/Modal';
import {
  createAnnouncement,
  getAnnouncementHistory,
  deactivateAnnouncement,
  deleteAnnouncementApi,
  type Announcement,
} from '../../announcements/announcementService';

type AnnouncementCategory = 'MAINTENANCE' | 'FEATURE' | 'URGENT';

const ICON_OPTIONS: { name: string; icon: LucideIcon }[] = [
  { name: 'AlertTriangle', icon: AlertTriangle },
  { name: 'Wrench', icon: Wrench },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Bell', icon: Bell },
  { name: 'Info', icon: Info },
  { name: 'Megaphone', icon: Megaphone },
  { name: 'Shield', icon: Shield },
  { name: 'Zap', icon: Zap },
  { name: 'Heart', icon: Heart },
  { name: 'Star', icon: Star },
  { name: 'Gift', icon: Gift },
];

const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
];

const CATEGORY_STYLES: Record<AnnouncementCategory, string> = {
  FEATURE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  MAINTENANCE: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  URGENT: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export default function AnnouncementsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<AnnouncementCategory>('FEATURE');
  const [customColor, setCustomColor] = useState<string>('');
  const [customIcon, setCustomIcon] = useState<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'announcements', page],
    queryFn: () => getAnnouncementHistory(page),
  });

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false })],
    content: '',
    editorProps: {
      attributes: {
        class:
          'prose prose-sm dark:prose-invert min-h-[200px] max-h-[400px] overflow-y-auto p-4 focus:outline-none border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800',
      },
    },
  });

  const resetForm = useCallback(() => {
    setTitle('');
    setCategory('FEATURE');
    setCustomColor('');
    setCustomIcon('');
    editor?.commands.clearContent();
  }, [editor]);

  const handleCreate = async () => {
    if (!title.trim() || !editor) return;
    setIsSubmitting(true);
    try {
      await createAnnouncement({
        title: title.trim(),
        content: JSON.stringify(editor.getJSON()),
        category,
        customColor: customColor || null,
        customIcon: customIcon || null,
      });
      toast.success(t('announcements.admin.created'));
      setShowCreateModal(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
    } catch {
      toast.error(t('announcements.admin.createFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await deactivateAnnouncement(id);
      toast.success(t('announcements.admin.deactivated'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
    } catch {
      toast.error(t('announcements.admin.deactivateFailed'));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAnnouncementApi(deleteTarget);
      toast.success(t('announcements.admin.deleted'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'announcements'] });
    } catch {
      toast.error(t('announcements.admin.deleteFailed'));
    }
    setDeleteTarget(null);
  };

  const setLinkUrl = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="max-w-4xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold flex items-center gap-2 text-neutral-900 dark:text-white">
          <Megaphone size={24} className="text-emerald-600" />
          {t('announcements.admin.title')}
        </h2>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus size={16} className="mr-1.5" />
          {t('announcements.admin.new')}
        </Button>
      </div>

      {/* Announcement List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
        </div>
      ) : !data?.data?.length ? (
        <div className="text-center py-16 text-neutral-500 dark:text-neutral-400">
          <Megaphone size={48} className="mx-auto mb-3 opacity-30" />
          <p>{t('announcements.admin.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.data.map((a: Announcement) => (
            <div
              key={a.id}
              className="bg-white dark:bg-neutral-800 rounded-xl border border-neutral-200/60 dark:border-neutral-700/40 p-4 flex items-center justify-between gap-4 shadow-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${CATEGORY_STYLES[a.category]}`}
                  >
                    {t(`announcements.category.${a.category}`)}
                  </span>
                  <span className="font-semibold text-neutral-900 dark:text-white truncate">
                    {a.title}
                  </span>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {a.createdBy?.name || a.createdBy?.email} &middot; {formatDate(a.createdAt)}
                  {a._count?.dismissals != null && (
                    <span className="ml-2">
                      &middot; {t('announcements.admin.dismissals', { count: a._count.dismissals })}
                    </span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    a.isActive
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400'
                  }`}
                >
                  {a.isActive ? t('announcements.admin.active') : t('announcements.admin.inactive')}
                </span>
                {a.isActive && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeactivate(a.id)}
                    aria-label={t('announcements.admin.deactivate')}
                  >
                    <PowerOff size={14} className="mr-1" />
                    {t('announcements.admin.deactivate')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(a.id)}
                  className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-4">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                aria-label={t('common.previous')}
              >
                <ChevronLeft size={16} />
              </Button>
              <span className="text-sm text-neutral-600 dark:text-neutral-400">
                {page} / {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                aria-label={t('common.next')}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Create Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => { setShowCreateModal(false); resetForm(); }}
        title={t('announcements.admin.new')}
        size="xl"
      >
        <div className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1">
              {t('announcements.admin.titleLabel')}
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('announcements.admin.titlePlaceholder')}
              className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1">
              {t('announcements.admin.categoryLabel')}
            </label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value as AnnouncementCategory)}
              className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            >
              <option value="FEATURE">{t('announcements.category.FEATURE')}</option>
              <option value="MAINTENANCE">{t('announcements.category.MAINTENANCE')}</option>
              <option value="URGENT">{t('announcements.category.URGENT')}</option>
            </select>
          </div>

          {/* Custom Color */}
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1.5">
              {t('announcements.admin.customColor')}
              <span className="text-xs font-normal text-neutral-400 ml-1">({t('common.optional')})</span>
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {/* None option */}
              <button
                type="button"
                onClick={() => setCustomColor('')}
                className={clsx(
                  'w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs text-neutral-400 transition-all',
                  !customColor ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'border-neutral-300 dark:border-neutral-600'
                )}
                title={t('announcements.admin.defaultColor')}
              >
                ✕
              </button>
              {COLOR_PRESETS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCustomColor(c)}
                  className={clsx(
                    'w-8 h-8 rounded-full border-2 transition-all',
                    customColor === c ? 'border-neutral-900 dark:border-white ring-2 ring-offset-1' : 'border-transparent'
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
              {/* Custom hex input */}
              <input
                type="color"
                value={customColor || '#10b981'}
                onChange={e => setCustomColor(e.target.value)}
                className="w-8 h-8 rounded-lg cursor-pointer border-0 p-0"
                title={t('announcements.admin.pickColor')}
              />
            </div>
          </div>

          {/* Custom Icon */}
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1.5">
              {t('announcements.admin.customIcon')}
              <span className="text-xs font-normal text-neutral-400 ml-1">({t('common.optional')})</span>
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* None option (use category default) */}
              <button
                type="button"
                onClick={() => setCustomIcon('')}
                className={clsx(
                  'w-9 h-9 rounded-lg border flex items-center justify-center text-xs text-neutral-400 transition-all',
                  !customIcon ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                )}
                title={t('announcements.admin.defaultIcon')}
              >
                Auto
              </button>
              {ICON_OPTIONS.map(({ name, icon: IconComp }) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setCustomIcon(name)}
                  className={clsx(
                    'w-9 h-9 rounded-lg border flex items-center justify-center transition-all',
                    customIcon === name
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                      : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  )}
                  title={name}
                >
                  <IconComp size={18} />
                </button>
              ))}
            </div>
          </div>

          {/* Editor */}
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1">
              {t('announcements.admin.contentLabel')}
            </label>
            {/* Toolbar */}
            <div className="flex items-center gap-1 mb-2 p-1 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
              <button
                type="button"
                onClick={() => editor?.chain().focus().toggleBold().run()}
                className={`p-2 rounded transition-colors ${
                  editor?.isActive('bold')
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                    : 'text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
                aria-label={t('announcements.admin.bold')}
              >
                <Bold size={16} />
              </button>
              <button
                type="button"
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                className={`p-2 rounded transition-colors ${
                  editor?.isActive('italic')
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                    : 'text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
                aria-label={t('announcements.admin.italic')}
              >
                <Italic size={16} />
              </button>
              <button
                type="button"
                onClick={setLinkUrl}
                className={`p-2 rounded transition-colors ${
                  editor?.isActive('link')
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                    : 'text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
                aria-label={t('announcements.admin.link')}
              >
                <LinkIcon size={16} />
              </button>
            </div>
            <EditorContent editor={editor} />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => { setShowCreateModal(false); resetForm(); }}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!title.trim() || isSubmitting}
              isLoading={isSubmitting}
            >
              {t('announcements.admin.publish')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('announcements.admin.deleteTitle')}
        message={t('announcements.admin.deleteMessage')}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </div>
  );
}
