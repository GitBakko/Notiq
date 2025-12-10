
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

type EmailTemplateType = 'SHARE_NOTE' | 'SHARE_NOTEBOOK' | 'WELCOME' | 'RESET_PASSWORD' | 'REMINDER';

export const sendNotificationEmail = async (
  to: string,
  type: EmailTemplateType,
  data: any
) => {
  let subject = '';
  let html = '';

  switch (type) {
    case 'SHARE_NOTE':
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
    case 'REMINDER':
      subject = `Reminder: ${data.taskTitle}`;
      html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Task Reminder</h2>
          <p>This is a reminder for your task: "<strong>${data.taskTitle}</strong>".</p>
          <p>Due: ${data.dueDate}</p>
          <p><a href="${process.env.FRONTEND_URL}/tasks" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Tasks</a></p>
        </div>
      `;
      break;
    case 'WELCOME':
      subject = 'Welcome to Notiq!';
      html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Welcome to Notiq, ${data.name}!</h2>
          <p>We are excited to have you on board.</p>
          <p><a href="${process.env.FRONTEND_URL}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Get Started</a></p>
        </div>
      `;
      break;
    case 'RESET_PASSWORD':
      subject = 'Reset Your Password';
      html = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h2>Reset Password</h2>
            <p>You requested to reset your password.</p>
            <p><a href="${process.env.FRONTEND_URL}/reset-password?token=${data.token}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a></p>
            <p>If you did not request this, please ignore this email.</p>
          </div>
        `;
      break;
  }

  if (subject && html) {
    return sendEmail(to, subject, html);
  }
};
