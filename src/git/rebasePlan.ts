/**
 * Pure helpers for the Rebase Plan Preview (F49).
 *
 * Given the list of commits in `<upstream>..HEAD` (newest first as `git log`
 * emits), compute what `git rebase -i --autosquash` would do to them and
 * render a preview the user can confirm before any rewriting happens.
 *
 * Autosquash rule recap:
 *   - `fixup! <subject>` is grouped with the most recent earlier commit
 *     whose subject (or a `fixup!` chain that points at it) matches
 *     `<subject>` (prefix match — `git log --grep` style).
 *   - `squash! <subject>` is grouped likewise but the action is `squash`
 *     instead of `fixup` (keep messages).
 *   - `amend! <subject>` rewrites the matched commit's message.
 *   - Everything else is `pick`.
 *
 * We approximate this faithfully enough that the preview is the truth for
 * the common case (fixup pairs created by `git commit --fixup=<sha>`).
 * For the rarer manual `fixup! <prefix>` style we do prefix matching with
 * a best-effort tiebreaker (most recent matching commit wins) — matches
 * git's behaviour as documented in `git-rebase(1)`.
 *
 * Pure — no vscode, no child_process. Tests in test/git/rebasePlan.test.ts.
 */

export type RebaseAction = 'pick' | 'fixup' | 'squash' | 'amend';

export interface RawCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface PlanRow {
  action: RebaseAction;
  sha: string;
  shortSha: string;
  subject: string;
  /**
   * For fixup/squash/amend rows, the sha of the target commit they fold
   * into. Undefined for `pick`.
   */
  targetSha?: string;
  /** Display label after autosquash arrangement ("→ fix parser" etc). */
  displayLabel: string;
}

export interface RebasePlan {
  /** Rows in the order rebase would execute (oldest first). */
  rows: PlanRow[];
  /** True when no fixup/squash/amend rows exist — rebase would be a noop. */
  trivial: boolean;
  /** Commit count grouped by action. */
  counts: Record<RebaseAction, number>;
  /** Commits that look fixup-shaped but found no target — these become picks with a warning. */
  orphans: PlanRow[];
}

/**
 * Build the autosquash plan. `commits` should be newest first (git log
 * default); we reverse internally so the plan output is oldest first
 * (matching the editor view).
 */
export function buildAutosquashPlan(commits: RawCommit[]): RebasePlan {
  const oldestFirst = [...commits].reverse();
  const rows: PlanRow[] = [];
  const orphans: PlanRow[] = [];
  const counts: Record<RebaseAction, number> = { pick: 0, fixup: 0, squash: 0, amend: 0 };

  // First pass: build picks. We need the full pick list so fixups can
  // search backwards for a target.
  const baseRows: PlanRow[] = oldestFirst.map(c => ({
    action: 'pick',
    sha: c.sha,
    shortSha: c.shortSha,
    subject: c.subject,
    displayLabel: c.subject,
  }));

  // Second pass: classify fixup/squash/amend and find their target.
  // We track a `subjectIndex` keyed on the subject's prefix so prefix-style
  // `fixup! refactor parser` finds the first commit starting with `refactor parser`.
  for (let i = 0; i < baseRows.length; i++) {
    const row = baseRows[i];
    const verdict = classify(row.subject);
    if (!verdict) continue;
    row.action = verdict.action;
    // Search earlier rows (and any already-folded chains) for a target.
    const target = findTarget(baseRows, i, verdict.targetSubject);
    if (target) {
      row.targetSha = target.sha;
      row.displayLabel = `→ ${target.subject}`;
    } else {
      // No target found — leave as the original action but mark as orphan.
      row.displayLabel = `(orphan ${labelForAction(verdict.action)}) ${verdict.targetSubject}`;
      orphans.push(row);
    }
  }

  // Final pass: reorder so fixups sit immediately after their target.
  // For each pick we emit, repeatedly drain any unplaced fixup/squash/amend
  // whose target is already-placed — this handles chained autosquash
  // (e.g. `fixup! fixup! parser` whose direct target is the intermediate
  // `fixup! parser`, which itself folds into `parser`).
  const ordered: PlanRow[] = [];
  const placed = new Set<string>(); // by sha
  for (let i = 0; i < baseRows.length; i++) {
    if (placed.has(baseRows[i].sha)) continue;
    const row = baseRows[i];
    if (row.action !== 'pick') continue; // fixups land via the drain loop
    ordered.push(row);
    placed.add(row.sha);
    // Drain — keep going until a full sweep finds nothing new.
    let drained = true;
    while (drained) {
      drained = false;
      for (let j = 0; j < baseRows.length; j++) {
        const cand = baseRows[j];
        if (placed.has(cand.sha)) continue;
        if (cand.action === 'pick') continue;
        if (cand.targetSha && placed.has(cand.targetSha)) {
          ordered.push(cand);
          placed.add(cand.sha);
          drained = true;
        }
      }
    }
  }
  // Append unplaced (orphan fixups whose target was outside the range) at the end as picks.
  for (let i = 0; i < baseRows.length; i++) {
    if (placed.has(baseRows[i].sha)) continue;
    const row = baseRows[i];
    // Demote orphans to pick so the rebase doesn't actually try to fold them.
    row.action = 'pick';
    ordered.push(row);
  }

  for (const r of ordered) counts[r.action]++;

  return {
    rows: ordered,
    trivial: counts.fixup + counts.squash + counts.amend === 0,
    counts,
    orphans,
  };
}

function classify(subject: string): { action: Exclude<RebaseAction, 'pick'>; targetSubject: string } | undefined {
  const trimmed = (subject ?? '').trim();
  let m = /^fixup!\s+(.*)$/.exec(trimmed);
  if (m) return { action: 'fixup', targetSubject: m[1].trim() };
  m = /^squash!\s+(.*)$/.exec(trimmed);
  if (m) return { action: 'squash', targetSubject: m[1].trim() };
  m = /^amend!\s+(.*)$/.exec(trimmed);
  if (m) return { action: 'amend', targetSubject: m[1].trim() };
  return undefined;
}

/**
 * Find the target commit for an autosquash row. Rules (matching git):
 *   1. If targetSubject is a 7+ hex string that prefixes an earlier sha,
 *      use that commit directly.
 *   2. Otherwise treat targetSubject as a subject-prefix match: walk
 *      backwards from `index-1`, peeling fixup!/squash!/amend! prefixes
 *      off candidate subjects, and pick the first commit whose subject
 *      starts with (or equals) the target subject.
 */
function findTarget(rows: PlanRow[], index: number, targetSubject: string): PlanRow | undefined {
  // sha-prefix mode
  if (/^[0-9a-f]{4,40}$/i.test(targetSubject)) {
    for (let j = index - 1; j >= 0; j--) {
      if (rows[j].sha.startsWith(targetSubject)) return rows[j];
    }
  }
  // subject-prefix mode (peeling). Peel the target subject too so
  // chained `fixup! fixup! parser` finds the original `parser` commit
  // via the intermediate `fixup! parser`.
  const peeledTarget = peelAutosquash(targetSubject);
  for (let j = index - 1; j >= 0; j--) {
    const cand = peelAutosquash(rows[j].subject);
    if (cand === peeledTarget ||
        cand.startsWith(peeledTarget + ' ') ||
        peeledTarget.startsWith(cand + ' ')) {
      return rows[j];
    }
  }
  return undefined;
}

/** Strip leading fixup!/squash!/amend! markers (recursively). */
export function peelAutosquash(subject: string): string {
  let s = (subject ?? '').trim();
  while (true) {
    const m = /^(fixup|squash|amend)!\s+/.exec(s);
    if (!m) return s;
    s = s.slice(m[0].length).trim();
  }
}

function labelForAction(a: Exclude<RebaseAction, 'pick'>): string {
  return a === 'fixup' ? 'fixup!' : a === 'squash' ? 'squash!' : 'amend!';
}

/**
 * Render the plan as a Markdown document. Suitable for VS Code's preview
 * window. We deliberately mirror what the `git rebase -i` editor would
 * show — `<action> <sha7> <subject>` — so anyone who's done a rebase
 * before recognises the layout instantly.
 */
export function renderPlanMarkdown(plan: RebasePlan, args: { upstream: string; head: string }): string {
  const lines: string[] = [];
  lines.push(`# Rebase plan — \`${args.upstream}..${args.head}\``);
  lines.push('');
  lines.push(`**${plan.rows.length} commit${plan.rows.length === 1 ? '' : 's'}** · ` +
    `${plan.counts.pick} pick · ${plan.counts.fixup} fixup · ${plan.counts.squash} squash · ${plan.counts.amend} amend`);
  if (plan.trivial) {
    lines.push('');
    lines.push('> No fixup/squash/amend commits in this range — rebase would be a no-op.');
  }
  if (plan.orphans.length) {
    lines.push('');
    lines.push(`> ${plan.orphans.length} orphan${plan.orphans.length === 1 ? '' : 's'} — autosquash markers that don't match an earlier commit in this range. These will be left as plain picks.`);
  }
  lines.push('');
  lines.push('```');
  for (const r of plan.rows) {
    const label = r.action === 'pick' ? r.displayLabel : `${r.displayLabel}`;
    lines.push(`${r.action.padEnd(7, ' ')} ${r.shortSha}  ${label}`);
  }
  lines.push('```');
  if (plan.orphans.length) {
    lines.push('');
    lines.push('## Orphan markers');
    lines.push('');
    for (const o of plan.orphans) {
      lines.push(`- \`${o.shortSha}\` — \`${o.subject}\``);
    }
  }
  return lines.join('\n');
}

/**
 * Pure parse for the `git log --pretty=format:'%H|%h|%s' <range>` output.
 * Subjects can themselves contain `|` so everything after the second
 * separator is joined back together.
 */
export function parsePlanLog(raw: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [sha, shortSha, ...rest] = parts;
    out.push({ sha, shortSha, subject: rest.join('|') });
  }
  return out;
}
