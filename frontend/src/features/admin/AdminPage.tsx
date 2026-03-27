import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import {
  Shield, LayoutDashboard, Users, History, Settings, Mail,
  HeartPulse, LogOut, Megaphone, HardDrive
} from 'lucide-react';
import api from '../../lib/api';
import type { DashboardStats, SystemHealth } from './types';

import DashboardTab from './tabs/DashboardTab';
import UsersTab from './tabs/UsersTab';
import AuditTab from './tabs/AuditTab';
import SettingsTab from './tabs/SettingsTab';
import RequestsTab from './tabs/RequestsTab';
import SystemHealthTab from './tabs/SystemHealthTab';
import AnnouncementsTab from './tabs/AnnouncementsTab';
import ChatFilesTab from './tabs/ChatFilesTab';

type TabId = 'dashboard' | 'users' | 'audit' | 'settings' | 'requests' | 'health' | 'announcements' | 'chatFiles';

const TABS: { id: TabId; icon: typeof LayoutDashboard; label: string }[] = [
  { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { id: 'health', icon: HeartPulse, label: 'System Health' },
  { id: 'users', icon: Users, label: 'Users' },
  { id: 'audit', icon: History, label: 'Audit Logs' },
  { id: 'settings', icon: Settings, label: 'Settings' },
  { id: 'requests', icon: Mail, label: 'Requests' },
  { id: 'announcements', icon: Megaphone, label: 'Announcements' },
  { id: 'chatFiles', icon: HardDrive, label: 'Chat Files' },
];

export default function AdminPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setIsLoading(true);
        const [statsRes, healthRes] = await Promise.all([
          api.get('/admin/stats'),
          api.get('/admin/system-health').catch(() => ({ data: null })),
        ]);
        setStats(statsRes.data);
        if (healthRes.data) setSystemHealth(healthRes.data);
      } catch {
        toast.error(t('admin.fetchFailed'));
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [t]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-neutral-50 dark:bg-neutral-950">
      {/* Sidebar Navigation */}
      <div className="w-64 bg-white border-r border-neutral-200/60 flex flex-col dark:bg-neutral-800 dark:border-neutral-700/40">
        <div className="p-6 border-b border-neutral-200/60 dark:border-neutral-700/40">
          <span className="text-xl font-bold flex items-center gap-2 text-emerald-600">
            <Shield /> SuperAdmin
          </span>
          <div className="mt-2 flex items-center gap-2 text-xs text-green-600 bg-green-50 dark:bg-green-900/20 px-2 py-1 rounded-full w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            {t('admin.monitoring.systemHealthy', 'System Healthy')}
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          {TABS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                activeTab === id
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-700'
              }`}
            >
              <Icon size={20} /> {label}
            </button>
          ))}
          <Link
            to="/"
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-700 mt-auto border-t border-neutral-100 dark:border-neutral-700/40"
          >
            <LogOut size={20} className="rotate-180" /> {t('common.backToApp', 'Back to App')}
          </Link>
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {activeTab === 'dashboard' && <DashboardTab stats={stats} systemHealth={systemHealth} />}
        {activeTab === 'health' && <SystemHealthTab />}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'audit' && <AuditTab />}
        {activeTab === 'settings' && <SettingsTab />}
        {activeTab === 'requests' && <RequestsTab />}
        {activeTab === 'announcements' && <AnnouncementsTab />}
        {activeTab === 'chatFiles' && <ChatFilesTab />}
      </div>
    </div>
  );
}
