import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SortField = 'updatedAt' | 'createdAt' | 'title';
export type SortOrder = 'asc' | 'desc';

interface UIState {
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  openSidebar: () => void;
  isSearchOpen: boolean;
  toggleSearch: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  notesSortField: SortField;
  notesSortOrder: SortOrder;
  setNotesSort: (field: SortField, order: SortOrder) => void;
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  isListCollapsed: boolean;
  toggleListCollapsed: () => void;
  isSidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  collapseAll: () => void;
  isNotificationPanelOpen: boolean;
  toggleNotificationPanel: () => void;
  closeNotificationPanel: () => void;
}

const applyThemeClass = (theme: 'light' | 'dark' | 'system') => {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme === 'system') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.classList.add(systemTheme);
  } else {
    root.classList.add(theme);
  }
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Transient state (not persisted)
      isSidebarOpen: false,
      toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
      closeSidebar: () => set({ isSidebarOpen: false }),
      openSidebar: () => set({ isSidebarOpen: true }),
      isSearchOpen: false,
      toggleSearch: () => set((state) => ({ isSearchOpen: !state.isSearchOpen })),
      openSearch: () => set({ isSearchOpen: true }),
      closeSearch: () => set({ isSearchOpen: false }),
      isNotificationPanelOpen: false,
      toggleNotificationPanel: () => set((state) => ({ isNotificationPanelOpen: !state.isNotificationPanelOpen })),
      closeNotificationPanel: () => set({ isNotificationPanelOpen: false }),

      // Persisted state
      theme: 'system',
      setTheme: (theme) => {
        set({ theme });
        applyThemeClass(theme);
      },
      notesSortField: 'updatedAt' as SortField,
      notesSortOrder: 'desc' as SortOrder,
      setNotesSort: (field, order) => set({ notesSortField: field, notesSortOrder: order }),
      notificationSoundEnabled: true,
      setNotificationSoundEnabled: (enabled) => set({ notificationSoundEnabled: enabled }),
      isListCollapsed: false,
      toggleListCollapsed: () => set((state) => ({ isListCollapsed: !state.isListCollapsed })),
      isSidebarCollapsed: false,
      toggleSidebarCollapsed: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
      collapseAll: () => set({ isSidebarCollapsed: true, isListCollapsed: true }),
    }),
    {
      name: 'ui-storage',
      partialize: (state) => ({
        theme: state.theme,
        notesSortField: state.notesSortField,
        notesSortOrder: state.notesSortOrder,
        notificationSoundEnabled: state.notificationSoundEnabled,
        isListCollapsed: state.isListCollapsed,
        isSidebarCollapsed: state.isSidebarCollapsed,
      }),
    }
  )
);

// Initialize theme from persisted state
applyThemeClass(useUIStore.getState().theme);
