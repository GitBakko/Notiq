import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RemindersPage from '../RemindersPage';

const navigate = vi.fn();
const future = new Date(Date.now() + 3 * 86400000).toISOString();

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) }));
vi.mock('../../../hooks/useReminders', () => ({
  useReminders: () => [
    { id: 'n1', title: 'Plain title', reminderDate: future },
    { id: 'v1', title: 'Secret title', isVault: true, reminderDate: future },
  ],
}));
vi.mock('../../../hooks/useKanbanReminders', () => ({
  useKanbanReminders: () => ({ data: [] }),
  useToggleKanbanReminder: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../../hooks/useTaskReminders', () => ({ useTaskReminders: () => [] }));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../store/uiStore', () => ({ useUIStore: () => ({ toggleSidebar: vi.fn() }) }));
vi.mock('../../notes/noteService', () => ({ updateNote: vi.fn() }));
vi.mock('../../tasks/taskListService', () => ({ updateTaskItem: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

describe('RemindersPage vault notes', () => {
  it('shows the generic label for vault notes and opens them in /vault', () => {
    render(<RemindersPage />);
    expect(screen.getByText('Plain title')).toBeTruthy();
    expect(screen.queryByText('Secret title')).toBeNull();
    fireEvent.click(screen.getByText('vault.reminderGeneric'));
    expect(navigate).toHaveBeenCalledWith('/vault?noteId=v1');
  });
});
