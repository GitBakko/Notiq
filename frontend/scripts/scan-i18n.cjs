const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '../src');
const LOCALES_DIR = path.join(SRC_DIR, 'locales');
const EN_PATH = path.join(LOCALES_DIR, 'en.json');
const IT_PATH = path.join(LOCALES_DIR, 'it.json');

// Regex for finding t('key') calls
const T_CALL_REGEX = /\bt\(['"]([^'"]+)['"]\)/g;

// Regex for potential hardcoded strings in JSX
// Matches >Text<, excluding tags and braces
const JSX_TEXT_REGEX = />([^<>{}\n]+)</g;

// Regex for specific attributes that often contain user-visible text
const ATTR_REGEX = /\b(placeholder|title|alt|label|aria-label)=['"]([^'"]+)['"]/g;

// Ignore list for hardcoded strings (common non-text items)
const IGNORE_STRINGS = [
  ' ', '', ':', '-', '/', '*', '+', '=', '|', '•', '·', '—', '>', '<',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'http', 'https', 'blob', 'data',
  '#',
];

function getAllFiles(dir, exts = ['.ts', '.tsx']) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(file));
    } else {
      if (exts.includes(path.extname(file))) {
        results.push(file);
      }
    }
  });
  return results;
}

function scan() {
  console.log('--- Starting Localization Audit ---');

  // 1. Load Locales
  let enString = fs.readFileSync(EN_PATH, 'utf8');
  // Simple JSON parse might fail if there are comments (standard JSON doesn't support them, but checking anyway)
  // Assuming standard JSON for now.
  const en = JSON.parse(enString);
  const it = JSON.parse(fs.readFileSync(IT_PATH, 'utf8'));

  const enKeys = flattenKeys(en);
  const itKeys = flattenKeys(it);

  // 2. Scan Code
  const files = getAllFiles(SRC_DIR);
  const usedKeys = new Set();
  const hardcodedCandidates = [];

  files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');

    // Find t() calls
    let match;
    while ((match = T_CALL_REGEX.exec(content)) !== null) {
      usedKeys.add(match[1]);
    }

    // Find Hardcoded Text (Naive check)
    // Only check React components files
    if (file.endsWith('.tsx')) {
      let textMatch;
      while ((textMatch = JSX_TEXT_REGEX.exec(content)) !== null) {
        const text = textMatch[1].trim();
        if (text.length > 1 && !IGNORE_STRINGS.includes(text) && !/^\d+$/.test(text)) {
          // heuristic: if it contains letters
          if (/[a-zA-Z]/.test(text)) {
            hardcodedCandidates.push({ file: path.relative(SRC_DIR, file), text, line: '?' });
          }
        }
      }

      let attrMatch;
      while ((attrMatch = ATTR_REGEX.exec(content)) !== null) {
        const text = attrMatch[2].trim();
        if (text.length > 1 && !IGNORE_STRINGS.includes(text) && /[a-zA-Z]/.test(text)) {
          hardcodedCandidates.push({ file: path.relative(SRC_DIR, file), text: `[${attrMatch[1]}] ${text}`, line: '?' });
        }
      }
    }
  });

  // 3. Analyze
  const missingEn = [];
  const missingIt = [];

  usedKeys.forEach(key => {
    if (!enKeys.has(key)) missingEn.push(key);
    if (!itKeys.has(key)) missingIt.push(key);
  });

  // 4. Report
  console.log(`\nFiles Scanned: ${files.length}`);
  console.log(`Keys Used: ${usedKeys.size}`);

  console.log(`\n--- Missing Keys in EN (${missingEn.length}) ---`);
  missingEn.forEach(k => console.log(`[ ] ${k}`));

  console.log(`\n--- Missing Keys in IT (${missingIt.length}) ---`);
  missingIt.forEach(k => console.log(`[ ] ${k}`));

  console.log(`\n--- Potential Hardcoded Strings (${hardcodedCandidates.length}) ---`);
  // Group by file
  const byFile = {};
  hardcodedCandidates.forEach(c => {
    if (!byFile[c.file]) byFile[c.file] = [];
    byFile[c.file].push(c.text);
  });

  Object.keys(byFile).sort().forEach(f => {
    console.log(`\nFile: ${f}`);
    // Dedupe strings per file
    const strings = [...new Set(byFile[f])];
    strings.forEach(s => console.log(`  - "${s}"`));
  });

  console.log('\n--- Audit Complete ---');
}

function flattenKeys(obj, prefix = '') {
  let keys = new Set();
  for (let k in obj) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const children = flattenKeys(obj[k], prefix + k + '.');
      children.forEach(c => keys.add(c));
    } else {
      keys.add(prefix + k);
    }
  }
  return keys;
}

scan();
