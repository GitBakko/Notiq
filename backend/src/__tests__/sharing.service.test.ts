import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../services/audit.service', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/email.service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
}));

import prisma from '../plugins/prisma';
import {
  shareNote,
  revokeNoteShare,
  shareNotebook,
  revokeNotebookShare,
  respondToShareById,
  getAcceptedSharedNotes,
  getSentShares,
} from '../services/sharing.service';
import * as notificationService from '../services/notification.service';

const prismaMock = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sharing.service — shareNote', () => {
  it('should share a note with another user', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({ id: 'note-1', userId: 'owner-1', title: 'My Note' } as any);
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: 'target-1', email: 'target@test.com' } as any) // target user
      .mockResolvedValueOnce({ id: 'owner-1', name: 'Owner', email: 'owner@test.com' } as any); // owner for email
    prismaMock.sharedNote.upsert.mockResolvedValueOnce({
      id: 'share-1',
      noteId: 'note-1',
      userId: 'target-1',
      permission: 'READ',
      status: 'PENDING',
      user: { id: 'target-1', name: 'Target', email: 'target@test.com' },
    } as any);

    const result = await shareNote('owner-1', 'note-1', 'target@test.com', 'READ');

    expect(result.id).toBe('share-1');
    expect(result.status).toBe('PENDING');
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      'target-1',
      'SHARE_NOTE',
      expect.any(String),
      expect.stringContaining('Owner'),
      expect.any(Object)
    );
  });

  it('should throw if note not found or not owned', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce(null);

    await expect(shareNote('user-1', 'note-1', 'target@test.com', 'READ'))
      .rejects.toThrow('Note not found or access denied');
  });

  it('should throw if note belongs to another user', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({ id: 'note-1', userId: 'real-owner' } as any);

    await expect(shareNote('not-owner', 'note-1', 'target@test.com', 'READ'))
      .rejects.toThrow('Note not found or access denied');
  });

  it('should throw if target user not found', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({ id: 'note-1', userId: 'owner-1' } as any);
    prismaMock.user.findUnique.mockResolvedValueOnce(null);

    await expect(shareNote('owner-1', 'note-1', 'ghost@test.com', 'READ'))
      .rejects.toThrow('User not found');
  });

  it('should throw if trying to share with yourself', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({ id: 'note-1', userId: 'owner-1' } as any);
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'owner-1', email: 'owner@test.com' } as any);

    await expect(shareNote('owner-1', 'note-1', 'owner@test.com', 'READ'))
      .rejects.toThrow('Cannot share with yourself');
  });
});

describe('sharing.service — revokeNoteShare', () => {
  it('should revoke a note share', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({ id: 'note-1', userId: 'owner-1' } as any);
    prismaMock.sharedNote.delete.mockResolvedValueOnce({ id: 'share-1' } as any);

    const result = await revokeNoteShare('owner-1', 'note-1', 'target-1');
    expect(result.id).toBe('share-1');
  });

  it('should throw if not the owner', async () => {
    prismaMock.note.findUnique.mockResolvedValueOnce({ id: 'note-1', userId: 'real-owner' } as any);

    await expect(revokeNoteShare('not-owner', 'note-1', 'target-1'))
      .rejects.toThrow('Note not found or access denied');
  });
});

describe('sharing.service — shareNotebook', () => {
  it('should share a notebook with another user', async () => {
    prismaMock.notebook.findUnique.mockResolvedValueOnce({ id: 'nb-1', userId: 'owner-1', name: 'My Notebook' } as any);
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: 'target-1', email: 'target@test.com' } as any) // target
      .mockResolvedValueOnce({ id: 'owner-1', name: 'Owner', email: 'owner@test.com' } as any); // owner for email
    prismaMock.sharedNotebook.upsert.mockResolvedValueOnce({
      id: 'share-nb-1',
      notebookId: 'nb-1',
      userId: 'target-1',
      permission: 'WRITE',
      status: 'PENDING',
      user: { id: 'target-1', name: 'Target', email: 'target@test.com' },
    } as any);

    const result = await shareNotebook('owner-1', 'nb-1', 'target@test.com', 'WRITE');
    expect(result.id).toBe('share-nb-1');
  });

  it('should throw if notebook not owned', async () => {
    prismaMock.notebook.findUnique.mockResolvedValueOnce(null);

    await expect(shareNotebook('user-1', 'nb-1', 'target@test.com', 'READ'))
      .rejects.toThrow('Notebook not found or access denied');
  });
});

describe('sharing.service — respondToShareById', () => {
  it('should accept a note share', async () => {
    prismaMock.sharedNote.findUnique.mockResolvedValueOnce({ id: 'share-1' } as any);
    prismaMock.sharedNote.update.mockResolvedValueOnce({
      id: 'share-1',
      status: 'ACCEPTED',
      note: { title: 'Test Note', user: { id: 'owner-1', email: 'owner@test.com', name: 'Owner' } },
      user: { id: 'user-1', name: 'Responder', email: 'responder@test.com' },
    } as any);

    const result = await respondToShareById('user-1', 'note-1', 'NOTE', 'accept');
    expect(result.success).toBe(true);
    expect(result.status).toBe('ACCEPTED');
  });

  it('should decline a note share', async () => {
    prismaMock.sharedNote.findUnique.mockResolvedValueOnce({ id: 'share-1' } as any);
    prismaMock.sharedNote.update.mockResolvedValueOnce({
      id: 'share-1',
      status: 'DECLINED',
      note: { title: 'Test Note', user: { id: 'owner-1', email: 'owner@test.com', name: 'Owner' } },
      user: { id: 'user-1', name: 'Responder', email: 'responder@test.com' },
    } as any);

    const result = await respondToShareById('user-1', 'note-1', 'NOTE', 'decline');
    expect(result.success).toBe(true);
    expect(result.status).toBe('DECLINED');
  });

  it('should throw if invitation not found', async () => {
    prismaMock.sharedNote.findUnique.mockResolvedValueOnce(null);

    await expect(respondToShareById('user-1', 'note-1', 'NOTE', 'accept'))
      .rejects.toThrow('Invitation not found');
  });

  it('should throw for notebook invitation not found', async () => {
    prismaMock.sharedNotebook.findUnique.mockResolvedValueOnce(null);

    await expect(respondToShareById('user-1', 'nb-1', 'NOTEBOOK', 'accept'))
      .rejects.toThrow('Invitation not found');
  });
});

describe('sharing.service — getAcceptedSharedNotes', () => {
  it('should return accepted shared notes with permission', async () => {
    prismaMock.sharedNote.findMany.mockResolvedValueOnce([
      {
        permission: 'READ',
        note: { id: 'note-1', title: 'Shared Note', userId: 'owner-1' },
      },
    ] as any);

    const result = await getAcceptedSharedNotes('user-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('_sharedPermission', 'READ');
    expect(result[0].id).toBe('note-1');
  });
});
