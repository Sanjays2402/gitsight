import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  deriveStashPatchFilename,
  sanitiseFilenameComponent,
  validateFilename,
  buildExportPlan,
  summariseExportPlan,
  describeExportPlan,
  buildExportReport,
  PatchExportCandidate,
} from '../../src/git/stashPatchExport';
import type { StashCandidate } from '../../src/git/stashTrash';
import type { Stash } from '../../src/git/git';

function makeStash(opts: { index?: number; ref?: string; subject?: string; branch?: string; date?: Date } = {}): Stash {
  return {
    index: opts.index ?? 0,
    ref: opts.ref ?? `stash@{${opts.index ?? 0}}`,
    subject: opts.subject ?? 'WIP on main: hello',
    branch: opts.branch ?? 'main',
    date: opts.date ?? new Date('2026-06-01T12:00:00Z'),
  } as Stash;
}

function makeCandidate(opts: Partial<{ ageDays: number; ageBucket: 'fresh' | 'stale' | 'ancient'; sourceBranchGone: boolean; dropSafe: boolean; named: boolean; cleanSubject: string; sourceBranch: string; index: number; subject: string; date: Date }> = {}): StashCandidate {
  const s = makeStash({ index: opts.index ?? 0, subject: opts.subject, date: opts.date });
  return {
    stash: s,
    ageDays: opts.ageDays ?? 30,
    ageBucket: opts.ageBucket ?? 'stale',
    sourceBranch: opts.sourceBranch,
    sourceBranchGone: opts.sourceBranchGone ?? false,
    cleanSubject: opts.cleanSubject ?? 'refactor extract user fetch',
    named: opts.named ?? false,
    dropSafe: opts.dropSafe ?? false,
  };
}

// ── sanitiseFilenameComponent ─────────────────────────────────────────
test('sanitiseFilenameComponent: lowercases and replaces non-alphanumerics with -', () => {
  assert.equal(sanitiseFilenameComponent('Refactor: extract user fetch (#42)', 50), 'refactor-extract-user-fetch-42');
});

test('sanitiseFilenameComponent: collapses runs of dashes', () => {
  assert.equal(sanitiseFilenameComponent('A!!!B   C', 50), 'a-b-c');
});

test('sanitiseFilenameComponent: strips leading and trailing dashes', () => {
  assert.equal(sanitiseFilenameComponent('---hello---', 50), 'hello');
});

test('sanitiseFilenameComponent: caps at maxLen and removes trailing dash post-cut', () => {
  const out = sanitiseFilenameComponent('aaaaa-bbbbb-ccccc-dddddd', 11);
  assert.ok(out.length <= 11);
  assert.ok(!out.endsWith('-'));
});

test('sanitiseFilenameComponent: handles empty input', () => {
  assert.equal(sanitiseFilenameComponent('', 50), '');
});

test('sanitiseFilenameComponent: turns release/2026.q2 into release-2026-q2', () => {
  assert.equal(sanitiseFilenameComponent('release/2026.q2', 30), 'release-2026-q2');
});

// ── deriveStashPatchFilename ──────────────────────────────────────────
test('deriveStashPatchFilename: includes prefix + timestamp + branch + subject + fingerprint + ext', () => {
  const out = deriveStashPatchFilename({
    stash: makeStash({ subject: 'WIP on feature/x: refactor user fetch' }),
    cleanSubject: 'refactor user fetch',
    sourceBranch: 'feature/x',
    now: new Date(2026, 5, 23, 13, 42),
  });
  assert.match(out, /^gitsight-stash__2026-06-23-1342/);
  assert.match(out, /on-feature-x/);
  assert.match(out, /refactor-user-fetch/);
  assert.match(out, /\.patch$/);
});

test('deriveStashPatchFilename: omits branch component when no source branch', () => {
  const out = deriveStashPatchFilename({
    stash: makeStash({ subject: 'On detached: foo' }),
    cleanSubject: 'foo',
    sourceBranch: undefined,
    now: new Date(2026, 5, 23, 13, 42),
  });
  assert.ok(!out.includes('on-'));
});

test('deriveStashPatchFilename: identical stashes get DIFFERENT fingerprints via ref + date', () => {
  const a = deriveStashPatchFilename({
    stash: makeStash({ ref: 'stash@{0}', subject: 'WIP', date: new Date('2026-06-01T12:00:00Z') }),
    cleanSubject: 'wip',
    sourceBranch: 'main',
    now: new Date(2026, 5, 23, 13, 42),
  });
  const b = deriveStashPatchFilename({
    stash: makeStash({ ref: 'stash@{1}', subject: 'WIP', date: new Date('2026-06-02T12:00:00Z') }),
    cleanSubject: 'wip',
    sourceBranch: 'main',
    now: new Date(2026, 5, 23, 13, 42),
  });
  // Same subject + same now + same branch but different ref + date -> different fingerprint
  assert.notEqual(a, b);
});

test('deriveStashPatchFilename: long subject + long branch -> filename trimmed to safe length', () => {
  const longSubject = 'a'.repeat(200);
  const longBranch = 'b'.repeat(200);
  const out = deriveStashPatchFilename({
    stash: makeStash({ subject: longSubject }),
    cleanSubject: longSubject,
    sourceBranch: longBranch,
    now: new Date(2026, 5, 23, 13, 42),
  });
  assert.ok(out.length <= 200, `expected <=200 chars, got ${out.length}`);
});

test('deriveStashPatchFilename: subject == branch drops duplicate component', () => {
  const out = deriveStashPatchFilename({
    stash: makeStash(),
    cleanSubject: 'main',
    sourceBranch: 'main',
    now: new Date(2026, 5, 23, 13, 42),
  });
  // Only `on-main` should appear; the duplicate `main` subject is dropped.
  const occurrences = (out.match(/main/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test('deriveStashPatchFilename: subject defaulted to "stash" when missing', () => {
  const out = deriveStashPatchFilename({
    stash: makeStash({ subject: '' }),
    cleanSubject: '',
    sourceBranch: undefined,
    now: new Date(2026, 5, 23, 13, 42),
  });
  assert.match(out, /stash/);
  assert.match(out, /\.patch$/);
});

// ── validateFilename ──────────────────────────────────────────────────
test('validateFilename: ok for normal names', () => {
  assert.equal(validateFilename('gitsight-stash__2026-06-23-1342__main__a3f2.patch'), undefined);
});

test('validateFilename: rejects empty', () => {
  assert.match(validateFilename('') ?? '', /empty/);
});

test('validateFilename: rejects illegal characters', () => {
  for (const bad of ['foo/bar', 'foo<bar', 'foo:bar', 'foo|bar', 'foo*bar']) {
    assert.match(validateFilename(bad) ?? '', /illegal/);
  }
});

test('validateFilename: rejects trailing dot or space', () => {
  assert.match(validateFilename('foo.') ?? '', /dot or space/);
  assert.match(validateFilename('foo ') ?? '', /dot or space/);
});

test('validateFilename: rejects Windows reserved names', () => {
  for (const reserved of ['CON.patch', 'PRN', 'aux.patch', 'NUL', 'COM1.patch', 'LPT9.patch']) {
    assert.match(validateFilename(reserved) ?? '', /reserved/);
  }
});

test('validateFilename: rejects too-long filenames', () => {
  const tooLong = 'a'.repeat(201) + '.patch';
  assert.match(validateFilename(tooLong) ?? '', /exceeds/);
});

// ── buildExportPlan ───────────────────────────────────────────────────
test('buildExportPlan: named stashes are pre-ticked for export', () => {
  const c = makeCandidate({ named: true, ageBucket: 'fresh' });
  const plan = buildExportPlan([c], new Date(2026, 5, 23, 13, 42));
  assert.equal(plan[0].priority, 'export');
  assert.equal(plan[0].rationale, 'named');
});

test('buildExportPlan: branch-gone stashes are pre-ticked', () => {
  const c = makeCandidate({ sourceBranchGone: true, sourceBranch: 'feat/dead', ageBucket: 'stale' });
  const plan = buildExportPlan([c], new Date(2026, 5, 23, 13, 42));
  assert.equal(plan[0].priority, 'export');
  assert.equal(plan[0].rationale, 'branch-gone');
});

test('buildExportPlan: ancient stashes are pre-ticked', () => {
  const c = makeCandidate({ ageBucket: 'ancient', ageDays: 200 });
  const plan = buildExportPlan([c], new Date(2026, 5, 23, 13, 42));
  assert.equal(plan[0].priority, 'export');
  assert.equal(plan[0].rationale, 'ancient');
});

test('buildExportPlan: stale but recent + named=false -> optional', () => {
  const c = makeCandidate({ ageBucket: 'stale', named: false, sourceBranchGone: false });
  const plan = buildExportPlan([c], new Date(2026, 5, 23, 13, 42));
  assert.equal(plan[0].priority, 'optional');
  assert.equal(plan[0].rationale, 'stale');
});

test('buildExportPlan: fresh + unnamed -> low-value optional', () => {
  const c = makeCandidate({ ageBucket: 'fresh', named: false });
  const plan = buildExportPlan([c], new Date(2026, 5, 23, 13, 42));
  assert.equal(plan[0].priority, 'optional');
  assert.equal(plan[0].rationale, 'low-value');
});

test('buildExportPlan: rationale precedence - named beats ancient', () => {
  const c = makeCandidate({ named: true, ageBucket: 'ancient' });
  const plan = buildExportPlan([c], new Date(2026, 5, 23, 13, 42));
  // Named is more informative than "ancient" - keep that rationale.
  assert.equal(plan[0].rationale, 'named');
});

test('buildExportPlan: each candidate gets a unique-derived filename', () => {
  const a = makeCandidate({ index: 0, subject: 'WIP refactor', cleanSubject: 'refactor', date: new Date('2026-01-01T00:00:00Z') });
  const b = makeCandidate({ index: 1, subject: 'WIP refactor', cleanSubject: 'refactor', date: new Date('2026-02-01T00:00:00Z') });
  const plan = buildExportPlan([a, b], new Date(2026, 5, 23, 13, 42));
  assert.notEqual(plan[0].filename, plan[1].filename);
});

// ── summariseExportPlan + describeExportPlan ──────────────────────────
test('summariseExportPlan: counts export vs optional', () => {
  const plan: PatchExportCandidate[] = [
    { candidate: makeCandidate(), rationale: 'named', rationaleNote: '', filename: 'a.patch', priority: 'export' },
    { candidate: makeCandidate(), rationale: 'stale', rationaleNote: '', filename: 'b.patch', priority: 'optional' },
    { candidate: makeCandidate(), rationale: 'ancient', rationaleNote: '', filename: 'c.patch', priority: 'export' },
  ];
  const s = summariseExportPlan(plan);
  assert.equal(s.total, 3);
  assert.equal(s.exportPriority, 2);
  assert.equal(s.optionalPriority, 1);
});

test('describeExportPlan: pluralisation', () => {
  assert.equal(describeExportPlan({ total: 0, exportPriority: 0, optionalPriority: 0 }), 'no stashes to export');
  assert.equal(describeExportPlan({ total: 1, exportPriority: 1, optionalPriority: 0 }), '1 stash - 1 to export, 0 optional');
  assert.equal(describeExportPlan({ total: 5, exportPriority: 2, optionalPriority: 3 }), '5 stashes - 2 to export, 3 optional');
});

// ── buildExportReport ─────────────────────────────────────────────────
test('buildExportReport: empty plan -> stub', () => {
  const md = buildExportReport({
    plan: [], exportedFilenames: [], failures: [], now: new Date(2026, 5, 23, 13, 42), exportDir: '/tmp/dir',
  });
  assert.match(md, /No stashes processed/);
});

test('buildExportReport: shows per-row filename when exported', () => {
  const plan: PatchExportCandidate[] = [
    { candidate: makeCandidate({ subject: 'WIP', cleanSubject: 'refactor', sourceBranch: 'feature/x', ref: 'stash@{0}' } as any), rationale: 'named', rationaleNote: '', filename: 'a.patch', priority: 'export' },
  ];
  const md = buildExportReport({
    plan,
    exportedFilenames: ['a.patch'],
    failures: [],
    now: new Date(2026, 5, 23, 13, 42),
    exportDir: '/tmp/d',
  });
  assert.match(md, /`a\.patch`/);
  assert.match(md, /refactor/);
});

test('buildExportReport: shows _failed: ..._ when in failures', () => {
  const plan: PatchExportCandidate[] = [
    { candidate: makeCandidate(), rationale: 'named', rationaleNote: '', filename: 'a.patch', priority: 'export' },
  ];
  const md = buildExportReport({
    plan,
    exportedFilenames: [],
    failures: [{ filename: 'a.patch', error: 'permission denied' }],
    now: new Date(2026, 5, 23, 13, 42),
    exportDir: '/tmp/d',
  });
  assert.match(md, /_failed: permission denied_/);
});

test('buildExportReport: shows _skipped_ when not exported and no failure', () => {
  const plan: PatchExportCandidate[] = [
    { candidate: makeCandidate(), rationale: 'named', rationaleNote: '', filename: 'a.patch', priority: 'export' },
  ];
  const md = buildExportReport({
    plan,
    exportedFilenames: [],
    failures: [],
    now: new Date(2026, 5, 23, 13, 42),
    exportDir: '/tmp/d',
  });
  assert.match(md, /_skipped_/);
});

test('buildExportReport: escapes pipe characters in subjects', () => {
  const plan: PatchExportCandidate[] = [
    { candidate: makeCandidate({ cleanSubject: 'pipe | in subject' }), rationale: 'named', rationaleNote: '', filename: 'a.patch', priority: 'export' },
  ];
  const md = buildExportReport({
    plan, exportedFilenames: ['a.patch'], failures: [],
    now: new Date(2026, 5, 23, 13, 42), exportDir: '/tmp/d',
  });
  assert.match(md, /pipe \\\| in subject/);
});
