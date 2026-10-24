import { describe, it, expect } from 'vitest';
import { isLocalImageSrc, stripRemoteImagesFromContent } from '../remoteImages';

const img = (src: string) => ({ type: 'image', attrs: { src } });
const doc = (...inline: unknown[]) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ciao' }, ...inline] }] });

describe('isLocalImageSrc', () => {
  it('solo /uploads/ e\' locale', () => {
    expect(isLocalImageSrc('/uploads/a.png')).toBe(true);
    for (const s of ['http://x/a.png', 'https://x/a.png', '//x/a.png', 'data:image/png;base64,AAAA', '/other/a.png', '', null, undefined, 3]) {
      expect(isLocalImageSrc(s)).toBe(false);
    }
  });
});

describe('stripRemoteImagesFromContent', () => {
  it('JSON: toglie le immagini non locali e tiene il testo', () => {
    const r = stripRemoteImagesFromContent(doc(img('https://x/a.png'), img('http://x/b.png'), img('//x/c.png'), img('data:image/png;base64,AAAA')));
    expect(r.removed).toBe(4);
    expect(JSON.parse(r.content).content[0].content).toEqual([{ type: 'text', text: 'ciao' }]);
  });

  it('JSON: tiene /uploads/ e restituisce la stessa stringa', () => {
    const s = doc(img('/uploads/x.png'));
    const r = stripRemoteImagesFromContent(s);
    expect(r).toEqual({ content: s, removed: 0 });
  });

  it('JSON: immagini annidate (lista, tabella)', () => {
    const s = JSON.stringify({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [img('https://x/a.png')] }] }] }] });
    const r = stripRemoteImagesFromContent(s);
    expect(r.removed).toBe(1);
    expect(r.content).not.toContain('https://x/a.png');
  });

  it('HTML: toglie gli img non locali senza caricarli e tiene il testo', () => {
    const r = stripRemoteImagesFromContent('<p>ciao <img src="https://x/a.png"><img src="/uploads/b.png"></p>');
    expect(r.removed).toBe(1);
    expect(r.content).not.toContain('https://x/a.png');
    expect(r.content).toContain('/uploads/b.png');
    expect(r.content).toContain('ciao');
  });

  it('senza immagini: identita\' (JSON, HTML, vuoto)', () => {
    for (const s of ['', '<p>solo testo</p>', doc(), 'testo grezzo non json']) {
      expect(stripRemoteImagesFromContent(s)).toEqual({ content: s, removed: 0 });
    }
  });
});
