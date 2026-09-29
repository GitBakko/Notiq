import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const { mockUseKanbanChat, mockPlaySound } = vi.hoisted(() => ({
  mockUseKanbanChat: vi.fn(),
  mockPlaySound: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../hooks/useKanbanChat', () => ({ useKanbanChat: mockUseKanbanChat }));
vi.mock('../../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../../utils/notificationSound', () => ({ playNotificationSound: mockPlaySound }));

import BoardChatSidebar from '../BoardChatSidebar';

const msg = (i: number, authorId = 'u-2') => ({
  id: `m-${i}`, boardId: 'b1', authorId, content: `message ${i}`,
  createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, i)).toISOString(),
  author: { id: authorId, name: 'Bob', email: 'bob@example.com', color: null, avatarUrl: null },
});
const range = (from: number, to: number, authorId?: string) =>
  Array.from({ length: to - from }, (_, k) => msg(from + k, authorId));
const chat = (messages: unknown[]) => ({ messages, isLoading: false, sendMessage: { mutate: vi.fn(), isPending: false } });

const currentUser = { id: 'u-1', name: 'Alice', color: '#000' };
const renderSidebar = (onNewMessage = vi.fn()) =>
  render(<BoardChatSidebar boardId="b1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

// 5.4 — the board chat now serves the NEWEST 50 messages. Past 50 a new message pushes
// the oldest out and the length stays 50: comparing lengths would never notify.
describe('BoardChatSidebar — new message notification', () => {
  it('notifies a message from someone else even when the window is already full', () => {
    const onNewMessage = vi.fn();
    mockUseKanbanChat.mockReturnValue(chat(range(0, 50)));
    const { rerender } = renderSidebar(onNewMessage);

    mockUseKanbanChat.mockReturnValue(chat(range(1, 51)));
    rerender(<BoardChatSidebar boardId="b1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

    expect(mockPlaySound).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
  });

  it('does not notify on the first load, nor for one\'s own message', () => {
    const onNewMessage = vi.fn();
    mockUseKanbanChat.mockReturnValue(chat(range(0, 3)));
    const { rerender } = renderSidebar(onNewMessage);
    expect(mockPlaySound).not.toHaveBeenCalled();

    mockUseKanbanChat.mockReturnValue(chat([...range(0, 3), msg(3, 'u-1')]));
    rerender(<BoardChatSidebar boardId="b1" isOpen={false} onClose={() => {}} currentUser={currentUser} onNewMessage={onNewMessage} />);

    expect(mockPlaySound).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
  });
});
