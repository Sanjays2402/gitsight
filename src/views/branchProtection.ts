import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { parseRemote } from '../git/hostDetect';

const pexec = promisify(execFile);

interface Rule {
  branch: string;
  requiresReview: boolean;
  requiredApprovers?: number;
  requiresStatusChecks: boolean;
  requiredChecks?: string[];
  requiresLinearHistory?: boolean;
  requiresSignedCommits?: boolean;
  enforceAdmins?: boolean;
  restrictsPushes?: boolean;
  allowsForcePush?: boolean;
  allowsDeletion?: boolean;
}

export async function showBranchProtection(git: Git) {
  const remotes = await git.remotes().catch(() => []);
  const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
  const info = origin && parseRemote(origin.fetchUrl);
  if (!info) return vscode.window.showInformationMessage('No GitHub or Azure DevOps remote detected.');

  const branches = (await git.branches(false)).map(b => b.name);
  const current = await git.raw(['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim()).catch(() => 'main');
  const branch = await vscode.window.showQuickPick(branches, {
    placeHolder: `Branch to inspect protection rules for (default: ${current})`,
  });
  if (!branch) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching protection rules for ${branch}…` },
    async () => {
      try {
        let rule: Rule | null = null;
        if (info.host === 'github') rule = await fetchGitHub(git.cwd, info.owner, info.repo, branch);
        else if (info.host === 'azure-devops') rule = await fetchAzure(git.cwd, info.owner, info.project!, info.repo, branch);
        if (!rule) return vscode.window.showInformationMessage(`No protection rules on ${branch}.`);
        const md = renderRule(rule);
        const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Branch protection fetch failed: ${e?.message ?? e}`);
      }
    },
  );
}

async function fetchGitHub(cwd: string, owner: string, repo: string, branch: string): Promise<Rule | null> {
  try {
    const { stdout } = await pexec('gh', ['api', `repos/${owner}/${repo}/branches/${branch}/protection`], { cwd });
    const j = JSON.parse(stdout);
    return {
      branch,
      requiresReview: !!j.required_pull_request_reviews,
      requiredApprovers: j.required_pull_request_reviews?.required_approving_review_count,
      requiresStatusChecks: !!j.required_status_checks,
      requiredChecks: j.required_status_checks?.contexts ?? [],
      requiresLinearHistory: !!j.required_linear_history?.enabled,
      requiresSignedCommits: !!j.required_signatures?.enabled,
      enforceAdmins: !!j.enforce_admins?.enabled,
      restrictsPushes: !!j.restrictions,
      allowsForcePush: !!j.allow_force_pushes?.enabled,
      allowsDeletion: !!j.allow_deletions?.enabled,
    };
  } catch (e: any) {
    if (/HTTP 404/.test(e?.stderr || e?.message || '')) return null;
    throw e;
  }
}

async function fetchAzure(cwd: string, org: string, project: string, repo: string, branch: string): Promise<Rule | null> {
  try {
    // az repos policy list (requires `az` + `azure-devops` ext, user authed)
    const { stdout: ridOut } = await pexec('az', [
      'repos', 'show', '--repository', repo,
      '--org', `https://dev.azure.com/${org}`, '--project', project, '--output', 'json',
    ], { cwd });
    const repoId = JSON.parse(ridOut).id;
    const { stdout } = await pexec('az', [
      'repos', 'policy', 'list',
      '--repository-id', repoId, '--branch', branch,
      '--org', `https://dev.azure.com/${org}`, '--project', project, '--output', 'json',
    ], { cwd });
    const policies: any[] = JSON.parse(stdout);
    if (!policies.length) return null;
    const find = (t: string) => policies.find(p => p.type?.displayName === t)?.settings;
    const review = find('Minimum number of reviewers');
    const checks = policies.filter(p => p.type?.displayName === 'Build').map(p => p.settings?.displayName || 'build').filter(Boolean);
    return {
      branch,
      requiresReview: !!review,
      requiredApprovers: review?.minimumApproverCount,
      requiresStatusChecks: checks.length > 0,
      requiredChecks: checks,
      requiresLinearHistory: !!find('Require a merge strategy'),
      requiresSignedCommits: false,
      enforceAdmins: false,
      restrictsPushes: policies.some(p => p.type?.displayName === 'Require a merge strategy'),
      allowsForcePush: false,
      allowsDeletion: false,
    };
  } catch (e: any) {
    if (/not found|404/i.test(e?.stderr || e?.message || '')) return null;
    throw e;
  }
}

function renderRule(r: Rule): string {
  const ok = (b: boolean | undefined) => b ? '✅' : '⬜';
  return [
    `# Branch protection — \`${r.branch}\``,
    '',
    '| Setting | Status |',
    '|---|---|',
    `| Requires pull request reviews | ${ok(r.requiresReview)}${r.requiredApprovers ? ` (≥ ${r.requiredApprovers} approvers)` : ''} |`,
    `| Requires status checks | ${ok(r.requiresStatusChecks)} |`,
    `| Required checks | ${(r.requiredChecks?.length ? r.requiredChecks.map(c => `\`${c}\``).join(', ') : '—')} |`,
    `| Requires linear history | ${ok(r.requiresLinearHistory)} |`,
    `| Requires signed commits | ${ok(r.requiresSignedCommits)} |`,
    `| Enforce on admins | ${ok(r.enforceAdmins)} |`,
    `| Restricts who can push | ${ok(r.restrictsPushes)} |`,
    `| Allows force push | ${ok(r.allowsForcePush)} |`,
    `| Allows branch deletion | ${ok(r.allowsDeletion)} |`,
    '',
    '---',
    '_Source: `gh api repos/.../branches/.../protection` or `az repos policy list`._',
  ].join('\n');
}
