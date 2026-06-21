/**
 * Branch Divergence Visualiser (F36).
 *
 * Listens to `RepoManager.onDidChange` (HEAD/refs moves) and, when the local
 * branch the user lands on is behind its tracked upstream, surfaces ONE
 * informative toast: "feature/x is 4 commits behind origin/main. Top
 * contributors: Alice, Bob +1 others." with three actions:
 *
 *   - Rebase onto upstream
 *   - Merge upstream into current
 *   - Show diff
 *
 * Why this is useful: by the time you've checked out an old feature branch,
 * the default branch has usually moved on. Knowing *who* moved it (so you
 * know who to ping for context on potential conflicts) before you start
 * coding saves real time.
 *
 * Debounced + cooldown'd to avoid spam during multi-step rebases / pulls.
 * Configurable via `gitsight.branchDivergence.enabled` (default true).
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseDivergenceCounts,
  parseShortlog,
  describeDivergence,
  shouldNotify,
  DivergenceContext,
} from '../git/branchDivergence';

const TOP_N = 3;

export class BranchDivergenceWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;
  /** Last (branch, upstreamSha) we already toasted on, to dedupe. Value = epoch ms. */
  private lastNotified = new Map<string, number>();
  /** Per-repo last HEAD so we only fire on actual moves. */
  private lastHead = new Map<string, string>();
  private static COOLDOWN_MS = 2 * 60 * 1000;
  private static DEBOUNCE_MS = 1500;

  constructor(private repos: RepoManager) {
    this.disposables.push(
      repos.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.branchDivergence')) this.schedule();
      }),
    );
    // Prime so the *next* HEAD move triggers, not the initial workspace load.
    queueMicrotask(() => this.primeHeads());
  }

  private async primeHeads() {
    for (const git of this.repos.all()) {
      const head = (await safe(git, ['rev-parse', 'HEAD'])).trim();
      if (head) this.lastHead.set(git.cwd, head);
    }
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.tick().catch(() => {}), BranchDivergenceWatcher.DEBOUNCE_MS);
  }

  private async tick() {
    const cfg = vscode.workspace.getConfiguration('gitsight.branchDivergence');
    if (!cfg.get<boolean>('enabled', true)) return;
    for (const git of this.repos.all()) {
      try { await this.checkRepo(git); }
      catch { /* per-repo failures shouldn't poison the watcher */ }
    }
  }

  private async checkRepo(git: Git) {
    const head = (await safe(git, ['rev-parse', 'HEAD'])).trim();
    if (!head) return;
    const prev = this.lastHead.get(git.cwd);
    if (!prev) { this.lastHead.set(git.cwd, head); return; }
    if (prev === head) return;
    this.lastHead.set(git.cwd, head);

    const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!branch || branch === 'HEAD') return; // detached HEAD has no upstream

    const upstream = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    if (!upstream) return; // no upstream configured

    const upstreamSha = (await safe(git, ['rev-parse', upstream])).trim();
    if (!upstreamSha) return;
    const key = `${git.cwd}::${branch}::${upstreamSha}`;
    const last = this.lastNotified.get(key) ?? 0;
    if (Date.now() - last < BranchDivergenceWatcher.COOLDOWN_MS) return;

    const [revOut, slOut] = await Promise.all([
      safe(git, ['rev-list', '--left-right', '--count', `${upstream}...${branch}`]),
      safe(git, ['shortlog', '-sne', '--no-merges', `${branch}..${upstream}`]),
    ]);
    const counts = parseDivergenceCounts(revOut);
    const contributors = parseShortlog(slOut);
    const ctx: DivergenceContext = {
      branch, upstream, counts,
      topContributors: contributors.slice(0, TOP_N),
      contributorTotal: contributors.length,
    };
    if (!shouldNotify(ctx)) return;
    const message = describeDivergence(ctx);
    if (!message) return;
    this.lastNotified.set(key, Date.now());
    void this.surfaceToast(git, ctx, message);
  }

  private async surfaceToast(git: Git, ctx: DivergenceContext, message: string) {
    const REBASE = 'Rebase onto upstream';
    const MERGE = 'Merge upstream';
    const SHOW = 'Show diff';
    const choice = await vscode.window.showInformationMessage(
      `GitSight: ${message}`,
      { modal: false },
      REBASE, MERGE, SHOW,
    );
    if (!choice) return;
    if (choice === REBASE) await this.rebase(git, ctx);
    else if (choice === MERGE) await this.merge(git, ctx);
    else if (choice === SHOW) await this.showDiff(git, ctx);
  }

  private async rebase(git: Git, ctx: DivergenceContext) {
    const ok = await vscode.window.showWarningMessage(
      `Rebase ${ctx.branch} onto ${ctx.upstream}?`,
      { modal: true, detail: 'If conflicts occur, the GitSight rebase coach will help you walk through them.' },
      'Rebase',
    );
    if (ok !== 'Rebase') return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: rebasing ${ctx.branch} onto ${ctx.upstream}…` },
      async () => {
        try {
          await git.raw(['rebase', ctx.upstream]);
          vscode.window.showInformationMessage(`GitSight: rebased ${ctx.branch} onto ${ctx.upstream}.`);
          vscode.commands.executeCommand('gitsight.refresh');
        } catch (e: any) {
          vscode.window.showErrorMessage(`GitSight: rebase failed: ${e.message}`);
        }
      },
    );
  }

  private async merge(git: Git, ctx: DivergenceContext) {
    try {
      await git.raw(['merge', ctx.upstream]);
      vscode.window.showInformationMessage(`GitSight: merged ${ctx.upstream} into ${ctx.branch}.`);
      vscode.commands.executeCommand('gitsight.refresh');
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: merge failed: ${e.message}`);
    }
  }

  private async showDiff(git: Git, ctx: DivergenceContext) {
    try {
      const diff = await git.raw(['log', '--oneline', `${ctx.branch}..${ctx.upstream}`]);
      const body = diff.trim() || `# Nothing to show — ${ctx.branch} is up to date with ${ctx.upstream}.`;
      const doc = await vscode.workspace.openTextDocument({
        content: `# Commits in ${ctx.upstream} that are not in ${ctx.branch}\n\n${body}`,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: ${e.message}`);
    }
  }

  dispose() {
    if (this.debounce) clearTimeout(this.debounce);
    this.disposables.forEach(d => d.dispose());
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
