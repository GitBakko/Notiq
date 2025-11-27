/**
 * SMTP Configuration Test Script
 * 
 * This script tests the SMTP configuration by sending a test email.
 * Run with: npx ts-node src/scripts/testSmtp.ts <recipient_email>
 */

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

const configPath = path.join(__dirname, '../../config.json');
let config: any = {};

try {
  const configFile = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(configFile);
  console.log('✓ Config file loaded successfully');
} catch (error) {
  console.error('✗ Failed to load config.json:', error);
  process.exit(1);
}

// Validate SMTP configuration
const smtpConfig = config.smtp;
if (!smtpConfig) {
  console.error('✗ SMTP configuration is missing from config.json');
  process.exit(1);
}

const requiredFields = ['host', 'port', 'user', 'pass'];
const missingFields = requiredFields.filter(field => !smtpConfig[field]);

if (missingFields.length > 0) {
  console.error(`✗ Missing required SMTP fields: ${missingFields.join(', ')}`);
  process.exit(1);
}

console.log('SMTP Configuration:');
console.log(`  Host: ${smtpConfig.host}`);
console.log(`  Port: ${smtpConfig.port}`);
console.log(`  User: ${smtpConfig.user}`);
console.log(`  Secure: ${smtpConfig.secure || false}`);
console.log('');

async function testSmtp(recipientEmail?: string) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure || false,
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
