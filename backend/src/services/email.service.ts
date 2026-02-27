
// @ts-ignore
import nodemailer from 'nodemailer';
import logger from '../utils/logger';

const escapeHtml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  console.warn('FRONTEND_URL is not defined in .env! Email links will be broken.');
}

const smtpHost = process.env.SMTP_HOST;
const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpSecure = process.env.SMTP_SECURE === 'true';
const smtpFromName = process.env.SMTP_FROM_NAME || 'Notiq App';

if (!smtpHost || !smtpUser || !smtpPass) {
  logger.warn('SMTP environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS) are not fully configured. Emails will fail.');
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpSecure,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

export const sendEmail = async (to: string, subject: string, html: string) => {
  try {
    const info = await transporter.sendMail({
      from: `"${smtpFromName}" <${smtpUser}>`,
      to,
      subject,
      html,
    });
    logger.info('Message sent: %s', info.messageId);
    return info;
  } catch (error) {
    logger.error(error, 'Error sending email');
    throw error;
  }
};

type EmailTemplateType = 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'WELCOME' | 'RESET_PASSWORD' | 'REMINDER' | 'CHAT_MESSAGE' | 'SHARE_INVITATION' | 'REGISTRATION_INVITATION' | 'SHARE_RESPONSE' | 'VERIFY_EMAIL' | 'INVITE_APPROVED' | 'INVITE_REJECTED' | 'GROUP_MEMBER_ADDED' | 'GROUP_MEMBER_REMOVED' | 'GROUP_INVITE_REGISTER' | 'GROUP_MEMBER_JOINED' | 'KANBAN_COMMENT' | 'KANBAN_COMMENT_DELETED' | 'KANBAN_CARD_MOVED';

// Transactional emails that are always sent regardless of user email preferences
const TRANSACTIONAL_EMAIL_TYPES: Set<string> = new Set([
  'VERIFY_EMAIL', 'REGISTRATION_INVITATION', 'INVITE_APPROVED', 'INVITE_REJECTED',
  'WELCOME', 'RESET_PASSWORD', 'GROUP_INVITE_REGISTER',
]);

export const sendNotificationEmail = async (
  to: string,
  type: EmailTemplateType,
  data: any
) => {
  // Check user email preference (skip for transactional emails)
  if (!TRANSACTIONAL_EMAIL_TYPES.has(type)) {
    try {
      const prisma = (await import('../plugins/prisma')).default;
      const user = await prisma.user.findUnique({
        where: { email: to },
        select: { emailNotificationsEnabled: true },
      });
      if (user && !user.emailNotificationsEnabled) {
        logger.info('Skipping email to %s — user has email notifications disabled', to);
        return;
      }
    } catch {
      // If lookup fails, send the email anyway (fail-open)
    }
  }

  let subject = '';
  let html = '';

  const locale = data.locale || 'en';
  const isIt = locale === 'it' || locale.startsWith('it');

  switch (type) {
    case 'SHARE_NOTE':
      // ... (Keep existing as English default or localize if needed, but user focused on invite/response)
      subject = `${escapeHtml(data.sharerName)} shared a note with you: ${escapeHtml(data.noteTitle)}`;
      html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>New Shared Note</h2>
          <p><strong>${escapeHtml(data.sharerName)}</strong> has shared the note "<strong>${escapeHtml(data.noteTitle)}</strong>" with you.</p>
          <p><a href="${FRONTEND_URL}/notes?noteId=${data.noteId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Note</a></p>
        </div>
      `;
      break;
    case 'SHARE_NOTEBOOK':
      subject = `${escapeHtml(data.sharerName)} shared a notebook with you: ${escapeHtml(data.notebookName)}`;
      html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>New Shared Notebook</h2>
          <p><strong>${escapeHtml(data.sharerName)}</strong> has shared the notebook "<strong>${escapeHtml(data.notebookName)}</strong>" with you.</p>
          <p><a href="${FRONTEND_URL}/notes?notebookId=${data.notebookId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Notebook</a></p>
        </div>
      `;
      break;

    // ... (Keep generic types as is)

    case 'SHARE_INVITATION': {
      const dashboardLink = data.shareId
        ? `${FRONTEND_URL}/shared?tab=${data.tab}&highlight=${data.shareId}`
        : `${FRONTEND_URL}/shared`;

      if (isIt) {
        const itemTypeIt = data.itemType === 'Note' ? 'la nota'
          : data.itemType === 'Notebook' ? 'il taccuino'
          : data.itemType === 'Task List' ? 'la lista attivita'
          : 'la board kanban';
        subject = `${escapeHtml(data.sharerName)} ti ha invitato a collaborare su: ${escapeHtml(data.itemName)}`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invito alla Collaborazione</h2>
            <p><strong>${escapeHtml(data.sharerName)}</strong> vuole condividere ${itemTypeIt} "<strong>${escapeHtml(data.itemName)}</strong>" con te.</p>
            <p style="margin-top: 20px;">
              <a href="${dashboardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Invito</a>
            </p>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Accedi a Notiq per accettare o rifiutare l'invito.</p>
          </div>
        `;
      } else {
        subject = `${escapeHtml(data.sharerName)} invited you to collaborate on: ${escapeHtml(data.itemName)}`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Collaboration Invitation</h2>
            <p><strong>${escapeHtml(data.sharerName)}</strong> wants to share the ${data.itemType} "<strong>${escapeHtml(data.itemName)}</strong>" with you.</p>
            <p style="margin-top: 20px;">
              <a href="${dashboardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Invitation</a>
            </p>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Sign in to Notiq to accept or decline the invitation.</p>
          </div>
        `;
      }
      break;
    }

    case 'REGISTRATION_INVITATION':
      if (isIt) {
        subject = `${escapeHtml(data.sharerName)} ti ha invitato su Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Sei stato invitato!</h2>
            <p><strong>${escapeHtml(data.sharerName)}</strong> ti ha inviato un codice invito per registrarti su <strong>Notiq</strong>.</p>
            <p>Il tuo codice invito è: <strong style="font-size: 1.2em; background: #eee; padding: 2px 6px; border-radius: 4px;">${data.code}</strong></p>
            <p><a href="${FRONTEND_URL}/register?code=${data.code}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Registrati Ora</a></p>
          </div>
        `;
      } else {
        subject = `${escapeHtml(data.sharerName)} invited you to Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>You've been invited!</h2>
            <p><strong>${escapeHtml(data.sharerName)}</strong> sent you an invitation code to join <strong>Notiq</strong>.</p>
            <p>Your invite code is: <strong style="font-size: 1.2em; background: #eee; padding: 2px 6px; border-radius: 4px;">${data.code}</strong></p>
            <p><a href="${FRONTEND_URL}/register?code=${data.code}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Register Now</a></p>
          </div>
        `;
      }
      break;

    // New: Invite Approved (Request)
    // IMPORTANT: Check if 'INVITE_APPROVED' is in EmailTemplateType
    case 'INVITE_APPROVED':
      if (isIt) {
        subject = 'La tua richiesta di invito è stata approvata! - Notiq';
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Richiesta Approvata</h2>
            <p>Siamo felici di informarti che la tua richiesta di invito per <strong>Notiq</strong> è stata approvata.</p>
             <p>Il tuo codice invito è: <strong style="font-size: 1.2em; background: #eee; padding: 2px 6px; border-radius: 4px;">${data.code}</strong></p>
            <p><a href="${FRONTEND_URL}/register?code=${data.code}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Crea il tuo Account</a></p>
          </div>
        `;
      } else {
        subject = 'Your invitation request has been approved! - Notiq';
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Request Approved</h2>
            <p>We are happy to inform you that your invitation request for <strong>Notiq</strong> has been approved.</p>
             <p>Your invite code is: <strong style="font-size: 1.2em; background: #eee; padding: 2px 6px; border-radius: 4px;">${data.code}</strong></p>
            <p><a href="${FRONTEND_URL}/register?code=${data.code}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Create your Account</a></p>
          </div>
        `;
      }
      break;

    // New: Invite Rejected (Request)
    // IMPORTANT: Check if 'INVITE_REJECTED' is in EmailTemplateType
    case 'INVITE_REJECTED':
      if (isIt) {
        subject = 'Stato della tua richiesta - Notiq';
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Richiesta Rifiutata</h2>
            <p>Ci dispiace informarti che al momento non possiamo approvare la tua richiesta di invito per <strong>Notiq</strong>.</p>
            <p>Grazie comunque per il tuo interesse.</p>
          </div>
        `;
      } else {
        subject = 'Application Status - Notiq';
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Request Rejected</h2>
            <p>We regret to inform you that we cannot approve your invitation request for <strong>Notiq</strong> at this time.</p>
            <p>Thank you for your interest.</p>
          </div>
        `;
      }
      break;

    case 'SHARE_RESPONSE':
      const actionEn = data.action === 'accepted' ? 'accepted' : 'declined';
      const actionIt = data.action === 'accepted' ? 'accettato' : 'rifiutato';
      const color = data.action === 'accepted' ? '#10b981' : '#ef4444';

      if (isIt) {
        subject = `${escapeHtml(data.responderName)} ha ${actionIt} il tuo invito`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invito ${actionIt.charAt(0).toUpperCase() + actionIt.slice(1)}</h2>
            <p><strong>${escapeHtml(data.responderName)}</strong> ha <span style="color: ${color}; font-weight: bold;">${actionIt}</span> il tuo invito a collaborare su "<strong>${escapeHtml(data.itemName)}</strong>".</p>
            ${data.action === 'accepted' ? `<p><a href="${FRONTEND_URL}/notes?noteId=${data.itemId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Nota</a></p>` : ''}
          </div>
        `;
      } else {
        subject = `${escapeHtml(data.responderName)} ${actionEn} your invitation`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invitation ${actionEn.charAt(0).toUpperCase() + actionEn.slice(1)}</h2>
            <p><strong>${escapeHtml(data.responderName)}</strong> has <span style="color: ${color}; font-weight: bold;">${actionEn}</span> your invitation to collaborate on "<strong>${escapeHtml(data.itemName)}</strong>".</p>
            ${data.action === 'accepted' ? `<p><a href="${FRONTEND_URL}/notes?noteId=${data.itemId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Note</a></p>` : ''}
          </div>
        `;
      }
      break;

    case 'GROUP_MEMBER_ADDED':
      if (isIt) {
        subject = `Sei stato aggiunto al gruppo "${escapeHtml(data.groupName)}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Aggiunto al Gruppo</h2>
            <p><strong>${escapeHtml(data.ownerName)}</strong> ti ha aggiunto al gruppo "<strong>${escapeHtml(data.groupName)}</strong>" su Notiq.</p>
            <p><a href="${FRONTEND_URL}/groups" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Gruppi</a></p>
          </div>
        `;
      } else {
        subject = `You were added to the group "${escapeHtml(data.groupName)}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Added to Group</h2>
            <p><strong>${escapeHtml(data.ownerName)}</strong> added you to the group "<strong>${escapeHtml(data.groupName)}</strong>" on Notiq.</p>
            <p><a href="${FRONTEND_URL}/groups" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Groups</a></p>
          </div>
        `;
      }
      break;

    case 'GROUP_MEMBER_REMOVED':
      if (isIt) {
        subject = `Sei stato rimosso dal gruppo "${escapeHtml(data.groupName)}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Rimosso dal Gruppo</h2>
            <p><strong>${escapeHtml(data.ownerName)}</strong> ti ha rimosso dal gruppo "<strong>${escapeHtml(data.groupName)}</strong>" su Notiq.</p>
          </div>
        `;
      } else {
        subject = `You were removed from the group "${escapeHtml(data.groupName)}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Removed from Group</h2>
            <p><strong>${escapeHtml(data.ownerName)}</strong> removed you from the group "<strong>${escapeHtml(data.groupName)}</strong>" on Notiq.</p>
          </div>
        `;
      }
      break;

    case 'GROUP_INVITE_REGISTER':
      if (isIt) {
        subject = `${escapeHtml(data.ownerName)} ti ha invitato a unirti a Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invito a Notiq</h2>
            <p><strong>${escapeHtml(data.ownerName)}</strong> vuole aggiungerti al gruppo "<strong>${escapeHtml(data.groupName)}</strong>" su Notiq.</p>
            <p>Per unirti, crea un account gratuito:</p>
            <p><a href="${data.registerUrl}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Registrati su Notiq</a></p>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Una volta completata la registrazione, verrai automaticamente aggiunto al gruppo.</p>
          </div>
        `;
      } else {
        subject = `${escapeHtml(data.ownerName)} invited you to join Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invitation to Notiq</h2>
            <p><strong>${escapeHtml(data.ownerName)}</strong> wants to add you to the group "<strong>${escapeHtml(data.groupName)}</strong>" on Notiq.</p>
            <p>To join, create a free account:</p>
            <p><a href="${data.registerUrl}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Register on Notiq</a></p>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Once you complete registration, you will be automatically added to the group.</p>
          </div>
        `;
      }
      break;

    case 'GROUP_MEMBER_JOINED':
      if (isIt) {
        subject = `Un nuovo membro si è unito al tuo gruppo - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Nuovo Membro nel Gruppo</h2>
            <p>L'utente <strong>${escapeHtml(data.memberEmail)}</strong> si è registrato e si è unito al tuo gruppo "<strong>${escapeHtml(data.groupName)}</strong>".</p>
            <p><a href="${FRONTEND_URL}/groups" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Gruppi</a></p>
          </div>
        `;
      } else {
        subject = `A new member joined your group - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>New Group Member</h2>
            <p>The user <strong>${escapeHtml(data.memberEmail)}</strong> has registered and joined your group "<strong>${escapeHtml(data.groupName)}</strong>".</p>
            <p><a href="${FRONTEND_URL}/groups" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Groups</a></p>
          </div>
        `;
      }
      break;

    case 'CHAT_MESSAGE':
      if (isIt) {
        subject = `Nuovo messaggio da ${escapeHtml(data.senderName)} su ${escapeHtml(data.noteTitle)}`;
        html = `
             <div style="font-family: sans-serif; padding: 20px;">
               <h2>Nuovo Messaggio</h2>
               <p><strong>${escapeHtml(data.senderName)}</strong> ha commentato su "<strong>${escapeHtml(data.noteTitle)}</strong>":</p>
               <blockquote style="background: #f3f4f6; padding: 10px; border-left: 4px solid #10b981;">${escapeHtml(data.messageContent)}</blockquote>
               <p><a href="${FRONTEND_URL}/notes?noteId=${data.noteId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Discussione</a></p>
             </div>
           `;
      } else {
        subject = `New message from ${escapeHtml(data.senderName)} on ${escapeHtml(data.noteTitle)}`;
        html = `
             <div style="font-family: sans-serif; padding: 20px;">
               <h2>New Message</h2>
               <p><strong>${escapeHtml(data.senderName)}</strong> commented on "<strong>${escapeHtml(data.noteTitle)}</strong>":</p>
               <blockquote style="background: #f3f4f6; padding: 10px; border-left: 4px solid #10b981;">${escapeHtml(data.messageContent)}</blockquote>
               <p><a href="${FRONTEND_URL}/notes?noteId=${data.noteId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Discussion</a></p>
             </div>
           `;
      }
      break;

    case 'VERIFY_EMAIL':
      const verifyLink = `${FRONTEND_URL}/verify-email?token=${data.token}`;
      if (isIt) {
        subject = 'Verifica la tua email - Notiq';
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Benvenuto in Notiq!</h2>
            <p>Grazie per esserti registrato. Per favore clicca il pulsante qui sotto per verificare il tuo indirizzo email e attivare il tuo account.</p>
            <p><a href="${verifyLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verifica Email</a></p>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Se non hai creato tu questo account, puoi ignorare questa email.</p>
          </div>
        `;
      } else {
        subject = 'Verify your email - Notiq';
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Welcome to Notiq!</h2>
            <p>Thanks for signing up. Please click the button below to verify your email address and activate your account.</p>
            <p><a href="${verifyLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a></p>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">If you didn't create this account, you can ignore this email.</p>
          </div>
        `;
      }
      break;

    case 'KANBAN_COMMENT': {
      const authorName = escapeHtml(data.authorName || '');
      const cardTitle = escapeHtml(data.cardTitle || '');
      const commentContent = escapeHtml(data.commentContent || '');
      const boardLink = `${FRONTEND_URL}/kanban?boardId=${data.boardId || ''}`;
      if (isIt) {
        subject = `Nuovo commento su "${cardTitle}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Nuovo commento</h2>
            <p><strong>${authorName}</strong> ha commentato sulla card <strong>"${cardTitle}"</strong>:</p>
            <blockquote style="border-left: 3px solid #10b981; padding: 8px 12px; margin: 12px 0; color: #555; background: #f9fafb;">${commentContent}</blockquote>
            <p><a href="${boardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Apri Board</a></p>
          </div>
        `;
      } else {
        subject = `New comment on "${cardTitle}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>New Comment</h2>
            <p><strong>${authorName}</strong> commented on card <strong>"${cardTitle}"</strong>:</p>
            <blockquote style="border-left: 3px solid #10b981; padding: 8px 12px; margin: 12px 0; color: #555; background: #f9fafb;">${commentContent}</blockquote>
            <p><a href="${boardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Open Board</a></p>
          </div>
        `;
      }
      break;
    }

    case 'KANBAN_COMMENT_DELETED': {
      const authorName = escapeHtml(data.authorName || '');
      const cardTitle = escapeHtml(data.cardTitle || '');
      const boardLink = `${FRONTEND_URL}/kanban?boardId=${data.boardId || ''}`;
      if (isIt) {
        subject = `Commento eliminato su "${cardTitle}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Commento eliminato</h2>
            <p><strong>${authorName}</strong> ha eliminato un commento sulla card <strong>"${cardTitle}"</strong>.</p>
            <p><a href="${boardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Apri Board</a></p>
          </div>
        `;
      } else {
        subject = `Comment deleted on "${cardTitle}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Comment Deleted</h2>
            <p><strong>${authorName}</strong> deleted a comment on card <strong>"${cardTitle}"</strong>.</p>
            <p><a href="${boardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Open Board</a></p>
          </div>
        `;
      }
      break;
    }

    case 'KANBAN_CARD_MOVED': {
      const actorName = escapeHtml(data.actorName || '');
      const cardTitle = escapeHtml(data.cardTitle || '');
      const fromColumn = escapeHtml(data.fromColumn || '');
      const toColumn = escapeHtml(data.toColumn || '');
      const boardLink = `${FRONTEND_URL}/kanban?boardId=${data.boardId || ''}`;
      if (isIt) {
        subject = `Card spostata: "${cardTitle}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Card spostata</h2>
            <p><strong>${actorName}</strong> ha spostato <strong>"${cardTitle}"</strong> da <em>${fromColumn}</em> a <em>${toColumn}</em>.</p>
            <p><a href="${boardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Apri Board</a></p>
          </div>
        `;
      } else {
        subject = `Card moved: "${cardTitle}" - Notiq`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Card Moved</h2>
            <p><strong>${actorName}</strong> moved <strong>"${cardTitle}"</strong> from <em>${fromColumn}</em> to <em>${toColumn}</em>.</p>
            <p><a href="${boardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Open Board</a></p>
          </div>
        `;
      }
      break;
    }
  }

  if (subject && html) {
    return sendEmail(to, subject, html);
  }
};
