import * as vscode from 'vscode';
import { Git, BlameLine } from '../git/git';
import { timeAgo, formatBlame } from '../git/format';

export class BlameController implements vscode.Disposable {
  private inlineDeco: vscode.TextEditorDecorationType;
  private heatmapDeco = new Map<string, vscode.TextEditorDecorationType>();
  private authorDeco = new Map<string, vscode.TextEditorDecorationType>();
  private timer?: NodeJS.Timeout;
  private cache = new Map<string, BlameLine[]>();
  private disposables: vscode.Disposable[] = [];

  constructor(private getGit: (file: string) => Git | undefined) {
    this.inlineDeco = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 3em',
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => this.scheduleInline(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e) { this.scheduleInline(e); this.renderGutter(e); } }),
      vscode.workspace.onDidSaveTextDocument(doc => this.invalidate(doc.uri.fsPath)),
      vscode.workspace.onDidChangeTextDocument(e => this.invalidate(e.document.uri.fsPath)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight')) {
          vscode.window.visibleTextEditors.forEach(ed => { this.scheduleInline(ed); this.renderGutter(ed); });
        }
      }),
    );
  }

  private invalidate(file: string) {
    this.cache.delete(file);
  }

  private scheduleInline(editor: vscode.TextEditor) {
    if (this.timer) clearTimeout(this.timer);
    const cfg = vscode.workspace.getConfiguration('gitsight.blame');
    if (!cfg.get<boolean>('enabled')) { editor.setDecorations(this.inlineDeco, []); return; }
    const delay = cfg.get<number>('delay') ?? 200;
    this.timer = setTimeout(() => this.renderInline(editor), delay);
  }

  private async loadBlame(file: string): Promise<BlameLine[] | undefined> {
    let lines = this.cache.get(file);
    if (lines) return lines;
    const git = this.getGit(file);
    if (!git) return;
    try { lines = await git.blame(file); this.cache.set(file, lines); return lines; }
    catch { return; }
  }

  private async renderInline(editor: vscode.TextEditor) {
    if (!editor || editor.document.uri.scheme !== 'file' || editor.document.isDirty) {
      editor?.setDecorations(this.inlineDeco, []); return;
    }
    const lines = await this.loadBlame(editor.document.uri.fsPath);
    if (!lines) return;
    const line = editor.selection.active.line;
    const info = lines.find(l => l.line === line + 1);
    if (!info || /^0+$/.test(info.sha)) { editor.setDecorations(this.inlineDeco, []); return; }
    const fmt = vscode.workspace.getConfiguration('gitsight.blame').get<string>('format') ?? '${author}, ${ago} • ${message}';
    const text = formatBlame(fmt, {
      author: info.author, ago: timeAgo(info.date),
      date: info.date.toLocaleDateString(), sha: info.sha.slice(0, 7), message: info.summary,
    });
    const endCol = editor.document.lineAt(line).text.length;
    editor.setDecorations(this.inlineDeco, [{
      range: new vscode.Range(line, endCol, line, endCol),
      renderOptions: { after: { contentText: `  ${text}` } },
    }]);
  }

  async renderGutter(editor: vscode.TextEditor) {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const cfg = vscode.workspace.getConfiguration('gitsight');
    const heatOn = cfg.get<boolean>('heatmap.enabled');
    const authOn = cfg.get<boolean>('authors.enabled');

    // Clear previous
    const file = editor.document.uri.fsPath;
    this.clearGutter(editor);
    if (!heatOn && !authOn) return;

    const lines = await this.loadBlame(file);
    if (!lines) return;

    if (heatOn) {
      const cold = cfg.get<number>('heatmap.coldDays') ?? 365;
      const byColor = new Map<string, vscode.Range[]>();
      for (const l of lines) {
        if (/^0+$/.test(l.sha)) continue;
        const days = (Date.now() - l.date.getTime()) / 86400000;
        const ratio = Math.min(1, days / cold);
        const hue = Math.floor(220 * ratio); // 0=red,220=blue
        const color = `hsl(${hue},70%,50%)`;
        const r = new vscode.Range(l.line - 1, 0, l.line - 1, 0);
        (byColor.get(color) ?? byColor.set(color, []).get(color)!).push(r);
      }
      for (const [color, ranges] of byColor) {
        const deco = vscode.window.createTextEditorDecorationType({
          gutterIconPath: this.dotIcon(color),
          gutterIconSize: '6px',
        });
        this.heatmapDeco.set(`${file}|${color}`, deco);
        editor.setDecorations(deco, ranges);
      }
    }
    if (authOn) {
      const byColor = new Map<string, vscode.Range[]>();
      for (const l of lines) {
        if (/^0+$/.test(l.sha)) continue;
        let h = 0; for (const c of l.author) h = (h << 5) - h + c.charCodeAt(0);
        const color = `hsl(${Math.abs(h) % 360},65%,60%)`;
        const r = new vscode.Range(l.line - 1, 0, l.line - 1, 0);
        (byColor.get(color) ?? byColor.set(color, []).get(color)!).push(r);
      }
      for (const [color, ranges] of byColor) {
        const deco = vscode.window.createTextEditorDecorationType({
          overviewRulerColor: color,
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
        this.authorDeco.set(`${file}|${color}`, deco);
        editor.setDecorations(deco, ranges);
      }
    }
  }

  private clearGutter(editor: vscode.TextEditor) {
    const file = editor.document.uri.fsPath;
    for (const [k, d] of this.heatmapDeco) if (k.startsWith(file + '|')) { d.dispose(); this.heatmapDeco.delete(k); }
    for (const [k, d] of this.authorDeco) if (k.startsWith(file + '|')) { d.dispose(); this.authorDeco.delete(k); }
  }

  private dotIcon(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="${color}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }

  dispose() {
    this.inlineDeco.dispose();
    this.heatmapDeco.forEach(d => d.dispose());
    this.authorDeco.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}
