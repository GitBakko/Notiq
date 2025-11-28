
import prisma from '../plugins/prisma';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { sendEmail } from './email.service';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export const requestPasswordReset = async (email: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Return true even if user not found to prevent enumeration
    return true;
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetToken: resetTokenHash,
      resetTokenExpiry,
    },
  });

  const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
  const logoUrl = `${FRONTEND_URL}/logo-no-bg.png`;
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset Your Password</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f4f7f6;
          margin: 0;
          padding: 0;
          line-height: 1.6;
          color: #333333;
        }
        .container {
          max-width: 500px;
          margin: 40px auto;
          background-color: #ffffff;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 10px 25px rgba(0,0,0,0.05);
        }
        .header {
          background-color: #218D7C;
          padding: 30px 20px;
          text-align: center;
        }
        .header img {
          height: 50px;
          width: auto;
          margin-bottom: 10px;
        }
        .header h1 {
          color: #ffffff;
          margin: 0;
          font-size: 28px;
          font-weight: 700;
          letter-spacing: 1px;
        }
        .content {
          padding: 40px 30px;
          text-align: left;
        }
        .content h2 {
          color: #1f2937;
          font-size: 22px;
          margin-top: 0;
          margin-bottom: 20px;
        }
        .content p {
          margin-bottom: 20px;
          color: #4b5563;
          font-size: 16px;
        }
        .button-container {
          text-align: center;
          margin: 30px 0;
        }
        .button {
          display: inline-block;
          background-color: #218D7C;
          color: #ffffff !important;
          text-decoration: none;
          padding: 14px 32px;
          border-radius: 50px;
          font-weight: 600;
          font-size: 16px;
          box-shadow: 0 4px 6px rgba(33, 141, 124, 0.2);
          transition: background-color 0.3s ease;
        }
        .button:hover {
          background-color: #1a7264;
        }
        .link-fallback {
          font-size: 13px;
          color: #9ca3af;
          margin-top: 30px;
          border-top: 1px solid #e5e7eb;
          padding-top: 20px;
          word-break: break-all;
        }
        .link-fallback a {
          color: #218D7C;
          text-decoration: none;
        }
        .footer {
          background-color: #f9fafb;
          padding: 20px;
          text-align: center;
          font-size: 12px;
          color: #9ca3af;
          border-top: 1px solid #f3f4f6;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="${logoUrl}" alt="Notiq Logo">
          <h1>Notiq</h1>
        </div>
        <div class="content">
          <h2>Password Reset Request</h2>
          <p>Hello,</p>
          <p>We received a request to reset the password for your Notiq account. If you didn't make this request, you can safely ignore this email.</p>
          
          <div class="button-container">
            <a href="${resetLink}" class="button">Reset Password</a>
          </div>

          <p>This link will expire in 1 hour for your security.</p>
          
          <div class="link-fallback">
            <p>If the button doesn't work, copy and paste this link into your browser:</p>
            <a href="${resetLink}">${resetLink}</a>
          </div>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Notiq. All rights reserved.</p>
          <p>This is an automated message, please do not reply.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  await sendEmail(email, 'Reset your Notiq password', html);
  return true;
};

export const resetPassword = async (token: string, newPassword: string) => {
  const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const user = await prisma.user.findFirst({
    where: {
      resetToken: resetTokenHash,
      resetTokenExpiry: {
        gt: new Date(),
      },
    },
  });

  if (!user) {
    throw new Error('Invalid or expired token');
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      resetToken: null,
      resetTokenExpiry: null,
    },
  });

  return true;
};
