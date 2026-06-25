import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  COMMIT_DETAIL_FORMAT,
  statusFromCode,
  parseNumstatZ,
  parseNameStatusZ,
  parseCommitMeta,
  buildCommitDetail,
} from '../../src/shared/commitDetail';
import { LOG_FIELD_SEP } from '../../src/shared/graphSnapshotBuild';

const US = LOG_FIELD_SEP;

// ── format ───────────────────────────────────────────────────────────

test('COMMIT_DETAIL_FORMAT carries 11 US-separated fields ending in body', () => {
  const parts = COMMIT_DETAIL_FORMAT.split('%x1f');
  assert.equal(parts.length, 11);
  assert.equal(parts[0], '%H');
  assert.equal(parts[9], '%s');
  assert.equal(parts[10], '%b');
});

// ── statusFromCode ───────────────────────────────────────────────────

test('statusFromCode maps every git status letter', () => {
  assert.equal(statusFromCode('A'), 'added');
  assert.equal(statusFromCode('M'), 'modified');
  assert.equal(statusFromCode('D'), 'deleted');
  assert.equal(statusFromCode('R100'), 'renamed');
  assert.equal(statusFromCode('C075'), 'copied');
  assert.equal(statusFromCode('T'), 'typechange');
  assert.equal(statusFromCode('U'), 'unmerged');
  assert.equal(statusFromCode('X'), 'unknown');
  assert.equal(statusFromCode(''), 'unknown');
});

// ── parseNumstatZ ────────────────────────────────────────────────────

test('parseNumstatZ reads counts, binary, and rename old/new paths', () => {
  // added.txt 2/0, blob.bin binary, del.txt 0/1, keep.txt 2/1, rename 1/0.
  const stdout =
    '2\t0\tadded.txt\0' +
    '-\t-\tblob.bin\0' +
    '0\t1\tdel.txt\0' +
    '2\t1\tkeep.txt\0' +
    '1\t0\t\0rename-me.txt\0renamed.txt\0';
  const rows = parseNumstatZ(stdout);
  assert.equal(rows.length, 5);

  const added = rows[0];
  assert.deepEqual([added.insertions, added.deletions, added.binary, added.path], [2, 0, false, 'added.txt']);

  const bin = rows[1];
  assert.equal(bin.binary, true);
  assert.equal(bin.insertions, -1);
  assert.equal(bin.deletions, -1);
  assert.equal(bin.path, 'blob.bin');

  const rename = rows[4];
  assert.equal(rename.path, 'renamed.txt');
  assert.equal(rename.oldPath, 'rename-me.txt');
  assert.equal(rename.insertions, 1);
});

test('parseNumstatZ tolerates empty input and stray separators', () => {
  assert.deepEqual(parseNumstatZ(''), []);
  assert.deepEqual(parseNumstatZ('\0\0'), []);
});

// ── parseNameStatusZ ─────────────────────────────────────────────────

test('parseNameStatusZ keys by destination and captures rename source', () => {
  const stdout =
    'A\0added.txt\0' +
    'A\0blob.bin\0' +
    'D\0del.txt\0' +
    'M\0keep.txt\0' +
    'R052\0rename-me.txt\0renamed.txt\0';
  const map = parseNameStatusZ(stdout);
  assert.equal(map.size, 5);
  assert.equal(map.get('added.txt')?.status, 'added');
  assert.equal(map.get('del.txt')?.status, 'deleted');
  assert.equal(map.get('keep.txt')?.status, 'modified');
  const r = map.get('renamed.txt');
  assert.equal(r?.status, 'renamed');
  assert.equal(r?.oldPath, 'rename-me.txt');
});

// ── parseCommitMeta ──────────────────────────────────────────────────

function metaRecord(fields: string[]): string {
  return fields.join(US) + '\n';
}

test('parseCommitMeta splits all fields and preserves a multi-line body', () => {
  const meta = parseCommitMeta(
    metaRecord([
      'e30c54cbaba8afdb1f93ac57f75c1869337 6d00e'.replace(' ', ''),
      'e30c54c',
      'fdf1aeacfe8edcb5266a6c8c2cdfe6b51defa5e8',
      'Cake',
      'cake@local',
      '2026-06-25T05:25:11-07:00',
      'Cake',
      'cake@local',
      '2026-06-25T05:25:11-07:00',
      'feat: mixed change',
      'This is the body paragraph.\nSecond line of body.',
    ]),
  );
  assert.ok(meta);
  assert.equal(meta!.subject, 'feat: mixed change');
  assert.equal(meta!.body, 'This is the body paragraph.\nSecond line of body.');
  assert.deepEqual(meta!.parents, ['fdf1aeacfe8edcb5266a6c8c2cdfe6b51defa5e8']);
  assert.equal(meta!.author, 'Cake');
  assert.equal(meta!.committerEmail, 'cake@local');
});

test('parseCommitMeta returns null when the record is too short or sha-less', () => {
  assert.equal(parseCommitMeta('only\x1ftwo\x1ffields'), null);
  assert.equal(parseCommitMeta(['', '', '', '', '', '', '', '', '', ''].join(US)), null);
});

test('parseCommitMeta handles an empty body (subject-only commit)', () => {
  const meta = parseCommitMeta(
    metaRecord(['sha1', 'sha1', '', 'A', 'a@x', 'd', 'A', 'a@x', 'd', 'subject only', '']),
  );
  assert.ok(meta);
  assert.equal(meta!.body, '');
  assert.equal(meta!.subject, 'subject only');
});

// ── buildCommitDetail (correlation) ──────────────────────────────────

test('buildCommitDetail correlates status + numstat and sums non-binary churn', () => {
  const metaStdout = metaRecord([
    'sha-full',
    'shaful',
    'parent1',
    'Cake',
    'cake@local',
    '2026-06-25T05:25:11-07:00',
    'Cake',
    'cake@local',
    '2026-06-25T05:25:11-07:00',
    'feat: mixed change',
    'body line',
  ]);
  const numstatStdout =
    '2\t0\tadded.txt\0' +
    '-\t-\tblob.bin\0' +
    '0\t1\tdel.txt\0' +
    '2\t1\tkeep.txt\0' +
    '1\t0\t\0rename-me.txt\0renamed.txt\0';
  const nameStatusStdout =
    'A\0added.txt\0' +
    'A\0blob.bin\0' +
    'D\0del.txt\0' +
    'M\0keep.txt\0' +
    'R052\0rename-me.txt\0renamed.txt\0';

  const detail = buildCommitDetail({ metaStdout, numstatStdout, nameStatusStdout, refs: ['HEAD -> main'] });
  assert.ok(detail);
  assert.equal(detail!.filesChanged, 5);
  // Non-binary insertions: 2 (added) + 2 (keep) + 1 (rename) = 5; binary excluded.
  assert.equal(detail!.insertions, 5);
  // Non-binary deletions: 1 (del) + 1 (keep) = 2.
  assert.equal(detail!.deletions, 2);
  assert.deepEqual(detail!.refs, ['HEAD -> main']);

  const blob = detail!.files.find(f => f.path === 'blob.bin')!;
  assert.equal(blob.binary, true);
  assert.equal(blob.status, 'added');

  const renamed = detail!.files.find(f => f.path === 'renamed.txt')!;
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'rename-me.txt');
});

test('buildCommitDetail falls back to numstat when name-status is empty', () => {
  const metaStdout = metaRecord([
    's', 's', '', 'A', 'a@x', 'd', 'A', 'a@x', 'd', 'subj', '',
  ]);
  const detail = buildCommitDetail({
    metaStdout,
    numstatStdout: '3\t1\tfoo.txt\0',
    nameStatusStdout: '',
  });
  assert.ok(detail);
  assert.equal(detail!.filesChanged, 1);
  assert.equal(detail!.files[0].status, 'modified');
  assert.equal(detail!.insertions, 3);
  assert.equal(detail!.deletions, 1);
});

test('buildCommitDetail returns null for unparseable meta', () => {
  assert.equal(
    buildCommitDetail({ metaStdout: 'garbage', numstatStdout: '', nameStatusStdout: '' }),
    null,
  );
});
