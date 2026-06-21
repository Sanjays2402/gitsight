import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePendingLog,
  summarizePending,
  describePending,
  shortlogText,
  authorBreakdown,
} from '../../src/git/pendingPush';

const FIXTURE = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|alice@x.io|2026-06-20T10:00:00-07:00|feat(api): add /v2 search',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|Bob|bob@x.io|2026-06-20T11:00:00-07:00|fix(parser): handle empty input',
  'cccccccccccccccccccccccccccccccccccccccc|cccc3|Alice|alice@x.io|2026-06-20T12:00:00-07:00|chore(deps): bump axios | minor',
  'dddddddddddddddddddddddddddddddddddddddd|dddd4|Alice|alice@x.io|2026-06-20T13:00:00-07:00|docs(readme): typo',
].join('\n');

test('parsePendingLog: parses canonical lines into PendingCommit', () => {
  const out = parsePendingLog(FIXTURE);
  assert.equal(out.length, 4);
  assert.equal(out[0].sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(out[0].shortSha, 'aaaa1');
  assert.equal(out[0].author, 'Alice');
  assert.equal(out[0].email, 'alice@x.io');
  assert.equal(out[0].dateIso, '2026-06-20T10:00:00-07:00');
  assert.equal(out[0].subject, 'feat(api): add /v2 search');
});

test('parsePendingLog: preserves pipes inside subjects', () => {
  const out = parsePendingLog(FIXTURE);
  assert.equal(out[2].subject, 'chore(deps): bump axios | minor');
});

test('parsePendingLog: empty input → empty array', () => {
  assert.deepEqual(parsePendingLog(''), []);
});

test('parsePendingLog: drops malformed lines silently', () => {
  const raw = [
    'malformed-line-too-few-fields',
    FIXTURE.split('\n')[0],
    '||||||', // technically has 6 splits but all empty — still parses with empty fields
  ].join('\n');
  const out = parsePendingLog(raw);
  // The first line has no separators → dropped. The third line has 6 empty
  // fields → parsed as an empty commit. The canonical fixture line lands.
  assert.equal(out.length, 2);
  assert.equal(out[0].author, 'Alice');
});

test('summarizePending + describePending: zero commits idle string', () => {
  const s = summarizePending([], 0);
  assert.equal(s.count, 0);
  assert.deepEqual(s.authors, []);
  assert.equal(describePending(s), 'Nothing to push');
});

test('summarizePending + describePending: pluralisation across all three buckets', () => {
  const commits = parsePendingLog(FIXTURE);
  const s = summarizePending(commits, 14);
  assert.equal(s.count, 4);
  assert.deepEqual(s.authors, ['Alice', 'Bob']); // alphabetised, deduped
  const out = describePending(s);
  assert.match(out, /4 commits/);
  assert.match(out, /2 authors/);
  assert.match(out, /14 files/);
});

test('describePending: singular forms when count = 1', () => {
  const one = parsePendingLog(FIXTURE).slice(0, 1);
  const s = summarizePending(one, 1);
  const out = describePending(s);
  assert.match(out, /1 commit\b/);
  assert.match(out, /1 author\b/);
  assert.match(out, /1 file\b/);
});

test('shortlogText: oneline rendering with author', () => {
  const commits = parsePendingLog(FIXTURE);
  const text = shortlogText(commits);
  assert.match(text, /aaaa1\s+feat\(api\): add \/v2 search\s+\(Alice\)/);
  assert.match(text, /bbbb2\s+fix\(parser\): handle empty input\s+\(Bob\)/);
  assert.equal(text.split('\n').length, 4);
});

test('authorBreakdown: count desc, ties alphabetical', () => {
  const commits = parsePendingLog(FIXTURE);
  // Alice has 3, Bob has 1
  assert.equal(authorBreakdown(commits), 'Alice (3), Bob (1)');
});

test('authorBreakdown: alphabetical tie-break', () => {
  const commits = [
    { sha: '', shortSha: '', author: 'Zoe',   email: '', dateIso: '', subject: '' },
    { sha: '', shortSha: '', author: 'Alice', email: '', dateIso: '', subject: '' },
    { sha: '', shortSha: '', author: 'Zoe',   email: '', dateIso: '', subject: '' },
    { sha: '', shortSha: '', author: 'Alice', email: '', dateIso: '', subject: '' },
    { sha: '', shortSha: '', author: 'Mike',  email: '', dateIso: '', subject: '' },
  ];
  // Alice=2, Zoe=2 tie (alphabetical: Alice first), Mike=1 last
  assert.equal(authorBreakdown(commits), 'Alice (2), Zoe (2), Mike (1)');
});
