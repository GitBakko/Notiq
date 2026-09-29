import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../../../lib/api';
import { getMessages } from '../chatService';

const mockApi = api as unknown as { get: ReturnType<typeof vi.fn> };
const URL = '/chat-direct/conversations/conv-1/messages';

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: [] });
});

describe('chatService.getMessages', () => {
  it('sends only page and limit for the first page', async () => {
    await getMessages('conv-1', 1);

    expect(mockApi.get).toHaveBeenCalledWith(URL, { params: { page: 1, limit: 50 } });
  });

  it('sends the before cursor when given', async () => {
    // Scrollback by page offset shifts by N whenever N new messages arrive in the
    // meantime, so older pages skip or duplicate rows. The backend already supports
    // a createdAt cursor (routes/chat-direct.ts `before`): the client must send it.
    await getMessages('conv-1', 1, 50, 'msg-oldest');

    expect(mockApi.get).toHaveBeenCalledWith(URL, {
      params: { page: 1, limit: 50, before: 'msg-oldest' },
    });
  });

  it('does not send an undefined before key', async () => {
    await getMessages('conv-1', 1, 50, undefined);

    const params = mockApi.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('before');
  });
});
