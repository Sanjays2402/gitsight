/**
 * AI-Generated Pull Request Description.
 *
 * Computes the diff between the current branch and the merge-base with the
 * auto-detected default branch (origin/HEAD), then asks Copilot to write a
 * markdown PR description: summary, changes (bulleted), test plan, and a
 * checklist. The result is opened in a new markdown editor and optionally
 * copied to the clipboard.
 *
 * F98 — when a `.github/PULL_REQUEST_TEMPLATE.md` (or directory variant)
 * exists, the AI body is merged INTO the template's section structure
 * rather than replacing it. The user's checklist boxes survive; the
 * AI's prose fills in the prose sections.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { runCopilotPrompt } from './copilot';
import {
  templateCandidatePaths,
  buildTemplatePickerEntries,
  mergeAiIntoTemplate,
  TemplateFile,
} from '../git/prTemplate';

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

      // F98 — if a PR template exists, fold AI content into it.
      const repoRoot = git.cwd;
      let mergedBody = md.trim();
      let mergeBreadcrumb = '';
      try {
        const template = await resolvePrTemplate(repoRoot);
        if (template) {
          const result = mergeAiIntoTemplate(template.body, mergedBody, { appendUnmatched: true });
          mergedBody = result.merged.trim();
          const parts: string[] = [];
          if (result.replaced.length) parts.push(`filled ${result.replaced.length} section${result.replaced.length === 1 ? '' : 's'}`);
          if (result.appended.length) parts.push(`appended ${result.appended.length}`);
          mergeBreadcrumb = parts.length
            ? `\n\n<!-- gitsight: merged into ${template.label} template — ${parts.join(', ')} -->`
            : `\n\n<!-- gitsight: merged into ${template.label} template -->`;
        }
      } catch {
        // Template read/merge failure should NEVER block the PR draft.
      }

      const title = `# ${branch} → ${base}\n\n` + mergedBody + mergeBreadcrumb + '\n';
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

/**
 * F98 — locate a PR template on disk and read its body. When multiple
 * templates exist under `.github/PULL_REQUEST_TEMPLATE/`, prompt the
 * user with a picker. Returns undefined when no template is configured.
 */
interface ResolvedTemplate { label: string; body: string; relPath: string; }

async function resolvePrTemplate(repoRoot: string): Promise<ResolvedTemplate | undefined> {
  const cfg = vscode.workspace.getConfiguration('gitsight.prTemplate');
  if (cfg.get<boolean>('enabled', true) === false) return undefined;

  for (const cand of templateCandidatePaths()) {
    const abs = vscode.Uri.file(path.join(repoRoot, cand.path));
    let stat: vscode.FileStat | undefined;
    try { stat = await vscode.workspace.fs.stat(abs); } catch { continue; }
    if (cand.isDirectory) {
      if (stat.type !== vscode.FileType.Directory && (stat.type & vscode.FileType.Directory) === 0) continue;
      const listing: [string, vscode.FileType][] = await new Promise(resolve => {
        Promise.resolve(vscode.workspace.fs.readDirectory(abs))
          .then(r => resolve(r as [string, vscode.FileType][]))
          .then(undefined, () => resolve([]));
      });
      const fileNames = listing
        .filter(([, t]: [string, vscode.FileType]) => t === vscode.FileType.File || (t & vscode.FileType.File) !== 0)
        .map(([n]: [string, vscode.FileType]) => n);
      const entries = buildTemplatePickerEntries(cand.path, fileNames);
      if (!entries.length) continue;
      const picked = await pickTemplate(entries);
      if (!picked) return undefined;
      const body = await readTemplateBody(repoRoot, picked.relPath);
      return body !== undefined ? { label: picked.label, body, relPath: picked.relPath } : undefined;
    } else {
      if (stat.type !== vscode.FileType.File && (stat.type & vscode.FileType.File) === 0) continue;
      const body = await readTemplateBody(repoRoot, cand.path);
      if (body === undefined) continue;
      return { label: path.basename(cand.path), body, relPath: cand.path };
    }
  }
  return undefined;
}

async function readTemplateBody(repoRoot: string, relPath: string): Promise<string | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(repoRoot, relPath)));
    return Buffer.from(buf).toString('utf8');
  } catch {
    return undefined;
  }
}

async function pickTemplate(entries: TemplateFile[]): Promise<TemplateFile | undefined> {
  if (entries.length === 1) return entries[0];
  const picked = await vscode.window.showQuickPick(
    entries.map(e => ({
      label: e.label,
      description: e.relPath,
      entry: e,
    })),
    { placeHolder: 'Pick a PR template', matchOnDescription: true },
  );
  return picked?.entry;
}
