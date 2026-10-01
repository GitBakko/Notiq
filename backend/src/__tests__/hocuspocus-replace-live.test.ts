/**
 * 1.13.2: restoring a version must replace the LIVE Y doc, otherwise Hocuspocus' next store()
 * writes the old in-memory content back. Real yjs + real transformer; Server is a double with a
 * real `documents` Map and a fake openDirectConnection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@hocuspocus/server', () => {
  function ServerMock(this: { hocuspocus: unknown }) {
    this.hocuspocus = {
      documents: new Map(),
      loadingDocuments: new Map(),
      getConnectionsCount: () => 0,
      openDirectConnection: vi.fn(),
    };
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

import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { hocuspocus, extensions, replaceLiveDocContent, flushLiveDoc } from '../hocuspocus';
import { extensions as ydocExtensions } from '../utils/ydoc';

describe('extensions', () => {
  it('hocuspocus exports the very same extensions array as utils/ydoc (single source, cannot drift)', () => {
    expect(extensions).toBe(ydocExtensions);
  });
});

const NOTE_ID = 'note-1';
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const str = (text: string) => JSON.stringify(doc(text));
const toYdoc = (json: unknown) => TiptapTransformer.toYdoc(json as any, 'default', extensions as any);
const fromYdoc = (y: Y.Doc) => TiptapTransformer.fromYdoc(y, 'default');

const inner = hocuspocus as unknown as {
  hocuspocus: { documents: Map<string, unknown>; loadingDocuments: Map<string, unknown>; openDirectConnection: ReturnType<typeof vi.fn> };
};

function liveDoc(json: unknown) {
  const ydoc = toYdoc(json);
  inner.hocuspocus.documents.set(NOTE_ID, {});
  const connection = {
    transact: vi.fn(async (cb: (d: Y.Doc) => void) => cb(ydoc)),
    disconnect: vi.fn(async () => {}),
  };
  inner.hocuspocus.openDirectConnection.mockResolvedValue(connection);
  return { ydoc, connection };
}

beforeEach(() => {
  inner.hocuspocus.documents.clear();
  inner.hocuspocus.loadingDocuments.clear();
  inner.hocuspocus.openDirectConnection.mockReset();
});

describe('flushLiveDoc', () => {
  it('is a no-op when nobody has the note open', async () => {
    await flushLiveDoc(NOTE_ID);
    expect(inner.hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  it('persists a live doc: context { restore: true } (no user), one transact, disconnect', async () => {
    const { connection } = liveDoc(doc('OLD'));

    await flushLiveDoc(NOTE_ID);

    expect(inner.hocuspocus.openDirectConnection).toHaveBeenCalledWith(NOTE_ID, { restore: true });
    expect(inner.hocuspocus.openDirectConnection.mock.calls[0][1]).not.toHaveProperty('user');
    expect(connection.transact).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('also flushes a doc that is only loading', async () => {
    liveDoc(doc('OLD'));
    inner.hocuspocus.documents.clear();
    inner.hocuspocus.loadingDocuments.set(NOTE_ID, Promise.resolve({}));

    await flushLiveDoc(NOTE_ID);

    expect(inner.hocuspocus.openDirectConnection).toHaveBeenCalledTimes(1);
  });

  it('still disconnects and propagates the error when transact throws', async () => {
    const { connection } = liveDoc(doc('OLD'));
    connection.transact.mockRejectedValue(new Error('boom'));

    await expect(flushLiveDoc(NOTE_ID)).rejects.toThrow('boom');
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('replaceLiveDocContent', () => {
  it('is a no-op when nobody has the note open', async () => {
    await replaceLiveDocContent(NOTE_ID, str('NEW'));
    expect(inner.hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  it('opens the connection when the doc is only loading (not yet in documents)', async () => {
    const { connection } = liveDoc(doc('OLD'));
    inner.hocuspocus.documents.clear();
    inner.hocuspocus.loadingDocuments.set(NOTE_ID, Promise.resolve({}));

    await replaceLiveDocContent(NOTE_ID, str('NEW'));

    expect(inner.hocuspocus.openDirectConnection).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  // 1.13.3 (strict conversion): legacy HTML used to become a fallback text paragraph; now it is refused.
  it('legacy HTML / plain-text content is refused, live doc untouched', async () => {
    const { ydoc } = liveDoc(doc('OLD'));

    await expect(replaceLiveDocContent(NOTE_ID, '<p>legacy <b>text</b></p>')).rejects.toThrow('could not be converted');

    expect(inner.hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(fromYdoc(ydoc)).toEqual(fromYdoc(toYdoc(doc('OLD'))));
  });

  it('content with a node unknown to the schema is refused, live doc untouched', async () => {
    const { ydoc } = liveDoc(doc('OLD'));
    const unknown = JSON.stringify({ type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', content: [doc('x').content[0]] }] }] });

    await expect(replaceLiveDocContent(NOTE_ID, unknown)).rejects.toThrow('could not be converted');

    expect(inner.hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(fromYdoc(ydoc)).toEqual(fromYdoc(toYdoc(doc('OLD'))));
  });

  it('swaps the content in a single update; context { restore: true } and no user key', async () => {
    const { ydoc, connection } = liveDoc(doc('OLD'));
    const updates = vi.fn();
    ydoc.on('update', updates);

    await replaceLiveDocContent(NOTE_ID, str('NEW'));

    expect(fromYdoc(ydoc)).toEqual(fromYdoc(toYdoc(doc('NEW'))));
    expect(updates).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(inner.hocuspocus.openDirectConnection).toHaveBeenCalledWith(NOTE_ID, { restore: true });
    expect(inner.hocuspocus.openDirectConnection.mock.calls[0][1]).not.toHaveProperty('user');
  });

  it('converges with a client that was synced to the old content (no OLD text, no duplication)', async () => {
    const { ydoc } = liveDoc(doc('OLD'));
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(ydoc));

    await replaceLiveDocContent(NOTE_ID, str('NEW'));

    Y.applyUpdate(client, Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(client)));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(client, Y.encodeStateVector(ydoc)));

    const expected = fromYdoc(toYdoc(doc('NEW')));
    expect(fromYdoc(client)).toEqual(expected);
    expect(fromYdoc(ydoc)).toEqual(expected);
    expect(JSON.stringify(fromYdoc(client))).not.toContain('OLD');
  });

  it('rejects empty restored content (no nodes) without touching the live doc', async () => {
    const { ydoc } = liveDoc(doc('OLD'));

    await expect(replaceLiveDocContent(NOTE_ID, JSON.stringify({ type: 'doc', content: [] }))).rejects.toThrow('could not be converted'); // schema check() refuses an empty doc (doc = block+), so a converted doc always has >= 1 node

    expect(inner.hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(fromYdoc(ydoc)).toEqual(fromYdoc(toYdoc(doc('OLD'))));
  });

  it('rejects when the conversion throws, without touching the live doc', async () => {
    const { ydoc } = liveDoc(doc('OLD'));
    const oldJson = fromYdoc(ydoc);
    const spy = vi.spyOn(TiptapTransformer, 'toYdoc').mockImplementation(() => { throw new Error('bad'); });

    await expect(replaceLiveDocContent(NOTE_ID, str('NEW'))).rejects.toThrow('could not be converted');
    expect(spy).toHaveBeenCalledTimes(1); // strict: no text fallback attempt
    spy.mockRestore();

    expect(inner.hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(fromYdoc(ydoc)).toEqual(oldJson);
  });

  it('still disconnects and propagates the error when the transaction throws', async () => {
    const { connection } = liveDoc(doc('OLD'));
    connection.transact.mockRejectedValue(new Error('boom'));

    await expect(replaceLiveDocContent(NOTE_ID, str('NEW'))).rejects.toThrow('boom');
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});
