/**
 * Pure helpers for the Branch Namer Assistant (F110).
 *
 * When the user creates a branch via `gitsight.createBranch`, instead of
 * an empty input box we prefill a kebab-cased branch name suggested
 * from:
 *
 *   1. The SCM input box (if it holds a Conventional Commit subject):
 *        "feat: add logout"          -> "feat/add-logout"
 *        "fix(auth): handle 401"     -> "fix/auth-handle-401"
 *        "chore: bump deps"          -> "chore/bump-deps"
 *   2. The current selection in the editor (heuristic: first non-empty
 *      sentence becomes the slug).
 *   3. A small set of dirty / staged paths (mirrors stashNaming).
 *   4. The active editor's filename (last resort).
 *
 * Naming convention (configurable):
 *   <type>/<kebab-subject>
 *   <type>/<ticket>-<kebab-subject>  when a leading [PROJ-123] or
 *                                     `<PROJ-123>` ticket marker is detected
 *
 * Pure -- no vscode, no child_process. Tests in
 * test/git/branchNamer.test.ts.
 */

export interface BranchNameSuggestion {
  /** Final ready-to-create branch name. */
  name: string;
  /** Human-readable label describing how we derived it. */
  source: string;
}

export interface NamerInput {
  /** SCM input box content (the user's in-progress commit message). */
  scmInput?: string;
  /** Active editor's current selection text (first sentence becomes slug). */
  selectionText?: string;
  /** Repo-relative paths of dirty / staged files. */
  dirtyPaths?: string[];
  /** Active editor's repo-relative filename. */
  activeFile?: string;
  /** Repo name (absolute last fallback). */
  repoName?: string;
  /** Optional preferred prefix style: 'slash' (feat/x), 'kebab' (feat-x), or 'none'. */
  separator?: 'slash' | 'kebab' | 'none';
}

/**
 * Kebab-case a string: lowercase, anything non-alnum -> '-', squash,
 * trim. Stable shape so callers can dedup suggestions confidently.
 */
export function kebab(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Conventional Commit type set, mirroring F29. */
const CONVENTIONAL_TYPES = new Set([
  'feat', 'fix', 'docs', 'refactor', 'perf', 'test',
  'chore', 'build', 'ci', 'style', 'revert',
]);

export interface ParsedSubject {
  type?: string;
  scope?: string;
  subject: string;
  breaking: boolean;
  ticket?: string;
}

/**
 * Parse a single-line commit subject into its conventional parts.
 *
 *   "feat(auth): add logout"          -> {type:'feat',scope:'auth',subject:'add logout',breaking:false}
 *   "fix(auth)!: handle 401"          -> {type:'fix', scope:'auth', breaking:true, subject:'handle 401'}
 *   "WIP: hack the planet"            -> {subject:'hack the planet'} (no recognised type)
 *   "PROJ-123 add logout"             -> {ticket:'PROJ-123', subject:'add logout'}
 *   "[PROJ-123] add logout"           -> {ticket:'PROJ-123', subject:'add logout'}
 *
 * Notes:
 *   - The body (anything after the first newline) is discarded; branch
 *     names should be short.
 *   - Subject is trimmed but otherwise verbatim (kebab-casing happens
 *     at the final compose step).
 */
export function parseSubject(raw: string): ParsedSubject {
  if (!raw) return { subject: '', breaking: false };
  const firstLine = raw.split('\n')[0].trim();
  if (!firstLine) return { subject: '', breaking: false };

  // Conventional commit shape: type(scope)!?: subject
  const ccMatch = /^([a-z]+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)$/i.exec(firstLine);
  if (ccMatch) {
    const type = ccMatch[1].toLowerCase();
    if (CONVENTIONAL_TYPES.has(type)) {
      const subject = ccMatch[4].trim();
      const ticket = extractTicket(subject);
      return {
        type,
        scope: ccMatch[2]?.trim() || undefined,
        subject: ticket ? stripTicket(subject) : subject,
        breaking: !!ccMatch[3],
        ticket,
      };
    }
  }

  // Plain subject -- look for a leading ticket marker.
  const ticket = extractTicket(firstLine);
  return {
    subject: ticket ? stripTicket(firstLine) : firstLine,
    breaking: false,
    ticket,
  };
}

const TICKET_RE = /\b([A-Z]{2,10}-\d{1,6})\b/;

function extractTicket(s: string): string | undefined {
  // Prefer a leading [PROJ-123] or PROJ-123 over an inline one.
  const bracketed = /^\s*[\[\(]([A-Z]{2,10}-\d{1,6})[\]\)]\s*/.exec(s);
  if (bracketed) return bracketed[1];
  const leading = /^\s*([A-Z]{2,10}-\d{1,6})\b/.exec(s);
  if (leading) return leading[1];
  const inline = TICKET_RE.exec(s);
  return inline ? inline[1] : undefined;
}

function stripTicket(s: string): string {
  return s
    .replace(/^\s*[\[\(]([A-Z]{2,10}-\d{1,6})[\]\)]\s*/, '')
    .replace(/^\s*([A-Z]{2,10}-\d{1,6})[\s\-:]+/, '')
    .trim();
}

/**
 * Compose the final branch name.
 *
 *   composeBranchName({type:'feat', subject:'add logout'}, 'slash')
 *     -> 'feat/add-logout'
 *
 *   composeBranchName({type:'fix', ticket:'PROJ-123', subject:'401 leak'}, 'slash')
 *     -> 'fix/proj-123-401-leak'
 *
 *   composeBranchName({subject:'misc'}, 'slash')
 *     -> 'misc'
 */
export function composeBranchName(parsed: ParsedSubject, separator: 'slash' | 'kebab' | 'none' = 'slash'): string {
  const slug = composeSlug(parsed);
  if (!parsed.type) return slug || 'wip';
  const sep = separator === 'slash' ? '/' : separator === 'kebab' ? '-' : '';
  if (separator === 'none') return slug || parsed.type;
  if (!slug) return parsed.type;
  return `${parsed.type}${sep}${slug}`;
}

function composeSlug(parsed: ParsedSubject): string {
  const parts: string[] = [];
  if (parsed.ticket) parts.push(kebab(parsed.ticket));
  if (parsed.subject) parts.push(kebab(parsed.subject));
  return parts.filter(Boolean).join('-');
}

/**
 * Cap a branch name at a reasonable length. Git itself allows long names
 * but they make terminal output awful. 60 chars is a common house style.
 */
export function capBranchName(name: string, max = 60): string {
  if (name.length <= max) return name;
  const head = name.slice(0, max);
  // Don't end on a trailing dash; trim back to the last clean boundary.
  return head.replace(/-+$/, '').replace(/\/$/, '');
}

/**
 * Build the ranked list of branch-name suggestions for a picker.
 *
 * Ranking (best-first):
 *   1. SCM input as a parsed conventional commit.
 *   2. SCM input as a plain leading ticket + subject.
 *   3. Selection text first-sentence.
 *   4. Dirty paths: single-file basename or common top-level dir.
 *   5. Active filename.
 *   6. Repo name (absolute fallback).
 */
export function suggestBranchNames(input: NamerInput): BranchNameSuggestion[] {
  const out: BranchNameSuggestion[] = [];
  const sep: 'slash' | 'kebab' | 'none' = input.separator ?? 'slash';

  // 1+2. SCM input.
  if (input.scmInput && input.scmInput.trim()) {
    const parsed = parseSubject(input.scmInput);
    const name = capBranchName(composeBranchName(parsed, sep));
    if (name) {
      const detail = parsed.type
        ? `from SCM input: ${parsed.type}${parsed.scope ? '(' + parsed.scope + ')' : ''}: ${truncate(parsed.subject, 40)}`
        : `from SCM input: ${truncate(parsed.subject, 50)}`;
      out.push({ name, source: detail });
    }
  }

  // 3. Selection text first non-trivial sentence.
  if (input.selectionText && input.selectionText.trim()) {
    const sentence = firstSentence(input.selectionText);
    if (sentence) {
      const parsed = parseSubject(sentence);
      const name = capBranchName(composeBranchName(parsed, sep));
      if (name) out.push({ name, source: `from selection: ${truncate(sentence, 50)}` });
    }
  }

  // 4. Dirty paths.
  const dirty = input.dirtyPaths ?? [];
  if (dirty.length === 1) {
    const base = dirty[0].split('/').pop()!.replace(/\.[^.]+$/, '');
    const name = capBranchName(`wip-${kebab(base)}`);
    if (base) out.push({ name, source: `single file ${dirty[0]}` });
  } else if (dirty.length > 1) {
    const top = topLevelDir(dirty);
    if (top) {
      const name = capBranchName(`wip-${kebab(top)}`);
      out.push({ name, source: `dirty under ${top}/ (${dirty.length} files)` });
    }
  }

  // 5. Active filename.
  if (input.activeFile) {
    const base = input.activeFile.split('/').pop()!.replace(/\.[^.]+$/, '');
    if (base) {
      const name = capBranchName(`wip-${kebab(base)}`);
      out.push({ name, source: `active file ${input.activeFile}` });
    }
  }

  // 6. Repo name (absolute fallback).
  if (input.repoName) {
    out.push({ name: capBranchName(`wip-${kebab(input.repoName)}`), source: 'repo name (fallback)' });
  }

  // Dedupe preserving order.
  const seen = new Set<string>();
  const unique: BranchNameSuggestion[] = [];
  for (const s of out) {
    if (!s.name || seen.has(s.name)) continue;
    seen.add(s.name);
    unique.push(s);
  }
  return unique;
}

function firstSentence(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  // Sentence-split on `.`, `!`, `?` -- but only if followed by whitespace
  // OR end-of-string (avoid splitting "v1.2.3" into 3 sentences).
  const m = /[^.!?\n]+[.!?](?=\s|$)/.exec(trimmed);
  const sentence = (m ? m[0] : trimmed.split('\n')[0]).trim();
  // Strip trailing punctuation; we'll re-add nothing in the kebab pass.
  return sentence.replace(/[.!?]+$/, '');
}

function topLevelDir(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const seg = p.split('/').filter(Boolean);
    if (seg.length < 2) continue;
    let i = 0;
    const skip = new Set(['src', 'lib', 'app', 'packages']);
    while (i < seg.length && skip.has(seg[i].toLowerCase())) i++;
    if (i >= seg.length) continue;
    counts.set(seg[i], (counts.get(seg[i]) ?? 0) + 1);
  }
  if (!counts.size) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '\u2026';
}

/** Pick the top suggestion (for `defaultValue` prefill). */
export function bestBranchSuggestion(input: NamerInput): string {
  const all = suggestBranchNames(input);
  return all[0]?.name ?? 'wip';
}

/**
 * Validate a branch name against `git check-ref-format --branch` rules
 * (subset). Returns an error message when invalid, undefined when ok.
 *
 * The full rule set is huge -- this catches the common foot-guns the
 * picker is likely to feed:
 *   - empty
 *   - leading or trailing '/'
 *   - '..', '@{', or any of \\ : ? * [ space
 *   - ends in '.lock'
 */
export function validateBranchName(name: string): string | undefined {
  if (!name || !name.trim()) return 'branch name is empty';
  if (name.startsWith('/') || name.endsWith('/')) return 'branch name cannot start or end with `/`';
  if (name.startsWith('.') || name.endsWith('.')) return 'branch name cannot start or end with `.`';
  if (name.includes('..')) return 'branch name cannot contain `..`';
  if (name.includes('@{')) return 'branch name cannot contain `@{`';
  if (name.endsWith('.lock')) return 'branch name cannot end with `.lock`';
  if (/[\\\x00-\x20\x7f:?*\[]/.test(name)) return 'branch name contains an illegal character';
  if (/\/\//.test(name)) return 'branch name cannot contain `//`';
  return undefined;
}
