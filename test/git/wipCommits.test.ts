import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySubject,
  parseLog,
  findWipCommits,
  summariseWip,
  describeWip,
  pickerLabel,
} from '../../src/git/wipCommits';

test('classifySubject: fixup! captures the target subject', () => {
  const v = classifySubject('fixup! refactor parser');
  assert.deepEqual(v, { kind: 'fixup', autosquashTarget: 'refactor parser' });
});

test('classifySubject: squash! captures the target subject', () => {
  const v = classifySubject('squash!  add tests');
  assert.deepEqual(v, { kind: 'squash', autosquashTarget: 'add tests' });
});

test('classifySubject: amend! captures the target subject', () => {
  const v = classifySubject('amend! tweak readme');
  assert.deepEqual(v, { kind: 'amend', autosquashTarget: 'tweak readme' });
});

test('classifySubject: WIP is case-insensitive and accepts several shapes', () => {
  assert.equal(classifySubject('WIP')?.kind, 'wip');
  assert.equal(classifySubject('WIP: rework auth')?.kind, 'wip');
  assert.equal(classifySubject('wip - testing locally')?.kind, 'wip');
  assert.equal(classifySubject('WIPrefix should not match')?.kind, undefined);
});

test('classifySubject: do-not-merge sentinels', () => {
  assert.equal(classifySubject('DO NOT MERGE')?.kind, 'do-not-merge');
  assert.equal(classifySubject('do not merge — debug print')?.kind, 'do-not-merge');
  assert.equal(classifySubject('dnm: scratch')?.kind, 'do-not-merge');
});

test('classifySubject: tmp/temp/TODO markers', () => {
  assert.equal(classifySubject('tmp: debug log')?.kind, 'tmp');
  assert.equal(classifySubject('TEMP: comment out')?.kind, 'tmp');
  assert.equal(classifySubject('TODO: split this')?.kind, 'tmp');
  assert.equal(classifySubject('todo something')?.kind, 'tmp');
});

test('classifySubject: well-formed conventional commits are NOT WIP', () => {
  assert.equal(classifySubject('feat: add auth'), undefined);
  assert.equal(classifySubject('fix(parser): handle empty input'), undefined);
  assert.equal(classifySubject('chore(release): v1.2.3'), undefined);
});

test('classifySubject: empty/whitespace subject returns undefined', () => {
  assert.equal(classifySubject(''), undefined);
  assert.equal(classifySubject('   '), undefined);
});

test('parseLog: pipe-tolerant subject reconstruction', () => {
  const raw = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|2026-06-20T10:00:00-07:00|feat: add /v2 search',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|Bob|2026-06-20T11:00:00-07:00|fixup! refactor | bits',
  ].join('\n');
  const out = parseLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[1].subject, 'fixup! refactor | bits');
});

test('parseLog: malformed/empty input', () => {
  assert.deepEqual(parseLog(''), []);
  assert.deepEqual(parseLog('not-enough-fields'), []);
});

test('findWipCommits: keeps only WIP-shaped subjects, preserves order', () => {
  const commits = parseLog([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|2026-06-20T10:00:00-07:00|feat: add /v2 search',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|Bob|2026-06-20T11:00:00-07:00|WIP: trying things',
    'cccccccccccccccccccccccccccccccccccccccc|cccc3|Alice|2026-06-20T12:00:00-07:00|fixup! feat: add /v2 search',
    'dddddddddddddddddddddddddddddddddddddddd|dddd4|Alice|2026-06-20T13:00:00-07:00|chore: bump deps',
  ].join('\n'));
  const wip = findWipCommits(commits);
  assert.equal(wip.length, 2);
  assert.equal(wip[0].kind, 'wip');
  assert.equal(wip[1].kind, 'fixup');
  assert.equal(wip[1].autosquashTarget, 'feat: add /v2 search');
});

test('summariseWip: tallies by kind and exposes hasAutosquashable', () => {
  const commits = parseLog([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|A|2026-06-20T10:00:00-07:00|WIP',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|A|2026-06-20T11:00:00-07:00|WIP: testing',
    'cccccccccccccccccccccccccccccccccccccccc|cccc3|A|2026-06-20T12:00:00-07:00|fixup! feat',
    'dddddddddddddddddddddddddddddddddddddddd|dddd4|A|2026-06-20T13:00:00-07:00|tmp: log',
  ].join('\n'));
  const s = summariseWip(findWipCommits(commits));
  assert.equal(s.total, 4);
  assert.equal(s.byKind.wip, 2);
  assert.equal(s.byKind.fixup, 1);
  assert.equal(s.byKind.tmp, 1);
  assert.equal(s.hasAutosquashable, true);
});

test('summariseWip: hasAutosquashable is false when only plain WIP/tmp', () => {
  const commits = parseLog([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|A|2026-06-20T10:00:00-07:00|WIP',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|A|2026-06-20T11:00:00-07:00|tmp: log',
  ].join('\n'));
  const s = summariseWip(findWipCommits(commits));
  assert.equal(s.hasAutosquashable, false);
});

test('describeWip: empty / non-empty', () => {
  assert.equal(describeWip({ total: 0, byKind: { wip: 0, fixup: 0, squash: 0, amend: 0, tmp: 0, 'do-not-merge': 0 }, hasAutosquashable: false }), 'No WIP commits');
  const commits = parseLog([
    'a'.repeat(40) + '|aaaa1|A|2026-06-20T10:00:00-07:00|WIP',
    'b'.repeat(40) + '|bbbb2|A|2026-06-20T11:00:00-07:00|fixup! x',
    'c'.repeat(40) + '|cccc3|A|2026-06-20T12:00:00-07:00|fixup! y',
  ].join('\n'));
  const s = summariseWip(findWipCommits(commits));
  // wip first in KIND_ORDER, then fixup
  assert.equal(describeWip(s), '1 WIP, 2 fixup!');
});

test('pickerLabel: wraps subject with bracketed kind', () => {
  const commits = parseLog([
    'a'.repeat(40) + '|aaaa1|A|2026-06-20T10:00:00-07:00|fixup! refactor parser',
  ].join('\n'));
  const wip = findWipCommits(commits);
  assert.equal(pickerLabel(wip[0]), '[fixup!] fixup! refactor parser');
});
