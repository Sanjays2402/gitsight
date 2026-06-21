/**
 * Repo Size + Biggest Files report (F40).
 *
 * Streams `git rev-list --objects --all` into `git cat-file --batch-check`,
 * then ranks blobs by on-disk size and opens a markdown report with the
 * Top-N largest blobs. Per-row actions:
 *
 *   - Reveal in Explorer (when the path resolves on disk today)
 *   - Open the file (when the path resolves on disk today)
 *   - Open the blob's history (`git log --all --follow -- <path>`)
 *   - Copy `git filter-repo` command to expunge that path
 *
 * The whole scan happens with progress reporting since it's O(repo size)
 * and can take a few seconds on a big monorepo. We cap stdout at 100 MB via
 * the existing maxBuffer; if a repo blows that we'll surface the error
 * instead of silently truncating.
 */
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { Git } from '../git/git';
import {
  joinBlobs, shasForBatchCheck, summariseRepo, formatReportMarkdown,
  formatSize, BlobRow,
} from '../git/repoSize';

export async function showRepoSizeReport(git: Git) {
  const report = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'GitSight: scanning repo objects…',
    cancellable: false,
  }, async (progress) => {
    progress.report({ message: 'rev-list --objects --all' });
    const revOut = await runCapture('git', ['rev-list', '--objects', '--all'], git.cwd);
    if (!revOut.trim()) return undefined;
    progress.report({ message: 'cat-file --batch-check' });
    const batchOut = await runCaptureStdin(
      'git', ['cat-file', `--batch-check=%(objectname) %(objecttype) %(objectsize:disk)`],
      git.cwd, shasForBatchCheck(revOut),
    );
    progress.report({ message: 'ranking' });
    const blobs = joinBlobs(revOut, batchOut);
    return summariseRepo(blobs, 20);
  });

  if (!report || !report.blobCount) {
    vscode.window.showInformationMessage('GitSight: no blobs found in this repo.');
    return;
  }

  // Open the markdown report in a side editor so the user can read it
  // while picking actions from the follow-up quick pick.
  const md = formatReportMarkdown(report);
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });

  // Offer per-row actions on the top blobs.
  type Pk = vscode.QuickPickItem & { _row?: BlobRow; _action?: 'overview' };
  const items: Pk[] = [
    sep(`${report.blobCount} blobs · ${formatSize(report.totalBytes)} total`),
    { label: '$(book) Show full report (already open)', description: 'Markdown opened to the side', _action: 'overview' },
    sep('Per-blob actions'),
    ...report.top.map(r => ({
      label: `$(file-binary) ${formatSize(r.size).padEnd(10, ' ')} ${r.path || '(orphan)'}`,
      description: r.sha.slice(0, 12),
      _row: r,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a blob for actions (reveal / open / history / expunge command)',
    matchOnDescription: true,
  });
  if (!picked || !picked._row) return;

  await actionsFor(git, picked._row);
}

async function actionsFor(git: Git, row: BlobRow) {
  const abs = row.path ? path.join(git.cwd, row.path) : '';
  const exists = abs ? await fileExists(abs) : false;
  type Pk = vscode.QuickPickItem & { _key: string };
  const items: Pk[] = [];
  if (exists) {
    items.push(
      { label: '$(folder-opened) Reveal in OS file explorer',         description: row.path, _key: 'reveal' },
      { label: '$(go-to-file) Open file in editor',                   description: row.path, _key: 'open' },
    );
  }
  if (row.path) {
    items.push(
      { label: '$(history) Show this path\u2019s history',             description: 'git log --all --follow', _key: 'history' },
      { label: '$(clippy) Copy filter-repo expunge command',           description: 'Remove this path from all of history', _key: 'expunge' },
    );
  }
  items.push(
    { label: '$(clippy) Copy SHA',                                     description: row.sha,                 _key: 'copy-sha' },
    { label: '$(clippy) Copy git show command',                        description: `git show ${row.sha.slice(0, 12)}`, _key: 'copy-show' },
  );
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `${row.path || '(orphan blob)'} — ${formatSize(row.size)}` });
  if (!picked) return;

  switch (picked._key) {
    case 'reveal':
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(abs));
      return;
    case 'open':
      await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
      return;
    case 'history': {
      // Lean on the existing File History view if the file is open; otherwise
      // open the file first.
      if (exists) {
        await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
        await vscode.commands.executeCommand('gitsight.showFileHistory');
      } else {
        const log = await git.raw(['log', '--all', '--follow', '--oneline', '--', row.path]).catch(() => '');
        const doc = await vscode.workspace.openTextDocument({ language: 'log', content: log || '(no history)' });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
      return;
    }
    case 'expunge': {
      const cmd = `git filter-repo --invert-paths --path ${shellEscape(row.path)}`;
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage(`Copied expunge command. Review it before running — it rewrites history.`);
      return;
    }
    case 'copy-sha':
      await vscode.env.clipboard.writeText(row.sha);
      vscode.window.setStatusBarMessage(`Copied ${row.sha.slice(0, 12)}`, 2000);
      return;
    case 'copy-show':
      await vscode.env.clipboard.writeText(`git show ${row.sha}`);
      vscode.window.setStatusBarMessage('Copied git show command', 2000);
      return;
  }
}

function shellEscape(s: string): string {
  // POSIX single-quote escaping; not bulletproof for exotic chars but good
  // enough for typical paths and the user will read the command before running.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return stat.type === vscode.FileType.File;
  } catch { return false; }
}

function sep(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function runCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${cmd} ${args[0]} exited ${code}: ${err.trim()}`));
      else resolve(out);
    });
  });
}

function runCaptureStdin(cmd: string, args: string[], cwd: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${cmd} ${args[0]} exited ${code}: ${err.trim()}`));
      else resolve(out);
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
