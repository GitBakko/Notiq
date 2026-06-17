#!/usr/bin/env node
/*
 * Notiq — auto-lint (PostToolUse: Write|Edit|MultiEdit)
 * Runs `eslint --fix` on the edited .ts/.tsx file in the BACKGROUND (detached,
 * non-blocking) so it never adds latency to the edit. Only fires for files under
 * frontend/src or backend/src. Remove by deleting the PostToolUse entry in
 * .claude/settings.local.json.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
let data = {};
try { data = JSON.parse(raw || '{}'); } catch (_) {}

const fp = String(
  (data && data.tool_input && data.tool_input.file_path) || ''
).replace(/\\/g, '/');
if (!/\.(ts|tsx)$/.test(fp)) process.exit(0);

const root = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, '/');
let cwd = null;
if (/\/frontend\/src\//.test(fp)) cwd = path.join(root, 'frontend');
else if (/\/backend\/src\//.test(fp)) cwd = path.join(root, 'backend');
if (!cwd) process.exit(0);

const isWin = process.platform === 'win32';
try {
  const child = spawn(isWin ? 'npx.cmd' : 'npx', ['eslint', '--fix', fp], {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();
} catch (_) {}
process.exit(0);
