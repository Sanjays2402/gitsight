import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  normaliseSubject,
  parseLogRecords,
  findAlreadyPicked,
  describeMatch,
  warningHeadline,
} from '../../src/git/cherryPickScout';

test('normaliseSubject: strips conventional-commit prefix', () => {
  assert.equal(normaliseSubject('feat(git): add quick switcher'), 'add quick switcher');
  assert.equal(normaliseSubject('fix: handle null path'), 'handle null path');
  assert.equal(normaliseSubject('feat!: breaking subject'), 'breaking subject');
  assert.equal(normaliseSubject('refactor(core): tidy up'), 'tidy up');
});

test('normaliseSubject: strips trailing #PR number', () => {
  assert.equal(
    normaliseSubject('feat(git): add quick switcher (#1234)'),
    'add quick switcher',
  );
});

test('normaliseSubject: strips leading [tag] / [backport]', () => {
  assert.equal(normaliseSubject('[backport 1.x] feat: fix null path'), 'fix null path');
  assert.equal(normaliseSubject('[release/2.0] chore: bump'), 'bump');
});

test('normaliseSubject: collapses whitespace, lowercases, trims period', () => {
  assert.equal(normaliseSubject('  feat: HANDLE  null   PATH.  '), 'handle null path');
});

test('normaliseSubject: empty input safe', () => {
  assert.equal(normaliseSubject(''), '');
  assert.equal(normaliseSubject(undefined as any), '');
});

test('parseLogRecords: parses one record', () => {
  const raw = 'abc123|abc123|Alice|2026-06-21T00:00:00Z|Subject line\nbody line one\nbody line two\n--RECORD--';
  const recs = parseLogRecords(raw);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].sha, 'abc123');
  assert.equal(recs[0].subject, 'Subject line');
  assert.match(recs[0].body ?? '', /body line one/);
});

test('parseLogRecords: parses multiple records', () => {
  const raw = [
    'a1|a1|Alice|2026-06-21T00:00:00Z|First\nbody A',
    '--RECORD--',
    'b2|b2|Bob|2026-06-20T00:00:00Z|Second\nbody B',
    '--RECORD--',
  ].join('\n');
  const recs = parseLogRecords(raw);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].subject, 'First');
  assert.equal(recs[1].subject, 'Second');
});

test('parseLogRecords: handles subjects with | chars', () => {
  const raw = 'abc|abc|Alice|2026-06-21T00:00:00Z|fix: handle a|b|c case\n--RECORD--';
  const recs = parseLogRecords(raw);
  assert.equal(recs[0].subject, 'fix: handle a|b|c case');
});

test('parseLogRecords: empty input returns []', () => {
  assert.deepEqual(parseLogRecords(''), []);
});

test('findAlreadyPicked: trailer match (exact sha prefix)', () => {
  const verdict = findAlreadyPicked(
    { sha: '0123456789abcdef0123456789abcdef01234567', subject: 'fix: anything' },
    [{
      sha: 'b2',
      shortSha: 'b2',
      subject: 'fix: anything (re-applied)',
      body: 'context\n\n(cherry picked from commit 0123456)\n',
    }],
  );
  assert.equal(verdict.alreadyPicked, true);
  assert.equal(verdict.matches[0].kind, 'trailer-exact');
});

test('findAlreadyPicked: subject-exact match', () => {
  const verdict = findAlreadyPicked(
    { sha: 'aaaa', subject: 'feat(git): add quick switcher' },
    [{
      sha: 'bbbb',
      shortSha: 'bbbb',
      subject: 'feat(git): add quick switcher',
    }],
  );
  assert.equal(verdict.matches[0].kind, 'subject-exact');
});

test('findAlreadyPicked: normalised match catches reword + PR-suffix', () => {
  const verdict = findAlreadyPicked(
    { sha: 'aaaa', subject: 'feat: handle null path' },
    [{
      sha: 'bbbb',
      shortSha: 'bbbb',
      subject: 'fix: handle null path (#42)',
    }],
  );
  // Normaliser strips the conventional header AND the PR suffix on both
  // sides, so they collide.
  assert.equal(verdict.alreadyPicked, true);
  assert.equal(verdict.matches[0].kind, 'subject-normalised');
});

test('findAlreadyPicked: nothing to find returns alreadyPicked=false', () => {
  const verdict = findAlreadyPicked(
    { sha: 'aaaa', subject: 'feat: brand new thing' },
    [{ sha: 'bbbb', shortSha: 'bbbb', subject: 'completely different' }],
  );
  assert.equal(verdict.alreadyPicked, false);
  assert.equal(verdict.matches.length, 0);
});

test('findAlreadyPicked: trailer > subject-exact > normalised ordering', () => {
  const source = { sha: '0123456789abcdef0123456789abcdef01234567', subject: 'feat: do x' };
  const verdict = findAlreadyPicked(source, [
    { sha: 'a1', shortSha: 'a1', subject: 'feat: do x' }, // subject-exact
    { sha: 'b2', shortSha: 'b2', subject: 'fix: do X (#9)' }, // normalised
    { sha: 'c3', shortSha: 'c3', subject: 'unrelated', body: '(cherry picked from commit 0123456)' }, // trailer
  ]);
  assert.equal(verdict.matches[0].sha, 'c3');
  assert.equal(verdict.matches[1].sha, 'a1');
  assert.equal(verdict.matches[2].sha, 'b2');
});

test('findAlreadyPicked: normaliser empty source = no false positives', () => {
  const verdict = findAlreadyPicked(
    { sha: 'aaaa', subject: '' },
    [{ sha: 'b2', shortSha: 'b2', subject: '' }],
  );
  assert.equal(verdict.alreadyPicked, false);
});

test('describeMatch: includes kind, author and date', () => {
  const out = describeMatch({
    sha: 'a1', shortSha: 'a1', subject: 'feat: x', kind: 'subject-exact',
    author: 'Alice', dateIso: '2026-06-21T12:34:56Z',
  });
  assert.match(out, /a1 feat: x/);
  assert.match(out, /exact subject/);
  assert.match(out, /by Alice/);
  assert.match(out, /2026-06-21/);
});

test('warningHeadline: empty verdict returns empty string', () => {
  const headline = warningHeadline(
    { shortSha: 'aaaa', subject: 'feat: do x' },
    { alreadyPicked: false, matches: [], normalisedSubject: 'do x' },
  );
  assert.equal(headline, '');
});

test('warningHeadline: single-match shape', () => {
  const headline = warningHeadline(
    { shortSha: 'aaaa', subject: 'feat: do x' },
    {
      alreadyPicked: true,
      normalisedSubject: 'do x',
      matches: [{
        sha: 'b2', shortSha: 'b2', subject: 'feat: do x', kind: 'subject-exact',
      }],
    },
  );
  assert.match(headline, /aaaa/);
  assert.match(headline, /matched b2/);
  assert.match(headline, /subject-exact/);
});

test('warningHeadline: multi-match shape', () => {
  const headline = warningHeadline(
    { shortSha: 'aaaa', subject: 'feat: do x' },
    {
      alreadyPicked: true,
      normalisedSubject: 'do x',
      matches: [
        { sha: 'b2', shortSha: 'b2', subject: 'feat: do x', kind: 'trailer-exact' },
        { sha: 'c3', shortSha: 'c3', subject: 'feat: do x', kind: 'subject-exact' },
      ],
    },
  );
  assert.match(headline, /2 matches/);
  assert.match(headline, /top: b2/);
});
