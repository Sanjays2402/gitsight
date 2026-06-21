/**
 * Pure helpers for the Worktree Disk-Usage Report (F24).
 *
 * Walks a directory tree without shelling out to `du`. Returns:
 *
 *   - total bytes (counting only files; symlinks not followed)
 *   - per-top-level-entry size aggregates (so the report can show
 *     "node_modules: 1.2 GB" alongside "src: 240 KB")
 *   - the top-N biggest files by leaf size
 *
 * Default skiplist mirrors the repoSize helper: `.git` is excluded
 * because users are looking at *working tree* size. node_modules can
 * be optionally counted (it's often the bulk of a JS worktree's
 * footprint).
 *
 * Pure-ish — depends on the injected `fs` adapter so the function is
 * trivially unit-testable. Tests in test/git/worktreeDu.test.ts.
 */

export interface FsAdapter {
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; isSymlink: boolean }>;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface DuOptions {
  /** Skip these top-level entry names (default: ['.git']). */
  skipNames?: string[];
  /** Hard cap on entries to walk (default 100_000) — protects against pathological trees. */
  maxEntries?: number;
  /** Follow symlinks (default false). */
  followSymlinks?: boolean;
}

export interface DuTopEntry {
  name: string;
  fullPath: string;
  bytes: number;
  isDirectory: boolean;
}

export interface DuReport {
  /** Total bytes across everything walked. */
  totalBytes: number;
  /** Files counted. */
  fileCount: number;
  /** Directories descended into. */
  directoryCount: number;
  /** Top-level entries, sorted by descending bytes. */
  topLevel: DuTopEntry[];
  /** Top-N largest individual files. */
  largestFiles: DuTopEntry[];
  /** True when the walk hit `maxEntries` and bailed early. */
  truncated: boolean;
}

const DEFAULT_SKIP_NAMES = ['.git'];

/**
 * Walk `root` and aggregate sizes. Returns a DuReport.
 *
 * `topN` controls how many entries are kept in `largestFiles`. The
 * function does a streaming top-N (heap-free, O(n log topN) bounded
 * size) so we don't allocate the full file list.
 */
export async function computeDu(
  root: string,
  fs: FsAdapter,
  options: DuOptions = {},
  topN = 10,
): Promise<DuReport> {
  const skip = new Set(options.skipNames ?? DEFAULT_SKIP_NAMES);
  const maxEntries = options.maxEntries ?? 100_000;
  const followSymlinks = options.followSymlinks ?? false;

  let entries = 0;
  let truncated = false;
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  const perTopLevel = new Map<string, { bytes: number; isDirectory: boolean }>();
  const top: DuTopEntry[] = []; // sorted descending; trimmed to topN

  // Each stack frame is "path + topLevelName" — we keep the top-level
  // name even as we descend so size goes into the right bucket.
  type Frame = { dir: string; topLevelName: string; topLevelFull: string; isTopLevelDir: boolean };
  const initial: Frame[] = [];

  let rootEntries: DirEntry[];
  try {
    rootEntries = await fs.readdir(root);
  } catch {
    rootEntries = [];
  }
  for (const e of rootEntries) {
    if (skip.has(e.name)) continue;
    if (entries++ >= maxEntries) { truncated = true; break; }
    const full = join(root, e.name);
    if (e.isSymlink && !followSymlinks) {
      // Treat symlinks as zero-size leaf entries (matches `du -P`).
      perTopLevel.set(e.name, { bytes: 0, isDirectory: false });
      continue;
    }
    if (e.isFile) {
      let size = 0;
      try { size = (await fs.stat(full)).size; } catch { /* ignore */ }
      fileCount++;
      totalBytes += size;
      perTopLevel.set(e.name, { bytes: size, isDirectory: false });
      maybePush(top, { name: e.name, fullPath: full, bytes: size, isDirectory: false }, topN);
    } else if (e.isDirectory) {
      directoryCount++;
      perTopLevel.set(e.name, { bytes: 0, isDirectory: true });
      initial.push({ dir: full, topLevelName: e.name, topLevelFull: full, isTopLevelDir: true });
    }
  }

  // Iterative DFS to keep stack depth bounded.
  const stack: Frame[] = initial;
  while (stack.length && entries < maxEntries) {
    const frame = stack.pop()!;
    let kids: DirEntry[];
    try { kids = await fs.readdir(frame.dir); } catch { continue; }
    for (const k of kids) {
      if (entries++ >= maxEntries) { truncated = true; break; }
      const full = join(frame.dir, k.name);
      if (k.isSymlink && !followSymlinks) {
        continue;
      }
      if (k.isFile) {
        let size = 0;
        try { size = (await fs.stat(full)).size; } catch { /* ignore */ }
        fileCount++;
        totalBytes += size;
        const bucket = perTopLevel.get(frame.topLevelName);
        if (bucket) bucket.bytes += size;
        maybePush(top, { name: relativeJoin(frame.topLevelName, full, frame.topLevelFull), fullPath: full, bytes: size, isDirectory: false }, topN);
      } else if (k.isDirectory) {
        directoryCount++;
        stack.push({ dir: full, topLevelName: frame.topLevelName, topLevelFull: frame.topLevelFull, isTopLevelDir: false });
      }
    }
  }

  const topLevel: DuTopEntry[] = [];
  for (const [name, info] of perTopLevel) {
    topLevel.push({ name, fullPath: join(root, name), bytes: info.bytes, isDirectory: info.isDirectory });
  }
  topLevel.sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    fileCount,
    directoryCount,
    topLevel,
    largestFiles: top.slice(),
    truncated,
  };
}

/** Push to a descending-sorted, top-N capped array. O(log N) per push. */
function maybePush(arr: DuTopEntry[], entry: DuTopEntry, topN: number): void {
  if (arr.length < topN) {
    insertSorted(arr, entry);
    return;
  }
  if (entry.bytes <= arr[arr.length - 1].bytes) return;
  arr.pop();
  insertSorted(arr, entry);
}

function insertSorted(arr: DuTopEntry[], entry: DuTopEntry): void {
  // Binary search for descending sort.
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].bytes >= entry.bytes) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, entry);
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

function relativeJoin(topLevelName: string, fullPath: string, topLevelFull: string): string {
  if (fullPath.startsWith(topLevelFull + '/')) {
    return topLevelName + '/' + fullPath.slice(topLevelFull.length + 1);
  }
  return fullPath;
}

/**
 * Format a byte count as "1.23 GB" / "456 KB" / "12 B". Uses base-1024
 * units (MiB rather than MB) — matches what `du -h` and `ls -lh` show,
 * which is what users expect in a code repo context.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(n)} ${units[i]}`;
  return `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${units[i]}`;
}

/**
 * Render the report as a Markdown document body. Title is left to the
 * caller so the controller can include the worktree label.
 */
export function renderDuMarkdown(report: DuReport, args: { topLevelLimit?: number; largestLimit?: number; root: string }): string {
  const topN = args.topLevelLimit ?? 25;
  const largestN = args.largestLimit ?? 10;
  const lines: string[] = [];

  lines.push(`**Total:** ${formatBytes(report.totalBytes)} across ${report.fileCount.toLocaleString()} files, ${report.directoryCount.toLocaleString()} directories.`);
  if (report.truncated) {
    lines.push('');
    lines.push('> Walk hit the entry cap and stopped early — totals are a lower bound.');
  }
  lines.push('');
  lines.push('## Top-level usage');
  lines.push('');
  lines.push('| Entry | Type | Size | Share |');
  lines.push('| --- | --- | ---: | ---: |');
  const slice = report.topLevel.slice(0, topN);
  for (const e of slice) {
    const share = report.totalBytes > 0 ? ((e.bytes / report.totalBytes) * 100).toFixed(1) + '%' : '0%';
    lines.push(`| \`${e.name}\` | ${e.isDirectory ? 'dir' : 'file'} | ${formatBytes(e.bytes)} | ${share} |`);
  }
  if (report.topLevel.length > topN) {
    lines.push(`| _(+${report.topLevel.length - topN} more, hidden)_ | | | |`);
  }
  lines.push('');
  lines.push('## Largest individual files');
  lines.push('');
  if (!report.largestFiles.length) {
    lines.push('_(no files measured)_');
  } else {
    lines.push('| Path | Size |');
    lines.push('| --- | ---: |');
    for (const f of report.largestFiles.slice(0, largestN)) {
      lines.push(`| \`${f.name}\` | ${formatBytes(f.bytes)} |`);
    }
  }
  lines.push('');
  lines.push(`_Walked from_ \`${args.root}\` (\`.git\` excluded).`);
  return lines.join('\n');
}
