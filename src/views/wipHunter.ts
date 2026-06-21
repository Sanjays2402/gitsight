/**
 * WIP Commit Hunter (F37) — surfaces WIP/fixup!/squash!/amend!/tmp/do-not-merge
 * commits on the current branch's pending range, then offers one-click cleanup:
 *
 *   - "Autosquash with rebase -i <upstream>" (when any fixup!/squash!/amend!
 *     exist; runs `git rebase -i --autosquash` with GIT_SEQUENCE_EDITOR=':' so
 *     the user doesn't have to dance through the editor).
 *   - "Copy SHA list" / "Open interactive rebase from this commit" per-row
 *     actions for the WIP/tmp/do-not-merge classes that aren't autosquashable.
 *
 * Range: defaults to `@{u}..HEAD`. Falls back to last 200 commits on HEAD if
 * the branch has no upstream — better to scan something than to bail. The
 * scan window is bounded; this is a glance, not a forensic tool.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  parseLog,
  findWipCommits,
  summariseWip,
  describeWip,
  pickerLabel,
  WipCommit,
} from '../git/wipCommits';

const FMT = '%H|%h|%an|%aI|%s';

type WipPickItem = vscode.QuickPickItem & { _commit?: WipCommit; _action?: 'autosquash' | 'copy-shas' | 'open-rebase-here' | 'show-log' };

export async function showWipHunter(git: Git) {
  const head = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const range = await resolveRange(git);
  const raw = await safe(git, ['log', `--pretty=format:${FMT}`, ...range.args]);
  const commits = parseLog(raw);
  const wip = findWipCommits(commits);
  const summary = summariseWip(wip);

  if (!wip.length) {
    vscode.window.showInformationMessage(
      `GitSight: no WIP commits in ${range.label} on ${head}. Branch is presentable.`,
    );
    return;
  }

  const items: WipPickItem[] = [];
  items.push(sep(`${describeWip(summary)} on ${head} (${range.label})`));
  if (summary.hasAutosquashable) {
    items.push({
      label: '$(combine) Autosquash now (rebase -i --autosquash)',
      description: `${summary.byKind.fixup + summary.byKind.squash + summary.byKind.amend} autosquashable commits`,
      _action: 'autosquash',
    });
  }
  items.push(
    { label: '$(clippy) Copy SHA list',                   description: `${wip.length} commits`,             _action: 'copy-shas' },
    { label: '$(history) Show shortlog of WIP commits',   description: 'Open in a scratch doc',             _action: 'show-log' },
  );
  items.push(sep('Commits (pick one to open an interactive rebase from its parent)'));
  for (const c of wip) {
    items.push({
      label: `$(git-commit) ${c.shortSha}  ${pickerLabel(c)}`,
      description: c.author,
      detail: relIsoLocal(c.dateIso),
      _commit: c,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `WIP hunter — ${describeWip(summary)}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked._commit) {
    return openRebaseHere(git, picked._commit);
  }

  switch (picked._action) {
    case 'autosquash':
      return runAutosquash(git, range);
    case 'copy-shas': {
      await vscode.env.clipboard.writeText(wip.map(c => c.sha).join('\n'));
      vscode.window.setStatusBarMessage(`Copied ${wip.length} SHAs`, 2000);
      return;
    }
    case 'show-log': {
      const body = [
        `# WIP commits on ${head} (${range.label})`,
        '',
        ...wip.map(c => `${c.shortSha}  ${pickerLabel(c)}  (${c.author})  ${relIsoLocal(c.dateIso)}`),
      ].join('\n');
      const doc = await vscode.workspace.openTextDocument({ content: body, language: 'log' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
  }
}

interface ResolvedRange {
  label: string;
  /** Args to splice into `git log`. */
  args: string[];
}

async function resolveRange(git: Git): Promise<ResolvedRange> {
  const upstream = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (upstream) return { label: `${upstream}..HEAD`, args: [`${upstream}..HEAD`] };
  return { label: 'last 200 commits', args: ['--max-count=200', 'HEAD'] };
}

async function runAutosquash(git: Git, range: ResolvedRange) {
  const ok = await vscode.window.showWarningMessage(
    `Run autosquash on ${range.label}?\n\nThis runs: git rebase -i --autosquash ${rangeBaseForRebase(range)}`,
    { modal: true },
    'Autosquash',
  );
  if (ok !== 'Autosquash') return;
  // Use the non-interactive editor so the rebase plan is accepted as-is.
  // --autosquash arranges fixup!/squash! lines next to their targets and
  // assigns the right action; with `:` as the editor we just say yes.
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const pexec = promisify(execFile);
    await pexec(
      'git',
      ['rebase', '-i', '--autosquash', rangeBaseForRebase(range)],
      {
        cwd: git.cwd,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' },
        maxBuffer: 100 * 1024 * 1024,
      },
    );
    vscode.window.showInformationMessage('GitSight: autosquash complete. Review your branch before pushing.');
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(
      `GitSight: autosquash failed (${(e.stderr || e.message || '').toString().trim().split('\n')[0]}).\n` +
      `Run \`git rebase --abort\` if a rebase is now in progress.`,
    );
  }
}

function rangeBaseForRebase(range: ResolvedRange): string {
  // For `<upstream>..HEAD` we rebase onto the upstream; for the fallback we
  // rebase onto HEAD~200 (capped at root by git itself).
  if (range.label.endsWith('..HEAD') && range.args.length === 1) {
    return range.args[0].replace(/\.\.HEAD$/, '');
  }
  return 'HEAD~200';
}

async function openRebaseHere(git: Git, c: WipCommit) {
  // Offer to start an interactive rebase from this commit's parent so the
  // user can edit/drop/fix it manually. We do NOT auto-execute the rebase
  // since they explicitly chose a non-autosquash row.
  const ok = await vscode.window.showInformationMessage(
    `Start interactive rebase from ${c.shortSha}^ ?`,
    { modal: false },
    'Run rebase -i', 'Copy command',
  );
  if (!ok) return;
  if (ok === 'Copy command') {
    await vscode.env.clipboard.writeText(`git rebase -i ${c.shortSha}^`);
    vscode.window.setStatusBarMessage('Copied rebase command', 2000);
    return;
  }
  const term = vscode.window.createTerminal({ name: 'GitSight: interactive rebase', cwd: git.cwd });
  term.show();
  term.sendText(`git rebase -i ${c.shortSha}^`);
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function sep(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function relIsoLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
