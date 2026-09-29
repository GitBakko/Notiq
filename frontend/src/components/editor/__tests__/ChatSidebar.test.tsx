import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const { mockUseQuery, mockPlaySound } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockPlaySound: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: mockUseQuery,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('emoji-picker-react', () => ({ default: () => null, Theme: { DARK: 'dark', LIGHT: 'light' } }));
vi.mock('../../../utils/notificationSound', () => ({ playNotificationSound: mockPlaySound }));
vi.mock('../../../lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import ChatSidebar from '../ChatSidebar';

const msg = (i: number) => ({
  id: `m-${i}`,
  userId: 'u-2',
  content: `message ${i}`,
  createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, i)).toISOString(),
  user: { id: 'u-2', name: 'Bob', email: 'bob@example.com', color: null, avatarUrl: null },
});
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k));

const currentUser = { id: 'u-1', name: 'Alice', color: '#000' };

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; the sidebar scrolls to the last message.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ChatSidebar — new message notification', () => {
  // The note chat serves the latest 100 messages. Past 100, a new message pushes the
  // oldest out and the length stays 100: comparing lengths never saw it.
  it('notifies a new message even when the window is already full', () => {
    const onNewMessage = vi.fn();
    mockUseQuery.mockReturnValue({ data: range(0, 100), isLoading: false });
    const { rerender } = render(
      <ChatSidebar noteId="n1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />,
    );

    mockUseQuery.mockReturnValue({ data: range(1, 101), isLoading: false });
    rerender(<ChatSidebar noteId="n1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

    expect(mockPlaySound).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
  });

  it('does not notify on the first load', () => {
    const onNewMessage = vi.fn();
    mockUseQuery.mockReturnValue({ data: range(0, 5), isLoading: false });
    render(<ChatSidebar noteId="n1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

    expect(mockPlaySound).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it('does not notify when the newest message is unchanged (refetch, or an older one deleted)', () => {
    const onNewMessage = vi.fn();
    mockUseQuery.mockReturnValue({ data: range(0, 5), isLoading: false });
    const { rerender } = render(
      <ChatSidebar noteId="n1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />,
    );

    mockUseQuery.mockReturnValue({ data: range(1, 5), isLoading: false });
    rerender(<ChatSidebar noteId="n1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

    expect(mockPlaySound).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it('plays the sound but does not raise the badge when the sidebar is open', () => {
    const onNewMessage = vi.fn();
    mockUseQuery.mockReturnValue({ data: range(0, 3), isLoading: false });
    const { rerender } = render(
      <ChatSidebar noteId="n1" isOpen onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />,
    );

    mockUseQuery.mockReturnValue({ data: range(0, 4), isLoading: false });
    rerender(<ChatSidebar noteId="n1" isOpen onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

    expect(mockPlaySound).toHaveBeenCalledTimes(1);
    expect(onNewMessage).not.toHaveBeenCalled();
  });
});
