import { FastifyInstance } from 'fastify';
import { saveAttachment, getAttachments, deleteAttachment, getAttachmentHistory } from '../services/attachment.service';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

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

    const attachment = await saveAttachment(data, noteId);
    return attachment;
  });

  // GET /api/attachments/:noteId - Get all attachments for a note
  app.get('/:noteId', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
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

    const history = await getAttachmentHistory(noteId, filename);
    return history;
  });

  // DELETE /api/attachments/:id - Delete attachment
  app.delete('/:id', { preValidation: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteAttachment(id);
    return { message: 'Attachment deleted' };
  });
}
