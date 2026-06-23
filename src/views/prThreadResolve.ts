/**
 * F108 - PR Comment Thread Resolver.
 *
 * Composes with F88 (PR Comments Inbox). The inbox lists unresolved
 * review-comment threads but stops at "open the file at line". This
 * view lets you actually mark threads as resolved without leaving the
 * editor.
 *
 * Flow:
 *   1. Resolve the target PR (current branch's open PR by default;
 *      explicit number wins when passed from a tree-item context menu).
 *   2. Fetch reviewThreads via gh GraphQL exposure:
 *        gh pr view <num> --json reviewThreads
 *   3. Show a multi-pick of unresolved threads (outdated sink to bottom).
 *   4. Build a single batched `mutation { t0: resolveReviewThread...
 *      t1: ... }` and pipe through `gh api graphql -F query=@-`.
 *   5. Summarise: all / partial / none, with per-failure error toast.
 *
 * Degrades gracefully:
 *   - gh CLI missing -> warning toast + bail.
 *   - gh not authenticated -> recover message + bail.
 *   - PR has no unresolved threads -> info toast.
 *   - Selected zero threads -> bail silently.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import {
  parseReviewThreads,
  selectResolvable,
  describeThreadLabel,
  describeThreadDescription,
  describeThreadsSummary,
  buildResolveMutation,
  classifyResolveResponse,
  MAX_BATCH,
  ReviewThread,
} from '../git/prThreadResolve';

const pexec = promisify(execFile);

export async function resolvePrCommentThreads(git: Git, prNumberArg?: number): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  const prNumber = await resolvePrNumber(git, prNumberArg);
  if (!prNumber) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch (and no PR number provided).');
    return;
  }

  const raw = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: loading PR #${prNumber} threads\u2026` },
    () => fetchThreads(git, prNumber),
  );
  if (raw === undefined) return;
  const all = parseReviewThreads(raw);
  if (!all.length) {
    vscode.window.showInformationMessage(`GitSight: PR #${prNumber} has no review threads.`);
    return;
  }
  const resolvable = selectResolvable(all);
  if (!resolvable.length) {
    vscode.window.showInformationMessage(`GitSight: PR #${prNumber} - all review threads already resolved. \u{1F389}`.replace(/[^\x00-\x7f\u00a0-\u3000]/g, ''));
    return;
  }

  type Pk = vscode.QuickPickItem & { _thread?: ReviewThread };
  const items: Pk[] = [];
  items.push({ label: describeThreadsSummary(all), kind: vscode.QuickPickItemKind.Separator } as any);
  for (const t of resolvable) {
    const last = t.comments[t.comments.length - 1];
    const detail = last?.body ? truncate(last.body.replace(/\s+/g, ' ').trim(), 140) : undefined;
    const rel = last?.createdAt ? `  \u00b7  ${timeAgo(new Date(last.createdAt))}` : '';
    items.push({
      label: `$(${t.isOutdated ? 'archive' : 'comment-discussion'}) ${describeThreadLabel(t)}${rel}`,
      description: describeThreadDescription(t),
      detail,
      _thread: t,
      picked: !t.isOutdated && t.comments.length <= 3,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Select threads to resolve on PR #${prNumber} (${resolvable.length} open)`,
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  }) as Pk[] | undefined;
  if (!picked || !picked.length) return;
  const targets = picked.map(p => p._thread).filter((t): t is ReviewThread => !!t);
  if (!targets.length) return;

  if (targets.length > MAX_BATCH) {
    const cont = await vscode.window.showWarningMessage(
      `GitSight: ${targets.length} threads selected - only the first ${MAX_BATCH} will be resolved in this batch.`,
      { modal: true },
      `Resolve first ${MAX_BATCH}`,
    );
    if (!cont) return;
    targets.length = MAX_BATCH;
  }

  const ids = targets.map(t => t.id);
  const mutation = buildResolveMutation(ids);
  const response = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: resolving ${ids.length} thread${ids.length === 1 ? '' : 's'}\u2026` },
    () => runResolve(git, mutation),
  );
  if (response === undefined) return;
  const summary = classifyResolveResponse(response, ids);

  if (summary.outcome === 'all') {
    vscode.window.setStatusBarMessage(`GitSight: resolved ${summary.resolvedIds.length} thread${summary.resolvedIds.length === 1 ? '' : 's'} on PR #${prNumber}.`, 4000);
  } else if (summary.outcome === 'none') {
    const errLine = summary.errorMessages[0] ? ` - ${summary.errorMessages[0]}` : '';
    vscode.window.showErrorMessage(`GitSight: could not resolve any of the ${ids.length} thread${ids.length === 1 ? '' : 's'}${errLine}.`);
  } else {
    const errLine = summary.errorMessages[0] ? ` (${summary.errorMessages[0]})` : '';
    vscode.window.showWarningMessage(`GitSight: resolved ${summary.resolvedIds.length}/${ids.length} thread${ids.length === 1 ? '' : 's'} on PR #${prNumber}${errLine}.`);
  }
}

async function resolvePrNumber(git: Git, arg?: number): Promise<number | undefined> {
  if (arg && Number.isFinite(arg) && arg > 0) return arg;
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'number'], { cwd: git.cwd, maxBuffer: 1024 * 1024 });
    const obj = JSON.parse(stdout);
    const n = Number(obj?.number);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

async function fetchThreads(git: Git, prNumber: number): Promise<string | undefined> {
  try {
    const { stdout } = await pexec(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'reviewThreads'],
      { cwd: git.cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? '');
    if (/not\s+authenticated/i.test(stderr)) {
      vscode.window.showWarningMessage('GitSight: gh is not authenticated. Run `gh auth login` and try again.');
    } else if (/unknown\s+JSON\s+field\s+"reviewThreads"/i.test(stderr) || /requires\s+the\s+`reviewThreads`/i.test(stderr)) {
      vscode.window.showWarningMessage('GitSight: this gh version does not expose `reviewThreads`. Update gh (brew upgrade gh) and try again.');
    } else if (stderr.trim()) {
      vscode.window.showErrorMessage(`GitSight: gh pr view failed - ${stderr.split('\n')[0]}`);
    }
    return undefined;
  }
}

async function runResolve(git: Git, mutation: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolveP) => {
    const child = execFile(
      'gh',
      ['api', 'graphql', '-F', 'query=@-'],
      { cwd: git.cwd, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || (err as Error).message || '').toString();
          if (/not\s+authenticated/i.test(msg)) {
            vscode.window.showWarningMessage('GitSight: gh is not authenticated. Run `gh auth login` and try again.');
            resolveP(undefined);
            return;
          }
          // gh returns non-zero on GraphQL errors; we still want to read
          // stdout so classifyResolveResponse can attribute partial
          // success. Fall through with whatever stdout we got, but the
          // classifier will mark missing IDs as failed.
          resolveP(stdout || msg);
          return;
        }
        resolveP(stdout);
      },
    );
    child.stdin?.write(mutation);
    child.stdin?.end();
  });
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { maxBuffer: 64 * 1024 }); return true; } catch { return false; }
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '\u2026';
}
