/**
 * F110 - Branch Namer Assistant.
 *
 * Wraps `gitsight.createBranch` so the input box is prefilled with a
 * smart kebab-cased branch name derived from:
 *
 *   1. SCM input box (best signal -- the user is already composing a
 *      conventional commit subject).
 *   2. Active editor's current selection (first sentence -> slug).
 *   3. Dirty / staged paths (single file -> `wip-<basename>`,
 *      many under one dir -> `wip-<dir>`).
 *   4. Active filename, then repo basename.
 *
 * Validation: built-in `git check-ref-format` subset so we reject
 * illegal chars BEFORE handing the name to `git branch`.
 *
 * Wired from extension.ts: the existing `gitsight.createBranch` now
 * calls into `createBranchWithAssistant(git, repos)`. Old keystrokes
 * still work -- the user can clear the prefill and type their own.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  suggestBranchNames,
  validateBranchName,
  bestBranchSuggestion,
  BranchNameSuggestion,
} from '../git/branchNamer';
import {
  classifyBranchRole,
  shouldAutoOfferProtection,
  describeAutoOfferRationale,
} from '../git/branchProtectionSuggest';

export async function createBranchWithAssistant(git: Git, _repos: RepoManager): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.branchNamer');
  const enabled = cfg.get<boolean>('enabled', true);
  const separator = (cfg.get<string>('separator', 'slash') as 'slash' | 'kebab' | 'none');

  let name: string | undefined;

  if (enabled) {
    const suggestions = await collectSuggestions(git, separator);
    if (suggestions.length > 0) {
      name = await pickOrEdit(suggestions);
    } else {
      name = await vscode.window.showInputBox({
        prompt: 'New branch name',
        validateInput: v => validateBranchName(v),
      });
    }
  } else {
    name = await vscode.window.showInputBox({
      prompt: 'New branch name',
      validateInput: v => validateBranchName(v),
    });
  }

  if (!name) return;

  await git.createBranch(name);
  const checkout = await vscode.window.showInformationMessage(`Branch '${name}' created`, 'Checkout');
  if (checkout === 'Checkout') await git.checkout(name);

  // F130: For branches with a "needs-protection" role (default / release /
  // hotfix / long-lived), proactively offer the F126 picker. The classifier
  // skips feature/* and other shapes - personal branches don't need
  // protection. Honour the user's opt-out config so this never becomes
  // surprise-noise.
  await offerProtectionForNewBranch(git, name);
}

/**
 * F130 - After a branch is created, classify its role and (when
 * classifier says "offer") surface a non-modal info toast asking
 * whether the user wants to run the F126 suggestion picker.
 *
 * The user has THREE choices: Suggest rules / Open settings / Dismiss.
 * "Dismiss" stays silent for the rest of this session for this branch
 * via a session-only cache so repeated checkouts don't re-prompt.
 *
 * Errors swallowed - the branch already created successfully; an offer
 * failure shouldn't bubble.
 */
const dismissedBranches = new Set<string>();
async function offerProtectionForNewBranch(git: Git, branch: string): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration('gitsight.branchProtectionSuggest');
    if (!cfg.get<boolean>('autoOfferOnCreate', true)) return;
    const key = branch.toLowerCase();
    if (dismissedBranches.has(key)) return;
    const defaultBranch = await readDefaultBranch(git);
    const role = classifyBranchRole({ branch, defaultBranch });
    if (shouldAutoOfferProtection(role) !== 'offer') return;
    const rationale = describeAutoOfferRationale(role);
    const action = await vscode.window.showInformationMessage(
      `GitSight: protect new branch '${branch}'? (${rationale})`,
      { modal: false },
      'Suggest rules',
      'Dismiss',
    );
    if (!action || action === 'Dismiss') {
      dismissedBranches.add(key);
      return;
    }
    if (action === 'Suggest rules') {
      await vscode.commands.executeCommand('gitsight.suggestBranchProtection', branch);
    }
  } catch {
    // Never surface as a modal - the branch creation already succeeded.
  }
}

async function readDefaultBranch(git: Git): Promise<string | undefined> {
  try {
    const raw = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const trimmed = raw.trim();
    const m = /refs\/remotes\/origin\/(.+)$/.exec(trimmed);
    return m?.[1];
  } catch {
    // Fall back to a config probe.
    try {
      const cfg = (await git.raw(['config', 'init.defaultBranch'])).trim();
      return cfg || undefined;
    } catch {
      return undefined;
    }
  }
}

async function pickOrEdit(suggestions: BranchNameSuggestion[]): Promise<string | undefined> {
  type Pk = vscode.QuickPickItem & { _name?: string; _editAction?: 'edit' };
  const items: Pk[] = [];
  items.push({ label: 'Suggestions', kind: vscode.QuickPickItemKind.Separator } as any);
  for (const s of suggestions) {
    items.push({
      label: `$(git-branch) ${s.name}`,
      description: s.source,
      _name: s.name,
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
  items.push({
    label: '$(edit) Type a custom name\u2026',
    description: `start from "${suggestions[0].name}"`,
    _editAction: 'edit',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a suggested branch name or choose to type your own',
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked._editAction === 'edit') {
    return await vscode.window.showInputBox({
      prompt: 'New branch name',
      value: suggestions[0].name,
      validateInput: v => validateBranchName(v),
    });
  }
  return picked._name;
}

async function collectSuggestions(git: Git, separator: 'slash' | 'kebab' | 'none'): Promise<BranchNameSuggestion[]> {
  const scmInput = await readScmInputBox(git);
  const selectionText = readActiveSelection();
  const activeFile = readActiveFileRel(git);
  const dirtyPaths = await readDirtyPaths(git);
  const repoName = path.basename(git.cwd);

  return suggestBranchNames({
    scmInput,
    selectionText,
    dirtyPaths,
    activeFile,
    repoName,
    separator,
  });
}

async function readScmInputBox(git: Git): Promise<string | undefined> {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
    const api = gitExt?.getAPI(1);
    const repos: any[] = api?.repositories ?? [];
    // Prefer the repository whose root matches our git.cwd.
    const match = repos.find(r => r?.rootUri?.fsPath && pathsEqual(r.rootUri.fsPath, git.cwd));
    const repo = match ?? repos[0];
    return repo?.inputBox?.value || undefined;
  } catch {
    return undefined;
  }
}

function readActiveSelection(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  if (editor.selection.isEmpty) return undefined;
  const text = editor.document.getText(editor.selection);
  if (!text || !text.trim()) return undefined;
  // Cap at 500 chars -- branch names come from short slugs only.
  return text.length > 500 ? text.slice(0, 500) : text;
}

function readActiveFileRel(git: Git): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const abs = editor.document.uri.fsPath;
  if (!abs) return undefined;
  const rel = path.relative(git.cwd, abs);
  if (!rel || rel.startsWith('..')) return undefined;
  return rel;
}

async function readDirtyPaths(git: Git): Promise<string[]> {
  try {
    const porcelain = await git.raw(['status', '--porcelain', '-z']);
    if (!porcelain) return [];
    const out: string[] = [];
    let i = 0;
    while (i < porcelain.length) {
      const end = porcelain.indexOf('\0', i);
      if (end < 0) break;
      const entry = porcelain.slice(i, end);
      i = end + 1;
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const file = entry.slice(3);
      // Skip untracked + ignored; the namer only cares about tracked dirty.
      if (x === '?' || y === '?' || x === '!' || y === '!') continue;
      // Renamed entries put the source after a NUL -- skip past it.
      if (x === 'R' || y === 'R') {
        const srcEnd = porcelain.indexOf('\0', i);
        if (srcEnd >= 0) i = srcEnd + 1;
      }
      if (file) out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

function pathsEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

// Re-export for the extension wiring to call without importing the pure
// helper directly.
export { suggestBranchNames, validateBranchName, bestBranchSuggestion };
