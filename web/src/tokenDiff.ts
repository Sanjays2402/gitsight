/**
 * Pure word-level intra-line diff (W34).
 *
 * DOM-free + framework-free + NO @shared import, so it's unit-tested under
 * node --test. The unified-diff renderer (diffView.ts) pairs a deleted line
 * with the added line that replaced it and asks this module which spans
 * actually changed, so a one-character edit highlights one token instead of
 * lighting up the whole row.
 *
 * Approach: tokenise each line into word / whitespace / punctuation runs
 * (every character is preserved so a join round-trips), compute the longest
 * common subsequence of tokens, then mark the tokens NOT on the LCS as
 * changed. Adjacent same-state tokens coalesce into one segment so the
 * renderer emits the minimum number of <span>s.
 *
 * Tests: web/src/tokenDiff.test.mjs
 */

/** A run of text flagged as changed (added/removed) or unchanged. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** Both sides of a paired-line word diff. */
export interface InlineDiff {
  old: DiffSegment[];
  new: DiffSegment[];
}

/**
 * Split a string into word / whitespace / other runs. A "word" is a maximal
 * run of letters, digits, and the connector chars that keep identifiers
 * whole (`_`, `$`). Whitespace runs and every other single char become their
 * own token. Concatenating the tokens reproduces the input exactly.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

/**
 * Longest-common-subsequence length table over two token arrays. Classic
 * O(n*m) DP; lines are short so this is cheap. Returns the (n+1)x(m+1)
 * table so the caller can backtrack to recover which tokens are shared.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const mLen = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(mLen + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = mLen - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Coalesce a flat token list (with a parallel changed-flag) into segments. */
function coalesce(tokens: string[], changed: boolean[]): DiffSegment[] {
  const segs: DiffSegment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed[i]) last.text += tokens[i];
    else segs.push({ text: tokens[i], changed: changed[i] });
  }
  return segs;
}

/**
 * Word-level diff of two lines. Returns coalesced segments for each side,
 * with `changed: true` on the tokens unique to that side and `false` on the
 * tokens shared by both (the LCS). Empty input yields an empty segment list.
 */
export function inlineDiff(oldLine: string, newLine: string): InlineDiff {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const dp = lcsTable(a, b);

  const aChanged = new Array<boolean>(a.length).fill(true);
  const bChanged = new Array<boolean>(b.length).fill(true);

  // Backtrack the LCS: tokens on the common subsequence are unchanged.
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      aChanged[i] = false;
      bChanged[j] = false;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return { old: coalesce(a, aChanged), new: coalesce(b, bChanged) };
}

/**
 * Decide whether a deleted/added line pair is similar enough that a
 * word-level highlight helps (vs two wholly different lines, where
 * per-token marks are just noise). Heuristic: the shared token run must
 * cover a meaningful fraction of the larger side AND not be entirely
 * whitespace. Returns the LCS-coverage ratio (0..1); callers compare it to
 * a threshold so the policy stays in one place.
 */
export function pairSimilarity(oldLine: string, newLine: string): number {
  const a = tokenize(oldLine).filter(t => t.trim() !== '');
  const b = tokenize(newLine).filter(t => t.trim() !== '');
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dp = lcsTable(a, b);
  const common = dp[0][0];
  return common / Math.max(a.length, b.length);
}

/** Default similarity floor for offering an intra-line highlight. */
export const INLINE_DIFF_THRESHOLD = 0.34;

/**
 * Should the renderer highlight word spans for this del/add pair? True when
 * the lines are non-identical, non-empty, and share enough tokens to make
 * the highlight signal (not noise). Identical lines never reach here in a
 * real diff, but we guard anyway.
 */
export function shouldInlineDiff(oldLine: string, newLine: string): boolean {
  if (oldLine === newLine) return false;
  if (oldLine.trim() === '' || newLine.trim() === '') return false;
  return pairSimilarity(oldLine, newLine) >= INLINE_DIFF_THRESHOLD;
}
