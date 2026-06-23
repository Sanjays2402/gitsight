/**
 * F119 - Branch Protection Overview command.
 *
 * One-shot picker that probes branch-protection settings across the
 * local branch list and surfaces a ranked table:
 *
 *   default branch (locked)         lock     5 rules
 *   current branch (reviewed)       verified force allowed
 *   release/2026.q2 (unprotected)   unlock
 *   feature/foo (unknown)           question gh CLI not authenticated
 *
 * Click a row -> per-branch action picker (open settings page, copy
 * branch name, view detailed rules).
 *
 * Composes with F71 force-push guard (which probes ONE branch at push
 * time). This is the proactive overview, F71 is the just-in-time gate.
 *
 * Hard requirements:
 *   - gh CLI on PATH (warns + bails otherwise)
 *   - GitHub repo origin (silently skipped otherwise - non-GitHub
 *     remotes have no protection API).
 *
 * Bounded fan-out: probe at most 20 branches per invocation (configurable),
 * preferring default + current + recent. A trailing action lets the user
 * probe more.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parseGitHubRepo } from '../git/forcePushGuard';
import {
  buildOverview,
  buildOverviewReport,
  formatOverviewHeader,
  selectBranchesToProbe,
  BranchProtectionProbe,
  BranchProtectionRow,
  ProtectionOverview,
  DEFAULT_PROBE_LIMIT,
} from '../git/branchProtectionOverview';

const pexec = promisify(execFile);

export async function showBranchProtectionOverview(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot probe branch protection.');
    return;
  }
  const repo = await resolveGitHubRepo(git);
  if (!repo) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub remote - branch protection only applies to GitHub.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.branchProtectionOverview');
  const limit = Math.max(3, Math.min(100, cfg.get<number>('probeLimit', DEFAULT_PROBE_LIMIT)));

  const overview = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: probing branch protection in ${repo.owner}/${repo.repo}\u2026`,
      cancellable: true,
    },
    async (progress, token) => {
      const [currentBranch, defaultBranch, candidates] = await Promise.all([
        loadCurrentBranch(git),
        loadDefaultBranch(git),
        loadLocalBranchCandidates(git),
      ]);
      const branches = selectBranchesToProbe(candidates, { currentBranch, defaultBranch, limit });
      const probes: BranchProtectionProbe[] = [];
      let done = 0;
      for (const branch of branches) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${branch} (${++done}/${branches.length})`, increment: 100 / branches.length });
        const probe = await probeBranch(repo.owner, repo.repo, branch);
        probes.push(probe);
      }
      return buildOverview({ probes, currentBranch, defaultBranch });
    },
  );

  await renderPicker(git, repo, overview);
}

interface RepoSlug { owner: string; repo: string; }

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

async function resolveGitHubRepo(git: Git): Promise<RepoSlug | undefined> {
  try {
    const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
    return parseGitHubRepo(url);
  } catch {
    return undefined;
  }
}

async function loadCurrentBranch(git: Git): Promise<string | undefined> {
  try {
    const out = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!out || out === 'HEAD') return undefined;
    return out;
  } catch { return undefined; }
}

async function loadDefaultBranch(git: Git): Promise<string | undefined> {
  try {
    const out = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out.replace(/^origin\//, '');
  } catch { /* may not be set */ }
  for (const cand of ['main', 'master']) {
    try {
      await git.raw(['rev-parse', '--verify', cand]);
      return cand;
    } catch { /* skip */ }
  }
  return undefined;
}

async function loadLocalBranchCandidates(git: Git): Promise<string[]> {
  try {
    // Sort by committerdate so recent branches are scored first.
    const out = await git.raw(['for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads/']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function probeBranch(owner: string, repo: string, branch: string): Promise<BranchProtectionProbe> {
  try {
    const { stdout, stderr } = await pexec(
      'gh',
      ['api', `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    return { branch, body: stdout, stderr: stderr ?? '', exitCode: 0 };
  } catch (e: any) {
    return {
      branch,
      body: typeof e?.stdout === 'string' ? e.stdout : '',
      stderr: typeof e?.stderr === 'string' ? e.stderr : (e?.message ?? ''),
      exitCode: typeof e?.code === 'number' ? e.code : 1,
    };
  }
}

async function renderPicker(git: Git, repo: RepoSlug, overview: ProtectionOverview): Promise<void> {
  type Pk = vscode.QuickPickItem & {
    _row?: BranchProtectionRow;
    _action?: 'open-report' | 'open-settings' | 'refresh';
  };
  const items: Pk[] = [];
  items.push({ label: formatOverviewHeader(overview), kind: vscode.QuickPickItemKind.Separator } as any);
  if (overview.rows.length === 0) {
    items.push({ label: '$(info) no local branches probed', description: 'nothing to show' });
  } else {
    for (const row of overview.rows) {
      const tag = row.isDefault ? ' (default)' : row.isCurrent ? ' (current)' : '';
      items.push({
        label: `$(${row.glyph}) ${row.branch}${tag}`,
        description: row.summary,
        detail: row.level === 'unknown' ? row.summary : undefined,
        _row: row,
      });
    }
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(notebook) Open full report', description: 'markdown scratch buffer', _action: 'open-report' });
  items.push({ label: '$(gear) Open repo branch protection settings', description: `${repo.owner}/${repo.repo}`, _action: 'open-settings' });
  items.push({ label: '$(refresh) Refresh', _action: 'refresh' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Branch protection - ${repo.owner}/${repo.repo}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'refresh') {
    const rm = (git as any).repos as RepoManager | undefined;
    await showBranchProtectionOverview(rm ?? new RepoManagerLike(git) as any);
    return;
  }
  if (picked._action === 'open-report') {
    const doc = await vscode.workspace.openTextDocument({
      content: buildOverviewReport(overview),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    return;
  }
  if (picked._action === 'open-settings') {
    await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repo.owner}/${repo.repo}/settings/branches`));
    return;
  }
  if (picked._row) {
    await openRowActions(repo, picked._row);
    return;
  }
}

async function openRowActions(repo: RepoSlug, row: BranchProtectionRow): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action: string };
  const items: Pk[] = [];
  items.push({ label: '$(link-external) Open branch on GitHub', _action: 'open-branch' });
  items.push({ label: '$(gear) Open branch protection rule (or add one)', _action: 'open-rule' });
  items.push({ label: '$(copy) Copy branch name', _action: 'copy-name' });
  if (row.decision.kind === 'protected') {
    items.push({ label: '$(list-unordered) Show all enabled rules', _action: 'show-rules' });
  }
  if (row.decision.kind === 'unknown') {
    items.push({ label: '$(question) Show probe error', _action: 'show-error' });
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `${row.branch} - ${row.summary}` });
  if (!picked) return;
  if (picked._action === 'open-branch') {
    await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repo.owner}/${repo.repo}/tree/${encodeURIComponent(row.branch)}`));
  } else if (picked._action === 'open-rule') {
    await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repo.owner}/${repo.repo}/settings/branches`));
  } else if (picked._action === 'copy-name') {
    await vscode.env.clipboard.writeText(row.branch);
    vscode.window.setStatusBarMessage(`Copied ${row.branch}`, 2000);
  } else if (picked._action === 'show-rules' && row.decision.kind === 'protected') {
    const lines = row.decision.rules.filter(r => r.enabled).map(r => `- ${r.label}`).join('\n');
    const md = `# Branch protection - ${row.branch}\n\n${lines || '_no rules enabled_'}\n`;
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  } else if (picked._action === 'show-error' && row.decision.kind === 'unknown') {
    vscode.window.showErrorMessage(`GitSight: ${row.decision.reason}`);
  }
}

// Tiny shim so renderPicker can call the public command without
// holding a RepoManager — `gitsight.refreshBranchProtectionOverview`
// re-enters from the command palette, but the picker also offers
// in-place refresh.
class RepoManagerLike {
  constructor(private g: Git) {}
  primary() { return this.g; }
}
