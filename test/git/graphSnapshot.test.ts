import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  LOG_FIELD_SEP,
  LOG_RECORD_SEP,
  LOG_PRETTY_FORMAT,
  buildLogArgs,
  parseLogRecord,
  parseLog,
  buildGraphSnapshot,
  resolveHeadLabel,
} from '../../src/shared/graphSnapshotBuild';
import { assignLanes } from '../../src/shared/graphCore';

const US = LOG_FIELD_SEP;
const RS = LOG_RECORD_SEP;

function rec(fields: string[]): string {
  return fields.join(US) + RS;
}

const SAMPLE = [
  rec(['aaaa1111bbbb2222cccc3333dddd4444eeee5555', 'aaaa111', 'bbbb222 cccc333', 'Ada Lovelace', 'ada@x.io', '2026-06-20T09:00:00Z', 'Merge feature into main', 'HEAD -> main, origin/main']),
  rec(['bbbb2222cccc3333dddd4444eeee5555ffff6666', 'bbbb222', 'dddd444', 'Sanjay', 's@x.io', '2026-06-19T12:00:00Z', 'fix: handle empty refs', 'tag: v1.0.0']),
  rec(['dddd4444eeee5555ffff6666aaaa1111bbbb2222', 'dddd444', '', 'Cake', 'cake@x.io', '2026-06-18T08:00:00Z', 'init: first commit', '']),
].join('');

// ── format / args ────────────────────────────────────────────────────

test('LOG_PRETTY_FORMAT uses US field sep and RS record terminator', () => {
  assert.ok(LOG_PRETTY_FORMAT.includes('%x1f'));
  assert.ok(LOG_PRETTY_FORMAT.endsWith('%x1e'));
  assert.ok(LOG_PRETTY_FORMAT.startsWith('%H%x1f%h'));
});

test('buildLogArgs defaults to --all with a max-count, overridable', () => {
  const def = buildLogArgs();
  assert.equal(def[0], 'log');
  assert.ok(def.includes('--all'));
  assert.ok(def.some(a => a === '--max-count=500'));

  const scoped = buildLogArgs({ max: 50, all: false });
  assert.ok(scoped.some(a => a === '--max-count=50'));
  assert.ok(!scoped.includes('--all'));
});

// ── parseLogRecord ────────────────────────────────────────────────────

test('parseLogRecord splits all fields and parents/refs lists', () => {
  const c = parseLogRecord(SAMPLE.split(RS)[0])!;
  assert.equal(c.shortSha, 'aaaa111');
  assert.deepEqual(c.parents, ['bbbb222', 'cccc333']);
  assert.equal(c.author, 'Ada Lovelace');
  assert.equal(c.email, 'ada@x.io');
  assert.equal(c.subject, 'Merge feature into main');
  assert.deepEqual(c.refs, ['HEAD -> main', 'origin/main']);
});

test('parseLogRecord yields empty parents/refs for a root commit', () => {
  const root = parseLogRecord(rec(['sha40', 'sha4', '', 'X', 'x@x', '2026-01-01T00:00:00Z', 'root', '']))!;
  assert.deepEqual(root.parents, []);
  assert.deepEqual(root.refs, []);
});

test('parseLogRecord returns null for blank or truncated records', () => {
  assert.equal(parseLogRecord(''), null);
  assert.equal(parseLogRecord('   '), null);
  // Only 3 fields -> below the 6-field minimum.
  assert.equal(parseLogRecord(['sha', 'sh', 'par'].join(US)), null);
});

test('parseLogRecord preserves a subject containing the field-sep-adjacent punctuation', () => {
  const c = parseLogRecord(rec(['s40', 's4', '', 'A', 'a@a', '2026-01-01T00:00:00Z', 'feat: a, b; c (#42)', '']))!;
  assert.equal(c.subject, 'feat: a, b; c (#42)');
});

// ── parseLog ──────────────────────────────────────────────────────────

test('parseLog returns commits in log order and drops trailing blanks', () => {
  const commits = parseLog(SAMPLE);
  assert.equal(commits.length, 3);
  assert.equal(commits[0].shortSha, 'aaaa111');
  assert.equal(commits[2].subject, 'init: first commit');
});

test('parseLog tolerates a trailing record separator', () => {
  assert.equal(parseLog(SAMPLE + RS).length, 3);
});

// ── buildGraphSnapshot ───────────────────────────────────────────────

test('buildGraphSnapshot assembles metadata + commit count', () => {
  const snap = buildGraphSnapshot({
    repo: 'gitsight',
    head: 'main',
    stdout: SAMPLE,
    now: new Date('2026-06-24T23:00:00Z'),
  });
  assert.equal(snap.repo, 'gitsight');
  assert.equal(snap.head, 'main');
  assert.equal(snap.commitCount, 3);
  assert.equal(snap.commits.length, 3);
  assert.equal(snap.generatedAt, '2026-06-24T23:00:00.000Z');
});

test('buildGraphSnapshot output feeds straight into the shared lane layout', () => {
  // The whole point: the snapshot a server emits is directly renderable
  // by the shared graphCore without any adaptation.
  const snap = buildGraphSnapshot({ repo: 'r', head: 'main', stdout: SAMPLE });
  const rows = assignLanes(snap.commits, ['#a', '#b']);
  assert.equal(rows.length, 3);
  // Merge commit (2 parents) opens a second lane somewhere in the layout.
  const maxLanes = Math.max(...rows.map(r => r.lanes.length));
  assert.ok(maxLanes >= 2);
});

test('buildGraphSnapshot falls back to safe defaults for blank metadata', () => {
  const snap = buildGraphSnapshot({ repo: '', head: '', stdout: '' });
  assert.equal(snap.repo, 'repository');
  assert.equal(snap.head, 'HEAD');
  assert.equal(snap.commitCount, 0);
});

// ── resolveHeadLabel ─────────────────────────────────────────────────

test('resolveHeadLabel prefers the branch, then detached sha, then HEAD', () => {
  assert.equal(resolveHeadLabel('main', 'abc1234'), 'main');
  assert.equal(resolveHeadLabel('', 'abc1234'), 'abc1234 (detached)');
  assert.equal(resolveHeadLabel(undefined, undefined), 'HEAD');
  assert.equal(resolveHeadLabel('  ', '  '), 'HEAD');
});
