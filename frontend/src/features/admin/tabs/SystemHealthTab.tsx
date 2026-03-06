import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Database, Globe, Radio, Server, Clock } from 'lucide-react';
import {
  ResponsiveContainer, Area, CartesianGrid, XAxis, YAxis, Tooltip, Line, ComposedChart
} from 'recharts';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import type { SystemHealth, MetricsData } from '../types';
import { formatBytes } from '../types';

const AUTO_REFRESH_SEC = 30;

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

export default function SystemHealthTab() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsData | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_REFRESH_SEC);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [healthRes, metricsRes] = await Promise.all([
        api.get('/admin/system-health'),
        api.get('/admin/metrics?window=60'),
      ]);
      setHealth(healthRes.data);
      setMetricsData(metricsRes.data);
    } catch (e) { console.error(e); }
    setIsRefreshing(false);
    setCountdown(AUTO_REFRESH_SEC);
  }, []);

  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { fetchData(); return AUTO_REFRESH_SEC; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [fetchData]);

  const tooltipStyles = useTooltipStyles();

  if (!health) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  const memPercent = Math.round((health.memory.heapUsed / health.memory.heapTotal) * 100);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Auto-refresh bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-neutral-900 dark:text-white flex items-center gap-2">
          <Server size={20} className="text-emerald-600" />
          {t('admin.monitoring.title', 'System Health')}
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">{t('admin.monitoring.refreshIn', { seconds: countdown })}</span>
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={isRefreshing}>
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Status Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Uptime */}
        <div className="bg-white rounded-xl p-5 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center gap-2 mb-2">
            <Clock size={16} className="text-blue-500" />
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.uptime')}</span>
          </div>
          <p className="text-xl font-bold text-neutral-900 dark:text-white">{formatUptime(health.uptime)}</p>
        </div>

        {/* Memory */}
        <div className="bg-white rounded-xl p-5 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center gap-2 mb-2">
            <Server size={16} className="text-purple-500" />
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.memory')}</span>
          </div>
          <p className="text-xl font-bold text-neutral-900 dark:text-white">
            {formatBytes(health.memory.heapUsed)}
          </p>
          <div className="mt-2 w-full h-2 bg-neutral-100 dark:bg-neutral-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${memPercent > 80 ? 'bg-red-500' : memPercent > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${memPercent}%` }}
            />
          </div>
          <p className="text-[10px] text-neutral-400 mt-1">{memPercent}% of {formatBytes(health.memory.heapTotal)}</p>
        </div>

        {/* Database */}
        <div className="bg-white rounded-xl p-5 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center gap-2 mb-2">
            <Database size={16} className="text-cyan-500" />
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.database')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${health.database.status === 'ok' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            <p className={`text-xl font-bold ${health.database.status === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
              {health.database.status === 'ok' ? t('admin.monitoring.healthy') : t('admin.monitoring.error')}
            </p>
          </div>
        </div>

        {/* Connections */}
        <div className="bg-white rounded-xl p-5 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center gap-2 mb-2">
            <Radio size={16} className="text-amber-500" />
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.connections')}</span>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-500">WebSocket</span>
              <span className="text-sm font-bold text-neutral-900 dark:text-white">{health.connections.websocket}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-500">SSE</span>
              <span className="text-sm font-bold text-neutral-900 dark:text-white">{health.connections.sse}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Request Timeline Chart */}
      {metricsData && metricsData.timeline.length > 0 && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-neutral-900 dark:text-white flex items-center gap-2">
              <Globe size={16} />
              {t('admin.monitoring.requestTimeline', 'Requests / Minute (60 min)')}
            </h3>
            <div className="flex gap-4 text-xs text-neutral-500">
              <span>{t('admin.monitoring.totalRequests')}: <b className="text-neutral-900 dark:text-white">{metricsData.requestCount}</b></span>
              <span>{t('admin.monitoring.errors')}: <b className="text-red-600">{metricsData.errors4xx + metricsData.errors5xx}</b></span>
              <span>{t('admin.monitoring.avgMs')}: <b className="text-neutral-900 dark:text-white">{metricsData.avgResponseMs}ms</b></span>
            </div>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={metricsData.timeline}>
                <defs>
                  <linearGradient id="colorReqs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis
                  dataKey="minute"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                <Tooltip
                  labelFormatter={(v) => new Date(v as string).toLocaleTimeString()}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={((value: any, name: any) => [value ?? 0, name === 'requests' ? t('admin.monitoring.requests') : t('admin.monitoring.errors')]) as any}
                  {...tooltipStyles}
                />
                <Area type="monotone" dataKey="requests" stroke="#10b981" fill="url(#colorReqs)" />
                <Line type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Slowest Routes Table */}
      {metricsData && metricsData.routes.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40 overflow-hidden">
          <div className="p-4 border-b border-neutral-100 dark:border-neutral-700/40">
            <h3 className="font-semibold text-neutral-900 dark:text-white">{t('admin.monitoring.slowestRoutes', 'Slowest Routes')}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-neutral-50 text-neutral-500 uppercase text-xs font-medium dark:bg-neutral-900/50">
                <tr>
                  <th className="px-4 py-3">{t('admin.monitoring.route')}</th>
                  <th className="px-4 py-3">{t('admin.monitoring.method')}</th>
                  <th className="px-4 py-3 text-right">{t('admin.monitoring.count')}</th>
                  <th className="px-4 py-3 text-right">{t('admin.monitoring.avgMs')}</th>
                  <th className="px-4 py-3 text-right">P95</th>
                  <th className="px-4 py-3 text-right">Max</th>
                  <th className="px-4 py-3 text-right">{t('admin.monitoring.errors')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-700">
                {metricsData.routes.slice(0, 15).map((r, i) => (
                  <tr key={i} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                    <td className="px-4 py-3 font-mono text-xs text-neutral-700 dark:text-neutral-300">{r.route}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-bold ${r.method === 'GET' ? 'text-blue-600' : r.method === 'POST' ? 'text-green-600' : r.method === 'PUT' ? 'text-amber-600' : 'text-red-600'}`}>
                        {r.method}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-500">{r.count}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-medium ${r.avgMs > 500 ? 'text-red-600' : r.avgMs > 200 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {r.avgMs}ms
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-500">{r.p95Ms}ms</td>
                    <td className="px-4 py-3 text-right text-neutral-500">{r.maxMs}ms</td>
                    <td className="px-4 py-3 text-right">
                      {r.errors > 0 ? <span className="text-red-600 font-medium">{r.errors}</span> : <span className="text-neutral-400">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
