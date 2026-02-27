import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import {
  Users,
  Activity,
  HardDrive,
  Settings,
  Shield,
  TrendingUp,
  Search,
  Check,
  History,
  LayoutDashboard,
  Share2,
  Lock,
  Tag,
  Book,
  LogOut,
  Mail,
  Sparkles,
  Eye,
  EyeOff
} from 'lucide-react';
import {
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  XAxis,
  YAxis,
  BarChart,
  Bar,
  Legend
} from 'recharts';
import api from '../../lib/api';
import { format } from 'date-fns';
import { Button } from '../../components/ui/Button';

// --- Types ---
interface DashboardStats {
  kpi: {
    totalUsers: number;
    activeUsers: number;
    totalNotes: number;
    totalNotebooks: number;
    totalStorageBytes: number;
    totalAttachments: number;
    avgNotesPerUser: number;
    // New Metrics
    totalTags: number;
    totalSharedNotes: number;
    totalSharedNotebooks: number;
    vaultUsersCount: number;
  };
  charts: {
    registrationHistory: { date: string; count: number }[];
    notesHistory: { date: string; count: number }[];
    storageByType: { name: string; value: number }[];
    sharingHistory: { date: string; count: number }[];
  };
  recentUsers: UserData[];
}

interface UserData {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastActiveAt: string;
  role: 'USER' | 'SUPERADMIN';
  isVerified: boolean;
  _count?: { notes: number };
}

interface AuditLog {
  id: string;
  event: string;
  createdAt: string;
  user: { email: string };
  details: Record<string, unknown>;
}

// --- Components ---

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8'];

const StatCard = ({ title, value, icon: Icon, subValue, color }: { title: string; value: string | number; icon: React.ComponentType<{ className?: string }>; subValue?: string; color: string }) => (
  <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
        <p className="text-2xl font-bold mt-2 text-gray-900 dark:text-white">{value}</p>
        {subValue && <p className="text-xs mt-1 text-gray-400">{subValue}</p>}
      </div>
      <div className={`p-3 rounded-lg ${color} bg-opacity-10 dark:bg-opacity-20`}>
        <Icon className={`w-6 h-6 ${color.replace('bg-', 'text-')}`} />
      </div>
    </div>
  </div>
);

export default function AdminPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'users' | 'audit' | 'settings' | 'requests'>('dashboard');
  const [isLoading, setIsLoading] = useState(true);

  // Data States
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [invitationEnabled, setInvitationEnabled] = useState(false);

  // AI Config State
  const [aiConfig, setAiConfig] = useState({
    enabled: false,
    provider: 'anthropic',
    apiKeySet: false,
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    temperature: 0.7,
  });
  const [aiApiKey, setAiApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  // Users Tab State
  const [users, setUsers] = useState<UserData[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [userTotalPages, setUserTotalPages] = useState(1);

  // Audit Tab State
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [logPage, setLogPage] = useState(1);

  // Requests Tab State
  const [requests, setRequests] = useState<{ id: string; email: string; createdAt: string; status: string }[]>([]);

  useEffect(() => {
    fetchInitialData();
  }, []);

  useEffect(() => {
    if (activeTab === 'users') fetchUsers();
    if (activeTab === 'audit') fetchLogs();
    if (activeTab === 'requests') fetchRequests();
  }, [activeTab, userPage, logPage]); // Trigger on tab change or pagination

  // Debounced search for users
  useEffect(() => {
    if (activeTab === 'users') {
      const timer = setTimeout(() => {
        setUserPage(1);
        fetchUsers();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [userSearch]);


  const fetchInitialData = async () => {
    try {
      setIsLoading(true);
      const [configRes, statsRes, aiRes] = await Promise.all([
        api.get('/auth/config'),
        api.get('/admin/stats'),
        api.get('/admin/ai-config').catch(() => ({ data: null })),
      ]);
      setInvitationEnabled(configRes.data.invitationSystemEnabled);
      setStats(statsRes.data);
      if (aiRes.data) setAiConfig(aiRes.data);
      setIsLoading(false);
    } catch {
      toast.error(t('admin.fetchFailed'));
      setIsLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await api.get(`/admin/users?page=${userPage}&limit=10&search=${userSearch}`);
      setUsers(res.data.users);
      setUserTotalPages(res.data.pages);
    } catch (e) { console.error(e); }
  };

  const fetchLogs = async () => {
    try {
      const res = await api.get(`/admin/audit-logs?page=${logPage}&limit=20`);
      setLogs(res.data.logs);
    } catch (e) { console.error(e); }
  };

  const updateUserRole = async (userId: string, action: string) => {
    try {
      const payload = action === 'VERIFY' ? { isVerified: true } : { role: action };
      await api.put(`/admin/users/${userId}`, payload);
      toast.success("User updated successfully");
      fetchUsers();
    } catch { toast.error("Failed to update user"); }
  }

  const toggleInvitationSystem = async () => {
    try {
      await api.post('/admin/settings', {
        key: 'invitation_system_enabled',
        value: (!invitationEnabled).toString()
      });
      setInvitationEnabled(!invitationEnabled);
      toast.success(t('admin.settingsUpdated'));
    } catch { toast.error(t('admin.updateFailed')); }
  };

  const saveAiSetting = async (key: string, value: string) => {
    try {
      await api.post('/admin/settings', { key, value });
    } catch {
      toast.error(t('admin.updateFailed'));
    }
  };

  const handleAiToggle = async () => {
    const newVal = !aiConfig.enabled;
    setAiConfig(c => ({ ...c, enabled: newVal }));
    await saveAiSetting('ai_enabled', newVal.toString());
    toast.success(t('admin.settingsUpdated'));
  };

  const handleAiApiKeySave = async () => {
    if (!aiApiKey.trim()) return;
    await saveAiSetting('ai_api_key', aiApiKey.trim());
    setAiConfig(c => ({ ...c, apiKeySet: true }));
    setAiApiKey('');
    setShowApiKey(false);
    toast.success(t('admin.ai.saved'));
  };

  const handleAiModelChange = async (model: string) => {
    setAiConfig(c => ({ ...c, model }));
    await saveAiSetting('ai_model', model);
  };

  const handleAiMaxTokensChange = async (maxTokens: number) => {
    setAiConfig(c => ({ ...c, maxTokens }));
    await saveAiSetting('ai_max_tokens', maxTokens.toString());
  };

  const handleAiTemperatureChange = async (temperature: number) => {
    setAiConfig(c => ({ ...c, temperature }));
    await saveAiSetting('ai_temperature', temperature.toString());
  };

  const fetchRequests = async () => {
    try {
      const res = await api.get('/admin/requests');
      setRequests(res.data);
    } catch (e) {
      console.error(e);
      toast.error('Failed to fetch requests');
    }
  };

  const handleRequestAction = async (id: string, action: 'approve' | 'reject') => {
    try {
      await api.post(`/admin/requests/${id}/${action}`);
      toast.success(`Request ${action}d`);
      fetchRequests();
    } catch {
      toast.error(`Failed to ${action} request`);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (isLoading) return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
    </div>
  );

  return (
    <div className="flex h-full bg-gray-50 dark:bg-gray-900">

      {/* Sidebar Navigation */}
      <div className="w-64 bg-white border-r border-gray-200 flex flex-col dark:bg-gray-800 dark:border-gray-700">
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xl font-bold flex items-center gap-2 text-emerald-600">
            <Shield /> SuperAdmin
          </span>
          <div className="mt-2 flex items-center gap-2 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            System Healthy
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'dashboard' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700'}`}
          >
            <LayoutDashboard size={20} /> {t('admin.dashboard')}
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'users' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700'}`}
          >
            <Users size={20} /> {t('admin.users', 'User Management')}
          </button>
          <button
            onClick={() => setActiveTab('audit')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'audit' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700'}`}
          >
            <History size={20} /> {t('admin.audit', 'Audit Logs')}
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'settings' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700'}`}
          >
            <Settings size={20} /> {t('admin.settings', 'Settings')}
          </button>
          <button
            onClick={() => setActiveTab('requests')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'requests' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700'}`}
          >
            <Mail size={20} /> {t('admin.requests', 'Requests')}
          </button>
          <Link
            to="/"
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700 mt-auto border-t border-gray-100 dark:border-gray-700"
          >
            <LogOut size={20} className="rotate-180" /> {t('common.backToApp', 'Back to App')}
          </Link>
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-8">

        {/* DASHBOARD TAB */}
        {activeTab === 'dashboard' && (
          <div className="space-y-8 animate-in fade-in duration-500">

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

            {/* Content & Collaboration Stats (New Row) */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard
                title={t('admin.stats.notebooks')}
                value={stats?.kpi.totalNotebooks || 0}
                subValue={t('admin.stats.totalCollections')}
                icon={Book} color="text-indigo-600 bg-indigo-600"
              />
              <StatCard
                title={t('admin.stats.tags')}
                value={stats?.kpi.totalTags || 0}
                subValue={t('admin.stats.totalDistinctTags')}
                icon={Tag} color="text-pink-600 bg-pink-600"
              />
              <StatCard
                title={t('admin.stats.collaboration')}
                value={(stats?.kpi.totalSharedNotes || 0) + (stats?.kpi.totalSharedNotebooks || 0)}
                subValue={t('admin.stats.sharedNotesAndBooks')}
                icon={Share2} color="text-cyan-600 bg-cyan-600"
              />
              <StatCard
                title={t('admin.stats.vaultAdoption')}
                value={stats?.kpi.vaultUsersCount || 0}
                subValue={t('admin.stats.usersWithVaultItems')}
                icon={Lock} color="text-rose-600 bg-rose-600"
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* User Growth */}
              <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <h3 className="font-semibold mb-4 text-gray-900 dark:text-white">{t('admin.charts.registrations')}</h3>
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

              {/* Sharing Activity (New Chart) */}
              <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <h3 className="font-semibold mb-4 text-gray-900 dark:text-white">{t('admin.charts.sharingActivity')}</h3>
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

              {/* Storage Composition */}
              <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <h3 className="font-semibold mb-4 text-gray-900 dark:text-white">{t('admin.charts.storageBreakdown')}</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={stats?.charts.storageByType}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={5}
                        dataKey="value"
                      >
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
                    <div key={index} className="flex items-center gap-1 text-xs text-gray-500">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }}></div>
                      {entry.name}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* USERS TAB */}
        {activeTab === 'users' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
              <div className="relative w-96">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                  type="text"
                  placeholder={t('admin.users.searchPlaceholder')}
                  className="pl-10 pr-4 py-2 w-full border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-500 uppercase font-medium dark:bg-gray-900/50">
                  <tr>
                    <th className="px-6 py-3">{t('admin.users.user')}</th>
                    <th className="px-6 py-3">{t('admin.users.role')}</th>
                    <th className="px-6 py-3">{t('admin.users.stats')}</th>
                    <th className="px-6 py-3">{t('admin.users.joined')}</th>
                    <th className="px-6 py-3 text-right">{t('admin.users.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-6 py-4">
                        <div className="font-medium text-gray-900 dark:text-white">{user.name || t('admin.users.anonymous')}</div>
                        <div className="text-gray-500">{user.email}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${user.role === 'SUPERADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {t('admin.users.notesCount', { count: user._count?.notes || 0 })}
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {format(new Date(user.createdAt), 'MMM d, yyyy')}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          {/* Verify Action */}
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {userTotalPages > 1 && (
              <div className="flex items-center justify-between p-4 bg-white rounded-xl border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setUserPage(p => Math.max(1, p - 1))}
                  disabled={userPage === 1}
                >
                  {t('admin.users.previous')}
                </Button>
                <span className="text-sm text-gray-500">
                  {t('admin.users.pageOf', { page: userPage, total: userTotalPages })}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setUserPage(p => Math.min(userTotalPages, p + 1))}
                  disabled={userPage === userTotalPages}
                >
                  {t('admin.users.next')}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* AUDIT TAB */}
        {activeTab === 'audit' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:bg-gray-800 dark:border-gray-700">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">System Audit Log</h3>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setLogPage(p => Math.max(1, p - 1))} disabled={logPage === 1}>Prev</Button>
                  <span className="text-sm text-gray-500 self-center">Page {logPage}</span>
                  <Button variant="secondary" size="sm" onClick={() => setLogPage(p => p + 1)} disabled={logs.length < 20}>Next</Button>
                </div>
              </div>
              <div className="space-y-4">
                {logs.length === 0 && <p className="text-gray-500">No logs found.</p>}
                {logs.map((log) => (
                  <div key={log.id} className="flex gap-4 p-4 border rounded-lg bg-gray-50 dark:bg-gray-700/30 dark:border-gray-600">
                    <div className="mt-1">
                      <History size={18} className="text-gray-400" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">
                        <span className="font-bold">{log.event}</span> by <span className="text-emerald-600">{log.user?.email || 'System'}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-1">{format(new Date(log.createdAt), 'PPpp')}</p>
                      {log.details && (
                        <pre className="text-xs mt-2 bg-gray-100 p-2 rounded dark:bg-gray-800 overflow-x-auto text-gray-600 dark:text-gray-300">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}


        {/* REQUESTS TAB */}
        {activeTab === 'requests' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:bg-gray-800 dark:border-gray-700">
              <h3 className="font-semibold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
                <Mail size={20} /> Invitation Requests
              </h3>

              <div className="overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-50 text-gray-500 uppercase font-medium dark:bg-gray-900/50">
                    <tr>
                      <th className="px-6 py-3">Email</th>
                      <th className="px-6 py-3">Requested</th>
                      <th className="px-6 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {requests.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-6 py-4 text-center text-gray-500">No pending requests.</td>
                      </tr>
                    ) : requests.map((req) => (
                      <tr key={req.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-6 py-4 font-medium text-gray-900 dark:text-white">
                          {req.email}
                        </td>
                        <td className="px-6 py-4 text-gray-500">
                          {format(new Date(req.createdAt), 'PPpp')}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              className="bg-emerald-600 hover:bg-emerald-700 text-white"
                              onClick={() => handleRequestAction(req.id, 'approve')}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                              onClick={() => handleRequestAction(req.id, 'reject')}
                            >
                              Reject
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === 'settings' && (
          <div className="max-w-xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:bg-gray-800 dark:border-gray-700">
              <h3 className="font-semibold mb-6 flex items-center gap-2 text-gray-900 dark:text-white">
                <Settings size={20} /> System Settings
              </h3>

              <div className="flex items-center justify-between pb-6 border-b border-gray-100 dark:border-gray-700">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">Invitation System Only</p>
                  <p className="text-xs text-gray-500 mt-1">
                    If enabled, new users can only register with a valid invite code.
                  </p>
                </div>
                <button
                  onClick={toggleInvitationSystem}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${invitationEnabled ? 'bg-emerald-600' : 'bg-gray-200 dark:bg-gray-700'}`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${invitationEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
            </div>

            {/* AI Configuration */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 dark:bg-gray-800 dark:border-gray-700 mt-6">
              <h3 className="font-semibold mb-6 flex items-center gap-2 text-gray-900 dark:text-white">
                <Sparkles size={20} className="text-purple-500" /> {t('admin.ai.title')}
              </h3>

              {/* AI Enable toggle */}
              <div className="flex items-center justify-between pb-4 border-b border-gray-100 dark:border-gray-700">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">{t('admin.ai.enabled')}</p>
                  <p className="text-xs text-gray-500 mt-1">{t('admin.ai.enabledDesc')}</p>
                </div>
                <button
                  onClick={handleAiToggle}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${aiConfig.enabled ? 'bg-purple-600' : 'bg-gray-200 dark:bg-gray-700'}`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${aiConfig.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* API Key */}
              <div className="py-4 border-b border-gray-100 dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">{t('admin.ai.apiKey')}</label>
                <p className={`text-xs mb-2 ${aiConfig.apiKeySet ? 'text-green-600' : 'text-red-500'}`}>
                  {aiConfig.apiKeySet ? t('admin.ai.apiKeySet') : t('admin.ai.apiKeyNotSet')}
                </p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={aiApiKey}
                      onChange={e => setAiApiKey(e.target.value)}
                      placeholder={t('admin.ai.apiKeyPlaceholder')}
                      className="w-full px-3 py-2 pr-10 text-sm border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <Button size="sm" onClick={handleAiApiKeySave} disabled={!aiApiKey.trim()}>
                    {t('common.save')}
                  </Button>
                </div>
              </div>

              {/* Model */}
              <div className="py-4 border-b border-gray-100 dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">{t('admin.ai.model')}</label>
                <select
                  value={aiConfig.model}
                  onChange={e => handleAiModelChange(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                >
                  <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                  <option value="claude-opus-4-20250514">Claude Opus 4</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                </select>
              </div>

              {/* Max Tokens */}
              <div className="py-4 border-b border-gray-100 dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-900 dark:text-white mb-1">{t('admin.ai.maxTokens')}</label>
                <input
                  type="number"
                  value={aiConfig.maxTokens}
                  onChange={e => handleAiMaxTokensChange(Math.max(256, Math.min(8192, parseInt(e.target.value) || 4096)))}
                  min={256}
                  max={8192}
                  step={256}
                  className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-gray-700 dark:text-white dark:border-gray-600"
                />
              </div>

              {/* Temperature */}
              <div className="pt-4">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-gray-900 dark:text-white">{t('admin.ai.temperature')}</label>
                  <span className="text-sm text-gray-500">{aiConfig.temperature.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  value={aiConfig.temperature}
                  onChange={e => handleAiTemperatureChange(parseFloat(e.target.value))}
                  min={0}
                  max={1}
                  step={0.1}
                  className="w-full accent-purple-600"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>Precise (0)</span>
                  <span>Creative (1)</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
