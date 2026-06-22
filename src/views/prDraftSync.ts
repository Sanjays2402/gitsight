/**
 * F77 — PR Draft Auto-Sync.
 *
 * After a successful `gitsight.push`, check whether the current branch has
 * an open DRAFT PR on GitHub. If it does, rewrite the PR body with a fresh
 * "what's in this draft so far" managed block. Anything the user wrote
 * outside the marker sentinels is preserved verbatim.
 *
 * Why drafts only: a non-draft PR's body is usually finalised prose; we
 * don't want to keep stomping it. Drafts are the "share what I've got"
 * shape where an auto-summary helps.
 *
 * Hook point: extension.ts calls runPrDraftSync(git) at the tail of the
 * push command, AFTER the underlying `git push` succeeds. We never block
 * the push itself; sync runs silently in the background and surfaces a
 * single status-bar message on success/failure.
 *
 * Configurable via:
 *   gitsight.prDraftSync.enabled          (default true)
 *   gitsight.prDraftSync.maxCommits       (default 25; cap on commit list)
 *   gitsight.prDraftSync.maxFiles         (default 50; cap on file list)
 *   gitsight.prDraftSync.baseRef          ('' = use the PR's own baseRefName)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { parseGitHubRepo } from '../git/forcePushGuard';
import {
  parseOpenDraftPr,
  buildSyncBlock,
  injectSyncBlock,
  parseCommitsForSync,
  parseFilesForSync,
  needsRewrite,
  OpenDraftPr,
  PrSyncInput,
} from '../git/prDraftSync';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const pexec = promisify(execFile);

export interface PrDraftSyncResult {
  decision: 'skipped' | 'no-pr' | 'not-draft' | 'unchanged' | 'updated' | 'failed';
  pr?: OpenDraftPr;
  reason?: string;
}

/**
 * Look up an open draft PR for `branch` and (when found + content changed)
 * rewrite its body. Returns a structured result so the caller can surface
 * one status-bar line.
 *
 * Failures are demoted to a structured `failed` result rather than thrown:
 * the user's push already succeeded, so a transient gh error here shouldn't
 * raise a modal error.
 */
export async function runPrDraftSync(git: Git, branch?: string): Promise<PrDraftSyncResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.prDraftSync');
  if (!cfg.get<boolean>('enabled', true)) return { decision: 'skipped', reason: 'disabled in settings' };

  const repo = await resolveGitHubRepo(git);
  if (!repo) return { decision: 'skipped', reason: 'origin is not a GitHub repository' };
  if (!(await ghAvailable())) return { decision: 'skipped', reason: 'gh CLI not on PATH' };

  const head = (branch ?? (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD']))).trim();
  if (!head || head === 'HEAD') return { decision: 'skipped', reason: 'detached HEAD' };

  // gh pr view --head <branch> looks up the PR by source branch.
  const prRaw = await ghJson([
    'pr', 'view', head,
    '--repo', `${repo.owner}/${repo.repo}`,
    '--json', 'number,url,headRefName,isDraft,baseRefName,body',
  ]);
  const pr = parseOpenDraftPr(prRaw);
  if (!pr) return { decision: 'no-pr', reason: `no open PR for branch ${head}` };
  if (!pr.isDraft) return { decision: 'not-draft', pr, reason: 'PR is not a draft' };

  const baseRef = (cfg.get<string>('baseRef', '') ?? '').trim() || extractBaseRef(prRaw) || 'origin/main';
  const maxCommits = Math.max(1, Math.min(200, cfg.get<number>('maxCommits', 25)));
  const maxFiles = Math.max(1, Math.min(500, cfg.get<number>('maxFiles', 50)));

  const [logOut, filesOut] = await Promise.all([
    safe(git, ['log', `${baseRef}..HEAD`, '--pretty=format:%h|%s']),
    safe(git, ['diff', '--name-only', `${baseRef}..HEAD`]),
  ]);
  const commits = parseCommitsForSync(logOut, maxCommits);
  const files = parseFilesForSync(filesOut, maxFiles);
  const input: PrSyncInput = {
    commits,
    files,
    syncedAt: formatLocalTime(new Date()),
  };
  const block = buildSyncBlock(input);
  if (!needsRewrite(pr.body, block)) return { decision: 'unchanged', pr };

  const nextBody = injectSyncBlock(pr.body, block);
  try {
    await editPrBody(repo.owner, repo.repo, pr.number, nextBody);
    return { decision: 'updated', pr };
  } catch (e: any) {
    return { decision: 'failed', pr, reason: String(e?.message ?? e ?? 'gh edit failed') };
  }
}

/**
 * Convenience for extension.ts: invoke the sync without blocking the caller,
 * surface one short status-bar line, and swallow any errors. Designed to be
 * called as a fire-and-forget after `git push`.
 */
export function runPrDraftSyncFireAndForget(git: Git, branch?: string): void {
  void (async () => {
    try {
      const r = await runPrDraftSync(git, branch);
      switch (r.decision) {
        case 'updated':
          vscode.window.setStatusBarMessage(
            `GitSight: synced draft PR #${r.pr?.number} body`,
            4000,
          );
          break;
        case 'unchanged':
          // No noise — draft body already matched.
          break;
        case 'failed':
          vscode.window.setStatusBarMessage(
            `GitSight: draft PR sync failed (${truncate(r.reason ?? 'unknown', 60)})`,
            5000,
          );
          break;
        default:
          // skipped / no-pr / not-draft are quiet.
          break;
      }
    } catch {
      // Never let an auto-sync error surface as a modal — the push succeeded.
    }
  })();
}

async function editPrBody(owner: string, repo: string, number: number, body: string): Promise<void> {
  // gh pr edit --body-file allows arbitrary content (newlines, backticks,
  // shell metachars) without quoting headaches.
  const tmp = path.join(os.tmpdir(), `gitsight-prsync-${process.pid}-${Date.now()}.md`);
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await pexec('gh', [
      'pr', 'edit', String(number),
      '--repo', `${owner}/${repo}`,
      '--body-file', tmp,
    ], { maxBuffer: 8 * 1024 * 1024 });
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

async function ghJson(args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('gh', args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

function extractBaseRef(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    const base = obj?.baseRefName;
    if (typeof base === 'string' && base) return `origin/${base}`;
  } catch { /* ignore */ }
  return undefined;
}

async function resolveGitHubRepo(git: Git): Promise<{ owner: string; repo: string } | undefined> {
  try {
    const out = await git.raw(['remote', 'get-url', 'origin']);
    return parseGitHubRepo(out.trim());
  } catch {
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { maxBuffer: 64 * 1024 }); return true; }
  catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function formatLocalTime(d: Date): string {
  // Stable, readable. Matches the shape the test asserts on indirectly via
  // the "_Last synced …_" line — keep it human and compact.
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}\u2026`;
}
