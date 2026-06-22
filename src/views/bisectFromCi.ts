/**
 * F76 — Bisect-from-CI-Failure view.
 *
 * Picks the most recent failing GitHub Actions run on the current branch
 * (via `gh run list`), drills into it (`gh run view --json`), and:
 *
 *   1. Locates the first failing step.
 *   2. Heuristically infers a local recovery command from the step name.
 *   3. Builds a `git bisect run` wrapper script that re-runs that command
 *      against each candidate commit.
 *   4. Writes the script to a temp file + opens a preview in a scratch doc.
 *   5. Offers to drop the user into a terminal pre-baked with the
 *      `git bisect start <bad>..<good>` + `git bisect run <script>` flow.
 *
 * No automatic destructive operations — the bisect is something the user
 * launches manually after reviewing the inferred command.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import {
  parseGhRunView,
  planBisectFromRun,
  GhRunView,
} from '../git/bisectFromCi';

const pexec = promisify(execFile);

export async function showBisectFromCiFailure(git: Git): Promise<void> {
  const ghOk = await ghAvailable();
  if (!ghOk) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found on PATH. Install GitHub CLI to bisect from CI failures.');
    return;
  }

  const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  const runId = await pickFailingRun(git, branch);
  if (!runId) return;

  // Pull the failing run with jobs + step status.
  let runJson: string;
  try {
    const { stdout } = await pexec(
      'gh',
      ['run', 'view', String(runId), '--json', 'workflowName,headSha,status,conclusion,jobs,url'],
      { cwd: git.cwd, maxBuffer: 20 * 1024 * 1024 },
    );
    runJson = stdout;
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh run view failed: ${(e?.stderr || e?.message || e).toString().split('\n')[0]}`);
    return;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(runJson); }
  catch { vscode.window.showErrorMessage('GitSight: could not parse gh run view JSON.'); return; }

  const run: GhRunView | undefined = parseGhRunView(parsed);
  if (!run) {
    vscode.window.showErrorMessage('GitSight: gh run view returned an unexpected shape.');
    return;
  }

  const plan = planBisectFromRun(run);
  if (!plan) {
    vscode.window.showInformationMessage(`GitSight: no failing job/step found in run #${runId}.`);
    return;
  }

  // Persist the script + open a preview.
  const tmpDir = path.join(os.tmpdir(), 'gitsight-bisect');
  await fs.mkdir(tmpDir, { recursive: true });
  const scriptPath = path.join(tmpDir, plan.scriptFileName);
  await fs.writeFile(scriptPath, plan.script, { mode: 0o755 });
  await fs.chmod(scriptPath, 0o755).catch(() => {});

  const preview =
    `# GitSight: bisect plan for ${run.workflowName ?? 'workflow'} @ ${(run.headSha ?? 'HEAD').slice(0, 7)}\n\n` +
    `**Failing job**: \`${plan.failing.jobName}\`  \n` +
    `**Failing step**: \`${plan.failing.stepName}\`  \n` +
    `**Inferred command** (${plan.inferred.confident ? 'confident' : 'placeholder — edit before running'}):\n\n` +
    `\`\`\`sh\n${plan.inferred.command}\n\`\`\`\n\n` +
    `**Script path**: \`${scriptPath}\`\n\n` +
    `## Script\n\n\`\`\`sh\n${plan.script}\`\`\`\n\n` +
    `## Next step\n\n` +
    `Confirm the GOOD commit (the last one that passed CI) and the BAD commit (HEAD by default).\n` +
    `Then run:\n\n` +
    `\`\`\`sh\n` +
    `git bisect start ${'$BAD'} ${'$GOOD'}\n` +
    `git bisect run ${scriptPath}\n` +
    `git bisect reset\n` +
    `\`\`\`\n`;

  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: preview });
  await vscode.window.showTextDocument(doc, { preview: true });

  const goodInput = await vscode.window.showInputBox({
    prompt: `Good commit (a SHA / ref that PASSED CI). Press Enter to use HEAD~10 as a starting guess.`,
    value: 'HEAD~10',
    validateInput: v => v.trim() ? undefined : 'Required',
  });
  if (!goodInput) return;
  const badInput = await vscode.window.showInputBox({
    prompt: 'Bad commit (where the failure reproduces). Press Enter to use HEAD.',
    value: 'HEAD',
    validateInput: v => v.trim() ? undefined : 'Required',
  });
  if (!badInput) return;

  const action = await vscode.window.showInformationMessage(
    `GitSight: open a terminal with the bisect ready to run?`,
    'Open terminal', 'Cancel',
  );
  if (action !== 'Open terminal') return;

  const term = vscode.window.createTerminal({ name: `GitSight: bisect ${runId}`, cwd: git.cwd });
  term.show();
  term.sendText(`git bisect start ${badInput.trim()} ${goodInput.trim()}`);
  term.sendText(`git bisect run ${scriptPath}`);
}

async function pickFailingRun(git: Git, branch: string): Promise<number | undefined> {
  try {
    const { stdout } = await pexec(
      'gh',
      [
        'run', 'list',
        '--branch', branch,
        '--status', 'failure',
        '--limit', '10',
        '--json', 'databaseId,name,workflowName,conclusion,headSha,startedAt,event,url',
      ],
      { cwd: git.cwd, maxBuffer: 20 * 1024 * 1024 },
    );
    const runs = JSON.parse(stdout) as Array<{
      databaseId: number; name: string; workflowName: string; conclusion: string;
      headSha: string; startedAt: string; event: string; url: string;
    }>;
    if (!runs.length) {
      vscode.window.showInformationMessage(
        `GitSight: no failing GitHub Actions runs on ${branch}. Bisect-from-CI needs a failing run to seed from.`,
      );
      return undefined;
    }
    type Item = vscode.QuickPickItem & { _id: number };
    const items: Item[] = runs.map(r => ({
      label: `$(error) ${r.workflowName || r.name || 'workflow'}`,
      description: `${r.headSha.slice(0, 7)} \u00b7 ${r.event}`,
      detail: `Run #${r.databaseId} \u00b7 started ${r.startedAt}`,
      _id: r.databaseId,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Pick a failing run on ${branch} to seed the bisect`,
      placeHolder: `${runs.length} failing run(s) found via gh run list`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?._id;
  } catch (e: any) {
    vscode.window.showErrorMessage(
      `GitSight: gh run list failed: ${(e?.stderr || e?.message || e).toString().split('\n')[0]}`,
    );
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { maxBuffer: 1024 * 1024 }); return true; }
  catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
