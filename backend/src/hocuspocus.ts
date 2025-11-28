import { Server } from '@hocuspocus/server';
import { Logger } from '@hocuspocus/extension-logger';
import { Database } from '@hocuspocus/extension-database';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

export const hocuspocus = new Server({
  port: 1234,
  extensions: [
    new Logger(),
    new Database({
      fetch: async ({ documentName }) => {
        const note = await prisma.note.findUnique({
          where: { id: documentName },
          select: { content: true },
        });

        if (note && note.content) {
          try {
            const json = JSON.parse(note.content);
            const doc = TiptapTransformer.toYdoc(json, 'default');
            return Y.encodeStateAsUpdate(doc);
          } catch (e) {
            console.error('Failed to parse note content', e);
          }
        }
        return null;
      },
      store: async ({ documentName, state }) => {
        // state is a Buffer/Uint8Array
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(state));

        const json = TiptapTransformer.fromYdoc(doc, 'default');

        await prisma.note.update({
          where: { id: documentName },
          data: {
            content: JSON.stringify(json),
            updatedAt: new Date(),
          },
        });
      },
    }),
  ],

  async onAuthenticate(data) {
    const { token } = data;

    if (!token) {
      throw new Error('Not authorized');
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;

      const noteId = data.documentName;
      const userId = decoded.id || decoded.userId;

      const note = await prisma.note.findUnique({
        where: { id: noteId },
        include: { sharedWith: true },
      });

      if (!note) {
        throw new Error('Note not found');
      }

      const isOwner = note.userId === userId;
      const isShared = note.sharedWith.some(share => share.userId === userId);

      if (!isOwner && !isShared) {
        throw new Error('Forbidden');
      }

      return {
        user: {
          id: userId,
          name: decoded.name || 'User',
        },
      };

    } catch (err) {
      throw new Error('Not authorized');
    }
  },
});
