import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import { importFromEnex } from '../import.service';
import { makeNotebook, makeTag, makeNote } from '../../__tests__/factories';

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

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEnexXml(notes: string[]): Buffer {
  const notesXml = notes.join('\n');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export>
  ${notesXml}
</en-export>`
  );
}

function buildSingleNoteEnex(title: string, content: string, extra = ''): string {
  return `<note>
    <title>${title}</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-note>${content}</en-note>]]></content>
    ${extra}
  </note>`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default Prisma behavior: note.create returns a valid note
  prismaMock.note.create.mockImplementation(({ data }: any) =>
    Promise.resolve(makeNote({
      title: data.title,
      userId: data.userId,
      notebookId: data.notebookId,
    }))
  );
});

// ===========================================================================
// importFromEnex
// ===========================================================================

describe('importFromEnex', () => {
  const userId = 'user-1';

  // -------------------------------------------------------------------------
  // 1. Parses valid ENEX XML and creates notes
  // -------------------------------------------------------------------------
  it('parses valid ENEX XML with a single note and creates it', async () => {
    const notebook = makeNotebook({ id: 'nb-1', userId });
    prismaMock.notebook.findFirst.mockResolvedValue(notebook);
    prismaMock.tag.findFirst.mockResolvedValue(null);

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Test Note', '<p>Hello world</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Test Note',
          userId,
          notebookId: 'nb-1',
          isTrashed: false,
          isVault: false,
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 2. Parses multiple notes
  // -------------------------------------------------------------------------
  it('parses ENEX XML with multiple notes', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Note 1', '<p>First</p>'),
      buildSingleNoteEnex('Note 2', '<p>Second</p>'),
      buildSingleNoteEnex('Note 3', '<p>Third</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, 'nb-1');

    expect(result.importedCount).toBe(3);
    expect(result.totalFound).toBe(3);
    expect(prismaMock.note.create).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // 3. Throws for invalid XML (no en-export / note nodes)
  // -------------------------------------------------------------------------
  it('throws BadRequestError for invalid XML without en-export node', async () => {
    const invalidBuffer = Buffer.from('<invalid>not enex</invalid>');

    await expect(importFromEnex(invalidBuffer, userId))
      .rejects.toThrow('errors.import.invalidEnex');
  });

  it('throws BadRequestError for XML with en-export but no note node', async () => {
    const invalidBuffer = Buffer.from('<en-export><other>data</other></en-export>');

    await expect(importFromEnex(invalidBuffer, userId))
      .rejects.toThrow('errors.import.invalidEnex');
  });

  // -------------------------------------------------------------------------
  // 4. Throws when buffer too large
  // -------------------------------------------------------------------------
  it('throws BadRequestError when buffer exceeds 10MB size limit', async () => {
    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1);

    await expect(importFromEnex(oversizedBuffer, userId))
      .rejects.toThrow('errors.import.fileTooLarge');
  });

  // -------------------------------------------------------------------------
  // 5. Assigns to target notebook when provided
  // -------------------------------------------------------------------------
  it('uses the provided targetNotebookId for all notes', async () => {
    const targetNotebookId = 'target-nb-id';

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Targeted Note', '<p>content</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, targetNotebookId);

    expect(result.importedCount).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notebookId: targetNotebookId,
        }),
      })
    );
    // Should NOT query for notebooks when target is provided
    expect(prismaMock.notebook.findFirst).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Creates default "Imports" notebook when no target and no existing
  // -------------------------------------------------------------------------
  it('creates an "Imports" notebook when no target and no existing notebooks', async () => {
    // No "Imports" notebook found, no first notebook either
    prismaMock.notebook.findFirst.mockResolvedValue(null);
    prismaMock.notebook.create.mockResolvedValue(
      makeNotebook({ id: 'new-imports-nb', name: 'Imports', userId })
    );

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Orphan Note', '<p>content</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId);

    expect(result.importedCount).toBe(1);
    expect(prismaMock.notebook.create).toHaveBeenCalledWith({
      data: { name: 'Imports', userId },
    });
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notebookId: 'new-imports-nb',
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 7. Uses existing "Imports" notebook when no target
  // -------------------------------------------------------------------------
  it('uses existing "Imports" notebook when no target notebook provided', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(
      makeNotebook({ id: 'existing-imports', name: 'Imports', userId })
    );

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Auto-placed Note', '<p>content</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId);

    expect(result.importedCount).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notebookId: 'existing-imports',
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 8. Processes tags and creates them when not found
  // -------------------------------------------------------------------------
  it('creates tags when they do not exist and associates them with the note', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));
    prismaMock.tag.findFirst.mockResolvedValue(null);
    const newTag = makeTag({ id: 'tag-1', name: 'MyTag', userId });
    prismaMock.tag.create.mockResolvedValue(newTag);

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Tagged Note', '<p>content</p>', '<tag>MyTag</tag>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(prismaMock.tag.findFirst).toHaveBeenCalledWith({
      where: { name: 'MyTag', userId, isVault: false },
    });
    expect(prismaMock.tag.create).toHaveBeenCalledWith({
      data: { name: 'MyTag', userId, isVault: false },
    });
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: {
            create: [{ tag: { connect: { id: 'tag-1' } }, user: { connect: { id: 'user-1' } } }],
          },
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 9. Reuses existing tags
  // -------------------------------------------------------------------------
  it('reuses existing tags instead of creating duplicates', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));
    const existingTag = makeTag({ id: 'existing-tag', name: 'Existing', userId });
    prismaMock.tag.findFirst.mockResolvedValue(existingTag);

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Note with existing tag', '<p>text</p>', '<tag>Existing</tag>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(prismaMock.tag.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 10. Sets isVault when specified
  // -------------------------------------------------------------------------
  it('sets isVault flag on imported notes when isVault is true', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Vault Note', '<p>secret</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, 'nb-1', true);

    expect(result.importedCount).toBe(1);
    expect(prismaMock.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isVault: true,
        }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // 11. Continues importing remaining notes when one fails
  // -------------------------------------------------------------------------
  it('continues importing remaining notes when one note fails to process', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(makeNotebook({ id: 'nb-1', userId }));

    // First call fails, second succeeds
    prismaMock.note.create
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce(makeNote({ title: 'Note 2' }));

    const enexBuffer = buildEnexXml([
      buildSingleNoteEnex('Failing Note', '<p>fail</p>'),
      buildSingleNoteEnex('Succeeding Note', '<p>success</p>'),
    ]);

    const result = await importFromEnex(enexBuffer, userId, 'nb-1');

    expect(result.importedCount).toBe(1);
    expect(result.totalFound).toBe(2);
  });
});
