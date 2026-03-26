import { Outlet, Navigate, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useAuthStore } from '../../store/authStore';
import { useEffect, useState } from 'react';
import ErrorBoundary from '../ErrorBoundary';
import { useUIStore } from '../../store/uiStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import clsx from 'clsx';
import CommandMenu from '../search/CommandMenu';
import WhatsNewModal from '../WhatsNewModal';
import AnnouncementBanner from '../../features/announcements/AnnouncementBanner';
import NotificationPanel from '../../features/notifications/NotificationPanel';
import { CURRENT_VERSION } from '../../data/changelog';
import i18n from '../../i18n';

import { useSync } from '../../hooks/useSync';

export default function AppLayout() {
  const { token, user, updateUser } = useAuthStore();
  useSync();

  const { isSidebarOpen, closeSidebar, isSidebarCollapsed, toggleSidebarCollapsed, closeNotificationPanel } = useUIStore();
  const isMobile = useIsMobile();
  const location = useLocation();

  const [showWhatsNew, setShowWhatsNew] = useState(() => {
    const lastSeen = localStorage.getItem('lastSeenVersion');
    return lastSeen !== CURRENT_VERSION;
  });

  // Close sidebar on route change on mobile, close notification panel on any route change
  useEffect(() => {
    if (isMobile) {
      closeSidebar();
    }
    closeNotificationPanel();
  }, [location.pathname, location.search, isMobile, closeSidebar, closeNotificationPanel]);

  // Sync frontend language to backend locale (covers existing users who never had locale set)
  useEffect(() => {
    if (!user) return;
    const frontendLang = i18n.language?.split('-')[0] || 'en';
    if (user.locale !== frontendLang && (frontendLang === 'en' || frontendLang === 'it')) {
      updateUser({ locale: frontendLang });
    }
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+B to toggle sidebar collapse (desktop only)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'b' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        if (!isMobile) toggleSidebarCollapsed();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, toggleSidebarCollapsed]);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen bg-white dark:bg-neutral-950 overflow-hidden safe-area-top safe-area-bottom">
      <CommandMenu />
      {/* Mobile Sidebar Overlay */}
      {isMobile && isSidebarOpen && (
        <div
          className="fixed inset-0 bg-neutral-950/60 z-40"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      <div className={clsx(
        "h-full bg-neutral-50 border-r border-neutral-200/60 dark:bg-neutral-950 dark:border-neutral-800/40 z-50",
        isMobile
          ? "fixed inset-y-0 left-0 w-64 shadow-xl transition-transform duration-300 ease-in-out"
          : clsx("relative transition-[width] duration-300 ease-in-out", isSidebarCollapsed ? "w-14" : "w-64"),
        isMobile && !isSidebarOpen && "-translate-x-full"
      )}>
        <Sidebar />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden w-full bg-white dark:bg-neutral-950">
        <AnnouncementBanner />
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </div>

      <NotificationPanel />
      {showWhatsNew && <WhatsNewModal onClose={() => setShowWhatsNew(false)} />}
    </div>
  );
}
