import { FastifyInstance } from 'fastify';
import { saveAttachment, getAttachments, deleteAttachment, getAttachmentHistory, getAttachmentPath } from '../services/attachment.service';
import { checkNoteAccess } from '../services/note.service';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import prisma from '../plugins/prisma';

export async function attachmentRoutes(app: FastifyInstance) {
  // POST /api/attachments?noteId=... - Upload attachment
  app.post('/', { preValidation: [app.authenticate] }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ message: 'No file uploaded' });
    }

    // We expect noteId as a field, but multipart handling is tricky.
    // fastify-multipart handles fields and files.
    // Let's assume noteId is passed as a query param for simplicity or we parse fields.
    // But request.file() returns the first file.
    // If we use request.parts(), we can iterate.
    // For MVP, let's use query param for noteId.

    // Actually, let's try to get the noteId from the fields if possible, 
    // but request.file() consumes the stream.
    // Let's use query param: POST /api/attachments?noteId=...

    const { noteId } = request.query as { noteId: string };
    if (!noteId) {
      return reply.status(400).send({ message: 'noteId is required' });
    }

    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });
    if (access === 'READ') return reply.code(403).send({ message: 'Read-only access' });

    const attachment = await saveAttachment(data, noteId);
    return attachment;
  });

  // GET /api/attachments/:noteId - Get all attachments for a note
  app.get('/:noteId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });
    const attachments = await getAttachments(noteId);
    return attachments;
  });

  // GET /api/attachments/:noteId/history?filename=... - Get version history
  app.get('/:noteId/history', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const { filename } = request.query as { filename: string };

    if (!filename) {
      return reply.status(400).send({ message: 'filename query param is required' });
    }

    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });

    const history = await getAttachmentHistory(noteId, filename);
    return history;
  });

  // GET /api/attachments/download/:id - Download single file with original filename
  app.get('/download/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.attachment.findUnique({ where: { id } });

    if (!attachment) {
      return reply.status(404).send({ message: 'Attachment not found' });
    }

    const access = await checkNoteAccess(request.user.id, attachment.noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });

    const filepath = getAttachmentPath(attachment.url);
    if (!fs.existsSync(filepath)) {
      return reply.status(404).send({ message: 'File not found on disk' });
    }

    const filename = encodeURIComponent(attachment.filename);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    reply.header('Content-Type', attachment.mimeType);

    const stream = fs.createReadStream(filepath);
    return reply.send(stream);
  });

  // GET /api/attachments/download-all/:noteId - Zip download
  app.get('/download-all/:noteId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });
    const attachments = await getAttachments(noteId); // Gets latest versions

    if (!attachments || attachments.length === 0) {
      return reply.status(404).send({ message: 'No attachments found' });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', 'attachment; filename="attachments.zip"');

    const archive = archiver('zip', {
      zlib: { level: 9 } // Sets the compression level.
    });

    archive.on('error', (err: Error) => {
      request.log.error(err);
      if (!reply.raw.headersSent) {
        reply.status(500).send({ message: 'Archiving error' });
      }
    });

    // Pipe the archive to the response
    // Fastify supports sending streams
    // We define it before creating files

    // Note: reply.send(archive) works if archive is a readable stream. archiver is readable.

    // Handle duplicate names
    const nameMap = new Map<string, number>();

    for (const att of attachments) {
      const filepath = getAttachmentPath(att.url);
      if (fs.existsSync(filepath)) {
        let name = att.filename;

        // Duplicate handling
        if (nameMap.has(name)) {
          const count = nameMap.get(name)! + 1;
          nameMap.set(name, count);
          const ext = path.extname(name);
          const base = path.basename(name, ext);
          name = `${base} (${count})${ext}`;
        } else {
          nameMap.set(name, 0);
        }

        archive.file(filepath, { name });
      }
    }

    archive.finalize();
    return reply.send(archive);
  });

  // DELETE /api/attachments/:id - Delete attachment
  app.delete('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.attachment.findUnique({ where: { id } });
    if (!attachment) return reply.status(404).send({ message: 'Attachment not found' });

    const access = await checkNoteAccess(request.user.id, attachment.noteId);
    if (!access) return reply.code(403).send({ message: 'Forbidden' });
    if (access === 'READ') return reply.code(403).send({ message: 'Read-only access' });

    await deleteAttachment(id);
    return { message: 'Attachment deleted' };
  });
}
