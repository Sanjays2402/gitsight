/**
 * F73 — Conventional Commit footer composer.
 *
 * Multi-pick of well-known trailers (Co-authored-by, Reviewed-by,
 * Signed-off-by, Closes, Fixes, Refs, BREAKING CHANGE) that append to
 * the SCM input box. Pairs with F29 (header) and F60 (scaffold).
 *
 * Flow:
 *
 *   1. Multi-pick of trailer kinds. Pre-checked: any kinds where the
 *      current message already has an entry of that shape (so re-running
 *      the picker adds more rather than starting fresh).
 *   2. For each picked kind, an input box validates the value against
 *      the trailer's shape (name+email, issue ref, free text).
 *   3. We append the validated entries to the SCM input box, preserving
 *      existing trailers and inserting the canonical blank-line separator
 *      between body and trailers.
 *
 * Gracefully degrades to clipboard when the SCM input box isn't
 * available (matches the F18/F29 patterns).
 *
 * Pure logic in src/git/commitFooter.ts. View just sequences the UI.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  FOOTER_DEFINITIONS,
  FooterDefinition,
  FooterEntry,
  FooterKind,
  appendFooters,
  extractExistingFooters,
  normaliseIssueRef,
  renderFooterLine,
  validateFooterValue,
} from '../git/commitFooter';

export async function showCommitFooterComposer(git: Git): Promise<void> {
  const repo = getScmRepo();
  const currentMessage: string = repo?.inputBox?.value ?? '';
  const existing = extractExistingFooters(currentMessage);
  const existingKinds = new Set(existing.map(e => e.kind));

  // Step 1 — multi-pick of footer kinds.
  type Pk = vscode.QuickPickItem & { _def: FooterDefinition };
  const items: Pk[] = FOOTER_DEFINITIONS.map(def => ({
    label: `$(symbol-key) ${def.label}`,
    description: def.description,
    detail: existingKinds.has(def.kind)
      ? `Already present: ${existing.filter(e => e.kind === def.kind).map(e => e.value).join(' \u00b7 ')}`
      : undefined,
    picked: false,
    _def: def,
  }));
  const picks = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick trailers to append (multi-select)',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picks || picks.length === 0) return;

  // Step 2 — collect a value per picked trailer.
  const entries: FooterEntry[] = [];
  for (const p of picks) {
    const def = p._def;
    const value = await promptForValue(def, git, currentMessage);
    if (value === undefined) {
      // User cancelled mid-way: keep what they've entered so far and bail
      // out only if they cancel the FIRST one. Anything later still ships.
      if (entries.length === 0) return;
      break;
    }
    entries.push({ kind: def.kind, value });
  }
  if (!entries.length) return;

  const next = appendFooters(currentMessage, entries);
  if (repo) {
    repo.inputBox.value = next;
    await vscode.commands.executeCommand('workbench.view.scm');
    const inserted = entries.map(renderFooterLine).join(' \u00b7 ');
    vscode.window.setStatusBarMessage(`GitSight: inserted ${entries.length} trailer${entries.length === 1 ? '' : 's'} (${inserted})`, 3000);
    return;
  }
  await vscode.env.clipboard.writeText(entries.map(renderFooterLine).join('\n'));
  vscode.window.showInformationMessage(`GitSight: SCM input not available — ${entries.length} trailer${entries.length === 1 ? '' : 's'} copied to clipboard.`);
}

async function promptForValue(def: FooterDefinition, git: Git, currentMessage: string): Promise<string | undefined> {
  if (def.shape === 'name-email') return promptNameEmail(def, git);
  if (def.shape === 'issue-ref')  return promptIssueRef(def);
  return promptFreeText(def);
}

async function promptNameEmail(def: FooterDefinition, git: Git): Promise<string | undefined> {
  // Suggest the most recent (non-self) author from the last 20 commits as a
  // starting point — saves typing for the common "add the person who just
  // reviewed it" path.
  const suggestion = await suggestRecentAuthor(git);
  const v = await vscode.window.showInputBox({
    prompt: `${def.key} — Name <email>`,
    placeHolder: 'Alice Doe <alice@example.com>',
    value: suggestion,
    validateInput: input => validateFooterValue(def.kind, input),
  });
  return v?.trim() || undefined;
}

async function promptIssueRef(def: FooterDefinition): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    prompt: `${def.key} — issue references`,
    placeHolder: '#123 or org/repo#123 (comma-separated for multiple)',
    validateInput: input => {
      const normalised = normaliseIssueRef(input);
      if (!normalised) return 'Expected: #123 or org/repo#123 (comma-separated for multiple)';
      return undefined;
    },
  });
  if (!v) return undefined;
  return normaliseIssueRef(v) ?? v.trim();
}

async function promptFreeText(def: FooterDefinition): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    prompt: `${def.key} — note`,
    placeHolder: def.kind === 'breaking-change' ? 'What broke and how should consumers adapt?' : 'value',
    validateInput: input => validateFooterValue(def.kind, input),
  });
  return v?.trim() || undefined;
}

async function suggestRecentAuthor(git: Git): Promise<string | undefined> {
  try {
    const self = (await git.raw(['config', 'user.email'])).trim().toLowerCase();
    const out = await git.raw(['log', '-n', '20', '--pretty=format:%an|%ae']);
    for (const line of out.split('\n')) {
      const [name, email] = line.split('|');
      if (!email) continue;
      if (email.toLowerCase() === self) continue;
      return `${name.trim()} <${email.trim()}>`;
    }
  } catch {
    /* no-op */
  }
  return undefined;
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

// Expose a helper that other commands can re-use (F18 Co-authored-by
// trailer-block insertion currently builds its own block; this lets
// future composers share the canonical insert behaviour).
export function previewFooterInsertion(currentMessage: string, kind: FooterKind, value: string): string {
  return appendFooters(currentMessage, [{ kind, value }]);
}
