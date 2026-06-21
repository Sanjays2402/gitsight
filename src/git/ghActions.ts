/**
 * Pure helpers for the GitHub Actions run pill (F62).
 *
 * The pill calls:
 *
 *   gh run list --branch <branch> --limit 1 --json \
 *       databaseId,status,conclusion,name,workflowName,headSha,startedAt,updatedAt,url,event
 *
 * and turns the resulting JSON into a small renderable struct. We keep
 * the JSON parse + status classification + label formatting in a pure
 * module so they can be unit-tested without spawning `gh`.
 *
 * Status semantics:
 *   - status='in_progress' / 'queued' / 'waiting' / 'pending' \u2192 running
 *   - status='completed' AND conclusion='success' \u2192 success
 *   - status='completed' AND conclusion='failure' \u2192 failure
 *   - status='completed' AND conclusion='cancelled' \u2192 cancelled
 *   - status='completed' AND conclusion='skipped' \u2192 skipped
 *   - status='completed' AND any other conclusion \u2192 other (still
 *     surfaced but with a generic glyph; covers neutral / timed_out /
 *     action_required / startup_failure)
 *
 * Pure \u2014 no vscode, no child_process. Tests in test/git/ghActions.test.ts.
 */

export type RunState = 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'other' | 'unknown';

export interface CiRun {
  databaseId: number;
  status: string;
  conclusion: string;
  name: string;
  workflowName: string;
  headSha: string;
  startedAt: string;
  updatedAt: string;
  url: string;
  event: string;
  state: RunState;
}

export function parseGhRunList(rawJson: string): CiRun[] {
  if (!rawJson) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: CiRun[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const status = typeof r.status === 'string' ? r.status : '';
    const conclusion = typeof r.conclusion === 'string' ? r.conclusion : '';
    out.push({
      databaseId: typeof r.databaseId === 'number' ? r.databaseId : 0,
      status,
      conclusion,
      name: typeof r.name === 'string' ? r.name : '',
      workflowName: typeof r.workflowName === 'string' ? r.workflowName : '',
      headSha: typeof r.headSha === 'string' ? r.headSha : '',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
      url: typeof r.url === 'string' ? r.url : '',
      event: typeof r.event === 'string' ? r.event : '',
      state: classifyRunState(status, conclusion),
    });
  }
  return out;
}

export function classifyRunState(status: string, conclusion: string): RunState {
  const s = (status ?? '').toLowerCase();
  const c = (conclusion ?? '').toLowerCase();
  if (s === 'in_progress' || s === 'queued' || s === 'waiting' || s === 'pending') return 'running';
  if (s !== 'completed') return s ? 'unknown' : 'unknown';
  if (c === 'success') return 'success';
  if (c === 'failure') return 'failure';
  if (c === 'cancelled') return 'cancelled';
  if (c === 'skipped') return 'skipped';
  return 'other';
}

/**
 * Codicon name + status-bar background severity for each run state. The
 * view does `$(glyphForRun(state))` and reads the severity for theme
 * colour selection.
 */
export function glyphForRun(state: RunState): string {
  switch (state) {
    case 'running':   return 'sync~spin';
    case 'success':   return 'pass';
    case 'failure':   return 'error';
    case 'cancelled': return 'circle-slash';
    case 'skipped':   return 'debug-step-over';
    case 'other':     return 'warning';
    case 'unknown':   return 'question';
  }
}

export type RunSeverity = 'none' | 'warning' | 'error';
export function severityForRun(state: RunState): RunSeverity {
  if (state === 'failure') return 'error';
  if (state === 'cancelled' || state === 'other') return 'warning';
  return 'none';
}

/**
 * Status-bar label \u2014 short and informative.
 *   "$(pass) CI: success"
 *   "$(sync~spin) CI: running \u2014 build"
 *   "$(error) CI: failure \u2014 test"
 */
export function formatPillLabel(run: CiRun): string {
  const name = run.workflowName || run.name || 'workflow';
  return `$(${glyphForRun(run.state)}) CI: ${stateLabel(run.state)}${name ? ` \u2014 ${truncate(name, 24)}` : ''}`;
}

function stateLabel(s: RunState): string {
  switch (s) {
    case 'running':   return 'running';
    case 'success':   return 'success';
    case 'failure':   return 'failure';
    case 'cancelled': return 'cancelled';
    case 'skipped':   return 'skipped';
    case 'other':     return 'attention';
    case 'unknown':   return 'unknown';
  }
}

/** Multi-line tooltip body. */
export function formatTooltipMarkdown(run: CiRun, opts: { branch?: string; ageLabel?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`**GitHub Actions** \u2014 ${stateLabel(run.state)}`);
  if (run.workflowName) lines.push(`Workflow: \`${escape(run.workflowName)}\``);
  if (opts.branch)      lines.push(`Branch: \`${escape(opts.branch)}\``);
  if (run.headSha)      lines.push(`HEAD: \`${run.headSha.slice(0, 7)}\``);
  if (run.event)        lines.push(`Event: ${escape(run.event)}`);
  if (opts.ageLabel)    lines.push(`Updated: ${opts.ageLabel} ago`);
  lines.push('');
  lines.push('Click for actions \u00b7 rerun, view logs, open in browser.');
  return lines.join('  \n');
}

function escape(s: string): string {
  return s.replace(/`/g, '\\`');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

/**
 * Detect whether the repo has a `.github/workflows/` directory. The
 * watcher uses this as a pre-filter \u2014 no point shelling out to `gh run`
 * when the repo doesn't use GitHub Actions at all.
 *
 * We accept the entries returned from a directory read (vs reading the
 * filesystem ourselves) so the view layer can use vscode workspace fs
 * and we can still unit-test the predicate.
 */
export function hasGithubWorkflows(entries: string[]): boolean {
  if (!entries || !entries.length) return false;
  return entries.some(name => /\.ya?ml$/i.test(name));
}
