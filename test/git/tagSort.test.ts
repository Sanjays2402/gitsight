import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseSemver,
  compareSemver,
  sortTagsForPicker,
  describeTag,
} from '../../src/git/tagSort';

test('parseSemver: accepts v-prefix, bare semver, and pre-release', () => {
  assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseSemver('1.2.3-rc.4'), { major: 1, minor: 2, patch: 3, pre: ['rc', 4] });
  assert.deepEqual(parseSemver('v0.0.1-alpha'), { major: 0, minor: 0, patch: 1, pre: ['alpha'] });
});

test('parseSemver: rejects non-semver names', () => {
  assert.equal(parseSemver('release-2024-01'), undefined);
  assert.equal(parseSemver('v1.2'), undefined);
  assert.equal(parseSemver('latest'), undefined);
});

test('compareSemver: spec ordering for major/minor/patch', () => {
  assert.ok(compareSemver(parseSemver('1.0.0')!, parseSemver('1.0.1')!) < 0);
  assert.ok(compareSemver(parseSemver('1.1.0')!, parseSemver('1.0.99')!) > 0);
  assert.ok(compareSemver(parseSemver('2.0.0')!, parseSemver('1.99.99')!) > 0);
});

test('compareSemver: pre-release < stable (per spec)', () => {
  assert.ok(compareSemver(parseSemver('1.0.0-alpha')!, parseSemver('1.0.0')!) < 0);
  assert.ok(compareSemver(parseSemver('1.0.0-alpha')!, parseSemver('1.0.0-alpha.1')!) < 0);
  assert.ok(compareSemver(parseSemver('1.0.0-alpha.1')!, parseSemver('1.0.0-beta')!) < 0);
  assert.equal(compareSemver(parseSemver('1.0.0')!, parseSemver('1.0.0')!), 0);
});

test('compareSemver: numeric pre-id < alphanumeric pre-id', () => {
  assert.ok(compareSemver(parseSemver('1.0.0-1')!, parseSemver('1.0.0-alpha')!) < 0);
});

test('sortTagsForPicker: semver newest first, non-semver after', () => {
  const tags = [
    { name: 'v1.0.0', sha: 'a', subject: 'a' },
    { name: 'v2.0.0-rc.1', sha: 'b', subject: 'b' },
    { name: 'v2.0.0', sha: 'c', subject: 'c' },
    { name: 'latest', sha: 'd', subject: 'd', date: new Date('2024-01-01') },
    { name: 'v1.5.0', sha: 'e', subject: 'e' },
  ];
  const sorted = sortTagsForPicker(tags as any).map(t => t.name);
  assert.deepEqual(sorted, ['v2.0.0', 'v2.0.0-rc.1', 'v1.5.0', 'v1.0.0', 'latest']);
});

test('sortTagsForPicker: non-semver falls back to date desc', () => {
  const tags = [
    { name: 'older', sha: 'o', subject: '', date: new Date('2024-01-01') },
    { name: 'newer', sha: 'n', subject: '', date: new Date('2024-06-01') },
    { name: 'oldest', sha: 'x', subject: '', date: new Date('2023-01-01') },
  ];
  const sorted = sortTagsForPicker(tags as any).map(t => t.name);
  assert.deepEqual(sorted, ['newer', 'older', 'oldest']);
});

test('describeTag: marks pre-release tags and truncates long subjects', () => {
  const d = describeTag({
    name: 'v1.0.0-rc.2',
    sha: 'abc',
    subject: 'x'.repeat(120),
    date: new Date('2024-03-04T05:06:07Z'),
  } as any, 50);
  assert.equal(d.isPre, true);
  assert.equal(d.date, '2024-03-04');
  assert.equal(d.subject.length, 50);
  assert.match(d.subject, /…$/);
});

test('describeTag: stable tags have isPre=false and short subject untouched', () => {
  const d = describeTag({ name: 'v2.1.0', sha: 'def', subject: 'release notes' } as any);
  assert.equal(d.isPre, false);
  assert.equal(d.subject, 'release notes');
  assert.equal(d.date, '');
});
