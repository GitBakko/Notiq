import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KanbanFilters } from '../features/kanban/components/KanbanFilterBar';

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
  /** Kanban filters per board id (6.2): they survive leaving the board and reloads. */
  kanbanFilters: Record<string, KanbanFilters>;
  setKanbanFilters: (boardId: string, filters: KanbanFilters) => void;
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
      kanbanFilters: {},
      setKanbanFilters: (boardId, filters) =>
        set((state) => {
          // Bounded without LRU bookkeeping: adding a 21st board starts the map over.
          const isNew = !(boardId in state.kanbanFilters);
          const kept = isNew && Object.keys(state.kanbanFilters).length >= 20 ? {} : state.kanbanFilters;
          return { kanbanFilters: { ...kept, [boardId]: filters } };
        }),
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
        kanbanFilters: state.kanbanFilters,
      }),
    }
  )
);

// Initialize theme from persisted state
applyThemeClass(useUIStore.getState().theme);
