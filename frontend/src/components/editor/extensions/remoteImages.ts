import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';

// Vault v3 (F.13): una nota vault non deve mai caricare risorse remote (web beacon: l'<img src> rivela IP e orario di apertura).
// Locale = solo /uploads/. Tutto il resto (http, https, //host, data:, ...) si toglie.

export const isLocalImageSrc = (s: unknown): boolean => typeof s === 'string' && s.startsWith('/uploads/');

interface JsonNode { type?: string; attrs?: { src?: unknown }; content?: JsonNode[] }

const stripJson = (n: JsonNode): number => {
  if (!Array.isArray(n.content)) return 0;
  let removed = 0;
  n.content = n.content.filter((c) => {
    if (c?.type === 'image' && !isLocalImageSrc(c.attrs?.src)) { removed++; return false; }
    return true;
  });
  for (const c of n.content) if (c) removed += stripJson(c);
  return removed;
};

// Contenuto della nota (JSON TipTap o HTML legacy). Senza immagini remote restituisce la STESSA stringa.
export function stripRemoteImagesFromContent(str: string): { content: string; removed: number } {
  if (!str) return { content: str, removed: 0 };
  try {
    const json = JSON.parse(str) as JsonNode | null;
    if (json && typeof json === 'object') {
      const removed = stripJson(json);
      return removed ? { content: JSON.stringify(json), removed } : { content: str, removed: 0 };
    }
  } catch { /* non e' JSON: HTML */ }
  // DOMParser 'text/html' e' inerte: non carica le immagini
  const body = new DOMParser().parseFromString(str, 'text/html').body;
  let removed = 0;
  body.querySelectorAll('img').forEach((el) => {
    if (!isLocalImageSrc(el.getAttribute('src'))) { el.remove(); removed++; }
  });
  return removed ? { content: body.innerHTML, removed } : { content: str, removed: 0 };
}

const stripFragment = (f: Fragment): { fragment: Fragment; removed: number } => {
  const out: PMNode[] = [];
  let removed = 0;
  f.forEach((n) => {
    if (n.type.name === 'image' && !isLocalImageSrc(n.attrs.src)) { removed++; return; }
    if (n.content.size) {
      const r = stripFragment(n.content);
      removed += r.removed;
      out.push(r.removed ? n.copy(r.fragment) : n);
    } else out.push(n);
  });
  return { fragment: removed ? Fragment.fromArray(out) : f, removed };
};

// Per transformPasted: paste e drop di HTML con <img> remoti.
export function stripSlice(slice: Slice): { slice: Slice; removed: number } {
  const r = stripFragment(slice.content);
  return r.removed ? { slice: new Slice(r.fragment, slice.openStart, slice.openEnd), removed: r.removed } : { slice, removed: 0 };
}
