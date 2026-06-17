#!/usr/bin/env node
/*
 * Notiq — critical-file edit guard (PreToolUse: Write|Edit|MultiEdit)
 * Enforces the CLAUDE.md "proponi prima, applica dopo" rule by requiring an
 * explicit user confirmation (permissionDecision: "ask") before any edit to a
 * TIER-1 (data-loss/corruption risk) or TIER-2 (cross-cutting) file.
 * Non-matching edits pass through untouched (exit 0, no output).
 * Remove by deleting the PreToolUse entry in .claude/settings.local.json.
 */
const fs = require('fs');

// TIER 1 — rischio data-loss / corruzione (CLAUDE.md "AREE CRITICHE")
const TIER1 = [
  'frontend/src/features/sync/syncService.ts',
  'frontend/src/lib/db.ts',
  'frontend/src/utils/crypto.ts',
  'frontend/src/store/vaultStore.ts',
  'backend/src/hocuspocus.ts',
  'backend/prisma/schema.prisma',
];

// TIER 2 — impatto trasversale
const TIER2 = [
  'frontend/src/lib/api.ts',
  'frontend/src/store/authStore.ts',
  'backend/src/app.ts',
  'backend/src/services/auth.service.ts',
  'frontend/src/components/editor/Editor.tsx',
  'backend/src/services/email.service.ts',
];

function norm(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^.*\/Notiq\//i, '')
    .replace(/^\.\//, '');
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
let data = {};
try { data = JSON.parse(raw || '{}'); } catch (_) {}

const fp = norm(data && data.tool_input && data.tool_input.file_path);
if (!fp) process.exit(0);

const t1 = TIER1.some((f) => fp.endsWith(f));
const t2 = !t1 && TIER2.some((f) => fp.endsWith(f));
if (!t1 && !t2) process.exit(0);

const tier = t1
  ? 'TIER 1 (rischio data-loss / corruzione)'
  : 'TIER 2 (impatto trasversale)';
const dexie = fp.endsWith('lib/db.ts')
  ? ' MAI modificare versioni Dexie esistenti — solo aggiungerne di nuove.'
  : '';
const reason =
  `${fp} e' ${tier} in CLAUDE.md. Regola progetto: proponi il diff e ` +
  `attendi conferma esplicita prima di applicare.${dexie}`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  })
);
process.exit(0);
