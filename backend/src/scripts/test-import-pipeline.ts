/**
 * Test script for the ENEX import pipeline.
 * Run: npx tsx src/scripts/test-import-pipeline.ts
 */
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { generateJSON } from '@tiptap/core';
import { extensions } from '../hocuspocus';
import { JSDOM } from 'jsdom';
import { extractTextFromTipTapJson } from '../utils/extractText';

function withDomEnvironment<T>(fn: () => T): T {
  const dom = new JSDOM('');
  const origWindow = (globalThis as any).window;
  (globalThis as any).window = dom.window;
  try { return fn(); }
  finally {
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
  }
}

// =======================================
// TEST 1: Simple known-good table HTML
// =======================================
console.log('=== TEST 1: Simple table ===');
const simpleTable = '<table><tbody><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td><td><p>D</p></td></tr></tbody></table>';

try {
  const json1 = withDomEnvironment(() => generateJSON(simpleTable, extensions));
  console.log('Result:', JSON.stringify(json1).substring(0, 300));
  const tables = json1.content?.filter((n: any) => n.type === 'table') || [];
  console.log('Tables:', tables.length);
  console.log(tables.length > 0 ? 'PASS' : 'FAIL - no tables');
} catch (err: any) {
  console.error('FAILED:', err.message);
}

// =======================================
// TEST 2: Table with paragraphs inside wrapper
// =======================================
console.log('\n=== TEST 2: Table with <p> wrapping ===');
const tableWithP = '<p>Before</p><table><tbody><tr><td><p>Cell 1</p></td><td><p>Cell 2</p></td></tr></tbody></table><p>After</p>';

try {
  const json2 = withDomEnvironment(() => generateJSON(tableWithP, extensions));
  const types2 = json2.content?.map((n: any) => n.type) || [];
  console.log('Node types:', types2);
  console.log(types2.includes('table') ? 'PASS' : 'FAIL - no table');
} catch (err: any) {
  console.error('FAILED:', err.message);
}

// =======================================
// TEST 3: Check DOMParser parsing (jsdom)
// =======================================
console.log('\n=== TEST 3: DOMParser output (jsdom) ===');
const testHtml = '<table><tbody><tr><td><p>Hello</p></td></tr></tbody></table>';
const dom3 = new JSDOM('');
const doc = new dom3.window.DOMParser().parseFromString(`<body>${testHtml}</body>`, 'text/html');
console.log('Body innerHTML:', doc.body?.innerHTML?.substring(0, 200) || 'NO BODY');
console.log('Body children:', doc.body?.childNodes?.length);

// =======================================
// TEST 4: Full ENEX note - small sample
// =======================================
console.log('\n=== TEST 4: ENEX table (first 2 rows only) ===');
const enexPath = path.join(process.cwd(), '..', 'debug_import.enex');
if (fs.existsSync(enexPath)) {
  const buffer = fs.readFileSync(enexPath);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text' });
  const xmlData = parser.parse(buffer);
  const note = Array.isArray(xmlData['en-export'].note) ? xmlData['en-export'].note[0] : xmlData['en-export'].note;

  let content = note.content || '';

  // Phase 1
  content = content.replace(/<\?xml.*?\?>/g, '');
  content = content.replace(/<!DOCTYPE.*?>/g, '');
  content = content.replace(/<en-note[^>]*>/g, '');
  content = content.replace(/<\/en-note>/g, '');

  // Phase 4: Strip styles
  content = content.replace(/\s+style="[^"]*"/gi, '');
  content = content.replace(/\s+style='[^']*'/gi, '');
  content = content.replace(/\s+rev="[^"]*"/gi, '');

  // Phase 5
  content = content.replace(/<\/?(span|font|center|small|big)[^>]*>/gi, '');

  // Phase 6: Smart DIV inside cells
  content = content.replace(/(<t[dh][^>]*>)([\s\S]*?)(<\/t[dh]>)/gi, (_m: string, open: string, inner: string, close: string) => {
    const cleaned = inner.replace(/<div[^>]*>/gi, '').replace(/<\/div>/gi, '<br/>');
    return open + cleaned + close;
  });
  content = content.replace(/<div[^>]*>/gi, '<p>');
  content = content.replace(/<\/div>/gi, '</p>');

  // Phase 7: Table cleanup
  content = content.replace(/<table[^>]*>/gi, '<table>');
  content = content.replace(/<tbody[^>]*>/gi, '<tbody>');
  content = content.replace(/<thead[^>]*>/gi, '');
  content = content.replace(/<\/thead>/gi, '');
  content = content.replace(/<tr[^>]*>/gi, '<tr>');
  content = content.replace(/<td[^>]*>/gi, '<td>');
  content = content.replace(/<th[^>]*>/gi, '<td>');
  content = content.replace(/<\/th>/gi, '</td>');
  content = content.replace(/<colgroup>[\s\S]*?<\/colgroup>/gi, '');
  content = content.replace(/<col[^>]*\/?>/gi, '');
  if (content.includes('<table>') && !content.includes('<table><tbody>')) {
    content = content.replace(/<table>/gi, '<table><tbody>');
  }
  if (content.includes('</table>') && !content.includes('</tbody></table>')) {
    content = content.replace(/<\/table>/gi, '</tbody></table>');
  }

  // Phase 8: Wrap cell content
  content = content.replace(/<td>([\s\S]*?)<\/td>/gi, (_m: string, inner: string) => {
    const trimmed = inner.trim();
    if (/^<(p|h[1-6]|ul|ol|blockquote|pre)[\s>]/i.test(trimmed)) return `<td>${trimmed}</td>`;
    const parts = trimmed.split(/<br\s*\/?>/gi).filter((p: string) => p.trim() !== '');
    if (parts.length === 0) return '<td><p></p></td>';
    return '<td>' + parts.map((p: string) => `<p>${p.trim()}</p>`).join('') + '</td>';
  });

  // Phase 9
  content = content.replace(/>\s+</g, '><');

  // Find the table and take only first 2 rows
  const tableStart = content.indexOf('<table>');
  const tableEnd = content.indexOf('</table>');

  if (tableStart >= 0 && tableEnd >= 0) {
    const tableContent = content.substring(tableStart, tableEnd + 8);

    // Count rows
    const rowCount = (tableContent.match(/<tr>/gi) || []).length;
    console.log(`Full table: ${rowCount} rows, ${tableContent.length} chars`);

    // Extract first 2 rows
    const rows = tableContent.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
    console.log(`Extracted ${rows.length} rows`);

    if (rows.length >= 2) {
      const smallTable = `<table><tbody>${rows[0]}${rows[1]}</tbody></table>`;
      console.log(`Small table HTML (${smallTable.length} chars):`);
      console.log(smallTable.substring(0, 500));

      try {
        const json4 = withDomEnvironment(() => generateJSON(smallTable, extensions));
        const types4 = json4.content?.map((n: any) => n.type) || [];
        console.log('Node types:', types4);
        console.log('Full JSON:', JSON.stringify(json4).substring(0, 500));
        console.log(types4.includes('table') ? 'PASS' : 'FAIL');
      } catch (err: any) {
        console.error('FAILED:', err.message);
      }
    }
  } else {
    console.log('No table found in cleaned content');
    console.log('Content starts with:', content.substring(0, 500));
  }
  // TEST 5: Full content through generateJSON
  console.log('\n=== TEST 5: Full ENEX content (all rows) ===');
  try {
    const jsonFull = withDomEnvironment(() => generateJSON(content, extensions));
    const typesFull = jsonFull.content?.map((n: any) => n.type) || [];
    const typeCountsFull: Record<string, number> = {};
    for (const t of typesFull) { typeCountsFull[t] = (typeCountsFull[t] || 0) + 1; }
    console.log('Node types:', typeCountsFull);

    const fullTables = jsonFull.content?.filter((n: any) => n.type === 'table') || [];
    if (fullTables.length > 0) {
      const fullRows = fullTables[0].content || [];
      console.log(`Table rows: ${fullRows.length}`);
    }

    const fullJsonStr = JSON.stringify(jsonFull);
    const fullSearchText = extractTextFromTipTapJson(fullJsonStr);
    console.log(`JSON size: ${fullJsonStr.length} chars`);
    console.log(`Search text (first 200): ${fullSearchText.substring(0, 200)}...`);
    console.log(typeCountsFull['table'] ? 'PASS' : 'FAIL');
  } catch (err: any) {
    console.error('FAILED:', err.message);
  }
} else {
  console.log('ENEX file not found, skipping');
}
