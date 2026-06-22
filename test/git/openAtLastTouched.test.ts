import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  findLastTouchedCommit,
  describeLastTouch,
  isOpenableTextPath,
} from '../../src/git/openAtLastTouched';

const sample = [
  '|||abc123def456abc123def456abc123def456abc1|abc1234|Alice|2026-06-20T12:00:00-07:00|fix bug in foo',
  'M\tsrc/foo.ts',
  'A\tsrc/bar.ts',
  '|||fff999fff999fff999fff999fff999fff999fff9|fff9999|Bob|2026-06-19T08:30:00-07:00|init bar',
  'A\tsrc/bar.ts',
  '|||111aaa111aaa111aaa111aaa111aaa111aaa111a|111aaaa|Eve|2026-06-15T10:00:00-07:00|rename old to new',
  'R100\tsrc/old.ts\tsrc/foo.ts',
  'M\tREADME.md',
  '|||000000000000000000000000000000000000abcd|0000abc|Carol|2026-06-01T09:00:00-07:00|initial drop',
  'A\tsrc/old.ts',
  'A\tREADME.md',
].join('\n');

test('findLastTouchedCommit returns the newest commit that touched the path', () => {
  const r = findLastTouchedCommit(sample, 'src/foo.ts');
  assert.ok(r, 'should find a match');
  assert.equal(r!.shortSha, 'abc1234');
  assert.equal(r!.status, 'M');
  assert.equal(r!.pathInCommit, 'src/foo.ts');
  assert.equal(r!.renamedFrom, undefined);
  assert.equal(r!.author, 'Alice');
  assert.equal(r!.subject, 'fix bug in foo');
});

test('findLastTouchedCommit returns the rename commit for the new path', () => {
  // Re-mine without the abc1234 commit so the rename row is the newest hit.
  const truncated = sample.split('\n').slice(3).join('\n');
  const r = findLastTouchedCommit(truncated, 'src/foo.ts');
  assert.ok(r);
  assert.equal(r!.shortSha, '111aaaa');
  assert.equal(r!.status, 'R');
  assert.equal(r!.pathInCommit, 'src/foo.ts');
  assert.equal(r!.renamedFrom, 'src/old.ts');
});

test('findLastTouchedCommit returns undefined when nothing touched the path', () => {
  const r = findLastTouchedCommit(sample, 'src/nowhere.ts');
  assert.equal(r, undefined);
});

test('findLastTouchedCommit returns undefined for empty input', () => {
  assert.equal(findLastTouchedCommit('', 'src/foo.ts'), undefined);
  assert.equal(findLastTouchedCommit(sample, ''), undefined);
});

test('findLastTouchedCommit ignores stray name-status rows without a commit header', () => {
  const orphan = 'M\tsrc/foo.ts\n|||deadbeefdeadbeefdeadbeefdeadbeefdeadbeef|deadbee|X|2026-01-01T00:00:00Z|x\nM\tsrc/foo.ts';
  const r = findLastTouchedCommit(orphan, 'src/foo.ts');
  assert.ok(r);
  assert.equal(r!.shortSha, 'deadbee');
});

test('findLastTouchedCommit walks past commits that don\'t mention the file', () => {
  const r = findLastTouchedCommit(sample, 'README.md');
  assert.ok(r);
  assert.equal(r!.shortSha, '111aaaa');
});

test('findLastTouchedCommit handles add status', () => {
  const r = findLastTouchedCommit(sample, 'src/bar.ts');
  assert.ok(r);
  assert.equal(r!.shortSha, 'abc1234');
  assert.equal(r!.status, 'A');
});

test('describeLastTouch produces a single-line summary with sha, author, date, subject', () => {
  const info = {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    author: 'Alice',
    date: new Date('2026-06-20T12:00:00Z'),
    subject: 'fix bug',
    status: 'M',
    pathInCommit: 'src/foo.ts',
  };
  const out = describeLastTouch(info, '3d ago');
  assert.equal(out, 'aaaaaaa \u00b7 Alice \u00b7 3d ago \u2014 fix bug');
});

test('describeLastTouch truncates very long subjects', () => {
  const info = {
    sha: 'b'.repeat(40),
    shortSha: 'bbbbbbb',
    author: 'Bob',
    date: new Date(),
    subject: 'a'.repeat(120),
    status: 'M',
    pathInCommit: 'x',
  };
  const out = describeLastTouch(info, '1d ago');
  assert.ok(out.length < 110, `expected truncation, got len ${out.length}`);
  assert.ok(out.endsWith('\u2026'), 'should end with horizontal ellipsis');
});

test('describeLastTouch falls back to "unknown" when author is empty', () => {
  const info = {
    sha: 'c'.repeat(40),
    shortSha: 'ccccccc',
    author: '',
    date: new Date(),
    subject: 's',
    status: 'M',
    pathInCommit: 'p',
  };
  const out = describeLastTouch(info, 'now');
  assert.ok(out.includes(' \u00b7 unknown \u00b7 '));
});

test('isOpenableTextPath rejects empty / directory paths', () => {
  assert.equal(isOpenableTextPath(''), false);
  assert.equal(isOpenableTextPath('src/'), false);
});

test('isOpenableTextPath rejects common binary suffixes', () => {
  for (const p of [
    'media/icon.png', 'docs/diagram.svg', 'fonts/Inter.woff2',
    'release/app.exe', 'lib/libfoo.so', 'archive.tar.gz', 'build/extension.vsix',
  ]) {
    assert.equal(isOpenableTextPath(p), false, `expected reject: ${p}`);
  }
});

test('isOpenableTextPath accepts typical source files', () => {
  for (const p of [
    'src/index.ts', 'README.md', '.github/workflows/ci.yml', 'package.json',
    'tests/foo.test.js', 'src/git/git.ts', 'tsconfig.json',
  ]) {
    assert.equal(isOpenableTextPath(p), true, `expected accept: ${p}`);
  }
});

test('isOpenableTextPath is case-insensitive on extension', () => {
  assert.equal(isOpenableTextPath('Assets/Logo.PNG'), false);
  assert.equal(isOpenableTextPath('Build/App.EXE'), false);
});
