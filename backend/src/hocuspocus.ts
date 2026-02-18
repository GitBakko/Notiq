import { Server } from '@hocuspocus/server';
import { Logger } from '@hocuspocus/extension-logger';
import { Database } from '@hocuspocus/extension-database';
import { TiptapTransformer } from '@hocuspocus/transformer';
import prisma from './plugins/prisma';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { extractTextFromTipTapJson } from './utils/extractText';
import logger from './utils/logger';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { FontFamily } from '@tiptap/extension-font-family';
// import Link from '@tiptap/extension-link';
import { Node, Extension } from '@tiptap/core';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

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
      createdBy: {
        default: null,
      }
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
            parseHTML: (element: any) => element.style?.fontSize?.replace(/['"]+/g, ''),
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

const CustomTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borderStyle: {
        default: null,
        parseHTML: (element: any) => element.style.borderStyle,
        renderHTML: (attributes) => {
          if (!attributes.borderStyle) return {};
          return { style: `border-style: ${attributes.borderStyle}` };
        },
      },
      borderColor: {
        default: null,
        parseHTML: (element: any) => element.style.borderColor,
        renderHTML: (attributes) => {
          if (!attributes.borderColor) return {};
          return { style: `border-color: ${attributes.borderColor}` };
        },
      },
    };
  },
});

const CustomTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borderStyle: {
        default: null,
        parseHTML: (element: any) => element.style.borderStyle,
        renderHTML: (attributes) => {
          if (!attributes.borderStyle) return {};
          return { style: `border-style: ${attributes.borderStyle}` };
        },
      },
      borderColor: {
        default: null,
        parseHTML: (element: any) => element.style.borderColor,
        renderHTML: (attributes) => {
          if (!attributes.borderColor) return {};
          return { style: `border-color: ${attributes.borderColor}` };
        },
      },
    };
  },
});



const LineHeight = Extension.create({
  name: 'lineHeight',

  addOptions() {
    return {
      types: ['paragraph', 'heading'],
      defaultLineHeight: '1.5',
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (element: any) => element.style.lineHeight || null,
            renderHTML: (attributes) => {
              if (!attributes.lineHeight) {
                return {};
              }
              return {
                style: `line-height: ${attributes.lineHeight}`,
              };
            },
          },
        },
      },
    ];
  },
});

export const extensions = [
  StarterKit,
  Table.configure({
    resizable: true,
  }),
  TableRow,
  CustomTableHeader,
  CustomTableCell,
  TextAlign.configure({
    types: ['heading', 'paragraph'],
  }),
  TextStyle,
  FontFamily,
  FontSize,
  // Link, // Removed as it is included in StarterKit v3 or causes duplicate warning
  EncryptedBlock,
  LineHeight,
];




export const hocuspocus = new Server({
  // port: 1234, // Removed to prevent standalone listening
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
            logger.error(e, 'Failed to parse note content as JSON, attempting fallback');
            // Fallback for legacy HTML content
            try {
              const doc = new Y.Doc();
              const text = note.content.replace(/<[^>]*>/g, ' ').trim(); // Simple strip tags

              // Create a basic document structure
              const json = {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        type: 'text',
                        text: text || ' ', // Ensure at least some text
                      },
                    ],
                  },
                ],
              };

              // @ts-ignore
              const tiptapDoc = TiptapTransformer.toYdoc(json, 'default', extensions);
              return Y.encodeStateAsUpdate(tiptapDoc);
            } catch (err) {
              logger.error(err, 'Failed to convert legacy content');
            }
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
        const contentStr = JSON.stringify(json);
        const searchText = extractTextFromTipTapJson(contentStr);

        await prisma.note.update({
          where: { id: documentName },
          data: {
            content: contentStr,
            searchText,
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
      const share = note.sharedWith.find((s: any) => s.userId === userId && s.status === 'ACCEPTED');
      const isShared = !!share;

      if (!isOwner && !isShared) {
        throw new Error('Forbidden');
      }

      const readOnly = !isOwner && share?.permission === 'READ';

      return {
        user: {
          id: userId,
          name: decoded.name || 'User',
        },
        readOnly,
      };

    } catch (err) {
      throw new Error('Not authorized');
    }
  },
});
