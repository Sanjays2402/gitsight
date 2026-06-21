/**
 * Open in GitHub Codespaces (F56) — for repos with a github.com remote,
 * surface a command + branch-tree action that crafts a "create a
 * codespace" URL and opens it in the browser.
 *
 * Flow:
 *   1. Resolve the origin URL via `git remote get-url origin`.
 *      If it's not a GitHub remote, refuse politely.
 *   2. Decide which ref to launch with (priority order):
 *      - explicit argument (when invoked from the branches tree)
 *      - the user's chosen default via picker (current / main / pick)
 *      - the current branch
 *   3. Auto-detect devcontainer.json — if there are 2+, ask which.
 *   4. Layer in any pinned machine / location from config.
 *   5. Build the URL (pure helper), open it, status-bar a copyable line.
 *
 * Configurable via:
 *   gitsight.codespaces.machine           pinned machine SKU id
 *   gitsight.codespaces.location          pinned region preference
 *   gitsight.codespaces.devcontainerPath  pinned devcontainer path
 *
 * Each pinned value triggers the `?machine=&location=&devcontainer_path=`
 * "advanced create" URL form so GitHub honours the override.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import {
  parseGitHubRemote,
  buildCodespacesUrl,
  buildManageCodespacesUrl,
  describeCodespaceTarget,
  GhRepoRef,
} from '../git/codespaces';

export async function openInCodespaces(git: Git, arg?: any): Promise<void> {
  const remoteUrl = await safe(git, ['remote', 'get-url', 'origin']);
  const repo = parseGitHubRemote(remoteUrl.trim());
  if (!repo) {
    vscode.window.showWarningMessage(
      'GitSight: Codespaces only launches from github.com remotes. Add a github.com remote first.',
    );
    return;
  }

  // Pick the ref. If invoked from the branches tree, the arg has a branch.
  let ref: string | undefined;
  const argName: string | undefined = arg?.branch?.name ?? arg?.name;
  if (typeof argName === 'string' && argName) {
    ref = argName.replace(/^origin\//, '');
  } else {
    ref = await pickRef(git);
    if (ref === undefined) return;
  }

  // Auto-detect devcontainer.
  const cfg = vscode.workspace.getConfiguration('gitsight.codespaces');
  const pinnedDevcontainer = cfg.get<string>('devcontainerPath', '').trim();
  let devcontainerPath = pinnedDevcontainer || undefined;
  if (!devcontainerPath) {
    const detected = await detectDevcontainers(git.cwd);
    if (detected.length === 1) {
      devcontainerPath = detected[0];
    } else if (detected.length > 1) {
      const picked = await vscode.window.showQuickPick(
        [{ label: '$(question) Use repo default (no override)', value: undefined as string | undefined }]
          .concat(detected.map(p => ({ label: `$(file) ${p}`, value: p as string | undefined }))),
        { placeHolder: 'Codespaces — which devcontainer.json?' },
      );
      if (!picked) return;
      devcontainerPath = picked.value ?? undefined;
    }
  }

  const target: GhRepoRef = {
    owner: repo.owner,
    name: repo.name,
    ref: ref || undefined,
    devcontainerPath,
    machine: cfg.get<string>('machine', '').trim() || undefined,
    location: cfg.get<string>('location', '').trim() || undefined,
  };

  const url = buildCodespacesUrl(target);
  const ans = await vscode.window.showInformationMessage(
    `GitSight: launch a Codespace for ${repo.owner}/${repo.name}?`,
    { detail: describeCodespaceTarget(target), modal: false },
    'Open in browser',
    'Copy URL',
    'Manage existing',
  );
  if (!ans) return;
  if (ans === 'Open in browser') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  if (ans === 'Copy URL') {
    await vscode.env.clipboard.writeText(url);
    vscode.window.setStatusBarMessage('Codespaces URL copied', 3000);
    return;
  }
  if (ans === 'Manage existing') {
    await vscode.env.openExternal(vscode.Uri.parse(buildManageCodespacesUrl(repo)));
    return;
  }
}

async function pickRef(git: Git): Promise<string | undefined> {
  const cur = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const branches = (await safe(git, ['branch', '--format=%(refname:short)']))
    .split('\n').map(s => s.trim()).filter(Boolean);
  type Pk = vscode.QuickPickItem & { _ref?: string };
  const items: Pk[] = [];
  if (cur && cur !== 'HEAD') items.push({
    label: `$(git-branch) ${cur}`, description: 'current branch', _ref: cur,
  });
  if (!branches.includes('main') && !branches.includes('master')) {
    items.push({ label: '$(rocket) (repo default branch)', description: 'no ref pinned', _ref: '' });
  } else {
    items.push({ label: '$(rocket) (repo default branch)', description: 'no ref pinned', _ref: '' });
  }
  for (const b of branches) {
    if (b === cur) continue;
    items.push({ label: `$(git-branch) ${b}`, _ref: b });
  }
  items.push({ label: '$(edit) Type a ref\u2026', _ref: undefined });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Codespaces — which branch / ref?',
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked._ref === undefined) {
    return await vscode.window.showInputBox({ prompt: 'Ref to launch from', value: cur || 'main' });
  }
  return picked._ref;
}

/**
 * Scan for devcontainer.json files relative to the repo root. The GitHub
 * Codespaces UI looks in a small, well-known set of locations; we mirror
 * that so the choices match what the user expects.
 *
 * Order:
 *   .devcontainer.json
 *   .devcontainer/devcontainer.json
 *   .devcontainer/<name>/devcontainer.json (up to 2 levels deep)
 */
async function detectDevcontainers(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const direct = path.join(repoRoot, '.devcontainer.json');
  if (await exists(direct)) found.push('.devcontainer.json');
  const dir = path.join(repoRoot, '.devcontainer');
  if (!(await isDir(dir))) return found;
  // .devcontainer/devcontainer.json
  if (await exists(path.join(dir, 'devcontainer.json'))) {
    found.push('.devcontainer/devcontainer.json');
  }
  // .devcontainer/*/devcontainer.json
  let entries: string[] = [];
  try { entries = await fs.readdir(dir); } catch { /* ignore */ }
  for (const name of entries) {
    const sub = path.join(dir, name);
    if (!(await isDir(sub))) continue;
    if (await exists(path.join(sub, 'devcontainer.json'))) {
      found.push(`.devcontainer/${name}/devcontainer.json`);
    }
  }
  return Array.from(new Set(found));
}

async function exists(p: string): Promise<boolean> {
  try { const s = await fs.stat(p); return s.isFile(); } catch { return false; }
}
async function isDir(p: string): Promise<boolean> {
  try { const s = await fs.stat(p); return s.isDirectory(); } catch { return false; }
}
async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
