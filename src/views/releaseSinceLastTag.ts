/**
 * F117 - "Last release vs HEAD" CHANGELOG preview command.
 *
 * Spinoff of F86 tag-on-merge: instead of waiting until you actually
 * merged a PR to see the suggested next tag and notes draft, this
 * surfaces the running tally at any time:
 *
 *   "47 commits since v1.2.0 - 12 features, 3 fixes - suggests v1.3.0 (minor)"
 *
 * Flow:
 *   1. Locate the last reachable tag (any semver tag, not just stable).
 *   2. Walk `<lastTag>..HEAD` to gather commits + numstat.
 *   3. Build the accumulation summary + headline.
 *   4. Show a picker:
 *        - Open CHANGELOG preview (markdown scratch buffer)
 *        - Copy headline to clipboard
 *        - Copy markdown section to clipboard
 *        - Refresh
 *        - Per-commit drill-down (gitsight.showCommitDetail)
 *
 * Why a fresh command instead of just extending F86 prompt: the F86
 * prompt is opt-in after a merge AND triggers the tag/release flow.
 * This is a passive "what would I ship right now?" view that doesn't
 * touch anything destructive. Different mental model, different
 * surface.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseDiffNumstat,
  summariseAccumulation,
  formatAccumulationHeadline,
  buildChangelogPreview,
  AccumulationSummary,
  DiffNumstatRow,
} from '../git/releaseSinceLastTag';
import { MergedCommit } from '../git/tagOnMerge';

const LOG_FORMAT = '%H|%h|%s%n%b%x00%an%x00';

export async function showReleaseSinceLastTag(git: Git): Promise<void> {
  const lastTag = await loadLastTag(git);
  const rangeRef = lastTag ? `${lastTag}..HEAD` : 'HEAD~100..HEAD';

  const commits = await loadMergedCommits(git, rangeRef);
  if (commits.length === 0) {
    vscode.window.showInformationMessage(
      lastTag
        ? `GitSight: no new commits since ${lastTag}.`
        : `GitSight: no commits in ${rangeRef}.`,
    );
    return;
  }
  const rawNumstat = await safe(git, ['diff', '--numstat', rangeRef]);
  const numstat = parseDiffNumstat(rawNumstat);
  const summary = summariseAccumulation({ commits, numstat, previousTag: lastTag });
  await renderPicker(git, { commits, numstat, summary, previousTag: lastTag, rangeRef });
}

interface RenderArgs {
  commits: MergedCommit[];
  numstat: DiffNumstatRow[];
  summary: AccumulationSummary;
  previousTag?: string;
  rangeRef: string;
}

async function renderPicker(git: Git, args: RenderArgs): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action?: 'preview' | 'copyHeadline' | 'copyMarkdown' | 'refresh' | 'jump'; _sha?: string };
  const headline = formatAccumulationHeadline(args.summary, args.previousTag);
  const items: Pk[] = [];
  items.push({ label: headline, kind: vscode.QuickPickItemKind.Separator } as any);
  items.push({ label: '$(notebook) Open CHANGELOG preview', detail: 'markdown scratch buffer with sections + touched files', _action: 'preview' });
  items.push({ label: '$(copy) Copy headline to clipboard', _action: 'copyHeadline' });
  items.push({ label: '$(markdown) Copy markdown section to clipboard', _action: 'copyMarkdown' });
  items.push({ label: '$(refresh) Refresh', _action: 'refresh' });
  items.push({ label: `Commits in ${args.rangeRef}`, kind: vscode.QuickPickItemKind.Separator } as any);
  for (const c of args.commits.slice(0, 80)) {
    items.push({
      label: `$(git-commit) ${c.shortSha}  ${truncate(c.subject, 80)}`,
      description: c.author,
      _action: 'jump',
      _sha: c.sha,
    });
  }
  if (args.commits.length > 80) {
    items.push({ label: `... ${args.commits.length - 80} more commits`, kind: vscode.QuickPickItemKind.Separator } as any);
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Range ${args.rangeRef} - ${args.summary.fileCount} files, +${args.summary.added}/-${args.summary.removed}`,
    matchOnDescription: true,
  });
  if (!picked || !picked._action) return;
  switch (picked._action) {
    case 'preview': {
      const md = buildChangelogPreview({
        commits: args.commits,
        numstat: args.numstat,
        previousTag: args.previousTag,
        summary: args.summary,
        rangeRef: args.rangeRef,
      });
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md + '\n' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    case 'copyHeadline':
      await vscode.env.clipboard.writeText(headline);
      vscode.window.setStatusBarMessage('GitSight: headline copied.', 2000);
      return;
    case 'copyMarkdown': {
      const md = buildChangelogPreview({
        commits: args.commits,
        numstat: args.numstat,
        previousTag: args.previousTag,
        summary: args.summary,
        rangeRef: args.rangeRef,
      });
      await vscode.env.clipboard.writeText(md);
      vscode.window.setStatusBarMessage('GitSight: markdown copied.', 2000);
      return;
    }
    case 'refresh':
      await showReleaseSinceLastTag(git);
      return;
    case 'jump':
      if (picked._sha) {
        try {
          await vscode.commands.executeCommand('gitsight.showCommitDetail', git, picked._sha);
        } catch {
          await vscode.env.clipboard.writeText(picked._sha);
          vscode.window.setStatusBarMessage(`Copied ${picked._sha.slice(0, 7)}`, 1500);
        }
      }
      return;
  }
}

async function loadLastTag(git: Git): Promise<string | undefined> {
  try {
    const out = (await git.raw(['describe', '--tags', '--abbrev=0', 'HEAD'])).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load commits in oldest-newest reverse (git log default is newest first;
 * F86 helpers don't care about order). Use a NUL-separated body so
 * multi-line bodies don't break the splitter.
 */
async function loadMergedCommits(git: Git, rangeRef: string): Promise<MergedCommit[]> {
  const raw = await safe(git, ['log', `--pretty=format:${LOG_FORMAT}`, '--no-merges', rangeRef]);
  if (!raw) return [];
  const out: MergedCommit[] = [];
  // Each commit ends with author + NUL; record separator is the second NUL.
  // We split on NUL pairs but keep the format simple: lines are <sha>|<short>|<subject>\n<body>\x00<author>\x00
  const records = raw.split('\x00').filter(r => r.trim().length > 0);
  for (let i = 0; i < records.length - 1; i += 2) {
    const head = records[i];
    const author = (records[i + 1] ?? '').trim();
    const newlineIdx = head.indexOf('\n');
    const headerLine = newlineIdx >= 0 ? head.slice(0, newlineIdx) : head;
    const body = newlineIdx >= 0 ? head.slice(newlineIdx + 1).trim() : '';
    const parts = headerLine.split('|');
    if (parts.length < 3) continue;
    const [sha, shortSha, ...subjectRest] = parts;
    out.push({
      sha,
      shortSha,
      subject: subjectRest.join('|').trim(),
      body,
      author: author || undefined,
    });
  }
  return out;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return (await git.raw(args)) ?? ''; } catch { return ''; }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '\u2026';
}

export async function runReleaseSinceLastTag(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  await showReleaseSinceLastTag(git);
}
