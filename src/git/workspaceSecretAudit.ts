/**
 * Pure helpers for the Workspace Secret Audit (F94).
 *
 * Where F89's secretAudit.ts handles per-workflow scanning + missing-name
 * classification, F94 aggregates ACROSS repos. The helpers here:
 *
 *   - Rank entries by `missing-count desc, then alphabetical`.
 *   - Summarise the workspace into one sentence for the picker header.
 *   - Render a portable markdown report for the scratch buffer.
 *
 * The view layer in src/views/workspaceSecretAudit.ts does the IO + IIO
 * shapes; these are the deterministic core (no vscode, no child_process,
 * no fs).
 *
 * Tests in test/git/workspaceSecretAudit.test.ts.
 */
import { SecretAuditResult } from './secretAudit';

export interface RepoAuditEntry {
  /** Repo working directory (absolute). */
  cwd: string;
  /** Display name — typically the folder basename. */
  name: string;
  /** Origin owner/repo when resolvable. */
  slug?: string;
  /** Whether this repo qualifies for the audit. */
  applies: boolean;
  /** Reason for not applying when applies=false. */
  skippedReason?: string;
  /** Audit result when applies=true. */
  audit?: SecretAuditResult;
}

/**
 * Sort entries into tiers:
 *
 *   0 — has at least 1 missing secret (review urgency).
 *   1 — applies but healthy.
 *   2 — skipped (not a github repo, no workflows, etc.).
 *
 * Within tier 0, more-missing-first (the worst offender top). Within
 * any tier, alphabetical name as the final tiebreak.
 */
export function rankEntries(entries: RepoAuditEntry[]): RepoAuditEntry[] {
  return [...entries].sort((a, b) => {
    const aTier = tierOf(a);
    const bTier = tierOf(b);
    if (aTier !== bTier) return aTier - bTier;
    if (aTier === 0) {
      const aMiss = a.audit?.missing.length ?? 0;
      const bMiss = b.audit?.missing.length ?? 0;
      if (aMiss !== bMiss) return bMiss - aMiss;
    }
    return a.name.localeCompare(b.name);
  });
}

function tierOf(e: RepoAuditEntry): number {
  if (e.applies && (e.audit?.missing.length ?? 0) > 0) return 0;
  if (e.applies) return 1;
  return 2;
}

/**
 * Build the one-line workspace summary:
 *
 *   "5 repos · 2 missing · 2 healthy · 1 skipped"
 *
 * Skipped reasons aren't itemised here — that lives in the per-row
 * description.
 */
export function summariseEntries(entries: RepoAuditEntry[]): string {
  const total = entries.length;
  const skipped = entries.filter(e => !e.applies).length;
  const missingRepos = entries.filter(e => e.applies && (e.audit?.missing.length ?? 0) > 0).length;
  const healthyRepos = entries.filter(e => e.applies && (e.audit?.missing.length ?? 0) === 0).length;
  const parts: string[] = [`${total} repo${total === 1 ? '' : 's'}`];
  if (missingRepos) parts.push(`${missingRepos} missing`);
  if (healthyRepos) parts.push(`${healthyRepos} healthy`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join('  \u00b7  ');
}

/**
 * Glyph for the per-row picker label. Codicon names; the view layer
 * wraps them in `$(name)`.
 */
export function glyphFor(e: RepoAuditEntry): string {
  if (!e.applies) return 'circle-slash';
  if ((e.audit?.missing.length ?? 0) > 0) return 'warning';
  return 'shield';
}

/** Short description for a picker row. */
export function describeEntryShort(e: RepoAuditEntry): string {
  if (!e.applies) return e.skippedReason ?? 'skipped';
  const miss = e.audit?.missing.length ?? 0;
  const refd = e.audit?.referenced.length ?? 0;
  if (!miss) return `healthy (${refd} secret${refd === 1 ? '' : 's'} referenced)`;
  return `${miss} missing of ${refd}`;
}

/** Optional detail line — usually the slug or absolute cwd. */
export function describeEntryDetail(e: RepoAuditEntry): string {
  if (!e.applies) return e.skippedReason ?? '';
  if (e.slug) return e.slug;
  return e.cwd;
}

/**
 * Render a portable markdown report. Pure function — pass a fixed
 * timestamp to keep snapshot tests stable. When `now` is omitted we
 * skip the timestamp line entirely (testable rendering).
 */
export function renderMarkdownReport(entries: RepoAuditEntry[], now?: Date): string {
  const lines: string[] = [];
  lines.push('# GitSight \u00b7 Workspace Secret Audit');
  lines.push('');
  if (now) {
    lines.push(`Generated ${now.toISOString()}`);
    lines.push('');
  }
  lines.push(`**Summary**: ${summariseEntries(entries)}`);
  lines.push('');
  for (const e of entries) {
    lines.push(`## ${e.name}`);
    if (e.slug) lines.push(`_${e.slug}_`);
    lines.push('');
    if (!e.applies) {
      lines.push(`> Skipped: ${e.skippedReason}`);
      lines.push('');
      continue;
    }
    const audit = e.audit!;
    const missing = audit.missing.length;
    const referenced = audit.referenced.length;
    if (!missing) {
      lines.push(`Healthy. ${referenced} secret${referenced === 1 ? '' : 's'} referenced, all configured.`);
      lines.push('');
      continue;
    }
    lines.push(`**${missing} missing** of ${referenced} referenced.`);
    if (audit.dynamicRefCount) {
      lines.push(`_(+${audit.dynamicRefCount} dynamic reference${audit.dynamicRefCount === 1 ? '' : 's'} \u2014 not scanned.)_`);
    }
    lines.push('');
    lines.push('| Secret | References |');
    lines.push('| --- | --- |');
    for (const name of audit.missing) {
      const refs = audit.refs.filter(r => r.name === name);
      const refDesc = refs.map(r => `\`${r.workflow}:${r.line}\``).join(' \u00b7 ');
      lines.push(`| \`${name}\` | ${refDesc} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
