
const fs = require('fs');
const path = require('path');

function flatten(obj, prefix = '', res = {}) {
  for (const key in obj) {
    const val = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'object' && val !== null) {
      flatten(val, newKey, res);
    } else {
      res[newKey] = val;
    }
  }
  return res;
}

const en = JSON.parse(fs.readFileSync('src/locales/en.json', 'utf8'));
const it = JSON.parse(fs.readFileSync('src/locales/it.json', 'utf8'));

const flatEn = flatten(en);
const flatIt = flatten(it);

const usedKeys = new Set();

function scanDir(dir) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath);
    } else if (stat.isFile() && /\.(tsx?|js)$/.test(entry)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      // Match t('key') or t("key") or i18n.t('key')
      // Regex capturing group 2 is the key
      const regex = /\bt\s*\(\s*(['"])([\w\.-]+)\1/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        usedKeys.add(match[2]);
      }
    }
  }
}

scanDir('src');

const missingEn = [];
const missingIt = [];

for (const key of usedKeys) {
  if (!flatEn[key]) missingEn.push(key);
  if (!flatIt[key]) missingIt.push(key);
}

console.log('--- Missing in EN ---');
console.log(missingEn.join('\n'));
console.log('\n--- Missing in IT ---');
console.log(missingIt.join('\n'));
