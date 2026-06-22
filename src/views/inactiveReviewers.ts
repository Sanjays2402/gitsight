/**
 * F105 — Inactive-reviewer detection + nudge.
 *
 * Composes with F75 prReviewInbox: when the user picks a PR they're
 * authoring or reviewing, the action menu gets a new option, "Find
 * inactive reviewers". That option:
 *
 *   1. Runs `gh pr view <num> --json reviewRequests,reviews,createdAt,
 *      updatedAt,isDraft`.
 *   2. Classifies requested reviewers via inactiveReviewers.ts pure
 *      helpers.
 *   3. Filters to "silent && over staleAfterDays".
 *   4. Picker shows the inactive reviewers; multi-select; bottom row is
 *      "Compose reminder comment" which:
 *      a. Builds a body via composeReminderComment().
 *      b. Opens a preview buffer.
 *      c. Picker offers Post via gh / Copy command / Cancel.
 *
 * Standalone command also exposes the flow on the current branch's
 * open PR (`gitsight.findInactiveReviewers`).
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import {
  parsePrActivity,
  buildReviewerStatuses,
  findInactiveReviewers,
  composeReminderComment,
  summariseInactive,
  ReviewerStatus,
} from '../git/inactiveReviewers';

const pexec = promisify(execFile);

interface InvokeArgs {
  /** PR number. */
  number: number;
  /** owner/repo slug — when provided, the gh call targets that repo. */
  repoSlug?: string;
}

/** Standalone command: prompt for PR number when called without an arg. */
export async function runFindInactiveReviewers(git: Git, arg?: InvokeArgs): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  let number = arg?.number;
  const repoSlug = arg?.repoSlug;
  if (!number) {
    // Default to the current branch's open PR.
    const current = await currentBranchPrNumber(git);
    if (current) {
      number = current;
    } else {
      const input = await vscode.window.showInputBox({
        title: 'GitSight: PR number',
        prompt: 'PR number to scan for inactive reviewers',
        validateInput: v => /^\d+$/.test(v.trim()) ? null : 'Enter a PR number (digits only).',
        ignoreFocusOut: true,
      });
      if (!input) return;
      number = Number(input.trim());
    }
  }

  const activity = await loadPrActivity(git, number, repoSlug);
  if (!activity) {
    vscode.window.showWarningMessage(`GitSight: couldn't load PR #${number} activity (gh permissions / not found).`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.inactiveReviewers');
  const staleAfterDays = Math.max(1, Math.min(60, cfg.get<number>('staleAfterDays', 3)));
  const includeTeams = cfg.get<boolean>('includeTeams', true);
  const includeCommented = cfg.get<boolean>('includeCommented', false);

  const statuses = buildReviewerStatuses(activity);
  const inactive = findInactiveReviewers(activity, statuses, {
    staleAfterDays,
    includeTeams,
    includeCommented,
  });

  if (!inactive.length) {
    const note = activity.isDraft
      ? `PR #${number} is a draft — no reminders sent.`
      : `PR #${number}: ${summariseInactive(inactive)}.`;
    vscode.window.showInformationMessage(`GitSight: ${note}`);
    return;
  }

  await pickAndCompose(git, number, statuses, inactive);
}

async function pickAndCompose(
  git: Git,
  prNumber: number,
  allStatuses: ReviewerStatus[],
  inactive: ReviewerStatus[],
): Promise<void> {
  type Pk = vscode.QuickPickItem & { _login?: string; _activeCount?: boolean };
  const items: Pk[] = [];
  items.push({
    label: `PR #${prNumber}  -  ${summariseInactive(inactive)}`,
    kind: vscode.QuickPickItemKind.Separator,
  } as any);
  for (const r of inactive) {
    items.push({
      label: `$(${r.isTeam ? 'organization' : 'person'}) @${r.login}`,
      description: `${r.daysSinceRequest}d silent`,
      detail: r.isTeam ? 'team handle (expands server-side)' : 'individual reviewer',
      picked: true,
      _login: r.login,
    });
  }
  if (allStatuses.length > inactive.length) {
    items.push({
      label: '$(check) reviewers already responded',
      kind: vscode.QuickPickItemKind.Separator,
    } as any);
    for (const r of allStatuses.filter(s => !inactive.includes(s))) {
      items.push({
        label: `@${r.login}`,
        description: r.activity,
        detail: 'no nudge — already participated',
        _login: r.login,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Nudge inactive reviewers on PR #${prNumber}`,
    placeHolder: 'Tick the reviewers to remind, then confirm.',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked || picked.length === 0) return;

  const chosen = picked
    .filter(p => p._login)
    .map(p => inactive.find(r => r.login === p._login) ?? allStatuses.find(r => r.login === p._login))
    .filter((x): x is ReviewerStatus => !!x);
  if (!chosen.length) return;

  const tonePick = await vscode.window.showQuickPick(
    [
      { label: '$(megaphone) Gentle ping', description: '"Gentle ping on this."' as any, _tone: 'gentle' as const },
      { label: '$(megaphone) Firm bump', description: '"Bumping this for review."', _tone: 'firm' as const },
      { label: '$(edit) Custom prefix\u2026', description: 'compose your own opening sentence', _tone: 'custom' as const },
    ],
    { title: 'Tone', placeHolder: 'How should the reminder open?' },
  );
  if (!tonePick) return;

  let prefix: string | undefined;
  if (tonePick._tone === 'custom') {
    prefix = await vscode.window.showInputBox({
      prompt: 'Reminder opener (markdown ok). Mentions are appended automatically.',
      placeHolder: 'Quick nudge:',
      ignoreFocusOut: true,
    });
    if (prefix === undefined) return;
  }

  const body = composeReminderComment(chosen, { prefix, tone: tonePick._tone === 'firm' ? 'firm' : 'gentle' });
  if (!body) return;

  const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(comment) Post via gh', description: `gh pr comment ${prNumber}` },
      { label: '$(clippy) Copy gh command' },
      { label: '$(clippy) Copy body' },
    ],
    { placeHolder: 'Send the reminder?' },
  );
  if (!action) return;

  if (action.label.includes('Post via gh')) {
    await postComment(git, prNumber, body);
  } else if (action.label.includes('Copy gh command')) {
    await vscode.env.clipboard.writeText(`gh pr comment ${prNumber} --body-file - <<'EOF'\n${body}\nEOF\n`);
    vscode.window.showInformationMessage('GitSight: gh command copied.');
  } else {
    await vscode.env.clipboard.writeText(body);
    vscode.window.showInformationMessage('GitSight: reminder body copied.');
  }
}

async function postComment(git: Git, prNumber: number, body: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('gh', ['pr', 'comment', String(prNumber), '--body-file', '-'], {
        cwd: git.cwd,
        maxBuffer: 4 * 1024 * 1024,
      }, (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).split('\n')[0]));
        else resolve();
      });
      try {
        child.stdin?.write(body);
        child.stdin?.end();
      } catch (e) { reject(e); }
    });
    vscode.window.setStatusBarMessage(`GitSight: reminder posted to PR #${prNumber}`, 3000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr comment failed - ${e?.message ?? e}`);
  }
}

async function loadPrActivity(git: Git, prNumber: number, repoSlug?: string) {
  const args = ['pr', 'view', String(prNumber), '--json', 'reviewRequests,reviews,createdAt,updatedAt,isDraft'];
  if (repoSlug) args.push('--repo', repoSlug);
  try {
    const { stdout } = await pexec('gh', args, { cwd: git.cwd, maxBuffer: 4 * 1024 * 1024 });
    return parsePrActivity(stdout);
  } catch {
    return undefined;
  }
}

async function currentBranchPrNumber(git: Git): Promise<number | undefined> {
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'number'], {
      cwd: git.cwd,
      maxBuffer: 1 * 1024 * 1024,
    });
    const obj = JSON.parse(stdout);
    const n = Number(obj?.number ?? 0);
    return n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version']); return true; } catch { return false; }
}
