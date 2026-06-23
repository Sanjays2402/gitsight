import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProtectionDelta,
  classifyDeltaVerdict,
  selectDeltaRows,
  describeDeltaRow,
  describeDeltaTitle,
  buildDeltaReport,
  pickAllChanges,
  ProtectionRuleDelta,
} from '../../src/git/branchProtectionSuggestDelta';
import { ProtectionDecision, ProtectionRule } from '../../src/git/forcePushGuard';
import { RuleSuggestion } from '../../src/git/branchProtectionSuggest';

function sug(
  id: ProtectionRule['id'],
  label: string,
  strength: RuleSuggestion['strength'] = 'recommended',
  weight = 100,
): RuleSuggestion {
  return {
    id,
    label,
    rationale: `rationale for ${label}`,
    strength,
    weight,
  };
}

function delta(
  id: ProtectionRule['id'],
  change: ProtectionRuleDelta['change'],
  strength: RuleSuggestion['strength'] = 'recommended',
  weight = 100,
): ProtectionRuleDelta {
  return {
    id,
    label: id,
    rationale: `rationale for ${id}`,
    strength,
    change,
    weight,
  };
}

test('computeProtectionDelta: unprotected branch -> all proposed are would-add', () => {
  const current: ProtectionDecision = { kind: 'unprotected' };
  const deltas = computeProtectionDelta({
    current,
    proposed: [sug('required-reviews', 'Require PR review'), sug('force-push', 'Disallow force-push')],
  });
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].change, 'would-add');
  assert.equal(deltas[1].change, 'would-add');
});

test('computeProtectionDelta: enabled rule -> already-on', () => {
  const current: ProtectionDecision = {
    kind: 'protected',
    allowsForcePush: false,
    rules: [{ id: 'required-reviews', enabled: true, label: 'enabled' }],
  };
  const deltas = computeProtectionDelta({
    current,
    proposed: [sug('required-reviews', 'Require PR review'), sug('force-push', 'Disallow force-push')],
  });
  assert.equal(deltas[0].change, 'already-on');
  assert.equal(deltas[1].change, 'would-add');
});

test('computeProtectionDelta: disabled rule -> would-strengthen', () => {
  const current: ProtectionDecision = {
    kind: 'protected',
    allowsForcePush: true,
    rules: [{ id: 'required-signatures', enabled: false, label: 'off' }],
  };
  const deltas = computeProtectionDelta({
    current,
    proposed: [sug('required-signatures', 'Require signed commits')],
  });
  assert.equal(deltas[0].change, 'would-strengthen');
});

test('computeProtectionDelta: empty proposed -> empty', () => {
  const current: ProtectionDecision = { kind: 'unprotected' };
  assert.deepEqual(computeProtectionDelta({ current, proposed: [] }), []);
});

test('computeProtectionDelta: unknown probe state treated as unprotected', () => {
  const current: ProtectionDecision = { kind: 'unknown', reason: 'rate limit' };
  const deltas = computeProtectionDelta({
    current,
    proposed: [sug('required-reviews', 'Require PR review')],
  });
  assert.equal(deltas[0].change, 'would-add');
});

test('computeProtectionDelta: weight preserved from proposal order', () => {
  const current: ProtectionDecision = { kind: 'unprotected' };
  const deltas = computeProtectionDelta({
    current,
    proposed: [
      sug('required-reviews', 'Reviews', 'recommended', 100),
      sug('force-push', 'No force-push', 'recommended', 90),
      sug('enforce-admins', 'Admins', 'aggressive', 30),
    ],
  });
  assert.deepEqual(deltas.map(d => d.weight), [100, 90, 30]);
});

test('classifyDeltaVerdict: empty -> no-delta', () => {
  assert.equal(classifyDeltaVerdict([]), 'no-delta');
});

test('classifyDeltaVerdict: all already-on -> no-delta', () => {
  assert.equal(classifyDeltaVerdict([
    delta('required-reviews', 'already-on'),
    delta('force-push', 'already-on'),
  ]), 'no-delta');
});

test('classifyDeltaVerdict: any change -> has-delta', () => {
  assert.equal(classifyDeltaVerdict([
    delta('required-reviews', 'already-on'),
    delta('force-push', 'would-add'),
  ]), 'has-delta');
});

test('selectDeltaRows: default drops already-on', () => {
  const rows = [
    delta('required-reviews', 'already-on'),
    delta('force-push', 'would-add'),
  ];
  const out = selectDeltaRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'force-push');
});

test('selectDeltaRows: includeAlreadyOn keeps everything', () => {
  const rows = [
    delta('required-reviews', 'already-on'),
    delta('force-push', 'would-add'),
  ];
  assert.equal(selectDeltaRows(rows, { includeAlreadyOn: true }).length, 2);
});

test('describeDeltaRow: would-add formatted correctly', () => {
  const d = describeDeltaRow({
    id: 'required-reviews', label: 'Require review', rationale: 'gate merges',
    strength: 'recommended', change: 'would-add', weight: 100,
  });
  assert.match(d, /would add \(recommended\)/);
  assert.match(d, /gate merges/);
});

test('describeDeltaRow: would-strengthen lead', () => {
  const d = describeDeltaRow({
    id: 'force-push', label: 'No force-push', rationale: 'history stable',
    strength: 'recommended', change: 'would-strengthen', weight: 90,
  });
  assert.match(d, /would enable \(recommended\)/);
});

test('describeDeltaRow: already-on lead', () => {
  const d = describeDeltaRow({
    id: 'force-push', label: 'No force-push', rationale: 'history stable',
    strength: 'recommended', change: 'already-on', weight: 90,
  });
  assert.match(d, /already on \(recommended\)/);
});

test('describeDeltaTitle: no-delta uses "already at the proposed baseline"', () => {
  assert.match(describeDeltaTitle('main', []), /already at the proposed baseline/);
});

test('describeDeltaTitle: has-delta lists kind counts', () => {
  const d = describeDeltaTitle('release/x', [
    delta('required-reviews', 'would-add'),
    delta('force-push', 'would-add'),
    delta('required-signatures', 'would-strengthen'),
  ]);
  assert.match(d, /release\/x - 3 changes/);
  assert.match(d, /2 add/);
  assert.match(d, /1 strengthen/);
});

test('describeDeltaTitle: singular count omits plural s', () => {
  const d = describeDeltaTitle('main', [delta('required-reviews', 'would-add')]);
  assert.match(d, /1 change /);
});

test('buildDeltaReport: no-delta emits short stub', () => {
  const md = buildDeltaReport({ branch: 'main', deltas: [] });
  assert.match(md, /# Branch Protection Delta - `main`/);
  assert.match(md, /No changes/);
});

test('buildDeltaReport: emits sections in order with counts', () => {
  const md = buildDeltaReport({
    branch: 'main',
    deltas: [
      delta('required-reviews', 'would-add', 'recommended', 100),
      delta('required-signatures', 'would-strengthen', 'optional', 50),
      delta('force-push', 'already-on', 'recommended', 90),
    ],
  });
  assert.ok(md.indexOf('## Would add (1)') >= 0);
  assert.ok(md.indexOf('## Would strengthen (1)') >= 0);
  assert.ok(md.indexOf('## Already covered (1)') >= 0);
  // Order: would-add first, then strengthen, then already-on
  assert.ok(md.indexOf('## Would add') < md.indexOf('## Would strengthen'));
  assert.ok(md.indexOf('## Would strengthen') < md.indexOf('## Already covered'));
});

test('buildDeltaReport: includeAlreadyOn=false skips that section', () => {
  const md = buildDeltaReport({
    branch: 'main',
    deltas: [
      delta('required-reviews', 'would-add', 'recommended', 100),
      delta('force-push', 'already-on', 'recommended', 90),
    ],
    includeAlreadyOn: false,
  });
  assert.ok(md.indexOf('## Would add') >= 0);
  assert.equal(md.indexOf('## Already covered'), -1);
});

test('buildDeltaReport: empty sections omitted', () => {
  const md = buildDeltaReport({
    branch: 'main',
    deltas: [delta('required-reviews', 'would-add', 'recommended', 100)],
  });
  assert.equal(md.indexOf('## Would strengthen'), -1);
  assert.equal(md.indexOf('## Already covered'), -1);
});

test('pickAllChanges: returns only changing ids', () => {
  const picked = pickAllChanges([
    delta('required-reviews', 'would-add'),
    delta('required-signatures', 'would-strengthen'),
    delta('force-push', 'already-on'),
  ]);
  assert.deepEqual(picked, ['required-reviews', 'required-signatures']);
});

test('pickAllChanges: all already-on -> empty', () => {
  const picked = pickAllChanges([delta('required-reviews', 'already-on')]);
  assert.deepEqual(picked, []);
});

test('pickAllChanges: empty input -> empty output', () => {
  assert.deepEqual(pickAllChanges([]), []);
});
