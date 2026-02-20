/**
 * SMTP Configuration Test Script
 *
 * This script tests the SMTP configuration by sending a test email.
 * Run with: npx tsx src/scripts/testSmtp.ts <recipient_email>
 */

// @ts-ignore
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const smtpConfig = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  secure: process.env.SMTP_SECURE === 'true',
};

const requiredFields: (keyof typeof smtpConfig)[] = ['host', 'user', 'pass'];
const missingFields = requiredFields.filter(field => !smtpConfig[field]);

if (missingFields.length > 0) {
  console.error(`✗ Missing required SMTP env vars: ${missingFields.map(f => `SMTP_${f.toUpperCase()}`).join(', ')}`);
  process.exit(1);
}

console.log('SMTP Configuration (from .env):');
console.log(`  Host: ${smtpConfig.host}`);
console.log(`  Port: ${smtpConfig.port}`);
console.log(`  User: ${smtpConfig.user}`);
console.log(`  Secure: ${smtpConfig.secure}`);
console.log('');

async function testSmtp(recipientEmail?: string) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: {
      user: smtpConfig.user,
      pass: smtpConfig.pass,
    },
  });

  // Test SMTP connection
  console.log('Testing SMTP connection...');
  try {
    await transporter.verify();
    console.log('✓ SMTP connection successful!');
  } catch (error: any) {
    console.error('✗ SMTP connection failed:', error.message);
    process.exit(1);
  }

  // Send test email if recipient provided
  if (recipientEmail) {
    console.log(`\nSending test email to ${recipientEmail}...`);
    try {
      const info = await transporter.sendMail({
        from: `"Notiq Test" <${smtpConfig.user}>`,
        to: recipientEmail,
        subject: 'Notiq SMTP Test Email',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #10b981;">✓ SMTP Test Successful!</h1>
            <p>This is a test email from your Notiq application.</p>
            <p>If you received this email, your SMTP configuration is working correctly.</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="color: #6b7280; font-size: 12px;">
              Sent at: ${new Date().toISOString()}<br>
              SMTP Host: ${smtpConfig.host}<br>
              SMTP Port: ${smtpConfig.port}
            </p>
          </div>
        `,
      });
      console.log('✓ Test email sent successfully!');
      console.log(`  Message ID: ${info.messageId}`);
    } catch (error: any) {
      console.error('✗ Failed to send test email:', error.message);
      process.exit(1);
    }
  } else {
    console.log('\nTip: Provide an email address as argument to send a test email:');
    console.log('  npx ts-node src/scripts/testSmtp.ts your@email.com');
  }
}

// Get recipient email from command line arguments
const recipientEmail = process.argv[2];
testSmtp(recipientEmail);
