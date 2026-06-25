import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assignLanes,
  buildLaneSvg,
  escapeHtml,
  classifyRef,
  refLabel,
  type GraphInputCommit,
} from '../../src/shared/graphCore';
import {
  THEMES,
  THEME_NAMES,
  paletteFor,
  asThemeName,
  authorColor,
} from '../../src/shared/graphPalette';

const PALETTE = ['#aaa', '#bbb', '#ccc', '#ddd'];

function c(sha: string, parents: string[]): GraphInputCommit {
  return { sha, parents };
}

// ── assignLanes ──────────────────────────────────────────────────────

test('assignLanes lays a linear history on a single lane', () => {
  const commits = [c('c3', ['c2']), c('c2', ['c1']), c('c1', [])];
  const rows = assignLanes(commits, PALETTE);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.lane === 0), 'all rows on lane 0');
  // Same colour carried down the single lane.
  assert.equal(rows[0].color, rows[1].color);
  assert.equal(rows[1].color, rows[2].color);
});

test('assignLanes opens a second lane for a branch then merges it back', () => {
  // c4 is a merge of c3 (mainline) and b1 (feature).
  const commits = [
    c('c4', ['c3', 'b1']),
    c('c3', ['c2']),
    c('b1', ['c2']),
    c('c2', ['c1']),
    c('c1', []),
  ];
  const rows = assignLanes(commits, PALETTE);
  // The merge row reserves a fresh lane for the second parent b1.
  const maxLanes = Math.max(...rows.map(r => r.lanes.length));
  assert.ok(maxLanes >= 2, 'a second lane opened for the feature parent');
  // b1 should land on a lane > 0 (it was the second parent of the merge).
  const b1 = rows.find(r => r.commit.sha === 'b1')!;
  assert.ok(b1.lane >= 1, 'feature commit sits off the mainline');
});

test('assignLanes handles an octopus merge (3 parents)', () => {
  const commits = [
    c('m', ['p1', 'p2', 'p3']),
    c('p1', ['base']),
    c('p2', ['base']),
    c('p3', ['base']),
    c('base', []),
  ];
  const rows = assignLanes(commits, PALETTE);
  const maxLanes = Math.max(...rows.map(r => r.lanes.length));
  assert.ok(maxLanes >= 3, 'octopus reserves three lanes');
});

test('assignLanes cycles the palette as new lanes open', () => {
  const commits = [
    c('m', ['p1', 'p2']),
    c('p1', []),
    c('p2', []),
  ];
  const rows = assignLanes(commits, ['#one', '#two']);
  // First node uses palette[0]; the second parent uses palette[1].
  assert.equal(rows[0].color, '#one');
  const p2 = rows.find(r => r.commit.sha === 'p2')!;
  assert.equal(p2.color, '#two');
});

test('assignLanes falls back to a default colour for an empty palette', () => {
  const rows = assignLanes([c('x', [])], []);
  assert.equal(rows.length, 1);
  assert.ok(/^#/.test(rows[0].color), 'still produced a hex colour');
});

test('assignLanes snapshot does not mutate across rows', () => {
  const commits = [c('c2', ['c1']), c('c1', [])];
  const rows = assignLanes(commits, PALETTE);
  // The first row's lane snapshot is independent of later mutation.
  assert.notEqual(rows[0].lanes, rows[1].lanes);
  assert.equal(rows[0].lanes[0]?.sha, 'c2');
});

// ── buildLaneSvg ─────────────────────────────────────────────────────

test('buildLaneSvg emits one <g> per row with a node circle', () => {
  const rows = assignLanes([c('c2', ['c1']), c('c1', [])], PALETTE);
  const out = buildLaneSvg(rows);
  assert.equal(out.rowCount, 2);
  const groups = out.rowsSvg.match(/<g transform=/g) ?? [];
  assert.equal(groups.length, 2);
  const circles = out.rowsSvg.match(/<circle /g) ?? [];
  assert.equal(circles.length, 2, 'one node per commit');
});

test('buildLaneSvg respects custom row height + column width', () => {
  const rows = assignLanes([c('a', [])], PALETTE);
  const out = buildLaneSvg(rows, { rowHeight: 40, colWidth: 24 });
  assert.equal(out.rowHeight, 40);
  // graphWidth = maxLanes(1) * colW(24) + 10 = 34.
  assert.equal(out.graphWidth, 34);
});

test('buildLaneSvg parameterises the node stroke', () => {
  const rows = assignLanes([c('a', [])], PALETTE);
  const out = buildLaneSvg(rows, { nodeStroke: '#123456' });
  assert.ok(out.rowsSvg.includes('stroke="#123456"'));
});

test('buildLaneSvg draws a curved edge between offset lanes', () => {
  // A merge produces a parent edge that bends between lanes -> a <path>.
  const rows = assignLanes([
    c('m', ['p1', 'p2']),
    c('p1', ['base']),
    c('p2', ['base']),
    c('base', []),
  ], PALETTE);
  const out = buildLaneSvg(rows);
  assert.ok(out.rowsSvg.includes('<path d="M'), 'curved edge present');
});

test('buildLaneSvg clamps absurd geometry to safe minimums', () => {
  const rows = assignLanes([c('a', [])], PALETTE);
  const out = buildLaneSvg(rows, { rowHeight: 1, colWidth: 1 });
  assert.ok(out.rowHeight >= 8);
  assert.ok(out.graphWidth >= 6 + 10);
});

// ── escapeHtml / classifyRef / refLabel ──────────────────────────────

test('escapeHtml neutralises angle brackets, quotes, and ampersands', () => {
  assert.equal(escapeHtml('<b>"a&b"</b>'), '&lt;b&gt;&quot;a&amp;b&quot;&lt;/b&gt;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('classifyRef sorts refs into the four visual buckets', () => {
  assert.equal(classifyRef('tag: v1.0.0'), 'tag');
  assert.equal(classifyRef('HEAD'), 'head');
  assert.equal(classifyRef('HEAD -> main'), 'head');
  assert.equal(classifyRef('origin/main'), 'remote');
  assert.equal(classifyRef('main'), 'branch');
});

test('refLabel strips the tag: prefix only', () => {
  assert.equal(refLabel('tag: v2.1.0'), 'v2.1.0');
  assert.equal(refLabel('main'), 'main');
});

// ── palette ──────────────────────────────────────────────────────────

test('paletteFor returns the named palette and falls back to default', () => {
  assert.deepEqual(paletteFor('dracula'), THEMES.dracula.palette);
  assert.deepEqual(paletteFor('does-not-exist'), THEMES.default.palette);
  assert.deepEqual(paletteFor(undefined), THEMES.default.palette);
});

test('every theme has a non-empty palette and a display name', () => {
  for (const k of THEME_NAMES) {
    assert.ok(THEMES[k].palette.length > 0, `${k} has colours`);
    assert.ok(THEMES[k].name.length > 0, `${k} has a name`);
  }
});

test('asThemeName narrows known names and rejects unknown ones', () => {
  assert.equal(asThemeName('nord'), 'nord');
  assert.equal(asThemeName('bogus'), undefined);
  assert.equal(asThemeName(undefined), undefined);
});

test('authorColor is deterministic and returns an hsl triple', () => {
  const a = authorColor('Ada Lovelace');
  const b = authorColor('Ada Lovelace');
  assert.equal(a, b);
  assert.ok(/^hsl\(\d+(?:\.\d+)?, 65%, 60%\)$/.test(a), `got ${a}`);
});
