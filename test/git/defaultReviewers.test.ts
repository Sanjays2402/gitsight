import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  normaliseOwner,
  buildReviewerSuggestions,
  describeSuggestion,
  describeSuggestionDetail,
  describeSuggestionWithLoad,
  buildGhAddReviewerArgs,
  parseChangedPaths,
  rerankRoundRobin,
  countReviewerLoad,
  ReviewerSuggestion,
} from '../../src/git/defaultReviewers';
import { parseCodeownersBody } from '../../src/git/filesIOwn';

const AUTHOR = { email: 'sanjay@example.com', name: 'Sanjay', handle: 'sanjays2402' };

test('normaliseOwner: user handles', () => {
  assert.deepEqual(normaliseOwner('@alice'), { raw: '@alice', kind: 'user', handle: 'alice' });
  assert.deepEqual(normaliseOwner('alice'), { raw: 'alice', kind: 'user', handle: 'alice' });
});

test('normaliseOwner: team handles', () => {
  assert.deepEqual(normaliseOwner('@myorg/core'), {
    raw: '@myorg/core', kind: 'team', handle: 'myorg/core',
  });
  assert.deepEqual(normaliseOwner('myorg/core'), {
    raw: 'myorg/core', kind: 'team', handle: 'myorg/core',
  });
});

test('normaliseOwner: emails rejected for reviewer use', () => {
  assert.equal(normaliseOwner('bob@example.com').kind, 'email');
});

test('normaliseOwner: empty / garbage rejected', () => {
  assert.equal(normaliseOwner('').kind, 'invalid');
  assert.equal(normaliseOwner('   ').kind, 'invalid');
  assert.equal(normaliseOwner('!!!').kind, 'invalid');
});

test('buildReviewerSuggestions: deduplicates across files, ranks by coverage', () => {
  const rules = parseCodeownersBody([
    '*.ts @alice @bob',
    'src/git/ @bob',
    'src/views/ @carol @myorg/ui',
  ].join('\n'));
  const out = buildReviewerSuggestions({
    rules,
    changedPaths: ['src/git/a.ts', 'src/git/b.ts', 'src/views/c.ts'],
    author: AUTHOR,
  });
  // Bob owns all 3 (matched by both wildcard and dir rule), Alice owns 0
  // (overridden by later rules), Carol+team own the views file.
  const bob = out.find(s => s.handle === 'bob');
  const carol = out.find(s => s.handle === 'carol');
  const team = out.find(s => s.handle === 'myorg/ui');
  assert.ok(bob);
  assert.equal(bob!.ownedPaths.length, 2);
  assert.equal(bob!.kind, 'user');
  assert.ok(carol);
  assert.equal(carol!.ownedPaths.length, 1);
  assert.ok(team);
  assert.equal(team!.kind, 'team');
  // First entry should be the highest-coverage user (bob with 2 files).
  assert.equal(out[0].handle, 'bob');
});

test('buildReviewerSuggestions: drops the author by handle', () => {
  const rules = parseCodeownersBody('*.ts @sanjays2402 @alice');
  const out = buildReviewerSuggestions({
    rules, changedPaths: ['x.ts'], author: AUTHOR,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('buildReviewerSuggestions: case-insensitive author drop', () => {
  const rules = parseCodeownersBody('*.ts @SanjayS2402');
  const out = buildReviewerSuggestions({
    rules, changedPaths: ['x.ts'], author: { ...AUTHOR, handle: 'sanjays2402' },
  });
  assert.equal(out.length, 0);
});

test('buildReviewerSuggestions: respects extraExcluded list', () => {
  const rules = parseCodeownersBody('*.ts @alice @bob');
  const out = buildReviewerSuggestions({
    rules, changedPaths: ['x.ts'], author: AUTHOR, extraExcluded: ['@bob'],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('buildReviewerSuggestions: includeTeams=false strips teams', () => {
  const rules = parseCodeownersBody('*.ts @myorg/ui @alice');
  const teamsOut = buildReviewerSuggestions({
    rules, changedPaths: ['x.ts'], author: AUTHOR, includeTeams: true,
  });
  const noTeamsOut = buildReviewerSuggestions({
    rules, changedPaths: ['x.ts'], author: AUTHOR, includeTeams: false,
  });
  assert.equal(teamsOut.length, 2);
  assert.equal(noTeamsOut.length, 1);
  assert.equal(noTeamsOut[0].handle, 'alice');
});

test('buildReviewerSuggestions: empty changedPaths returns []', () => {
  const rules = parseCodeownersBody('*.ts @alice');
  assert.deepEqual(buildReviewerSuggestions({ rules, changedPaths: [], author: AUTHOR }), []);
});

test('buildReviewerSuggestions: emails in CODEOWNERS are dropped', () => {
  const rules = parseCodeownersBody('*.ts @alice bob@example.com');
  const out = buildReviewerSuggestions({
    rules, changedPaths: ['x.ts'], author: AUTHOR,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('buildReviewerSuggestions: users rank before teams at equal coverage', () => {
  const rules = parseCodeownersBody('*.ts @myorg/team @alice');
  const out = buildReviewerSuggestions({
    rules, changedPaths: ['a.ts'], author: AUTHOR,
  });
  assert.equal(out[0].handle, 'alice');
  assert.equal(out[1].handle, 'myorg/team');
});

test('describeSuggestion: percentage formatting', () => {
  const s = {
    handle: 'alice', displayHandle: '@alice', kind: 'user' as const,
    ownedPaths: ['a', 'b'], coverage: 2 / 4,
  };
  assert.equal(describeSuggestion(s, 4), 'user \u00b7 owns 2/4 (50%)');
});

test('describeSuggestionDetail: truncates after 3 paths', () => {
  const s = {
    handle: 'alice', displayHandle: '@alice', kind: 'user' as const,
    ownedPaths: ['a', 'b', 'c'], coverage: 1,
  };
  assert.equal(describeSuggestionDetail(s), 'a, b, c');
  const big = { ...s, ownedPaths: ['a', 'b', 'c', 'd', 'e'] };
  const detail = describeSuggestionDetail(big);
  assert.match(detail ?? '', /a, b, c .* \+2 more/);
});

test('describeSuggestionDetail: empty paths returns undefined', () => {
  const s = {
    handle: 'alice', displayHandle: '@alice', kind: 'user' as const,
    ownedPaths: [], coverage: 0,
  };
  assert.equal(describeSuggestionDetail(s), undefined);
});

test('buildGhAddReviewerArgs: emits per-handle --add-reviewer pairs', () => {
  const args = buildGhAddReviewerArgs(42, [
    { handle: 'alice', displayHandle: '@alice', kind: 'user', ownedPaths: [], coverage: 0 },
    { handle: 'myorg/ui', displayHandle: '@myorg/ui', kind: 'team', ownedPaths: [], coverage: 0 },
  ]);
  assert.ok(args);
  assert.deepEqual(args!.args, [
    'pr', 'edit', '42',
    '--add-reviewer', 'alice',
    '--add-reviewer', 'myorg/ui',
  ]);
  assert.deepEqual(args!.users, ['alice']);
  assert.deepEqual(args!.teams, ['myorg/ui']);
});

test('buildGhAddReviewerArgs: empty selection returns undefined', () => {
  assert.equal(buildGhAddReviewerArgs(1, []), undefined);
});

test('parseChangedPaths: dedupes, sorts, trims', () => {
  const out = parseChangedPaths('  b.ts\na.ts\nb.ts\n\nc.ts\n');
  assert.deepEqual(out, ['a.ts', 'b.ts', 'c.ts']);
});

test('parseChangedPaths: empty input returns []', () => {
  assert.deepEqual(parseChangedPaths(''), []);
});

// ── F85: rerankRoundRobin ────────────────────────────────────────

function mkSug(handle: string, ownedPaths: string[], kind: 'user' | 'team' = 'user'): ReviewerSuggestion {
  return {
    handle, displayHandle: `@${handle}`, kind, ownedPaths,
    coverage: ownedPaths.length ? ownedPaths.length / Math.max(ownedPaths.length, 1) : 0,
  };
}

test('rerankRoundRobin: within a tier, lower load floats up', () => {
  const sugs = [
    mkSug('alice', ['a', 'b']),     // tier 2, load 5
    mkSug('bob',   ['c', 'd']),     // tier 2, load 0
    mkSug('carol', ['e', 'f']),     // tier 2, load 2
  ];
  const load = new Map([['alice', 5], ['carol', 2]]); // bob defaults to 0
  const out = rerankRoundRobin({ suggestions: sugs, loadByHandle: load });
  assert.deepEqual(out.map(s => s.handle), ['bob', 'carol', 'alice']);
});

test('rerankRoundRobin: never crosses coverage tiers', () => {
  // Higher coverage with high load still beats lower coverage with no load.
  const sugs = [
    mkSug('alice', ['a', 'b', 'c']),   // tier 3, load 100
    mkSug('bob',   ['d']),              // tier 1, load 0
  ];
  const load = new Map([['alice', 100]]);
  const out = rerankRoundRobin({ suggestions: sugs, loadByHandle: load });
  assert.deepEqual(out.map(s => s.handle), ['alice', 'bob']);
});

test('rerankRoundRobin: load tiebreak then user-before-team then alphabetical', () => {
  const sugs = [
    mkSug('zeb',     ['a'], 'user'),
    mkSug('myorg/x', ['b'], 'team'),
    mkSug('alice',   ['c'], 'user'),
  ];
  // All same coverage tier (1), all load 0 → user-before-team, then alpha.
  const out = rerankRoundRobin({ suggestions: sugs, loadByHandle: new Map() });
  assert.deepEqual(out.map(s => s.handle), ['alice', 'zeb', 'myorg/x']);
});

test('rerankRoundRobin: empty suggestions returns []', () => {
  assert.deepEqual(rerankRoundRobin({ suggestions: [], loadByHandle: new Map() }), []);
});

test('rerankRoundRobin: does not mutate input', () => {
  const sugs = [
    mkSug('alice', ['a']),
    mkSug('bob',   ['b']),
  ];
  const snapshot = JSON.stringify(sugs);
  const load = new Map([['alice', 10]]);
  rerankRoundRobin({ suggestions: sugs, loadByHandle: load });
  assert.equal(JSON.stringify(sugs), snapshot);
});

// ── F85: countReviewerLoad ───────────────────────────────────────

test('countReviewerLoad: user logins from reviewRequests', () => {
  const counts = countReviewerLoad([
    { reviewRequests: [{ login: 'alice' }, { login: 'bob' }] },
    { reviewRequests: [{ login: 'alice' }] },
  ]);
  assert.equal(counts.get('alice'), 2);
  assert.equal(counts.get('bob'), 1);
});

test('countReviewerLoad: team handles via org/name shape', () => {
  const counts = countReviewerLoad([
    { reviewRequests: [{ name: 'core', organization: { login: 'myorg' } }] },
    { reviewRequests: [{ name: 'core', organization: 'myorg' }] }, // string-shaped org
  ]);
  assert.equal(counts.get('myorg/core'), 2);
});

test('countReviewerLoad: same handle in reviewRequests AND latestReviews counts as 1 per PR', () => {
  const counts = countReviewerLoad([
    {
      reviewRequests: [{ login: 'alice' }],
      latestReviews: [{ author: { login: 'alice' } }],
    },
  ]);
  assert.equal(counts.get('alice'), 1);
});

test('countReviewerLoad: latestReviews-only counts (already-reviewed PR)', () => {
  const counts = countReviewerLoad([
    { latestReviews: [{ author: { login: 'alice' } }, { author: { login: 'bob' } }] },
  ]);
  assert.equal(counts.get('alice'), 1);
  assert.equal(counts.get('bob'), 1);
});

test('countReviewerLoad: tolerates missing fields, malformed entries, non-array input', () => {
  // Non-array → empty.
  assert.equal(countReviewerLoad('not an array' as any).size, 0);
  // Entries with no requests/reviews → empty.
  const counts = countReviewerLoad([
    null as any,
    {} as any,
    { reviewRequests: null as any, latestReviews: null as any } as any,
    { reviewRequests: [{ login: '' }, null, { name: '' }] } as any,
  ]);
  assert.equal(counts.size, 0);
});

test('countReviewerLoad: case-folds handles for lookup', () => {
  const counts = countReviewerLoad([
    { reviewRequests: [{ login: 'AliceCase' }] },
    { reviewRequests: [{ login: 'alicecase' }] },
  ]);
  assert.equal(counts.get('alicecase'), 2);
});

// ── F85: describeSuggestionWithLoad ──────────────────────────────

test('describeSuggestionWithLoad: pluralises requests correctly', () => {
  const s = mkSug('alice', ['a', 'b']);
  const load = new Map([['alice', 1]]);
  assert.match(describeSuggestionWithLoad(s, 4, load), /1 recent request$/);
  const load2 = new Map([['alice', 3]]);
  assert.match(describeSuggestionWithLoad(s, 4, load2), /3 recent requests$/);
});

test('describeSuggestionWithLoad: zero load reads as "0 recent requests"', () => {
  const s = mkSug('alice', ['a']);
  assert.match(describeSuggestionWithLoad(s, 4, new Map()), /0 recent requests$/);
});
