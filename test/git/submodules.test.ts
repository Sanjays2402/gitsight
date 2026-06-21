import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseSubmoduleStatus,
  summariseSubmodules,
  formatPillLabel,
  pillSeverity,
  formatTooltipMarkdown,
  Submodule,
} from '../../src/git/submodules';

test('parseSubmoduleStatus: empty input', () => {
  assert.deepEqual(parseSubmoduleStatus(''), []);
});

test('parseSubmoduleStatus: single in-sync entry with describe', () => {
  const out = parseSubmoduleStatus(' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa libs/foo (v1.2.3)\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'in-sync');
  assert.equal(out[0].path, 'libs/foo');
  assert.equal(out[0].describe, 'v1.2.3');
});

test('parseSubmoduleStatus: + means out-of-sync, no describe', () => {
  const out = parseSubmoduleStatus('+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa libs/foo\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'out-of-sync');
  assert.equal(out[0].describe, undefined);
});

test('parseSubmoduleStatus: - means uninitialised', () => {
  const out = parseSubmoduleStatus('-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb libs/foo\n');
  assert.equal(out[0].state, 'uninitialised');
});

test('parseSubmoduleStatus: U means conflicted', () => {
  const out = parseSubmoduleStatus('Ucccccccccccccccccccccccccccccccccccccccc libs/foo (heads/main)\n');
  assert.equal(out[0].state, 'conflicted');
  assert.equal(out[0].describe, 'heads/main');
});

test('parseSubmoduleStatus: multi-line with mixed states', () => {
  const raw =
    ' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa libs/foo (v1)\n' +
    '+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb libs/bar (v2-3-gabcd)\n' +
    '-cccccccccccccccccccccccccccccccccccccccc libs/baz\n' +
    'Udddddddddddddddddddddddddddddddddddddddd libs/qux\n';
  const out = parseSubmoduleStatus(raw);
  assert.equal(out.length, 4);
  assert.equal(out[0].state, 'in-sync');
  assert.equal(out[1].state, 'out-of-sync');
  assert.equal(out[2].state, 'uninitialised');
  assert.equal(out[3].state, 'conflicted');
});

test('parseSubmoduleStatus: handles paths with spaces', () => {
  const out = parseSubmoduleStatus(' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa some lib/with spaces (v1.0)\n');
  assert.equal(out[0].path, 'some lib/with spaces');
  assert.equal(out[0].describe, 'v1.0');
});

test('parseSubmoduleStatus: skips malformed lines silently', () => {
  const out = parseSubmoduleStatus('garbage line\n# comment\n');
  assert.equal(out.length, 0);
});

test('summariseSubmodules: clean repo is total>0 + zero issues', () => {
  const subs: Submodule[] = [
    { path: 'a', sha: 'aa', state: 'in-sync' },
    { path: 'b', sha: 'bb', state: 'in-sync' },
  ];
  const s = summariseSubmodules(subs);
  assert.equal(s.total, 2);
  assert.equal(s.inSync, 2);
  assert.equal(s.clean, true);
});

test('summariseSubmodules: any issue marks clean=false', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'out-of-sync' },
    { path: 'b', sha: 'bb', state: 'in-sync' },
  ]);
  assert.equal(s.clean, false);
  assert.equal(s.outOfSync, 1);
});

test('summariseSubmodules: empty repo is clean=false (no submodules at all)', () => {
  const s = summariseSubmodules([]);
  assert.equal(s.total, 0);
  assert.equal(s.clean, false);
});

test('formatPillLabel: clean repo says "in sync"', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'in-sync' },
    { path: 'b', sha: 'bb', state: 'in-sync' },
    { path: 'c', sha: 'cc', state: 'in-sync' },
  ]);
  assert.equal(formatPillLabel(s), '$(repo-forked) 3 \u00b7 in sync');
});

test('formatPillLabel: mixed states list each issue', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'in-sync' },
    { path: 'b', sha: 'bb', state: 'out-of-sync' },
    { path: 'c', sha: 'cc', state: 'uninitialised' },
  ]);
  const label = formatPillLabel(s);
  assert.match(label, /3 /);
  assert.match(label, /1 out/);
  assert.match(label, /1 not init/);
});

test('formatPillLabel: empty submodule list returns ""', () => {
  assert.equal(formatPillLabel(summariseSubmodules([])), '');
});

test('pillSeverity: conflict trumps everything', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'out-of-sync' },
    { path: 'b', sha: 'bb', state: 'conflicted' },
  ]);
  assert.equal(pillSeverity(s), 'error');
});

test('pillSeverity: out-of-sync alone is warning', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'out-of-sync' },
  ]);
  assert.equal(pillSeverity(s), 'warning');
});

test('pillSeverity: uninitialised alone is warning', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'uninitialised' },
  ]);
  assert.equal(pillSeverity(s), 'warning');
});

test('pillSeverity: clean returns none', () => {
  const s = summariseSubmodules([
    { path: 'a', sha: 'aa', state: 'in-sync' },
  ]);
  assert.equal(pillSeverity(s), 'none');
});

test('formatTooltipMarkdown: empty list', () => {
  assert.match(formatTooltipMarkdown([]), /No submodules/);
});

test('formatTooltipMarkdown: lists each row with sha + describe', () => {
  const md = formatTooltipMarkdown([
    { path: 'libs/foo', sha: '1234567abcdef', state: 'in-sync', describe: 'v1.2.3' },
    { path: 'libs/bar', sha: 'abcdef1234567', state: 'out-of-sync' },
    { path: 'libs/baz', sha: '0000000000000', state: 'uninitialised' },
  ]);
  assert.match(md, /\*\*3 submodules\*\*/);
  assert.match(md, /libs\/foo.*1234567.*v1\.2\.3/);
  assert.match(md, /out of sync/);
  assert.match(md, /not initialised/);
});
