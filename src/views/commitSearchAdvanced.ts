/**
 * Advanced Commit Search (F51) — `gitsight.searchCommitsAdvanced`.
 *
 * Replaces the single-input `gitsight.searchCommits` flow (which dumps
 * one substring into the SearchView tree) with a rich query language
 * exposed through a single QuickPick that doubles as live results.
 *
 * Query syntax (parsed by src/git/commitSearch.ts):
 *
 *   parser bug                     → grep "parser" + grep "bug"
 *   author:alice path:src/         → --author=alice -- src/
 *   "fix: typo" since:2026-01-01   → grep "fix: typo" --since=…
 *   re:^WIP                        → grep --extended-regexp "^WIP"
 *   case:off Fix                   → case-sensitive grep "Fix"
 *   max:500                        → cap at 500 hits
 *
 * The picker keeps the original `searchCommits` reachable: the legacy
 * command still exists and feeds the SearchView, so users who had it
 * bound to a keybinding don't lose anything.
 *
 * Picker actions per row: open commit detail (existing
 * gitsight.showCommitDetail), copy sha, open on remote.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  parseQuery,
  buildSearchArgs,
  parseHits,
  describeHits,
  describeQuery,
  ParsedHit,
} from '../git/commitSearch';

const FMT = '%H|%h|%aI|%an|%s';

type SearchItem = vscode.QuickPickItem & { _hit?: ParsedHit; _action?: 'open-tree' | 'help' };

export async function showAdvancedCommitSearch(git: Git, ctx: vscode.ExtensionContext, initial?: string) {
  const cfg = vscode.workspace.getConfiguration('gitsight.commitSearch');
  const defaultMax = cfg.get<number>('defaultMaxCount', 200) ?? 200;

  const qp = vscode.window.createQuickPick<SearchItem>();
  qp.title = 'GitSight: Advanced commit search';
  qp.placeholder = 'Type to search (author:foo  path:bar  since:N  re:^pat  case:off  max:500)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.value = initial ?? ctx.workspaceState.get<string>('gitsight.commitSearch.lastQuery', '');
  qp.items = [helpRow()];

  let inflight: AbortController | undefined;
  let runId = 0;

  const runSearch = async (raw: string) => {
    const id = ++runId;
    if (inflight) inflight.abort();
    inflight = new AbortController();
    qp.busy = true;
    try {
      if (!raw.trim()) {
        qp.items = [helpRow()];
        return;
      }
      const q = parseQuery(raw, { maxCount: defaultMax });
      const args = ['log', `--pretty=format:${FMT}`, ...buildSearchArgs(q)];
      const out = await runGit(git, args, inflight.signal);
      if (id !== runId) return; // a newer search arrived
      const hits = parseHits(out);
      qp.items = renderItems(hits, q.raw);
    } catch (e: any) {
      if (id !== runId) return;
      const message = (e?.message ?? String(e)).toString().trim();
      qp.items = [{
        label: '$(error) Search failed',
        description: message.split('\n')[0].slice(0, 200),
        detail: 'Hint: bad regex? Try `re:` prefix only with valid patterns, or quote special chars.',
      }];
    } finally {
      if (id === runId) qp.busy = false;
    }
  };

  // Debounce 200ms — feels responsive without spamming git on every keystroke.
  let debounce: NodeJS.Timeout | undefined;
  qp.onDidChangeValue((value) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(value), 200);
  });

  qp.onDidAccept(async () => {
    const picked = qp.activeItems[0];
    if (!picked) return;
    if (picked._action === 'help') return; // help row is no-op
    if (picked._action === 'open-tree') {
      await ctx.workspaceState.update('gitsight.commitSearch.lastQuery', qp.value);
      qp.hide();
      // Forward to the legacy tree-search so the user can browse results.
      const term = qp.value || '';
      await vscode.commands.executeCommand('gitsight.searchCommits');
      // Best-effort: pass the legacy input box the grep term too.
      // (gitsight.searchCommits opens its own showInputBox; we can't fill it,
      // so we just open the tree.)
      return;
    }
    if (picked._hit) {
      await ctx.workspaceState.update('gitsight.commitSearch.lastQuery', qp.value);
      qp.hide();
      await vscode.commands.executeCommand('gitsight.showCommitDetail', git, picked._hit.sha);
    }
  });

  qp.onDidTriggerItemButton(async (e) => {
    const item = e.item;
    if (!item._hit) return;
    const btn = e.button.tooltip;
    if (btn === 'Copy SHA') {
      await vscode.env.clipboard.writeText(item._hit.sha);
      vscode.window.setStatusBarMessage(`Copied ${item._hit.shortSha}`, 1500);
    } else if (btn === 'Open on remote') {
      await vscode.commands.executeCommand('gitsight.openCommitOnRemote', { git, sha: item._hit.sha });
    }
  });

  qp.onDidHide(() => {
    if (debounce) clearTimeout(debounce);
    if (inflight) inflight.abort();
    qp.dispose();
  });

  qp.show();

  // Trigger initial run if there's seeded text.
  if (qp.value) await runSearch(qp.value);
}

function renderItems(hits: ParsedHit[], rawQuery: string): SearchItem[] {
  const out: SearchItem[] = [];
  out.push({
    label: `$(search) ${describeHits(hits)}`,
    description: rawQuery ? `query: ${rawQuery}` : '',
    detail: 'Press Enter on a row to open the commit. Right side buttons: copy SHA, open on remote.',
    _action: 'help',
  });
  if (hits.length === 0) {
    out.push({
      label: '$(info) No matches — try broadening (drop author:, re:, or case:).',
      _action: 'help',
    });
    return out;
  }
  const copyBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clippy'), tooltip: 'Copy SHA' };
  const remoteBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Open on remote' };
  for (const h of hits) {
    out.push({
      label: `$(git-commit) ${h.shortSha}  ${h.subject}`,
      description: h.author,
      detail: relIso(h.dateIso),
      buttons: [copyBtn, remoteBtn],
      _hit: h,
    });
  }
  // Footer: jump-to-tree shortcut for power users who want a persistent view.
  out.push({
    label: '$(list-tree) Open results in tree view…',
    description: 'Switches to the GitSight SearchView and re-runs (subject substring only)',
    _action: 'open-tree',
  });
  return out;
}

function helpRow(): SearchItem {
  return {
    label: '$(search) Start typing to search…',
    detail: 'Examples: "parser bug" · author:alice path:src/ · re:^WIP · since:2026-01-01 case:off',
    _action: 'help',
  };
}

function runGit(git: Git, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    git.raw(args).then(resolve, reject);
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

function relIso(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
