import * as vscode from 'vscode';
import { Git } from '../git/git';

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export class CommitSparkline implements vscode.Disposable {
  private status: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;

  constructor(private readonly getGit: () => Git | undefined) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.status.command = 'gitsight.activityHeatmap';
    this.poll();
    this.timer = setInterval(() => this.poll(), 5 * 60_000);
  }

  dispose() { if (this.timer) clearInterval(this.timer); this.status.dispose(); }

  private async poll() {
    const git = this.getGit(); if (!git) { this.status.hide(); return; }
    try {
      const cfg = vscode.workspace.getConfiguration('gitsight');
      const days = cfg.get<number>('sparkline.days', 14);
      const author = cfg.get<string>('sparkline.author', 'all'); // 'me' | 'all'
      const args = ['log', `--since=${days}.days.ago`, '--pretty=format:%cI'];
      if (author === 'me') {
        const email = (await git.raw(['config', 'user.email']).catch(() => '')).trim();
        if (email) args.push(`--author=${email}`);
      }
      const out = await git.raw(args).catch(() => '');
      const counts = new Array(days).fill(0);
      const now = Date.now();
      const dayMs = 86_400_000;
      for (const line of out.split('\n')) {
        if (!line) continue;
        const t = Date.parse(line);
        if (isNaN(t)) continue;
        const idx = days - 1 - Math.floor((now - t) / dayMs);
        if (idx >= 0 && idx < days) counts[idx]++;
      }
      const max = Math.max(1, ...counts);
      const spark = counts.map(c => c === 0 ? BARS[0] : BARS[Math.min(BARS.length - 1, Math.floor((c / max) * (BARS.length - 1)))]).join('');
      const total = counts.reduce((a, b) => a + b, 0);
      this.status.text = `$(graph-line) ${spark} ${total}`;
      this.status.tooltip = `Commits over last ${days} days ${author === 'me' ? '(you)' : '(all)'}\nTotal: ${total}\nClick to open the activity heatmap.`;
      this.status.show();
    } catch {
      this.status.hide();
    }
  }
}
