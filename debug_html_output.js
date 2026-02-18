
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const filePath = 'd:\\Develop\\AI\\Notiq\\debug_import.enex';
const fileContent = fs.readFileSync(filePath);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: "#text"
});

const xmlData = parser.parse(fileContent);
const notes = Array.isArray(xmlData['en-export'].note) ? xmlData['en-export'].note : [xmlData['en-export'].note];
const enexNote = notes[0];

let content = enexNote.content || '';

console.log('--- ORIGINAL CONTENT ---');
console.log(content);
console.log('------------------------');

// --- APPLYING CURRENT LOGIC FROM import.service.ts ---

// Basic cleanup
content = content.replace(/<\?xml.*?\?>/g, '');
content = content.replace(/<!DOCTYPE.*?>/g, '');
content = content.replace(/<en-note.*?>/g, '');
content = content.replace(/<\/en-note>/g, '');

// STRIP ALL STYLE ATTRIBUTES
content = content.replace(/\s+style="[^"]*"/gi, '');
content = content.replace(/\s+style='[^']*'/gi, '');

// Convert divs to BR
content = content.replace(/<\/div>/gi, '<br/>');
content = content.replace(/<div[^>]*>/gi, '');

// Strip attributes from tables
content = content.replace(/<table[^>]*>/gi, '<table>');
content = content.replace(/<tbody[^>]*>/gi, '<tbody>');
content = content.replace(/<thead[^>]*>/gi, '<thead>');
content = content.replace(/<tr[^>]*>/gi, '<tr>');
content = content.replace(/<td[^>]*>/gi, '<td>');
content = content.replace(/<th[^>]*>/gi, '<th>');

// Clean empty spans
content = content.replace(/<span[^>]*>(.*?)<\/span>/gi, '$1');

// Remove colgroup
content = content.replace(/<colgroup>[\s\S]*?<\/colgroup>/gi, '');
content = content.replace(/<col[^>]*>/gi, '');

// Convert en-todo
content = content.replace(/<en-todo checked="true"[^>]*\/>/gi, '<input type="checkbox" checked disabled /> ');
content = content.replace(/<en-todo[^>]*\/>/gi, '<input type="checkbox" disabled /> ');


console.log('--- FINAL HTML OUTPUT ---');
console.log(content);
fs.writeFileSync('debug_output_full.html', content);
console.log('Written to debug_output_full.html');
