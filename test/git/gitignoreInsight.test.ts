import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { attributeIgnoredFiles, countBySource } from '../../src/git/gitignoreInsight';

test('attributeIgnoredFiles: standard verbose output', () => {
  const out = [
    '/repo/.gitignore:3:node_modules/\tnode_modules/foo.js',
    '/repo/.gitignore:3:node_modules/\tnode_modules/bar.js',
    '/repo/sub/.gitignore:1:*.log\tsub/a.log',
  ].join('\n');
  const attributed = attributeIgnoredFiles(out, '/repo');
  assert.equal(attributed.length, 3);
  assert.equal(attributed[0].relPath, 'node_modules/foo.js');
  assert.equal(attributed[0].sourceFile, '/repo/.gitignore');
  assert.equal(attributed[0].lineNumber, 3);
  assert.equal(attributed[0].pattern, 'node_modules/');
  assert.equal(attributed[2].sourceFile, '/repo/sub/.gitignore');
  assert.equal(attributed[2].relPath, 'sub/a.log');
});

test('attributeIgnoredFiles: paths absolute and repo-relative both normalise', () => {
  const out = [
    '/repo/.gitignore:1:*.tmp\t/repo/dist/x.tmp',
    '/repo/.gitignore:1:*.tmp\tdist/y.tmp',
  ].join('\n');
  const attributed = attributeIgnoredFiles(out, '/repo');
  assert.equal(attributed[0].relPath, 'dist/x.tmp');
  assert.equal(attributed[1].relPath, 'dist/y.tmp');
});

test('attributeIgnoredFiles: built-in / command-line rules survive parsing', () => {
  const out = '::\tsome/file.txt';
  const attributed = attributeIgnoredFiles(out, '/repo');
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0].sourceFile, '');
  assert.equal(attributed[0].lineNumber, undefined);
  assert.equal(attributed[0].pattern, undefined);
  assert.equal(attributed[0].relPath, 'some/file.txt');
});

test('attributeIgnoredFiles: empty input → empty array', () => {
  assert.deepEqual(attributeIgnoredFiles('', '/repo'), []);
});

test('attributeIgnoredFiles: lines without a tab are skipped', () => {
  const out = 'malformed line without tab\n/repo/.gitignore:1:*.log\tok.log';
  const attributed = attributeIgnoredFiles(out, '/repo');
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0].relPath, 'ok.log');
});

test('countBySource: groups counts by source file', () => {
  const files = [
    { relPath: 'a', sourceFile: '/repo/.gitignore', lineNumber: 1, pattern: '*' },
    { relPath: 'b', sourceFile: '/repo/.gitignore', lineNumber: 2, pattern: '*' },
    { relPath: 'c', sourceFile: '/repo/sub/.gitignore', lineNumber: 1, pattern: '*' },
    { relPath: 'd', sourceFile: '' },
  ];
  const counts = countBySource(files);
  assert.equal(counts.get('/repo/.gitignore'), 2);
  assert.equal(counts.get('/repo/sub/.gitignore'), 1);
  assert.equal(counts.get('<built-in>'), 1);
});
