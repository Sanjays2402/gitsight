/**
 * SCM Pre-Commit-Message Scaffold (F60).
 *
 * Passive controller — polls the built-in git extension's SCM input box on
 * a 2 s timer. When the input is empty AND the staging area has a small,
 * coherent set of paths whose `suggestType`/`suggestScope` produces a
 * non-default answer, write a conventional-commit header into the input
 * box (e.g. `feat(git): `) so the user only has to type the verb.
 *
 * Rules (decideScaffold in src/git/commitScaffold.ts):
 *   - Skipped when the input already has any non-whitespace text.
 *   - Skipped when staging is empty or > maxPaths (default 8).
 *   - Skipped when suggestType confidence < 0.7 (default `feat`@0.4 doesn't
 *     trigger — we don't write `feat: ` on a single-file mystery edit).
 *   - Skipped when suggestScope returns undefined and scaffoldWithoutScope
 *     is false. Headers without a scope are noise; better to stay silent.
 *
 * Once a scaffold is written, we remember the value we wrote so we can
 * SAFELY rescaffold when the staging changes (the user hasn't typed yet).
 * If the user has typed past our scaffold, we never touch it again until
 * they clear the box.
 *
 * Configurable via:
 *   gitsight.commitScaffold.enabled        (default true)
 *   gitsight.commitScaffold.maxPaths       (default 8)
 *   gitsight.commitScaffold.minConfidence  (default 0.7)
 *   gitsight.commitScaffold.scaffoldWithoutScope (default false)
 */
import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  decideScaffold,
  isScaffoldShaped,
  stagingChanged,
} from '../git/commitScaffold';

const APPLY_COMMAND = 'gitsight.commitScaffold.apply';

export class CommitScaffoldController implements vscode.Disposable {
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private lastWrittenScaffold = '';
  private lastStaged: string[] = [];
  private inFlight = false;

  constructor(private repos: RepoManager) {
    this.timer = setInterval(() => this.tick().catch(() => {}), 2000);
    this.disposables.push(
      { dispose: () => clearInterval(this.timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.commitScaffold')) this.tick().catch(() => {});
      }),
      this.repos.onDidChange(() => this.tick().catch(() => {})),
    );
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(APPLY_COMMAND, () => this.applyOnDemand().catch(e =>
        vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`),
      )),
    ];
  }

  /** Manual command — force a rescaffold even if the heuristic would skip. */
  private async applyOnDemand() {
    const git = this.repos.primary();
    if (!git) return;
    const staged = await loadStaged(git);
    if (!staged.length) {
      vscode.window.showInformationMessage('GitSight: nothing staged to scaffold a commit message from.');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('gitsight.commitScaffold');
    const decision = decideScaffold({
      inputValue: '',
      stagedPaths: staged,
      maxPathsForScaffold: cfg.get<number>('maxPaths', 8),
      minTypeConfidence: 0,            // force-evaluate
      scaffoldWithoutScope: true,      // force-write
      enabled: true,
    });
    if (!decision.shouldScaffold || !decision.header) {
      vscode.window.showInformationMessage('GitSight: no scaffold could be derived from the current staging.');
      return;
    }
    const repo = primarySvcRepo();
    if (!repo) {
      vscode.window.showWarningMessage('GitSight: built-in git extension not active, cannot write to SCM input.');
      return;
    }
    repo.inputBox.value = decision.header;
    this.lastWrittenScaffold = decision.header;
    this.lastStaged = staged;
    vscode.window.setStatusBarMessage('GitSight: scaffolded commit header.', 2000);
  }

  private async tick() {
    const cfg = vscode.workspace.getConfiguration('gitsight.commitScaffold');
    if (!cfg.get<boolean>('enabled', true)) return;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const repo = primarySvcRepo();
      if (!repo) return;
      const currentInput: string = repo.inputBox?.value ?? '';
      const git = this.repos.primary();
      if (!git) return;
      const staged = await loadStaged(git);
      const stagingDidChange = stagingChanged(this.lastStaged, staged);
      this.lastStaged = staged;

      // If our previous scaffold is still verbatim in the input, treat the
      // input as effectively empty for the purposes of deciding the next
      // scaffold — the user hasn't typed anything past our prefix.
      const inputForDecision = currentInput === this.lastWrittenScaffold ? '' : currentInput;
      const decision = decideScaffold({
        inputValue: inputForDecision,
        stagedPaths: staged,
        maxPathsForScaffold: cfg.get<number>('maxPaths', 8),
        minTypeConfidence: cfg.get<number>('minConfidence', 0.7),
        scaffoldWithoutScope: cfg.get<boolean>('scaffoldWithoutScope', false),
        enabled: true,
      });

      if (!decision.shouldScaffold || !decision.header) {
        // If the user wiped the input AND there's still a header we wrote,
        // clear our memory so the next valid trigger writes fresh.
        if (!currentInput.trim()) this.lastWrittenScaffold = '';
        return;
      }

      // Only WRITE when:
      //   - the input is empty, OR
      //   - the input still contains exactly our previous scaffold AND the
      //     staging changed (so the type/scope might have changed too).
      const shouldWrite =
        currentInput.length === 0 ||
        (currentInput === this.lastWrittenScaffold && stagingDidChange);
      if (!shouldWrite) {
        // Detect "user kept our header and typed a subject" — leave them alone.
        const shape = isScaffoldShaped(currentInput);
        if (shape && shape.subjectLength > 0) {
          // User is composing; do nothing.
        }
        return;
      }

      if (currentInput === decision.header) return; // nothing to do
      repo.inputBox.value = decision.header;
      this.lastWrittenScaffold = decision.header;
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

async function loadStaged(git: Git): Promise<string[]> {
  try {
    const out = await git.raw(['diff', '--cached', '--name-only']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function primarySvcRepo(): any | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt || !gitExt.isActive) return null;
    const api = gitExt.exports?.getAPI?.(1);
    return api?.repositories?.[0] ?? null;
  } catch {
    return null;
  }
}
