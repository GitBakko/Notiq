
// @ts-ignore
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

const configPath = path.join(__dirname, '../../config.json');
let config: any = {};

try {
  const configFile = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(configFile);
} catch (error) {
  console.error('Failed to load config.json', error);
}

const transporter = nodemailer.createTransport({
  host: config.smtp?.host,
  port: config.smtp?.port,
  secure: config.smtp?.secure || false,
  auth: {
    user: config.smtp?.user,
    pass: config.smtp?.pass,
  },
});

export const sendEmail = async (to: string, subject: string, html: string) => {
  try {
    const info = await transporter.sendMail({
      from: `"${config.smtp?.fromName || 'Notiq App'}" <${config.smtp?.user}>`,
      to,
      subject,
      html,
    });
    console.log('Message sent: %s', info.messageId);
    return info;
  } catch (error) {
    console.error('Error sending email', error);
    throw error;
  }
};

type EmailTemplateType = 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'WELCOME' | 'RESET_PASSWORD' | 'REMINDER' | 'CHAT_MESSAGE' | 'SHARE_INVITATION' | 'SHARE_RESPONSE';

export const sendNotificationEmail = async (
  to: string,
  type: EmailTemplateType,
  data: any
) => {
  let subject = '';
  let html = '';

  const locale = data.locale || 'en';
  const isIt = locale === 'it' || locale.startsWith('it');

  switch (type) {
    case 'SHARE_NOTE':
      // ... (Keep existing as English default or localize if needed, but user focused on invite/response)
      subject = `${data.sharerName} shared a note with you: ${data.noteTitle}`;
      html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>New Shared Note</h2>
          <p><strong>${data.sharerName}</strong> has shared the note "<strong>${data.noteTitle}</strong>" with you.</p>
          <p><a href="${process.env.FRONTEND_URL}/notes?noteId=${data.noteId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Note</a></p>
        </div>
      `;
      break;
    case 'SHARE_NOTEBOOK':
      subject = `${data.sharerName} shared a notebook with you: ${data.notebookName}`;
      html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>New Shared Notebook</h2>
          <p><strong>${data.sharerName}</strong> has shared the notebook "<strong>${data.notebookName}</strong>" with you.</p>
          <p><a href="${process.env.FRONTEND_URL}/notes?notebookId=${data.notebookId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Notebook</a></p>
        </div>
      `;
      break;

    // ... (Keep generic types as is)

    case 'SHARE_INVITATION':
      if (isIt) {
        subject = `${data.sharerName} ti ha invitato a collaborare su: ${data.itemName}`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invito alla Collaborazione</h2>
            <p><strong>${data.sharerName}</strong> vuole condividere ${data.itemType === 'Note' ? 'la nota' : 'il taccuino'} "<strong>${data.itemName}</strong>" con te.</p>
            <div style="margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL}/share/respond?token=${data.token}&action=accept" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Accetta</a>
              <a href="${process.env.FRONTEND_URL}/share/respond?token=${data.token}&action=decline" style="background: #ef4444; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Rifiuta</a>
            </div>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Oppure vedi gli inviti in sospeso nella tua dashboard: <a href="${process.env.FRONTEND_URL}/shared">Vedi Tutti gli Inviti</a></p>
          </div>
        `;
      } else {
        subject = `${data.sharerName} invited you to collaborate on: ${data.itemName}`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Collaboration Invitation</h2>
            <p><strong>${data.sharerName}</strong> wants to share the ${data.itemType} "<strong>${data.itemName}</strong>" with you.</p>
            <div style="margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL}/share/respond?token=${data.token}&action=accept" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Accept Invitation</a>
              <a href="${process.env.FRONTEND_URL}/share/respond?token=${data.token}&action=decline" style="background: #ef4444; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Decline Invitation</a>
            </div>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">Or view pending invites in your dashboard: <a href="${process.env.FRONTEND_URL}/shared">View All Invites</a></p>
          </div>
        `;
      }
      break;

    case 'SHARE_RESPONSE':
      const actionEn = data.action === 'accepted' ? 'accepted' : 'declined';
      const actionIt = data.action === 'accepted' ? 'accettato' : 'rifiutato';
      const color = data.action === 'accepted' ? '#10b981' : '#ef4444';

      if (isIt) {
        subject = `${data.responderName} ha ${actionIt} il tuo invito`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invito ${actionIt.charAt(0).toUpperCase() + actionIt.slice(1)}</h2>
            <p><strong>${data.responderName}</strong> ha <span style="color: ${color}; font-weight: bold;">${actionIt}</span> il tuo invito a collaborare su "<strong>${data.itemName}</strong>".</p>
            ${data.action === 'accepted' ? `<p><a href="${process.env.FRONTEND_URL}/notes?noteId=${data.itemId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Nota</a></p>` : ''}
          </div>
        `;
      } else {
        subject = `${data.responderName} ${actionEn} your invitation`;
        html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Invitation ${actionEn.charAt(0).toUpperCase() + actionEn.slice(1)}</h2>
            <p><strong>${data.responderName}</strong> has <span style="color: ${color}; font-weight: bold;">${actionEn}</span> your invitation to collaborate on "<strong>${data.itemName}</strong>".</p>
            ${data.action === 'accepted' ? `<p><a href="${process.env.FRONTEND_URL}/notes?noteId=${data.itemId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Note</a></p>` : ''}
          </div>
        `;
      }
      break;

    case 'CHAT_MESSAGE':
      if (isIt) {
        subject = `Nuovo messaggio da ${data.senderName} su ${data.noteTitle}`;
        html = `
             <div style="font-family: sans-serif; padding: 20px;">
               <h2>Nuovo Messaggio</h2>
               <p><strong>${data.senderName}</strong> ha commentato su "<strong>${data.noteTitle}</strong>":</p>
               <blockquote style="background: #f3f4f6; padding: 10px; border-left: 4px solid #10b981;">${data.messageContent}</blockquote>
               <p><a href="${process.env.FRONTEND_URL}/notes?noteId=${data.noteId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Discussione</a></p>
             </div>
           `;
      } else {
        subject = `New message from ${data.senderName} on ${data.noteTitle}`;
        html = `
             <div style="font-family: sans-serif; padding: 20px;">
               <h2>New Message</h2>
               <p><strong>${data.senderName}</strong> commented on "<strong>${data.noteTitle}</strong>":</p>
               <blockquote style="background: #f3f4f6; padding: 10px; border-left: 4px solid #10b981;">${data.messageContent}</blockquote>
               <p><a href="${process.env.FRONTEND_URL}/notes?noteId=${data.noteId}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Discussion</a></p>
             </div>
           `;
      }
      break;
  }

  if (subject && html) {
    return sendEmail(to, subject, html);
  }
};
