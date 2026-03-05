import { useTranslation } from 'react-i18next';
import {
  Users, Activity, HardDrive, TrendingUp, Share2, Lock, Tag, Book
} from 'lucide-react';
import {
  Tooltip, ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell,
  CartesianGrid, XAxis, YAxis, BarChart, Bar, Legend
} from 'recharts';
import type { DashboardStats, SystemHealth } from '../types';
import { COLORS, formatBytes } from '../types';

const StatCard = ({ title, value, icon: Icon, subValue, color }: {
  title: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  subValue?: string;
  color: string;
}) => (
  <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{title}</p>
        <p className="text-2xl font-bold mt-2 text-neutral-900 dark:text-white">{value}</p>
        {subValue && <p className="text-xs mt-1 text-neutral-400">{subValue}</p>}
      </div>
      <div className={`p-3 rounded-lg ${color} bg-opacity-10 dark:bg-opacity-20`}>
        <Icon className={`w-6 h-6 ${color.replace('bg-', 'text-')}`} />
      </div>
    </div>
  </div>
);

interface DashboardTabProps {
  stats: DashboardStats | null;
  systemHealth: SystemHealth | null;
}

export default function DashboardTab({ stats, systemHealth }: DashboardTabProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Mini System Overview */}
      {systemHealth && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg p-4 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.uptime')}</p>
            <p className="text-lg font-bold text-neutral-900 dark:text-white mt-1">
              {formatUptime(systemHealth.uptime)}
            </p>
          </div>
          <div className="bg-white rounded-lg p-4 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.requestsPerMin')}</p>
            <p className="text-lg font-bold text-neutral-900 dark:text-white mt-1">
              {systemHealth.metrics.requestsPerMinute}
            </p>
          </div>
          <div className="bg-white rounded-lg p-4 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.errorRate')}</p>
            <p className={`text-lg font-bold mt-1 ${systemHealth.metrics.errorRate > 0.05 ? 'text-red-600' : 'text-emerald-600'}`}>
              {(systemHealth.metrics.errorRate * 100).toFixed(1)}%
            </p>
          </div>
          <div className="bg-white rounded-lg p-4 border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('admin.monitoring.avgResponse')}</p>
            <p className="text-lg font-bold text-neutral-900 dark:text-white mt-1">
              {systemHealth.metrics.avgResponseMs}ms
            </p>
          </div>
        </div>
      )}

      {/* General Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title={t('admin.stats.totalUsers')} value={stats?.kpi.totalUsers || 0} icon={Users} color="text-blue-600 bg-blue-600" />
        <StatCard
          title={t('admin.stats.activeUsers')}
          value={stats?.kpi.activeUsers || 0}
          subValue={t('admin.stats.last30days')}
          icon={Activity} color="text-emerald-600 bg-emerald-600"
        />
        <StatCard
          title={t('admin.stats.storage')}
          value={formatBytes(stats?.kpi.totalStorageBytes || 0)}
          subValue={t('admin.stats.files', { count: stats?.kpi.totalAttachments || 0 })}
          icon={HardDrive} color="text-purple-600 bg-purple-600"
        />
        <StatCard
          title={t('admin.stats.engagement')}
          value={stats?.kpi.avgNotesPerUser || 0}
          subValue={t('admin.stats.avgNotesPerUser')}
          icon={TrendingUp} color="text-amber-600 bg-amber-600"
        />
      </div>

      {/* Content & Collaboration Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title={t('admin.stats.notebooks')} value={stats?.kpi.totalNotebooks || 0} subValue={t('admin.stats.totalCollections')} icon={Book} color="text-indigo-600 bg-indigo-600" />
        <StatCard title={t('admin.stats.tags')} value={stats?.kpi.totalTags || 0} subValue={t('admin.stats.totalDistinctTags')} icon={Tag} color="text-pink-600 bg-pink-600" />
        <StatCard title={t('admin.stats.collaboration')} value={(stats?.kpi.totalSharedNotes || 0) + (stats?.kpi.totalSharedNotebooks || 0)} subValue={t('admin.stats.sharedNotesAndBooks')} icon={Share2} color="text-cyan-600 bg-cyan-600" />
        <StatCard title={t('admin.stats.vaultAdoption')} value={stats?.kpi.vaultUsersCount || 0} subValue={t('admin.stats.usersWithVaultItems')} icon={Lock} color="text-rose-600 bg-rose-600" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <h3 className="font-semibold mb-4 text-neutral-900 dark:text-white">{t('admin.charts.registrations')}</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats?.charts.registrationHistory}>
                <defs>
                  <linearGradient id="colorUsers" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.1} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Area type="monotone" dataKey="count" stroke="#2563eb" fill="url(#colorUsers)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <h3 className="font-semibold mb-4 text-neutral-900 dark:text-white">{t('admin.charts.sharingActivity')}</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.charts.sharingHistory}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'transparent' }} />
                <Legend />
                <Bar dataKey="count" name={t('admin.charts.sharedItems')} fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40">
          <h3 className="font-semibold mb-4 text-neutral-900 dark:text-white">{t('admin.charts.storageBreakdown')}</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stats?.charts.storageByType} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                  {stats?.charts.storageByType.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatBytes(Number(value ?? 0))} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-4 mt-2 flex-wrap">
            {stats?.charts.storageByType.map((entry, index) => (
              <div key={index} className="flex items-center gap-1 text-xs text-neutral-500">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }}></div>
                {entry.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
