/**
 * Forgotten-File Diagnostic (F39).
 *
 * A status-bar pill + on-demand picker that flags files the user has been
 * editing recently (within N days) but isn't currently staging. Premise:
 * a typical commit cluster is 2-5 files, and it's easy to `git add foo`
 * and forget the related test fixture or CHANGELOG line you touched on
 * Tuesday. We give you one nudge before you commit.
 *
 *   - Pill appears in the status bar (left) only when the SCM input box
 *     has text AND there's a non-empty forgotten list. Click → picker.
 *   - Picker lists each forgotten file with last-edit age + a per-row
 *     action (Open / Stage / Ignore-once for this session).
 *   - "Stage all" button on the top of the picker for the easy case.
 *
 * Configurable via:
 *   - gitsight.forgottenFiles.enabled        (default true)
 *   - gitsight.forgottenFiles.days           (default 7)
 *   - gitsight.forgottenFiles.includeClean   (default false — clean recently
 *                                            edited files are usually
 *                                            deliberate omissions, but
 *                                            opting in catches the rare
 *                                            "I committed bar.ts last week,
 *                                              forgot the test" case)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseRecentTouches,
  parsePorcelain,
  stagedPaths,
  dirtyWorktreePaths,
  findForgottenFiles,
  summariseForgotten,
  ForgottenFile,
} from '../git/forgottenFiles';
import { timeAgo } from '../git/format';

const SHOW_COMMAND = 'gitsight.forgottenFiles.show';
const RESCAN_COMMAND = 'gitsight.forgottenFiles.rescan';

export class ForgottenFilesController implements vscode.Disposable {
  private pill: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private lastFiles: ForgottenFile[] = [];
  private dismissedThisSession = new Set<string>();
  private lastScmValue = '';
  private inFlight = false;

  constructor(private repos: RepoManager) {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
    this.pill.command = SHOW_COMMAND;
    this.disposables.push(this.pill);

    this.timer = setInterval(() => this.tick().catch(() => {}), 2000);
    this.disposables.push(
      { dispose: () => clearInterval(this.timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.forgottenFiles')) this.tick().catch(() => {});
      }),
      this.repos.onDidChange(() => this.tick().catch(() => {})),
    );
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(SHOW_COMMAND, () => this.showPicker().catch(e =>
        vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`),
      )),
      vscode.commands.registerCommand(RESCAN_COMMAND, async () => {
        await this.tick();
        vscode.window.setStatusBarMessage('GitSight: rescanned for forgotten files', 2000);
      }),
    ];
  }

  private async tick() {
    const cfg = vscode.workspace.getConfiguration('gitsight.forgottenFiles');
    if (!cfg.get<boolean>('enabled', true)) { this.pill.hide(); return; }
    const value = readScmInput();
    // Only show the pill while a commit is being composed.
    if (value == null || !value.trim()) { this.pill.hide(); this.lastScmValue = value ?? ''; return; }
    // Rescan when SCM value changed (cheap optimisation: don't shell out on every tick).
    const needScan = value !== this.lastScmValue || this.lastFiles.length === 0;
    this.lastScmValue = value;
    if (needScan) await this.rescan(cfg);
    this.refreshPill();
  }

  private async rescan(cfg: vscode.WorkspaceConfiguration) {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const git = this.repos.primary();
      if (!git) { this.lastFiles = []; return; }
      const days = clampInt(cfg.get<number>('days', 7), 1, 90);
      const includeClean = cfg.get<boolean>('includeClean', false);
      const email = await safe(git, ['config', 'user.email']);
      const me = email.trim();
      // 1. Recent touches by the user (limit author to avoid flagging files
      //    teammates edited in shared worktrees).
      const logArgs = [
        'log',
        `--since=${days}.days`,
        '--name-only',
        '--no-merges',
        '--pretty=format:%H|%aI',
      ];
      if (me) logArgs.push(`--author=${me}`);
      const [logOut, porcelainOut] = await Promise.all([
        safe(git, logArgs),
        safe(git, ['status', '--porcelain=v1']),
      ]);
      const recent = parseRecentTouches(logOut);
      const rows = parsePorcelain(porcelainOut);
      const staged = stagedPaths(rows);
      const dirty = dirtyWorktreePaths(rows);
      const files = findForgottenFiles({
        recent,
        staged,
        dirtyWorktree: dirty,
        excludePaths: [...this.dismissedThisSession],
        ignoreClean: !includeClean,
      });
      this.lastFiles = files;
    } finally {
      this.inFlight = false;
    }
  }

  private refreshPill() {
    if (!this.lastFiles.length) { this.pill.hide(); return; }
    this.pill.text = `$(eye-closed) ${this.lastFiles.length} forgotten`;
    this.pill.tooltip = new vscode.MarkdownString(
      `**GitSight: forgotten files**  \n${summariseForgotten(this.lastFiles)}\n\nClick to review.`,
    );
    this.pill.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.pill.show();
  }

  private async showPicker() {
    const git = this.repos.primary();
    if (!git) return;
    if (!this.lastFiles.length) {
      vscode.window.showInformationMessage('GitSight: no forgotten edits — your stage looks complete.');
      return;
    }
    type Pk = vscode.QuickPickItem & { _action: 'stage-all' | 'open' | 'stage' | 'ignore'; _file?: ForgottenFile };
    const items: Pk[] = [];
    items.push({
      label: '$(check-all) Stage all forgotten files',
      detail: `Runs git add on the ${this.lastFiles.length} file${this.lastFiles.length === 1 ? '' : 's'} below`,
      _action: 'stage-all',
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, _action: 'open' });
    const now = Date.now();
    for (const f of this.lastFiles) {
      const age = ageLabel(f.lastTouchedIso, now);
      items.push({
        label: `$(file) ${f.path}`,
        description: `${age}${f.dirtyButUnstaged ? '  ·  dirty' : '  ·  clean'}`,
        _action: 'open',
        _file: f,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: summariseForgotten(this.lastFiles),
      matchOnDescription: true,
    });
    if (!picked) return;
    if (picked._action === 'stage-all') {
      await this.stageAll(git);
      return;
    }
    if (!picked._file) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(go-to-file) Open file', _id: 'open' as const },
        { label: '$(add) Stage file', _id: 'stage' as const },
        { label: '$(eye-closed) Ignore for this session', _id: 'ignore' as const },
      ],
      { placeHolder: picked._file.path },
    );
    if (!action) return;
    if (action._id === 'open') {
      const uri = vscode.Uri.file(path.join(git.cwd, picked._file.path));
      await vscode.commands.executeCommand('vscode.open', uri);
    } else if (action._id === 'stage') {
      await this.stageOne(git, picked._file.path);
    } else if (action._id === 'ignore') {
      this.dismissedThisSession.add(picked._file.path);
      vscode.window.setStatusBarMessage(`GitSight: ignoring ${picked._file.path} for this session`, 2500);
      await this.tick();
    }
  }

  private async stageAll(git: Git) {
    const paths = this.lastFiles.map(f => f.path);
    if (!paths.length) return;
    try {
      await git.raw(['add', '--', ...paths]);
      vscode.window.setStatusBarMessage(`GitSight: staged ${paths.length} forgotten file${paths.length === 1 ? '' : 's'}`, 3000);
      vscode.commands.executeCommand('gitsight.refresh');
      await this.tick();
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: stage-all failed: ${e.message}`);
    }
  }

  private async stageOne(git: Git, path: string) {
    try {
      await git.raw(['add', '--', path]);
      vscode.window.setStatusBarMessage(`GitSight: staged ${path}`, 2500);
      vscode.commands.executeCommand('gitsight.refresh');
      await this.tick();
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: stage failed: ${e.message}`);
    }
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }
}

function ageLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return timeAgo(new Date(t));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function readScmInput(): string | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt || !gitExt.isActive) return null;
    const api = gitExt.exports?.getAPI?.(1);
    const repo = api?.repositories?.[0];
    if (!repo) return null;
    return repo.inputBox?.value ?? '';
  } catch {
    return null;
  }
}
