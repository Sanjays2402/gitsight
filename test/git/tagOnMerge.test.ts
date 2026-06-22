import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseConventionalHeader,
  classifyCommitBump,
  classifyRangeBump,
  parseSemverTag,
  applyBump,
  suggestNextTag,
  buildReleaseNotes,
  detectMergedPrNumber,
  MergedCommit,
} from '../../src/git/tagOnMerge';

function mk(subject: string, body = '', author = 'alice', sha = 'a'.repeat(40)): MergedCommit {
  return { sha, shortSha: sha.slice(0, 7), subject, body, author };
}

// ── parseConventionalHeader ─────────────────────────────────────

test('parseConventionalHeader: feat(scope)', () => {
  assert.deepEqual(parseConventionalHeader('feat(git): add branch picker'), {
    type: 'feat', scope: 'git', breaking: false, description: 'add branch picker',
  });
});

test('parseConventionalHeader: bang marks breaking', () => {
  assert.deepEqual(parseConventionalHeader('fix!: drop deprecated flag'), {
    type: 'fix', scope: undefined, breaking: true, description: 'drop deprecated flag',
  });
});

test('parseConventionalHeader: scope + bang', () => {
  assert.deepEqual(parseConventionalHeader('feat(api)!: rename foo to bar'), {
    type: 'feat', scope: 'api', breaking: true, description: 'rename foo to bar',
  });
});

test('parseConventionalHeader: rejects non-conventional shapes', () => {
  assert.equal(parseConventionalHeader('Random commit'), undefined);
  assert.equal(parseConventionalHeader('FEAT: caps type'), undefined);
  assert.equal(parseConventionalHeader('feat:no space'), undefined);
  assert.equal(parseConventionalHeader(''), undefined);
});

// ── classifyCommitBump ──────────────────────────────────────────

test('classifyCommitBump: feat is minor', () => {
  assert.equal(classifyCommitBump(mk('feat(x): add')), 'minor');
});

test('classifyCommitBump: fix is patch', () => {
  assert.equal(classifyCommitBump(mk('fix: stop crashing')), 'patch');
});

test('classifyCommitBump: perf is patch', () => {
  assert.equal(classifyCommitBump(mk('perf: cache compiled regex')), 'patch');
});

test('classifyCommitBump: bang in header is major', () => {
  assert.equal(classifyCommitBump(mk('feat!: rename')), 'major');
});

test('classifyCommitBump: BREAKING CHANGE in body is major regardless of type', () => {
  const c = mk('chore: refactor', 'Body line\n\nBREAKING CHANGE: old API removed');
  assert.equal(classifyCommitBump(c), 'major');
});

test('classifyCommitBump: BREAKING-CHANGE hyphenated form also detected', () => {
  const c = mk('refactor: rewrite', 'BREAKING-CHANGE: signature now async');
  assert.equal(classifyCommitBump(c), 'major');
});

test('classifyCommitBump: docs/chore/style without breaking is none', () => {
  assert.equal(classifyCommitBump(mk('docs: typo')), 'none');
  assert.equal(classifyCommitBump(mk('chore: bump deps')), 'none');
  assert.equal(classifyCommitBump(mk('style: format')), 'none');
});

test('classifyCommitBump: non-conventional subject is none', () => {
  assert.equal(classifyCommitBump(mk('WIP debugging')), 'none');
});

// ── classifyRangeBump ───────────────────────────────────────────

test('classifyRangeBump: empty range is none', () => {
  assert.equal(classifyRangeBump([]), 'none');
});

test('classifyRangeBump: takes the MAX bump observed', () => {
  assert.equal(classifyRangeBump([
    mk('docs: a'),
    mk('fix: b'),
    mk('feat: c'),
  ]), 'minor');
});

test('classifyRangeBump: major wins over minor/patch', () => {
  assert.equal(classifyRangeBump([
    mk('feat: a'),
    mk('feat!: b'),
    mk('fix: c'),
  ]), 'major');
});

test('classifyRangeBump: only chore/docs is none', () => {
  assert.equal(classifyRangeBump([
    mk('docs: a'),
    mk('chore: b'),
  ]), 'none');
});

// ── parseSemverTag ──────────────────────────────────────────────

test('parseSemverTag: v-prefix preserved', () => {
  assert.deepEqual(parseSemverTag('v1.2.3'), {
    prefix: 'v', major: 1, minor: 2, patch: 3, pre: undefined,
  });
});

test('parseSemverTag: no-prefix preserved', () => {
  assert.deepEqual(parseSemverTag('1.2.3'), {
    prefix: '', major: 1, minor: 2, patch: 3, pre: undefined,
  });
});

test('parseSemverTag: pre-release captured', () => {
  assert.deepEqual(parseSemverTag('v2.0.0-rc.1'), {
    prefix: 'v', major: 2, minor: 0, patch: 0, pre: 'rc.1',
  });
});

test('parseSemverTag: build metadata stripped', () => {
  assert.deepEqual(parseSemverTag('v1.0.0+build.42'), {
    prefix: 'v', major: 1, minor: 0, patch: 0, pre: undefined,
  });
});

test('parseSemverTag: rejects non-semver', () => {
  assert.equal(parseSemverTag('release-1'), undefined);
  assert.equal(parseSemverTag('1.2'), undefined);
  assert.equal(parseSemverTag(''), undefined);
  assert.equal(parseSemverTag('vX.Y.Z'), undefined);
});

// ── applyBump ───────────────────────────────────────────────────

test('applyBump: major resets minor + patch', () => {
  const p = parseSemverTag('v1.4.7')!;
  assert.equal(applyBump(p, 'major'), 'v2.0.0');
});

test('applyBump: minor resets patch', () => {
  const p = parseSemverTag('v1.4.7')!;
  assert.equal(applyBump(p, 'minor'), 'v1.5.0');
});

test('applyBump: patch increments patch', () => {
  const p = parseSemverTag('v1.4.7')!;
  assert.equal(applyBump(p, 'patch'), 'v1.4.8');
});

test('applyBump: pre-release is dropped on bump', () => {
  const p = parseSemverTag('v2.0.0-rc.1')!;
  assert.equal(applyBump(p, 'minor'), 'v2.1.0');
  assert.equal(applyBump(p, 'patch'), 'v2.0.1');
});

test('applyBump: no-prefix tags stay no-prefix', () => {
  const p = parseSemverTag('1.2.3')!;
  assert.equal(applyBump(p, 'minor'), '1.3.0');
});

test('applyBump: none returns undefined', () => {
  const p = parseSemverTag('v1.0.0')!;
  assert.equal(applyBump(p, 'none'), undefined);
});

// ── suggestNextTag ──────────────────────────────────────────────

test('suggestNextTag: bumps from previous semver tag', () => {
  assert.equal(suggestNextTag('v1.0.0', [mk('feat: a')]), 'v1.1.0');
  assert.equal(suggestNextTag('v1.0.0', [mk('fix: a')]), 'v1.0.1');
  assert.equal(suggestNextTag('v1.0.0', [mk('feat!: a')]), 'v2.0.0');
});

test('suggestNextTag: no previous tag seeds with v0.0.1 for patch', () => {
  assert.equal(suggestNextTag(undefined, [mk('fix: first')]), 'v0.0.1');
});

test('suggestNextTag: no previous tag seeds with v0.1.0 for minor', () => {
  assert.equal(suggestNextTag(undefined, [mk('feat: first')]), 'v0.1.0');
});

test('suggestNextTag: no previous tag seeds with v0.1.0 even for major', () => {
  // 0.x semver convention — major bumps within 0.x are expressed as 0.y bumps.
  // The user can manually pick v1.0.0 when they're ready.
  assert.equal(suggestNextTag(undefined, [mk('feat!: first')]), 'v0.1.0');
});

test('suggestNextTag: no bump returns undefined', () => {
  assert.equal(suggestNextTag('v1.0.0', [mk('docs: a')]), undefined);
});

test('suggestNextTag: non-semver previous tag returns undefined', () => {
  assert.equal(suggestNextTag('release-1', [mk('feat: a')]), undefined);
});

// ── buildReleaseNotes ───────────────────────────────────────────

test('buildReleaseNotes: groups by type with breaking-first ordering', () => {
  const out = buildReleaseNotes({
    commits: [
      mk('feat(git): add picker', '', 'alice', 'a'.repeat(40)),
      mk('fix(parser): handle empty', '', 'bob', 'b'.repeat(40)),
      mk('feat!: drop legacy', '', 'alice', 'c'.repeat(40)),
      mk('chore: bump deps', '', 'carol', 'd'.repeat(40)),
    ],
    range: 'v1.0.0..HEAD',
    nextTag: 'v2.0.0',
  });
  // Section ordering: tag header → Breaking → Features → Fixes → Other.
  const sections = ['## v2.0.0', '### Breaking changes', '### Features', '### Fixes', '### Other'];
  let prev = -1;
  for (const s of sections) {
    const idx = out.indexOf(s);
    assert.ok(idx > prev, `expected ${s} after position ${prev}, got ${idx}`);
    prev = idx;
  }
});

test('buildReleaseNotes: empty sections are skipped', () => {
  const out = buildReleaseNotes({
    commits: [mk('feat: a'), mk('feat: b')],
    nextTag: 'v0.2.0',
  });
  assert.match(out, /### Features/);
  assert.doesNotMatch(out, /### Fixes/);
  assert.doesNotMatch(out, /### Breaking changes/);
});

test('buildReleaseNotes: contributors list dedups preserving first-seen order', () => {
  const out = buildReleaseNotes({
    commits: [
      mk('feat: a', '', 'bob'),
      mk('feat: b', '', 'alice'),
      mk('feat: c', '', 'bob'),
    ],
    nextTag: 'v0.2.0',
  });
  assert.match(out, /## Contributors\nbob, alice$/m);
});

test('buildReleaseNotes: no contributors with names omits the section', () => {
  const out = buildReleaseNotes({
    commits: [{ sha: 'x'.repeat(40), shortSha: 'xxxxxxx', subject: 'feat: a', body: '' }],
    nextTag: 'v0.2.0',
  });
  assert.doesNotMatch(out, /## Contributors/);
});

test('buildReleaseNotes: bullet lines include short SHA in parens', () => {
  const out = buildReleaseNotes({
    commits: [mk('feat: add picker', '', 'alice', 'abc1234' + '0'.repeat(33))],
    nextTag: 'v0.2.0',
  });
  assert.match(out, /- feat: add picker \(abc1234\)/);
});

// ── detectMergedPrNumber ───────────────────────────────────────

test('detectMergedPrNumber: Merge pull request #N shape', () => {
  assert.equal(detectMergedPrNumber('Merge pull request #42 from foo/bar'), 42);
});

test('detectMergedPrNumber: squash-merge "subject (#N)" shape', () => {
  assert.equal(detectMergedPrNumber('feat(git): add branch picker (#7)'), 7);
});

test('detectMergedPrNumber: rejects bare # references', () => {
  assert.equal(detectMergedPrNumber('feat: closes #5'), undefined);
  assert.equal(detectMergedPrNumber('Random'), undefined);
  assert.equal(detectMergedPrNumber(''), undefined);
});

test('detectMergedPrNumber: tolerates trailing whitespace', () => {
  assert.equal(detectMergedPrNumber('feat: x (#9)   '), 9);
});
