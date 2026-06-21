/**
 * Pure helpers for the Repo Size / Biggest Files report (F40).
 *
 * Combines two cheap-ish git plumbing calls:
 *
 *   git rev-list --objects --all
 *   git cat-file --batch-check='%(objecttype) %(objectsize:disk) %(rest)'
 *
 * (the second command is fed the first's stdout) into a ranked list of the
 * largest blobs ever committed, keyed by their CURRENT path in the working
 * copy when possible (paths from rev-list --objects are the path at the
 * commit that introduced/touched the blob — good enough for triage).
 *
 * Pure — no vscode, no child_process. Tests in test/git/repoSize.test.ts.
 */

export interface BlobRow {
  /** Object SHA-1 of the blob. */
  sha: string;
  /** On-disk byte size from cat-file (pack-aware, post-delta). */
  size: number;
  /** Repo-relative path captured by `rev-list --objects` (may be empty). */
  path: string;
}

/**
 * Merge a `rev-list --objects --all` stream (lines like "<sha> <path>") with
 * a `cat-file --batch-check` stream (lines like "<sha> <type> <size>") into a
 * single deduplicated, blob-only list sorted by size desc.
 *
 * Both inputs are joined by SHA. Trees and commits coming through `cat-file`
 * are dropped (`type !== 'blob'`). Blobs with no path in `rev-list` keep an
 * empty path so callers can still surface "X MB of unnamed pack data".
 */
export function joinBlobs(revListObjects: string, batchCheck: string): BlobRow[] {
  const pathBySha = new Map<string, string>();
  for (const line of (revListObjects ?? '').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) {
      pathBySha.set(line.trim(), '');
      continue;
    }
    const sha = line.slice(0, sp).trim();
    const path = line.slice(sp + 1).trim();
    if (sha) pathBySha.set(sha, path);
  }

  const seen = new Set<string>();
  const out: BlobRow[] = [];
  for (const line of (batchCheck ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [sha, type, sizeStr] = parts;
    if (type !== 'blob') continue;
    if (seen.has(sha)) continue;
    const size = parseIntSafe(sizeStr);
    if (size <= 0) continue;
    seen.add(sha);
    out.push({ sha, size, path: pathBySha.get(sha) ?? '' });
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/**
 * Build the cat-file input. `cat-file --batch-check` reads SHAs on stdin
 * one-per-line; rev-list emits "<sha> <path>" so we strip the path before
 * piping. Exposed so the controller can construct the stream without
 * re-implementing the trivial split.
 */
export function shasForBatchCheck(revListObjects: string): string {
  const out: string[] = [];
  for (const line of (revListObjects ?? '').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    out.push(sp < 0 ? line.trim() : line.slice(0, sp).trim());
  }
  return out.join('\n');
}

/**
 * Render a human size in MiB/KiB/B. Always rounds to one decimal except for
 * bytes; matches what humans see in Finder/Explorer.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export interface RepoSizeSummary {
  blobCount: number;
  totalBytes: number;
  /** Top-N (default 20) blobs by size. */
  top: BlobRow[];
}

export function summariseRepo(blobs: BlobRow[], topN = 20): RepoSizeSummary {
  let total = 0;
  for (const b of blobs) total += b.size;
  return {
    blobCount: blobs.length,
    totalBytes: total,
    top: blobs.slice(0, topN),
  };
}

/**
 * Multi-line markdown body used by the report doc.
 *
 *   # Repo size — 1234 blobs · 456.7 MiB total
 *
 *   | # | Size | Path | SHA |
 *   |---|---|---|---|
 *   | 1 | 12.3 MiB | assets/big.bin | abc1234 |
 *   ...
 */
export function formatReportMarkdown(s: RepoSizeSummary): string {
  const lines: string[] = [];
  lines.push(`# Repo size — ${s.blobCount} blobs · ${formatSize(s.totalBytes)} total`);
  lines.push('');
  if (!s.top.length) {
    lines.push('_No blobs found. Is this an empty repo?_');
    return lines.join('\n');
  }
  lines.push(`## Top ${s.top.length} largest blobs (ever committed)`);
  lines.push('');
  lines.push('| # | Size | Path | SHA |');
  lines.push('|---|------|------|-----|');
  for (let i = 0; i < s.top.length; i++) {
    const b = s.top[i];
    const path = b.path || '_(no path — orphan blob)_';
    const sha = b.sha.slice(0, 12);
    lines.push(`| ${i + 1} | ${formatSize(b.size)} | ${escapePipes(path)} | \`${sha}\` |`);
  }
  lines.push('');
  lines.push('_Sizes are on-disk (pack-aware). Use `git filter-repo --invert-paths --path <path>` to expunge a path from history if needed._');
  return lines.join('\n');
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function parseIntSafe(s: string): number {
  const n = parseInt((s ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
