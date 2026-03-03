import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { importFromOneNote } from '../onenote-import.service';
import { makeNotebook, makeNote } from '../../__tests__/factories';

// ---------------------------------------------------------------------------
// Mocks beyond setup.ts
// ---------------------------------------------------------------------------

vi.mock('../../hocuspocus', () => ({
  hocuspocus: { openDirectConnection: vi.fn() },
  extensions: [],
}));

vi.mock('@tiptap/core', () => ({
  generateJSON: vi.fn(() => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mock content' }] }],
  })),
}));

vi.mock('jsdom', () => ({
  JSDOM: vi.fn().mockImplementation(() => ({
    window: { DOMParser: class {} },
  })),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-v4'),
}));

vi.mock('../../utils/extractText', () => ({
  extractTextFromTipTapJson: vi.fn(() => 'extracted text'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock adm-zip: returns entries based on test setup
const mockGetEntries = vi.fn(() => []);
vi.mock('adm-zip', () => {
  return {
    default: class MockAdmZip {
      constructor() {
        // constructor receives fileBuffer but we ignore it in tests
      }
      getEntries() {
        return mockGetEntries();
      }
    },
  };
});

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHtmlPage(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>${bodyContent}</body>
</html>`;
}

function buildMhtFile(htmlContent: string, boundary = 'NextPart_boundary'): string {
  return `Content-Type: multipart/related; boundary="${boundary}"

--${boundary}
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

${htmlContent}
--${boundary}--`;
}

function buildSimpleMht(htmlContent: string): string {
  return `Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

${htmlContent}`;
}

function makeZipEntry(name: string, content: string): any {
  return {
    entryName: name,
    getData: () => Buffer.from(content, 'utf-8'),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default Prisma behavior
  prismaMock.note.create.mockImplementation(({ data }: any) =>
    Promise.resolve(makeNote({
      title: data.title,
      userId: data.userId,
      notebookId: data.notebookId,
    }))
  );

  // Reset adm-zip mock to return empty by default
  mockGetEntries.mockReturnValue([]);
});

// ===========================================================================
// importFromOneNote
// ===========================================================================

describe('importFromOneNote', () => {
  const userId = 'user-1';

  // -------------------------------------------------------------------------
  // 1. Import from a single HTML file
  // -------------------------------------------------------------------------
  it('imports a single HTML file and creates a note', async () => {
    const notebook = makeNotebook({ id: 'nb-1', userId });
    prismaMock.notebook.findFirst.mockResolvedValue(notebook);

    const html = buildHtmlPage('My OneNote Page', '<p>Some content here</p>');
    const buffer = Buffer.from(html, 'utf-8');

    const result = await importFromOneNote(buffer, 'page.html', userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'My OneNote Page',
          userId,
          notebookId: 'nb-1',
          isTrashed: false,
          isVault: false,
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 2. Import from MHT content (multipart)
  // -------------------------------------------------------------------------
  it('imports an MHT file and creates a note', async () => {
    const notebook = makeNotebook({ id: 'nb-1', userId });
    prismaMock.notebook.findFirst.mockResolvedValue(notebook);

    const htmlContent = buildHtmlPage('MHT Note', '<p>MHT content</p>');
    const mht = buildMhtFile(htmlContent);
    const buffer = Buffer.from(mht, 'utf-8');

    const result = await importFromOneNote(buffer, 'export.mht', userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 3. Import from simple MHT (non-multipart)
  // -------------------------------------------------------------------------
  it('imports a simple (non-multipart) MHT file', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const htmlContent = '<p>Simple MHT</p>';
    const mht = buildSimpleMht(htmlContent);
    const buffer = Buffer.from(mht, 'utf-8');

    const result = await importFromOneNote(buffer, 'simple.mhtml', userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Import from ZIP with HTML files
  // -------------------------------------------------------------------------
  it('imports HTML files from a ZIP archive', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const entry1 = makeZipEntry('page1.html', buildHtmlPage('Page 1', '<p>Content 1</p>'));
    const entry2 = makeZipEntry('page2.htm', buildHtmlPage('Page 2', '<p>Content 2</p>'));
    mockGetEntries.mockReturnValue([entry1, entry2]);

    const buffer = Buffer.from('fake-zip-data');

    const result = await importFromOneNote(buffer, 'export.zip', userId, 'nb-1');

    expect(result.importedCount).toBe(2);
    expect(result.totalFound).toBe(2);
    expect(prismaMock.note.create).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 5. Import from ZIP with MHT files inside
  // -------------------------------------------------------------------------
  it('imports MHT files from a ZIP archive', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const htmlContent = buildHtmlPage('Zipped MHT', '<p>Zipped content</p>');
    const mhtContent = buildMhtFile(htmlContent);
    const entry = makeZipEntry('notebook.mht', mhtContent);
    mockGetEntries.mockReturnValue([entry]);

    const buffer = Buffer.from('fake-zip-data');

    const result = await importFromOneNote(buffer, 'export.zip', userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Throws for unsupported format
  // -------------------------------------------------------------------------
  it('throws BadRequestError for unsupported file format', async () => {
    const buffer = Buffer.from('some data');

    await expect(importFromOneNote(buffer, 'document.pdf', userId))
      .rejects.toThrow('errors.import.unsupportedFormat');
  });

  it('throws BadRequestError for .txt files', async () => {
    const buffer = Buffer.from('plain text');

    await expect(importFromOneNote(buffer, 'notes.txt', userId))
      .rejects.toThrow('errors.import.unsupportedFormat');
  });

  // -------------------------------------------------------------------------
  // 7. Throws when exceeding size limit (50MB)
  // -------------------------------------------------------------------------
  it('throws BadRequestError when buffer exceeds 50MB size limit', async () => {
    const oversizedBuffer = Buffer.alloc(50 * 1024 * 1024 + 1);

    await expect(importFromOneNote(oversizedBuffer, 'big.html', userId))
      .rejects.toThrow('errors.import.fileTooLarge');
  });

  // -------------------------------------------------------------------------
  // 8. Assigns to target notebook
  // -------------------------------------------------------------------------
  it('uses provided targetNotebookId and does not query for notebooks', async () => {
    const html = buildHtmlPage('Targeted', '<p>content</p>');
    const buffer = Buffer.from(html, 'utf-8');

    const result = await importFromOneNote(buffer, 'page.html', userId, 'target-nb');

    expect(result.importedCount).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notebookId: 'target-nb',
        }),
      })
    );
    expect(prismaMock.notebook.findFirst).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. Creates default notebook when no target
  // -------------------------------------------------------------------------
  it('creates an "Imports" notebook when no target and no existing notebooks', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(null);
    prismaMock.notebook.create.mockResolvedValue(
      makeNotebook({ id: 'new-imports', name: 'Imports', userId })
    );

    const html = buildHtmlPage('Orphan', '<p>text</p>');
    const buffer = Buffer.from(html, 'utf-8');

    const result = await importFromOneNote(buffer, 'page.html', userId);

    expect(result.importedCount).toBe(1);
    expect(prismaMock.notebook.create).toHaveBeenCalledWith({
      data: { name: 'Imports', userId },
    });
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notebookId: 'new-imports',
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 10. Extracts title from <title> tag in HTML
  // -------------------------------------------------------------------------
  it('extracts the title from the HTML <title> tag', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const html = buildHtmlPage('Page Title From HTML', '<p>content</p>');
    const buffer = Buffer.from(html, 'utf-8');

    await importFromOneNote(buffer, 'fallback-name.html', userId, 'nb-1');

    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Page Title From HTML',
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 11. Falls back to filename as title when no <title> tag
  // -------------------------------------------------------------------------
  it('uses filename as title when HTML has no <title> tag', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const html = '<p>No title tag here</p>';
    const buffer = Buffer.from(html, 'utf-8');

    await importFromOneNote(buffer, 'my-document.html', userId, 'nb-1');

    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'my-document',
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 12. Sets isVault when specified
  // -------------------------------------------------------------------------
  it('sets isVault flag on imported notes when isVault is true', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const html = buildHtmlPage('Vault Note', '<p>secret</p>');
    const buffer = Buffer.from(html, 'utf-8');

    await importFromOneNote(buffer, 'page.html', userId, 'nb-1', true);

    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isVault: true,
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 13. Continues importing when one note fails
  // -------------------------------------------------------------------------
  it('continues importing remaining notes when one HTML in ZIP fails', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const entry1 = makeZipEntry('good.html', buildHtmlPage('Good', '<p>ok</p>'));
    const entry2 = makeZipEntry('bad.html', buildHtmlPage('Bad', '<p>fail</p>'));
    mockGetEntries.mockReturnValue([entry1, entry2]);

    // First call succeeds, second fails
    prismaMock.note.create
      .mockResolvedValueOnce(makeNote({ title: 'Good' }))
      .mockRejectedValueOnce(new Error('DB error'));

    const buffer = Buffer.from('fake-zip');

    const result = await importFromOneNote(buffer, 'export.zip', userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(2);
  });
});
