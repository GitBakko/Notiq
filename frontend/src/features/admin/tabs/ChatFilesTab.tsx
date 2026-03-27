import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Trash2, HardDrive, FileText, Image, Film, Music, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import api from '../../../lib/api';
import { toast } from 'react-hot-toast';

interface ChatFileStats {
  totalFiles: number;
  totalSizeMB: number;
  filesByType: Record<string, number>;
}

interface ChatFileItem {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  message: {
    senderId: string;
    sender: { name: string | null; email: string };
    conversation: { id: string; type: string; title: string | null };
  };
}

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#6b7280'];

const TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  image: Image,
  video: Film,
  audio: Music,
};

// Dark-mode aware tooltip styles for Recharts
const useTooltipStyles = () => {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return {
    contentStyle: {
      backgroundColor: isDark ? '#262626' : '#fff',
      borderColor: isDark ? '#404040' : '#e5e7eb',
      borderRadius: 8,
      color: isDark ? '#f5f5f5' : '#111827',
    },
    labelStyle: { color: isDark ? '#d4d4d4' : '#6b7280' },
    itemStyle: { color: isDark ? '#f5f5f5' : '#111827' },
  };
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getTypeIcon(mimeType: string) {
  const type = mimeType.split('/')[0];
  return TYPE_ICONS[type] || FileText;
}

export default function ChatFilesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const limit = 20;

  const tooltipStyles = useTooltipStyles();

  const { data: stats, isLoading: statsLoading } = useQuery<ChatFileStats>({
    queryKey: ['admin', 'chat-files', 'stats'],
    queryFn: async () => (await api.get('/chat-direct/admin/chat-files/stats')).data,
  });

  const { data: filesData, isLoading: filesLoading } = useQuery<{ data: ChatFileItem[]; total: number }>({
    queryKey: ['admin', 'chat-files', page],
    queryFn: async () => (await api.get(`/chat-direct/admin/chat-files?page=${page}&limit=${limit}`)).data,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/chat-direct/admin/chat-files/${id}`);
    },
    onSuccess: () => {
      toast.success(t('common.success'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'chat-files'] });
      setDeleteTarget(null);
    },
    onError: () => {
      toast.error(t('common.error'));
    },
  });

  const pieData = stats
    ? Object.entries(stats.filesByType).map(([name, value]) => ({ name, value }))
    : [];

  const totalPages = filesData ? Math.ceil(filesData.total / limit) : 1;

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <h2 className="text-lg font-bold text-neutral-900 dark:text-white flex items-center gap-2">
        <HardDrive size={20} className="text-emerald-600" />
        {t('admin.chatFiles.title')}
      </h2>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Total Files */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
                {t('admin.chatFiles.totalFiles')}
              </p>
              <p className="text-2xl font-bold mt-2 text-neutral-900 dark:text-white">
                {stats?.totalFiles ?? 0}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-emerald-500 bg-opacity-10 dark:bg-opacity-20">
              <FileText className="w-6 h-6 text-emerald-500" />
            </div>
          </div>
        </div>

        {/* Total Size */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
                {t('admin.chatFiles.totalSize')}
              </p>
              <p className="text-2xl font-bold mt-2 text-neutral-900 dark:text-white">
                {stats?.totalSizeMB ?? 0} MB
              </p>
            </div>
            <div className="p-3 rounded-lg bg-blue-500 bg-opacity-10 dark:bg-opacity-20">
              <HardDrive className="w-6 h-6 text-blue-500" />
            </div>
          </div>
        </div>

        {/* Pie Chart by Type */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400 mb-2">
            {t('admin.chatFiles.filesByType')}
          </p>
          {pieData.length > 0 ? (
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={28} outerRadius={50}>
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyles.contentStyle}
                    labelStyle={tooltipStyles.labelStyle}
                    itemStyle={tooltipStyles.itemStyle}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-neutral-400 dark:text-neutral-500 mt-4">
              {t('admin.chatFiles.noFiles')}
            </p>
          )}
          {pieData.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {pieData.map((entry, i) => (
                <span key={entry.name} className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  {entry.name} ({entry.value})
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* File List Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 dark:border-neutral-700/40 bg-neutral-50 dark:bg-neutral-900/50">
                <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">
                  {t('admin.chatFiles.filename')}
                </th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">
                  {t('admin.chatFiles.sender')}
                </th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 hidden md:table-cell">
                  {t('admin.chatFiles.conversation')}
                </th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">
                  {t('admin.chatFiles.size')}
                </th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400 hidden sm:table-cell">
                  {t('admin.chatFiles.date')}
                </th>
                <th className="text-right px-4 py-3 font-medium text-neutral-500 dark:text-neutral-400">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filesLoading ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-neutral-400 dark:text-neutral-500">
                    {t('common.loading')}
                  </td>
                </tr>
              ) : !filesData?.data.length ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-neutral-400 dark:text-neutral-500">
                    {t('admin.chatFiles.noFiles')}
                  </td>
                </tr>
              ) : (
                filesData.data.map((file) => {
                  const TypeIcon = getTypeIcon(file.mimeType);
                  return (
                    <tr
                      key={file.id}
                      className="border-b border-neutral-50 dark:border-neutral-700/20 hover:bg-neutral-50 dark:hover:bg-neutral-700/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <TypeIcon size={16} className="text-neutral-400 dark:text-neutral-500 flex-shrink-0" />
                          <span className="truncate max-w-[200px] text-neutral-800 dark:text-neutral-200" title={file.filename}>
                            {file.filename}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300">
                        {file.message.sender.name || file.message.sender.email}
                      </td>
                      <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 hidden md:table-cell">
                        {file.message.conversation.title || file.message.conversation.type}
                      </td>
                      <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                        {formatFileSize(file.size)}
                      </td>
                      <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400 hidden sm:table-cell">
                        {new Date(file.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(file.id)}
                          aria-label={t('admin.chatFiles.deleteFile')}
                          className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-100 dark:border-neutral-700/40">
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {t('admin.audit.page', { page })} / {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label={t('admin.users.previous')}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                aria-label={t('admin.users.next')}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        title={t('admin.chatFiles.deleteFile')}
        message={t('admin.chatFiles.deleteFileConfirm')}
        variant="danger"
      />
    </div>
  );
}
