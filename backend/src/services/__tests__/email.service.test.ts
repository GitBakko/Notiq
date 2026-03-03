import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting, so mockSendMail is available in the factory
const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: mockSendMail,
    }),
  },
}));

import prisma from '../../plugins/prisma';
import { sendEmail, sendNotificationEmail } from '../email.service';

const prismaMock = prisma as any;
const FRONTEND_URL = process.env.FRONTEND_URL; // 'http://localhost:5173' from setup.ts

// The email service reads SMTP env vars at module load time (setup.ts doesn't set them),
// so smtpUser is undefined and smtpFromName defaults to 'Notiq App'.
const EXPECTED_FROM = '"Notiq App" <undefined>';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------
describe('sendEmail', () => {
  it('calls sendMail with correct from, to, subject, and html', async () => {
    const result = await sendEmail('user@example.com', 'Test Subject', '<p>Hello</p>');

    expect(mockSendMail).toHaveBeenCalledWith({
      from: EXPECTED_FROM,
      to: 'user@example.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
    });
    expect(result).toEqual({ messageId: 'test-msg-id' });
  });

  it('throws when sendMail fails', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));

    await expect(sendEmail('user@example.com', 'Fail', '<p>fail</p>'))
      .rejects.toThrow('SMTP connection refused');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — User email preference
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — email preference check', () => {
  it('skips sending when user has email notifications disabled (non-transactional)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: false });

    await sendNotificationEmail('user@example.com', 'SHARE_NOTE', {
      sharerName: 'Alice',
      noteTitle: 'Test Note',
      noteId: 'note-1',
    });

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('sends email when user has email notifications enabled (non-transactional)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });

    await sendNotificationEmail('user@example.com', 'SHARE_NOTE', {
      sharerName: 'Alice',
      noteTitle: 'Test Note',
      noteId: 'note-1',
    });

    expect(mockSendMail).toHaveBeenCalled();
  });

  it('sends email when user is not found (fail-open)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await sendNotificationEmail('unknown@example.com', 'SHARE_NOTE', {
      sharerName: 'Alice',
      noteTitle: 'Test Note',
      noteId: 'note-1',
    });

    expect(mockSendMail).toHaveBeenCalled();
  });

  it('sends email when prisma lookup fails (fail-open)', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('DB error'));

    await sendNotificationEmail('user@example.com', 'SHARE_NOTE', {
      sharerName: 'Alice',
      noteTitle: 'Test Note',
      noteId: 'note-1',
    });

    expect(mockSendMail).toHaveBeenCalled();
  });

  it('bypasses preference check for transactional email types', async () => {
    // VERIFY_EMAIL is transactional — should NOT check user preference
    await sendNotificationEmail('user@example.com', 'VERIFY_EMAIL', {
      token: 'abc123',
    });

    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalled();
  });

  it.each([
    'VERIFY_EMAIL',
    'REGISTRATION_INVITATION',
    'INVITE_APPROVED',
    'INVITE_REJECTED',
    'WELCOME',
    'RESET_PASSWORD',
    'GROUP_INVITE_REGISTER',
  ] as const)('does not check email preference for transactional type: %s', async (type) => {
    // Provide minimal data so the template renders (subject + html non-empty)
    const data: Record<string, string> = {
      token: 'tok-123',
      sharerName: 'Admin',
      code: 'INV-001',
      ownerName: 'Admin',
      groupName: 'Team',
      registerUrl: 'http://localhost:5173/register?code=INV-001',
    };

    await sendNotificationEmail('user@example.com', type, data);

    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — SHARE_NOTE
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — SHARE_NOTE', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends with correct subject and link (English)', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_NOTE', {
      sharerName: 'Alice',
      noteTitle: 'My Note',
      noteId: 'note-123',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Alice shared a note with you: My Note',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Shared Note');
    expect(html).toContain('Alice');
    expect(html).toContain('My Note');
    expect(html).toContain(`${FRONTEND_URL}/notes?noteId=note-123`);
  });

  it('escapes HTML in sharerName and noteTitle', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_NOTE', {
      sharerName: '<script>alert("xss")</script>',
      noteTitle: 'Note & "Title"',
      noteId: 'note-1',
      locale: 'en',
    });

    const call = mockSendMail.mock.calls[0][0];
    expect(call.subject).toContain('&lt;script&gt;');
    expect(call.subject).toContain('Note &amp; &quot;Title&quot;');
    expect(call.html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — SHARE_NOTEBOOK
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — SHARE_NOTEBOOK', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends with correct subject and link', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_NOTEBOOK', {
      sharerName: 'Bob',
      notebookName: 'Work Notebook',
      notebookId: 'nb-456',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Bob shared a notebook with you: Work Notebook',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Shared Notebook');
    expect(html).toContain(`${FRONTEND_URL}/notes?notebookId=nb-456`);
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — SHARE_INVITATION
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — SHARE_INVITATION', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English invitation with dashboard link including shareId', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_INVITATION', {
      sharerName: 'Alice',
      itemName: 'Project Board',
      itemType: 'Note',
      shareId: 'share-789',
      tab: 'notes',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Alice invited you to collaborate on: Project Board',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Collaboration Invitation');
    expect(html).toContain(`${FRONTEND_URL}/shared?tab=notes&highlight=share-789`);
    expect(html).toContain('the Note');
  });

  it('sends Italian invitation when locale is it', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_INVITATION', {
      sharerName: 'Alice',
      itemName: 'Progetto',
      itemType: 'Notebook',
      shareId: 'share-1',
      tab: 'notebooks',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Alice ti ha invitato a collaborare su: Progetto',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invito alla Collaborazione');
    expect(html).toContain('il taccuino');
  });

  it('falls back to generic dashboard link when shareId is missing', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_INVITATION', {
      sharerName: 'Alice',
      itemName: 'Item',
      itemType: 'Note',
      locale: 'en',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain(`${FRONTEND_URL}/shared`);
    expect(html).not.toContain('highlight=');
  });

  it.each([
    ['Note', 'la nota'],
    ['Notebook', 'il taccuino'],
    ['Task List', 'la lista attivita'],
    ['Kanban Board', 'la board kanban'],
  ])('translates itemType "%s" to "%s" in Italian', async (itemType, expectedTranslation) => {
    await sendNotificationEmail('user@example.com', 'SHARE_INVITATION', {
      sharerName: 'Alice',
      itemName: 'Test',
      itemType,
      shareId: 'share-1',
      tab: 'notes',
      locale: 'it',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain(expectedTranslation);
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — REGISTRATION_INVITATION
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — REGISTRATION_INVITATION', () => {
  it('sends English registration invitation with code and register link', async () => {
    await sendNotificationEmail('new@example.com', 'REGISTRATION_INVITATION', {
      sharerName: 'Admin',
      code: 'INV-ABC',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Admin invited you to Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain("You've been invited!");
    expect(html).toContain('INV-ABC');
    expect(html).toContain(`${FRONTEND_URL}/register?code=INV-ABC`);
  });

  it('sends Italian registration invitation', async () => {
    await sendNotificationEmail('new@example.com', 'REGISTRATION_INVITATION', {
      sharerName: 'Admin',
      code: 'INV-ABC',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Admin ti ha invitato su Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Sei stato invitato!');
    expect(html).toContain('INV-ABC');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — INVITE_APPROVED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — INVITE_APPROVED', () => {
  it('sends English approval with code and register link', async () => {
    await sendNotificationEmail('user@example.com', 'INVITE_APPROVED', {
      code: 'APPROVED-CODE',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Your invitation request has been approved! - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Request Approved');
    expect(html).toContain('APPROVED-CODE');
    expect(html).toContain(`${FRONTEND_URL}/register?code=APPROVED-CODE`);
  });

  it('sends Italian approval', async () => {
    await sendNotificationEmail('user@example.com', 'INVITE_APPROVED', {
      code: 'APPROVED-CODE',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('approvata'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Richiesta Approvata');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — INVITE_REJECTED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — INVITE_REJECTED', () => {
  it('sends English rejection', async () => {
    await sendNotificationEmail('user@example.com', 'INVITE_REJECTED', {
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Application Status - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Request Rejected');
    expect(html).toContain('cannot approve');
  });

  it('sends Italian rejection', async () => {
    await sendNotificationEmail('user@example.com', 'INVITE_REJECTED', {
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Notiq'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Richiesta Rifiutata');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — SHARE_RESPONSE
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — SHARE_RESPONSE', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends accepted response in English with view link', async () => {
    await sendNotificationEmail('owner@example.com', 'SHARE_RESPONSE', {
      responderName: 'Bob',
      action: 'accepted',
      itemName: 'Shared Doc',
      itemId: 'note-1',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Bob accepted your invitation',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invitation Accepted');
    expect(html).toContain('accepted');
    expect(html).toContain(`${FRONTEND_URL}/notes?noteId=note-1`);
    expect(html).toContain('#10b981'); // green for accepted
  });

  it('sends declined response in English without view link', async () => {
    await sendNotificationEmail('owner@example.com', 'SHARE_RESPONSE', {
      responderName: 'Bob',
      action: 'declined',
      itemName: 'Shared Doc',
      itemId: 'note-1',
      locale: 'en',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invitation Declined');
    expect(html).toContain('#ef4444'); // red for declined
    expect(html).not.toContain('View Note');
  });

  it('sends Italian accepted response', async () => {
    await sendNotificationEmail('owner@example.com', 'SHARE_RESPONSE', {
      responderName: 'Bob',
      action: 'accepted',
      itemName: 'Documento',
      itemId: 'note-1',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Bob ha accettato il tuo invito',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invito Accettato');
  });

  it('sends Italian declined response', async () => {
    await sendNotificationEmail('owner@example.com', 'SHARE_RESPONSE', {
      responderName: 'Bob',
      action: 'declined',
      itemName: 'Documento',
      itemId: 'note-1',
      locale: 'it',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invito Rifiutato');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — VERIFY_EMAIL
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — VERIFY_EMAIL', () => {
  it('sends English verification email with token link', async () => {
    await sendNotificationEmail('user@example.com', 'VERIFY_EMAIL', {
      token: 'verify-token-123',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Verify your email - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Welcome to Notiq!');
    expect(html).toContain(`${FRONTEND_URL}/verify-email?token=verify-token-123`);
    expect(html).toContain('Verify Email');
  });

  it('sends Italian verification email', async () => {
    await sendNotificationEmail('user@example.com', 'VERIFY_EMAIL', {
      token: 'verify-token-123',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Verifica la tua email - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Benvenuto in Notiq!');
    expect(html).toContain('Verifica Email');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — GROUP_MEMBER_ADDED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — GROUP_MEMBER_ADDED', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English group add notification', async () => {
    await sendNotificationEmail('member@example.com', 'GROUP_MEMBER_ADDED', {
      ownerName: 'Admin',
      groupName: 'Dev Team',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'You were added to the group "Dev Team" - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Added to Group');
    expect(html).toContain('Admin');
    expect(html).toContain(`${FRONTEND_URL}/groups`);
  });

  it('sends Italian group add notification', async () => {
    await sendNotificationEmail('member@example.com', 'GROUP_MEMBER_ADDED', {
      ownerName: 'Admin',
      groupName: 'Dev Team',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Sei stato aggiunto al gruppo'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Aggiunto al Gruppo');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — GROUP_MEMBER_REMOVED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — GROUP_MEMBER_REMOVED', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English group remove notification', async () => {
    await sendNotificationEmail('member@example.com', 'GROUP_MEMBER_REMOVED', {
      ownerName: 'Admin',
      groupName: 'Dev Team',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'You were removed from the group "Dev Team" - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Removed from Group');
  });

  it('sends Italian group remove notification', async () => {
    await sendNotificationEmail('member@example.com', 'GROUP_MEMBER_REMOVED', {
      ownerName: 'Admin',
      groupName: 'Dev Team',
      locale: 'it',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Rimosso dal Gruppo');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — GROUP_INVITE_REGISTER
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — GROUP_INVITE_REGISTER', () => {
  it('sends English group invite registration email', async () => {
    await sendNotificationEmail('new@example.com', 'GROUP_INVITE_REGISTER', {
      ownerName: 'Alice',
      groupName: 'Design Team',
      registerUrl: 'http://localhost:5173/register?code=GRP-001',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Alice invited you to join Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invitation to Notiq');
    expect(html).toContain('Design Team');
    expect(html).toContain('http://localhost:5173/register?code=GRP-001');
  });

  it('sends Italian group invite registration email', async () => {
    await sendNotificationEmail('new@example.com', 'GROUP_INVITE_REGISTER', {
      ownerName: 'Alice',
      groupName: 'Design Team',
      registerUrl: 'http://localhost:5173/register?code=GRP-001',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Alice ti ha invitato a unirti a Notiq'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Invito a Notiq');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — GROUP_MEMBER_JOINED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — GROUP_MEMBER_JOINED', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English group member joined notification', async () => {
    await sendNotificationEmail('owner@example.com', 'GROUP_MEMBER_JOINED', {
      memberEmail: 'newmember@example.com',
      groupName: 'Dev Team',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'A new member joined your group - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Group Member');
    expect(html).toContain('newmember@example.com');
    expect(html).toContain(`${FRONTEND_URL}/groups`);
  });

  it('sends Italian group member joined notification', async () => {
    await sendNotificationEmail('owner@example.com', 'GROUP_MEMBER_JOINED', {
      memberEmail: 'newmember@example.com',
      groupName: 'Dev Team',
      locale: 'it',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Nuovo Membro nel Gruppo');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — CHAT_MESSAGE
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — CHAT_MESSAGE', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English chat message notification', async () => {
    await sendNotificationEmail('user@example.com', 'CHAT_MESSAGE', {
      senderName: 'Alice',
      noteTitle: 'Meeting Notes',
      messageContent: 'Hey, check this out!',
      noteId: 'note-chat-1',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'New message from Alice on Meeting Notes',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Message');
    expect(html).toContain('Hey, check this out!');
    expect(html).toContain(`${FRONTEND_URL}/notes?noteId=note-chat-1`);
  });

  it('sends Italian chat message notification', async () => {
    await sendNotificationEmail('user@example.com', 'CHAT_MESSAGE', {
      senderName: 'Alice',
      noteTitle: 'Meeting Notes',
      messageContent: 'Ciao!',
      noteId: 'note-chat-1',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Nuovo messaggio da Alice'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Nuovo Messaggio');
  });

  it('escapes HTML in message content', async () => {
    await sendNotificationEmail('user@example.com', 'CHAT_MESSAGE', {
      senderName: 'Eve',
      noteTitle: 'Note',
      messageContent: '<img src=x onerror=alert(1)>',
      noteId: 'note-1',
      locale: 'en',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — KANBAN_COMMENT
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — KANBAN_COMMENT', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English kanban comment notification', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_COMMENT', {
      authorName: 'Charlie',
      cardTitle: 'Fix bug #42',
      commentContent: 'This is ready for review',
      boardId: 'board-1',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'New comment on "Fix bug #42" - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Comment');
    expect(html).toContain('Charlie');
    expect(html).toContain('This is ready for review');
    expect(html).toContain(`${FRONTEND_URL}/kanban?boardId=board-1`);
  });

  it('sends Italian kanban comment notification', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_COMMENT', {
      authorName: 'Charlie',
      cardTitle: 'Fix bug #42',
      commentContent: 'Pronto per review',
      boardId: 'board-1',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Nuovo commento su'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Nuovo commento');
  });

  it('handles missing optional fields with empty strings', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_COMMENT', {
      locale: 'en',
    });

    // Should not throw; uses empty strings for missing fields
    expect(mockSendMail).toHaveBeenCalled();
    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Comment');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — KANBAN_COMMENT_DELETED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — KANBAN_COMMENT_DELETED', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English kanban comment deleted notification', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_COMMENT_DELETED', {
      authorName: 'Charlie',
      cardTitle: 'Task Alpha',
      boardId: 'board-2',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Comment deleted on "Task Alpha" - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Comment Deleted');
    expect(html).toContain(`${FRONTEND_URL}/kanban?boardId=board-2`);
  });

  it('sends Italian kanban comment deleted notification', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_COMMENT_DELETED', {
      authorName: 'Charlie',
      cardTitle: 'Task Alpha',
      boardId: 'board-2',
      locale: 'it',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Commento eliminato');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — KANBAN_CARD_MOVED
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — KANBAN_CARD_MOVED', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('sends English kanban card moved notification', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_CARD_MOVED', {
      actorName: 'Dave',
      cardTitle: 'Deploy v2',
      fromColumn: 'In Progress',
      toColumn: 'Done',
      boardId: 'board-3',
      locale: 'en',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Card moved: "Deploy v2" - Notiq',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Card Moved');
    expect(html).toContain('Dave');
    expect(html).toContain('Deploy v2');
    expect(html).toContain('In Progress');
    expect(html).toContain('Done');
    expect(html).toContain(`${FRONTEND_URL}/kanban?boardId=board-3`);
  });

  it('sends Italian kanban card moved notification', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_CARD_MOVED', {
      actorName: 'Dave',
      cardTitle: 'Deploy v2',
      fromColumn: 'In Progress',
      toColumn: 'Done',
      boardId: 'board-3',
      locale: 'it',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Card spostata'),
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Card spostata');
    expect(html).toContain('ha spostato');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — Locale defaults
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — locale handling', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('defaults to English when locale is not provided', async () => {
    await sendNotificationEmail('user@example.com', 'SHARE_NOTE', {
      sharerName: 'Alice',
      noteTitle: 'Test',
      noteId: 'note-1',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Alice shared a note with you: Test',
      })
    );

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('New Shared Note');
  });

  it('treats locale starting with "it" as Italian (e.g. it-IT)', async () => {
    await sendNotificationEmail('user@example.com', 'KANBAN_CARD_MOVED', {
      actorName: 'Dave',
      cardTitle: 'Card',
      fromColumn: 'A',
      toColumn: 'B',
      boardId: 'board-1',
      locale: 'it-IT',
    });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Card spostata');
  });
});

// ---------------------------------------------------------------------------
// sendNotificationEmail — does not call sendMail for unhandled types
// ---------------------------------------------------------------------------
describe('sendNotificationEmail — unhandled template types', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ emailNotificationsEnabled: true });
  });

  it('does not call sendMail when type produces empty subject/html (e.g. WELCOME, RESET_PASSWORD)', async () => {
    // WELCOME and RESET_PASSWORD are listed in EmailTemplateType but have no
    // case in the switch, so subject and html remain empty strings.
    await sendNotificationEmail('user@example.com', 'WELCOME', { locale: 'en' });

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('does not call sendMail for REMINDER type (no case in switch)', async () => {
    await sendNotificationEmail('user@example.com', 'REMINDER', { locale: 'en' });

    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
