/**
 * Conventional Commit Quick-Insert (F29) — guided three-step picker:
 *
 *   1. Pick a type (feat / fix / chore / docs / refactor / perf / test / build /
 *      ci / style / revert). The currently-staged files' suggested type is
 *      pre-highlighted with a star icon.
 *   2. Pick a scope. We pre-fill with a smart suggestion mined from the staged
 *      file paths (e.g. 'git' when most staged files live under src/git/),
 *      with a "skip scope" escape hatch and a "type your own" option.
 *   3. Type the subject. Optionally mark it as a breaking change (`feat!:`).
 *
 * The composed header is written to the built-in git SCM input box (replacing
 * the first line so existing body text survives). When the SCM box isn't
 * available, the header is copied to the clipboard.
 *
 * Pure types, suggesters, and composer live in src/git/conventionalCommit.ts
 * and are fully unit-tested.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  CONVENTIONAL_TYPES,
  ConventionalType,
  composeHeader,
  suggestScope,
  suggestType,
  applyHeader,
} from '../git/conventionalCommit';

interface TypeItem extends vscode.QuickPickItem { _t: ConventionalType; }

export async function showConventionalCommitInsert(git: Git): Promise<void> {
  const stagedPaths = await readStagedPaths(git);

  const typeHint = suggestType(stagedPaths);
  const scopeHint = suggestScope(stagedPaths);

  // Step 1 — type.
  const typeItems: TypeItem[] = CONVENTIONAL_TYPES.map(t => {
    const recommended = t.type === typeHint.type;
    return {
      label: `${recommended ? '$(star-full)' : '$(zap)'} ${t.type}`,
      description: t.description,
      detail: recommended ? `Recommended for ${stagedPaths.length} staged file${stagedPaths.length === 1 ? '' : 's'}` : undefined,
      _t: t,
    };
  });
  // Promote recommended to the top of the list.
  typeItems.sort((a, b) => {
    if (a._t.type === typeHint.type) return -1;
    if (b._t.type === typeHint.type) return 1;
    return 0;
  });
  const typePick = await vscode.window.showQuickPick(typeItems, {
    placeHolder: 'Conventional commit — pick a type',
    matchOnDescription: true,
  });
  if (!typePick) return;
  const type = typePick._t.type;

  // Step 2 — scope.
  type ScopeAction = 'use-suggestion' | 'skip' | 'custom';
  type ScopeItem = vscode.QuickPickItem & { _action: ScopeAction };
  const scopeItems: ScopeItem[] = [];
  if (scopeHint) {
    scopeItems.push({
      label: `$(symbol-namespace) ${scopeHint}`,
      detail: `Auto-detected from ${stagedPaths.length} staged file${stagedPaths.length === 1 ? '' : 's'}`,
      _action: 'use-suggestion',
    });
  }
  scopeItems.push({ label: '$(edit) Type a custom scope\u2026', _action: 'custom' });
  scopeItems.push({ label: '$(circle-slash) No scope', _action: 'skip' });
  const scopePick = await vscode.window.showQuickPick(scopeItems, {
    placeHolder: scopeHint ? `Scope (recommended: ${scopeHint})` : 'Scope (none recommended)',
    matchOnDescription: true,
  });
  if (!scopePick) return;
  let scope: string | undefined;
  if (scopePick._action === 'use-suggestion') scope = scopeHint;
  else if (scopePick._action === 'custom') {
    scope = (await vscode.window.showInputBox({
      prompt: 'Scope (e.g. api, ui, db, git)',
      value: scopeHint ?? '',
      validateInput: v => /^[a-z0-9._/\-]*$/i.test(v) ? undefined : 'Letters, digits, . _ / -',
    }))?.trim() || undefined;
  }
  // Skip leaves scope undefined.

  // Step 3 — subject + breaking flag.
  const subject = (await vscode.window.showInputBox({
    prompt: `Subject for ${type}${scope ? `(${scope})` : ''}:`,
    placeHolder: 'short, imperative — e.g. "handle null upstream"',
    validateInput: v => {
      const t = v.trim();
      if (!t) return 'Required';
      if (t.length > 72) return `Subject is ${t.length} chars; keep ≤ 72 for the conventional header`;
      return undefined;
    },
  }))?.trim();
  if (!subject) return;

  const breaking = (await vscode.window.showQuickPick(
    [
      { label: '$(circle-outline) No', description: 'Standard change', _b: false },
      { label: '$(warning) Yes — breaking change', description: 'Adds `!` and a BREAKING CHANGE footer', _b: true },
    ],
    { placeHolder: 'Is this a breaking change?' },
  ))?._b ?? false;

  const header = composeHeader(type, scope, subject, breaking);
  const repo = getScmRepo();
  const before: string = repo?.inputBox?.value ?? '';
  let next = applyHeader(before, header);
  if (breaking) {
    // Append a BREAKING CHANGE footer if not already present.
    if (!/^BREAKING CHANGE:/m.test(next)) {
      const note = await vscode.window.showInputBox({
        prompt: 'BREAKING CHANGE note (optional)',
        placeHolder: 'What broke and how should consumers adapt?',
      });
      if (note?.trim()) {
        next = `${next.replace(/[\s\n]+$/, '')}\n\nBREAKING CHANGE: ${note.trim()}\n`;
      }
    }
  }

  if (repo) {
    repo.inputBox.value = next;
    await vscode.commands.executeCommand('workbench.view.scm');
    vscode.window.setStatusBarMessage(`GitSight: inserted ${header}`, 3000);
    return;
  }
  await vscode.env.clipboard.writeText(header);
  vscode.window.showInformationMessage(`GitSight: SCM input not available — header copied: ${header}`);
}

async function readStagedPaths(git: Git): Promise<string[]> {
  try {
    const out = await git.raw(['diff', '--cached', '--name-only']);
    const staged = out.split('\n').map(s => s.trim()).filter(Boolean);
    if (staged.length) return staged;
    // Fall back to unstaged changes when nothing is staged — gives users a sensible
    // hint right when they're about to stage and commit in one motion.
    const fallback = await git.raw(['diff', '--name-only']);
    return fallback.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function getScmRepo(): any | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt || !gitExt.isActive) return null;
    const api = gitExt.exports?.getAPI?.(1);
    return api?.repositories?.[0] ?? null;
  } catch {
    return null;
  }
}
