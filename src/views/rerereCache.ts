/**
 * rerere Cache Visualizer (F63).
 *
 * Walks `.git/rr-cache/` (or wherever `git rev-parse --git-path rr-cache`
 * points), classifies each cache entry, and surfaces them in a picker
 * with per-row actions:
 *
 *   - Show preimage  (diff editor: preimage vs postimage)
 *   - Forget this resolution (`git rerere forget` if path is known,
 *                              otherwise rm -rf .git/rr-cache/<hash>)
 *   - Show full entry directory listing (for orphan / forensic cases)
 *
 * The picker title surfaces the summary: "12 entries \u00b7 1 in-flight \u00b7
 * 3 stale (>90d)".
 *
 * Configurable via:
 *   gitsight.rerereCache.staleAfterDays  (default 90)
 *   gitsight.rerereCache.maxEntries      (default 200 — cache walks are
 *                                          cheap but huge repos can have
 *                                          thousands)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import {
  buildEntry,
  sortEntries,
  summariseEntries,
  describeSummary,
  describeEntry,
  isValidRerereHash,
  RerereCacheEntry,
} from '../git/rerereCache';

const pexec = promisify(execFile);

type Pk = vscode.QuickPickItem & { _entry?: RerereCacheEntry; _action?: 'enable' | 'rerere-clear' };

export async function showRerereCacheVisualizer(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.rerereCache');
  const staleAfterDays = clamp(cfg.get<number>('staleAfterDays', 90), 1, 3650);
  const maxEntries = clamp(cfg.get<number>('maxEntries', 200), 1, 10000);

  const rrCacheDir = await locateRerereCache(git);
  if (!rrCacheDir) {
    const enable = await vscode.window.showInformationMessage(
      'GitSight: rerere is not enabled in this repo (no .git/rr-cache yet). Enable it now?',
      'Enable rerere',
    );
    if (enable === 'Enable rerere') {
      try {
        await git.raw(['config', 'rerere.enabled', 'true']);
        vscode.window.setStatusBarMessage('GitSight: rerere enabled. Conflict resolutions will now be cached.', 4000);
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: failed to enable rerere: ${e?.message ?? e}`);
      }
    }
    return;
  }

  const entries = await loadEntries(rrCacheDir, maxEntries);
  if (!entries.length) {
    vscode.window.showInformationMessage('GitSight: rerere cache is empty \u2014 no recorded resolutions.');
    return;
  }
  const summary = summariseEntries(entries, staleAfterDays);
  const sorted = sortEntries(entries);

  const items: Pk[] = sorted.map(e => ({
    label: `${iconFor(e)} ${e.hash.slice(0, 8)}\u2026${e.hash.slice(-4)}`,
    description: describeEntry(e),
    detail: e.preimageSignature,
    _entry: e,
  }));
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(trash) Clear ALL recorded resolutions', detail: 'Runs git rerere clear \u2014 use after a known-good merge window.', _action: 'rerere-clear' },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: `GitSight: rerere cache (${describeSummary(summary, staleAfterDays)})`,
    placeHolder: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} \u00b7 stale threshold ${staleAfterDays}d`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked._action === 'rerere-clear') {
    const ans = await vscode.window.showWarningMessage(
      `Clear ALL ${entries.length} cached resolutions?\n\nThis runs \`git rerere clear\` and is not reversible \u2014 you'll have to resolve every recurring conflict by hand until rerere learns it again.`,
      { modal: true },
      'Clear cache',
    );
    if (ans !== 'Clear cache') return;
    try {
      await git.raw(['rerere', 'clear']);
      vscode.window.setStatusBarMessage('GitSight: rerere cache cleared.', 4000);
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: rerere clear failed: ${e?.message ?? e}`);
    }
    return;
  }

  const entry = picked._entry;
  if (!entry) return;

  await offerEntryActions(git, rrCacheDir, entry);
}

async function offerEntryActions(git: Git, rrCacheDir: string, entry: RerereCacheEntry): Promise<void> {
  type Ak = vscode.QuickPickItem & { _do: 'show-preimage' | 'show-postimage' | 'open-path' | 'forget' };
  const actions: Ak[] = [];
  if (entry.path) {
    actions.push({
      label: '$(file) Open referenced file',
      detail: entry.path,
      _do: 'open-path',
    });
  }
  actions.push({
    label: '$(diff) Show preimage \u2192 postimage diff',
    detail: 'Compare the cached conflict against the recorded resolution',
    _do: 'show-preimage',
  });
  actions.push({
    label: '$(eye) Show postimage only',
    detail: 'Open the saved resolution body',
    _do: 'show-postimage',
  });
  actions.push({
    label: '$(trash) Forget this resolution',
    detail: entry.path
      ? `Runs git rerere forget ${entry.path}`
      : 'Removes the cache directory directly (no recorded path)',
    _do: 'forget',
  });

  const pick = await vscode.window.showQuickPick(actions, {
    title: `rerere entry ${entry.hash.slice(0, 8)} (${entry.status}, ${describeAge(entry.ageDays)})`,
  });
  if (!pick) return;

  switch (pick._do) {
    case 'open-path': {
      if (!entry.path) return;
      const uri = vscode.Uri.file(path.isAbsolute(entry.path) ? entry.path : path.join(git.cwd, entry.path));
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    case 'show-preimage': {
      await openDiffPreVsPost(rrCacheDir, entry);
      return;
    }
    case 'show-postimage': {
      const file = path.join(rrCacheDir, entry.hash, 'postimage');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      return;
    }
    case 'forget': {
      await forgetEntry(git, rrCacheDir, entry);
      return;
    }
  }
}

async function openDiffPreVsPost(rrCacheDir: string, entry: RerereCacheEntry): Promise<void> {
  const pre = vscode.Uri.file(path.join(rrCacheDir, entry.hash, 'preimage'));
  const post = vscode.Uri.file(path.join(rrCacheDir, entry.hash, 'postimage'));
  try {
    await fs.access(pre.fsPath);
    await fs.access(post.fsPath);
  } catch {
    vscode.window.showWarningMessage('GitSight: this entry has no preimage/postimage pair to diff.');
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    pre,
    post,
    `rerere ${entry.hash.slice(0, 8)} \u2014 preimage \u2192 postimage`,
  );
}

async function forgetEntry(git: Git, rrCacheDir: string, entry: RerereCacheEntry): Promise<void> {
  if (!isValidRerereHash(entry.hash)) {
    vscode.window.showWarningMessage('GitSight: refusing to delete \u2014 invalid rerere hash shape.');
    return;
  }
  if (entry.path) {
    try {
      await git.raw(['rerere', 'forget', entry.path]);
      vscode.window.setStatusBarMessage(`GitSight: forgot rerere resolution for ${entry.path}.`, 3500);
      return;
    } catch (e: any) {
      const msg = (e?.message ?? '').toString();
      // git rerere forget can fail if the path file is stale; fall back to dir removal.
      vscode.window.showInformationMessage(`git rerere forget failed (${msg.split('\n')[0]}). Falling back to direct cache removal.`);
    }
  }
  const dir = path.join(rrCacheDir, entry.hash);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    vscode.window.setStatusBarMessage(`GitSight: removed cache entry ${entry.hash.slice(0, 8)}.`, 3500);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: failed to remove cache entry: ${e?.message ?? e}`);
  }
}

async function locateRerereCache(git: Git): Promise<string | undefined> {
  try {
    const out = (await git.raw(['rev-parse', '--git-path', 'rr-cache'])).trim();
    if (!out) return undefined;
    const abs = path.isAbsolute(out) ? out : path.join(git.cwd, out);
    await fs.access(abs);
    return abs;
  } catch {
    return undefined;
  }
}

async function loadEntries(rrCacheDir: string, maxEntries: number): Promise<RerereCacheEntry[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(rrCacheDir, { withFileTypes: true }))
      .filter(d => d.isDirectory() && isValidRerereHash(d.name))
      .map(d => d.name);
  } catch {
    return [];
  }
  const now = Date.now();
  const limited = names.slice(0, maxEntries);
  const out: RerereCacheEntry[] = [];
  for (const name of limited) {
    const entryDir = path.join(rrCacheDir, name);
    const [preStat, postStat, thisStat, pathTxt] = await Promise.all([
      tryStat(path.join(entryDir, 'preimage')),
      tryStat(path.join(entryDir, 'postimage')),
      tryStat(path.join(entryDir, 'thisimage')),
      tryReadText(path.join(entryDir, 'path')),
    ]);
    const lastModifiedMs = Math.max(
      preStat?.mtimeMs ?? 0,
      postStat?.mtimeMs ?? 0,
      thisStat?.mtimeMs ?? 0,
    );
    let preimageHead: string | undefined;
    let preimageTail: string | undefined;
    if (preStat) {
      const sample = await tryReadText(path.join(entryDir, 'preimage'));
      if (sample) {
        const lines = sample.split('\n');
        preimageHead = lines.slice(0, 4).join('\n');
        preimageTail = lines.slice(-2).join('\n');
      }
    }
    out.push(buildEntry({
      hash: name,
      hasPreimage: !!preStat,
      hasPostimage: !!postStat,
      hasThisimage: !!thisStat,
      pathFileContent: pathTxt,
      lastModifiedMs,
      postimageBytes: postStat?.size ?? 0,
      preimageHead,
      preimageTail,
    }, now));
  }
  return out;
}

async function tryStat(p: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const s = await fs.stat(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

async function tryReadText(p: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return buf;
  } catch {
    return undefined;
  }
}

function iconFor(e: RerereCacheEntry): string {
  switch (e.status) {
    case 'in-flight': return '$(alert)';
    case 'orphaned':  return '$(circle-slash)';
    case 'resolved':  return '$(check)';
    default:          return '$(question)';
  }
}

function describeAge(days: number): string {
  if (!Number.isFinite(days)) return 'unknown age';
  if (days === 0) return 'today';
  if (days === 1) return '1 day old';
  return `${days} days old`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
