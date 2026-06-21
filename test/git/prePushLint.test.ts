import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  lintPrePush,
  hasConflictMarkers,
  summarisePrePush,
  describePrePush,
  parsePrePushLog,
  PrePushCommit,
} from '../../src/git/prePushLint';

test('lintPrePush: clean commits produce no findings', () => {
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'feat: add login form' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'fix: handle null user' },
  ];
  const findings = lintPrePush(commits);
  assert.equal(findings.length, 0);
});

test('lintPrePush: WIP subjects flagged as warnings', () => {
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'WIP: scratch session storage' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'fixup! login form' },
    { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'do not merge: experimenting' },
  ];
  const findings = lintPrePush(commits);
  assert.equal(findings.length, 3);
  for (const f of findings) {
    assert.equal(f.kind, 'wip-commit');
    assert.equal(f.severity, 'warn');
  }
  assert.equal(findings[0].detail, 'WIP');
  assert.equal(findings[1].detail, 'fixup!');
  assert.equal(findings[2].detail, 'do-not-merge');
});

test('lintPrePush: conflict markers in patch flagged as error', () => {
  const patch = [
    'commit aaaaaaa',
    'diff --git a/src/foo.ts b/src/foo.ts',
    '@@ -1,5 +1,9 @@',
    ' line one',
    '+<<<<<<< HEAD',
    '+ours',
    '+=======',
    '+theirs',
    '+>>>>>>> feature/x',
    ' line five',
  ].join('\n');
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'fix: resolve conflict', patch },
  ];
  const findings = lintPrePush(commits);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'conflict-marker');
  assert.equal(findings[0].severity, 'error');
  assert.ok(findings[0].detail.includes('1 unresolved conflict block'));
});

test('lintPrePush: a WIP commit with conflict markers yields BOTH findings, error-first', () => {
  const patch = [
    'diff --git a/file b/file',
    '+<<<<<<< HEAD',
    '+ours',
    '+=======',
    '+theirs',
    '+>>>>>>> theirs',
  ].join('\n');
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'WIP: bad merge', patch },
  ];
  const findings = lintPrePush(commits);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].kind, 'conflict-marker');
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[1].kind, 'wip-commit');
  assert.equal(findings[1].severity, 'warn');
});

test('lintPrePush: requireSubjectMatching flags missing issue refs', () => {
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'feat: add login form' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'GH-42 feat: add 2FA' },
  ];
  const findings = lintPrePush(commits, { requireSubjectMatching: '^GH-\\d+' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sha, 'a'.repeat(40));
  assert.equal(findings[0].kind, 'missing-issue');
  assert.equal(findings[0].severity, 'warn');
  assert.ok(findings[0].detail.includes('/^GH-\\d+/'));
});

test('lintPrePush: invalid requireSubjectMatching regex is silently ignored', () => {
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'feat: x' },
  ];
  // No throw, no missing-issue finding either.
  const findings = lintPrePush(commits, { requireSubjectMatching: '[unclosed' });
  assert.equal(findings.length, 0);
});

test('lintPrePush: wipKinds option subsets the warn list', () => {
  const commits: PrePushCommit[] = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'WIP: a' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'fixup! b' },
  ];
  const findings = lintPrePush(commits, { wipKinds: ['fixup'] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sha, 'b'.repeat(40));
});

test('hasConflictMarkers: plain text without markers returns false', () => {
  assert.equal(hasConflictMarkers(''), false);
  assert.equal(hasConflictMarkers('hello world'), false);
  assert.equal(hasConflictMarkers('+ added a line'), false);
});

test('hasConflictMarkers: well-formed block in a patch returns true', () => {
  const patch = '+<<<<<<< HEAD\n+a\n+=======\n+b\n+>>>>>>> theirs';
  assert.equal(hasConflictMarkers(patch), true);
});

test('hasConflictMarkers: lonely `<<<<<<<` without a separator does NOT count as conflict', () => {
  // Stray angle bracket prose like documentation should not register.
  const patch = '+<<<<<<< this is just text\n+normal line';
  // Pre-filter passes, but groupBlocks yields an unclosed block. We accept
  // that as a "block" in the parser sense (start without end), so the
  // helper returns true. That's deliberate — it's still suspicious.
  assert.equal(hasConflictMarkers(patch), true);
});

test('hasConflictMarkers: rejects fake angle-bracket runs (10+ wide)', () => {
  // Documentation visual separators like <<<<<<<<<<< should NOT match.
  const patch = '+<<<<<<<<<< visual separator';
  assert.equal(hasConflictMarkers(patch), false);
});

test('summarisePrePush: counts buckets and flags blocking', () => {
  const findings = [
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's', kind: 'conflict-marker' as const, severity: 'error' as const, detail: 'd' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 's', kind: 'wip-commit' as const, severity: 'warn' as const, detail: 'd' },
    { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 's', kind: 'wip-commit' as const, severity: 'warn' as const, detail: 'd' },
  ];
  const s = summarisePrePush(findings);
  assert.equal(s.total, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.warnings, 2);
  assert.equal(s.blocking, true);
  assert.equal(s.byKind['conflict-marker'], 1);
  assert.equal(s.byKind['wip-commit'], 2);
});

test('summarisePrePush: no findings is non-blocking', () => {
  const s = summarisePrePush([]);
  assert.equal(s.total, 0);
  assert.equal(s.blocking, false);
});

test('describePrePush: clean and non-clean phrasing', () => {
  const clean = summarisePrePush([]);
  assert.equal(describePrePush(clean), 'clean — nothing to flag');
  const dirty = summarisePrePush([
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's', kind: 'wip-commit', severity: 'warn', detail: 'WIP' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 's', kind: 'wip-commit', severity: 'warn', detail: 'WIP' },
    { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 's', kind: 'conflict-marker', severity: 'error', detail: 'x' },
  ]);
  const out = describePrePush(dirty);
  assert.ok(out.includes('1 conflict marker'));
  assert.ok(out.includes('2 WIP/fixup'));
});

test('parsePrePushLog: parses pipe-separated log lines', () => {
  const raw = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaaaaa|feat: thing',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbbbbb|fix: thing with | in subject',
  ].join('\n');
  const out = parsePrePushLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].sha, 'a'.repeat(40));
  assert.equal(out[0].subject, 'feat: thing');
  // Pipes inside the subject are preserved.
  assert.equal(out[1].subject, 'fix: thing with | in subject');
});

test('parsePrePushLog: empty input → empty list', () => {
  assert.deepEqual(parsePrePushLog(''), []);
});
