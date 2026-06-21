import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ageDaysFrom,
  classifyStatus,
  deriveSignature,
  buildEntry,
  sortEntries,
  summariseEntries,
  describeSummary,
  describeEntry,
  isValidRerereHash,
  RawEntryFiles,
  RerereCacheEntry,
} from '../../src/git/rerereCache';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-21T00:00:00Z');

function rawEntry(over: Partial<RawEntryFiles>): RawEntryFiles {
  return {
    hash: '0'.repeat(40),
    hasPreimage: true,
    hasPostimage: true,
    hasThisimage: false,
    lastModifiedMs: NOW - 5 * DAY,
    postimageBytes: 256,
    ...over,
  };
}

test('ageDaysFrom: computes floor days', () => {
  assert.equal(ageDaysFrom(NOW - 3 * DAY, NOW), 3);
  assert.equal(ageDaysFrom(NOW - 0.5 * DAY, NOW), 0);
  assert.equal(ageDaysFrom(NOW, NOW), 0);
});

test('ageDaysFrom: future / invalid returns sensible values', () => {
  assert.equal(ageDaysFrom(0, NOW), Infinity);
  assert.equal(ageDaysFrom(NaN, NOW), Infinity);
  assert.equal(ageDaysFrom(NOW + DAY, NOW), 0);
});

test('classifyStatus: in-flight wins over everything', () => {
  assert.equal(classifyStatus(rawEntry({ hasThisimage: true })), 'in-flight');
  // Even if postimage exists, the in-flight signal takes precedence.
  assert.equal(
    classifyStatus(rawEntry({ hasThisimage: true, hasPreimage: true, hasPostimage: true })),
    'in-flight',
  );
});

test('classifyStatus: resolved requires both pre + post images', () => {
  assert.equal(classifyStatus(rawEntry({})), 'resolved');
});

test('classifyStatus: orphaned when preimage present but postimage missing', () => {
  assert.equal(
    classifyStatus(rawEntry({ hasPreimage: true, hasPostimage: false })),
    'orphaned',
  );
});

test('classifyStatus: unknown when neither image present', () => {
  assert.equal(
    classifyStatus(rawEntry({ hasPreimage: false, hasPostimage: false })),
    'unknown',
  );
});

test('deriveSignature: combines head + tail snippets', () => {
  const s = deriveSignature('function foo() {\nreturn 1;', 'console.log("hi");');
  assert.match(s ?? '', /function foo/);
  assert.match(s ?? '', /console\.log/);
});

test('deriveSignature: truncates long output', () => {
  const long = 'x'.repeat(500);
  const s = deriveSignature(long, '');
  assert.ok(s);
  assert.ok(s!.length <= 120);
  assert.ok(s!.endsWith('\u2026'));
});

test('deriveSignature: empty when no inputs', () => {
  assert.equal(deriveSignature('', ''), undefined);
  assert.equal(deriveSignature(undefined, undefined), undefined);
});

test('buildEntry: composes the public shape', () => {
  const raw = rawEntry({
    pathFileContent: 'src/foo.ts\n',
    preimageHead: '<<<<<<<\nold line\n=======',
    preimageTail: '>>>>>>>',
  });
  const e = buildEntry(raw, NOW);
  assert.equal(e.hash, raw.hash);
  assert.equal(e.status, 'resolved');
  assert.equal(e.path, 'src/foo.ts');
  assert.equal(e.ageDays, 5);
  assert.ok(e.preimageSignature);
});

test('buildEntry: pathFileContent absent → undefined path', () => {
  const e = buildEntry(rawEntry({ pathFileContent: '' }), NOW);
  assert.equal(e.path, undefined);
});

test('sortEntries: in-flight first, then orphaned, then resolved oldest-first', () => {
  const e: RerereCacheEntry[] = [
    buildEntry(rawEntry({ hash: 'a'.repeat(40), lastModifiedMs: NOW - 1 * DAY }), NOW),
    buildEntry(rawEntry({ hash: 'b'.repeat(40), lastModifiedMs: NOW - 100 * DAY }), NOW),
    buildEntry(rawEntry({ hash: 'c'.repeat(40), hasPreimage: true, hasPostimage: false }), NOW),
    buildEntry(rawEntry({ hash: 'd'.repeat(40), hasThisimage: true }), NOW),
  ];
  const sorted = sortEntries(e);
  assert.equal(sorted[0].hash, 'd'.repeat(40));      // in-flight
  assert.equal(sorted[1].hash, 'c'.repeat(40));      // orphaned
  assert.equal(sorted[2].hash, 'b'.repeat(40));      // resolved (older)
  assert.equal(sorted[3].hash, 'a'.repeat(40));      // resolved (newer)
});

test('summariseEntries: counts by status and stale threshold', () => {
  const e: RerereCacheEntry[] = [
    buildEntry(rawEntry({ hash: 'a'.repeat(40), lastModifiedMs: NOW - 30 * DAY }), NOW),
    buildEntry(rawEntry({ hash: 'b'.repeat(40), lastModifiedMs: NOW - 200 * DAY }), NOW),
    buildEntry(rawEntry({ hash: 'c'.repeat(40), hasPreimage: true, hasPostimage: false }), NOW),
    buildEntry(rawEntry({ hash: 'd'.repeat(40), hasThisimage: true }), NOW),
  ];
  const s = summariseEntries(e, 90);
  assert.equal(s.total, 4);
  assert.equal(s.resolved, 2);
  assert.equal(s.orphaned, 1);
  assert.equal(s.inFlight, 1);
  assert.equal(s.staleResolved, 1); // only the 200-day-old resolved entry
});

test('describeSummary: empty cache', () => {
  const s = summariseEntries([], 90);
  assert.equal(describeSummary(s, 90), 'rerere cache empty');
});

test('describeSummary: highlights in-flight and stale', () => {
  const e: RerereCacheEntry[] = [
    buildEntry(rawEntry({ hash: 'a'.repeat(40), hasThisimage: true }), NOW),
    buildEntry(rawEntry({ hash: 'b'.repeat(40), lastModifiedMs: NOW - 200 * DAY }), NOW),
  ];
  const s = summariseEntries(e, 90);
  const desc = describeSummary(s, 90);
  assert.match(desc, /2 entries/);
  assert.match(desc, /1 in-flight/);
  assert.match(desc, /1 stale/);
});

test('describeEntry: includes status + age + path when known', () => {
  const e = buildEntry(rawEntry({ pathFileContent: 'src/foo.ts', lastModifiedMs: NOW - 7 * DAY }), NOW);
  assert.equal(describeEntry(e), 'resolved \u00b7 7d \u00b7 src/foo.ts');
});

test('describeEntry: omits path when unknown', () => {
  const e = buildEntry(rawEntry({ pathFileContent: '', lastModifiedMs: NOW - 7 * DAY }), NOW);
  assert.equal(describeEntry(e), 'resolved \u00b7 7d');
});

test('isValidRerereHash: accepts sha1, rejects everything else', () => {
  assert.equal(isValidRerereHash('a'.repeat(40)), true);
  assert.equal(isValidRerereHash('0'.repeat(40)), true);
  assert.equal(isValidRerereHash('A'.repeat(40)), false); // hex must be lowercase
  assert.equal(isValidRerereHash('z'.repeat(40)), false);
  assert.equal(isValidRerereHash('a'.repeat(39)), false);
  assert.equal(isValidRerereHash('a'.repeat(41)), false);
  assert.equal(isValidRerereHash(''), false);
  assert.equal(isValidRerereHash('../etc/passwd'), false);
});
