/**
 * AI-Generated Pull Request Description.
 *
 * Computes the diff between the current branch and the merge-base with the
 * auto-detected default branch (origin/HEAD), then asks Copilot to write a
 * markdown PR description: summary, changes (bulleted), test plan, and a
 * checklist. The result is opened in a new markdown editor and optionally
 * copied to the clipboard.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { runCopilotPrompt } from './copilot';

const SYSTEM_PROMPT = `You write thorough, scannable Pull Request descriptions.
Output format (markdown, no code fences around the whole thing):

## Summary
<1-3 sentences explaining the WHY of this PR>

## Changes
- <bulleted user-facing or developer-visible changes; group related ones>

## Implementation notes
- <key decisions, tradeoffs, things a reviewer should know>

## Test plan
- [ ] <manual or automated step the reviewer should perform>

## Checklist
- [ ] Updated docs/CHANGELOG if user-facing
- [ ] Tests added/updated
- [ ] No breaking changes (or noted above)

Rules:
- Be concrete. Reference files only when it adds clarity.
- Skip empty sections.
- No emoji. No marketing speak. No "this PR introduces…" filler.
- Keep total length under 400 words unless the diff is genuinely huge.`;

/** Best-effort default branch detection. Falls back to "main" then "master". */
async function detectDefaultBranch(git: Git): Promise<string> {
  // 1) Try origin/HEAD
  try {
    const out = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out; // e.g. "origin/main"
  } catch { /* not set */ }
  // 2) Refresh and retry once
  try {
    await git.raw(['remote', 'set-head', 'origin', '--auto']);
    const out = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out;
  } catch { /* offline or no remote */ }
  // 3) Probe likely candidates
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    try { await git.raw(['rev-parse', '--verify', cand]); return cand; } catch { /* skip */ }
  }
  return 'main';
}

export async function generatePullRequestDescription(ctx: vscode.ExtensionContext, git: Git) {
  const branch = (await git.currentBranch()).trim();
  if (!branch || branch === 'HEAD') {
    vscode.window.showWarningMessage('GitSight: PR description requires a named branch (HEAD is detached).');
    return;
  }
  const base = await detectDefaultBranch(git);
  if (branch.replace(/^[^/]+\//, '') === base.replace(/^[^/]+\//, '')) {
    vscode.window.showInformationMessage(`GitSight: you are on the default branch (${branch}). Switch to a feature branch first.`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: drafting PR description for ${branch} → ${base}…`, cancellable: true },
    async (_p, token) => {
      const tokenSource = new vscode.CancellationTokenSource();
      token.onCancellationRequested(() => tokenSource.cancel());

      let mergeBase = '';
      try { mergeBase = (await git.raw(['merge-base', base, 'HEAD'])).trim(); }
      catch { /* no shared history yet; fall back to range below */ }

      const range = mergeBase ? `${mergeBase}..HEAD` : `${base}..HEAD`;
      const commits = await git.raw(['log', '--no-merges', '--pretty=format:%h %s%n%b%n---', range]).catch(() => '');
      const diffStat = await git.raw(['diff', '--stat', range]).catch(() => '');
      const diffPatch = await git.raw(['diff', range]).catch(() => '');
      if (!commits.trim() && !diffPatch.trim()) {
        vscode.window.showInformationMessage(`GitSight: no changes between ${base} and ${branch}.`);
        return;
      }

      // Keep prompts within model context — truncate the patch hardest.
      const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
      const userPrompt =
        `Source branch: ${branch}\n` +
        `Target branch: ${base}\n` +
        `Range: ${range}\n\n` +
        `## Commits\n${truncate(commits, 6000)}\n\n` +
        `## File stats\n${truncate(diffStat, 2000)}\n\n` +
        `## Patch (truncated)\n${truncate(diffPatch, 18000)}\n\n` +
        `Write the PR description.`;

      let md: string;
      try {
        md = await runCopilotPrompt(ctx, SYSTEM_PROMPT, userPrompt, { tokenSource });
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
        return;
      }

      const title = `# ${branch} → ${base}\n\n` + md.trim() + '\n';
      const doc = await vscode.workspace.openTextDocument({ content: title, language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

      const action = await vscode.window.showInformationMessage(
        'GitSight: PR description drafted.',
        'Copy to clipboard',
        'Open in gh CLI',
      );
      if (action === 'Copy to clipboard') {
        await vscode.env.clipboard.writeText(title);
        vscode.window.setStatusBarMessage('PR description copied', 2000);
      } else if (action === 'Open in gh CLI') {
        const term = vscode.window.createTerminal({ name: 'GitSight: gh pr create', cwd: git.cwd });
        term.show();
        // Pre-fill body via stdin so the user just hits enter / edits the title.
        const escaped = title.replace(/'/g, `'\\''`);
        term.sendText(`printf '%s' '${escaped}' | gh pr create --base ${base.replace(/^[^/]+\//, '')} --body-file -`);
      }
    },
  );
}
