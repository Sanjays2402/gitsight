import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyLevel,
  buildOverview,
  buildOverviewReport,
  describeRow,
  glyphForLevel,
  formatOverviewHeader,
  selectBranchesToProbe,
  DEFAULT_PROBE_LIMIT,
  BranchProtectionProbe,
} from '../../src/git/branchProtectionOverview';
import type { ProtectionDecision } from '../../src/git/forcePushGuard';

function probe(branch: string, body: any, opts: { stderr?: string; exitCode?: number } = {}): BranchProtectionProbe {
  return {
    branch,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  };
}

const unknown = (reason: string): ProtectionDecision => ({ kind: 'unknown', reason });
const unprotected: ProtectionDecision = { kind: 'unprotected' };

test('classifyLevel: unknown decision stays unknown', () => {
  assert.equal(classifyLevel(unknown('auth failed')), 'unknown');
});

test('classifyLevel: unprotected decision returns unprotected', () => {
  assert.equal(classifyLevel(unprotected), 'unprotected');
});

test('classifyLevel: protected with reviews + force off => locked', () => {
  const d: ProtectionDecision = {
    kind: 'protected',
    allowsForcePush: false,
    rules: [
      { id: 'required-reviews', enabled: true, label: 'PR review required' },
      { id: 'force-push', enabled: false, label: 'Force-push disallowed' },
    ],
  };
  assert.equal(classifyLevel(d), 'locked');
});

test('classifyLevel: protected with lock_branch => locked regardless', () => {
  const d: ProtectionDecision = {
    kind: 'protected', allowsForcePush: true,
    rules: [{ id: 'lock-branch', enabled: true, label: 'Branch locked' }],
  };
  assert.equal(classifyLevel(d), 'locked');
});

test('classifyLevel: protected with reviews + force allowed => reviewed', () => {
  const d: ProtectionDecision = {
    kind: 'protected', allowsForcePush: true,
    rules: [
      { id: 'required-reviews', enabled: true, label: 'PR review required' },
      { id: 'force-push', enabled: true, label: 'Force-push allowed' },
    ],
  };
  assert.equal(classifyLevel(d), 'reviewed');
});

test('classifyLevel: protected with only status checks => guarded', () => {
  const d: ProtectionDecision = {
    kind: 'protected', allowsForcePush: false,
    rules: [
      { id: 'required-status-checks', enabled: true, label: 'Required status checks' },
      { id: 'force-push', enabled: false, label: 'Force-push disallowed' },
    ],
  };
  assert.equal(classifyLevel(d), 'guarded');
});

test('describeRow: locked includes rule count', () => {
  const d: ProtectionDecision = {
    kind: 'protected', allowsForcePush: false,
    rules: [
      { id: 'required-reviews', enabled: true, label: 'PR review required' },
      // force-push enabled=false still gets recorded by classifyProtection
      // but describeRow only counts ENABLED rules, so this doesn't add to
      // the rule-count tally.
      { id: 'force-push', enabled: false, label: 'Force-push disallowed' },
      { id: 'required-signatures', enabled: true, label: 'Signed commits required' },
    ],
  };
  const out = describeRow({ decision: d, level: classifyLevel(d) });
  assert.match(out, /^locked - \d+ rule/);
  // 2 enabled rules: required-reviews + required-signatures.
  assert.match(out, /2 rules/);
});

test('describeRow: reviewed shows force-allowed/disallowed', () => {
  const d: ProtectionDecision = {
    kind: 'protected', allowsForcePush: true,
    rules: [
      { id: 'required-reviews', enabled: true, label: 'PR review required' },
      { id: 'force-push', enabled: true, label: 'Force-push allowed' },
    ],
  };
  assert.equal(describeRow({ decision: d, level: 'reviewed' }), 'reviewed - force allowed');
});

test('describeRow: guarded lists short rule names', () => {
  const d: ProtectionDecision = {
    kind: 'protected', allowsForcePush: false,
    rules: [
      { id: 'required-status-checks', enabled: true, label: 'Required status checks' },
      { id: 'required-signatures', enabled: true, label: 'Signed commits required' },
      { id: 'force-push', enabled: false, label: 'Force-push disallowed' },
    ],
  };
  assert.equal(describeRow({ decision: d, level: 'guarded' }), 'guarded - status checks, signatures');
});

test('describeRow: unknown surfaces the failure reason', () => {
  assert.equal(describeRow({ decision: unknown('gh CLI not authenticated'), level: 'unknown' }), 'unknown - gh CLI not authenticated');
});

test('glyphForLevel: every level has a codicon (no emoji)', () => {
  const levels = ['locked', 'reviewed', 'guarded', 'unprotected', 'unknown'] as const;
  for (const lvl of levels) {
    const g = glyphForLevel(lvl);
    assert.ok(g.length > 0, `glyph for ${lvl}`);
    // codicons are kebab-case alphanumerics, no special chars
    assert.match(g, /^[a-z-]+$/);
  }
});

test('buildOverview: probes with no body get unprotected verdict via 404', () => {
  const probes = [
    probe('feature/x', '', { stderr: 'HTTP 404: Branch not protected (https://api.github.com/...)', exitCode: 1 }),
  ];
  const o = buildOverview({ probes });
  assert.equal(o.rows.length, 1);
  assert.equal(o.rows[0].level, 'unprotected');
  assert.equal(o.byLevel.unprotected, 1);
});

test('buildOverview: default branch sorts first, then current, then by level', () => {
  const lockedBody = {
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    required_pull_request_reviews: { dismiss_stale_reviews: true },
    required_signatures: { enabled: true },
  };
  const reviewedBody = {
    allow_force_pushes: { enabled: true },
    required_pull_request_reviews: { dismiss_stale_reviews: true },
  };
  const probes: BranchProtectionProbe[] = [
    probe('feature/x', '', { stderr: 'Branch not protected', exitCode: 1 }),
    probe('main', lockedBody),
    probe('release', reviewedBody),
    probe('hotfix', '', { stderr: 'Branch not protected', exitCode: 1 }),
  ];
  const o = buildOverview({ probes, currentBranch: 'hotfix', defaultBranch: 'main' });
  // Order: default (main) → current (hotfix) → rest by level desc → alphabetical
  assert.deepEqual(o.rows.map(r => r.branch), ['main', 'hotfix', 'release', 'feature/x']);
  assert.equal(o.byLevel.locked, 1);
  assert.equal(o.byLevel.reviewed, 1);
  assert.equal(o.byLevel.unprotected, 2);
});

test('buildOverview: empty rows / skipped probes (no branch) tallied separately', () => {
  const probes: BranchProtectionProbe[] = [
    { branch: '', body: '', stderr: '', exitCode: 0 },
    probe('main', { allow_force_pushes: { enabled: false }, required_pull_request_reviews: {} }),
  ];
  const o = buildOverview({ probes, defaultBranch: 'main' });
  assert.equal(o.rows.length, 1);
  assert.equal(o.skipped, 1);
});

test('buildOverview: marks isCurrent + isDefault correctly', () => {
  const probes: BranchProtectionProbe[] = [
    probe('main', { allow_force_pushes: { enabled: false }, required_pull_request_reviews: {} }),
    probe('foo', '', { stderr: 'Branch not protected', exitCode: 1 }),
  ];
  const o = buildOverview({ probes, currentBranch: 'foo', defaultBranch: 'main' });
  const main = o.rows.find(r => r.branch === 'main')!;
  const foo = o.rows.find(r => r.branch === 'foo')!;
  assert.equal(main.isDefault, true);
  assert.equal(main.isCurrent, false);
  assert.equal(foo.isCurrent, true);
  assert.equal(foo.isDefault, false);
});

test('buildOverview: unknown decision sorts to the bottom of levels', () => {
  const probes: BranchProtectionProbe[] = [
    probe('a', '', { stderr: 'oops some network error', exitCode: 1 }),
    probe('b', '', { stderr: 'Branch not protected', exitCode: 1 }),
  ];
  const o = buildOverview({ probes });
  assert.equal(o.rows[0].branch, 'b');
  assert.equal(o.rows[1].branch, 'a');
  assert.equal(o.byLevel.unknown, 1);
  assert.equal(o.byLevel.unprotected, 1);
});

test('formatOverviewHeader: lists only non-zero buckets + branch count plural', () => {
  const probes = [
    probe('m', { allow_force_pushes: { enabled: false }, required_pull_request_reviews: {} }),
    probe('a', '', { stderr: 'Branch not protected', exitCode: 1 }),
    probe('b', '', { stderr: 'Branch not protected', exitCode: 1 }),
  ];
  const o = buildOverview({ probes });
  const header = formatOverviewHeader(o);
  assert.match(header, /1 locked/);
  assert.match(header, /2 unprotected/);
  assert.match(header, /\(3 branches\)/);
  assert.equal(/guarded/.test(header), false);
});

test('formatOverviewHeader: no branches handled', () => {
  const o = buildOverview({ probes: [] });
  assert.equal(formatOverviewHeader(o), 'no branches');
});

test('formatOverviewHeader: single branch uses singular', () => {
  const probes = [probe('m', '', { stderr: 'Branch not protected', exitCode: 1 })];
  const o = buildOverview({ probes });
  assert.match(formatOverviewHeader(o), /1 branch\)/);
});

test('buildOverviewReport: renders a markdown table with current/default annotations', () => {
  const probes = [
    probe('main', { allow_force_pushes: { enabled: false }, required_pull_request_reviews: {}, required_signatures: { enabled: true } }),
    probe('foo', '', { stderr: 'Branch not protected', exitCode: 1 }),
  ];
  const o = buildOverview({ probes, currentBranch: 'foo', defaultBranch: 'main' });
  const md = buildOverviewReport(o);
  assert.match(md, /^# Branch Protection Overview/);
  assert.match(md, /\| Branch \| Level \| Summary \| Rules \|/);
  assert.match(md, /`main` \(default\)/);
  assert.match(md, /`foo` \(current\)/);
  // Rules column for protected includes ; -joined labels
  assert.match(md, /PR review required/);
});

test('buildOverviewReport: pipe in branch name is escaped', () => {
  const probes = [probe('weird|name', '', { stderr: 'Branch not protected', exitCode: 1 })];
  const o = buildOverview({ probes });
  const md = buildOverviewReport(o);
  assert.match(md, /weird\\\|name/);
});

test('selectBranchesToProbe: default + current promoted first', () => {
  const got = selectBranchesToProbe(['a', 'b', 'c', 'main'], {
    currentBranch: 'feature',
    defaultBranch: 'main',
    limit: 4,
  });
  assert.deepEqual(got, ['main', 'feature', 'a', 'b']);
});

test('selectBranchesToProbe: deduplicates and respects limit', () => {
  const got = selectBranchesToProbe(['main', 'main', 'a', 'a', 'b'], {
    currentBranch: 'main',
    defaultBranch: 'main',
    limit: 3,
  });
  assert.deepEqual(got, ['main', 'a', 'b']);
});

test('selectBranchesToProbe: zero/negative limit clamps to >=1', () => {
  const got = selectBranchesToProbe(['a', 'b'], { limit: 0 });
  assert.equal(got.length, 1);
  assert.deepEqual(got, ['a']);
});

test('selectBranchesToProbe: defaults to DEFAULT_PROBE_LIMIT when limit omitted', () => {
  const branches = Array.from({ length: 30 }, (_, i) => `b${i}`);
  const got = selectBranchesToProbe(branches, {});
  assert.equal(got.length, DEFAULT_PROBE_LIMIT);
});
