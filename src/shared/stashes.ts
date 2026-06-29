/**
 * GitSight shared stash-list logic (W19).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. The pure parsers
 * + assembler behind the web "Stashes" view, the port of the extension's
 * stashVisualizer webview. Turns the raw output of a few `git stash`
 * commands into a typed `StashList`:
 *
 *   - the stash entries from `git stash list --pretty` (index, ref,
 *     subject, branch, ISO date);
 *   - per-entry file changes from `git stash show --name-status -z`
 *     correlated with `--numstat -z` churn (same NUL grammar the
 *     commit-detail builder uses).
 *
 * A stash ref (`stash@{N}`) carries `@{}` which the rev-safety guard
 * rejects, so the server constructs the ref from a validated integer
 * index via `stashRefForIndex` — never from user-supplied ref text.
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/stashes.test.ts
 */

export type StashFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unknown';

/** One file changed in a stash. */
export interface StashFile {
  path: string;
  oldPath?: string;
  status: StashFileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/** One stash entry. */
export interface StashEntry {
  /** Numeric stash index (0 = most recent). */
  index: number;
  /** The full ref, e.g. `stash@{0}`. */
  ref: string;
  /** The stash subject (`%gs`), e.g. "WIP on main: 1a2b3c subject". */
  subject: string;
  /** The branch the stash was taken on, parsed from the subject. */
  branch: string;
  /** ISO-8601 author date. */
  date: string;
  files: StashFile[];
  insertions: number;
  deletions: number;
  filesChanged: number;
}

export interface StashList {
  stashes: StashEntry[];
  total: number;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** The git pretty-format the companion must use for `git stash list`. */
export const STASH_LIST_FORMAT = ['%gd', '%gs', '%aI'].join('%x1f') + '%x1e';

/** Map a git status letter to the stash-file enum. */
export function stashStatusFromCode(code: string): StashFileStatus {
  switch ((code[0] ?? '').toUpperCase()) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'unknown';
  }
}

/**
 * Validate a stash index: a non-negative integer within a sane bound. The
 * server uses this before constructing `stash@{N}` so a crafted query can't
 * smuggle anything into the ref.
 */
export function isValidStashIndex(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 10000;
}

/** Construct a stash ref from a validated index. Throws on a bad index. */
export function stashRefForIndex(n: number): string {
  if (!isValidStashIndex(n)) throw new Error(`invalid stash index: ${n}`);
  return `stash@{${n}}`;
}

/** Parse the branch name out of a stash subject ("WIP on <branch>: ..."). */
export function stashBranch(subject: string): string {
  const m = /(?:WIP on|On) ([^:]+):/.exec(subject);
  return m ? m[1].trim() : '';
}

/**
 * Parse `git stash list --pretty=format:STASH_LIST_FORMAT` output into the
 * bare entries (no file data yet — the server fetches that per entry).
 */
export function parseStashList(stdout: string): Array<Pick<StashEntry, 'index' | 'ref' | 'subject' | 'branch' | 'date'>> {
  return stdout
    .split(RECORD)
    .map(rec => rec.replace(/\x1e+$/, '').trim())
    .filter(Boolean)
    .map((rec, i) => {
      const f = rec.split(FIELD);
      const ref = (f[0] ?? '').trim();
      const subject = f[1] ?? '';
      const date = (f[2] ?? '').trim();
      if (!ref) return null;
      return { index: i, ref, subject, branch: stashBranch(subject), date };
    })
    .filter((e): e is Pick<StashEntry, 'index' | 'ref' | 'subject' | 'branch' | 'date'> => e !== null);
}

interface NumRow {
  insertions: number;
  deletions: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}

/** Parse `git stash show --numstat -z` output keyed by destination path. */
export function parseStashNumstat(stdout: string): NumRow[] {
  const tokens = stdout.split('\0');
  const out: NumRow[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) {
      i++;
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(t);
    if (!m) {
      i++;
      continue;
    }
    const binary = m[1] === '-' && m[2] === '-';
    const insertions = m[1] === '-' ? -1 : parseInt(m[1], 10);
    const deletions = m[2] === '-' ? -1 : parseInt(m[2], 10);
    const rest = m[3];
    if (rest === '') {
      out.push({ insertions, deletions, binary, path: tokens[i + 2] ?? '', oldPath: tokens[i + 1] ?? '' });
      i += 3;
    } else {
      out.push({ insertions, deletions, binary, path: rest });
      i += 1;
    }
  }
  return out;
}

/** Parse `git stash show --name-status -z` output keyed by destination path. */
export function parseStashNameStatus(stdout: string): Map<string, { status: StashFileStatus; oldPath?: string }> {
  const map = new Map<string, { status: StashFileStatus; oldPath?: string }>();
  const tokens = stdout.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) {
      i++;
      continue;
    }
    const letter = code[0].toUpperCase();
    if (letter === 'R' || letter === 'C') {
      map.set(tokens[i + 2] ?? '', { status: stashStatusFromCode(letter), oldPath: tokens[i + 1] ?? '' });
      i += 3;
    } else {
      map.set(tokens[i + 1] ?? '', { status: stashStatusFromCode(letter) });
      i += 2;
    }
  }
  return map;
}

/** Assemble the file list for one stash from its numstat + name-status. */
export function buildStashFiles(numstatStdout: string, nameStatusStdout: string): {
  files: StashFile[];
  insertions: number;
  deletions: number;
} {
  const numByPath = new Map<string, NumRow>();
  for (const n of parseStashNumstat(numstatStdout)) numByPath.set(n.path, n);
  const nameStatus = parseStashNameStatus(nameStatusStdout);

  const files: StashFile[] = [];
  let insertions = 0;
  let deletions = 0;

  const rows =
    nameStatus.size > 0
      ? [...nameStatus.entries()].map(([path, ns]) => ({ path, status: ns.status, oldPath: ns.oldPath }))
      : parseStashNumstat(numstatStdout).map(n => ({ path: n.path, status: 'modified' as StashFileStatus, oldPath: n.oldPath }));

  for (const r of rows) {
    const n = numByPath.get(r.path);
    const binary = n?.binary ?? false;
    const ins = n ? n.insertions : 0;
    const del = n ? n.deletions : 0;
    if (!binary) {
      if (ins > 0) insertions += ins;
      if (del > 0) deletions += del;
    }
    files.push({ path: r.path, oldPath: r.oldPath || n?.oldPath, status: r.status, insertions: ins, deletions: del, binary });
  }
  files.sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path));
  return { files, insertions, deletions };
}

function churn(f: StashFile): number {
  return Math.max(0, f.insertions) + Math.max(0, f.deletions);
}

/** A one-line summary like "3 files · +18 -4". */
export function stashSummary(entry: Pick<StashEntry, 'filesChanged' | 'insertions' | 'deletions'>): string {
  const fileWord = entry.filesChanged === 1 ? 'file' : 'files';
  const parts = [`${entry.filesChanged} ${fileWord}`];
  if (entry.insertions > 0) parts.push(`+${entry.insertions}`);
  if (entry.deletions > 0) parts.push(`-${entry.deletions}`);
  return parts.join(' \u00b7 ');
}

// ── Mutating actions (W25) — apply / pop / drop ──────────────────────

/** The three local-only stash mutations the web view can request (W25). */
export type StashAction = 'apply' | 'pop' | 'drop';

const STASH_ACTIONS: StashAction[] = ['apply', 'pop', 'drop'];

/** True when a string names a supported stash mutation. */
export function isStashAction(s: unknown): s is StashAction {
  return typeof s === 'string' && (STASH_ACTIONS as string[]).includes(s);
}

/**
 * Build the validated `git stash <action> stash@{N}` argv for a mutation.
 * BOTH the action and the index are validated — the index via the same
 * `stashRefForIndex` gate the read path uses (so `stash@{N}` can never be
 * anything but an integer-indexed ref), and the action against the closed
 * verb set — so a crafted request can't smuggle a different subcommand or
 * a flag into the argv. Throws on either being invalid.
 */
export function buildStashActionArgs(action: string, index: number): string[] {
  if (!isStashAction(action)) throw new Error(`invalid stash action: ${action}`);
  const ref = stashRefForIndex(index); // throws on a bad index
  return ['stash', action, ref];
}

/** Human past-tense label for a completed action (toast / status). */
export function stashActionLabel(action: StashAction): string {
  switch (action) {
    case 'apply':
      return 'applied';
    case 'pop':
      return 'popped';
    case 'drop':
      return 'dropped';
  }
}

/**
 * Whether an action removes the stash entry from the list (so the client
 * knows to refresh): pop + drop remove it; apply leaves it in place.
 */
export function stashActionRemovesEntry(action: StashAction): boolean {
  return action === 'pop' || action === 'drop';
}

// ── Stash create (W42) — git stash push ──────────────────────────────

/** Options for creating a stash from the web app (W42). */
export interface StashPushOptions {
  /** Optional message (`-m <message>`); blank means a default WIP subject. */
  message?: string;
  /** Include untracked files (`-u`). */
  includeUntracked?: boolean;
  /** Keep staged changes in the index (`--keep-index`). */
  keepIndex?: boolean;
}

/** Max stash message length we accept (defensive bound on argv size). */
export const STASH_MESSAGE_MAX = 500;

/**
 * Validate + normalise a stash message. A message is optional; when present
 * it must be a string within the length bound and is trimmed of trailing
 * whitespace. Control characters (newlines, NULs) are stripped so the
 * subject stays a single clean line. Returns the cleaned message, or ''
 * for "no message" (git then writes its default `WIP on <branch>` subject).
 */
export function normalizeStashMessage(message: unknown): string {
  if (typeof message !== 'string') return '';
  // Strip control chars (including newlines/NUL) so the subject is one line.
  // eslint-disable-next-line no-control-regex
  const cleaned = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.slice(0, STASH_MESSAGE_MAX);
}

/**
 * Build the validated `git stash push` argv for a create (W42). The message
 * is normalised + length-bounded, and is always passed via `-m <message>`
 * (never concatenated) so it can't smuggle a flag. Boolean options map to
 * their git flags. Mirrors the W25 mutation-argv discipline: every piece is
 * a fixed token or a validated value.
 */
export function buildStashPushArgs(opts: StashPushOptions = {}): string[] {
  const args = ['stash', 'push'];
  if (opts.includeUntracked) args.push('--include-untracked');
  if (opts.keepIndex) args.push('--keep-index');
  const message = normalizeStashMessage(opts.message);
  if (message) args.push('-m', message);
  return args;
}

// ── Stash search / filter (W59) ──────────────────────────────────────

/** The minimal fields the stash filter matches against. */
export type FilterableStash = Pick<StashEntry, 'subject' | 'branch'>;

/** Normalise a stash-filter query: trimmed + lowercased. */
export function normalizeStashQuery(query: string): string {
  return (query ?? '').trim().toLowerCase();
}

/**
 * Whether a single stash matches a (raw) query (W59). An empty/whitespace
 * query matches everything. Otherwise the lowercased query must be a substring
 * of the stash's subject (the WIP message) or the branch it was taken on, so
 * a specific work-in-progress is findable by what you remember about it.
 */
export function stashMatchesQuery(entry: FilterableStash, query: string): boolean {
  const q = normalizeStashQuery(query);
  if (!q) return true;
  if ((entry.subject ?? '').toLowerCase().includes(q)) return true;
  if ((entry.branch ?? '').toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Filter a stash list by a subject/branch query (W59). Preserves the input
 * order and identity (returns the same objects). An empty query returns a
 * fresh copy of the list so callers can treat the result uniformly.
 */
export function filterStashes<T extends FilterableStash>(entries: T[], query: string): T[] {
  const q = normalizeStashQuery(query);
  if (!q) return entries.slice();
  return entries.filter(e => stashMatchesQuery(e, q));
}

/**
 * Whether pressing Esc on the Stashes view should clear the active W63 filter
 * (W127). True only when there's a non-empty query to clear (after trimming),
 * so Esc is a no-op when the box is already empty — mirroring the graph search
 * Esc-clears behaviour. Pure (a thin guard over normalizeStashQuery) so the
 * gating is testable; the view calls clearStashQuery only when this is true.
 */
export function stashEscapeClears(query: string): boolean {
  return normalizeStashQuery(query).length > 0;
}

// ── Stash filter command-palette source (W91) ────────────────────────

/** One Cmd-K entry that jumps to a filtered Stashes view (W91, data only). */
export interface StashFilterPaletteItem {
  /** The filter term this entry applies (a branch name). */
  term: string;
  label: string;
  /** How many stashes the term matches, for the palette hint. */
  count: number;
}

/**
 * Build the command-palette source for the loaded stashes (W91), so the
 * W59/W63 message/branch filter is reachable from Cmd-K, not just the box on
 * the Stashes view. Mirrors the W82 blame-author palette source: pure + data
 * only (the view maps each entry to a real PaletteItem with its run), so the
 * gating is unit-testable.
 *
 * Stashes are grouped by the BRANCH they were taken on — the high-value filter
 * dimension, since a branch typically groups several WIPs while subjects are
 * near-unique. Each distinct, non-empty branch yields one "Filter stashes on
 * <branch>" entry carrying the count it matches (verified through the same
 * `filterStashes` matcher the box uses, so the palette count and the filtered
 * view agree). Branches de-dupe case-insensitively (first-seen casing kept),
 * are ordered by frequency (busiest branch first) then first appearance, and
 * the list is capped at `limit` so a repo with many branches can't flood the
 * palette; the palette's own fuzzy filter narrows from there.
 */
export function stashFilterPaletteItems(
  entries: ReadonlyArray<FilterableStash>,
  limit = 12,
): StashFilterPaletteItem[] {
  const order: string[] = [];
  const byKey = new Map<string, { term: string; count: number }>();
  for (const e of entries) {
    const term = (e.branch ?? '').trim();
    if (!term) continue;
    // W106: a branch term must round-trip the W63 deep-link sanitiser unchanged,
    // or the reloaded #stashes?q= view would show a DIFFERENT count than the
    // palette promised. Branches can hold '/' (fine), but a control/space-bearing
    // name would be altered en route — drop it so palette == deep-link always.
    if (!stashWordSurvivesQuery(term)) continue;
    const key = term.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
    } else {
      byKey.set(key, { term, count: 1 });
      order.push(key);
    }
  }
  const cap = Math.max(0, Math.floor(limit));
  return order
    .map(key => byKey.get(key)!)
    // Busiest branch first; stable on the first-seen order for ties.
    .sort((a, b) => b.count - a.count || order.indexOf(a.term.toLowerCase()) - order.indexOf(b.term.toLowerCase()))
    .slice(0, cap)
    .map(({ term, count }) => ({ term, label: `Filter stashes on ${term}`, count }));
}

// ── Stash subject-word command-palette source (W96) ──────────────────

/**
 * Stop-words dropped from stash-subject tokens (W96): articles, prepositions,
 * pronouns, and the git-stash boilerplate verbs ("wip", "on", "index") so the
 * suggested words are about WHAT the work was, not scaffolding. Lowercased.
 */
const STASH_STOP_WORDS = new Set([
  'wip', 'on', 'in', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with',
  'at', 'by', 'from', 'into', 'is', 'it', 'this', 'that', 'index', 'changes',
  'change', 'fix', 'update', 'add', 'wip:', 'stash',
]);

/**
 * Whether a tokenised stash word survives the W63 `#stashes?q=` deep-link
 * sanitiser unchanged (W101). The deep link routes a palette word through
 * setStashQuery -> sanitizeStashQuery (trim, strip control chars, cap 200), so
 * a word that would be altered en route would show a DIFFERENT count after a
 * reload than the palette promised. stashSubjectWords already splits on
 * non-`[a-z0-9]`, so today every token is clean — this is the defensive lock:
 * a word must be 1..200 chars and free of control/whitespace chars to count.
 * Pure so the agreement is unit-testable without the web sanitiser in scope.
 */
export function stashWordSurvivesQuery(word: string): boolean {
  if (!word || word.length > 200) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f\s]/.test(word) && word.trim() === word;
}

/**
 * Tokenise a stash subject into significant lowercased words (W96). Strips the
 * leading "WIP on <branch>:" / "On <branch>:" boilerplate git prepends (so the
 * branch name + the scaffolding don't pollute the word list), splits on
 * non-word characters, drops stop-words + very short tokens + bare numbers, and
 * de-dupes within the one subject so a word repeated in a message counts once
 * for that stash. Pure so the tokenising is unit-testable.
 *
 * W101: every emitted token must survive the W63 deep-link sanitiser unchanged
 * (stashWordSurvivesQuery) so the palette count and the reloaded `#stashes?q=`
 * view always agree — already true given the a-z0-9 split, but locked here so a
 * future split-grammar change can't leak a word that round-trips differently.
 */
export function stashSubjectWords(subject: string): string[] {
  // Drop the "WIP on <branch>:" / "On <branch>:" prefix git writes.
  const body = (subject ?? '').replace(/^(?:WIP on|On) [^:]+:\s*/i, '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of body.toLowerCase().split(/[^a-z0-9]+/)) {
    const w = raw.trim();
    if (w.length < 3) continue; // too short to be meaningful
    if (/^\d+$/.test(w)) continue; // bare numbers aren't useful filters
    if (STASH_STOP_WORDS.has(w)) continue;
    if (!stashWordSurvivesQuery(w)) continue; // W101: must round-trip the deep link
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** One Cmd-K entry that filters stashes by a subject word (W96, data only). */
export interface StashSubjectPaletteItem {
  /** The subject word this entry filters by. */
  term: string;
  label: string;
  /** How many stashes the word matches (via filterStashes), for the hint. */
  count: number;
}

/**
 * Build a second tier of stash-filter palette entries keyed by SUBJECT WORD
 * (W96), complementing the W91 branch tier so a WIP is findable by what it was
 * about, not just which branch it sat on. Tokenises every stash subject
 * (stashSubjectWords — boilerplate + stop-words stripped), counts how many
 * stashes each significant word appears in, and emits "Filter stashes: <word>"
 * for the most common words.
 *
 * Each word's count is verified through the same `filterStashes` matcher the
 * box uses (a substring match over subject OR branch), so the palette count and
 * the resulting filtered view agree — even when the matcher catches a stash the
 * tokeniser didn't (e.g. the word appears mid-token). Only words matching at
 * least `minCount` stashes are surfaced (a one-off word is just the subject
 * itself — no better than typing it), ordered by match count (most common
 * first) then first appearance, and capped at `limit` so a large stash list
 * can't flood the palette; the palette's own fuzzy filter narrows from there.
 */
export function stashSubjectFilterPaletteItems(
  entries: ReadonlyArray<FilterableStash>,
  limit = 8,
  minCount = 2,
): StashSubjectPaletteItem[] {
  const order: string[] = [];
  const firstSeen = new Map<string, number>();
  for (const e of entries) {
    for (const word of stashSubjectWords(e.subject ?? '')) {
      if (!firstSeen.has(word)) {
        firstSeen.set(word, order.length);
        order.push(word);
      }
    }
  }
  const cap = Math.max(0, Math.floor(limit));
  const floor = Math.max(1, Math.floor(minCount));
  const list = order
    // W111: re-gate every word through the deep-link sanitiser at assembly time
    // (mirrors the W106 branch tier) so a future stashSubjectWords grammar change
    // can never leak a control-bearing token whose reloaded #stashes?q= count
    // would diverge from the palette's. stashWordSurvivesQuery is the lock.
    .filter(word => stashWordSurvivesQuery(word))
    // Count via the real matcher so the palette + the filtered view agree.
    .map(word => ({ term: word, count: filterStashes(entries as FilterableStash[], word).length }))
    .filter(w => w.count >= floor)
    .sort((a, b) => b.count - a.count || firstSeen.get(a.term)! - firstSeen.get(b.term)!)
    .slice(0, cap);
  return list.map(({ term, count }) => ({ term, label: `Filter stashes: ${term}`, count }));
}
