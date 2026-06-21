/**
 * .gitattributes Diagnostics (F42) — scans the working tree for files whose
 * declared attributes don't match their actual content:
 *
 *   - declared `text` (or `text=auto`) but contain NUL bytes
 *   - declared `binary` but look like plain text
 *   - declared `eol=lf` but have CRLF line endings
 *   - declared `eol=crlf` but have LF-only line endings
 *
 * Exposed as the command `gitsight.gitattributesDiagnostics`. The command
 * shells out to:
 *
 *   git ls-files -z --cached --modified --others --exclude-standard
 *   git check-attr -z --all <stdin paths>
 *
 * Then reads each candidate file's first 8 KB for the content sniffs (the
 * pure helpers in src/git/gitattributesDiag.ts handle the rest).
 *
 * Capped at 5000 tracked files for performance — repos larger than that
 * should use a one-off `git check-attr --all` script. Skips ignored and
 * un-attributed files (where every reported attr is 'unspecified').
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { Git } from '../git/git';
import {
  AttrDiagnostic,
  diagnoseFile,
  FileAttrs,
  formatReportMarkdown,
  parseCheckAttrZ,
  summariseDiagnostics,
} from '../git/gitattributesDiag';

const pexec = promisify(execFile);
const FILE_LIMIT = 5000;

export async function showGitattributesDiagnostics(git: Git): Promise<void> {
  const all = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'GitSight: scanning .gitattributes…',
  }, async progress => {
    progress.report({ message: 'listing tracked files…' });
    const paths = await listCandidatePaths(git);
    if (!paths.length) return [];
    if (paths.length > FILE_LIMIT) {
      vscode.window.showWarningMessage(
        `GitSight: ${paths.length} files in repo — scanning the first ${FILE_LIMIT} only.`,
      );
    }
    const slice = paths.slice(0, FILE_LIMIT);
    progress.report({ message: `check-attr for ${slice.length} files…` });
    const attrs = await checkAttrs(git, slice);
    progress.report({ message: 'sniffing file contents…' });
    return diagnoseAll(git.cwd, attrs);
  });

  if (!all.length) {
    vscode.window.showInformationMessage(`GitSight: ${summariseDiagnostics([])}`);
    return;
  }
  const md = formatReportMarkdown(all);
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);

  type Pk = vscode.QuickPickItem & { _diag: AttrDiagnostic };
  const items: Pk[] = all.map(d => ({
    label: `$(warning) ${d.code}`,
    description: d.path,
    detail: d.message.replace(/`/g, ''),
    _diag: d,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: summariseDiagnostics(all) + '  ·  pick one to open the offending file',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const uri = vscode.Uri.file(path.join(git.cwd, picked._diag.path));
  await vscode.commands.executeCommand('vscode.open', uri);
}

async function listCandidatePaths(git: Git): Promise<string[]> {
  // -z to be safe with weird filenames; tracked + modified + new (still under .gitignore-aware).
  const raw = await git.raw([
    'ls-files', '-z', '--cached', '--modified', '--others', '--exclude-standard',
  ]).catch(() => '');
  return raw.split('\0').map(s => s.trim()).filter(Boolean);
}

async function checkAttrs(git: Git, paths: string[]): Promise<FileAttrs[]> {
  if (!paths.length) return [];
  // Use spawn-style stdin for the path list — same pattern as F40.
  try {
    const { stdout } = await pexec('git', ['check-attr', '-z', '--all', '--stdin'], {
      cwd: git.cwd,
      maxBuffer: 200 * 1024 * 1024,
      input: paths.join('\0') + '\0',
    } as any);
    const parsed = parseCheckAttrZ(typeof stdout === 'string' ? stdout : (stdout as Buffer).toString('utf8'));
    // Drop entries where every attr is 'unspecified' (no .gitattributes opinion on this file).
    return parsed.filter(p => Object.values(p.attrs).some(v => v !== 'unspecified'));
  } catch {
    return [];
  }
}

function diagnoseAll(repoRoot: string, files: FileAttrs[]): AttrDiagnostic[] {
  const out: AttrDiagnostic[] = [];
  for (const f of files) {
    const abs = path.join(repoRoot, f.path);
    let content: Buffer;
    try {
      content = readHead(abs);
    } catch {
      continue;
    }
    out.push(...diagnoseFile({ attrs: f, content }));
  }
  return out;
}

/** Read the first 8 KB of a file synchronously. Returns empty buffer on failure. */
function readHead(abs: string): Buffer {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
