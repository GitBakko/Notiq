import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { History, Filter, Download } from 'lucide-react';
import { format } from 'date-fns';
import {
  ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip
} from 'recharts';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import type { AuditLog, AuditStats } from '../types';

const EVENT_COLORS: Record<string, string> = {
  REGISTER: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  EMAIL_VERIFIED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  PASSWORD_RESET: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  PASSWORD_RESET_REQUEST: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  PASSWORD_CHANGED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  SHARE_SENT: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  SHARE_ACCEPTED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  SHARE_DECLINED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  SHARE_REVOKED: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  NOTE_DELETED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  NOTEBOOK_DELETED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  ADMIN_ROLE_CHANGE: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  ADMIN_SETTING_CHANGE: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  ADMIN_USER_VERIFY: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  IMPORT_EVERNOTE: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  IMPORT_ONENOTE: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
};

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

export default function AuditTab() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [logPage, setLogPage] = useState(1);
  const [logTotal, setLogTotal] = useState(0);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filterEvent, setFilterEvent] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const tooltipStyles = useTooltipStyles();

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(logPage), limit: '20' });
      if (filterEvent) params.set('event', filterEvent);
      if (filterDateFrom) params.set('dateFrom', filterDateFrom);
      if (filterDateTo) params.set('dateTo', filterDateTo);
      const res = await api.get(`/admin/audit-logs?${params}`);
      setLogs(res.data.logs);
      setLogTotal(res.data.total);
    } catch (e) { console.error(e); }
  }, [logPage, filterEvent, filterDateFrom, filterDateTo]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  useEffect(() => {
    api.get('/admin/audit-stats?days=30').then(res => setStats(res.data)).catch(() => {});
  }, []);

  const exportCsv = () => {
    if (logs.length === 0) return;
    const header = 'Event,User,Date,Details\n';
    const rows = logs.map(l =>
      `"${l.event}","${l.user?.email || 'System'}","${l.createdAt}","${JSON.stringify(l.details || {}).replace(/"/g, '""')}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-logs-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetFilters = () => {
    setFilterEvent('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setLogPage(1);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Audit Stats Chart */}
      {stats && stats.dailyTimeline.length > 0 && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <h3 className="font-semibold mb-4 text-neutral-900 dark:text-white">{t('admin.audit.eventTimeline', 'Audit Events (30 days)')}</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.dailyTimeline}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip {...tooltipStyles} />
                <Bar dataKey="count" fill="#10b981" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Event Distribution */}
      {stats && stats.eventCounts.length > 0 && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <h3 className="font-semibold mb-3 text-neutral-900 dark:text-white">{t('admin.audit.eventDistribution', 'Event Distribution')}</h3>
          <div className="flex flex-wrap gap-2">
            {stats.eventCounts.map(({ event, count }) => (
              <button
                key={event}
                onClick={() => { setFilterEvent(event); setLogPage(1); }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${EVENT_COLORS[event] || 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300'} hover:opacity-80`}
              >
                {event} <span className="font-bold">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Audit Logs */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 dark:bg-neutral-800 dark:border-neutral-700/40">
        <div className="flex flex-wrap justify-between items-center mb-4 gap-3">
          <h3 className="font-semibold text-neutral-900 dark:text-white">{t('admin.audit.title', 'System Audit Log')}</h3>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowFilters(!showFilters)}>
              <Filter size={14} className="mr-1" /> {t('admin.audit.filters', 'Filters')}
            </Button>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={logs.length === 0}>
              <Download size={14} className="mr-1" /> CSV
            </Button>
          </div>
        </div>

        {/* Filter Bar */}
        {showFilters && (
          <div className="flex flex-wrap gap-3 mb-4 p-3 bg-neutral-50 dark:bg-neutral-700/30 rounded-lg">
            <select
              value={filterEvent}
              onChange={e => { setFilterEvent(e.target.value); setLogPage(1); }}
              className="px-3 py-1.5 text-sm border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
            >
              <option value="">{t('admin.audit.allEvents', 'All Events')}</option>
              {stats?.eventTypes.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
            <input
              type="date"
              value={filterDateFrom}
              onChange={e => { setFilterDateFrom(e.target.value); setLogPage(1); }}
              className="px-3 py-1.5 text-sm border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
              placeholder={t('admin.audit.from', 'From')}
            />
            <input
              type="date"
              value={filterDateTo}
              onChange={e => { setFilterDateTo(e.target.value); setLogPage(1); }}
              className="px-3 py-1.5 text-sm border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
              placeholder={t('admin.audit.to', 'To')}
            />
            <Button variant="secondary" size="sm" onClick={resetFilters}>{t('admin.audit.reset', 'Reset')}</Button>
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-neutral-500">{t('admin.audit.totalEntries', { count: logTotal })}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setLogPage(p => Math.max(1, p - 1))} disabled={logPage === 1}>
              {t('admin.users.previous', 'Prev')}
            </Button>
            <span className="text-sm text-neutral-500 self-center">{t('admin.audit.page', { page: logPage })}</span>
            <Button variant="secondary" size="sm" onClick={() => setLogPage(p => p + 1)} disabled={logs.length < 20}>
              {t('admin.users.next', 'Next')}
            </Button>
          </div>
        </div>

        {/* Log Entries */}
        <div className="space-y-3">
          {logs.length === 0 && <p className="text-neutral-500 text-center py-4">{t('admin.audit.noLogs', 'No logs found.')}</p>}
          {logs.map((log) => (
            <div key={log.id} className="flex gap-3 p-3 border rounded-lg bg-neutral-50 dark:bg-neutral-700/30 dark:border-neutral-600">
              <div className="mt-0.5">
                <History size={16} className="text-neutral-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${EVENT_COLORS[log.event] || 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300'}`}>
                    {log.event}
                  </span>
                  <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium truncate">
                    {log.user?.email || 'System'}
                  </span>
                  <span className="text-xs text-neutral-400 ml-auto whitespace-nowrap">
                    {format(new Date(log.createdAt), 'PPpp')}
                  </span>
                </div>
                {log.details && Object.keys(log.details).length > 0 && (
                  <pre className="text-xs mt-1.5 bg-neutral-100 dark:bg-neutral-800 p-2 rounded overflow-x-auto text-neutral-600 dark:text-neutral-300">
                    {JSON.stringify(log.details, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
