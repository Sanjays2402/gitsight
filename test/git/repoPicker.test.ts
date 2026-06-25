import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  stripTrailingSlash,
  repoName,
  isWithinRoot,
  isRepoAllowed,
  buildRepoEntries,
} from '../../src/shared/repoPicker';

// ── stripTrailingSlash ───────────────────────────────────────────────

test('stripTrailingSlash trims but preserves the bare root', () => {
  assert.equal(stripTrailingSlash('/a/b/'), '/a/b');
  assert.equal(stripTrailingSlash('/a/b///'), '/a/b');
  assert.equal(stripTrailingSlash('/a/b'), '/a/b');
  assert.equal(stripTrailingSlash('/'), '/');
});

// ── repoName ─────────────────────────────────────────────────────────

test('repoName returns the basename, robust to trailing slashes', () => {
  assert.equal(repoName('/Volumes/Projects/gitsight'), 'gitsight');
  assert.equal(repoName('/Volumes/Projects/gitsight/'), 'gitsight');
  assert.equal(repoName('gitsight'), 'gitsight');
});

// ── isWithinRoot ─────────────────────────────────────────────────────

test('isWithinRoot accepts the root and descendants', () => {
  assert.equal(isWithinRoot('/Projects', '/Projects'), true);
  assert.equal(isWithinRoot('/Projects', '/Projects/gitsight'), true);
  assert.equal(isWithinRoot('/Projects/', '/Projects/gitsight/'), true);
  assert.equal(isWithinRoot('/', '/anything'), true);
});

test('isWithinRoot rejects the sibling-prefix trap and outsiders', () => {
  // The classic /foo/bar vs /foo/bar-baz prefix bug.
  assert.equal(isWithinRoot('/Projects/gitsight', '/Projects/gitsight-evil'), false);
  assert.equal(isWithinRoot('/Projects', '/Other/gitsight'), false);
  assert.equal(isWithinRoot('', '/x'), false);
  assert.equal(isWithinRoot('/x', ''), false);
});

// ── isRepoAllowed ────────────────────────────────────────────────────

test('isRepoAllowed always permits the default served repo', () => {
  assert.equal(isRepoAllowed('/srv/repo', { repo: '/srv/repo' }), true);
  assert.equal(isRepoAllowed('/srv/repo/', { repo: '/srv/repo' }), true);
});

test('isRepoAllowed permits repos under the root, blocks the rest', () => {
  const opts = { repo: '/srv/repo', root: '/Projects' };
  assert.equal(isRepoAllowed('/Projects/a', opts), true);
  assert.equal(isRepoAllowed('/Projects/deep/nested', opts), true);
  assert.equal(isRepoAllowed('/etc/passwd', opts), false);
  assert.equal(isRepoAllowed('/Projects-evil/a', opts), false);
});

test('isRepoAllowed blocks everything but the default when no root set', () => {
  assert.equal(isRepoAllowed('/anywhere', { repo: '/srv/repo' }), false);
  assert.equal(isRepoAllowed('', { repo: '/srv/repo' }), false);
});

// ── buildRepoEntries ─────────────────────────────────────────────────

test('buildRepoEntries puts current first, then alpha by name', () => {
  const entries = buildRepoEntries(
    ['/p/zebra', '/p/alpha', '/p/current'],
    '/p/current',
  );
  assert.deepEqual(
    entries.map(e => e.name),
    ['current', 'alpha', 'zebra'],
  );
  assert.equal(entries[0].current, true);
  assert.equal(entries[1].current, false);
});

test('buildRepoEntries de-duplicates and normalises slashes', () => {
  const entries = buildRepoEntries(
    ['/p/a/', '/p/a', '/p/b'],
    '/p/a',
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.path).sort(), ['/p/a', '/p/b']);
});

test('buildRepoEntries includes the current repo even if not in the scan list', () => {
  const entries = buildRepoEntries(['/p/other'], '/elsewhere/mine');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, '/elsewhere/mine');
  assert.equal(entries[0].current, true);
});

test('buildRepoEntries breaks name ties by path', () => {
  const entries = buildRepoEntries(['/z/dup', '/a/dup'], '/cur/x');
  const dups = entries.filter(e => e.name === 'dup');
  assert.deepEqual(dups.map(e => e.path), ['/a/dup', '/z/dup']);
});
