import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { X, Loader2 } from 'lucide-react';
import api from '../../lib/api';
import { formatBytes } from '../../utils/format';

interface NoteSizeBreakdown {
  note: number;
  attachments: number;
  chat: number;
  ai: number;
  total: number;
  characters: number;
  lines: number;
}

interface NoteSizeModalProps {
  noteId: string;
  onClose: () => void;
}

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6'];

export default function NoteSizeModal({ noteId, onClose }: NoteSizeModalProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<NoteSizeBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api.get<NoteSizeBreakdown>(`/notes/${noteId}/size`)
      .then(res => { if (!cancelled) setData(res.data); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [noteId]);

  const chartData = data ? [
    { name: t('notes.size.noteContent'), value: data.note, color: COLORS[0] },
    { name: t('notes.size.attachments'), value: data.attachments, color: COLORS[1] },
    { name: t('notes.size.chat'), value: data.chat, color: COLORS[2] },
    { name: t('notes.size.ai'), value: data.ai, color: COLORS[3] },
  ].filter(d => d.value > 0) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('notes.size.title')}
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 size={24} className="animate-spin mr-2" />
              {t('notes.size.loading')}
            </div>
          )}

          {error && (
            <div className="text-center py-8 text-red-500 text-sm">
              {t('notes.size.error')}
            </div>
          )}

          {data && (
            <>
              {/* Total */}
              <div className="text-center mb-4">
                <span className="text-sm text-gray-500 dark:text-gray-400">{t('notes.size.total')}</span>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">
                  {formatBytes(data.total)}
                </div>
                <div className="flex items-center justify-center gap-3 mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                  <span>{(data.characters ?? 0).toLocaleString()} {t('notes.size.characters')}</span>
                  <span className="text-gray-300 dark:text-gray-600">|</span>
                  <span>{(data.lines ?? 0).toLocaleString()} {t('notes.size.lines')}</span>
                </div>
              </div>

              {/* Pie Chart */}
              {chartData.length > 0 ? (
                <div className="flex justify-center">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={chartData}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={85}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {chartData.map((entry, index) => (
                          <Cell key={index} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number) => formatBytes(value)}
                        contentStyle={{
                          backgroundColor: 'var(--tooltip-bg, #fff)',
                          border: '1px solid var(--tooltip-border, #e5e7eb)',
                          borderRadius: '8px',
                          fontSize: '13px',
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="text-center py-4 text-gray-400 text-sm">
                  {t('notes.size.loading')}
                </div>
              )}

              {/* Legend */}
              <div className="space-y-2 mt-4">
                {[
                  { label: t('notes.size.noteContent'), value: data.note, color: COLORS[0] },
                  { label: t('notes.size.attachments'), value: data.attachments, color: COLORS[1] },
                  { label: t('notes.size.chat'), value: data.chat, color: COLORS[2] },
                  { label: t('notes.size.ai'), value: data.ai, color: COLORS[3] },
                ].map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-gray-600 dark:text-gray-300">{item.label}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-900 dark:text-white font-medium">
                        {formatBytes(item.value)}
                      </span>
                      <span className="text-gray-400 text-xs w-12 text-right">
                        {data.total > 0 ? ((item.value / data.total) * 100).toFixed(1) : '0.0'}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
