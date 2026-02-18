import prisma from '../plugins/prisma';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import util from 'util';
import { v4 as uuidv4 } from 'uuid';
import { MultipartFile } from '@fastify/multipart';
import crypto from 'crypto';

const pump = util.promisify(pipeline);
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'video/mp4', 'video/webm',
]);
const BLOCKED_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.sh', '.html', '.htm', '.php', '.js', '.mjs']);

export const saveAttachment = async (file: MultipartFile, noteId: string) => {
  // Validate file type
  const ext = path.extname(file.filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) throw new Error('File type not allowed');
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) throw new Error('MIME type not allowed');

  // Check Quota
  const QUOTA_MB = parseInt(process.env.NOTE_ATTACHMENT_QUOTA_MB || '10');
  const MAX_BYTES = QUOTA_MB * 1024 * 1024;

  const currentAttachments = await prisma.attachment.findMany({
    where: { noteId, isLatest: true },
    select: { size: true }
  });

  const totalSize = currentAttachments.reduce((acc, curr) => acc + curr.size, 0);

  // We don't know the file size exactly until we read it, but Fastify Multipart gives us a stream.
  // We can count bytes as we pipe.
  // OR we can rely on a soft check if we can't know size beforehand.
  // But wait, we calculate size during streaming in the code below.
  // So we will throw AFTER streaming if size > limit? That's wasteful but accurate.
  // Or do we check Request Header Content-Length? It might be for the whole body (multiple files).
  // Let's implement the check *during* stream (in the promise).

  const originalFilename = file.filename;
  const extension = path.extname(originalFilename);
  const storageFilename = `${uuidv4()}${extension}`;
  const filepath = path.join(UPLOAD_DIR, storageFilename);

  // Create hash and write stream
  const hash = crypto.createHash('sha256');
  const writeStream = fs.createWriteStream(filepath);
  let size = 0;

  // Pass through stream to calculate hash and size while writing
  try {
    await new Promise((resolve, reject) => {
      file.file.on('data', (chunk) => {
        size += chunk.length;
        if (totalSize + size > MAX_BYTES) {
          // Quota exceeded
          file.file.destroy(); // Stop reading
          writeStream.destroy();
          // We should cleanup later (unlink is handled if error is caught?)
          // We need to reject with a specific error
          reject(new Error('QUOTA_EXCEEDED'));
        }
        hash.update(chunk);
      });

      file.file.pipe(writeStream)
        .on('finish', () => resolve(true))
        .on('error', reject);
    });
  } catch (error) {
    // Clean up the partially written file if an error occurred (e.g., QUOTA_EXCEEDED)
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    throw error; // Re-throw the error after cleanup
  }


  const fileHash = hash.digest('hex');

  // Check for existing latest version
  const existingLatest = await prisma.attachment.findFirst({
    where: {
      noteId,
      filename: originalFilename,
      isLatest: true,
    },
  });

  if (existingLatest) {
    // Idempotency check: if content is identical, return existing
    if (existingLatest.hash === fileHash) {
      // Delete the duplicate file we just wrote
      fs.unlinkSync(filepath);
      return existingLatest;
    }

    // Mark old version as not latest
    await prisma.attachment.update({
      where: { id: existingLatest.id },
      data: { isLatest: false },
    });

    // Create new version
    return prisma.attachment.create({
      data: {
        noteId,
        url: `/uploads/${storageFilename}`,
        filename: originalFilename,
        mimeType: file.mimetype,
        size,
        version: existingLatest.version + 1,
        hash: fileHash,
        isLatest: true,
      },
    });
  }

  // Create first version
  return prisma.attachment.create({
    data: {
      noteId,
      url: `/uploads/${storageFilename}`,
      filename: originalFilename,
      mimeType: file.mimetype,
      size,
      version: 1,
      hash: fileHash,
      isLatest: true,
    },
  });
};

export const getAttachments = async (noteId: string) => {
  return prisma.attachment.findMany({
    where: {
      noteId,
      isLatest: true // Only return latest versions by default
    },
    orderBy: { createdAt: 'desc' }
  });
};

export const getAttachmentHistory = async (noteId: string, filename: string) => {
  return prisma.attachment.findMany({
    where: {
      noteId,
      filename
    },
    orderBy: { version: 'desc' }
  });
};

export const deleteAttachment = async (id: string) => {
  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment) return;

  // Delete from disk
  const filename = path.basename(attachment.url);
  const filepath = path.join(UPLOAD_DIR, filename);

  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }

  // If we delete the latest, should we promote the previous one?
  // For now, simple delete. Ideally, we might want to "restore" previous version or delete all versions.
  // Let's assume deleting a specific attachment ID just deletes that version.
  // If the user wants to delete the "file", they might expect all versions to go.
  // But the UI usually shows the list of files.
  return prisma.attachment.delete({ where: { id } });
};

// Helper for downloads
export const getAttachmentPath = (url: string) => {
  const filename = path.basename(url);
  return path.join(UPLOAD_DIR, filename);
};
