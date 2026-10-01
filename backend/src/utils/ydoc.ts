import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import logger from './logger';
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
import { Node, Extension, getSchema } from '@tiptap/core';

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

/**
 * Note.content (TipTap JSON string, or legacy HTML/plain text) -> Yjs state update.
 * Shared by the Database `fetch` and replaceLiveDocContent. Returns null when conversion fails.
 */
export function contentToYdocState(content: string): Uint8Array | null {
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

type TopLevelNode = Y.XmlElement | Y.XmlText;
type TipTapDocJson = { content?: unknown[] };

// Computed once (lazily, on first strict conversion): ProseMirror schema of the shared extensions, used to
// validate structure before toYdoc. Lazy so modules that mock @tiptap/core do not break at import time.
let pmSchemaCache: ReturnType<typeof getSchema> | undefined;
const pmSchema = () => (pmSchemaCache ??= getSchema(extensions));

/**
 * G5: legacy docs sometimes carry inline nodes (text, image...) directly under the root, which check() rejects.
 * Wrap each run of consecutive top-level inline nodes in one paragraph (in place). Anything else is left as is.
 */
function wrapTopLevelInline(json: any): void {
  if (!Array.isArray(json?.content)) return;
  const nodes = pmSchema().nodes;
  const out: any[] = [];
  let run: any[] | null = null;
  for (const n of json.content) {
    if (n?.type === 'text' || nodes[n?.type]?.isInline) {
      if (!run) out.push({ type: 'paragraph', content: (run = []) });
      run.push(n);
    } else {
      run = null;
      out.push(n);
    }
  }
  json.content = out;
}

/**
 * STRICT content -> Y doc: JSON.parse + schema validation + toYdoc, null if any throws (unknown node, legacy HTML,
 * structurally invalid doc such as text or a listItem at the root). No text fallback.
 */
function strictContentToYDoc(content: string): Y.Doc | null {
  try {
    const json = JSON.parse(content);
    wrapTopLevelInline(json);
    // toYdoc alone accepts structurally invalid trees (it only maps nodes); check() enforces the content model.
    pmSchema().nodeFromJSON(json).check();
    // @ts-ignore — TiptapTransformer API types incomplete
    return TiptapTransformer.toYdoc(json, 'default', extensions) as Y.Doc;
  } catch {
    return null;
  }
}

// @ts-ignore — TiptapTransformer API types incomplete
const docToJson = (doc: Y.Doc): TipTapDocJson => TiptapTransformer.fromYdoc(doc, 'default', extensions) as TipTapDocJson;

/**
 * STRICT conversion for REST writers that must not persist garbage: unlike contentToYdocState it never
 * falls back to a text paragraph, so legacy HTML or a node this schema does not know yields null.
 * Returns unintegrated clones (Y types cannot move between docs), ready for fragment.insert.
 */
export function contentToYNodes(content: string): Array<TopLevelNode> | null {
  const doc = strictContentToYDoc(content);
  if (!doc) return null;
  return doc.getXmlFragment('default').toArray().map((n) => n.clone()) as Array<TopLevelNode>;
}

const REBASE_MAX_LEN = 256 * 1024; // absolute cap on both the old Y state and the new content

/**
 * New ydocState for a REST content write, built ON TOP of the old Y state so a client still holding the
 * old Y doc merges into it instead of duplicating every block (a state rebuilt from content has fresh
 * client ids). Only the top-level nodes that differ (common prefix/suffix kept) are replaced, in one
 * transaction. Never throws; null whenever in doubt (caller then stores ydocState = null).
 * A returned state always decodes to the NORMALIZED form of `newContent` as produced by the schema (e.g. top-level
 * inline nodes wrapped in a paragraph), verified before returning; not necessarily to the literal JSON written.
 * Accepted loss: offline edits of a stale client INSIDE a replaced block disappear.
 */
export function rebaseYdocState(
  old: Uint8Array | null | undefined,
  newContent: string,
): Uint8Array<ArrayBuffer> | null {
  try {
    if (!old || old.length === 0) return null;
    if (old.length > REBASE_MAX_LEN || newContent.length > REBASE_MAX_LEN) {
      logger.warn({ oldLen: old.length, newLen: newContent.length }, 'rebaseYdocState: state or content above cap — dropping it');
      return null;
    }

    const newDoc = strictContentToYDoc(newContent);
    if (!newDoc) return null;
    const newNodes = newDoc.getXmlFragment('default').toArray();
    const newItems = docToJson(newDoc).content ?? [];
    if (newNodes.length === 0 || newItems.length !== newNodes.length) return null;

    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(old));
    // A partial doc (missing deps) must be discarded, not patched.
    if (doc.store.pendingStructs || doc.store.pendingDs) return null;

    const frag = doc.getXmlFragment('default');
    const oldItems = docToJson(doc).content ?? [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    const oldLen = frag.length;
    const newLen = newNodes.length;
    let p = 0;
    let s = 0;
    if (oldItems.length === oldLen) {
      const max = Math.min(oldLen, newLen);
      while (p < max && same(oldItems[p], newItems[p])) p++;
      while (s < max - p && same(oldItems[oldLen - 1 - s], newItems[newLen - 1 - s])) s++;
    }

    if (!(p === oldLen && p === newLen)) {
      const insert = newNodes.slice(p, newLen - s).map((n) => n.clone()) as Array<TopLevelNode>;
      doc.transact(() => {
        frag.delete(p, oldLen - p - s);
        frag.insert(p, insert);
      });
    }

    if (!same(docToJson(doc).content ?? [], newItems)) {
      logger.warn('rebaseYdocState: rebased doc does not match new content — dropping state');
      return null;
    }
    return new Uint8Array(Y.encodeStateAsUpdate(doc));
  } catch (err) {
    logger.warn({ err }, 'rebaseYdocState failed — dropping state');
    return null;
  }
}
