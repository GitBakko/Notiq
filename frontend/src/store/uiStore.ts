import { create } from 'zustand';

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
}

const loadSort = (): { field: SortField; order: SortOrder } => {
  try {
    const raw = localStorage.getItem('notesSort');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (['updatedAt', 'createdAt', 'title'].includes(parsed.field) && ['asc', 'desc'].includes(parsed.order)) {
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return { field: 'updatedAt', order: 'desc' };
};

export const useUIStore = create<UIState>((set) => ({
  isSidebarOpen: false,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  closeSidebar: () => set({ isSidebarOpen: false }),
  openSidebar: () => set({ isSidebarOpen: true }),
  isSearchOpen: false,
  toggleSearch: () => set((state) => ({ isSearchOpen: !state.isSearchOpen })),
  openSearch: () => set({ isSearchOpen: true }),
  closeSearch: () => set({ isSearchOpen: false }),
  theme: (localStorage.getItem('theme') as 'light' | 'dark' | 'system') || 'system',
  setTheme: (theme) => {
    set({ theme });
    localStorage.setItem('theme', theme);
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  },
  notesSortField: loadSort().field,
  notesSortOrder: loadSort().order,
  setNotesSort: (field, order) => {
    set({ notesSortField: field, notesSortOrder: order });
    localStorage.setItem('notesSort', JSON.stringify({ field, order }));
  },
}));

// Initialize theme
const theme = useUIStore.getState().theme;
const root = window.document.documentElement;
root.classList.remove('light', 'dark');
if (theme === 'system') {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.classList.add(systemTheme);
} else {
  root.classList.add(theme);
}
