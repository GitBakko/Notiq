/**
 * DL-5 round-trip test: proves that tableWidth (on table node) and rowHeight (on tableRow node)
 * survive a real TiptapTransformer.toYdoc → fromYdoc round-trip using the backend extensions.
 *
 * Uses REAL @hocuspocus/transformer and real yjs (not mocked) to exercise actual serialization.
 * @hocuspocus/server and related infra are mocked to prevent module-level side effects.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock infra that would cause module-level side effects when hocuspocus.ts is imported.
// These mocks must be declared before the import of hocuspocus.ts (via `extensions`).
vi.mock('@hocuspocus/server', () => {
  function ServerMock(this: { hocuspocus: { getConnectionsCount: () => number } }) {
    this.hocuspocus = { getConnectionsCount: () => 0 };
  }
  return { Server: ServerMock };
});
vi.mock('@hocuspocus/extension-logger', () => {
  function LoggerMock() {}
  return { Logger: LoggerMock };
});
vi.mock('@hocuspocus/extension-database', () => {
  function DatabaseMock(this: object, cfg: unknown) { Object.assign(this, cfg as object); }
  return { Database: DatabaseMock };
});
vi.mock('jsonwebtoken', () => ({ default: { verify: vi.fn() } }));

// NOTE: @hocuspocus/transformer, yjs, and all @tiptap/* are NOT mocked here —
// we need real implementations to prove the round-trip works.

import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { extensions } from '../hocuspocus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find all nodes of a given type in a TipTap JSON doc (recursive).
 */
function findNodes(node: Record<string, unknown>, typeName: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  if (node.type === typeName) results.push(node);
  const children = node.content as Record<string, unknown>[] | undefined;
  if (Array.isArray(children)) {
    for (const child of children) {
      results.push(...findNodes(child, typeName));
    }
  }
  return results;
}

function roundTrip(json: Record<string, unknown>): Record<string, unknown> {
  // @ts-ignore — TiptapTransformer API types incomplete (same pattern as hocuspocus.ts)
  const ydoc = TiptapTransformer.toYdoc(json, 'default', extensions);
  // @ts-ignore
  return TiptapTransformer.fromYdoc(ydoc, 'default', extensions) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DL-5: table attribute round-trip via real TiptapTransformer', () => {
  it('round-trips a simple paragraph doc without throwing (sanity check)', () => {
    const simpleDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello Notiq' }],
        },
      ],
    };

    expect(() => roundTrip(simpleDoc)).not.toThrow();
    const back = roundTrip(simpleDoc);
    const paragraphs = findNodes(back, 'paragraph');
    expect(paragraphs.length).toBeGreaterThan(0);
    const texts = findNodes(back, 'text');
    expect(texts.some((t) => (t.text as string)?.includes('Hello Notiq'))).toBe(true);
  });

  it('preserves tableWidth="free" on the table node', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { tableWidth: 'free' },
          content: [
            {
              type: 'tableRow',
              attrs: { rowHeight: null },
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'cell text' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(() => roundTrip(doc)).not.toThrow();
    const back = roundTrip(doc);
    const tables = findNodes(back, 'table');
    expect(tables.length).toBe(1);
    expect((tables[0].attrs as Record<string, unknown>)?.tableWidth).toBe('free');
  });

  it('preserves rowHeight="40px" on the tableRow node', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { tableWidth: null },
          content: [
            {
              type: 'tableRow',
              attrs: { rowHeight: '40px' },
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'row text' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(() => roundTrip(doc)).not.toThrow();
    const back = roundTrip(doc);
    const rows = findNodes(back, 'tableRow');
    expect(rows.length).toBe(1);
    expect((rows[0].attrs as Record<string, unknown>)?.rowHeight).toBe('40px');
  });

  it('preserves both tableWidth="free" and rowHeight="40px" in one doc', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { tableWidth: 'free' },
          content: [
            {
              type: 'tableRow',
              attrs: { rowHeight: '40px' },
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'cell content' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(() => roundTrip(doc)).not.toThrow();
    const back = roundTrip(doc);

    const tables = findNodes(back, 'table');
    expect(tables.length).toBe(1);
    expect((tables[0].attrs as Record<string, unknown>)?.tableWidth).toBe('free');

    const rows = findNodes(back, 'tableRow');
    expect(rows.length).toBe(1);
    expect((rows[0].attrs as Record<string, unknown>)?.rowHeight).toBe('40px');

    const texts = findNodes(back, 'text');
    expect(texts.some((t) => (t.text as string)?.includes('cell content'))).toBe(true);
  });

  it('drops tableWidth correctly when null (AUTO mode renders as style:width:100%)', () => {
    // When tableWidth is null (AUTO), after round-trip the attr should be null (default)
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { tableWidth: null },
          content: [
            {
              type: 'tableRow',
              attrs: { rowHeight: null },
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'auto table' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(() => roundTrip(doc)).not.toThrow();
    const back = roundTrip(doc);
    const tables = findNodes(back, 'table');
    expect(tables.length).toBe(1);
    // tableWidth null → attr should be null (default preserved)
    const tableWidth = (tables[0].attrs as Record<string, unknown>)?.tableWidth;
    expect(tableWidth === null || tableWidth === undefined).toBe(true);
  });
});
