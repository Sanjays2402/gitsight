import * as vscode from 'vscode';
import { Git } from '../git/git';
import { runCopilotPrompt } from '../ai/copilot';

const SYSTEM_PROMPT = `You write release-quality changelog entries from git log output.
Output format:
## <Version or Range>
### Added
- ...
### Changed
- ...
### Fixed
- ...
### Removed
- ...
Rules:
- Bullets are user-facing and meaningful — skip "bump version", "merge branch", "wip".
- Group by Conventional Commit type when possible (feat→Added, fix→Fixed, refactor/perf/chore→Changed).
- Skip empty sections entirely.
- No emoji. No code fences. Markdown only.`;

export async function generateChangelog(ctx: vscode.ExtensionContext, git: Git) {
  const tags = await git.raw(['tag', '--sort=-creatordate']).then(s => s.split('\n').filter(Boolean)).catch(() => []);
  const refsItems: vscode.QuickPickItem[] = [
    { label: '$(history) HEAD~20..HEAD', description: 'last 20 commits' },
    { label: '$(history) HEAD~50..HEAD', description: 'last 50 commits' },
    ...(tags.length >= 1 ? [{ label: `$(tag) ${tags[0]}..HEAD`, description: 'since latest tag' }] : []),
    ...(tags.length >= 2 ? [{ label: `$(tag) ${tags[1]}..${tags[0]}`, description: `${tags[1]} → ${tags[0]}` }] : []),
    { label: '$(edit) Custom range…', description: 'enter a git range manually (e.g. v1.0.0..HEAD)' },
  ];
  const picked = await vscode.window.showQuickPick(refsItems, { placeHolder: 'Pick a commit range to summarize' });
  if (!picked) return;
  let range = picked.label.replace(/^\$\([a-z-]+\)\s+/, '');
  if (range.startsWith('Custom')) {
    const input = await vscode.window.showInputBox({ prompt: 'git range (e.g. v1.0.0..HEAD)', value: 'HEAD~20..HEAD' });
    if (!input) return;
    range = input;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: AI changelog for ${range}` },
    async () => {
      const log = await git.raw(['log', '--no-merges', '--pretty=format:%h %s%n%b%n---', range]);
      if (!log.trim()) return vscode.window.showInformationMessage('No commits in range.');
      const truncated = log.length > 14000 ? log.slice(0, 14000) + '\n...[truncated]' : log;
      const md = await runCopilotPrompt(
        ctx,
        SYSTEM_PROMPT,
        `Range: ${range}\n\nCommits:\n${truncated}\n\nWrite the changelog section.`,
      );
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    },
  );
}
