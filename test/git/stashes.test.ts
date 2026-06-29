import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  stashStatusFromCode,
  isValidStashIndex,
  stashRefForIndex,
  stashBranch,
  parseStashList,
  parseStashNumstat,
  parseStashNameStatus,
  buildStashFiles,
  stashSummary,
  STASH_LIST_FORMAT,
  isStashAction,
  buildStashActionArgs,
  stashActionLabel,
  stashActionRemovesEntry,
  normalizeStashMessage,
  buildStashPushArgs,
  STASH_MESSAGE_MAX,
  normalizeStashQuery,
  stashMatchesQuery,
  filterStashes,
  stashFilterPaletteItems,
  stashSubjectWords,
  stashSubjectFilterPaletteItems,
  stashWordSurvivesQuery,
} from '../../src/shared/stashes';

const F = '\x1f';
const R = '\x1e';

// ── stashStatusFromCode ──────────────────────────────────────────────

test('stashStatusFromCode maps git letters', () => {
  assert.equal(stashStatusFromCode('A'), 'added');
  assert.equal(stashStatusFromCode('M'), 'modified');
  assert.equal(stashStatusFromCode('D'), 'deleted');
  assert.equal(stashStatusFromCode('R100'), 'renamed');
  assert.equal(stashStatusFromCode('C75'), 'copied');
  assert.equal(stashStatusFromCode('?'), 'unknown');
});

// ── index validation + ref construction (security gate) ──────────────

test('isValidStashIndex accepts non-negative integers in range', () => {
  assert.equal(isValidStashIndex(0), true);
  assert.equal(isValidStashIndex(42), true);
  assert.equal(isValidStashIndex(-1), false);
  assert.equal(isValidStashIndex(1.5), false);
  assert.equal(isValidStashIndex(99999), false);
  assert.equal(isValidStashIndex('0'), false);
  assert.equal(isValidStashIndex(NaN), false);
});

test('stashRefForIndex builds stash@{N} and rejects bad indices', () => {
  assert.equal(stashRefForIndex(0), 'stash@{0}');
  assert.equal(stashRefForIndex(7), 'stash@{7}');
  assert.throws(() => stashRefForIndex(-1), /invalid stash index/);
  assert.throws(() => stashRefForIndex(1.2), /invalid stash index/);
});

// ── stashBranch ──────────────────────────────────────────────────────

test('stashBranch parses the branch from WIP/On subjects', () => {
  assert.equal(stashBranch('WIP on main: 1a2b3c subject'), 'main');
  assert.equal(stashBranch('On feature/foo: custom message'), 'feature/foo');
  assert.equal(stashBranch('no recognised prefix'), '');
});

// ── parseStashList ───────────────────────────────────────────────────

test('parseStashList parses entries with index, ref, branch, date', () => {
  const stdout =
    ['stash@{0}', 'WIP on main: abc subject', '2026-06-20T09:00:00Z'].join(F) + R +
    ['stash@{1}', 'On feature: hand-named', '2026-06-19T09:00:00Z'].join(F) + R;
  const list = parseStashList(stdout);
  assert.equal(list.length, 2);
  assert.equal(list[0].index, 0);
  assert.equal(list[0].ref, 'stash@{0}');
  assert.equal(list[0].branch, 'main');
  assert.equal(list[1].index, 1);
  assert.equal(list[1].branch, 'feature');
});

test('parseStashList tolerates empty output', () => {
  assert.deepEqual(parseStashList(''), []);
  assert.deepEqual(parseStashList(R), []);
});

// ── numstat / name-status ────────────────────────────────────────────

test('parseStashNumstat reads counts, binary, and renames', () => {
  const stdout = `5\t2\tsrc/a.ts\0` + `-\t-\tlogo.png\0` + `3\t1\t\0old.ts\0new.ts\0`;
  const rows = parseStashNumstat(stdout);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].insertions, 5);
  assert.equal(rows[1].binary, true);
  assert.equal(rows[2].path, 'new.ts');
  assert.equal(rows[2].oldPath, 'old.ts');
});

test('parseStashNameStatus keys by destination path + handles renames', () => {
  const stdout = `M\0a.ts\0A\0new.ts\0R100\0old.ts\0moved.ts\0`;
  const map = parseStashNameStatus(stdout);
  assert.equal(map.get('a.ts')!.status, 'modified');
  assert.equal(map.get('new.ts')!.status, 'added');
  assert.equal(map.get('moved.ts')!.status, 'renamed');
  assert.equal(map.get('moved.ts')!.oldPath, 'old.ts');
});

// ── buildStashFiles ──────────────────────────────────────────────────

test('buildStashFiles correlates status + churn and sorts by churn desc', () => {
  const numstat = `1\t1\tsmall.ts\0` + `40\t10\tbig.ts\0`;
  const nameStatus = `M\0small.ts\0M\0big.ts\0`;
  const { files, insertions, deletions } = buildStashFiles(numstat, nameStatus);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'big.ts'); // 50 churn sorts first
  assert.equal(insertions, 41);
  assert.equal(deletions, 11);
});

test('buildStashFiles ignores binary churn in totals', () => {
  const { files, insertions } = buildStashFiles(`-\t-\tlogo.png\0` + `2\t0\ttext.txt\0`, `M\0logo.png\0A\0text.txt\0`);
  assert.equal(insertions, 2);
  assert.equal(files.find(f => f.path === 'logo.png')!.binary, true);
});

test('buildStashFiles falls back to numstat when name-status is empty', () => {
  const { files } = buildStashFiles(`3\t0\tonly.ts\0`, '');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'only.ts');
  assert.equal(files[0].status, 'modified');
});

// ── stashSummary ─────────────────────────────────────────────────────

test('stashSummary pluralises + omits zero churn segments', () => {
  assert.equal(stashSummary({ filesChanged: 1, insertions: 5, deletions: 0 }), '1 file \u00b7 +5');
  assert.equal(stashSummary({ filesChanged: 3, insertions: 18, deletions: 4 }), '3 files \u00b7 +18 \u00b7 -4');
  assert.equal(stashSummary({ filesChanged: 0, insertions: 0, deletions: 0 }), '0 files');
});

test('STASH_LIST_FORMAT carries the three fields + record terminator', () => {
  assert.ok(STASH_LIST_FORMAT.includes('%gd'));
  assert.ok(STASH_LIST_FORMAT.includes('%gs'));
  assert.ok(STASH_LIST_FORMAT.endsWith('%x1e'));
});

// ── stash mutations (W25) ────────────────────────────────────────────

test('isStashAction accepts only apply/pop/drop', () => {
  assert.equal(isStashAction('apply'), true);
  assert.equal(isStashAction('pop'), true);
  assert.equal(isStashAction('drop'), true);
  assert.equal(isStashAction('clear'), false);
  assert.equal(isStashAction('push'), false);
  assert.equal(isStashAction(''), false);
  assert.equal(isStashAction(null), false);
});

test('buildStashActionArgs builds a validated stash subcommand', () => {
  assert.deepEqual(buildStashActionArgs('apply', 0), ['stash', 'apply', 'stash@{0}']);
  assert.deepEqual(buildStashActionArgs('pop', 3), ['stash', 'pop', 'stash@{3}']);
  assert.deepEqual(buildStashActionArgs('drop', 12), ['stash', 'drop', 'stash@{12}']);
});

test('buildStashActionArgs rejects a bad action or index (no argv injection)', () => {
  assert.throws(() => buildStashActionArgs('clear', 0), /invalid stash action/);
  assert.throws(() => buildStashActionArgs('--exec=evil', 0), /invalid stash action/);
  assert.throws(() => buildStashActionArgs('apply', -1), /invalid stash index/);
  assert.throws(() => buildStashActionArgs('apply', 1.5), /invalid stash index/);
  assert.throws(() => buildStashActionArgs('apply', 999999), /invalid stash index/);
});

test('stashActionLabel + stashActionRemovesEntry describe the outcome', () => {
  assert.equal(stashActionLabel('apply'), 'applied');
  assert.equal(stashActionLabel('pop'), 'popped');
  assert.equal(stashActionLabel('drop'), 'dropped');
  assert.equal(stashActionRemovesEntry('apply'), false);
  assert.equal(stashActionRemovesEntry('pop'), true);
  assert.equal(stashActionRemovesEntry('drop'), true);
});

// ── Stash create (W42) ───────────────────────────────────────────────

test('normalizeStashMessage trims, strips control chars, and bounds length', () => {
  assert.equal(normalizeStashMessage('  hello  '), 'hello');
  assert.equal(normalizeStashMessage('line1\nline2\ttab'), 'line1 line2 tab');
  assert.equal(normalizeStashMessage(''), '');
  assert.equal(normalizeStashMessage(undefined), '');
  assert.equal(normalizeStashMessage(42), '');
  // NUL is stripped (would otherwise break argv).
  assert.equal(normalizeStashMessage('a\u0000b'), 'a b');
  // Length is bounded.
  const long = 'x'.repeat(STASH_MESSAGE_MAX + 50);
  assert.equal(normalizeStashMessage(long).length, STASH_MESSAGE_MAX);
});

test('buildStashPushArgs builds a bare push by default', () => {
  assert.deepEqual(buildStashPushArgs(), ['stash', 'push']);
  assert.deepEqual(buildStashPushArgs({}), ['stash', 'push']);
});

test('buildStashPushArgs maps options to flags + passes the message via -m', () => {
  assert.deepEqual(buildStashPushArgs({ message: 'wip: refactor' }), [
    'stash',
    'push',
    '-m',
    'wip: refactor',
  ]);
  assert.deepEqual(buildStashPushArgs({ includeUntracked: true }), [
    'stash',
    'push',
    '--include-untracked',
  ]);
  assert.deepEqual(buildStashPushArgs({ keepIndex: true, includeUntracked: true, message: 'm' }), [
    'stash',
    'push',
    '--include-untracked',
    '--keep-index',
    '-m',
    'm',
  ]);
});

test('buildStashPushArgs never lets a flag-like message smuggle an option', () => {
  // The message is always after `-m`, so even a flag-shaped message is a value.
  const args = buildStashPushArgs({ message: '--include-untracked --evil' });
  assert.deepEqual(args, ['stash', 'push', '-m', '--include-untracked --evil']);
  // It sits in the value slot (right after -m), never as its own flag.
  assert.equal(args[args.indexOf('-m') + 1], '--include-untracked --evil');
  // A whitespace-only message is dropped (no empty -m value).
  assert.deepEqual(buildStashPushArgs({ message: '   ' }), ['stash', 'push']);
});

// ── Stash search / filter (W59) ──────────────────────────────────────

const FILTER_STASHES = [
  { subject: 'WIP on main: fix the lane layout', branch: 'main' },
  { subject: 'On feature/web: compare patch assembly', branch: 'feature/web' },
  { subject: 'WIP on main: blame ignore revs', branch: 'main' },
];

test('normalizeStashQuery trims and lowercases', () => {
  assert.equal(normalizeStashQuery('  Lane  '), 'lane');
  assert.equal(normalizeStashQuery(''), '');
  assert.equal(normalizeStashQuery('   '), '');
});

test('stashMatchesQuery matches the subject or the branch', () => {
  // Subject substring (case-insensitive).
  assert.equal(stashMatchesQuery(FILTER_STASHES[0], 'lane'), true);
  assert.equal(stashMatchesQuery(FILTER_STASHES[0], 'LANE'), true);
  // Branch substring.
  assert.equal(stashMatchesQuery(FILTER_STASHES[1], 'feature'), true);
  // No match.
  assert.equal(stashMatchesQuery(FILTER_STASHES[1], 'lane'), false);
  // Empty query matches everything.
  assert.equal(stashMatchesQuery(FILTER_STASHES[1], ''), true);
  assert.equal(stashMatchesQuery(FILTER_STASHES[1], '   '), true);
  // Missing fields don't throw.
  assert.equal(stashMatchesQuery({ subject: '', branch: '' }, 'x'), false);
});

test('filterStashes narrows by query, preserving order + identity', () => {
  const onMain = filterStashes(FILTER_STASHES, 'main');
  assert.equal(onMain.length, 2);
  assert.equal(onMain[0], FILTER_STASHES[0]); // same object, original order
  assert.equal(onMain[1], FILTER_STASHES[2]);
  // Empty query returns a fresh copy of the whole list.
  const all = filterStashes(FILTER_STASHES, '');
  assert.deepEqual(all, FILTER_STASHES);
  assert.notEqual(all, FILTER_STASHES); // new array
  // No matches -> empty.
  assert.deepEqual(filterStashes(FILTER_STASHES, 'zzzzz'), []);
});

// ── stashFilterPaletteItems (W91) ────────────────────────────────────

test('stashFilterPaletteItems groups by branch, busiest first, with counts', () => {
  const items = stashFilterPaletteItems(FILTER_STASHES);
  // Two distinct branches; main has 2 stashes so it leads.
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { term: 'main', label: 'Filter stashes on main', count: 2 });
  assert.deepEqual(items[1], { term: 'feature/web', label: 'Filter stashes on feature/web', count: 1 });
  // The count agrees with what filterStashes(term) actually matches.
  assert.equal(filterStashes(FILTER_STASHES, items[0].term).length, items[0].count);
});

test('stashFilterPaletteItems de-dupes branches case-insensitively, keeping first casing', () => {
  const items = stashFilterPaletteItems([
    { subject: 'a', branch: 'Main' },
    { subject: 'b', branch: 'main' },
    { subject: 'c', branch: 'MAIN' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].term, 'Main'); // first-seen casing
  assert.equal(items[0].count, 3);
});

test('stashFilterPaletteItems skips empty branches and caps the list', () => {
  const noBranch = stashFilterPaletteItems([
    { subject: 'detached stash', branch: '' },
    { subject: 'spaces', branch: '   ' },
  ]);
  assert.deepEqual(noBranch, []);
  const many = Array.from({ length: 30 }, (_, i) => ({ subject: 's', branch: `b${i}` }));
  assert.equal(stashFilterPaletteItems(many, 5).length, 5);
});

// ── stashSubjectWords / subject-word palette (W96) ───────────────────

test('stashSubjectWords strips the WIP/On prefix and stop-words', () => {
  // "WIP on main: fix the lane layout" -> drops prefix + "fix"/"the" stop-words.
  assert.deepEqual(stashSubjectWords('WIP on main: fix the lane layout'), ['lane', 'layout']);
  // "On feature/web: compare patch assembly" -> branch + prefix gone.
  assert.deepEqual(stashSubjectWords('On feature/web: compare patch assembly'), ['compare', 'patch', 'assembly']);
});

test('stashSubjectWords drops short tokens, bare numbers, and de-dupes', () => {
  // "a" / "to" too short or stop-word; "42" is a bare number; "blame" repeats.
  assert.deepEqual(
    stashSubjectWords('WIP on dev: blame to a 42 blame heatmap'),
    ['blame', 'heatmap'],
  );
  // A subject with no prefix still tokenises.
  assert.deepEqual(stashSubjectWords('refactor renderer'), ['refactor', 'renderer']);
  // Empty / boilerplate-only -> nothing.
  assert.deepEqual(stashSubjectWords('WIP on main:'), []);
});

test('stashSubjectFilterPaletteItems surfaces words shared by 2+ stashes', () => {
  const stashes = [
    { subject: 'WIP on main: blame ignore revs', branch: 'main' },
    { subject: 'WIP on main: blame heatmap legend', branch: 'main' },
    { subject: 'On feature/web: compare patch assembly', branch: 'feature/web' },
  ];
  const items = stashSubjectFilterPaletteItems(stashes);
  // "blame" appears in two subjects -> surfaced; one-off words are dropped.
  assert.ok(items.length >= 1);
  assert.equal(items[0].term, 'blame');
  assert.equal(items[0].label, 'Filter stashes: blame');
  assert.equal(items[0].count, 2);
  // The count agrees with what filterStashes(term) actually matches.
  assert.equal(filterStashes(stashes, items[0].term).length, items[0].count);
  // A one-off word like "assembly" isn't offered (count 1 < minCount 2).
  assert.ok(!items.some(i => i.term === 'assembly'));
});

test('stashSubjectFilterPaletteItems caps the list and respects minCount', () => {
  // 10 distinct words each shared by exactly 2 stashes.
  const stashes: Array<{ subject: string; branch: string }> = [];
  for (let i = 0; i < 10; i++) {
    stashes.push({ subject: `WIP on main: topic${i}word alpha${i}beta`, branch: 'main' });
    stashes.push({ subject: `WIP on dev: topic${i}word gamma${i}delta`, branch: 'dev' });
  }
  const capped = stashSubjectFilterPaletteItems(stashes, 4);
  assert.equal(capped.length, 4);
  // With minCount 3 nothing qualifies (each word hits only 2 stashes).
  assert.deepEqual(stashSubjectFilterPaletteItems(stashes, 8, 3), []);
});

// ── W101: stash word deep-link round-trip agreement ──────────────────

// Mirror of web/src/hashRoute.ts sanitizeStashQuery so the test verifies the
// SAME transform the deep link applies, without importing the web alias.
function sanitizeStashQuery(query: string): string | null {
  // eslint-disable-next-line no-control-regex
  const q = query.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return q ? q.slice(0, 200) : null;
}

test('stashWordSurvivesQuery rejects words altered by the deep-link sanitiser', () => {
  assert.equal(stashWordSurvivesQuery('layout'), true);
  assert.equal(stashWordSurvivesQuery('a'), true);
  assert.equal(stashWordSurvivesQuery('two words'), false); // space would not survive
  assert.equal(stashWordSurvivesQuery('x'.repeat(201)), false); // capped
  assert.equal(stashWordSurvivesQuery(''), false);
});

test('every stashSubjectWords token round-trips sanitizeStashQuery unchanged (W101)', () => {
  const words = stashSubjectWords('WIP on main: lane-layout compare patch assembly');
  for (const w of words) assert.equal(sanitizeStashQuery(w), w);
});

test('palette word count matches the deep-linked filtered count (W101)', () => {
  const stashes = [
    { index: 0, subject: 'WIP on main: lane layout', branch: 'main' },
    { index: 1, subject: 'WIP on feat: layout polish', branch: 'feat' },
    { index: 2, subject: 'WIP on dev: unrelated', branch: 'dev' },
  ];
  const items = stashSubjectFilterPaletteItems(stashes, 8, 2);
  const layout = items.find(i => i.term === 'layout');
  assert.ok(layout);
  // The deep-linked view applies sanitize then filterStashes — same count.
  const deepQuery = sanitizeStashQuery(layout.term) ?? '';
  assert.equal(filterStashes(stashes, deepQuery).length, layout.count);
});

// ── W106: stash branch palette deep-link agreement ───────────────────

test('stashFilterPaletteItems keeps slash-bearing branches (round-trip clean)', () => {
  const slashed = [
    { subject: 'a', branch: 'feature/login' },
    { subject: 'b', branch: 'feature/login' },
  ];
  const items = stashFilterPaletteItems(slashed);
  const f = items.find(i => i.term === 'feature/login');
  assert.ok(f);
  // The slash survives the deep-link sanitiser, so the deep-linked count agrees.
  const deepQuery = sanitizeStashQuery(f.term) ?? '';
  assert.equal(filterStashes(slashed, deepQuery).length, f.count);
});

test('stashFilterPaletteItems drops a branch that would not survive the deep link (W106)', () => {
  const items = stashFilterPaletteItems([
    { subject: 'a', branch: 'bad branch' }, // space wouldn't round-trip
    { subject: 'b', branch: 'main' },
  ]);
  assert.deepEqual(items.map(i => i.term), ['main']); // space-bearing branch dropped
});

// ── W111: stash subject-word three-tier audit ────────────────────────

test('every surfaced subject word survives the deep-link sanitiser + count agrees (W111)', () => {
  const stashes = [
    { subject: 'WIP on main: refactor lane layout', branch: 'main' },
    { subject: 'WIP on feat: lane polish layout pass', branch: 'feat' },
    { subject: 'WIP on dev: refactor cache', branch: 'dev' },
  ];
  const items = stashSubjectFilterPaletteItems(stashes, 8, 2);
  assert.ok(items.length >= 1);
  for (const item of items) {
    // Three-tier: word survives sanitize, AND palette count == deep-linked count.
    assert.equal(stashWordSurvivesQuery(item.term), true);
    const deepQuery = sanitizeStashQuery(item.term) ?? '';
    assert.equal(filterStashes(stashes, deepQuery).length, item.count);
  }
});

test('stashSubjectFilterPaletteItems caps defensively + never surfaces a control-bearing token (W111)', () => {
  // A control char in a subject body: tokeniser splits on it, so no token ever
  // carries it; the assembly-time re-gate is the lock if the grammar changed.
  const items = stashSubjectFilterPaletteItems(
    [
      { subject: 'WIP on main: deploy\u0007pipeline deploy now', branch: 'main' },
      { subject: 'WIP on dev: deploy retry now', branch: 'dev' },
    ],
    8,
    2,
  );
  assert.ok(items.every(i => stashWordSurvivesQuery(i.term)));
  assert.ok(!items.some(i => /[\u0000-\u001f]/.test(i.term)));
  // Cap is honoured even with a 0 limit.
  assert.deepEqual(stashSubjectFilterPaletteItems([{ subject: 'WIP on a: x x', branch: 'a' }], 0), []);
});
