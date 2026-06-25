/**
 * Graph SVG export (W15).
 *
 * Builds a standalone, self-contained SVG of the CURRENT graph view
 * (honouring the active filter + lane palette) and triggers a browser
 * download. REUSES the shared renderer end-to-end — the same
 * `assignLanes` + `buildLaneSvg` the on-screen graph uses, wrapped by the
 * shared `buildStandaloneSvg` the VS Code webview export also uses. Zero
 * forked geometry, zero forked document template.
 *
 * The pure document assembly is delegated to @shared/graphExport; this
 * module only adapts the snapshot into export rows and owns the
 * Blob/anchor download side effect (kept thin so the rest is testable).
 */

import { assignLanes, buildLaneSvg } from '@shared/graphCore';
import { paletteFor } from '@shared/graphPalette';
import {
  buildStandaloneSvg,
  buildExportFilename,
  type ExportRow,
  type BuiltSvg,
} from '@shared/graphExport';
import { parseQuery, commitMatchesQuery } from '@shared/commitQuery';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';
import { timeAgo } from './format';

const ROW_H = 30;
const COL_W = 16;

export interface ExportThemeColours {
  background: string;
  foreground: string;
  muted: string;
}

export interface BuildExportOptions {
  theme?: string;
  filter?: string;
  title?: string;
  colours?: ExportThemeColours;
  /** Injectable clock for stable relative dates / filenames in tests. */
  now?: Date;
}

export interface GraphExport extends BuiltSvg {
  filename: string;
  rowCount: number;
}

/**
 * Build the standalone SVG for a snapshot + filter + palette. Pure: no
 * DOM, no download — returns the SVG string, dimensions, and a
 * timestamped filename. The download wrapper calls this.
 */
export function buildGraphExport(snapshot: GraphSnapshot, opts: BuildExportOptions = {}): GraphExport {
  const palette = paletteFor(opts.theme);
  const query = parseQuery(opts.filter ?? '');
  const commits =
    query.terms.length === 0
      ? snapshot.commits
      : snapshot.commits.filter((c: GraphSnapshotCommit) => commitMatchesQuery(c, query));

  const rows = assignLanes(commits, palette);
  const lane = buildLaneSvg(rows, { rowHeight: ROW_H, colWidth: COL_W, nodeStroke: '#0d1117' });
  const now = opts.now ?? new Date();

  const exportRows: ExportRow[] = rows.map((r, i) => {
    const c = r.commit as GraphSnapshotCommit;
    return {
      shortSha: c.shortSha,
      subject: c.subject,
      author: c.author,
      relativeDate: timeAgo(c.date, now.getTime()),
      y: i * ROW_H,
    };
  });

  const built = buildStandaloneSvg({
    rowsSvg: lane.rowsSvg,
    graphWidth: lane.graphWidth,
    rowHeight: ROW_H,
    rowCount: rows.length,
    rows: exportRows,
    title: opts.title ?? `GitSight \u2014 ${snapshot.repo}`,
    background: opts.colours?.background,
    foreground: opts.colours?.foreground,
    muted: opts.colours?.muted,
  });

  return { ...built, filename: buildExportFilename(now, 'svg'), rowCount: rows.length };
}

/**
 * Build the export for the current view and trigger a download. Returns
 * the filename so the caller can toast it. No-op-safe: returns null when
 * there's nothing to export (empty filter result).
 */
export function downloadGraphSvg(snapshot: GraphSnapshot, opts: BuildExportOptions = {}): string | null {
  const exp = buildGraphExport(snapshot, opts);
  if (exp.rowCount === 0) return null;
  const blob = new Blob([exp.svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exp.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return exp.filename;
}
