/**
 * F86 — Tag-on-Merge Prompt.
 *
 * After merging a PR into the default branch, the user invokes
 * `gitsight.tagFromMerged` to:
 *   1. Detect the merge commit on HEAD (PR-shaped subject or squash-merge
 *      `(#N)` suffix).
 *   2. Walk the merged-in commit range from the previous tag.
 *   3. Suggest the next semver tag based on conventional-commit prefixes
 *      and BREAKING CHANGE trailers in the range.
 *   4. Open a markdown preview of the release notes draft.
 *   5. Offer to create the tag (annotated) and push it to origin.
 *
 * All inputs require user confirmation. The tag/push never fires
 * automatically — this is opt-in, surfaced from the command palette
 * and the PRs view item menu.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import {
  MergedCommit,
  parseConventionalHeader,
  classifyRangeBump,
  suggestNextTag,
  buildReleaseNotes,
  detectMergedPrNumber,
  SemverBump,
} from '../git/tagOnMerge';

const pexec = promisify(execFile);

export async function showTagFromMergedPrompt(git: Git): Promise<void> {
  // 1. HEAD detection. Look at the latest commit subject for a merge shape.
  const headSubject = (await safe(git, ['log', '-1', '--format=%s', 'HEAD'])).trim();
  const mergedPr = detectMergedPrNumber(headSubject);

  // 2. Last tag (any reachable tag, newest by tagger date).
  const lastTag = (await safe(git, [
    'describe', '--tags', '--abbrev=0', '--always', 'HEAD~1',
  ])).trim() || undefined;

  // 3. Range we'll inspect. Prefer <lastTag>..HEAD; fall back to last 50
  //    commits when there's no tag at all.
  const rangeRef = lastTag ? `${lastTag}..HEAD` : 'HEAD~50..HEAD';
  const commits = await loadMergedCommits(git, rangeRef);
  if (!commits.length) {
    vscode.window.showInformationMessage(
      `GitSight: no new commits in ${rangeRef} — nothing to tag.`,
    );
    return;
  }

  // 4. Classify the bump + suggest the tag.
  const bump = classifyRangeBump(commits);
  if (bump === 'none') {
    vscode.window.showInformationMessage(
      `GitSight: ${commits.length} commit(s) in ${rangeRef} don't suggest a semver bump (no feat/fix/perf/breaking). Skip the release for now.`,
    );
    return;
  }
  const suggested = suggestNextTag(lastTag, commits);
  if (!suggested) {
    vscode.window.showWarningMessage(
      `GitSight: cannot compute next tag — previous tag ${JSON.stringify(lastTag ?? '(none)')} is not semver. Tag manually.`,
    );
    return;
  }

  // 5. Build the release notes draft.
  const notes = buildReleaseNotes({
    commits,
    range: rangeRef,
    nextTag: suggested,
  });

  // 6. Preview + confirm. Open the notes in a scratch doc so the user can
  //    review/edit before the tag lands.
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: notes + '\n',
  });
  await vscode.window.showTextDocument(doc, { preview: true });

  const previewSummary = mergedPr
    ? `Merged PR #${mergedPr} — ${commits.length} commit(s), ${humanBump(bump)} bump.`
    : `${commits.length} commit(s) since ${lastTag ?? '(no prior tag)'}, ${humanBump(bump)} bump.`;

  const action = await vscode.window.showInformationMessage(
    `GitSight: ${previewSummary}\nSuggested tag: ${suggested}`,
    { modal: true },
    'Create tag', 'Create + push', 'Cancel',
  );
  if (!action || action === 'Cancel') return;

  // 7. Override the tag name if the user wants something else.
  const finalTag = await vscode.window.showInputBox({
    prompt: 'Tag name (semver). Press Enter to accept.',
    value: suggested,
    validateInput: (v) => /^v?\d+\.\d+\.\d+/.test(v.trim())
      ? undefined
      : 'Tag must look like v1.2.3 (or 1.2.3 without the v prefix).',
  });
  if (!finalTag) return;

  // 8. Create the annotated tag, optionally push.
  const tagMessage = `Release ${finalTag}\n\n${notes}`;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: tagging ${finalTag}\u2026` },
    async () => {
      try {
        await git.raw(['tag', '-a', finalTag.trim(), '-m', tagMessage]);
        if (action === 'Create + push') {
          await git.raw(['push', 'origin', finalTag.trim()]);
          vscode.window.setStatusBarMessage(`GitSight: tagged ${finalTag} and pushed to origin.`, 5000);
        } else {
          vscode.window.setStatusBarMessage(`GitSight: tagged ${finalTag} (not pushed).`, 5000);
        }
      } catch (e: any) {
        const msg = e?.stderr || e?.message || String(e);
        vscode.window.showErrorMessage(`GitSight: tag failed: ${msg.split('\n')[0]}`);
      }
    },
  );
}

function humanBump(bump: SemverBump): string {
  switch (bump) {
    case 'major': return 'major';
    case 'minor': return 'minor';
    case 'patch': return 'patch';
    case 'none':  return 'no';
  }
}

/**
 * Load the commits in a range via `git log` with the standardised pipe-
 * separated format. Includes author name for the contributors block.
 * Caps at 200 to avoid runaway loops; ranges that big shouldn't be a
 * single release anyway.
 */
async function loadMergedCommits(git: Git, range: string): Promise<MergedCommit[]> {
  const RECORD_SEP = '\u001E';
  const FIELD_SEP = '\u001F';
  const format = `%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  const raw = await safe(git, ['log', '--max-count=200', `--format=${format}`, range]);
  if (!raw) return [];
  const out: MergedCommit[] = [];
  for (const record of raw.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed) continue;
    const [sha, shortSha, author, subject, body] = trimmed.split(FIELD_SEP);
    if (!sha) continue;
    out.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      author: author || undefined,
      subject: subject || '',
      body: body || '',
    });
  }
  return out;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
