import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/api', () => ({ default: { post: vi.fn(), delete: vi.fn() } }));
vi.mock('../../../lib/db', () => ({ db: { notes: { get: vi.fn(), update: vi.fn() } } }));

import api from '../../../lib/api';
import { db } from '../../../lib/db';
import queryClient from '../../../lib/queryClient';
import { queryKeys } from '../../../lib/queryKeys';
import { uploadAttachment, deleteAttachment } from '../attachmentService';

const old = { id: 'a0', filename: 'old.pdf', size: 1 };
const fresh = { id: 'a1', filename: 'new.pdf', size: 2 };

describe('attachmentService query cache sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setQueryData(queryKeys.notes.detail('n1'), { id: 'n1', attachments: [old] });
    vi.mocked(db.notes.get).mockResolvedValue({ id: 'n1', attachments: [old] } as never);
  });

  it('upload updates the open note detail cache', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: fresh });
    await uploadAttachment('n1', new File(['x'], 'new.pdf'));
    const cached = queryClient.getQueryData(queryKeys.notes.detail('n1')) as { attachments: unknown[] };
    expect(cached.attachments).toEqual([old, fresh]);
    expect(db.notes.update).toHaveBeenCalled();
  });

  it('delete updates the open note detail cache', async () => {
    vi.mocked(api.delete).mockResolvedValue({});
    await deleteAttachment('n1', 'a0');
    const cached = queryClient.getQueryData(queryKeys.notes.detail('n1')) as { attachments: unknown[] };
    expect(cached.attachments).toEqual([]);
  });

  it('upload keeps attachments that exist only in the query cache', async () => {
    const cacheOnly = { id: 'a9', filename: 'cache.pdf', size: 3 };
    queryClient.setQueryData(queryKeys.notes.detail('n1'), { id: 'n1', attachments: [old, cacheOnly] });
    vi.mocked(api.post).mockResolvedValue({ data: fresh });
    await uploadAttachment('n1', new File(['x'], 'new.pdf'));
    const cached = queryClient.getQueryData(queryKeys.notes.detail('n1')) as { attachments: unknown[] };
    expect(cached.attachments).toEqual([old, cacheOnly, fresh]);
  });

  it('upload and delete update the cache when the note is not in Dexie', async () => {
    vi.mocked(db.notes.get).mockResolvedValue(undefined as never);
    vi.mocked(api.post).mockResolvedValue({ data: fresh });
    await uploadAttachment('n1', new File(['x'], 'new.pdf'));
    const get = () => queryClient.getQueryData(queryKeys.notes.detail('n1')) as { attachments: unknown[] };
    expect(get().attachments).toEqual([old, fresh]);
    vi.mocked(api.delete).mockResolvedValue({});
    await deleteAttachment('n1', 'a1');
    expect(get().attachments).toEqual([old]);
    expect(db.notes.update).not.toHaveBeenCalled();
  });
});
