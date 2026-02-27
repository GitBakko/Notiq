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
import { CURRENT_VERSION } from '../../data/changelog';

import { useSync } from '../../hooks/useSync';

export default function AppLayout() {
  const { token } = useAuthStore();
  useSync();

  const { isSidebarOpen, closeSidebar, isSidebarCollapsed, toggleSidebarCollapsed } = useUIStore();
  const isMobile = useIsMobile();
  const location = useLocation();

  const [showWhatsNew, setShowWhatsNew] = useState(() => {
    const lastSeen = localStorage.getItem('lastSeenVersion');
    return lastSeen !== CURRENT_VERSION;
  });

  // Close sidebar on route change on mobile
  useEffect(() => {
    if (isMobile) {
      closeSidebar();
    }
  }, [location.pathname, location.search, isMobile, closeSidebar]);

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
    <div className="flex h-screen bg-white dark:bg-gray-900 overflow-hidden safe-area-top safe-area-bottom">
      <CommandMenu />
      {/* Mobile Sidebar Overlay */}
      {isMobile && isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      <div className={clsx(
        "h-full bg-gray-50 border-r border-gray-200 dark:bg-gray-900 dark:border-gray-800 z-50",
        isMobile
          ? "fixed inset-y-0 left-0 w-64 shadow-xl transition-transform duration-300 ease-in-out"
          : clsx("relative transition-[width] duration-300 ease-in-out", isSidebarCollapsed ? "w-14" : "w-64"),
        isMobile && !isSidebarOpen && "-translate-x-full"
      )}>
        <Sidebar />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden w-full bg-white dark:bg-gray-900">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </div>

      {showWhatsNew && <WhatsNewModal onClose={() => setShowWhatsNew(false)} />}
    </div>
  );
}
