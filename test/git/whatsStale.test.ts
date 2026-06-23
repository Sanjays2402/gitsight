import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scoreBranch,
  scoreStash,
  scoreWorktree,
  scoreSecrets,
  aggregateRot,
  summariseRot,
  formatRotHeader,
  glyphForSeverity,
  buildRotReport,
  RotItem,
} from '../../src/git/whatsStale';

function makeBranchAge(name: string, status: 'fresh' | 'aging' | 'stale' | 'ancient', ageDays: number) {
  return {
    branch: { name, current: false, lastDate: new Date(Date.now() - ageDays * 86_400_000), upstream: '', remote: false, ahead: 0, behind: 0 } as any,
    status,
    ageDays,
  };
}

function makeStash(opts: { index: number; ageDays: number; bucket: 'fresh' | 'stale' | 'ancient'; sourceBranchGone: boolean; dropSafe: boolean; subject?: string; sourceBranch?: string }) {
  return {
    stash: { index: opts.index, ref: `stash@{${opts.index}}`, subject: opts.subject ?? 'WIP', branch: opts.sourceBranch ?? '', date: new Date() } as any,
    ageDays: opts.ageDays,
    ageBucket: opts.bucket,
    sourceBranch: opts.sourceBranch,
    sourceBranchGone: opts.sourceBranchGone,
    cleanSubject: opts.subject ?? 'WIP work',
    named: false,
    dropSafe: opts.dropSafe,
  };
}

function makeWorktree(opts: { path: string; ageDays: number; reasons: ('missing-on-disk' | 'upstream-gone' | 'stale-only')[]; branch?: string }) {
  return {
    worktree: { path: opts.path, branch: opts.branch ?? 'feature/x', head: 'abc1234', bare: false, detached: false, locked: false } as any,
    ageDays: opts.ageDays,
    existsOnDisk: !opts.reasons.includes('missing-on-disk'),
    branchUpstreamGone: opts.reasons.includes('upstream-gone'),
    reasons: opts.reasons,
    pruneSafe: true,
    protectedReason: undefined,
  };
}

test('scoreBranch: fresh branches filtered out (no rot)', () => {
  assert.equal(scoreBranch(makeBranchAge('main', 'fresh', 0)), undefined);
});

test('scoreBranch: ancient branch gets critical + score >= 300', () => {
  const item = scoreBranch(makeBranchAge('old', 'ancient', 500))!;
  assert.equal(item.severity, 'critical');
  assert.ok(item.score >= 300, `score=${item.score}`);
  assert.equal(item.kind, 'branch');
  assert.equal(item.label, 'old');
  assert.equal(item.ageDays, 500);
});

test('scoreBranch: stale branch gets major + score around 100-200', () => {
  const item = scoreBranch(makeBranchAge('feat', 'stale', 120))!;
  assert.equal(item.severity, 'major');
  assert.equal(item.score, 100 + 120);
});

test('scoreBranch: aging branch gets minor', () => {
  const item = scoreBranch(makeBranchAge('warm', 'aging', 45))!;
  assert.equal(item.severity, 'minor');
});

test('scoreBranch: Infinity age (no date) clamped to large finite value', () => {
  const b = makeBranchAge('mystery', 'ancient', Infinity);
  const item = scoreBranch(b)!;
  assert.ok(Number.isFinite(item.score));
});

test('scoreStash: fresh + branch-alive returns undefined', () => {
  const c = makeStash({ index: 0, ageDays: 2, bucket: 'fresh', sourceBranchGone: false, dropSafe: false });
  assert.equal(scoreStash(c), undefined);
});

test('scoreStash: fresh + branch-gone surfaces (rot signal)', () => {
  const c = makeStash({ index: 1, ageDays: 5, bucket: 'fresh', sourceBranchGone: true, dropSafe: false, sourceBranch: 'feature/x' });
  const item = scoreStash(c)!;
  assert.equal(item.severity, 'major');
  assert.match(item.description, /source branch gone/);
});

test('scoreStash: drop-safe stash gets major + high score', () => {
  const c = makeStash({ index: 2, ageDays: 200, bucket: 'ancient', sourceBranchGone: true, dropSafe: true });
  const item = scoreStash(c)!;
  assert.equal(item.severity, 'major');
  assert.ok(item.score >= 150);
  assert.match(item.description, /drop-safe/);
});

test('scoreStash: stale-but-keep stash gets minor (not pre-pickable)', () => {
  const c = makeStash({ index: 3, ageDays: 95, bucket: 'stale', sourceBranchGone: false, dropSafe: false });
  const item = scoreStash(c)!;
  assert.equal(item.severity, 'minor');
});

test('scoreStash: label falls back to stash@{N} when subject is empty', () => {
  const c = makeStash({ index: 4, ageDays: 200, bucket: 'ancient', sourceBranchGone: false, dropSafe: true, subject: '' });
  c.cleanSubject = '';
  const item = scoreStash(c)!;
  assert.equal(item.label, 'stash@{4}');
});

test('scoreWorktree: no reasons => not a rot item', () => {
  const w = makeWorktree({ path: '/tmp/wt', ageDays: 5, reasons: [] });
  assert.equal(scoreWorktree(w), undefined);
});

test('scoreWorktree: missing-on-disk => critical', () => {
  const w = makeWorktree({ path: '/tmp/wt', ageDays: 30, reasons: ['missing-on-disk'] });
  const item = scoreWorktree(w)!;
  assert.equal(item.severity, 'critical');
  assert.equal(item.glyph, 'circle-slash');
});

test('scoreWorktree: upstream-gone => major', () => {
  const w = makeWorktree({ path: '/tmp/wt', ageDays: 60, reasons: ['upstream-gone'] });
  const item = scoreWorktree(w)!;
  assert.equal(item.severity, 'major');
});

test('scoreWorktree: stale-only => minor with versions glyph', () => {
  const w = makeWorktree({ path: '/tmp/wt', ageDays: 200, reasons: ['stale-only'] });
  const item = scoreWorktree(w)!;
  assert.equal(item.severity, 'minor');
  assert.equal(item.glyph, 'versions');
});

test('scoreWorktree: multiple reasons takes worst (missing dominates)', () => {
  const w = makeWorktree({ path: '/tmp/wt', ageDays: 200, reasons: ['missing-on-disk', 'upstream-gone'] });
  const item = scoreWorktree(w)!;
  assert.equal(item.severity, 'critical');
  assert.deepEqual(item.payload.reasons, ['missing-on-disk', 'upstream-gone']);
});

test('scoreSecrets: zero missing => undefined', () => {
  assert.equal(scoreSecrets({ repoName: 'r', missingCount: 0, workflowCount: 0 }), undefined);
});

test('scoreSecrets: 1 missing => minor', () => {
  const item = scoreSecrets({ repoName: 'r', missingCount: 1, workflowCount: 1 })!;
  assert.equal(item.severity, 'minor');
});

test('scoreSecrets: 3 missing => major', () => {
  const item = scoreSecrets({ repoName: 'r', missingCount: 3, workflowCount: 2 })!;
  assert.equal(item.severity, 'major');
});

test('scoreSecrets: 6 missing => critical', () => {
  const item = scoreSecrets({ repoName: 'r', missingCount: 6, workflowCount: 4 })!;
  assert.equal(item.severity, 'critical');
});

test('aggregateRot: filters undefined, sorts critical-first then by score', () => {
  const items: (RotItem | undefined)[] = [
    scoreBranch(makeBranchAge('fresh', 'fresh', 0)),
    scoreBranch(makeBranchAge('aging', 'aging', 40)),
    scoreBranch(makeBranchAge('ancient', 'ancient', 500)),
    scoreStash(makeStash({ index: 1, ageDays: 200, bucket: 'ancient', sourceBranchGone: true, dropSafe: true })),
    scoreWorktree(makeWorktree({ path: '/tmp/wt', ageDays: 80, reasons: ['missing-on-disk'] })),
  ];
  const out = aggregateRot(items);
  // critical (worktree=missing, branch=ancient) → major (stash) → minor (aging branch)
  assert.equal(out.length, 4);
  assert.equal(out[0].severity, 'critical');
  assert.equal(out[out.length - 1].severity, 'minor');
});

test('aggregateRot: stable order within same severity by label asc', () => {
  const items = [
    scoreBranch(makeBranchAge('zzz', 'stale', 100)),
    scoreBranch(makeBranchAge('aaa', 'stale', 100)),
  ];
  const out = aggregateRot(items);
  assert.equal(out[0].label, 'aaa');
  assert.equal(out[1].label, 'zzz');
});

test('summariseRot: counts by severity + kind', () => {
  const items = aggregateRot([
    scoreBranch(makeBranchAge('a', 'ancient', 500)),
    scoreBranch(makeBranchAge('b', 'stale', 120)),
    scoreStash(makeStash({ index: 1, ageDays: 200, bucket: 'ancient', sourceBranchGone: true, dropSafe: true })),
    scoreWorktree(makeWorktree({ path: '/wt', ageDays: 60, reasons: ['upstream-gone'] })),
  ]);
  const s = summariseRot(items);
  assert.equal(s.total, 4);
  assert.equal(s.critical, 1);
  // major: stale branch + ancient/drop-safe stash + upstream-gone worktree
  assert.equal(s.major, 3);
  assert.equal(s.minor, 0);
  assert.equal(s.byKind.branch, 2);
  assert.equal(s.byKind.stash, 1);
  assert.equal(s.byKind.worktree, 1);
});

test('formatRotHeader: empty -> "no rot detected"', () => {
  assert.equal(formatRotHeader({ total: 0, critical: 0, major: 0, minor: 0, informational: 0, byKind: { branch: 0, stash: 0, worktree: 0, secrets: 0 } }), 'no rot detected');
});

test('formatRotHeader: non-zero counts listed only', () => {
  const s = {
    total: 5, critical: 1, major: 2, minor: 2, informational: 0,
    byKind: { branch: 3, stash: 1, worktree: 1, secrets: 0 } as const,
  };
  const out = formatRotHeader(s);
  assert.match(out, /1 critical/);
  assert.match(out, /2 major/);
  assert.match(out, /2 minor/);
  assert.match(out, /5 items/);
  assert.equal(/informational/.test(out), false);
});

test('formatRotHeader: 1 item uses singular', () => {
  const s = {
    total: 1, critical: 1, major: 0, minor: 0, informational: 0,
    byKind: { branch: 0, stash: 0, worktree: 1, secrets: 0 } as const,
  };
  assert.match(formatRotHeader(s), /\(1 item\)/);
});

test('glyphForSeverity: every level has a codicon (no emoji)', () => {
  for (const sev of ['critical', 'major', 'minor', 'informational'] as const) {
    const g = glyphForSeverity(sev);
    assert.match(g, /^[a-z-]+$/);
    assert.ok(g.length > 0);
  }
});

test('buildRotReport: empty list renders cheerful "nothing to clean"', () => {
  const md = buildRotReport([], { total: 0, critical: 0, major: 0, minor: 0, informational: 0, byKind: { branch: 0, stash: 0, worktree: 0, secrets: 0 } });
  assert.match(md, /Nothing to clean up\./);
});

test('buildRotReport: non-empty renders a markdown table', () => {
  const items = aggregateRot([
    scoreBranch(makeBranchAge('feat/x', 'stale', 95)),
    scoreStash(makeStash({ index: 0, ageDays: 200, bucket: 'ancient', sourceBranchGone: true, dropSafe: true, subject: 'WIP big thing' })),
  ]);
  const md = buildRotReport(items, summariseRot(items));
  assert.match(md, /^# What's stale\?/);
  assert.match(md, /\| Kind \| Severity \| Item \| Description \| Age \|/);
  assert.match(md, /branch/);
  assert.match(md, /stash/);
  assert.match(md, /\| 95d \|/);
});

test('buildRotReport: pipe in label is escaped', () => {
  const items: RotItem[] = [{
    kind: 'branch', label: 'has|pipe', score: 100, severity: 'minor',
    description: 'has|pipe', glyph: 'git-branch', payload: {},
  }];
  const md = buildRotReport(items, summariseRot(items));
  assert.match(md, /has\\\|pipe/);
});

test('aggregateRot: empty input handled', () => {
  assert.deepEqual(aggregateRot([undefined, undefined]), []);
});
