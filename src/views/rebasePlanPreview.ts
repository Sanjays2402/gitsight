/**
 * Rebase Plan Preview (F49) — before running `git rebase -i --autosquash <upstream>`,
 * render the to-rebase commits with their planned grouping (fixup pairs,
 * squash candidates, amend targets) and let the user confirm or back out.
 *
 * Flow:
 *   1. Resolve upstream — `@{u}` first, falls back to `origin/<branch>`,
 *      then to a quick-pick over local branches.
 *   2. Fetch the commit list with `git log --pretty=...`.
 *   3. Compute the autosquash plan (pure helper).
 *   4. Render the plan in a scratch Markdown document, side by side.
 *   5. Modal "Run autosquash now / Cancel".
 *   6. On Run, fire `git rebase -i --autosquash <upstream>` with
 *      GIT_SEQUENCE_EDITOR=':' so it accepts the computed plan.
 *
 * Refuses to act if the range has no autosquash markers (would be a no-op);
 * surfaces orphan markers as a separate warning so the user knows their
 * fixup!s aren't going to fold.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  buildAutosquashPlan,
  renderPlanMarkdown,
  parsePlanLog,
} from '../git/rebasePlan';

const FMT = '%H|%h|%s';

export async function showRebasePlanPreview(git: Git) {
  const head = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const upstream = await resolveUpstream(git, head);
  if (!upstream) {
    vscode.window.showInformationMessage('GitSight: no upstream — cancelled.');
    return;
  }

  const raw = await safe(git, ['log', `--pretty=format:${FMT}`, `${upstream}..HEAD`]);
  const commits = parsePlanLog(raw);
  if (!commits.length) {
    vscode.window.showInformationMessage(`GitSight: nothing to rebase — ${upstream}..HEAD is empty.`);
    return;
  }
  const plan = buildAutosquashPlan(commits);

  // Open the plan in a scratch document for review.
  const body = renderPlanMarkdown(plan, { upstream, head });
  const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);

  if (plan.trivial) {
    vscode.window.showInformationMessage(
      `GitSight: no autosquash work needed on ${upstream}..HEAD. Nothing to run.`,
    );
    return;
  }

  // Confirmation dialog.
  const summary = `${plan.counts.pick} pick, ${plan.counts.fixup} fixup, ${plan.counts.squash} squash, ${plan.counts.amend} amend`;
  const orphanLine = plan.orphans.length
    ? `\n\n${plan.orphans.length} orphan autosquash marker${plan.orphans.length === 1 ? '' : 's'} will be left as plain picks.`
    : '';
  const ans = await vscode.window.showWarningMessage(
    `Run rebase -i --autosquash ${upstream}?\n\nPlan: ${summary}.${orphanLine}\n\nThis rewrites history — review the plan first.`,
    { modal: true },
    'Run autosquash', 'Copy command',
  );
  if (!ans) return;
  if (ans === 'Copy command') {
    await vscode.env.clipboard.writeText(`git rebase -i --autosquash ${upstream}`);
    vscode.window.setStatusBarMessage('Copied: git rebase -i --autosquash …', 3000);
    return;
  }
  await runAutosquash(git, upstream);
}

async function resolveUpstream(git: Git, head: string): Promise<string | undefined> {
  // 1. Try @{u}.
  const up = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (up) return up;
  // 2. origin/<head> if it exists.
  if (head && head !== 'HEAD') {
    const candidate = `origin/${head}`;
    const ok = await safe(git, ['rev-parse', '--verify', candidate]);
    if (ok.trim()) return candidate;
  }
  // 3. Picker over local branches.
  const branches = (await safe(git, ['branch', '--format=%(refname:short)']))
    .split('\n').map(s => s.trim()).filter(b => b && b !== head);
  if (!branches.length) return undefined;
  const picked = await vscode.window.showQuickPick(branches, {
    placeHolder: `Rebase plan — pick an upstream to compare against ${head}`,
  });
  return picked;
}

async function runAutosquash(git: Git, upstream: string) {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const pexec = promisify(execFile);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: rebase --autosquash ${upstream}…` },
      async () => {
        await pexec(
          'git',
          ['rebase', '-i', '--autosquash', upstream],
          {
            cwd: git.cwd,
            env: { ...process.env, GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' },
            maxBuffer: 100 * 1024 * 1024,
          },
        );
      },
    );
    vscode.window.showInformationMessage('GitSight: rebase --autosquash complete.');
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(
      `GitSight: rebase --autosquash failed (${(e.stderr || e.message || '').toString().trim().split('\n')[0]}).\n` +
      `Run \`git rebase --abort\` if a rebase is now in progress.`,
    );
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
