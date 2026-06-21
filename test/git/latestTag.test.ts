import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLatestTag,
  formatTagPill,
  formatTagTooltip,
} from '../../src/git/latestTag';

const tags = [
  { name: 'v1.0.0', sha: 'a', subject: 'first ga', date: new Date('2026-01-01') },
  { name: 'v1.1.0', sha: 'b', subject: 'minor bump', date: new Date('2026-02-15') },
  { name: 'v2.0.0-rc.1', sha: 'c', subject: 'breaking rc', date: new Date('2026-04-01') },
  { name: 'v1.1.1', sha: 'd', subject: 'patch fix', date: new Date('2026-03-10') },
];

test('pickLatestTag: returns undefined for empty input', () => {
  assert.equal(pickLatestTag([]), undefined);
});

test('pickLatestTag: default picks newest semver (pre-release allowed)', () => {
  const pick = pickLatestTag(tags);
  assert.equal(pick?.tag.name, 'v2.0.0-rc.1');
  assert.equal(pick?.isPre, true);
  assert.equal(pick?.isSemver, true);
});

test('pickLatestTag: preferStable skips pre-release in favour of stable', () => {
  const pick = pickLatestTag(tags, { preferStable: true });
  assert.equal(pick?.tag.name, 'v1.1.1');
  assert.equal(pick?.isPre, false);
});

test('pickLatestTag: preferStable falls back to pre when no stable exists', () => {
  const only = [tags[2]]; // just the rc
  const pick = pickLatestTag(only, { preferStable: true });
  assert.equal(pick?.tag.name, 'v2.0.0-rc.1');
  assert.equal(pick?.isPre, true);
});

test('pickLatestTag: marks non-semver tag correctly', () => {
  const odd = [{ name: 'release-2026Q2', sha: 'e', subject: 'q2 cut', date: new Date('2026-04-30') }];
  const pick = pickLatestTag(odd);
  assert.equal(pick?.tag.name, 'release-2026Q2');
  assert.equal(pick?.isSemver, false);
  assert.equal(pick?.isPre, false);
});

test('formatTagPill: bare tag name when no commits-since', () => {
  const pick = pickLatestTag(tags)!;
  assert.equal(formatTagPill(pick), 'v2.0.0-rc.1');
});

test('formatTagPill: appends +N when commits-since > 0', () => {
  const pick = pickLatestTag(tags, { preferStable: true })!;
  assert.equal(formatTagPill(pick, 5), 'v1.1.1 +5');
});

test('formatTagPill: omits +0 (HEAD is on the tag)', () => {
  const pick = pickLatestTag(tags, { preferStable: true })!;
  assert.equal(formatTagPill(pick, 0), 'v1.1.1');
});

test('formatTagTooltip: HEAD-on-tag message at zero commits since', () => {
  const pick = pickLatestTag(tags, { preferStable: true })!;
  const md = formatTagTooltip(pick, { ageLabel: '3d', commitsSince: 0 });
  assert.match(md, /\*\*Latest tag: v1\.1\.1\*\*/);
  assert.match(md, /HEAD is on the tag/);
  assert.match(md, /3d ago/);
  assert.match(md, /Click for tag actions/);
});

test('formatTagTooltip: pre-release marker present when applicable', () => {
  const pick = pickLatestTag(tags)!;
  const md = formatTagTooltip(pick, { ageLabel: '2mo', commitsSince: 42 });
  assert.match(md, /pre-release/);
  assert.match(md, /42 commits since/);
});

test('formatTagTooltip: tolerates missing date / commitsSince gracefully', () => {
  const odd = [{ name: 'milestone', sha: 'x', subject: '', date: undefined }];
  const pick = pickLatestTag(odd)!;
  const md = formatTagTooltip(pick, { ageLabel: '' });
  assert.match(md, /\*\*Latest tag: milestone\*\*/);
  // No subject and no age section when both are absent
  assert.doesNotMatch(md, /undefined/);
});
