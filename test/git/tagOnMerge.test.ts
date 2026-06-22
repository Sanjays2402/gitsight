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
  isPrereleaseTag,
  extractReleaseAsTag,
  explicitReleaseTagFromCommits,
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

// ── F92: prerelease detection ──────────────────────────────────────

test('isPrereleaseTag: standard prerelease segments recognised', () => {
  assert.equal(isPrereleaseTag('v1.0.0-alpha'), true);
  assert.equal(isPrereleaseTag('v1.0.0-beta.1'), true);
  assert.equal(isPrereleaseTag('v1.0.0-rc.2'), true);
  assert.equal(isPrereleaseTag('v0.5.0-pre.0'), true);
  assert.equal(isPrereleaseTag('v3.0.0-canary'), true);
  assert.equal(isPrereleaseTag('v0.1.0-nightly.20'), true);
  assert.equal(isPrereleaseTag('v3.0.0-next.1'), true);
});

test('isPrereleaseTag: works without v prefix', () => {
  assert.equal(isPrereleaseTag('1.2.3-alpha'), true);
  assert.equal(isPrereleaseTag('2.0.0-beta.5'), true);
});

test('isPrereleaseTag: stable releases NOT flagged', () => {
  assert.equal(isPrereleaseTag('v1.0.0'), false);
  assert.equal(isPrereleaseTag('v2.3.4'), false);
  assert.equal(isPrereleaseTag('1.0.0'), false);
});

test('isPrereleaseTag: arbitrary hyphenated suffix NOT a prerelease', () => {
  // \"v1.0.0-fix-hotpatch\" is a custom tag, not a SemVer prerelease.
  assert.equal(isPrereleaseTag('v1.0.0-fix-hotpatch'), false);
  assert.equal(isPrereleaseTag('v1.0.0-redhat-build'), false);
});

test('isPrereleaseTag: case-insensitive match', () => {
  assert.equal(isPrereleaseTag('v1.0.0-ALPHA'), true);
  assert.equal(isPrereleaseTag('v1.0.0-Beta.1'), true);
  assert.equal(isPrereleaseTag('V1.0.0-rc.0'), true);
});

test('isPrereleaseTag: empty / whitespace -> false', () => {
  assert.equal(isPrereleaseTag(''), false);
  assert.equal(isPrereleaseTag('   '), false);
  assert.equal(isPrereleaseTag(undefined as any), false);
});

// ───────────── F97: Release-as trailer ─────────────

test('extractReleaseAsTag: picks the explicit tag from a clean trailer', () => {
  const body = [
    'Some body text.',
    '',
    'Release-as: v2.0.0',
  ].join('\n');
  assert.equal(extractReleaseAsTag(body), 'v2.0.0');
});

test('extractReleaseAsTag: case-insensitive key', () => {
  assert.equal(extractReleaseAsTag('Release-As: v1.2.3'), 'v1.2.3');
  assert.equal(extractReleaseAsTag('release-as: 2.0.0-rc.1'), '2.0.0-rc.1');
  assert.equal(extractReleaseAsTag('RELEASE-AS: v0.1.0'), 'v0.1.0');
});

test('extractReleaseAsTag: ignores mid-line / prose mentions', () => {
  const body = "we'll do a Release-as: v9.9.9 next sprint, not this PR";
  assert.equal(extractReleaseAsTag(body), undefined);
});

test('extractReleaseAsTag: trims whitespace + drops trailing CR/LF artifacts', () => {
  assert.equal(extractReleaseAsTag('Release-as:   v3.4.5   '), 'v3.4.5');
  assert.equal(extractReleaseAsTag('Release-as: v3.4.5\r'), 'v3.4.5');
});

test('extractReleaseAsTag: skip/none sentinels return undefined', () => {
  assert.equal(extractReleaseAsTag('Release-as: skip'), undefined);
  assert.equal(extractReleaseAsTag('Release-as: none'), undefined);
  assert.equal(extractReleaseAsTag('Release-as: no'), undefined);
  assert.equal(extractReleaseAsTag('Release-as: NONE'), undefined);
});

test('extractReleaseAsTag: empty body / missing trailer -> undefined', () => {
  assert.equal(extractReleaseAsTag(''), undefined);
  assert.equal(extractReleaseAsTag('plain body, no trailer'), undefined);
});

test('extractReleaseAsTag: empty value -> undefined', () => {
  assert.equal(extractReleaseAsTag('Release-as:   '), undefined);
});

test('extractReleaseAsTag: handles preserves non-semver values verbatim (no validation here)', () => {
  // Pure helper does NOT semver-validate — that's the view's regex gate.
  assert.equal(extractReleaseAsTag('Release-as: weird-tag-shape'), 'weird-tag-shape');
});

test('explicitReleaseTagFromCommits: returns tag from FIRST commit when present', () => {
  const c1 = mk('feat: thing', 'Body\n\nRelease-as: v5.0.0');
  const c2 = mk('feat: other', 'Body\n\nRelease-as: v9.0.0');
  assert.equal(explicitReleaseTagFromCommits([c1, c2]), 'v5.0.0');
});

test('explicitReleaseTagFromCommits: walks up to 5 commits to find trailer', () => {
  // First 3 commits have no trailer; 4th has the explicit tag.
  const cs: MergedCommit[] = [
    mk('feat: a', 'no trailer'),
    mk('feat: b', 'still no trailer'),
    mk('feat: c', ''),
    mk('feat: d', 'Some body\n\nRelease-as: v7.7.7\n'),
    mk('feat: e', 'Release-as: v0.0.1'),
  ];
  assert.equal(explicitReleaseTagFromCommits(cs), 'v7.7.7');
});

test('explicitReleaseTagFromCommits: stops at 5-commit cap', () => {
  const cs: MergedCommit[] = [];
  for (let i = 0; i < 5; i++) cs.push(mk(`feat: x${i}`, 'no trailer here'));
  // 6th commit has it, but we don't scan that far.
  cs.push(mk('feat: x5', 'Release-as: v6.6.6'));
  assert.equal(explicitReleaseTagFromCommits(cs), undefined);
});

test('explicitReleaseTagFromCommits: empty list -> undefined', () => {
  assert.equal(explicitReleaseTagFromCommits([]), undefined);
});

test('explicitReleaseTagFromCommits: every commit has skip sentinel -> undefined', () => {
  const cs = [
    mk('chore: bump', 'Release-as: skip'),
    mk('chore: bump 2', 'Release-as: none'),
  ];
  assert.equal(explicitReleaseTagFromCommits(cs), undefined);
});
