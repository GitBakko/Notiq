/**
 * 1.13.3: utils/ydoc.ts — single home of the server-side TipTap extensions, plus the strict
 * conversion (contentToYNodes) and rebaseYdocState used by REST writers. Real extensions and
 * real yjs: NO mocks, so the duplication regression is proven against the actual schema.
 */
import { describe, it, expect } from 'vitest';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { extensions, contentToYdocState, contentToYNodes, rebaseYdocState } from '../utils/ydoc';

type Json = { type: string; content?: unknown[] };
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const docOf = (...texts: string[]): Json => ({ type: 'doc', content: texts.map(para) });
const str = (...texts: string[]) => JSON.stringify(docOf(...texts));
const toYdoc = (json: unknown) => TiptapTransformer.toYdoc(json as any, 'default', extensions as any);
const fromYdoc = (y: Y.Doc) => (TiptapTransformer as any).fromYdoc(y, 'default', extensions) as Json;
const stateOf = (json: unknown) => Buffer.from(Y.encodeStateAsUpdate(toYdoc(json)));
const docFromState = (s: Uint8Array) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(s));
  return d;
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
};
const texts = (j: Json) => (j.content ?? []).map((n: any) => n.content?.[0]?.text);

const TASK_DOC = JSON.stringify({
  type: 'doc',
  content: [{ type: 'taskList', content: [{ type: 'taskItem', content: [para('x')] }] }],
});

describe('rebaseYdocState: returns null when in doubt', () => {
  const S0 = stateOf(docOf('a', 'b', 'c'));

  it('old state absent or empty', () => {
    expect(rebaseYdocState(null, str('a'))).toBeNull();
    expect(rebaseYdocState(undefined, str('a'))).toBeNull();
    expect(rebaseYdocState(Buffer.alloc(0), str('a'))).toBeNull();
  });

  it('random bytes, truncated state, diff without its base', () => {
    expect(rebaseYdocState(Buffer.from([1, 2, 3, 250, 99, 7, 7, 7]), str('a'))).toBeNull();
    expect(rebaseYdocState(S0.subarray(0, Math.floor(S0.length / 2)), str('a'))).toBeNull();
    const base = toYdoc(docOf('a', 'b', 'c'));
    const edited = docFromState(Y.encodeStateAsUpdate(base));
    (edited.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, [new Y.XmlText('zzz')]);
    const diff = Buffer.from(Y.encodeStateAsUpdate(edited, Y.encodeStateVector(base)));
    expect(rebaseYdocState(diff, str('a'))).toBeNull();
  });

  it('new content with an unknown node (strict conversion)', () => {
    expect(rebaseYdocState(S0, TASK_DOC)).toBeNull();
  });

  it('new content with 0 nodes, or not JSON', () => {
    expect(rebaseYdocState(S0, JSON.stringify({ type: 'doc', content: [] }))).toBeNull();
    expect(rebaseYdocState(S0, '<p>legacy</p>')).toBeNull();
  });

  it('absolute cap: old state OR new content above 256 KiB', () => {
    const big = docOf(...Array.from({ length: 30 }, (_, i) => `${i}-` + 'x'.repeat(10_000)));
    const bigState = stateOf(big);
    expect(bigState.length).toBeGreaterThan(256 * 1024);
    expect(rebaseYdocState(bigState, str('tiny'))).toBeNull();
    // new content above the cap, even with a same-size old state (no more 3x escape hatch)
    const bigger = docOf(...Array.from({ length: 30 }, (_, i) => `${i}-` + 'y'.repeat(10_000)));
    expect(rebaseYdocState(bigState, JSON.stringify(bigger))).toBeNull();
    // small old state, oversized new content
    expect(rebaseYdocState(stateOf(docOf('a')), JSON.stringify(bigger))).toBeNull();
  });

  it('structurally invalid new content (listItem at the root)', () => {
    expect(rebaseYdocState(S0, JSON.stringify({ type: 'doc', content: [{ type: 'listItem', content: [para('x')] }] }))).toBeNull();
  });
});

describe('rebaseYdocState: convergence', () => {
  it('(e) a stale client converges to the new content, no duplicated blocks', () => {
    const C0 = docOf('a', 'b', 'c');
    const C1 = docOf('a', 'B2', 'c', 'd');
    const S0 = stateOf(C0);
    const client = docFromState(S0);

    const rebased = rebaseYdocState(S0, JSON.stringify(C1));
    expect(rebased).not.toBeNull();
    const server = docFromState(rebased!);
    sync(server, client);

    const expected = fromYdoc(toYdoc(C1));
    expect(fromYdoc(server)).toEqual(expected);
    expect(fromYdoc(client)).toEqual(expected);
  });

  it('(e) control: a state rebuilt from content duplicates the blocks of a stale client', () => {
    const S0 = stateOf(docOf('a', 'b', 'c'));
    const client = docFromState(S0);
    const fresh = contentToYdocState(str('a', 'B2', 'c', 'd'))!;
    const server = docFromState(fresh);
    sync(server, client);
    expect((fromYdoc(server).content ?? []).length).toBeGreaterThan(4);
  });

  it('(f) an offline edit in an UNTOUCHED paragraph survives; one in a replaced paragraph is lost', () => {
    const S0 = stateOf(docOf('a', 'b', 'c'));
    const client = docFromState(S0);
    const frag = client.getXmlFragment('default');
    ((frag.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'X');
    ((frag.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'Y');

    const rebased = rebaseYdocState(S0, str('a', 'B2', 'c'));
    const server = docFromState(rebased!);
    sync(server, client);

    const merged = fromYdoc(server);
    expect(texts(merged)).toEqual(['Xa', 'B2', 'c']); // 'Y' (replaced paragraph) is the accepted loss
    expect(fromYdoc(client)).toEqual(merged);
  });

  it('(g) identical content returns a state of the same length', () => {
    const S0 = stateOf(docOf('a', 'b', 'c'));
    const out = rebaseYdocState(S0, str('a', 'b', 'c'))!;
    expect(out).not.toBeNull();
    expect(out.length).toBe(S0.length);
    expect(fromYdoc(docFromState(out))).toEqual(fromYdoc(toYdoc(docOf('a', 'b', 'c'))));
  });

  it('(h) 100 writes touching one paragraph out of 20 do not bloat the state', () => {
    const base = Array.from({ length: 20 }, (_, i) => `paragraph number ${i} with some text`);
    let state: Uint8Array = stateOf(docOf(...base));
    let last = base;
    for (let i = 0; i < 100; i++) {
      last = base.map((t, k) => (k === 7 ? `changed ${i}` : t));
      const next = rebaseYdocState(state, str(...last));
      expect(next).not.toBeNull();
      state = next!;
    }
    expect(state.length).toBeLessThan(3 * stateOf(docOf(...last)).length);
    expect(fromYdoc(docFromState(state))).toEqual(fromYdoc(toYdoc(docOf(...last))));
  });
});

describe('rebaseYdocState: normalized form and full-replace branch (H6)', () => {
  it('(a) image/text at the top level: the state decodes to the NORMALIZED form (wrapped in a paragraph)', () => {
    const S0 = stateOf(docOf('a', 'b'));
    const content = { type: 'doc', content: [para('a'), { type: 'image', attrs: { src: 'a.png' } }, { type: 'text', text: 'y' }] };
    const out = rebaseYdocState(S0, JSON.stringify(content));
    expect(out).not.toBeNull();
    const json = fromYdoc(docFromState(out!)) as any;
    // consecutive top-level inline nodes (image + text) share ONE wrapping paragraph
    expect(json.content.map((n: any) => n.type)).toEqual(['paragraph', 'paragraph']);
    expect(json.content[1].content.map((n: any) => n.type)).toEqual(['image', 'text']);
    expect(json.content[1].content[0].attrs.src).toBe('a.png');
    expect(json.content[1].content[1].text).toBe('y');
  });

  it('(b) old state with a top-level Y.XmlText in the fragment: full replace converges to the new content', () => {
    const y = new Y.Doc();
    const frag = y.getXmlFragment('default');
    frag.insert(0, [new Y.XmlText('stray')]);
    const out = rebaseYdocState(Buffer.from(Y.encodeStateAsUpdate(y)), str('new1', 'new2'));
    expect(out).not.toBeNull();
    expect(fromYdoc(docFromState(out!))).toEqual(fromYdoc(toYdoc(docOf('new1', 'new2'))));
  });
});

describe('contentToYNodes (strict)', () => {
  it('(i) converts valid TipTap JSON', () => {
    const nodes = contentToYNodes(str('a', 'b'));
    expect(nodes).toHaveLength(2);
  });

  it('(i) null on an unknown node and on legacy HTML', () => {
    expect(contentToYNodes(TASK_DOC)).toBeNull();
    expect(contentToYNodes('<p>legacy</p>')).toBeNull();
  });

  it('null on structurally invalid docs (listItem at the root)', () => {
    expect(contentToYNodes(JSON.stringify({ type: 'doc', content: [{ type: 'listItem', content: [para('x')] }] }))).toBeNull();
  });

  it('G5: top-level inline nodes are wrapped in a paragraph (consecutive ones share it)', () => {
    const text = contentToYNodes(JSON.stringify({ type: 'doc', content: [{ type: 'text', text: 'x' }] }));
    expect(text).toHaveLength(1);
    expect((text![0] as Y.XmlElement).nodeName).toBe('paragraph');

    const img = { type: 'image', attrs: { src: 'a.png' } };
    const mixed = contentToYNodes(JSON.stringify({ type: 'doc', content: [para('a'), img, { type: 'text', text: 'y' }, para('b')] }));
    expect(mixed!.map((n) => (n as Y.XmlElement).nodeName)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('G5: a lone top-level image converts (wrapped), listItem at root stays null', () => {
    const nodes = contentToYNodes(JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src: 'a.png' } }] }));
    expect(nodes).toHaveLength(1);
    expect((nodes![0] as Y.XmlElement).nodeName).toBe('paragraph');
    expect(contentToYNodes(JSON.stringify({ type: 'doc', content: [{ type: 'listItem', content: [para('x')] }] }))).toBeNull();
  });
});

describe('contentToYdocState (permissive, fetch only)', () => {
  it('falls back to a text paragraph for legacy HTML', () => {
    const s = contentToYdocState('<p>legacy <b>text</b></p>');
    expect(s).not.toBeNull();
    expect(texts(fromYdoc(docFromState(s!)))).toEqual(['legacy  text']);
  });
});
