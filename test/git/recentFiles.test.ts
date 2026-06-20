import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanRecentFiles } from '../../src/git/recentFiles';

const SAMPLE = [
  '|||aaaa1111aaaa1111|aaaa111|Alice|2026-06-19T10:00:00Z|fix: a',
  'M\tsrc/a.ts',
  'A\tsrc/b.ts',
  '',
  '|||bbbb2222bbbb2222|bbbb222|Bob|2026-06-18T09:00:00Z|refactor: a',
  'M\tsrc/a.ts',
  'D\tsrc/old.ts',
  '',
  '|||cccc3333cccc3333|cccc333|Cake|2026-06-17T08:00:00Z|chore: rename',
  'R100\tsrc/legacy.ts\tsrc/new.ts',
].join('\n');

test('scanRecentFiles: records first (most recent) commit per file', () => {
  const files = scanRecentFiles(SAMPLE, 3);
  const byPath = Object.fromEntries(files.map(f => [f.path, f]));
  assert.equal(byPath['src/a.ts'].shortSha, 'aaaa111', 'src/a.ts → most recent commit wins');
  assert.equal(byPath['src/a.ts'].commitCount, 2, 'src/a.ts seen in two commits');
  assert.equal(byPath['src/b.ts'].shortSha, 'aaaa111');
  assert.equal(byPath['src/old.ts'].shortSha, 'bbbb222');
  assert.equal(byPath['src/old.ts'].status, 'D');
});

test('scanRecentFiles: rename uses the new path (R cols[2])', () => {
  const files = scanRecentFiles(SAMPLE, 3);
  const paths = files.map(f => f.path);
  assert.ok(paths.includes('src/new.ts'), 'rename target captured');
  assert.ok(!paths.includes('src/legacy.ts'), 'rename source dropped');
});

test('scanRecentFiles: windowSize echoed and ordering matches recency', () => {
  const files = scanRecentFiles(SAMPLE, 3);
  assert.equal(files[0].windowSize, 3);
  assert.deepEqual(
    files.map(f => f.path),
    ['src/a.ts', 'src/b.ts', 'src/old.ts', 'src/new.ts'],
    'recency preserved by insertion order',
  );
});

test('scanRecentFiles: empty output → empty array', () => {
  assert.deepEqual(scanRecentFiles('', 5), []);
});

test('scanRecentFiles: subjects containing pipes are preserved', () => {
  const out = '|||1|1|me|2026-06-19T10:00:00Z|feat: pipe | in subject\nM\tx.ts\n';
  const files = scanRecentFiles(out, 1);
  assert.equal(files[0].subject, 'feat: pipe | in subject');
});

test('scanRecentFiles: name-status lines before any commit header are ignored', () => {
  const out = 'M\torphan.ts\n|||1|1|me|2026-06-19T10:00:00Z|s\nM\treal.ts\n';
  const files = scanRecentFiles(out, 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'real.ts');
});
