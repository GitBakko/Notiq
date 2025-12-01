import { Server } from '@hocuspocus/server';
import { Logger } from '@hocuspocus/extension-logger';
import { Database } from '@hocuspocus/extension-database';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import { Node, Extension } from '@tiptap/core';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Define custom extensions to match frontend
const EncryptedBlock = Node.create({
  name: 'encryptedBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      ciphertext: {
        default: '',
      },
    }
  },
  parseHTML() {
    return [{ tag: 'encrypted-block' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['encrypted-block', HTMLAttributes]
  },
});

const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return {
      types: ['textStyle'],
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize?.replace(/['"]+/g, ''),
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
});

export const extensions = [
  StarterKit,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TextAlign,
  TextStyle,
  FontFamily,
  FontSize,
  Link,
  EncryptedBlock,
];

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
            // @ts-ignore
            const doc = TiptapTransformer.toYdoc(json, 'default', extensions);
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

        // @ts-ignore
        const json = TiptapTransformer.fromYdoc(doc, 'default', extensions);

        // Safeguard: Do not overwrite existing content with empty content if the existing content is recent
        const currentNote = await prisma.note.findUnique({ where: { id: documentName } });

        const isNewContentEmpty = !json.content || json.content.length === 0 || (json.content.length === 1 && json.content[0].type === 'paragraph' && (!json.content[0].content || json.content[0].content.length === 0));

        if (currentNote && currentNote.content && currentNote.content !== '' && currentNote.content !== '<p></p>' && currentNote.content !== '{"type":"doc","content":[{"type":"paragraph"}]}') {
          // DB has content.
          if (isNewContentEmpty) {
            // Check if DB update was recent (e.g. < 5 seconds)
            const timeDiff = new Date().getTime() - currentNote.updatedAt.getTime();
            if (timeDiff < 5000) {
              return;
            }
          }
        }

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
