import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git, Commit } from '../git/git';
import { timeAgo, colorForAuthor } from '../git/format';
import { activePalette } from '../views/graphThemes';
import { buildStandaloneSvg, buildExportFilename, buildSvgDataUrl, parsePngDataUrl, buildPrintHtml, classifyPdfExport, estimateSvgBytes, ExportRow } from '../git/commitGraphExport';

export class CommitGraphPanel {
  private static current?: CommitGraphPanel;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  /** Cache of the last-rendered rows so the export command can build
   *  the same SVG fragment the webview is showing. */
  private lastRender?: {
    rowsSvg: string;
    graphWidth: number;
    rowHeight: number;
    rowCount: number;
    rows: ExportRow[];
  };

  static show(ctx: vscode.ExtensionContext, git: Git) {
    if (CommitGraphPanel.current) {
      CommitGraphPanel.current.panel.reveal();
      CommitGraphPanel.current.refresh(git);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gitsight.commitGraph', 'GitSight: Commit Graph',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    CommitGraphPanel.current = new CommitGraphPanel(panel, git);
  }

  private constructor(panel: vscode.WebviewPanel, private git: Git) {
    this.panel = panel;
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'showCommit') {
        try {
          const out = await git.show(msg.sha);
          const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        } catch (e: any) {
          vscode.window.showErrorMessage(`GitSight: ${e.message}`);
        }
      } else if (msg.type === 'copySha') {
        await vscode.env.clipboard.writeText(msg.sha);
        vscode.window.setStatusBarMessage(`Copied ${msg.sha.slice(0, 7)}`, 1500);
      } else if (msg.type === 'refresh') {
        await this.refresh(git);
      } else if (msg.type === 'search') {
        await this.refresh(git, msg.q);
      } else if (msg.type === 'exportSvg') {
        await this.exportSvg(git);
      } else if (msg.type === 'exportPng') {
        await this.exportPng(git);
      } else if (msg.type === 'exportPngBytes') {
        await this.writePngBytes(git, msg.dataUrl);
      } else if (msg.type === 'exportPngFailed') {
        vscode.window.showErrorMessage(`GitSight: PNG export failed: ${msg.reason ?? 'unknown'}`);
      } else if (msg.type === 'exportPdf') {
        await this.exportPdf(git);
      }
    });
    this.refresh(git);
  }

  async refresh(git: Git, search?: string) {
    const cfg = vscode.workspace.getConfiguration('gitsight.graph');
    const max = cfg.get<number>('maxCommits') ?? 1000;
    const all = cfg.get<boolean>('showAllBranches') ?? true;
    try {
      const commits = await git.log({ max, all, grep: search });
      const rendered = renderGraph(commits, search ?? '');
      this.lastRender = rendered.exportData;
      this.panel.webview.html = rendered.html;
    } catch (e: any) {
      this.panel.webview.html = `<pre style="padding:16px;color:#e44">${escape(e.message)}</pre>`;
    }
  }

  /**
   * F61 - export the current graph as a standalone SVG file written to
   * the workspace root with a timestamped filename. Shows a "Reveal in
   * Finder" / "Open" follow-up.
   */
  private async exportSvg(git: Git): Promise<void> {
    if (!this.lastRender || this.lastRender.rowCount === 0) {
      vscode.window.showInformationMessage('GitSight: nothing to export \u2014 no commits in the current view.');
      return;
    }
    const built = this.buildSvgForExport(git);
    const filename = buildExportFilename(new Date(), 'svg');
    const target = await this.resolveExportTarget(git, filename);
    if (!target) return;
    try {
      await fs.writeFile(target, built.svg, 'utf8');
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: export failed: ${e.message ?? e}`);
      return;
    }
    await this.surfaceExportSuccess(target, filename, built.width, built.height);
  }

  /**
   * F83 - export the current graph as a PNG. Two-phase:
   *   1. Extension builds the standalone SVG and posts it to the webview.
   *   2. Webview draws the SVG into a canvas, calls toDataURL('image/png'),
   *      posts the data URL back via `exportPngBytes`.
   *   3. Extension decodes the base64 portion and writes the file.
   *
   * The webview path is mandatory: Node has no canvas implementation
   * without a binary dep, and we don't want to ship `canvas` as a
   * package dependency. The webview already runs a Chromium-grade DOM.
   */
  private async exportPng(_git: Git): Promise<void> {
    if (!this.lastRender || this.lastRender.rowCount === 0) {
      vscode.window.showInformationMessage('GitSight: nothing to export \u2014 no commits in the current view.');
      return;
    }
    const built = this.buildSvgForExport(this.git);
    // Post the SVG to the webview so it can rasterise. Use a base64-encoded
    // data URL (rather than a raw string) to dodge transport quoting issues.
    const dataUrl = buildSvgDataUrl(built.svg, s => Buffer.from(s, 'utf8').toString('base64'));
    void this.panel.webview.postMessage({
      type: 'rasterisePng',
      svgDataUrl: dataUrl,
      width: built.width,
      height: built.height,
    });
    // The webview will reply with `exportPngBytes` (success) or
    // `exportPngFailed` (failure); both are handled in onDidReceiveMessage.
    vscode.window.setStatusBarMessage('GitSight: rasterising commit graph PNG\u2026', 4000);
  }

  private async writePngBytes(git: Git, dataUrl: unknown): Promise<void> {
    const decoded = parsePngDataUrl(dataUrl);
    if (!decoded.ok) {
      vscode.window.showErrorMessage(`GitSight: PNG export returned an unexpected payload: ${decoded.reason}`);
      return;
    }
    const filename = buildExportFilename(new Date(), 'png');
    const target = await this.resolveExportTarget(git, filename);
    if (!target) return;
    try {
      const buf = Buffer.from(decoded.base64, 'base64');
      await fs.writeFile(target, buf);
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: PNG export failed: ${e.message ?? e}`);
      return;
    }
    await this.surfaceExportSuccess(target, filename);
  }

  /**
   * F132 - PDF export. The webview side opens a transient print window
   * with media:print stylesheet that scales the SVG to a single page,
   * then calls window.print() so the user can save as PDF via the
   * system print dialog. We can't write PDF bytes from a webview
   * (no Chromium PDF API exposed) but print-to-PDF is universally
   * available across macOS, Linux, and Windows.
   *
   * Why not generate the PDF in the extension side? Same reason as F83:
   * Node has no PDF rendering without a heavy binary dep (we don't ship
   * puppeteer / playwright as a dependency). The webview already has a
   * Chromium-grade DOM that owns this surface.
   */
  private async exportPdf(_git: Git): Promise<void> {
    if (!this.lastRender || this.lastRender.rowCount === 0) {
      vscode.window.showInformationMessage('GitSight: nothing to export \u2014 no commits in the current view.');
      return;
    }
    const estimated = estimateSvgBytes(this.lastRender.rowCount);
    const verdict = classifyPdfExport({ rowCount: this.lastRender.rowCount, estimatedBytes: estimated });
    if (verdict === 'no-graph') {
      vscode.window.showInformationMessage('GitSight: nothing to export.');
      return;
    }
    if (verdict === 'too-large') {
      vscode.window.showWarningMessage('GitSight: graph is too large for PDF export. Consider filtering to a shorter range or using SVG/PNG instead.');
      return;
    }
    const built = this.buildSvgForExport(this.git);
    const html = buildPrintHtml({
      svg: built.svg,
      svgWidth: built.width,
      svgHeight: built.height,
      title: `GitSight Commit Graph (${this.lastRender.rowCount} commits)`,
    });
    // Post to the webview - it opens an iframe with the print HTML
    // and calls window.print() once the iframe has loaded.
    void this.panel.webview.postMessage({
      type: 'printPdf',
      html,
    });
    vscode.window.setStatusBarMessage('GitSight: opening print dialog\u2014pick "Save as PDF"', 6000);
  }

  private buildSvgForExport(git: Git): { svg: string; width: number; height: number } {
    return buildStandaloneSvg({
      rowsSvg: this.lastRender!.rowsSvg,
      graphWidth: this.lastRender!.graphWidth,
      rowHeight: this.lastRender!.rowHeight,
      rowCount: this.lastRender!.rowCount,
      rows: this.lastRender!.rows,
      title: `GitSight \u2014 ${path.basename(git.cwd)}`,
    });
  }

  private async resolveExportTarget(git: Git, filename: string): Promise<string | undefined> {
    const cfg = vscode.workspace.getConfiguration('gitsight.graphExport');
    const dirRaw = cfg.get<string>('directory', '').trim();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? git.cwd;
    const outDir = dirRaw ? path.resolve(folder, dirRaw) : folder;
    try {
      await fs.mkdir(outDir, { recursive: true });
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: could not create export dir ${outDir}: ${e.message ?? e}`);
      return undefined;
    }
    return path.join(outDir, filename);
  }

  private async surfaceExportSuccess(target: string, filename: string, width?: number, height?: number): Promise<void> {
    const dims = (width && height) ? ` (${width}\u00d7${height})` : '';
    const choice = await vscode.window.showInformationMessage(
      `GitSight: exported ${filename}${dims}`,
      'Reveal in OS', 'Open',
    );
    if (choice === 'Reveal in OS') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    } else if (choice === 'Open') {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch {
        // PNG can't be opened as a text doc - reveal instead.
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
      }
    }
  }

  dispose() {
    CommitGraphPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface RenderResult {
  html: string;
  exportData: {
    rowsSvg: string;
    graphWidth: number;
    rowHeight: number;
    rowCount: number;
    rows: ExportRow[];
  };
}

function renderGraph(commits: Commit[], search: string): RenderResult {
  type Lane = { sha: string; color: string };
  const lanes: (Lane | null)[] = [];
  const rows: { commit: Commit; lane: number; lanes: (Lane | null)[]; color: string }[] = [];
  const palette = activePalette();
  let colorIdx = 0;
  const byParent = new Map<string, number>();

  for (const c of commits) {
    let laneIdx = byParent.get(c.sha);
    let color: string;
    if (laneIdx === undefined) {
      laneIdx = lanes.findIndex(l => l === null);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(null); }
      color = palette[colorIdx++ % palette.length];
    } else color = lanes[laneIdx]!.color;
    lanes[laneIdx] = { sha: c.sha, color };
    const snapshot = lanes.map(l => (l ? { ...l } : null));

    if (c.parents.length === 0) lanes[laneIdx] = null;
    else {
      lanes[laneIdx] = { sha: c.parents[0], color };
      byParent.set(c.parents[0], laneIdx);
      for (let i = 1; i < c.parents.length; i++) {
        let n = lanes.findIndex(l => l === null);
        if (n === -1) { n = lanes.length; lanes.push(null); }
        const pc = palette[colorIdx++ % palette.length];
        lanes[n] = { sha: c.parents[i], color: pc };
        byParent.set(c.parents[i], n);
      }
    }
    rows.push({ commit: c, lane: laneIdx, lanes: snapshot, color });
  }

  const rowH = 28, colW = 16;
  const maxLanes = Math.max(...rows.map(r => r.lanes.length), 1);
  const graphW = maxLanes * colW + 10;

  const svgRows = rows.map((r, i) => {
    const cx = r.lane * colW + colW / 2 + 5;
    const nextLanes = rows[i + 1]?.lanes ?? [];
    const parts: string[] = [];
    r.lanes.forEach((l, idx) => {
      if (!l) return;
      const x = idx * colW + colW / 2 + 5;
      parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${rowH / 2}" stroke="${l.color}" stroke-width="2"/>`);
      const continues = nextLanes.some((nl, ni) => nl && nl.sha === l.sha && ni === idx);
      if (continues) parts.push(`<line x1="${x}" y1="${rowH / 2}" x2="${x}" y2="${rowH}" stroke="${l.color}" stroke-width="2"/>`);
    });
    r.commit.parents.forEach(p => {
      const nIdx = nextLanes.findIndex(nl => nl && nl.sha === p);
      if (nIdx === -1) return;
      const nx = nIdx * colW + colW / 2 + 5;
      if (nx === cx) parts.push(`<line x1="${cx}" y1="${rowH / 2}" x2="${nx}" y2="${rowH}" stroke="${r.color}" stroke-width="2"/>`);
      else parts.push(`<path d="M${cx},${rowH / 2} C${cx},${rowH * 0.85} ${nx},${rowH * 0.5} ${nx},${rowH}" stroke="${r.color}" stroke-width="2" fill="none"/>`);
    });
    parts.push(`<circle cx="${cx}" cy="${rowH / 2}" r="5" fill="${r.color}" stroke="var(--vscode-editor-background)" stroke-width="2"/>`);
    return `<g transform="translate(0,${i * rowH})">${parts.join('')}</g>`;
  }).join('');

  const list = rows.map(r => {
    const refsHtml = r.commit.refs.map(ref => {
      const cls = ref.startsWith('tag:') ? 'tag' : ref === 'HEAD' || ref.includes('HEAD') ? 'head' : ref.includes('/') ? 'remote' : 'branch';
      return `<span class="ref ${cls}">${escape(ref.replace(/^tag: /, ''))}</span>`;
    }).join('');
    return `
    <div class="row" data-sha="${r.commit.sha}" style="height:${28}px">
      <span class="refs">${refsHtml}</span>
      <span class="subject">${escape(r.commit.subject)}</span>
      <span class="meta">
        <span class="author" style="color:${colorForAuthor(r.commit.author)}">${escape(r.commit.author)}</span>
        <span class="ago">${timeAgo(r.commit.date)}</span>
        <span class="sha" data-sha="${r.commit.sha}" title="Click to copy">${r.commit.shortSha}</span>
      </span>
    </div>`;
  }).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark light; }
  body { margin:0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size: 13px; }
  .toolbar { display:flex; padding:8px 12px; gap:8px; border-bottom:1px solid var(--vscode-panel-border); position:sticky; top:0; background:var(--vscode-editor-background); z-index:10; align-items:center; }
  .toolbar input { flex:1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 3px; }
  .toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .stats { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .wrap { display: flex; }
  .graph { width: ${graphW}px; min-width: ${graphW}px; background: var(--vscode-editorWidget-background); }
  .list { flex: 1; overflow-x: hidden; }
  .row { display: flex; align-items: center; padding: 0 12px; gap: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; border-bottom: 1px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.active { background: var(--vscode-list-activeSelectionBackground); }
  .subject { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; gap: 12px; color: var(--vscode-descriptionForeground); font-size: 11px; align-items: center; }
  .sha { font-family: var(--vscode-editor-font-family); cursor: copy; padding: 1px 4px; border-radius: 2px; }
  .sha:hover { background: var(--vscode-toolbar-hoverBackground); }
  .refs { display:flex; gap: 4px; }
  .ref { padding: 1px 6px; border-radius: 3px; font-size: 10px; }
  .ref.branch { background: #2563eb22; color: #60a5fa; border:1px solid #60a5fa55; }
  .ref.remote { background: #16a34a22; color: #4ade80; border:1px solid #4ade8055; }
  .ref.tag    { background: #d9770622; color: #fbbf24; border:1px solid #fbbf2455; }
  .ref.head   { background: #dc262622; color: #f87171; border:1px solid #f8717155; font-weight:600; }
</style></head>
<body>
<div class="toolbar">
  <input id="search" placeholder="Search commits by message…" value="${escape(search)}"/>
  <button id="refresh">Refresh</button>
  <button id="export" title="Export the current graph view as a standalone SVG">Export SVG</button>
  <button id="exportPng" title="Export the current graph view as a PNG (rasterised in the webview)">Export PNG</button>
  <button id="exportPdf" title="Export the current graph view as a PDF (via system print dialog)">Export PDF</button>
  <span class="stats">${rows.length} commits</span>
</div>
<div class="wrap">
  <svg class="graph" width="${graphW}" height="${rows.length * rowH}" xmlns="http://www.w3.org/2000/svg">${svgRows}</svg>
  <div class="list">${list}</div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.row').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('sha')) return;
      document.querySelectorAll('.row.active').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      vscode.postMessage({ type: 'showCommit', sha: el.dataset.sha });
    });
  });
  document.querySelectorAll('.sha').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'copySha', sha: el.dataset.sha });
    });
  });
  const input = document.getElementById('search');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => vscode.postMessage({ type: 'search', q: input.value }), 300);
  });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('export').addEventListener('click', () => vscode.postMessage({ type: 'exportSvg' }));
  document.getElementById('exportPng').addEventListener('click', () => vscode.postMessage({ type: 'exportPng' }));
  document.getElementById('exportPdf').addEventListener('click', () => vscode.postMessage({ type: 'exportPdf' }));

  // F83: PNG rasterisation. The extension posts a 'rasterisePng' message
  // with a base64 SVG data URL + the intended canvas dimensions. We
  // draw it onto a high-DPR canvas and post back the PNG data URL.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'rasterisePng') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(msg.width * dpr);
          canvas.height = Math.floor(msg.height * dpr);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('2d context unavailable');
          ctx.scale(dpr, dpr);
          ctx.drawImage(img, 0, 0, msg.width, msg.height);
          const dataUrl = canvas.toDataURL('image/png');
          vscode.postMessage({ type: 'exportPngBytes', dataUrl });
        } catch (e) {
          vscode.postMessage({ type: 'exportPngFailed', reason: (e && e.message) || String(e) });
        }
      };
      img.onerror = () => {
        vscode.postMessage({ type: 'exportPngFailed', reason: 'SVG image failed to load' });
      };
      img.src = msg.svgDataUrl;
    } else if (msg && msg.type === 'printPdf') {
      // F132: PDF print. Open a transient iframe with the print-only HTML,
      // wait for it to load, then invoke window.print() via the iframe's
      // contentWindow so the user gets the system print dialog scoped to
      // the standalone SVG document. Clean up the iframe afterwards.
      try {
        let iframe = document.getElementById('gitsight-print-iframe');
        if (iframe) iframe.parentNode && iframe.parentNode.removeChild(iframe);
        iframe = document.createElement('iframe');
        iframe.id = 'gitsight-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        iframe.setAttribute('aria-hidden', 'true');
        document.body.appendChild(iframe);
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (!doc) throw new Error('iframe document unavailable');
        doc.open();
        doc.write(msg.html);
        doc.close();
        // Wait for layout; some browsers need a tick before print() works.
        setTimeout(() => {
          try {
            if (iframe.contentWindow) {
              iframe.contentWindow.focus();
              iframe.contentWindow.print();
            }
          } catch (e) {
            // Last resort: navigate the host to the HTML so the user can print manually.
            console.error('print failed', e);
          }
        }, 250);
      } catch (e) {
        console.error('PDF export iframe setup failed', e);
      }
    }
  });
</script>
</body></html>`;

  return { html, exportData: {
    rowsSvg: svgRows,
    graphWidth: graphW,
    rowHeight: rowH,
    rowCount: rows.length,
    rows: rows.map((r, i) => ({
      shortSha: r.commit.shortSha,
      subject: r.commit.subject,
      author: r.commit.author,
      relativeDate: timeAgo(r.commit.date),
      y: i * rowH,
    })),
  } };
}

