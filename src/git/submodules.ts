/**
 * Pure helpers for the Submodule Status Pill (F59).
 *
 * Parses `git submodule status --recursive` output into a list of submodule
 * entries with their state, plus a roll-up summary for the status-bar pill.
 *
 * `git submodule status` line format:
 *
 *   <prefix><sha> <path> (<describe>)
 *
 * where <prefix> is exactly one character:
 *   ' '   in sync (sha matches the recorded gitlink)
 *   '+'   out of sync (sha differs)
 *   '-'   not initialised (no work-tree)
 *   'U'   has merge conflicts
 *
 * The trailing `(...)` is `git describe` output for the checked-out commit
 * — optional.
 *
 * Pure — no vscode, no child_process. Tests in test/git/submodules.test.ts.
 */

export type SubmoduleState = 'in-sync' | 'out-of-sync' | 'uninitialised' | 'conflicted' | 'unknown';

export interface Submodule {
  /** Path relative to the parent repo. */
  path: string;
  sha: string;
  state: SubmoduleState;
  /** Describe string e.g. "v1.2.3-2-gabcdef0". Undefined when absent. */
  describe?: string;
}

export interface SubmoduleSummary {
  total: number;
  inSync: number;
  outOfSync: number;
  uninitialised: number;
  conflicted: number;
  /** True when every submodule is in sync and initialised. */
  clean: boolean;
}

/** Parse `git submodule status [--recursive]` output. */
export function parseSubmoduleStatus(raw: string): Submodule[] {
  const out: Submodule[] = [];
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = /^([ +\-U])([0-9a-f]+)\s+(.+?)(?:\s+\((.+)\))?$/.exec(line);
    if (!m) continue;
    const [, prefix, sha, path, describe] = m;
    out.push({
      path,
      sha,
      state: stateFor(prefix),
      describe: describe?.trim() || undefined,
    });
  }
  return out;
}

function stateFor(prefix: string): SubmoduleState {
  switch (prefix) {
    case ' ': return 'in-sync';
    case '+': return 'out-of-sync';
    case '-': return 'uninitialised';
    case 'U': return 'conflicted';
    default:  return 'unknown';
  }
}

/** Roll up a list of submodules for the status-bar pill. */
export function summariseSubmodules(subs: Submodule[]): SubmoduleSummary {
  const s: SubmoduleSummary = {
    total: subs.length,
    inSync: 0,
    outOfSync: 0,
    uninitialised: 0,
    conflicted: 0,
    clean: true,
  };
  for (const sub of subs) {
    if (sub.state === 'in-sync') s.inSync++;
    else if (sub.state === 'out-of-sync') s.outOfSync++;
    else if (sub.state === 'uninitialised') s.uninitialised++;
    else if (sub.state === 'conflicted') s.conflicted++;
  }
  s.clean = s.total > 0 && s.outOfSync === 0 && s.uninitialised === 0 && s.conflicted === 0;
  return s;
}

/**
 * Format the summary into a tiny status-bar label. Mirrors the existing
 * GitSight pill conventions: single glyph + counts, no emoji, no colour
 * codes (let VS Code's `backgroundColor` warning theme drive emphasis).
 *
 * Examples:
 *   "$(repo-forked) 3 in sync"
 *   "$(repo-forked) 3 \u00b7 1 out-of-sync"
 *   "$(repo-forked) 3 \u00b7 1 out \u00b7 2 not init"
 */
export function formatPillLabel(s: SubmoduleSummary): string {
  if (s.total === 0) return '';
  const bits: string[] = [String(s.total)];
  if (s.outOfSync) bits.push(`${s.outOfSync} out`);
  if (s.uninitialised) bits.push(`${s.uninitialised} not init`);
  if (s.conflicted) bits.push(`${s.conflicted} conflict`);
  if (bits.length === 1) bits.push('in sync');
  return `$(repo-forked) ${bits.join(' \u00b7 ')}`;
}

/**
 * Severity drives the status-bar background. `warning` for out-of-sync or
 * uninitialised, `error` for conflicts; otherwise no background.
 */
export type PillSeverity = 'none' | 'warning' | 'error';

export function pillSeverity(s: SubmoduleSummary): PillSeverity {
  if (s.conflicted > 0) return 'error';
  if (s.outOfSync > 0 || s.uninitialised > 0) return 'warning';
  return 'none';
}

/** Multi-line markdown tooltip body listing each submodule's state. */
export function formatTooltipMarkdown(subs: Submodule[]): string {
  if (!subs.length) return '_No submodules._';
  const s = summariseSubmodules(subs);
  const header = `**${s.total} submodule${s.total === 1 ? '' : 's'}**`;
  const lines: string[] = [header, ''];
  for (const sub of subs) {
    lines.push(`- \`${escape(sub.path)}\` \u2014 ${describeState(sub)}`);
  }
  return lines.join('\n');
}

function describeState(sub: Submodule): string {
  const sha = sub.sha.slice(0, 7);
  const tail = sub.describe ? ` (${sub.describe})` : '';
  switch (sub.state) {
    case 'in-sync':       return `in sync at \`${sha}\`${tail}`;
    case 'out-of-sync':   return `out of sync \u2014 working copy at \`${sha}\`${tail}, but the parent records something else`;
    case 'uninitialised': return 'not initialised \u2014 run `git submodule update --init`';
    case 'conflicted':    return 'merge conflict in the submodule';
    case 'unknown':       return `unknown state at \`${sha}\``;
  }
}

function escape(s: string): string {
  return s.replace(/`/g, '\\`');
}
