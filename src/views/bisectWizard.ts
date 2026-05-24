import * as vscode from 'vscode';
import { Git } from '../git/git';

/**
 * Bisect wizard — wraps `git bisect start/good/bad/skip/reset/run`.
 * Status bar updates with current step + remaining estimate.
 */
export class BisectWizard implements vscode.Disposable {
  private status: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly getGit: () => Git | undefined) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    this.status.command = 'gitsight.bisectMenu';
    this.disposables.push(this.status);
    this.refresh();
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }

  async refresh() {
    const git = this.getGit();
    if (!git) { this.status.hide(); return; }
    try {
      const log = await git.raw(['bisect', 'log']);
      if (log.trim()) {
        const head = await git.raw(['rev-parse', '--short', 'HEAD']).then(s => s.trim()).catch(() => '');
        this.status.text = `$(beaker) Bisect @ ${head}`;
        this.status.tooltip = 'Click for bisect actions';
        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.status.show();
      } else {
        this.status.hide();
      }
    } catch {
      this.status.hide();
    }
  }

  async start() {
    const git = this.getGit(); if (!git) return;
    const bad = await vscode.window.showInputBox({
      prompt: 'Known BAD commit (defaults to HEAD)',
      value: 'HEAD',
    });
    if (bad === undefined) return;
    const good = await vscode.window.showInputBox({
      prompt: 'Known GOOD commit (e.g. a tag, an older SHA)',
      placeHolder: 'v1.0.0 or abc1234',
    });
    if (!good) return;
    await git.raw(['bisect', 'start', bad || 'HEAD', good]);
    vscode.window.showInformationMessage(`Bisect started. Test current commit and mark good/bad.`);
    this.refresh();
  }

  async mark(verdict: 'good' | 'bad' | 'skip') {
    const git = this.getGit(); if (!git) return;
    const out = await git.raw(['bisect', verdict]);
    if (/is the first bad commit/i.test(out)) {
      vscode.window.showInformationMessage('🎯 First bad commit found! See output.');
      const doc = await vscode.workspace.openTextDocument({ content: out, language: 'log' });
      vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } else {
      vscode.window.setStatusBarMessage(`bisect ${verdict}: ${out.split('\n')[0]}`, 4000);
    }
    this.refresh();
  }

  async reset() {
    const git = this.getGit(); if (!git) return;
    await git.raw(['bisect', 'reset']);
    vscode.window.showInformationMessage('Bisect reset.');
    this.refresh();
  }

  async run() {
    const git = this.getGit(); if (!git) return;
    const cmd = await vscode.window.showInputBox({
      prompt: 'Test command (non-zero exit = bad, 0 = good)',
      placeHolder: 'npm test',
    });
    if (!cmd) return;
    const term = vscode.window.createTerminal({ name: 'GitSight Bisect Run', cwd: git.cwd });
    term.sendText(`git bisect run sh -c ${JSON.stringify(cmd)}`);
    term.show();
  }

  async menu() {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(check) Mark current as GOOD', _v: 'good' },
        { label: '$(error) Mark current as BAD', _v: 'bad' },
        { label: '$(circle-slash) Skip current', _v: 'skip' },
        { label: '$(terminal) Run automated bisect…', _v: 'run' },
        { label: '$(close) Reset (abort bisect)', _v: 'reset' },
      ],
      { placeHolder: 'Bisect actions' },
    );
    if (!picked) return;
    if (picked._v === 'good' || picked._v === 'bad' || picked._v === 'skip') return this.mark(picked._v);
    if (picked._v === 'run') return this.run();
    if (picked._v === 'reset') return this.reset();
  }
}
