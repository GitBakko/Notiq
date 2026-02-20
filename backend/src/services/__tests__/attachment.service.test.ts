import { vi, describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock path module to use posix-style for consistent tests
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    default: {
      ...actual,
      join: vi.fn((...args: string[]) => args.join('/')),
      extname: actual.extname,
      basename: actual.basename,
    },
    join: vi.fn((...args: string[]) => args.join('/')),
    extname: actual.extname,
    basename: actual.basename,
  };
});

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mocked-uuid'),
}));

// Mock crypto
vi.mock('crypto', () => ({
  default: {
    createHash: vi.fn().mockReturnValue({
      update: vi.fn(),
      digest: vi.fn().mockReturnValue('mocked-hash-abc123'),
    }),
  },
  createHash: vi.fn().mockReturnValue({
    update: vi.fn(),
    digest: vi.fn().mockReturnValue('mocked-hash-abc123'),
  }),
}));

import {
  getAttachments,
  getAttachmentHistory,
  deleteAttachment,
  getAttachmentPath,
} from '../attachment.service';
import fs from 'fs';

const prismaMock = prisma as any;

const NOTE_ID = 'note-1';
const ATTACHMENT_ID = 'att-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAttachments', () => {
  it('should return latest attachments for a note', async () => {
    const attachments = [
      { id: 'att-1', filename: 'photo.jpg', isLatest: true },
      { id: 'att-2', filename: 'doc.pdf', isLatest: true },
    ];
    prismaMock.attachment.findMany.mockResolvedValue(attachments);

    const result = await getAttachments(NOTE_ID);

    expect(prismaMock.attachment.findMany).toHaveBeenCalledWith({
      where: { noteId: NOTE_ID, isLatest: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual(attachments);
  });

  it('should return empty array when note has no attachments', async () => {
    prismaMock.attachment.findMany.mockResolvedValue([]);

    const result = await getAttachments(NOTE_ID);

    expect(result).toEqual([]);
  });
});

describe('getAttachmentHistory', () => {
  it('should return all versions of a file ordered by version desc', async () => {
    const history = [
      { id: 'att-2', filename: 'photo.jpg', version: 2, isLatest: true },
      { id: 'att-1', filename: 'photo.jpg', version: 1, isLatest: false },
    ];
    prismaMock.attachment.findMany.mockResolvedValue(history);

    const result = await getAttachmentHistory(NOTE_ID, 'photo.jpg');

    expect(prismaMock.attachment.findMany).toHaveBeenCalledWith({
      where: { noteId: NOTE_ID, filename: 'photo.jpg' },
      orderBy: { version: 'desc' },
    });
    expect(result).toEqual(history);
  });
});

describe('deleteAttachment', () => {
  it('should delete the file from disk and from database', async () => {
    const attachment = {
      id: ATTACHMENT_ID,
      url: '/uploads/some-uuid.jpg',
    };
    prismaMock.attachment.findUnique.mockResolvedValue(attachment);
    (fs.existsSync as any).mockReturnValue(true);
    prismaMock.attachment.delete.mockResolvedValue(attachment);

    const result = await deleteAttachment(ATTACHMENT_ID);

    expect(prismaMock.attachment.findUnique).toHaveBeenCalledWith({
      where: { id: ATTACHMENT_ID },
    });
    expect(fs.existsSync).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalled();
    expect(prismaMock.attachment.delete).toHaveBeenCalledWith({
      where: { id: ATTACHMENT_ID },
    });
    expect(result).toEqual(attachment);
  });

  it('should skip disk deletion when file does not exist on disk', async () => {
    const attachment = {
      id: ATTACHMENT_ID,
      url: '/uploads/missing-file.jpg',
    };
    prismaMock.attachment.findUnique.mockResolvedValue(attachment);
    (fs.existsSync as any).mockReturnValue(false);
    prismaMock.attachment.delete.mockResolvedValue(attachment);

    await deleteAttachment(ATTACHMENT_ID);

    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(prismaMock.attachment.delete).toHaveBeenCalledWith({
      where: { id: ATTACHMENT_ID },
    });
  });

  it('should return undefined when attachment is not found in database', async () => {
    prismaMock.attachment.findUnique.mockResolvedValue(null);

    const result = await deleteAttachment('non-existent');

    expect(result).toBeUndefined();
    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(prismaMock.attachment.delete).not.toHaveBeenCalled();
  });
});

describe('getAttachmentPath', () => {
  it('should return the full file path for an upload URL', () => {
    const result = getAttachmentPath('/uploads/abc-123.pdf');

    // path.join is mocked to concatenate with '/'
    expect(result).toContain('abc-123.pdf');
  });
});
