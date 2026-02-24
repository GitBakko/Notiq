import prisma from '../plugins/prisma';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { generateJSON } from '@tiptap/core';
import { extensions } from '../hocuspocus';
import { JSDOM } from 'jsdom';
import { extractTextFromTipTapJson } from '../utils/extractText';
import logger from '../utils/logger';
import AdmZip from 'adm-zip';

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
interface AttachmentData {
  filename: string;
  url: string;
  mimeType: string;
  size: number;
}

// --- Constants ---
const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50MB (ZIPs can be large)

// --- MHT/MHTML Parser ---

/** Decode quoted-printable encoding: =XX → byte, =\r?\n → soft line break (removed) */
function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

interface MhtPart {
  headers: Record<string, string>;
  body: string;
  bodyBuffer?: Buffer;
}

/** Parse an MHT/MHTML file into its MIME parts */
function parseMht(raw: string): { htmlPart: string; resources: Map<string, Buffer> } {
  const resources = new Map<string, Buffer>();

  // Extract top-level headers (before the first blank line)
  const headerEnd = raw.indexOf('\r\n\r\n') !== -1
    ? raw.indexOf('\r\n\r\n')
    : raw.indexOf('\n\n');
  const topHeaders = raw.substring(0, headerEnd);
  const topBody = raw.substring(headerEnd).replace(/^[\r\n]+/, '');

  const contentTypeMatch = topHeaders.match(/Content-Type:\s*([^\r\n;]+)/i);
  const topContentType = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : '';

  // Case 1: Multipart MHT (has boundary — contains embedded images)
  const boundaryMatch = topHeaders.match(/boundary="?([^"\r\n;]+)"?/i);
  if (topContentType.includes('multipart/') && boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = topBody.split(`--${boundary}`);
    let htmlContent = '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === '--') continue; // skip preamble and closing

      const partHeaderEnd = trimmed.indexOf('\r\n\r\n') !== -1
        ? trimmed.indexOf('\r\n\r\n')
        : trimmed.indexOf('\n\n');
      if (partHeaderEnd === -1) continue;

      const partHeaders = trimmed.substring(0, partHeaderEnd);
      const partBody = trimmed.substring(partHeaderEnd).replace(/^[\r\n]+/, '');

      const partCT = (partHeaders.match(/Content-Type:\s*([^\r\n;]+)/i)?.[1] || '').trim().toLowerCase();
      const partEncoding = (partHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1] || '').trim().toLowerCase();
      const partLocation = (partHeaders.match(/Content-Location:\s*([^\r\n]+)/i)?.[1] || '').trim();

      if (partCT.startsWith('text/html')) {
        htmlContent = partEncoding === 'quoted-printable'
          ? decodeQuotedPrintable(partBody)
          : partBody;
      } else if (partCT.startsWith('image/')) {
        // Resource part (image)
        const buffer = partEncoding === 'base64'
          ? Buffer.from(partBody.replace(/[\r\n\s]/g, ''), 'base64')
          : Buffer.from(partBody);
        if (partLocation) {
          resources.set(partLocation, buffer);
          // Also store just the filename for matching
          const filename = partLocation.split('/').pop() || '';
          if (filename) resources.set(filename, buffer);
        }
      }
    }

    return { htmlPart: htmlContent, resources };
  }

  // Case 2: Simple MHT (no multipart — just quoted-printable HTML)
  const encoding = (topHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1] || '').trim().toLowerCase();
  const html = encoding === 'quoted-printable' ? decodeQuotedPrintable(topBody) : topBody;

  return { htmlPart: html, resources };
}

// --- Main export ---
export async function importFromOneNote(
  fileBuffer: Buffer,
  originalFilename: string,
  userId: string,
  targetNotebookId?: string,
  isVault: boolean = false
): Promise<{ importedCount: number; totalFound: number }> {
  if (fileBuffer.length > MAX_IMPORT_SIZE) {
    throw new Error('Import file exceeds maximum size limit (50MB)');
  }

  const lowerFilename = originalFilename.toLowerCase();
  const htmlFiles: Array<{ title: string; html: string; mhtResources?: Map<string, Buffer> }> = [];
  let zipEntries: Map<string, Buffer> | undefined;

  if (lowerFilename.endsWith('.zip')) {
    const zip = new AdmZip(fileBuffer);
    const entries = zip.getEntries();
    zipEntries = new Map<string, Buffer>();

    for (const entry of entries) {
      const entryName = entry.entryName;
      const entryLower = entryName.toLowerCase();

      if (entryLower.endsWith('.html') || entryLower.endsWith('.htm')) {
        const html = entry.getData().toString('utf-8');
        const title = path.basename(entryName, path.extname(entryName));
        htmlFiles.push({ title, html });
      } else if (entryLower.endsWith('.mht') || entryLower.endsWith('.mhtml')) {
        const raw = entry.getData().toString('utf-8');
        const { htmlPart, resources } = parseMht(raw);
        const title = path.basename(entryName, path.extname(entryName));
        htmlFiles.push({ title, html: htmlPart, mhtResources: resources });
      } else {
        // Store non-HTML files (images, etc.) for reference by HTML content
        const buffer = entry.getData();
        zipEntries.set(entryName, buffer);
        const decoded = decodeURIComponent(entryName);
        if (decoded !== entryName) {
          zipEntries.set(decoded, buffer);
        }
      }
    }
  } else if (lowerFilename.endsWith('.mht') || lowerFilename.endsWith('.mhtml')) {
    // MHT/MHTML file — parse MIME structure
    const raw = fileBuffer.toString('utf-8');
    const { htmlPart, resources } = parseMht(raw);
    const title = path.basename(originalFilename, path.extname(originalFilename));
    htmlFiles.push({ title, html: htmlPart, mhtResources: resources });
  } else if (lowerFilename.endsWith('.html') || lowerFilename.endsWith('.htm')) {
    const html = fileBuffer.toString('utf-8');
    const title = path.basename(originalFilename, path.extname(originalFilename));
    htmlFiles.push({ title, html });
  } else {
    throw new Error('Unsupported file format. Please provide an .mht, .html, or .zip file.');
  }

  let importedCount = 0;

  for (const file of htmlFiles) {
    try {
      // Merge MHT resources into zipEntries map for unified image handling
      const resourceMap = file.mhtResources || zipEntries;
      await processOneNoteHtml(file.html, file.title, userId, targetNotebookId, isVault, resourceMap);
      importedCount++;
    } catch (e) {
      logger.error(e, 'Failed to import OneNote note: %s', file.title);
    }
  }

  return { importedCount, totalFound: htmlFiles.length };
}

// --- Process single OneNote HTML ---
async function processOneNoteHtml(
  html: string,
  fallbackTitle: string,
  userId: string,
  targetNotebookId?: string,
  isVault: boolean = false,
  zipEntries?: Map<string, Buffer>
): Promise<void> {
  const createdAttachments: AttachmentData[] = [];
  const uploadDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Extract title from <title> tag if present
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;

  let content = html;

  // ============================================================
  // Phase 1: Remove OneNote boilerplate
  // ============================================================
  content = content.replace(/<!DOCTYPE[^>]*>/gi, '');
  content = content.replace(/<html[^>]*>/gi, '');
  content = content.replace(/<\/html>/gi, '');
  content = content.replace(/<head>[\s\S]*?<\/head>/gi, '');
  content = content.replace(/<body[^>]*>/gi, '');
  content = content.replace(/<\/body>/gi, '');
  content = content.replace(/<meta[^>]*\/?>/gi, '');
  content = content.replace(/<link[^>]*\/?>/gi, '');

  // ============================================================
  // Phase 2: Extract and save embedded images (data URIs)
  // ============================================================
  content = content.replace(
    /<img\s+[^>]*src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/gi,
    (_match, mime: string, base64Data: string) => {
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = mime.split('/')[1] || 'png';
      const filename = `${uuidv4()}.${ext}`;
      const filePath = path.join(uploadDir, filename);
      const url = `/uploads/${filename}`;
      fs.writeFileSync(filePath, buffer);
      createdAttachments.push({ filename, url, mimeType: mime, size: buffer.length });
      return `<img src="${url}" alt="${filename}" />`;
    }
  );

  // Handle images referencing files in ZIP or MHT resources
  if (zipEntries) {
    content = content.replace(
      /<img\s+[^>]*src="([^"]+)"[^>]*\/?>/gi,
      (match, src: string) => {
        if (src.startsWith('/uploads/') || src.startsWith('http')) return match;

        // Try direct match, then decoded, then just the filename (for MHT file:/// paths)
        let imageBuffer = zipEntries.get(src) || zipEntries.get(decodeURIComponent(src));
        if (!imageBuffer) {
          const filename = src.split('/').pop() || '';
          imageBuffer = zipEntries.get(filename);
        }
        if (!imageBuffer) return match;

        const ext = path.extname(src).slice(1) || 'png';
        const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        const filename = `${uuidv4()}.${ext}`;
        const filePath = path.join(uploadDir, filename);
        const url = `/uploads/${filename}`;
        fs.writeFileSync(filePath, imageBuffer);
        createdAttachments.push({ filename, url, mimeType: mime, size: imageBuffer.length });
        return `<img src="${url}" alt="${filename}" />`;
      }
    );
  }

  // ============================================================
  // Phase 3: Strip inline styles
  // ============================================================
  content = content.replace(/\s+style="[^"]*"/gi, '');
  content = content.replace(/\s+style='[^']*'/gi, '');
  content = content.replace(/\s+class="[^"]*"/gi, '');

  // ============================================================
  // Phase 4: Remove non-semantic tags
  // ============================================================
  content = content.replace(/<\/?(span|font|center|small|big|o:p)[^>]*>/gi, '');

  // ============================================================
  // Phase 5: Smart DIV conversion
  // ============================================================
  // Inside table cells: div → line breaks (inline)
  content = content.replace(
    /(<t[dh][^>]*>)([\s\S]*?)(<\/t[dh]>)/gi,
    (_match, open: string, inner: string, close: string) => {
      const cleaned = inner
        .replace(/<div[^>]*>/gi, '')
        .replace(/<\/div>/gi, '<br/>');
      return open + cleaned + close;
    }
  );
  // Outside tables: remaining divs → paragraphs
  content = content.replace(/<div[^>]*>/gi, '<p>');
  content = content.replace(/<\/div>/gi, '</p>');

  // ============================================================
  // Phase 6: Table cleanup
  // ============================================================
  content = content.replace(/<table[^>]*>/gi, '<table>');
  content = content.replace(/<tbody[^>]*>/gi, '<tbody>');
  content = content.replace(/<thead[^>]*>/gi, '');
  content = content.replace(/<\/thead>/gi, '');
  content = content.replace(/<tr[^>]*>/gi, '<tr>');
  content = content.replace(/<td[^>]*>/gi, '<td>');
  content = content.replace(/<th[^>]*>/gi, '<td>');
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

  // Wrap table cell content in <p> (TipTap requires block nodes inside cells)
  content = content.replace(/<td>([\s\S]*?)<\/td>/gi, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (/^<(p|h[1-6]|ul|ol|blockquote|pre)[\s>]/i.test(trimmed)) {
      return `<td>${trimmed}</td>`;
    }
    const parts = trimmed.split(/<br\s*\/?>/gi).filter(p => p.trim() !== '');
    if (parts.length === 0) {
      return '<td><p></p></td>';
    }
    const wrapped = parts.map(p => `<p>${p.trim()}</p>`).join('');
    return `<td>${wrapped}</td>`;
  });

  // ============================================================
  // Phase 7: Whitespace cleanup + TipTap JSON conversion
  // ============================================================
  content = content.replace(/>\s+</g, '><');

  let contentJson: string;

  if (!content.trim()) {
    contentJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
  } else {
    try {
      const tiptapJson = withDomEnvironment(() => generateJSON(content, extensions));
      // Override lineHeight on imported paragraphs/headings.
      // The LineHeight extension defaults to 0.5 which causes text overlap on long wrapping paragraphs.
      // Set to "normal" so CSS applies standard line-height for readable imported content.
      function normalizeLineHeight(node: any): void {
        if (node.attrs && 'lineHeight' in node.attrs) {
          node.attrs.lineHeight = 'normal';
        }
        if (Array.isArray(node.content)) {
          node.content.forEach(normalizeLineHeight);
        }
      }
      normalizeLineHeight(tiptapJson);
      contentJson = JSON.stringify(tiptapJson);
    } catch (err) {
      logger.error(err, 'Failed to convert OneNote HTML to TipTap JSON, using plain text fallback');
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

  const searchText = extractTextFromTipTapJson(contentJson);

  // ============================================================
  // Determine notebook
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
  // Create note
  // ============================================================
  await prisma.note.create({
    data: {
      title: title || 'Untitled Import',
      content: contentJson,
      searchText,
      userId,
      notebookId: notebookId!,
      isTrashed: false,
      isVault,
      tags: { create: [] },
      attachments: {
        create: createdAttachments
      },
    }
  });
}
