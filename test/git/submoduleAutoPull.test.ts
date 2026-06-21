import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitlinkChanges,
  summariseGitlinkChanges,
  suggestUpdateActions,
  cooldownKey,
} from '../../src/git/submoduleAutoPull';

function rawDiff(rows: string[]): string {
  // Builds a synthetic --raw -z stream: each row is "header\0path\0" (or
  // "header\0src\0dst\0" for renames).
  return rows.join('') + '';
}

test('parseGitlinkChanges: detects modified submodule (M)', () => {
  const raw = rawDiff([
    ':160000 160000 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 M\0vendor/lib\0',
  ]);
  const out = parseGitlinkChanges(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'vendor/lib');
  assert.equal(out[0].status, 'modified');
  assert.match(out[0].prevSha, /^aaaa/);
  assert.match(out[0].newSha, /^bbbb/);
});

test('parseGitlinkChanges: detects added submodule (A)', () => {
  const raw = rawDiff([
    ':000000 160000 0000000000000000000000000000000000000000 cccc3333cccc3333cccc3333cccc3333cccc3333 A\0libs/new\0',
  ]);
  const out = parseGitlinkChanges(raw);
  assert.equal(out[0].status, 'added');
  assert.equal(out[0].prevSha, '');
  assert.match(out[0].newSha, /^cccc/);
});

test('parseGitlinkChanges: detects removed submodule (D)', () => {
  const raw = rawDiff([
    ':160000 000000 dddd4444dddd4444dddd4444dddd4444dddd4444 0000000000000000000000000000000000000000 D\0libs/old\0',
  ]);
  const out = parseGitlinkChanges(raw);
  assert.equal(out[0].status, 'removed');
  assert.equal(out[0].newSha, '');
  assert.match(out[0].prevSha, /^dddd/);
});

test('parseGitlinkChanges: ignores plain file changes (mode 100644)', () => {
  const raw = rawDiff([
    ':100644 100644 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 M\0src/foo.ts\0',
    ':160000 160000 cccc3333cccc3333cccc3333cccc3333cccc3333 dddd4444dddd4444dddd4444dddd4444dddd4444 M\0vendor/lib\0',
  ]);
  const out = parseGitlinkChanges(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'vendor/lib');
});

test('parseGitlinkChanges: skips rename src path correctly', () => {
  const raw = rawDiff([
    ':160000 160000 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 R100\0old/path\0new/path\0',
    ':160000 160000 cccc3333cccc3333cccc3333cccc3333cccc3333 dddd4444dddd4444dddd4444dddd4444dddd4444 M\0vendor/lib\0',
  ]);
  const out = parseGitlinkChanges(raw);
  // Renames: the first token after the header is the source, then the dest.
  // We index into `path` as the FIRST token by design — it's enough to
  // identify the entry; rename semantics aren't meaningful for submodules
  // (you'd add+remove). The point is we advance past BOTH tokens so the
  // next row isn't mis-parsed.
  assert.equal(out.length, 2);
  assert.equal(out[1].path, 'vendor/lib'); // would be wrong if we ate one less token
});

test('parseGitlinkChanges: empty input returns []', () => {
  assert.deepEqual(parseGitlinkChanges(''), []);
});

test('parseGitlinkChanges: handles trailing NUL noise', () => {
  const raw = ':160000 160000 aaaa aaaa M\0vendor/lib\0\0\0';
  const out = parseGitlinkChanges(raw);
  assert.equal(out.length, 1);
});

test('parseGitlinkChanges: handles multiple submodule changes in one diff', () => {
  const raw = rawDiff([
    ':160000 160000 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 M\0vendor/a\0',
    ':000000 160000 0000000000000000000000000000000000000000 cccc3333cccc3333cccc3333cccc3333cccc3333 A\0vendor/b\0',
    ':160000 000000 dddd4444dddd4444dddd4444dddd4444dddd4444 0000000000000000000000000000000000000000 D\0vendor/c\0',
  ]);
  const out = parseGitlinkChanges(raw);
  assert.equal(out.length, 3);
  assert.equal(out[0].status, 'modified');
  assert.equal(out[1].status, 'added');
  assert.equal(out[2].status, 'removed');
});

test('summariseGitlinkChanges: pluralisation + first-three names', () => {
  assert.equal(
    summariseGitlinkChanges([
      { path: 'vendor/a', status: 'modified', prevSha: '', newSha: '' },
    ]),
    '1 submodule changed: vendor/a',
  );
  assert.equal(
    summariseGitlinkChanges([
      { path: 'a', status: 'modified', prevSha: '', newSha: '' },
      { path: 'b', status: 'modified', prevSha: '', newSha: '' },
      { path: 'c', status: 'modified', prevSha: '', newSha: '' },
      { path: 'd', status: 'modified', prevSha: '', newSha: '' },
    ]),
    '4 submodules changed: a, b, c, +1 more',
  );
});

test('summariseGitlinkChanges: empty → "No submodule changes"', () => {
  assert.match(summariseGitlinkChanges([]), /No submodule/);
});

test('suggestUpdateActions: added+modified → init+update path-scoped + global', () => {
  const actions = suggestUpdateActions([
    { path: 'vendor/a', status: 'modified', prevSha: '', newSha: '' },
    { path: 'vendor/b', status: 'added', prevSha: '', newSha: '' },
  ]);
  // First action is path-scoped; second is the recurse-all catch-all.
  assert.ok(actions[0].args.includes('--'));
  assert.ok(actions[0].args.includes('vendor/a'));
  assert.ok(actions[0].args.includes('vendor/b'));
  assert.deepEqual(actions[1].args, ['submodule', 'update', '--init', '--recursive']);
});

test('suggestUpdateActions: removed-only → deinit only', () => {
  const actions = suggestUpdateActions([
    { path: 'vendor/old', status: 'removed', prevSha: '', newSha: '' },
  ]);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].args, ['submodule', 'deinit', '-f', '--', 'vendor/old']);
});

test('suggestUpdateActions: mixed adds + removed → update + deinit', () => {
  const actions = suggestUpdateActions([
    { path: 'vendor/new', status: 'added', prevSha: '', newSha: '' },
    { path: 'vendor/old', status: 'removed', prevSha: '', newSha: '' },
  ]);
  // update-then-deinit ordering
  assert.match(actions[0].label, /Init \+ update/);
  assert.match(actions[2].label, /Deinit/);
});

test('suggestUpdateActions: empty → []', () => {
  assert.deepEqual(suggestUpdateActions([]), []);
});

test('cooldownKey: stable across path order', () => {
  const a = cooldownKey('/repo', [
    { path: 'a', status: 'modified', prevSha: '', newSha: '' },
    { path: 'b', status: 'modified', prevSha: '', newSha: '' },
  ]);
  const b = cooldownKey('/repo', [
    { path: 'b', status: 'modified', prevSha: '', newSha: '' },
    { path: 'a', status: 'modified', prevSha: '', newSha: '' },
  ]);
  assert.equal(a, b);
});
