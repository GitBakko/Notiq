import { XMLParser } from 'fast-xml-parser';
import prisma from '../plugins/prisma';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { generateJSON } from '@tiptap/core';
import { extensions } from '../hocuspocus';
import { JSDOM } from 'jsdom';
import { extractTextFromTipTapJson } from '../utils/extractText';
import logger from '../utils/logger';

// --- DOM polyfill for generateJSON (requires window.DOMParser) ---
function withDomEnvironment<T>(fn: () => T): T {
  const dom = new JSDOM('');
  const origWindow = (globalThis as any).window;
  (globalThis as any).window = dom.window;
  try {
    return fn();
  } finally {
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
  }
}

// --- Interfaces ---
interface EnexResource {
  data: {
    '#text': string; // base64
    encoding?: string;
  };
  mime: string;
  width?: number;
  height?: number;
  'resource-attributes'?: {
    'file-name'?: string;
  };
}

interface EnexNote {
  title: string;
  content: string;
  created?: string;
  updated?: string;
  tag?: string | string[];
  resource?: EnexResource | EnexResource[];
  'note-attributes'?: {
    'source-url'?: string;
  };
}

// --- Main export ---
const MAX_IMPORT_SIZE = 10 * 1024 * 1024; // 10MB

export const importFromEnex = async (fileBuffer: Buffer, userId: string, targetNotebookId?: string, isVault: boolean = false) => {
  if (fileBuffer.length > MAX_IMPORT_SIZE) {
    throw new Error('Import file exceeds maximum size limit');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    processEntities: false,
  });

  const xmlData = parser.parse(fileBuffer);

  if (!xmlData['en-export'] || !xmlData['en-export'].note) {
    throw new Error('Invalid ENEX file format');
  }

  const notes = Array.isArray(xmlData['en-export'].note)
    ? xmlData['en-export'].note
    : [xmlData['en-export'].note];

  let importedCount = 0;

  for (const enexNote of notes as EnexNote[]) {
    try {
      await processEnexNote(enexNote, userId, targetNotebookId, isVault);
      importedCount++;
    } catch (e) {
      logger.error(e, 'Failed to import note: %s', enexNote.title);
    }
  }

  return { importedCount, totalFound: notes.length };
};

// --- Helpers ---
const formatEnexDate = (dateStr: string) => {
  if (!dateStr || dateStr.length < 15) return new Date();
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  const hour = dateStr.substring(9, 11);
  const min = dateStr.substring(11, 13);
  const sec = dateStr.substring(13, 15);
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
};

// --- Process single note ---
const processEnexNote = async (enexNote: EnexNote, userId: string, targetNotebookId?: string, isVault: boolean = false) => {

  // ============================================================
  // 1. PROCESS TAGS (unchanged)
  // ============================================================
  const noteTags: string[] = [];
  if (enexNote.tag) {
    const tags = Array.isArray(enexNote.tag) ? enexNote.tag : [enexNote.tag];
    for (const tagName of tags) {
      if (typeof tagName !== 'string') continue;

      let tag = await prisma.tag.findFirst({
        where: { name: tagName, userId, isVault }
      });

      if (!tag) {
        tag = await prisma.tag.create({
          data: { name: tagName, userId, isVault }
        });
      }
      noteTags.push(tag.id);
    }
  }

  // ============================================================
  // 2. PROCESS RESOURCES + build hash→attachment map
  // ============================================================
  const createdAttachments: any[] = [];
  const resourceMap = new Map<string, { url: string; mime: string; filename: string }>();

  const resources = enexNote.resource
    ? (Array.isArray(enexNote.resource) ? enexNote.resource : [enexNote.resource])
    : [];

  const uploadDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

  for (const res of resources) {
    if (!res.data || !res.data['#text']) continue;

    const buffer = Buffer.from(res.data['#text'], 'base64');
    const mime = res.mime || 'application/octet-stream';
    const originalName = res['resource-attributes']?.['file-name'] || `attachment-${uuidv4()}.${mime.split('/')[1] || 'bin'}`;
    const size = buffer.length;

    const uniqueFilename = `${uuidv4()}-${originalName}`;
    const filePath = path.join(uploadDir, uniqueFilename);
    const url = `/uploads/${uniqueFilename}`;

    fs.writeFileSync(filePath, buffer);

    // Compute MD5 hash (Evernote uses MD5 to reference resources in en-media tags)
    const md5Hash = crypto.createHash('md5').update(buffer).digest('hex');
    resourceMap.set(md5Hash, { url, mime, filename: originalName });

    createdAttachments.push({
      filename: originalName,
      url,
      mimeType: mime,
      size
    });
  }

  // ============================================================
  // 3. PROCESS CONTENT — 10-phase cleanup pipeline
  // ============================================================
  let content = enexNote.content || '';

  // Phase 1: Remove ENEX boilerplate
  content = content.replace(/<\?xml.*?\?>/g, '');
  content = content.replace(/<!DOCTYPE.*?>/g, '');
  content = content.replace(/<en-note[^>]*>/g, '');
  content = content.replace(/<\/en-note>/g, '');

  // Phase 2: Replace en-media tags with <img> or <a> using resource hash map
  content = content.replace(/<en-media[^>]*\/?>/gi, (match) => {
    const hashMatch = match.match(/hash="([^"]+)"/i);
    if (!hashMatch) return '';

    const resource = resourceMap.get(hashMatch[1]);
    if (!resource) return '';

    if (resource.mime.startsWith('image/')) {
      return `<img src="${resource.url}" alt="${resource.filename}" />`;
    }
    return `<a href="${resource.url}">${resource.filename}</a>`;
  });

  // Phase 3: Convert en-todo checkboxes
  content = content.replace(/<en-todo\s+checked="true"[^>]*\/?>/gi, '<input type="checkbox" checked disabled /> ');
  content = content.replace(/<en-todo[^>]*\/?>/gi, '<input type="checkbox" disabled /> ');

  // Phase 4: Strip inline styles but PRESERVE semantic tags
  content = content.replace(/\s+style="[^"]*"/gi, '');
  content = content.replace(/\s+style='[^']*'/gi, '');
  content = content.replace(/\s+rev="[^"]*"/gi, '');

  // Phase 5: Remove non-semantic wrapper tags (keep content)
  // Preserved: p, h1-6, strong, b, em, i, s, u, a, code, pre, blockquote, ul, ol, li, br, hr, img, table structure
  content = content.replace(/<\/?(span|font|center|small|big)[^>]*>/gi, '');

  // Phase 6: Smart DIV conversion
  // Inside table cells: div → line breaks (inline)
  content = content.replace(/(<t[dh][^>]*>)([\s\S]*?)(<\/t[dh]>)/gi, (_match, open: string, inner: string, close: string) => {
    const cleaned = inner
      .replace(/<div[^>]*>/gi, '')
      .replace(/<\/div>/gi, '<br/>');
    return open + cleaned + close;
  });
  // Outside tables: remaining divs → paragraphs
  content = content.replace(/<div[^>]*>/gi, '<p>');
  content = content.replace(/<\/div>/gi, '</p>');

  // Phase 7: Table structure cleanup
  content = content.replace(/<table[^>]*>/gi, '<table>');
  content = content.replace(/<tbody[^>]*>/gi, '<tbody>');
  content = content.replace(/<thead[^>]*>/gi, '');
  content = content.replace(/<\/thead>/gi, '');
  content = content.replace(/<tr[^>]*>/gi, '<tr>');
  content = content.replace(/<td[^>]*>/gi, '<td>');
  content = content.replace(/<th[^>]*>/gi, '<td>');  // Convert th → td (TipTap handles header rows separately)
  content = content.replace(/<\/th>/gi, '</td>');
  // Remove colgroup/col
  content = content.replace(/<colgroup>[\s\S]*?<\/colgroup>/gi, '');
  content = content.replace(/<col[^>]*\/?>/gi, '');
  // Ensure tbody exists
  if (content.includes('<table>') && !content.includes('<table><tbody>')) {
    content = content.replace(/<table>/gi, '<table><tbody>');
  }
  if (content.includes('</table>') && !content.includes('</tbody></table>')) {
    content = content.replace(/<\/table>/gi, '</tbody></table>');
  }

  // Phase 8: Wrap table cell content in <p> (TipTap requires block nodes inside cells)
  content = content.replace(/<td>([\s\S]*?)<\/td>/gi, (_match, inner: string) => {
    const trimmed = inner.trim();
    // If already starts with a block element, leave as-is
    if (/^<(p|h[1-6]|ul|ol|blockquote|pre)[\s>]/i.test(trimmed)) {
      return `<td>${trimmed}</td>`;
    }
    // Split on <br/> to create multiple paragraphs
    const parts = trimmed.split(/<br\s*\/?>/gi).filter(p => p.trim() !== '');
    if (parts.length === 0) {
      return '<td><p></p></td>';
    }
    const wrapped = parts.map(p => `<p>${p.trim()}</p>`).join('');
    return `<td>${wrapped}</td>`;
  });

  // Phase 9: Remove whitespace between structural tags (MUST BE LAST before conversion)
  content = content.replace(/>\s+</g, '><');

  // Phase 10: Convert HTML to TipTap JSON using the same extensions as hocuspocus
  let contentJson: string;

  if (!content.trim()) {
    // Empty note
    contentJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
  } else {
    try {
      const tiptapJson = withDomEnvironment(() => generateJSON(content, extensions));
      contentJson = JSON.stringify(tiptapJson);
    } catch (err) {
      logger.error(err, 'Failed to convert HTML to TipTap JSON, using plain text fallback');
      const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      contentJson = JSON.stringify({
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: plainText ? [{ type: 'text', text: plainText }] : []
        }]
      });
    }
  }

  // Extract plain text for search indexing
  const searchText = extractTextFromTipTapJson(contentJson);

  // ============================================================
  // 4. DETERMINE NOTEBOOK (unchanged)
  // ============================================================
  let notebookId = targetNotebookId;

  if (!notebookId) {
    const importsNotebook = await prisma.notebook.findFirst({
      where: { userId, name: 'Imports' }
    });

    if (importsNotebook) {
      notebookId = importsNotebook.id;
    } else {
      const firstNotebook = await prisma.notebook.findFirst({
        where: { userId }
      });

      if (firstNotebook) {
        notebookId = firstNotebook.id;
      } else {
        const newNb = await prisma.notebook.create({
          data: { name: 'Imports', userId }
        });
        notebookId = newNb.id;
      }
    }
  }

  // ============================================================
  // 5. CREATE NOTE
  // ============================================================
  const note = await prisma.note.create({
    data: {
      title: enexNote.title || 'Untitled Import',
      content: contentJson,
      searchText,
      userId,
      notebookId: notebookId!,
      isTrashed: false,
      isVault,
      createdAt: enexNote.created ? formatEnexDate(enexNote.created) : new Date(),
      updatedAt: enexNote.updated ? formatEnexDate(enexNote.updated) : new Date(),
      tags: {
        create: noteTags.map(tagId => ({ tag: { connect: { id: tagId } } }))
      },
      attachments: {
        create: createdAttachments
      },
    }
  });

  return note;
};
