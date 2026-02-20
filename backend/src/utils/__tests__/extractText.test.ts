import { describe, it, expect } from 'vitest';
import { extractTextFromTipTapJson, countDocumentStats } from '../extractText';

describe('extractTextFromTipTapJson', () => {
  describe('valid TipTap JSON', () => {
    it('should extract text from a simple paragraph', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hello world' },
            ],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Hello world');
    });

    it('should extract text from multiple paragraphs', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'First paragraph' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Second paragraph' }],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('First paragraph Second paragraph');
    });

    it('should extract text from nested content (headings, lists)', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Title' }],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item one' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item two' }],
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Title Item one Item two');
    });

    it('should handle inline marks (bold, italic) by extracting plain text', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Normal ' },
              { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' text' },
            ],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Normal bold text');
    });

    it('should skip encryptedBlock nodes', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Public content' }],
          },
          {
            type: 'encryptedBlock',
            attrs: { ciphertext: 'U2FsdGVkX1+abc123...' },
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'More public content' }],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Public content More public content');
    });

    it('should handle table content', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Cell A' }],
                      },
                    ],
                  },
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Cell B' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Cell A Cell B');
    });

    it('should handle empty document', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [],
      });

      expect(extractTextFromTipTapJson(content)).toBe('');
    });

    it('should handle document with empty paragraphs', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph' },
          { type: 'paragraph', content: [] },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Non-empty' }],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Non-empty');
    });

    it('should collapse multiple whitespace into single spaces', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hello    world' }],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('Hello world');
    });
  });

  describe('edge cases and fallback', () => {
    it('should return empty string for empty input', () => {
      expect(extractTextFromTipTapJson('')).toBe('');
    });

    it('should return empty string for null-like input', () => {
      expect(extractTextFromTipTapJson(null as any)).toBe('');
      expect(extractTextFromTipTapJson(undefined as any)).toBe('');
    });

    it('should fall back to HTML stripping for invalid JSON', () => {
      const htmlContent = '<p>Hello <strong>world</strong></p>';

      expect(extractTextFromTipTapJson(htmlContent)).toBe('Hello world');
    });

    it('should fall back to HTML stripping for legacy HTML content', () => {
      const legacyHtml = '<h1>Title</h1><p>Some <em>formatted</em> text.</p>';

      expect(extractTextFromTipTapJson(legacyHtml)).toBe('Title Some formatted text.');
    });

    it('should return empty string for JSON that is not an object', () => {
      expect(extractTextFromTipTapJson('"just a string"')).toBe('');
      expect(extractTextFromTipTapJson('42')).toBe('');
      expect(extractTextFromTipTapJson('true')).toBe('');
    });

    it('should return empty string for JSON null', () => {
      expect(extractTextFromTipTapJson('null')).toBe('');
    });

    it('should handle a node with no content and no text', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          { type: 'horizontalRule' },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('');
    });
  });

  describe('realistic TipTap structures', () => {
    it('should extract text from a code block', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'const x = 1;' }],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('const x = 1;');
    });

    it('should extract text from a blockquote', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'A wise quote' }],
              },
            ],
          },
        ],
      });

      expect(extractTextFromTipTapJson(content)).toBe('A wise quote');
    });

    it('should handle a mixed document with various node types', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Meeting Notes' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Discussed the ' },
              { type: 'text', text: 'roadmap', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' for Q3.' },
            ],
          },
          {
            type: 'orderedList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Review milestones' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Assign tasks' }],
                  },
                ],
              },
            ],
          },
          { type: 'horizontalRule' },
          {
            type: 'encryptedBlock',
            attrs: { ciphertext: 'encrypted-data' },
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'End of notes.' }],
          },
        ],
      });

      const result = extractTextFromTipTapJson(content);

      expect(result).toBe(
        'Meeting Notes Discussed the roadmap for Q3. Review milestones Assign tasks End of notes.',
      );
    });
  });
});

describe('countDocumentStats', () => {
  it('counts a simple paragraph as 1 line', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    });
    expect(countDocumentStats(content)).toEqual({ characters: 11, lines: 1 });
  });

  it('counts multiple paragraphs as separate lines', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Line three' }] },
      ],
    });
    expect(countDocumentStats(content)).toEqual({ characters: 26, lines: 3 });
  });

  it('counts each table row as 1 line', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Age' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alice' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '30' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bob' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '25' }] }] },
              ],
            },
          ],
        },
      ],
    });
    const result = countDocumentStats(content);
    expect(result.lines).toBe(3); // 3 rows = 3 lines
    expect(result.characters).toBe('NameAgeAlice30Bob25'.length);
  });

  it('counts heading + paragraph + table rows correctly', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A1' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B1' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A2' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B2' }] }] },
              ],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'End' }] },
      ],
    });
    // heading(1) + paragraph(1) + 2 table rows(2) + paragraph(1) = 5 lines
    expect(countDocumentStats(content).lines).toBe(5);
  });

  it('counts list items as separate lines', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 3' }] }] },
          ],
        },
      ],
    });
    expect(countDocumentStats(content).lines).toBe(3);
  });

  it('preserves internal newlines in code blocks', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [{ type: 'text', text: 'const a = 1;\nconst b = 2;\nconst c = 3;' }],
        },
      ],
    });
    expect(countDocumentStats(content).lines).toBe(3);
    expect(countDocumentStats(content).characters).toBe('const a = 1;\nconst b = 2;\nconst c = 3;'.length);
  });

  it('skips encrypted blocks', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Visible' }] },
        { type: 'encryptedBlock', attrs: { ciphertext: 'abc' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Also visible' }] },
      ],
    });
    expect(countDocumentStats(content)).toEqual({ characters: 19, lines: 2 });
  });

  it('handles empty content', () => {
    expect(countDocumentStats('')).toEqual({ characters: 0, lines: 0 });
    expect(countDocumentStats(null as any)).toEqual({ characters: 0, lines: 0 });
  });

  it('handles empty document', () => {
    const content = JSON.stringify({ type: 'doc', content: [] });
    expect(countDocumentStats(content)).toEqual({ characters: 0, lines: 0 });
  });

  it('falls back for HTML content', () => {
    const html = '<p>Hello</p><p>World</p>';
    const result = countDocumentStats(html);
    expect(result.characters).toBeGreaterThan(0);
    expect(result.lines).toBe(1); // HTML fallback collapses to 1 line
  });

  it('handles hardBreak as a newline within a paragraph', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Line A' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Line B' },
          ],
        },
      ],
    });
    // hardBreak creates a visual line break within a paragraph → 2 lines
    expect(countDocumentStats(content).lines).toBe(2);
  });
});
