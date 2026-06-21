import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildAutosquashPlan,
  renderPlanMarkdown,
  parsePlanLog,
  peelAutosquash,
  RawCommit,
} from '../../src/git/rebasePlan';

function c(sha: string, subject: string): RawCommit {
  return { sha: sha + 'fff', shortSha: sha, subject };
}

test('buildAutosquashPlan: pure picks when no fixup markers', () => {
  const plan = buildAutosquashPlan([
    c('a1', 'add feature x'),
    c('a2', 'tweak feature y'),
  ]);
  assert.equal(plan.trivial, true);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.counts.pick, 2);
  assert.equal(plan.counts.fixup, 0);
  assert.equal(plan.orphans.length, 0);
  // oldest first
  assert.equal(plan.rows[0].sha, 'a2fff');
  assert.equal(plan.rows[1].sha, 'a1fff');
});

test('buildAutosquashPlan: fixup pairs land beneath target', () => {
  // git log newest-first: fixup, then later, then target
  const plan = buildAutosquashPlan([
    c('c3', 'fixup! refactor parser'),
    c('c2', 'add lexer'),
    c('c1', 'refactor parser'),
  ]);
  // oldest first should be: refactor parser (pick), then fixup, then add lexer
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.rows[0].subject, 'refactor parser');
  assert.equal(plan.rows[0].action, 'pick');
  assert.equal(plan.rows[1].subject, 'fixup! refactor parser');
  assert.equal(plan.rows[1].action, 'fixup');
  assert.equal(plan.rows[1].targetSha, 'c1fff');
  assert.equal(plan.rows[2].subject, 'add lexer');
  assert.equal(plan.rows[2].action, 'pick');
});

test('buildAutosquashPlan: squash! works like fixup but keeps action=squash', () => {
  const plan = buildAutosquashPlan([
    c('s2', 'squash! initial commit'),
    c('s1', 'initial commit'),
  ]);
  assert.equal(plan.rows[1].action, 'squash');
  assert.equal(plan.rows[1].targetSha, 's1fff');
  assert.equal(plan.counts.squash, 1);
});

test('buildAutosquashPlan: amend! folds and rewrites message', () => {
  const plan = buildAutosquashPlan([
    c('a2', 'amend! tweak header'),
    c('a1', 'tweak header'),
  ]);
  assert.equal(plan.rows[1].action, 'amend');
  assert.equal(plan.counts.amend, 1);
});

test('buildAutosquashPlan: chained fixups land in order, both fold into source', () => {
  // f3 "fixup! fixup! parser" → peels to "parser" → matches f2's peeled "parser"
  //   (most recent earlier subject match wins)
  // f2 "fixup! parser" → matches f1 "parser"
  // Both end up applied to f1 via the chain.
  const plan = buildAutosquashPlan([
    c('f3', 'fixup! fixup! parser'),
    c('f2', 'fixup! parser'),
    c('f1', 'parser'),
  ]);
  assert.equal(plan.rows[1].subject, 'fixup! parser');
  assert.equal(plan.rows[1].action, 'fixup');
  assert.equal(plan.rows[1].targetSha, 'f1fff');
  assert.equal(plan.rows[2].subject, 'fixup! fixup! parser');
  assert.equal(plan.rows[2].action, 'fixup');
  // f3 chains via f2 — its direct target is f2 but effect is f1.
  assert.equal(plan.rows[2].targetSha, 'f2fff');
  assert.equal(plan.counts.fixup, 2);
});

test('buildAutosquashPlan: orphan fixup demotes to pick', () => {
  const plan = buildAutosquashPlan([
    c('o2', 'fixup! does not exist'),
    c('o1', 'unrelated commit'),
  ]);
  assert.equal(plan.orphans.length, 1);
  // After ordering, orphans are demoted to pick at the end.
  const orphanRow = plan.rows.find(r => r.subject === 'fixup! does not exist')!;
  assert.equal(orphanRow.action, 'pick');
});

test('buildAutosquashPlan: sha-prefix target matching', () => {
  const plan = buildAutosquashPlan([
    c('b2', 'fixup! b1'),
    c('b1', 'real parser fix'),
  ]);
  // 'b1' is too short to be a real sha prefix in our 3-char test fixture,
  // but our matcher accepts 7+. Let's use a 7-char fixture.
  const plan2 = buildAutosquashPlan([
    { sha: 'b2fff', shortSha: 'b2fff', subject: 'fixup! b1ffff' },
    { sha: 'b1ffff' + 'xxxxxxxxx', shortSha: 'b1ffff', subject: 'real parser fix' },
  ]);
  const fixupRow = plan2.rows.find(r => r.subject.startsWith('fixup!'))!;
  assert.equal(fixupRow.action, 'fixup');
  assert.equal(fixupRow.targetSha, 'b1ffff' + 'xxxxxxxxx');
});

test('buildAutosquashPlan: most-recent matching target wins', () => {
  // Two earlier commits both start with "refactor parser"; the fixup
  // should attach to the most recent (which is the closer one).
  const plan = buildAutosquashPlan([
    c('m3', 'fixup! refactor parser'),
    c('m2', 'refactor parser more'),  // <-- more recent of the two
    c('m1', 'refactor parser'),
  ]);
  const fixupRow = plan.rows.find(r => r.subject.startsWith('fixup!'))!;
  // "refactor parser" matches both as a prefix, but we walk backwards
  // from the fixup and the most recent earlier match should be m2.
  assert.equal(fixupRow.targetSha, 'm2fff');
});

test('buildAutosquashPlan: preserves order of multiple fixups on same target', () => {
  const plan = buildAutosquashPlan([
    c('p3', 'fixup! parser'),  // oldest-first reverse: this becomes the third entry
    c('p2', 'fixup! parser'),
    c('p1', 'parser'),
  ]);
  // After reversal (oldest first): p1 (parser), p2 (fixup), p3 (fixup).
  // After autosquash ordering: p1, then fixups in the order they appear post-reversal.
  const order = plan.rows.map(r => r.sha);
  assert.deepEqual(order, ['p1fff', 'p2fff', 'p3fff']);
});

test('peelAutosquash: strips single marker', () => {
  assert.equal(peelAutosquash('fixup! parser'), 'parser');
  assert.equal(peelAutosquash('squash! initial commit'), 'initial commit');
});

test('peelAutosquash: strips chained markers', () => {
  assert.equal(peelAutosquash('fixup! fixup! parser'), 'parser');
  assert.equal(peelAutosquash('fixup! squash! amend! topic'), 'topic');
});

test('peelAutosquash: leaves clean subject alone', () => {
  assert.equal(peelAutosquash('add feature x'), 'add feature x');
  assert.equal(peelAutosquash(''), '');
});

test('parsePlanLog: standard 3-column format', () => {
  const raw = 'abc123|abc1234|add feature\ndef456|def4567|fix bug';
  const out = parsePlanLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].sha, 'abc123');
  assert.equal(out[0].shortSha, 'abc1234');
  assert.equal(out[0].subject, 'add feature');
});

test('parsePlanLog: subject containing pipe characters', () => {
  const raw = 'sha1|sha1234|fix: foo | bar | baz';
  const out = parsePlanLog(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, 'fix: foo | bar | baz');
});

test('parsePlanLog: empty input → empty array', () => {
  assert.deepEqual(parsePlanLog(''), []);
  assert.deepEqual(parsePlanLog('\n\n\n'), []);
});

test('renderPlanMarkdown: includes counts header', () => {
  const plan = buildAutosquashPlan([
    c('a2', 'fixup! add x'),
    c('a1', 'add x'),
  ]);
  const md = renderPlanMarkdown(plan, { upstream: 'origin/main', head: 'HEAD' });
  assert.match(md, /Rebase plan — `origin\/main\.\.HEAD`/);
  assert.match(md, /\*\*2 commits\*\* · 1 pick · 1 fixup · 0 squash · 0 amend/);
  assert.match(md, /pick\s+a1\s+add x/);
  assert.match(md, /fixup\s+a2/);
});

test('renderPlanMarkdown: trivial plan banner', () => {
  const plan = buildAutosquashPlan([c('x1', 'feature')]);
  const md = renderPlanMarkdown(plan, { upstream: 'main', head: 'topic' });
  assert.match(md, /rebase would be a no-op/);
});

test('renderPlanMarkdown: orphan section appears with details', () => {
  const plan = buildAutosquashPlan([
    c('o1', 'fixup! nothing matches'),
    c('z1', 'unrelated'),
  ]);
  const md = renderPlanMarkdown(plan, { upstream: 'main', head: 'topic' });
  assert.match(md, /## Orphan markers/);
  assert.match(md, /`o1`/);
});

test('buildAutosquashPlan: counts only fold-action rows as non-trivial', () => {
  const plan = buildAutosquashPlan([c('a1', 'just a pick')]);
  assert.equal(plan.trivial, true);
  assert.equal(plan.rows.length, 1);
});

test('buildAutosquashPlan: empty input', () => {
  const plan = buildAutosquashPlan([]);
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.trivial, true);
});

test('buildAutosquashPlan: mixed picks + multiple targets', () => {
  const plan = buildAutosquashPlan([
    c('e5', 'fixup! lexer'),       // targets e3
    c('e4', 'add docs'),
    c('e3', 'lexer rewrite'),
    c('e2', 'fixup! parser bug'),  // targets e1
    c('e1', 'parser bug'),
  ]);
  // Oldest first: e1, e2, e3, e4, e5. After autosquash reorder:
  //   e1 (pick, parser bug)
  //   e2 (fixup, → parser bug)
  //   e3 (pick, lexer rewrite)
  //   e5 (fixup, → lexer rewrite)
  //   e4 (pick, add docs)
  const order = plan.rows.map(r => r.sha);
  assert.deepEqual(order, ['e1fff', 'e2fff', 'e3fff', 'e5fff', 'e4fff']);
  assert.equal(plan.counts.fixup, 2);
  assert.equal(plan.counts.pick, 3);
});

test('buildAutosquashPlan: display label uses target subject for fixups', () => {
  const plan = buildAutosquashPlan([
    c('d2', 'fixup! my topic'),
    c('d1', 'my topic'),
  ]);
  const fixupRow = plan.rows.find(r => r.subject.startsWith('fixup!'))!;
  assert.equal(fixupRow.displayLabel, '→ my topic');
});
