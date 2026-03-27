import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import prisma from '../plugins/prisma';
import { BadRequestError } from '../utils/errors';
import logger from '../utils/logger';

const CHAT_UPLOADS_DIR = path.join(__dirname, '../../uploads/chat');
const CHAT_THUMBS_DIR = path.join(CHAT_UPLOADS_DIR, 'thumbs');

// Ensure directories exist
if (!fs.existsSync(CHAT_UPLOADS_DIR)) fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CHAT_THUMBS_DIR)) fs.mkdirSync(CHAT_THUMBS_DIR, { recursive: true });

const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.cmd', '.sh', '.com', '.msi', '.scr', '.pif', '.vbs', '.js'];

async function getMaxFileSize(): Promise<number> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'chat_max_file_size_mb' } });
    return (parseInt(setting?.value || '10', 10) || 10) * 1024 * 1024;
  } catch {
    return 10 * 1024 * 1024;
  }
}

export async function uploadChatFile(
  messageId: string,
  fileBuffer: Buffer,
  originalFilename: string,
  mimeType: string,
): Promise<{ url: string; thumbnailUrl: string | null; filename: string; mimeType: string; size: number }> {
  const ext = path.extname(originalFilename).toLowerCase();

  // Validate extension
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    throw new BadRequestError('errors.chat.blockedFileType');
  }

  // Validate size
  const maxSize = await getMaxFileSize();
  if (fileBuffer.length > maxSize) {
    throw new BadRequestError('errors.chat.fileTooLarge');
  }

  // Save file
  const storageFilename = crypto.randomUUID() + ext;
  const filepath = path.join(CHAT_UPLOADS_DIR, storageFilename);
  fs.writeFileSync(filepath, fileBuffer);

  // Generate thumbnail for images
  let thumbnailUrl: string | null = null;
  if (mimeType.startsWith('image/') && !mimeType.includes('svg')) {
    try {
      // Try sharp if available, otherwise skip thumbnail
      const sharp = require('sharp');
      const thumbFilename = crypto.randomUUID() + '.jpg';
      const thumbPath = path.join(CHAT_THUMBS_DIR, thumbFilename);
      await sharp(fileBuffer).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath);
      thumbnailUrl = `/uploads/chat/thumbs/${thumbFilename}`;
    } catch (err) {
      logger.warn({ err }, 'Failed to generate chat file thumbnail, skipping');
    }
  }

  const url = `/uploads/chat/${storageFilename}`;

  // Create ChatFile record
  await prisma.chatFile.create({
    data: { messageId, url, thumbnailUrl, filename: originalFilename, mimeType, size: fileBuffer.length },
  });

  return { url, thumbnailUrl, filename: originalFilename, mimeType, size: fileBuffer.length };
}

export async function getChatStorageStats() {
  const files = await prisma.chatFile.findMany({ select: { size: true, mimeType: true } });
  const totalFiles = files.length;
  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const totalSizeMB = Math.round(totalSizeBytes / 1024 / 1024 * 100) / 100;

  const byType: Record<string, number> = {};
  for (const f of files) {
    const type = f.mimeType.split('/')[0] || 'other';
    byType[type] = (byType[type] || 0) + 1;
  }

  return { totalFiles, totalSizeMB, filesByType: byType };
}

export async function deleteChatFile(fileId: string) {
  const file = await prisma.chatFile.findUnique({ where: { id: fileId } });
  if (!file) return;

  // Delete physical files
  const filepath = path.join(__dirname, '../..', file.url);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  if (file.thumbnailUrl) {
    const thumbPath = path.join(__dirname, '../..', file.thumbnailUrl);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }

  await prisma.chatFile.delete({ where: { id: fileId } });
}
