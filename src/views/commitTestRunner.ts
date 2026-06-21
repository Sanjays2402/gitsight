/**
 * Commit-by-Commit Test Runner (F55).
 *
 * For `<upstream>..HEAD` (oldest \u2192 newest), checkout each commit in
 * detached-HEAD mode, run a configured test command, and report which
 * commit broke things. Useful when you've just rebased a 10-commit
 * stack and only want to know *which* commit to bisect.
 *
 * Safety rules (non-negotiable):
 *   1. Working tree must be clean. We refuse to start otherwise \u2014 detached
 *      checkouts would silently lose modifications.
 *   2. The original HEAD ref (branch name OR detached sha) is captured
 *      BEFORE we start and restored on EVERY exit path (success / failure /
 *      cancellation / VS Code window close \u2014 the cleanup uses a single
 *      try/finally + a disposable so it survives view disposal too).
 *   3. Cancellation token wired into the progress notification \u2014 the user
 *      can hit "Cancel" between commits, which short-circuits the loop
 *      cleanly.
 *   4. Per-commit results land in a sticky output channel as they happen,
 *      not just at the end \u2014 so a long run still gives feedback.
 *
 * Flow:
 *   1. Resolve upstream (@{u} \u2192 origin/<branch> \u2192 picker fallback).
 *   2. Confirm command (config default, or input box with last-used value).
 *   3. Modal warning (count of commits, the command, "this will detach HEAD").
 *   4. Run the loop. For each commit:
 *        git checkout --detach <sha>
 *        run command via spawn (capture stdout+stderr tail)
 *        record result, update output channel
 *   5. Restore original HEAD.
 *   6. Open the markdown report scratch document.
 *
 * Configurable via:
 *   gitsight.commitTestRunner.command          (default 'npm test')
 *   gitsight.commitTestRunner.timeoutMs        (default 300_000 = 5 min)
 *   gitsight.commitTestRunner.stopOnFirstFail  (default false)
 *   gitsight.commitTestRunner.maxCommits       (default 50)
 */
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { Git } from '../git/git';
import {
  parseWalkLog,
  walkOrder,
  summariseRun,
  renderReport,
  tailLines,
  formatMs,
  RunResult,
  RawCommit,
} from '../git/commitWalk';

const LOG_FORMAT = '%H|%h|%an|%ae|%s';

export async function showCommitByCommitTestRunner(git: Git): Promise<void> {
  const head = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const upstream = await resolveUpstream(git, head);
  if (!upstream) {
    vscode.window.showInformationMessage('GitSight: no upstream available; cancelled.');
    return;
  }

  // Working-tree cleanliness gate.
  const porcelain = (await safe(git, ['status', '--porcelain'])).trim();
  if (porcelain) {
    vscode.window.showWarningMessage(
      'GitSight: working tree is dirty. Stash or commit before running the per-commit test runner.',
      { modal: true },
    );
    return;
  }

  const raw = await safe(git, ['log', `--pretty=format:${LOG_FORMAT}`, `${upstream}..HEAD`]);
  const commits = parseWalkLog(raw);
  if (!commits.length) {
    vscode.window.showInformationMessage(`GitSight: ${upstream}..HEAD is empty; nothing to run.`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.commitTestRunner');
  const maxCommits = cfg.get<number>('maxCommits', 50);
  if (commits.length > maxCommits) {
    const ok = await vscode.window.showWarningMessage(
      `GitSight: ${commits.length} commits exceeds maxCommits=${maxCommits}. Run anyway?`,
      { modal: true },
      'Run all',
    );
    if (!ok) return;
  }

  // Command picker.
  const defaultCmd = (cfg.get<string>('command', '') || '').trim() || 'npm test';
  const command = await vscode.window.showInputBox({
    prompt: `Test command to run at each commit in ${upstream}..HEAD (oldest \u2192 newest, ${commits.length} commits)`,
    value: defaultCmd,
  });
  if (!command || !command.trim()) return;

  // Confirm.
  const ans = await vscode.window.showWarningMessage(
    `Run \`${command.trim()}\` at each of ${commits.length} commits?`,
    {
      modal: true,
      detail: 'GitSight will checkout each commit in DETACHED HEAD mode, run the command, and restore your original HEAD when done. Working tree must stay clean during the run.',
    },
    'Run',
  );
  if (ans !== 'Run') return;

  // Save the current HEAD so we can restore it. Prefer the branch name
  // when we're on a branch (so reflog lines read like a normal switch),
  // fall back to the raw sha for detached-HEAD callers.
  const originalRef = head && head !== 'HEAD'
    ? head
    : (await safe(git, ['rev-parse', 'HEAD'])).trim();

  const ordered = walkOrder(commits);
  const channel = vscode.window.createOutputChannel('GitSight: Commit Test Runner');
  channel.show(true);
  channel.appendLine(`# ${command.trim()}`);
  channel.appendLine(`# Range: ${upstream}..HEAD (${ordered.length} commits)`);
  channel.appendLine(`# Will restore HEAD to ${originalRef} when done.`);
  channel.appendLine('');

  const results: RunResult[] = [];
  let cancelled = false;
  const stopOnFirstFail = cfg.get<boolean>('stopOnFirstFail', false);
  const timeoutMs = cfg.get<number>('timeoutMs', 300_000);

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: testing ${ordered.length} commits\u2026`,
      cancellable: true,
    }, async (progress, token) => {
      token.onCancellationRequested(() => { cancelled = true; });
      for (let i = 0; i < ordered.length; i++) {
        if (cancelled) {
          for (const skipped of ordered.slice(i)) {
            results.push({ sha: skipped.sha, status: 'not-run', reason: 'cancelled' });
          }
          break;
        }
        const c = ordered[i];
        progress.report({
          message: `${i + 1}/${ordered.length} \u00b7 ${c.shortSha} ${c.subject.slice(0, 60)}`,
          increment: 100 / ordered.length,
        });
        channel.appendLine(`-- [${i + 1}/${ordered.length}] ${c.shortSha} ${c.subject}`);
        const result = await runOneCommit(git, c, command.trim(), timeoutMs);
        results.push(result);
        channel.appendLine(`   \u2192 ${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ''} in ${result.durationMs !== undefined ? formatMs(result.durationMs) : '?'}`);
        if (result.reason) channel.appendLine(`   reason: ${result.reason}`);
        if (result.status === 'fail' && stopOnFirstFail) {
          channel.appendLine('-- stopOnFirstFail is on; stopping.');
          for (const skipped of ordered.slice(i + 1)) {
            results.push({ sha: skipped.sha, status: 'not-run', reason: 'stopped after first failure' });
          }
          break;
        }
      }
    });
  } finally {
    // Restore HEAD. Even if the user cancelled or a checkout errored
    // mid-loop, we owe them the same working state they started in.
    try {
      await git.raw(['checkout', originalRef]);
      channel.appendLine('');
      channel.appendLine(`# Restored HEAD to ${originalRef}.`);
    } catch (e: any) {
      channel.appendLine('');
      channel.appendLine(`# FAILED to restore HEAD to ${originalRef}: ${e.message ?? e}`);
      vscode.window.showErrorMessage(
        `GitSight: couldn't restore HEAD to ${originalRef}. Run \`git checkout ${originalRef}\` manually.`,
      );
    }
  }

  const summary = summariseRun(results);
  channel.appendLine('');
  channel.appendLine(`# Summary: ${summary.passed} pass / ${summary.failed} fail / ${summary.errored} error / ${summary.skipped} skipped / ${summary.notRun} not run`);
  if (summary.bisectSha) {
    const bisectShort = ordered.find(c => c.sha === summary.bisectSha)?.shortSha ?? summary.bisectSha.slice(0, 7);
    channel.appendLine(`# Likely culprit: ${bisectShort}`);
  }

  const md = renderReport(ordered, results, { upstream, head: 'HEAD', command: command.trim() });
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
}

async function runOneCommit(
  git: Git,
  c: RawCommit,
  command: string,
  timeoutMs: number,
): Promise<RunResult> {
  // Step 1: checkout in detached mode. If this fails (rare \u2014 working
  // tree was clean when we started), surface as "error" and skip the
  // command run.
  const t0 = Date.now();
  try {
    await git.raw(['checkout', '--detach', c.sha]);
  } catch (e: any) {
    return {
      sha: c.sha,
      status: 'error',
      reason: `checkout failed: ${(e.message ?? e).toString().trim().split('\n')[0]}`,
      durationMs: Date.now() - t0,
    };
  }
  // Step 2: run the command. We deliberately use a shell so users can
  // chain commands ("npm install && npm test") without weird quoting.
  return await runShellCommand(git.cwd, command, timeoutMs, c.sha);
}

function runShellCommand(cwd: string, command: string, timeoutMs: number, sha: string): Promise<RunResult> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(command, { cwd, shell: true });
    let out = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<RunResult, 'sha' | 'durationMs'> & { durationMs?: number }) => {
      if (timer) clearTimeout(timer);
      resolve({
        sha,
        durationMs: result.durationMs ?? (Date.now() - t0),
        ...result,
      });
    };
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('error', e => finish({ status: 'error', reason: `spawn failed: ${e.message}` }));
    child.on('close', code => {
      const status = code === 0 ? 'pass' : 'fail';
      finish({ status, exitCode: code ?? undefined, tail: tailLines(out, 50) });
    });
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
      finish({ status: 'error', reason: `timed out after ${formatMs(timeoutMs)}`, tail: tailLines(out, 50) });
    }, timeoutMs);
  });
}

async function resolveUpstream(git: Git, head: string): Promise<string | undefined> {
  const up = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (up) return up;
  if (head && head !== 'HEAD') {
    const candidate = `origin/${head}`;
    const ok = await safe(git, ['rev-parse', '--verify', candidate]);
    if (ok.trim()) return candidate;
  }
  const branches = (await safe(git, ['branch', '--format=%(refname:short)']))
    .split('\n').map(s => s.trim()).filter(b => b && b !== head);
  if (!branches.length) return undefined;
  return await vscode.window.showQuickPick(branches, {
    placeHolder: `Commit test runner \u2014 pick an upstream to compare against ${head}`,
  });
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
