import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const pexec = promisify(execFile);

/**
 * Virtual filesystem: gitsight://<repo>/<sha>/<path>
 * Lets users open any file at any commit as a real read-only editor tab,
 * with diffs, peek-definitions, and all language features working.
 */
export class GitVirtualFs implements vscode.FileSystemProvider {
  static SCHEME = 'gitsight';

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this._emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Read-only virtual fs'); }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { repo, sha, file } = parseUri(uri);
    try {
      const { stdout } = await pexec('git', ['show', `${sha}:${file}`], { cwd: repo, maxBuffer: 200 * 1024 * 1024, encoding: 'buffer' as any });
      return new Uint8Array(stdout as any);
    } catch (e: any) {
      throw vscode.FileSystemError.FileNotFound(`${sha}:${file} not found in ${repo}`);
    }
  }

  writeFile(): void { throw vscode.FileSystemError.NoPermissions('Historic files are read-only'); }
  delete(): void { throw vscode.FileSystemError.NoPermissions('Read-only virtual fs'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Read-only virtual fs'); }
}

export function uriFor(repo: string, sha: string, file: string): vscode.Uri {
  const encodedRepo = encodeURIComponent(repo);
  return vscode.Uri.parse(`${GitVirtualFs.SCHEME}:/${encodedRepo}/${sha}/${file}`);
}

function parseUri(uri: vscode.Uri): { repo: string; sha: string; file: string } {
  const parts = uri.path.replace(/^\//, '').split('/');
  const repo = decodeURIComponent(parts[0]);
  const sha = parts[1];
  const file = parts.slice(2).join('/');
  return { repo, sha, file };
}

/** Open a single historic file in an editor tab. */
export async function openHistoricFile(repo: string, sha: string, file: string) {
  const uri = uriFor(repo, sha, file);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Diff two revisions of a file side-by-side. */
export async function diffRevisions(repo: string, file: string, fromSha: string, toSha: string) {
  const left = uriFor(repo, fromSha, file);
  const right = toSha === 'WORKING' ? vscode.Uri.file(`${repo}/${file}`) : uriFor(repo, toSha, file);
  const name = file.split('/').pop();
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${fromSha.slice(0, 7)} ↔ ${toSha === 'WORKING' ? 'Working' : toSha.slice(0, 7)})`);
}
