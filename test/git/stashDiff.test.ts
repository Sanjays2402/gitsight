import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseNameStatusZ,
  mergeNumstatZ,
  detectUntrackedParent,
  summariseStashContents,
  describeChange,
  StashChange,
} from '../../src/git/stashDiff';

test('parseNameStatusZ: single modify entry', () => {
  const out = parseNameStatusZ('M\0src/git/git.ts\0');
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'src/git/git.ts');
  assert.equal(out[0].kind, 'modified');
  assert.equal(out[0].oldPath, undefined);
});

test('parseNameStatusZ: handles A, D, T statuses', () => {
  const out = parseNameStatusZ('A\0new.txt\0D\0gone.txt\0T\0symlink\0');
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'added');
  assert.equal(out[1].kind, 'deleted');
  assert.equal(out[2].kind, 'typechange');
});

test('parseNameStatusZ: rename uses 3 tokens', () => {
  const out = parseNameStatusZ('R100\0old.txt\0new.txt\0');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'renamed');
  assert.equal(out[0].path, 'new.txt');
  assert.equal(out[0].oldPath, 'old.txt');
  assert.equal(out[0].rawStatus, 'R100');
});

test('parseNameStatusZ: copy uses 3 tokens', () => {
  const out = parseNameStatusZ('C75\0src.txt\0dst.txt\0');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'copied');
  assert.equal(out[0].oldPath, 'src.txt');
});

test('parseNameStatusZ: paths with spaces/tabs survive', () => {
  const out = parseNameStatusZ('M\0some path/with space.txt\0M\0tabby\tpath.txt\0');
  assert.equal(out.length, 2);
  assert.equal(out[0].path, 'some path/with space.txt');
  assert.equal(out[1].path, 'tabby\tpath.txt');
});

test('parseNameStatusZ: empty input returns []', () => {
  assert.deepEqual(parseNameStatusZ(''), []);
});

test('parseNameStatusZ: truncated rename does not crash', () => {
  const out = parseNameStatusZ('R100\0old.txt\0'); // missing newpath
  assert.equal(out.length, 0);
});

test('mergeNumstatZ: simple +/- on existing modify entry', () => {
  const changes: StashChange[] = [
    { path: 'src/a.ts', kind: 'modified', rawStatus: 'M' },
    { path: 'src/b.ts', kind: 'added', rawStatus: 'A' },
  ];
  const merged = mergeNumstatZ(changes, '12\t3\tsrc/a.ts\0' + '17\t0\tsrc/b.ts\0');
  assert.equal(merged[0].insertions, 12);
  assert.equal(merged[0].deletions, 3);
  assert.equal(merged[1].insertions, 17);
  assert.equal(merged[1].deletions, 0);
});

test('mergeNumstatZ: rename form keys by new path', () => {
  const changes: StashChange[] = [
    { path: 'new.txt', oldPath: 'old.txt', kind: 'renamed', rawStatus: 'R100' },
  ];
  const merged = mergeNumstatZ(changes, '1\t1\t\0old.txt\0new.txt\0');
  assert.equal(merged[0].insertions, 1);
  assert.equal(merged[0].deletions, 1);
});

test('mergeNumstatZ: binary entries surface as undefined counts', () => {
  const changes: StashChange[] = [
    { path: 'image.png', kind: 'modified', rawStatus: 'M' },
  ];
  const merged = mergeNumstatZ(changes, '-\t-\timage.png\0');
  assert.equal(merged[0].insertions, undefined);
  assert.equal(merged[0].deletions, undefined);
});

test('mergeNumstatZ: empty raw leaves changes unchanged', () => {
  const changes: StashChange[] = [
    { path: 'x.ts', kind: 'modified', rawStatus: 'M' },
  ];
  const merged = mergeNumstatZ(changes, '');
  assert.equal(merged[0].insertions, undefined);
});

test('detectUntrackedParent: 3 SHAs => no untracked', () => {
  assert.equal(detectUntrackedParent('aaa bbb ccc'), false);
});

test('detectUntrackedParent: 4 SHAs => untracked sub-commit', () => {
  assert.equal(detectUntrackedParent('aaa bbb ccc ddd'), true);
});

test('detectUntrackedParent: empty / whitespace handled', () => {
  assert.equal(detectUntrackedParent(''), false);
  assert.equal(detectUntrackedParent('  '), false);
});

test('summariseStashContents: aggregates +/- across files', () => {
  const s = {
    ref: 'stash@{0}',
    changes: [
      { path: 'a.ts', kind: 'modified', rawStatus: 'M', insertions: 12, deletions: 3 } as StashChange,
      { path: 'b.ts', kind: 'added',    rawStatus: 'A', insertions: 5,  deletions: 0 } as StashChange,
    ],
    hadUntracked: false,
  };
  const sum = summariseStashContents(s);
  assert.match(sum, /2 files/);
  assert.match(sum, /\+17 \/ -3/);
});

test('summariseStashContents: untracked tag surfaces', () => {
  const s = {
    ref: 'stash@{1}',
    changes: [{ path: 'x.ts', kind: 'modified', rawStatus: 'M', insertions: 1, deletions: 0 } as StashChange],
    hadUntracked: true,
  };
  assert.match(summariseStashContents(s), /includes untracked/);
});

test('summariseStashContents: binary-only stash reports binary diff', () => {
  const s = {
    ref: 'stash@{2}',
    changes: [{ path: 'x.png', kind: 'modified', rawStatus: 'M' } as StashChange],
    hadUntracked: false,
  };
  assert.match(summariseStashContents(s), /binary diff/);
});

test('describeChange: rename includes "from <oldPath>"', () => {
  const d = describeChange({ path: 'new.txt', oldPath: 'old.txt', kind: 'renamed', rawStatus: 'R100', insertions: 1, deletions: 1 });
  assert.equal(d.glyph, 'R');
  assert.match(d.desc, /from old\.txt/);
});

test('describeChange: binary file', () => {
  const d = describeChange({ path: 'p.png', kind: 'modified', rawStatus: 'M' });
  assert.equal(d.glyph, 'M');
  assert.match(d.desc, /binary/);
});
