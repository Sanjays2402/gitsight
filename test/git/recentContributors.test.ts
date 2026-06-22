import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseContributors,
  describeHeadline,
  describeContributor,
  buildTooltipMarkdown,
  badgeForCount,
} from '../../src/git/recentContributors';

test('parseContributors dedupes by email and counts commits per contributor', () => {
  const raw = [
    'Alice\talice@example.com\t2026-06-20T10:00:00Z',
    'Bob\tbob@example.com\t2026-06-19T15:00:00Z',
    'Alice\talice@example.com\t2026-06-18T09:00:00Z',
    'Alice\talice@example.com\t2026-06-15T09:00:00Z',
  ].join('\n');
  const c = parseContributors(raw);
  assert.equal(c.length, 2);
  // Alice first (most recent: 2026-06-20).
  assert.equal(c[0].name, 'Alice');
  assert.equal(c[0].commitCount, 3);
  assert.equal(c[1].name, 'Bob');
  assert.equal(c[1].commitCount, 1);
});

test('parseContributors orders by most-recent-touch descending', () => {
  const raw = [
    'C\tc@x\t2026-01-01T00:00:00Z',
    'A\ta@x\t2026-06-21T00:00:00Z',
    'B\tb@x\t2026-03-15T00:00:00Z',
  ].join('\n');
  const c = parseContributors(raw);
  assert.deepEqual(c.map(x => x.name), ['A', 'B', 'C']);
});

test('parseContributors uses name+@ as key when email is empty', () => {
  const raw = [
    'NoEmail\t\t2026-06-20T10:00:00Z',
    'NoEmail\t\t2026-06-19T10:00:00Z',
  ].join('\n');
  const c = parseContributors(raw);
  assert.equal(c.length, 1);
  assert.equal(c[0].commitCount, 2);
});

test('parseContributors collapses case-different emails into one entry', () => {
  const raw = [
    'Alice\talice@example.com\t2026-06-20T10:00:00Z',
    'Alice\tALICE@example.com\t2026-06-19T15:00:00Z',
  ].join('\n');
  const c = parseContributors(raw);
  assert.equal(c.length, 1);
  assert.equal(c[0].commitCount, 2);
});

test('parseContributors keeps the newest commit\'s name/email after a rename', () => {
  const raw = [
    'Alice Cohen\talice@example.com\t2026-06-21T10:00:00Z',
    'Alice\talice@example.com\t2026-01-01T10:00:00Z',
  ].join('\n');
  const c = parseContributors(raw);
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'Alice Cohen');
});

test('parseContributors skips malformed and empty rows', () => {
  const raw = [
    '',
    'only-name',
    'name\temail-no-date',
    'Bob\tbob@example.com\tnot-a-date',
    '\t\t',
    'Alice\talice@example.com\t2026-06-20T10:00:00Z',
  ].join('\n');
  const c = parseContributors(raw);
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'Alice');
});

test('parseContributors handles empty input', () => {
  assert.deepEqual(parseContributors(''), []);
  assert.deepEqual(parseContributors('\n\n\n'), []);
});

test('describeHeadline formats singular and plural', () => {
  assert.equal(
    describeHeadline([], 50),
    '0 contributors in the last 50 commits',
  );
  assert.equal(
    describeHeadline([{ name: 'Alice', email: 'a@x', lastDate: new Date(), commitCount: 1 }], 50),
    '1 contributor in the last 50 commits',
  );
  assert.equal(
    describeHeadline([
      { name: 'A', email: 'a@x', lastDate: new Date(), commitCount: 1 },
      { name: 'B', email: 'b@x', lastDate: new Date(), commitCount: 1 },
    ], 1),
    '2 contributors in the last 1 commit',
  );
});

test('describeContributor formats commits + relative date', () => {
  const c = { name: 'Alice', email: 'a@x', lastDate: new Date(), commitCount: 3 };
  assert.equal(describeContributor(c, '2d ago'), 'Alice  \u00b7  3 commits  \u00b7  2d ago');
  const single = { name: 'Bob', email: 'b@x', lastDate: new Date(), commitCount: 1 };
  assert.equal(describeContributor(single, '1y ago'), 'Bob  \u00b7  1 commit  \u00b7  1y ago');
});

test('buildTooltipMarkdown renders bullets with author bolded', () => {
  const md = buildTooltipMarkdown(
    [
      { name: 'Alice', email: 'a@x', lastDate: new Date('2026-06-20'), commitCount: 3 },
      { name: 'Bob', email: 'b@x', lastDate: new Date('2026-06-15'), commitCount: 1 },
    ],
    d => d.toISOString().slice(0, 10),
  );
  assert.ok(md.includes('- **Alice**'));
  assert.ok(md.includes('3 commits'));
  assert.ok(md.includes('- **Bob**'));
  assert.ok(md.includes('1 commit'));
});

test('buildTooltipMarkdown returns a placeholder for empty input', () => {
  assert.equal(buildTooltipMarkdown([], () => ''), '_No recent contributors._');
});

test('badgeForCount returns short strings and caps at 9+', () => {
  assert.equal(badgeForCount(0), undefined);
  assert.equal(badgeForCount(-1), undefined);
  assert.equal(badgeForCount(1), '1');
  assert.equal(badgeForCount(9), '9');
  assert.equal(badgeForCount(10), '9+');
  assert.equal(badgeForCount(100), '9+');
});
