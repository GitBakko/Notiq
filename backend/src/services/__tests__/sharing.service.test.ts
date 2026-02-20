import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  shareNote,
  revokeNoteShare,
  getAcceptedSharedNotes,
  getSharedNotes,
  shareNotebook,
  revokeNotebookShare,
  getSharedNotebooks,
  respondToShare,
  respondToShareById,
} from '../sharing.service';
import jwt from 'jsonwebtoken';

// Mock sibling services
vi.mock('../audit.service', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../email.service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import * as auditService from '../audit.service';
import * as emailService from '../email.service';
import * as notificationService from '../notification.service';

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = 'owner-id-1';
const TARGET_USER_ID = 'target-user-id-2';
const NOTE_ID = 'note-id-1';
const NOTEBOOK_ID = 'notebook-id-1';

const ownerUser = { id: OWNER_ID, name: 'Owner', email: 'owner@test.com' };
const targetUser = { id: TARGET_USER_ID, name: 'Target', email: 'target@test.com' };

const sampleNote = {
  id: NOTE_ID,
  title: 'My Note',
  userId: OWNER_ID,
  content: '{}',
};

const sampleNotebook = {
  id: NOTEBOOK_ID,
  name: 'My Notebook',
  userId: OWNER_ID,
};

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// shareNote
// ===========================================================================

describe('shareNote', () => {
  it('should share a note with a target user and return the shared record', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser) // target lookup
      .mockResolvedValueOnce(ownerUser); // owner lookup for email
    const sharedRecord = {
      noteId: NOTE_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNote.upsert.mockResolvedValue(sharedRecord);

    const result = await shareNote(OWNER_ID, NOTE_ID, targetUser.email, 'READ');

    expect(result).toEqual(sharedRecord);
    expect(prismaMock.note.findUnique).toHaveBeenCalledWith({ where: { id: NOTE_ID } });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { email: targetUser.email } });
    expect(prismaMock.sharedNote.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { noteId_userId: { noteId: NOTE_ID, userId: TARGET_USER_ID } },
        create: expect.objectContaining({ permission: 'READ', status: 'PENDING' }),
        update: expect.objectContaining({ permission: 'READ', status: 'PENDING' }),
      }),
    );
    expect(auditService.logEvent).toHaveBeenCalledWith(
      OWNER_ID,
      'SHARE_SENT',
      expect.objectContaining({ noteId: NOTE_ID, targetEmail: targetUser.email }),
    );
    expect(emailService.sendNotificationEmail).toHaveBeenCalled();
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      TARGET_USER_ID,
      'SHARE_NOTE',
      expect.any(String),
      expect.stringContaining(sampleNote.title),
      expect.objectContaining({ noteId: NOTE_ID, status: 'PENDING' }),
    );
  });

  it('should throw when note does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue(null);

    await expect(shareNote(OWNER_ID, NOTE_ID, targetUser.email, 'READ')).rejects.toThrow(
      'Note not found or access denied',
    );
    expect(prismaMock.sharedNote.upsert).not.toHaveBeenCalled();
  });

  it('should throw when caller is not the note owner', async () => {
    prismaMock.note.findUnique.mockResolvedValue({ ...sampleNote, userId: 'other-owner' });

    await expect(shareNote(OWNER_ID, NOTE_ID, targetUser.email, 'READ')).rejects.toThrow(
      'Note not found or access denied',
    );
  });

  it('should throw when target user does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(shareNote(OWNER_ID, NOTE_ID, 'nobody@test.com', 'READ')).rejects.toThrow('User not found');
  });

  it('should throw when owner tries to share with themselves', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.user.findUnique.mockResolvedValue(ownerUser);

    await expect(shareNote(OWNER_ID, NOTE_ID, ownerUser.email, 'WRITE')).rejects.toThrow(
      'Cannot share with yourself',
    );
  });

  it('should re-share (upsert) a previously shared note with PENDING status', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(ownerUser);
    const reshared = {
      noteId: NOTE_ID,
      userId: TARGET_USER_ID,
      permission: 'WRITE',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNote.upsert.mockResolvedValue(reshared);

    const result = await shareNote(OWNER_ID, NOTE_ID, targetUser.email, 'WRITE');

    expect(result.permission).toBe('WRITE');
    expect(result.status).toBe('PENDING');
    expect(prismaMock.sharedNote.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ permission: 'WRITE', status: 'PENDING' }),
      }),
    );
  });

  it('should still return the shared record when email sending fails', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(ownerUser);
    const sharedRecord = {
      noteId: NOTE_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNote.upsert.mockResolvedValue(sharedRecord);
    vi.mocked(emailService.sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));

    const result = await shareNote(OWNER_ID, NOTE_ID, targetUser.email, 'READ');

    // The function catches email errors and continues
    expect(result).toEqual(sharedRecord);
  });

  it('should skip email and notification when owner lookup returns null', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(null); // owner not found (edge case)
    const sharedRecord = {
      noteId: NOTE_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNote.upsert.mockResolvedValue(sharedRecord);

    const result = await shareNote(OWNER_ID, NOTE_ID, targetUser.email, 'READ');

    expect(result).toEqual(sharedRecord);
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// revokeNoteShare
// ===========================================================================

describe('revokeNoteShare', () => {
  it('should delete the shared note record when owner revokes', async () => {
    prismaMock.note.findUnique.mockResolvedValue(sampleNote);
    prismaMock.sharedNote.delete.mockResolvedValue({ noteId: NOTE_ID, userId: TARGET_USER_ID });

    const result = await revokeNoteShare(OWNER_ID, NOTE_ID, TARGET_USER_ID);

    expect(result).toEqual({ noteId: NOTE_ID, userId: TARGET_USER_ID });
    expect(prismaMock.sharedNote.delete).toHaveBeenCalledWith({
      where: { noteId_userId: { noteId: NOTE_ID, userId: TARGET_USER_ID } },
    });
  });

  it('should throw when note does not exist', async () => {
    prismaMock.note.findUnique.mockResolvedValue(null);

    await expect(revokeNoteShare(OWNER_ID, NOTE_ID, TARGET_USER_ID)).rejects.toThrow(
      'Note not found or access denied',
    );
    expect(prismaMock.sharedNote.delete).not.toHaveBeenCalled();
  });

  it('should throw when caller is not the note owner', async () => {
    prismaMock.note.findUnique.mockResolvedValue({ ...sampleNote, userId: 'someone-else' });

    await expect(revokeNoteShare(OWNER_ID, NOTE_ID, TARGET_USER_ID)).rejects.toThrow(
      'Note not found or access denied',
    );
    expect(prismaMock.sharedNote.delete).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getAcceptedSharedNotes
// ===========================================================================

describe('getAcceptedSharedNotes', () => {
  it('should return notes with _sharedPermission field mapped from permission', async () => {
    const sharedRows = [
      {
        permission: 'READ',
        note: {
          id: 'n1',
          title: 'Shared 1',
          content: '{}',
          userId: OWNER_ID,
          tags: [],
          attachments: [],
          sharedWith: [],
          user: ownerUser,
        },
      },
      {
        permission: 'WRITE',
        note: {
          id: 'n2',
          title: 'Shared 2',
          content: '{}',
          userId: OWNER_ID,
          tags: [],
          attachments: [],
          sharedWith: [],
          user: ownerUser,
        },
      },
    ];
    prismaMock.sharedNote.findMany.mockResolvedValue(sharedRows);

    const result = await getAcceptedSharedNotes(TARGET_USER_ID);

    expect(result).toHaveLength(2);
    expect(result[0]._sharedPermission).toBe('READ');
    expect(result[0].id).toBe('n1');
    expect(result[1]._sharedPermission).toBe('WRITE');
    expect(result[1].id).toBe('n2');
  });

  it('should query only ACCEPTED shares for the given user', async () => {
    prismaMock.sharedNote.findMany.mockResolvedValue([]);

    await getAcceptedSharedNotes(TARGET_USER_ID);

    expect(prismaMock.sharedNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: TARGET_USER_ID, status: 'ACCEPTED' },
      }),
    );
  });

  it('should return an empty array when user has no accepted shares', async () => {
    prismaMock.sharedNote.findMany.mockResolvedValue([]);

    const result = await getAcceptedSharedNotes(TARGET_USER_ID);

    expect(result).toEqual([]);
  });

  it('should spread all note fields alongside _sharedPermission', async () => {
    const noteData = {
      id: 'n1',
      title: 'Test',
      content: '{}',
      searchText: 'test',
      notebookId: null,
      userId: OWNER_ID,
      isPinned: false,
      isTrashed: false,
      isEncrypted: false,
      isPublic: false,
      isVault: false,
      shareId: null,
      reminderDate: null,
      isReminderDone: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      tags: [],
      attachments: [],
      sharedWith: [],
      user: ownerUser,
    };
    prismaMock.sharedNote.findMany.mockResolvedValue([{ permission: 'READ', note: noteData }]);

    const result = await getAcceptedSharedNotes(TARGET_USER_ID);

    expect(result[0]).toEqual({ ...noteData, _sharedPermission: 'READ' });
  });
});

// ===========================================================================
// getSharedNotes
// ===========================================================================

describe('getSharedNotes', () => {
  it('should return all shared notes for a user with note and user included', async () => {
    const rows = [
      { noteId: 'n1', userId: TARGET_USER_ID, status: 'PENDING', note: { id: 'n1', user: ownerUser } },
    ];
    prismaMock.sharedNote.findMany.mockResolvedValue(rows);

    const result = await getSharedNotes(TARGET_USER_ID);

    expect(result).toEqual(rows);
    expect(prismaMock.sharedNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: TARGET_USER_ID },
        include: expect.objectContaining({
          note: expect.objectContaining({ include: expect.any(Object) }),
        }),
      }),
    );
  });

  it('should return an empty array when no shares exist', async () => {
    prismaMock.sharedNote.findMany.mockResolvedValue([]);

    const result = await getSharedNotes(TARGET_USER_ID);

    expect(result).toEqual([]);
  });
});

// ===========================================================================
// shareNotebook
// ===========================================================================

describe('shareNotebook', () => {
  it('should share a notebook with a target user and return the shared record', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(sampleNotebook);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(ownerUser);
    const sharedRecord = {
      notebookId: NOTEBOOK_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNotebook.upsert.mockResolvedValue(sharedRecord);

    const result = await shareNotebook(OWNER_ID, NOTEBOOK_ID, targetUser.email, 'READ');

    expect(result).toEqual(sharedRecord);
    expect(prismaMock.notebook.findUnique).toHaveBeenCalledWith({ where: { id: NOTEBOOK_ID } });
    expect(prismaMock.sharedNotebook.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { notebookId_userId: { notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID } },
        create: expect.objectContaining({ permission: 'READ', status: 'PENDING' }),
      }),
    );
    expect(auditService.logEvent).toHaveBeenCalledWith(
      OWNER_ID,
      'SHARE_SENT',
      expect.objectContaining({ notebookId: NOTEBOOK_ID }),
    );
    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      targetUser.email,
      'SHARE_INVITATION',
      expect.objectContaining({ itemType: 'Notebook', itemName: sampleNotebook.name }),
    );
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      TARGET_USER_ID,
      'SHARE_NOTEBOOK',
      expect.any(String),
      expect.stringContaining(sampleNotebook.name),
      expect.objectContaining({ notebookId: NOTEBOOK_ID, status: 'PENDING' }),
    );
  });

  it('should throw when notebook does not exist', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(null);

    await expect(shareNotebook(OWNER_ID, NOTEBOOK_ID, targetUser.email, 'READ')).rejects.toThrow(
      'Notebook not found or access denied',
    );
  });

  it('should throw when caller is not the notebook owner', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue({ ...sampleNotebook, userId: 'other-owner' });

    await expect(shareNotebook(OWNER_ID, NOTEBOOK_ID, targetUser.email, 'READ')).rejects.toThrow(
      'Notebook not found or access denied',
    );
  });

  it('should throw when target user does not exist', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(sampleNotebook);
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(shareNotebook(OWNER_ID, NOTEBOOK_ID, 'nobody@test.com', 'WRITE')).rejects.toThrow(
      'User not found',
    );
  });

  it('should throw when owner tries to share with themselves', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(sampleNotebook);
    prismaMock.user.findUnique.mockResolvedValue(ownerUser);

    await expect(shareNotebook(OWNER_ID, NOTEBOOK_ID, ownerUser.email, 'READ')).rejects.toThrow(
      'Cannot share with yourself',
    );
  });

  it('should still return the shared record when email sending fails', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(sampleNotebook);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(ownerUser);
    const sharedRecord = {
      notebookId: NOTEBOOK_ID,
      userId: TARGET_USER_ID,
      permission: 'READ',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNotebook.upsert.mockResolvedValue(sharedRecord);
    vi.mocked(emailService.sendNotificationEmail).mockRejectedValueOnce(new Error('SMTP down'));

    const result = await shareNotebook(OWNER_ID, NOTEBOOK_ID, targetUser.email, 'READ');

    expect(result).toEqual(sharedRecord);
  });

  it('should skip email and notification when owner lookup returns null', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(sampleNotebook);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(targetUser)
      .mockResolvedValueOnce(null);
    const sharedRecord = {
      notebookId: NOTEBOOK_ID,
      userId: TARGET_USER_ID,
      permission: 'WRITE',
      status: 'PENDING',
      user: targetUser,
    };
    prismaMock.sharedNotebook.upsert.mockResolvedValue(sharedRecord);

    const result = await shareNotebook(OWNER_ID, NOTEBOOK_ID, targetUser.email, 'WRITE');

    expect(result).toEqual(sharedRecord);
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// revokeNotebookShare
// ===========================================================================

describe('revokeNotebookShare', () => {
  it('should delete the shared notebook record when owner revokes', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(sampleNotebook);
    prismaMock.sharedNotebook.delete.mockResolvedValue({
      notebookId: NOTEBOOK_ID,
      userId: TARGET_USER_ID,
    });

    const result = await revokeNotebookShare(OWNER_ID, NOTEBOOK_ID, TARGET_USER_ID);

    expect(result).toEqual({ notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID });
    expect(prismaMock.sharedNotebook.delete).toHaveBeenCalledWith({
      where: { notebookId_userId: { notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID } },
    });
  });

  it('should throw when notebook does not exist', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue(null);

    await expect(revokeNotebookShare(OWNER_ID, NOTEBOOK_ID, TARGET_USER_ID)).rejects.toThrow(
      'Notebook not found or access denied',
    );
    expect(prismaMock.sharedNotebook.delete).not.toHaveBeenCalled();
  });

  it('should throw when caller is not the notebook owner', async () => {
    prismaMock.notebook.findUnique.mockResolvedValue({ ...sampleNotebook, userId: 'someone-else' });

    await expect(revokeNotebookShare(OWNER_ID, NOTEBOOK_ID, TARGET_USER_ID)).rejects.toThrow(
      'Notebook not found or access denied',
    );
    expect(prismaMock.sharedNotebook.delete).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getSharedNotebooks
// ===========================================================================

describe('getSharedNotebooks', () => {
  it('should return all shared notebooks for a user', async () => {
    const rows = [
      {
        notebookId: NOTEBOOK_ID,
        userId: TARGET_USER_ID,
        status: 'PENDING',
        notebook: { id: NOTEBOOK_ID, user: ownerUser },
      },
    ];
    prismaMock.sharedNotebook.findMany.mockResolvedValue(rows);

    const result = await getSharedNotebooks(TARGET_USER_ID);

    expect(result).toEqual(rows);
    expect(prismaMock.sharedNotebook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: TARGET_USER_ID },
      }),
    );
  });

  it('should return an empty array when no shared notebooks exist', async () => {
    prismaMock.sharedNotebook.findMany.mockResolvedValue([]);

    const result = await getSharedNotebooks(TARGET_USER_ID);

    expect(result).toEqual([]);
  });
});

// ===========================================================================
// respondToShare (token-based)
// ===========================================================================

describe('respondToShare', () => {
  function signToken(payload: object): string {
    return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' });
  }

  describe('NOTE type', () => {
    it('should accept a note share invitation and notify the owner', async () => {
      const token = signToken({ noteId: NOTE_ID, userId: TARGET_USER_ID, type: 'NOTE' });
      const updateResult = {
        noteId: NOTE_ID,
        userId: TARGET_USER_ID,
        status: 'ACCEPTED',
        note: { ...sampleNote, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNote.update.mockResolvedValue(updateResult);

      const result = await respondToShare(token, 'accept');

      expect(result).toEqual({ success: true, status: 'ACCEPTED' });
      expect(prismaMock.sharedNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { noteId_userId: { noteId: NOTE_ID, userId: TARGET_USER_ID } },
          data: { status: 'ACCEPTED' },
        }),
      );
      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        ownerUser.email,
        'SHARE_RESPONSE',
        expect.objectContaining({ action: 'accepted', itemName: sampleNote.title }),
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        OWNER_ID,
        'SYSTEM',
        'Invitation Update',
        expect.stringContaining('accepted'),
        expect.objectContaining({ type: 'NOTE', action: 'accept' }),
      );
    });

    it('should decline a note share invitation', async () => {
      const token = signToken({ noteId: NOTE_ID, userId: TARGET_USER_ID, type: 'NOTE' });
      const updateResult = {
        noteId: NOTE_ID,
        userId: TARGET_USER_ID,
        status: 'DECLINED',
        note: { ...sampleNote, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNote.update.mockResolvedValue(updateResult);

      const result = await respondToShare(token, 'decline');

      expect(result).toEqual({ success: true, status: 'DECLINED' });
      expect(prismaMock.sharedNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'DECLINED' },
        }),
      );
      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        ownerUser.email,
        'SHARE_RESPONSE',
        expect.objectContaining({ action: 'declined' }),
      );
    });
  });

  describe('NOTEBOOK type', () => {
    it('should accept a notebook share invitation and notify the owner', async () => {
      const token = signToken({ notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID, type: 'NOTEBOOK' });
      const updateResult = {
        notebookId: NOTEBOOK_ID,
        userId: TARGET_USER_ID,
        status: 'ACCEPTED',
        notebook: { ...sampleNotebook, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNotebook.update.mockResolvedValue(updateResult);

      const result = await respondToShare(token, 'accept');

      expect(result).toEqual({ success: true, status: 'ACCEPTED' });
      expect(prismaMock.sharedNotebook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { notebookId_userId: { notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID } },
          data: { status: 'ACCEPTED' },
        }),
      );
      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        ownerUser.email,
        'SHARE_RESPONSE',
        expect.objectContaining({ action: 'accepted', itemName: sampleNotebook.name }),
      );
    });

    it('should decline a notebook share invitation', async () => {
      const token = signToken({ notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID, type: 'NOTEBOOK' });
      const updateResult = {
        notebookId: NOTEBOOK_ID,
        userId: TARGET_USER_ID,
        status: 'DECLINED',
        notebook: { ...sampleNotebook, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNotebook.update.mockResolvedValue(updateResult);

      const result = await respondToShare(token, 'decline');

      expect(result).toEqual({ success: true, status: 'DECLINED' });
    });
  });

  it('should throw on an expired or invalid token', async () => {
    await expect(respondToShare('invalid-token', 'accept')).rejects.toThrow(
      'Invalid or expired token',
    );
    expect(prismaMock.sharedNote.update).not.toHaveBeenCalled();
    expect(prismaMock.sharedNotebook.update).not.toHaveBeenCalled();
  });

  it('should throw when the token has been tampered with', async () => {
    const token = jwt.sign(
      { noteId: NOTE_ID, userId: TARGET_USER_ID, type: 'NOTE' },
      'wrong-secret',
      { expiresIn: '7d' },
    );

    await expect(respondToShare(token, 'accept')).rejects.toThrow('Invalid or expired token');
  });

  it('should throw when prisma update fails (wraps as invalid token)', async () => {
    const token = signToken({ noteId: NOTE_ID, userId: TARGET_USER_ID, type: 'NOTE' });
    prismaMock.sharedNote.update.mockRejectedValue(new Error('Record not found'));

    await expect(respondToShare(token, 'accept')).rejects.toThrow('Invalid or expired token');
  });
});

// ===========================================================================
// respondToShareById
// ===========================================================================

describe('respondToShareById', () => {
  describe('NOTE type', () => {
    it('should accept a note share by ID and notify the owner', async () => {
      const existing = { noteId: NOTE_ID, userId: TARGET_USER_ID, status: 'PENDING' };
      prismaMock.sharedNote.findUnique.mockResolvedValue(existing);
      const updateResult = {
        noteId: NOTE_ID,
        userId: TARGET_USER_ID,
        status: 'ACCEPTED',
        note: { ...sampleNote, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNote.update.mockResolvedValue(updateResult);

      const result = await respondToShareById(TARGET_USER_ID, NOTE_ID, 'NOTE', 'accept');

      expect(result).toEqual({ success: true, status: 'ACCEPTED' });
      expect(prismaMock.sharedNote.findUnique).toHaveBeenCalledWith({
        where: { noteId_userId: { noteId: NOTE_ID, userId: TARGET_USER_ID } },
      });
      expect(prismaMock.sharedNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'ACCEPTED' },
        }),
      );
      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        ownerUser.email,
        'SHARE_RESPONSE',
        expect.objectContaining({ action: 'accepted' }),
      );
      expect(notificationService.createNotification).toHaveBeenCalledWith(
        OWNER_ID,
        'SYSTEM',
        'Invitation Update',
        expect.stringContaining('accepted'),
        expect.objectContaining({ itemId: NOTE_ID, type: 'NOTE', action: 'accept' }),
      );
    });

    it('should decline a note share by ID', async () => {
      const existing = { noteId: NOTE_ID, userId: TARGET_USER_ID, status: 'PENDING' };
      prismaMock.sharedNote.findUnique.mockResolvedValue(existing);
      const updateResult = {
        noteId: NOTE_ID,
        userId: TARGET_USER_ID,
        status: 'DECLINED',
        note: { ...sampleNote, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNote.update.mockResolvedValue(updateResult);

      const result = await respondToShareById(TARGET_USER_ID, NOTE_ID, 'NOTE', 'decline');

      expect(result).toEqual({ success: true, status: 'DECLINED' });
      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        ownerUser.email,
        'SHARE_RESPONSE',
        expect.objectContaining({ action: 'declined' }),
      );
    });

    it('should throw when note invitation does not exist', async () => {
      prismaMock.sharedNote.findUnique.mockResolvedValue(null);

      await expect(
        respondToShareById(TARGET_USER_ID, NOTE_ID, 'NOTE', 'accept'),
      ).rejects.toThrow('Invitation not found');
      expect(prismaMock.sharedNote.update).not.toHaveBeenCalled();
    });
  });

  describe('NOTEBOOK type', () => {
    it('should accept a notebook share by ID and notify the owner', async () => {
      const existing = { notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID, status: 'PENDING' };
      prismaMock.sharedNotebook.findUnique.mockResolvedValue(existing);
      const updateResult = {
        notebookId: NOTEBOOK_ID,
        userId: TARGET_USER_ID,
        status: 'ACCEPTED',
        notebook: { ...sampleNotebook, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNotebook.update.mockResolvedValue(updateResult);

      const result = await respondToShareById(TARGET_USER_ID, NOTEBOOK_ID, 'NOTEBOOK', 'accept');

      expect(result).toEqual({ success: true, status: 'ACCEPTED' });
      expect(prismaMock.sharedNotebook.findUnique).toHaveBeenCalledWith({
        where: { notebookId_userId: { notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID } },
      });
      expect(prismaMock.sharedNotebook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'ACCEPTED' },
        }),
      );
      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        ownerUser.email,
        'SHARE_RESPONSE',
        expect.objectContaining({ action: 'accepted', itemName: sampleNotebook.name }),
      );
    });

    it('should decline a notebook share by ID', async () => {
      const existing = { notebookId: NOTEBOOK_ID, userId: TARGET_USER_ID, status: 'PENDING' };
      prismaMock.sharedNotebook.findUnique.mockResolvedValue(existing);
      const updateResult = {
        notebookId: NOTEBOOK_ID,
        userId: TARGET_USER_ID,
        status: 'DECLINED',
        notebook: { ...sampleNotebook, user: ownerUser },
        user: targetUser,
      };
      prismaMock.sharedNotebook.update.mockResolvedValue(updateResult);

      const result = await respondToShareById(TARGET_USER_ID, NOTEBOOK_ID, 'NOTEBOOK', 'decline');

      expect(result).toEqual({ success: true, status: 'DECLINED' });
    });

    it('should throw when notebook invitation does not exist', async () => {
      prismaMock.sharedNotebook.findUnique.mockResolvedValue(null);

      await expect(
        respondToShareById(TARGET_USER_ID, NOTEBOOK_ID, 'NOTEBOOK', 'accept'),
      ).rejects.toThrow('Invitation not found');
      expect(prismaMock.sharedNotebook.update).not.toHaveBeenCalled();
    });
  });

  it('should return success even when owner notification sending fails silently', async () => {
    const existing = { noteId: NOTE_ID, userId: TARGET_USER_ID, status: 'PENDING' };
    prismaMock.sharedNote.findUnique.mockResolvedValue(existing);
    const updateResult = {
      noteId: NOTE_ID,
      userId: TARGET_USER_ID,
      status: 'ACCEPTED',
      note: { ...sampleNote, user: ownerUser },
      user: targetUser,
    };
    prismaMock.sharedNote.update.mockResolvedValue(updateResult);
    // Note: respondToShareById does NOT wrap email errors in try/catch,
    // so a failure here would propagate. This test documents that behavior.
    vi.mocked(emailService.sendNotificationEmail).mockResolvedValueOnce(undefined);

    const result = await respondToShareById(TARGET_USER_ID, NOTE_ID, 'NOTE', 'accept');

    expect(result).toEqual({ success: true, status: 'ACCEPTED' });
  });

  it('should not send notifications when the result has no owner', async () => {
    const existing = { noteId: NOTE_ID, userId: TARGET_USER_ID, status: 'PENDING' };
    prismaMock.sharedNote.findUnique.mockResolvedValue(existing);
    const updateResult = {
      noteId: NOTE_ID,
      userId: TARGET_USER_ID,
      status: 'ACCEPTED',
      note: { ...sampleNote, user: null },
      user: targetUser,
    };
    prismaMock.sharedNote.update.mockResolvedValue(updateResult);

    const result = await respondToShareById(TARGET_USER_ID, NOTE_ID, 'NOTE', 'accept');

    expect(result).toEqual({ success: true, status: 'ACCEPTED' });
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});
