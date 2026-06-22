/**
 * F80 — Stash-on-Branch-Switch.
 *
 * After a successful branch checkout, look up stashes that were
 * previously created WHILE ON the destination branch and surface a
 * toast offering to re-apply them. Bookends the existing stash UX:
 *
 *   - F31 Stash Quick-Switcher  — apply any stash from anywhere
 *   - F43 Smart Stash Save      — save a stash with a useful name
 *   - F48 Auto-Stash Before Checkout — stash dirty work when blocked
 *   - F80 Stash-on-Branch-Switch    — re-apply branch-bound stashes
 *                                     when you come back
 *
 * Hook: extension.ts calls runStashOnSwitch(git, branch) at the tail of
 * `gitsight.checkoutBranch` (and any other surface that completes a
 * checkout via the F48 wrapper). The check is cheap — one `git stash
 * list` call — and silently no-ops when nothing matches.
 *
 * UX shape:
 *
 *   "GitSight: 2 stashes previously made on `feature/x`."
 *     [Apply newest] [Pick from list] [Dismiss]
 *
 *   - Apply newest: runs `git stash apply stash@{N}` for the lowest
 *     matching index (most recent in git's stack), keeps the stash.
 *   - Pick from list: shows a QuickPick of all matches with per-row
 *     apply/pop/show actions.
 *   - Dismiss: remembers the branch for this session so we don't
 *     re-prompt on the next checkout-to-same-branch.
 *
 * Configurable via:
 *   gitsight.stashOnSwitch.enabled    (default true)
 *   gitsight.stashOnSwitch.freshDays  (default 3 — stashes older than this
 *                                       are no longer "auto-suggested",
 *                                       just listed without a primary
 *                                       button)
 *   gitsight.stashOnSwitch.agingDays  (default 14 — stashes older than this
 *                                       are demoted to muted display only)
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  matchStashesForBranch,
  glyphForAge,
  describeStashMatch,
  describeToastHeadline,
  StashMatch,
} from '../git/stashOnSwitch';

// Session-only dismissal cache: branch name (lower-case, normalised) →
// set of stash refs the user said "skip" for. Cleared on extension
// reload (intentionally; if the user reopens VS Code they get a fresh
// chance to apply the stash).
const dismissedThisSession = new Map<string, Set<string>>();

export interface StashOnSwitchResult {
  decision: 'skipped' | 'no-matches' | 'all-dismissed' | 'applied' | 'opened-picker' | 'dismissed';
  branch: string;
  matchCount: number;
  appliedRef?: string;
}

export async function runStashOnSwitch(git: Git, branch: string): Promise<StashOnSwitchResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.stashOnSwitch');
  if (!cfg.get<boolean>('enabled', true)) {
    return { decision: 'skipped', branch, matchCount: 0 };
  }
  if (!branch) return { decision: 'skipped', branch, matchCount: 0 };

  const stashes = await loadStashes(git);
  if (stashes.length === 0) return { decision: 'no-matches', branch, matchCount: 0 };

  const freshDays = clampInt(cfg.get<number>('freshDays', 3), 1, 365);
  const agingDays = clampInt(cfg.get<number>('agingDays', 14), freshDays, 1095);
  const matches = matchStashesForBranch(stashes, branch, { freshDays, agingDays });
  if (matches.length === 0) return { decision: 'no-matches', branch, matchCount: 0 };

  const dismissed = dismissedThisSession.get(normaliseKey(branch)) ?? new Set<string>();
  const live = matches.filter(m => !dismissed.has(m.ref));
  if (live.length === 0) return { decision: 'all-dismissed', branch, matchCount: matches.length };

  return await surfaceToast(git, branch, live);
}

/**
 * Fire-and-forget wrapper for the extension hook — never throws, never
 * blocks the caller. Returns void so the checkout command can chain
 * `.then(refresh)` cleanly.
 */
export function runStashOnSwitchFireAndForget(git: Git, branch: string): void {
  void (async () => {
    try { await runStashOnSwitch(git, branch); }
    catch { /* silent — checkout already succeeded */ }
  })();
}

async function surfaceToast(git: Git, branch: string, matches: StashMatch[]): Promise<StashOnSwitchResult> {
  const headline = describeToastHeadline(matches, branch);
  const buttons: string[] = [];
  if (matches.length === 1) {
    buttons.push('Apply', 'Pick action\u2026', 'Dismiss');
  } else {
    buttons.push('Apply newest', 'Pick from list\u2026', 'Dismiss');
  }
  const picked = await vscode.window.showInformationMessage(headline, { modal: false }, ...buttons);
  if (!picked || picked === 'Dismiss') {
    rememberDismissal(branch, matches);
    return { decision: 'dismissed', branch, matchCount: matches.length };
  }
  if (picked === 'Apply' || picked === 'Apply newest') {
    const newest = matches[0]; // matches already sorted by index ascending
    await applyStash(git, newest);
    return { decision: 'applied', branch, matchCount: matches.length, appliedRef: newest.ref };
  }
  // 'Pick action…' or 'Pick from list…'
  const result = await showMatchPicker(git, branch, matches);
  return result;
}

async function showMatchPicker(git: Git, branch: string, matches: StashMatch[]): Promise<StashOnSwitchResult> {
  type Pk = vscode.QuickPickItem & { _match: StashMatch; _action: 'apply' | 'pop' | 'show' | 'drop' };
  const items: Pk[] = [];
  items.push({ label: `Stashes on \`${branch}\``, kind: vscode.QuickPickItemKind.Separator } as any);
  for (const m of matches) {
    items.push({
      label: `$(${glyphForAge(m.age)}) ${m.cleanSubject || '(no message)'}`,
      description: describeStashMatch(m),
      detail: 'Apply (keeps the stash)',
      _match: m,
      _action: 'apply',
    });
    items.push({
      label: `   $(diff) ${m.cleanSubject || '(no message)'}`,
      description: `show the stash diff`,
      detail: `git stash show -p ${m.ref}`,
      _match: m,
      _action: 'show',
    });
    items.push({
      label: `   $(eject) ${m.cleanSubject || '(no message)'}`,
      description: `pop (apply + drop)`,
      detail: `git stash pop ${m.ref}`,
      _match: m,
      _action: 'pop',
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${matches.length} stash${matches.length === 1 ? '' : 'es'} from \`${branch}\``,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return { decision: 'opened-picker', branch, matchCount: matches.length };
  }
  if (picked._action === 'apply') {
    await applyStash(git, picked._match);
    return { decision: 'applied', branch, matchCount: matches.length, appliedRef: picked._match.ref };
  }
  if (picked._action === 'pop') {
    await popStash(git, picked._match);
    return { decision: 'applied', branch, matchCount: matches.length, appliedRef: picked._match.ref };
  }
  if (picked._action === 'show') {
    await showStashDiff(git, picked._match);
    return { decision: 'opened-picker', branch, matchCount: matches.length };
  }
  return { decision: 'opened-picker', branch, matchCount: matches.length };
}

async function applyStash(git: Git, m: StashMatch): Promise<void> {
  try {
    await git.raw(['stash', 'apply', m.ref]);
    vscode.window.setStatusBarMessage(`GitSight: applied ${m.ref} \u2014 ${m.cleanSubject}`, 4000);
    await vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: stash apply failed: ${e.message ?? e}`);
  }
}

async function popStash(git: Git, m: StashMatch): Promise<void> {
  try {
    await git.raw(['stash', 'pop', m.ref]);
    vscode.window.setStatusBarMessage(`GitSight: popped ${m.ref} \u2014 ${m.cleanSubject}`, 4000);
    await vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: stash pop failed: ${e.message ?? e}`);
  }
}

async function showStashDiff(git: Git, m: StashMatch): Promise<void> {
  try {
    const out = await git.raw(['stash', 'show', '-p', m.ref]);
    const doc = await vscode.workspace.openTextDocument({ content: out || `# Empty stash ${m.ref}`, language: 'diff' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: stash show failed: ${e.message ?? e}`);
  }
}

function rememberDismissal(branch: string, matches: StashMatch[]): void {
  const key = normaliseKey(branch);
  let set = dismissedThisSession.get(key);
  if (!set) { set = new Set<string>(); dismissedThisSession.set(key, set); }
  for (const m of matches) set.add(m.ref);
}

function normaliseKey(name: string): string {
  return (name ?? '').replace(/^origin\//, '').toLowerCase();
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

async function loadStashes(git: Git): Promise<Awaited<ReturnType<Git['stashes']>>> {
  try { return await git.stashes(); } catch { return []; }
}
