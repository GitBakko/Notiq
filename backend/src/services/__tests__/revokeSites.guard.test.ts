import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The kanban SSE heartbeat re-resolves authorization on every tick, so a revocation that
 * `assertBoardAccess` can SEE — the user row, the board row or the share row disappearing —
 * closes the stream on its own and needs no call site.
 *
 * `tokenVersion` is the one class it is structurally blind to: board access is still
 * perfectly valid, only the credentials died. That is the gap this guard watches. It is an
 * import-level canary, not a call assertion — the calls themselves are pinned in
 * `auth.service.test.ts` and `user.service.test.ts`.
 *
 * Do NOT widen it to chase other revoke shapes: the tick already covers those, and a guard
 * that fails for reasons nobody can act on gets deleted by the next person.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('revocation sites the SSE heartbeat cannot see', () => {
  it('every file that bumps tokenVersion also kicks the kanban event streams', () => {
    const offenders = sourceFiles(join(__dirname, '..', '..'))
      .filter((f) => /tokenVersion:/.test(readFileSync(f, 'utf8')))
      // app.ts and the SSE module itself only READ tokenVersion to compare it.
      .filter((f) => /tokenVersion:\s*\{\s*increment/.test(readFileSync(f, 'utf8')))
      .filter((f) => !/from\s+'[./]*kanbanSSE'/.test(readFileSync(f, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('watches at least the two sites known to bump it', () => {
    // A guard that silently matches nothing is worse than no guard: if the regex or the
    // directory walk ever stops finding these, the test above passes vacuously.
    const bumpers = sourceFiles(join(__dirname, '..', '..'))
      .filter((f) => /tokenVersion:\s*\{\s*increment/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/').split('/').pop());

    expect(bumpers).toEqual(expect.arrayContaining(['auth.service.ts', 'user.service.ts']));
  });
});
