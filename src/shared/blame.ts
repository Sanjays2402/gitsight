/**
 * GitSight shared blame-heatmap logic (W12).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. Parses the output of
 * `git blame --porcelain <file>` into a per-line model the web app's
 * blame view renders as an age heatmap. This is the snapshot-side cousin
 * of the extension's `blameHeatmap` webview, which used the structured
 * `git.blame()` wrapper; here we parse the porcelain stream directly so
 * the companion server can shell out without a vscode dependency.
 *
 * Porcelain format (per line group):
 *   <40-hex-sha> <orig-line> <final-line> [<num-lines>]   (header)
 *   author <name>
 *   author-mail <<email>>
 *   author-time <unix>
 *   author-tz <+hhmm>
 *   summary <subject>
 *   ... (committer-*, previous, filename) ...
 *   \t<source line text>                                  (the code, tab-prefixed)
 * Commit headers repeat their metadata only the first time a sha appears;
 * later lines for the same sha carry just the abbreviated header + code,
 * so we cache metadata by sha.
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/blame.test.ts
 */

export interface BlameLineInfo {
  /** 1-based final line number in the file. */
  line: number;
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** Author time as unix epoch SECONDS (0 when unknown). */
  authorTime: number;
  summary: string;
  /** The source line text (without the leading tab). */
  code: string;
}

export interface BlameAuthorStat {
  author: string;
  lines: number;
  share: number;
}

export interface BlameModel {
  lines: BlameLineInfo[];
  /** Distinct authors, busiest first. */
  authors: BlameAuthorStat[];
  totalLines: number;
  /** Oldest / newest author-time across the file (unix seconds), or 0. */
  oldest: number;
  newest: number;
}

interface CommitMeta {
  author: string;
  email: string;
  authorTime: number;
  summary: string;
}

/** Strip the angle brackets git wraps around the porcelain mail field. */
function cleanMail(raw: string): string {
  const m = /^<?(.*?)>?$/.exec(raw.trim());
  return m ? m[1] : raw.trim();
}

/**
 * Parse `git blame --porcelain` output into a per-line blame model.
 * Robust to the repeated/abbreviated headers porcelain emits for runs of
 * lines sharing a commit.
 */
export function parsePorcelainBlame(stdout: string): BlameModel {
  const metaBySha = new Map<string, CommitMeta>();
  const lines: BlameLineInfo[] = [];
  // Split but keep empty lines out of the way; porcelain never has blank
  // structural lines (a blank source line is `\t` + nothing).
  const raw = stdout.split('\n');

  let i = 0;
  let pendingSha: string | null = null;
  let pendingMeta: Partial<CommitMeta> = {};
  let finalLine = 0;

  while (i < raw.length) {
    const ln = raw[i];
    // A header line: <sha> <orig> <final> [<count>]
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(ln);
    if (header) {
      pendingSha = header[1];
      finalLine = Number(header[2]);
      pendingMeta = {};
      i++;
      continue;
    }
    if (pendingSha) {
      // Metadata lines until we hit the tab-prefixed source line.
      if (ln.startsWith('\t')) {
        const sha = pendingSha;
        // Merge any freshly-parsed metadata into the cache for this sha.
        const cached = metaBySha.get(sha);
        const meta: CommitMeta = {
          author: pendingMeta.author ?? cached?.author ?? 'Unknown',
          email: pendingMeta.email ?? cached?.email ?? '',
          authorTime: pendingMeta.authorTime ?? cached?.authorTime ?? 0,
          summary: pendingMeta.summary ?? cached?.summary ?? '',
        };
        if (!cached) metaBySha.set(sha, meta);
        lines.push({
          line: finalLine,
          sha,
          shortSha: sha.slice(0, 7),
          author: meta.author,
          email: meta.email,
          authorTime: meta.authorTime,
          summary: meta.summary,
          code: ln.slice(1),
        });
        pendingSha = null;
        pendingMeta = {};
        i++;
        continue;
      }
      const sp = ln.indexOf(' ');
      const key = sp === -1 ? ln : ln.slice(0, sp);
      const val = sp === -1 ? '' : ln.slice(sp + 1);
      switch (key) {
        case 'author':
          pendingMeta.author = val;
          break;
        case 'author-mail':
          pendingMeta.email = cleanMail(val);
          break;
        case 'author-time':
          pendingMeta.authorTime = Number(val) || 0;
          break;
        case 'summary':
          pendingMeta.summary = val;
          break;
        default:
          break;
      }
      i++;
      continue;
    }
    i++;
  }

  return summariseBlame(lines);
}

/** Fold parsed lines into the model (author stats + age range). */
export function summariseBlame(lines: BlameLineInfo[]): BlameModel {
  const byAuthor = new Map<string, number>();
  let oldest = 0;
  let newest = 0;
  for (const l of lines) {
    byAuthor.set(l.author, (byAuthor.get(l.author) ?? 0) + 1);
    if (l.authorTime > 0) {
      if (oldest === 0 || l.authorTime < oldest) oldest = l.authorTime;
      if (l.authorTime > newest) newest = l.authorTime;
    }
  }
  const total = lines.length || 0;
  const authors: BlameAuthorStat[] = [...byAuthor.entries()]
    .map(([author, n]) => ({ author, lines: n, share: total ? n / total : 0 }))
    .sort((a, b) => b.lines - a.lines || a.author.toLowerCase().localeCompare(b.author.toLowerCase()));

  return { lines, authors, totalLines: total, oldest, newest };
}

/**
 * Map an author-time to a 0..1 "heat" where 1 = newest (hot) and 0 =
 * oldest (cold) within this file's age span. A single-commit file (no
 * span) returns 1 for everything. Pure so the colour ramp is testable.
 */
export function blameHeat(authorTime: number, oldest: number, newest: number): number {
  if (authorTime <= 0) return 0;
  if (newest <= oldest) return 1;
  const t = (authorTime - oldest) / (newest - oldest);
  return Math.min(1, Math.max(0, t));
}
