import { Server } from '@hocuspocus/server';
import { Logger } from '@hocuspocus/extension-logger';
import { Database } from '@hocuspocus/extension-database';
import { TiptapTransformer } from '@hocuspocus/transformer';
import prisma from './plugins/prisma';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { extractTextFromTipTapJson } from './utils/extractText';
import logger from './utils/logger';
import { guardEmptyContentOverwrite } from './utils/contentGuard';
import { isDegenerateTipTapJson } from './utils/ydocIntegrity';
import { snapshotPreviousVersion } from './services/noteVersion.service';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { FontFamily } from '@tiptap/extension-font-family';
// import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Node, Extension } from '@tiptap/core';
import type { SharedNote } from '@prisma/client';

interface JwtPayload {
  id?: string;
  userId?: string;
  email: string;
  role: string;
  tokenVersion?: number;
}

// Per-user WebSocket connection limiter
const MAX_WS_CONNECTIONS_PER_USER = 10;
const userWsConnections = new Map<string, number>();

function trackWsConnect(userId: string): boolean {
  const current = userWsConnections.get(userId) ?? 0;
  if (current >= MAX_WS_CONNECTIONS_PER_USER) return false;
  userWsConnections.set(userId, current + 1);
  return true;
}

function trackWsDisconnect(userId: string): void {
  const current = userWsConnections.get(userId) ?? 1;
  if (current <= 1) userWsConnections.delete(userId);
  else userWsConnections.set(userId, current - 1);
}

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
            parseHTML: (element: HTMLElement) => element.style?.fontSize?.replace(/['"]+/g, ''),
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
        parseHTML: (element: HTMLElement) => element.style.borderStyle,
        renderHTML: (attributes) => {
          if (!attributes.borderStyle) return {};
          return { style: `border-style: ${attributes.borderStyle}` };
        },
      },
      borderColor: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.borderColor,
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
        parseHTML: (element: HTMLElement) => element.style.borderStyle,
        renderHTML: (attributes) => {
          if (!attributes.borderStyle) return {};
          return { style: `border-style: ${attributes.borderStyle}` };
        },
      },
      borderColor: {
        default: null,
        parseHTML: (element: HTMLElement) => element.style.borderColor,
        renderHTML: (attributes) => {
          if (!attributes.borderColor) return {};
          return { style: `border-color: ${attributes.borderColor}` };
        },
      },
    };
  },
});

// Mirror of frontend Table.extend — preserves tableWidth attr during Hocuspocus persistence
const CustomTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tableWidth: {
        default: null, // null = AUTO (100%), 'free' = column-based
        parseHTML: (element: HTMLElement) => {
          const w = element.getAttribute('data-table-width');
          if (w === 'free') return 'free';
          return null; // default AUTO
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          if (attributes.tableWidth === 'free') {
            return { 'data-table-width': 'free' };
          }
          return { style: 'width: 100%' }; // AUTO
        },
      },
    };
  },
}).configure({
  resizable: true,
});

// Mirror of frontend TableRow.extend — preserves rowHeight attr during Hocuspocus persistence
const CustomTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      rowHeight: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const h = element.style.height;
          return (h && h !== 'auto') ? h : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.rowHeight) return {};
          return { style: `height: ${attributes.rowHeight}` };
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
      defaultLineHeight: '0.5',
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (element: HTMLElement) => element.style.lineHeight || null,
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
  CustomTable,
  CustomTableRow,
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
  Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        width: {
          default: null,
          parseHTML: (element: HTMLElement) => element.style?.width || element.getAttribute('width') || null,
          renderHTML: (attributes: Record<string, string | null>) => {
            if (!attributes.width) return {};
            return { style: `width: ${attributes.width}` };
          },
        },
      };
    },
  }).configure({ inline: true }),
];




export function getWsConnectionCount(): number {
  return hocuspocus.hocuspocus.getConnectionsCount();
}

/**
 * Kick every live collaboration session a user holds on one note.
 *
 * onAuthenticate resolves note access ONCE, at connect, and Hocuspocus never re-checks
 * it: a collaborator whose share is revoked keeps `readOnly === false` on the live
 * Connection and goes on WRITING to the note until they close the tab. Every site that
 * removes or suspends note access has to call this. Mirrors disconnectUser() in
 * kanbanSSE.ts, which does the same job for the board event streams.
 *
 * Connection.close() deliberately does NOT close the WebSocket: it removes the
 * connection from the Document and sends a CLOSE message. That is what we want — the
 * updates stop reaching the document immediately (so they are never persisted), and the
 * client does not enter a reconnect loop, because the provider only retries on a real
 * socket close. On the client the provider drops to isSynced === false, which makes
 * NoteEditor fall back to the REST save path — where the share IS re-checked per
 * request, and answers 403.
 */
export function disconnectUserFromNote(noteId: string, userId: string): void {
  try {
    const document = hocuspocus.hocuspocus.documents.get(noteId);
    if (!document) return;
    for (const connection of document.getConnections()) {
      if (connection.context?.user?.id === userId) {
        connection.close({ code: 4403, reason: 'Forbidden' });
      }
    }
  } catch (err) {
    logger.error({ err, noteId, userId }, 'disconnectUserFromNote failed — revoked user may still hold a live session');
  }
}

/**
 * Kick every collaboration session a user holds, on every note.
 *
 * Called where a user's credentials stop being valid, rather than where one share
 * changes: a password change or reset bumps tokenVersion, which makes onAuthenticate
 * refuse NEW connections but says nothing about the ones already open — those were
 * authorized once, at connect. Without this, someone who changes their password
 * precisely because they think a session was stolen leaves the thief editing every
 * note they had open.
 */
export function disconnectUserEverywhere(userId: string): void {
  try {
    for (const noteId of hocuspocus.hocuspocus.documents.keys()) {
      disconnectUserFromNote(noteId, userId);
    }
  } catch (err) {
    logger.error({ err, userId }, 'disconnectUserEverywhere failed — user may still hold live sessions');
  }
}

/**
 * Note.content (TipTap JSON string, or legacy HTML/plain text) -> Yjs state update.
 * Shared by the Database `fetch` and replaceLiveDocContent. Returns null when conversion fails.
 */
function contentToYdocState(content: string): Uint8Array | null {
  try {
    const json = JSON.parse(content);
    // @ts-ignore — TiptapTransformer API types incomplete
    const doc = TiptapTransformer.toYdoc(json, 'default', extensions);
    const state = Y.encodeStateAsUpdate(doc);
    return state;
  } catch (e) {
    logger.error(e, 'Failed to parse note content as JSON, attempting fallback');
    try {
      const text = content.replace(/<[^>]*>/g, ' ').trim();
      const json = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: text || ' ' }] }],
      };
      // @ts-ignore — TiptapTransformer API types incomplete
      const tiptapDoc = TiptapTransformer.toYdoc(json, 'default', extensions);
      return Y.encodeStateAsUpdate(tiptapDoc);
    } catch (err) {
      logger.error(err, 'Failed to convert legacy content');
    }
  }
  return null;
}

/**
 * Swap the content of a note's LIVE collab doc (no-op when nobody has it open or loading it).
 * A REST write to Note.content is invisible to a loaded Y doc: its next store() writes the
 * old in-memory state back. One Yjs transaction: clients get a single update and never see
 * an empty fragment (Editor.tsx injection guard). Nodes are cloned BEFORE mutating, so a
 * failure never leaves an empty fragment.
 * Context { restore: true } on purpose: NO `user` -> onDisconnect does not touch the per-user
 * WS counter; the Database `store` (also triggered by transact/disconnect, which pass the same
 * context) skips snapshotPreviousVersion, because restoreNoteVersion already archived the
 * pre-restore content and a second snapshot would only add the stale in-memory state.
 * Note: client edits arriving in the few ms between flushLiveDoc and this swap are discarded by
 * the swap and NOT archived (accepted window).
 */
export async function replaceLiveDocContent(noteId: string, content: string): Promise<void> {
  const inner = hocuspocus.hocuspocus;
  if (!inner.documents.has(noteId) && !inner.loadingDocuments.has(noteId)) return;
  const state = contentToYdocState(content);
  if (!state) throw new Error('replaceLiveDocContent: restored content could not be converted');
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, state);
  const nodes = tmp.getXmlFragment('default').toArray().map((n) => n.clone()) as Array<Y.XmlElement | Y.XmlText>;
  if (nodes.length === 0) throw new Error('replaceLiveDocContent: restored content has no nodes');
  const connection = await inner.openDirectConnection(noteId, { restore: true });
  try {
    await connection.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        fragment.delete(0, fragment.length);
        // Y types cannot move between docs: clone() = unintegrated deep copy.
        fragment.insert(0, nodes);
      });
    });
  } finally {
    await connection.disconnect();
  }
}

/**
 * Force-persist a note's LIVE collab doc (no-op when nobody has it open or loading it).
 * Unsaved client edits live only in memory until the store debounce fires (up to ~10s); a restore
 * archives the DB content, so without this flush those edits would be swapped away unarchived.
 * Context { restore: true } (no `user`): the store persists but skips snapshotPreviousVersion, because
 * restoreNoteVersion's forced snapshot archives the flushed content after its re-read (no duplicates).
 * DirectConnection.transact always runs the store hooks immediately.
 * Vault docs are never live (onAuthenticate refuses them, store refuses isVault writes).
 */
export async function flushLiveDoc(noteId: string): Promise<void> {
  const inner = hocuspocus.hocuspocus;
  if (!inner.documents.has(noteId) && !inner.loadingDocuments.has(noteId)) return;
  const connection = await inner.openDirectConnection(noteId, { restore: true });
  try {
    await connection.transact(() => {});
  } finally {
    await connection.disconnect();
  }
}

export const hocuspocus = new Server({
  // port: 1234, // Removed to prevent standalone listening
  extensions: [
    new Logger(),
    new Database({

      fetch: async ({ documentName }) => {
        const note = await prisma.note.findUnique({
          where: { id: documentName },
          select: { content: true, ydocState: true },
        });

        if (!note) return null;

        // If we have stored Yjs binary state, use it — but only if it decodes to
        // a non-degenerate doc. A corrupt ydocState over good content is exactly
        // what rendered notes blank (2026-06 incident); fall through to content.
        if (note.ydocState) {
          try {
            const probe = new Y.Doc();
            Y.applyUpdate(probe, new Uint8Array(note.ydocState));
            // @ts-ignore — TiptapTransformer API types incomplete
            const probeJson = TiptapTransformer.fromYdoc(probe, 'default', extensions);
            const ydocLooksEmpty = isDegenerateTipTapJson(probeJson);
            const contentSubstantial = (note.content?.length ?? 0) > 150;
            if (!(ydocLooksEmpty && contentSubstantial)) {
              return new Uint8Array(note.ydocState);
            }
            logger.warn({ documentName }, 'Hocuspocus fetch: degenerate ydocState over substantial content — rebuilding from content');
          } catch (err) {
            logger.error({ err, documentName }, 'Hocuspocus fetch: ydocState failed to decode — rebuilding from content');
          }
        }

        // Fallback: convert JSON content to Yjs (for notes without ydocState yet)
        if (note.content) {
          return contentToYdocState(note.content);
        }
        return null;
      },
      store: async ({ documentName, state, context }) => {
        try {
          // state is a Buffer/Uint8Array
          const doc = new Y.Doc();
          Y.applyUpdate(doc, new Uint8Array(state));

          // @ts-ignore — TiptapTransformer API types incomplete
          const json = TiptapTransformer.fromYdoc(doc, 'default', extensions);
          const contentStr = JSON.stringify(json);

          // [BACKUP] 2026-06-10 — inline <150 guard replaced by shared guard + try/catch
          const existing = await prisma.note.findUnique({
            where: { id: documentName },
            select: { content: true, title: true, isVault: true },
          });

          // Vault notes are E2E client-side and only saved via REST by the owner: never persist a Yjs state over them.
          if (existing?.isVault) {
            logger.warn({ documentName }, 'Hocuspocus store: vault note — skipping write');
            return;
          }

          // Integrity: never replace good content with a degenerate doc (empty/paragraph-only).
          if (isDegenerateTipTapJson(json) && (existing?.content?.length ?? 0) > 150) {
            logger.warn({ documentName }, 'Hocuspocus store: degenerate doc over substantial content — skipping write');
            return;
          }

          if (guardEmptyContentOverwrite(existing?.content, contentStr) === undefined) {
            logger.warn(
              { documentName, newLen: contentStr.length, oldLen: existing?.content?.length ?? 0 },
              'Hocuspocus store: blocked empty content overwrite',
            );
            return;
          }

          const searchText = extractTextFromTipTapJson(contentStr);

          // Conditional write: a store already in flight when the note moved into the vault
          // (the read above is stale by then) must not write. isVault is re-checked atomically here.
          try {
            const { count } = await prisma.note.updateMany({
              where: { id: documentName, isVault: false },
              data: {
                content: contentStr,
                ydocState: Buffer.from(state),
                searchText,
                updatedAt: new Date(),
              },
            });
            if (count === 0) {
              logger.warn({ documentName }, 'Hocuspocus store: note moved into the vault (or gone) while storing — write and snapshot skipped');
              return;
            }
          } catch (err) {
            // Never let a persistence failure become an unhandled rejection inside
            // the extension — log loudly; the client keeps the edit in its Yjs doc
            // and the next change retries.
            logger.error({ err, documentName }, 'Hocuspocus store: prisma.note.updateMany FAILED — edit not persisted');
            return;
          }

          // Versioning is best-effort and runs AFTER the conditional write: a vault note (count 0 above)
          // never gets a new snapshot. A snapshot failure never loses the edit.
          try {
            // restore (replaceLiveDocContent): restoreNoteVersion already archived the pre-restore content
            if (!context?.restore) await snapshotPreviousVersion(prisma, documentName, existing?.content, existing?.title ?? '');
          } catch (snapErr) {
            logger.warn({ snapErr, documentName }, 'Hocuspocus store: snapshot failed — edit already saved');
          }
        } catch (err) {
          logger.error({ err, documentName }, 'Hocuspocus store: unexpected failure — edit not persisted this cycle');
        }
      },
    }),
  ],

  async onAuthenticate(data) {
    const { token } = data;

    if (!token) {
      throw new Error('Not authorized');
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

      const noteId = data.documentName;
      const userId = decoded.id || decoded.userId;

      const note = await prisma.note.findUnique({
        where: { id: noteId },
        include: { sharedWith: true },
      });

      if (!note) {
        throw new Error('Note not found');
      }

      // Vault notes never go through collaboration (not even for the owner: they save via REST).
      if (note.isVault) throw new Error('Forbidden');

      const isOwner = note.userId === userId;
      const share = note.sharedWith.find((s: SharedNote) => s.userId === userId && s.status === 'ACCEPTED');
      const isShared = !!share;

      if (!isOwner && !isShared) {
        throw new Error('Forbidden');
      }

      const readOnly = !isOwner && share?.permission === 'READ';

      if (!userId) {
        throw new Error('Not authorized');
      }

      // [BACKUP] 2026-09-01 — this lookup ran AFTER trackWsConnect and selected only
      // name/color/avatarUrl. It now runs first and also reads tokenVersion, so an
      // invalidated token is rejected without having to unwind the connection counter.
      // Fetch user details for awareness (color + avatar), plus tokenVersion.
      const userDetails = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, color: true, avatarUrl: true, tokenVersion: true },
      });

      // app.ts checks tokenVersion on every REST request (app.ts:171-178); this hook
      // never did — the field was declared on JwtPayload and never compared to anything
      // — so a token stolen before a password change or reset went on opening NEW
      // collaboration sessions forever, while every REST call answered 401.
      if (!userDetails || (decoded.tokenVersion !== undefined && userDetails.tokenVersion !== decoded.tokenVersion)) {
        throw new Error('Token invalidated');
      }

      // Per-user connection limit
      if (!trackWsConnect(userId)) {
        throw new Error('Too many concurrent connections');
      }

      return {
        user: {
          id: userId,
          name: userDetails?.name || 'User',
          color: userDetails?.color || '#319795',
          avatarUrl: userDetails?.avatarUrl || null,
        },
        readOnly,
      };

    } catch (_err) {
      throw new Error('Not authorized'); // Intentionally generic — don't expose auth details to WS client
    }
  },

  async onDisconnect(data) {
    const userId = data.context?.user?.id;
    if (userId) trackWsDisconnect(userId);
  },
});
