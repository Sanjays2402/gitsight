/**
 * Pure parsing helpers for `git status --porcelain` output.
 *
 * The porcelain v1 format encodes index status (X) and worktree status (Y)
 * as two columns followed by the path:
 *     XY <path>
 *
 *  - ' ' = unmodified
 *  - M = modified, A = added, D = deleted, R = renamed, C = copied, T = type
 *  - ?? = untracked, !! = ignored
 *  - Unmerged (conflicted) combinations: DD, AA, UU, AU, UA, DU, UD.
 *
 * Keep this module dependency-free (no vscode imports) so it can be unit-tested
 * with `node --test` directly.
 */

export interface WorkTreeCounts {
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

export function isConflict(x: string, y: string): boolean {
  if (x === 'U' || y === 'U') return true;
  if (x === 'A' && y === 'A') return true;
  if (x === 'D' && y === 'D') return true;
  return false;
}

export function parsePorcelain(out: string): WorkTreeCounts {
  let staged = 0, modified = 0, untracked = 0, conflicted = 0;
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    if (raw.startsWith('??')) { untracked++; continue; }
    if (raw.startsWith('!!')) continue; // ignored
    if (raw.length < 2) continue;
    const x = raw[0], y = raw[1];
    if (isConflict(x, y)) { conflicted++; continue; }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') modified++;
  }
  return { staged, modified, untracked, conflicted };
}

/** Render a one-line summary used by tooltips. Empty when clean. */
export function describeCounts(c: WorkTreeCounts): string {
  const parts: string[] = [];
  if (c.conflicted) parts.push(`${c.conflicted} conflicted`);
  if (c.staged) parts.push(`${c.staged} staged`);
  if (c.modified) parts.push(`${c.modified} modified`);
  if (c.untracked) parts.push(`${c.untracked} untracked`);
  return parts.join('  ·  ');
}

/** Short pill text (e.g. `+3 ~2 ?1`). Empty when clean. */
export function shortCounts(c: WorkTreeCounts): string {
  const parts: string[] = [];
  if (c.conflicted) parts.push(`!${c.conflicted}`);
  if (c.staged) parts.push(`+${c.staged}`);
  if (c.modified) parts.push(`~${c.modified}`);
  if (c.untracked) parts.push(`?${c.untracked}`);
  return parts.join(' ');
}
