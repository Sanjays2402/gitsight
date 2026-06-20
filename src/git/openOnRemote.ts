/**
 * Open-on-Remote suite — translates local context into a host-aware web URL
 * and opens it in the default browser.
 *
 *  - openRepoOnRemote     → repo home (origin)
 *  - openBranchOnRemote   → tree view of a branch
 *  - openFileOnRemote     → blob view of the active file at HEAD (preserves
 *                           the current selection as a line / line range anchor)
 *
 * Honors GitHub, Azure DevOps, GitLab and Bitbucket via hostDetect.parseRemote().
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { HostInfo, parseRemote } from '../git/hostDetect';

async function originInfo(git: Git): Promise<HostInfo | undefined> {
  const remotes = await git.remotes();
  const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
  if (!origin) return undefined;
  return parseRemote(origin.fetchUrl) || parseRemote(origin.pushUrl);
}

async function open(uri: string) {
  await vscode.env.openExternal(vscode.Uri.parse(uri));
}

function noRemote() {
  vscode.window.showWarningMessage('GitSight: no recognizable remote (need github / azure-devops / gitlab / bitbucket origin).');
}

export async function openRepoOnRemote(git: Git) {
  const info = await originInfo(git);
  if (!info) return noRemote();
  await open(info.webBase);
}

/** Branch / ref tree URL. */
function branchTreeUrl(info: HostInfo, refName: string): string {
  const ref = encodeURIComponent(refName);
  switch (info.host) {
    case 'azure-devops':
      // dev.azure.com/.../_git/<repo>?version=GB<branch>
      return `${info.webBase}?version=GB${ref}`;
    case 'bitbucket':
      return `${info.webBase}/src/${ref}`;
    case 'gitlab':
      return `${info.webBase}/-/tree/${ref}`;
    case 'github':
    default:
      return `${info.webBase}/tree/${ref}`;
  }
}

/** File / blob URL. `sha` is the ref (branch or commit). `line` is 1-based. */
function fileBlobUrl(info: HostInfo, sha: string, relPath: string, line?: number, endLine?: number): string {
  const rel = relPath.split(path.sep).map(encodeURIComponent).join('/');
  switch (info.host) {
    case 'azure-devops': {
      // dev.azure.com/.../_git/<repo>?path=/foo/bar.ts&version=GC<sha>&line=10&lineEnd=20
      const params = new URLSearchParams();
      params.set('path', `/${rel}`);
      params.set('version', `GC${sha}`);
      if (line) {
        params.set('line', String(line));
        params.set('lineEnd', String(endLine ?? line));
        params.set('lineStartColumn', '1');
        params.set('lineEndColumn', '1');
      }
      return `${info.webBase}?${params.toString()}`;
    }
    case 'bitbucket': {
      let url = `${info.webBase}/src/${sha}/${rel}`;
      if (line) url += `#lines-${line}${endLine && endLine !== line ? `:${endLine}` : ''}`;
      return url;
    }
    case 'gitlab': {
      let url = `${info.webBase}/-/blob/${sha}/${rel}`;
      if (line) url += `#L${line}${endLine && endLine !== line ? `-${endLine}` : ''}`;
      return url;
    }
    case 'github':
    default: {
      let url = `${info.webBase}/blob/${sha}/${rel}`;
      if (line) url += `#L${line}${endLine && endLine !== line ? `-L${endLine}` : ''}`;
      return url;
    }
  }
}

export async function openBranchOnRemote(git: Git, branchName?: string) {
  const info = await originInfo(git);
  if (!info) return noRemote();
  let ref = branchName;
  if (!ref) {
    const branches = await git.branches(true);
    const picked = await vscode.window.showQuickPick(
      branches.map(b => ({ label: b.name, description: b.current ? '(current)' : b.remote ? '(remote)' : '' })),
      { placeHolder: 'Pick a branch to open on remote' },
    );
    if (!picked) return;
    ref = picked.label;
  }
  // Strip remote prefix; the web view wants the bare branch name.
  ref = ref.replace(/^[^/]+\//, '');
  await open(branchTreeUrl(info, ref));
}

export async function openFileOnRemote(git: Git, atRef?: string) {
  const info = await originInfo(git);
  if (!info) return noRemote();
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('GitSight: open a file first.'); return; }
  const file = editor.document.uri.fsPath;
  const rel = path.relative(git.cwd, file);
  if (rel.startsWith('..')) { vscode.window.showWarningMessage('GitSight: active file is outside the repository.'); return; }

  // Use HEAD sha by default so the link stays stable. The user can opt for
  // current branch via the explicit branch-name commands.
  let ref = atRef;
  if (!ref) {
    try { ref = (await git.headSha()).trim(); }
    catch { ref = (await git.currentBranch()).trim() || 'HEAD'; }
  }

  const sel = editor.selection;
  const line = sel.start.line + 1;
  const endLine = sel.end.line + 1;
  await open(fileBlobUrl(info, ref, rel, line, endLine === line ? undefined : endLine));
}
