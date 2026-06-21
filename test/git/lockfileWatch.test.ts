import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLockfile,
  findChangedLockfiles,
  summariseChanged,
  aggregateInstallCommands,
  LOCKFILE_TABLE,
} from '../../src/git/lockfileWatch';

test('classifyLockfile: known basenames map to their ecosystem', () => {
  assert.equal(classifyLockfile('package-lock.json')?.ecosystem, 'npm');
  assert.equal(classifyLockfile('pnpm-lock.yaml')?.ecosystem, 'pnpm');
  assert.equal(classifyLockfile('yarn.lock')?.ecosystem, 'yarn');
  assert.equal(classifyLockfile('Cargo.lock')?.ecosystem, 'cargo');
  assert.equal(classifyLockfile('go.sum')?.ecosystem, 'go');
  assert.equal(classifyLockfile('packages/api/pnpm-lock.yaml')?.ecosystem, 'pnpm');
});

test('classifyLockfile: capitalisation is enforced', () => {
  // package-LOCK.json is not a thing — don't paper over typos.
  assert.equal(classifyLockfile('Package-Lock.json'), undefined);
  // Cargo.lock IS Capitalised — that's the canonical form.
  assert.ok(classifyLockfile('Cargo.lock'));
});

test('classifyLockfile: unknown → undefined', () => {
  assert.equal(classifyLockfile('README.md'), undefined);
  assert.equal(classifyLockfile('src/index.ts'), undefined);
  assert.equal(classifyLockfile(''), undefined);
});

test('LOCKFILE_TABLE: all entries expose at least one install command', () => {
  for (const row of LOCKFILE_TABLE) {
    assert.ok(row.installCommands.length > 0, `${row.basename} missing commands`);
  }
});

test('findChangedLockfiles: picks lockfiles out of porcelain output', () => {
  const porcelain = [
    ' M src/index.ts',
    'M  package-lock.json',
    '?? new-file.txt',
    'M  packages/api/pnpm-lock.yaml',
    ' M README.md',
  ].join('\n');
  const out = findChangedLockfiles(porcelain);
  assert.equal(out.length, 2);
  assert.equal(out[0].path, 'package-lock.json');
  assert.equal(out[1].path, 'packages/api/pnpm-lock.yaml');
});

test('findChangedLockfiles: skips untracked and ignored entries', () => {
  const porcelain = [
    '?? package-lock.json',  // fresh project — not a pull-driven change
    '!! ignored-thing',
  ].join('\n');
  assert.deepEqual(findChangedLockfiles(porcelain), []);
});

test('findChangedLockfiles: dedupes when index + worktree both dirty', () => {
  const porcelain = 'MM Cargo.lock';
  const out = findChangedLockfiles(porcelain);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'Cargo.lock');
});

test('findChangedLockfiles: rename rows pick the new path', () => {
  const porcelain = 'R  old-pnpm.yaml -> pnpm-lock.yaml';
  const out = findChangedLockfiles(porcelain);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'pnpm-lock.yaml');
});

test('findChangedLockfiles: empty input → empty array', () => {
  assert.deepEqual(findChangedLockfiles(''), []);
});

test('summariseChanged: zero / one / many', () => {
  assert.equal(summariseChanged([]), 'No lockfile changes');
  assert.equal(
    summariseChanged([{ path: 'pnpm-lock.yaml', ecosystem: 'pnpm', installCommands: [] }]),
    '1 lockfile changed: pnpm-lock.yaml',
  );
  assert.equal(
    summariseChanged([
      { path: 'pnpm-lock.yaml', ecosystem: 'pnpm', installCommands: [] },
      { path: 'apps/api/Cargo.lock', ecosystem: 'cargo', installCommands: [] },
    ]),
    '2 lockfiles changed: pnpm-lock.yaml, Cargo.lock',
  );
});

test('aggregateInstallCommands: dedupes by first command, preserves order', () => {
  const out = aggregateInstallCommands([
    { path: 'package-lock.json', ecosystem: 'npm', installCommands: ['npm ci', 'npm install'] },
    { path: 'apps/api/package-lock.json', ecosystem: 'npm', installCommands: ['npm ci', 'npm install'] },
    { path: 'pnpm-lock.yaml', ecosystem: 'pnpm', installCommands: ['pnpm install'] },
  ]);
  assert.deepEqual(out, ['npm ci', 'pnpm install']);
});
