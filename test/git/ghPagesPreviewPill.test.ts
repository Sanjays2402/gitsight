import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPagesPill,
  formatPillText,
  buildPillTooltip,
  workflowsAdvertisePages,
  hasPagesSurface,
} from '../../src/git/ghPagesPreviewPill';

describe('F147 - classifyPagesPill verdict states', () => {
  it('hides when disabled', () => {
    const s = classifyPagesPill({
      enabled: false,
      workingTreeChangedFiles: ['docs/a.md'],
      hasPagesSurface: true,
    });
    assert.equal(s.verdict, 'hide-disabled');
    assert.equal(s.totalCount, 0);
  });

  it('hides when repo has no Pages surface', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['docs/a.md'],
      hasPagesSurface: false,
    });
    assert.equal(s.verdict, 'hide-not-applicable');
  });

  it('hides when no docs files changed', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['src/foo.ts', 'README.md'],
      hasPagesSurface: true,
    });
    assert.equal(s.verdict, 'hide-clean');
  });

  it('shows when working-tree docs files changed', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['docs/a.md', 'docs/b.md'],
      hasPagesSurface: true,
    });
    assert.equal(s.verdict, 'show');
    assert.equal(s.totalCount, 2);
    assert.equal(s.workingTreeCount, 2);
    assert.equal(s.unpushedCount, 0);
  });

  it('shows + counts unpushed range separately', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['docs/a.md'],
      unpushedFiles: ['docs/b.md', 'docs/c.md'],
      hasPagesSurface: true,
    });
    assert.equal(s.verdict, 'show');
    assert.equal(s.totalCount, 3);
    assert.equal(s.workingTreeCount, 1);
    assert.equal(s.unpushedCount, 2);
  });

  it('dedups a path that exists in both ranges', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['docs/a.md'],
      unpushedFiles: ['docs/a.md'],
      hasPagesSurface: true,
    });
    assert.equal(s.totalCount, 1, 'overlap should be deduped in totalCount');
    assert.equal(s.workingTreeCount, 1);
    assert.equal(s.unpushedCount, 1);
  });

  it('honours a custom pagesDirs list', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['site/a.md', 'docs/a.md'],
      pagesDirs: ['site'],
      hasPagesSurface: true,
    });
    // docs/ shouldn't count under the custom list.
    assert.equal(s.totalCount, 1);
    assert.equal(s.countsByDir.site, 1);
    assert.equal(s.countsByDir.docs, undefined);
  });

  it('treats whitespace-only paths as empty', () => {
    const s = classifyPagesPill({
      enabled: true,
      workingTreeChangedFiles: ['  ', '', 'docs/a.md'],
      hasPagesSurface: true,
    });
    assert.equal(s.totalCount, 1);
  });
});

describe('F147 - formatPillText', () => {
  it('singular one-change form', () => {
    const text = formatPillText({
      verdict: 'show',
      totalCount: 1,
      workingTreeCount: 1,
      unpushedCount: 0,
      countsByDir: { docs: 1 },
      matchedPaths: ['docs/a.md'],
    });
    assert.equal(text, 'Pages: 1 docs change');
  });

  it('plural form same dir', () => {
    const text = formatPillText({
      verdict: 'show',
      totalCount: 5,
      workingTreeCount: 5,
      unpushedCount: 0,
      countsByDir: { docs: 5 },
      matchedPaths: [],
    });
    assert.equal(text, 'Pages: 5 docs changes');
  });

  it('multi-dir shape lists top dirs', () => {
    const text = formatPillText({
      verdict: 'show',
      totalCount: 12,
      workingTreeCount: 12,
      unpushedCount: 0,
      countsByDir: { docs: 10, _site: 2 },
      matchedPaths: [],
    });
    assert.match(text, /docs\+_site/);
    assert.match(text, /\(12\)/);
  });

  it('multi-dir sorts most-touched first', () => {
    const text = formatPillText({
      verdict: 'show',
      totalCount: 10,
      workingTreeCount: 10,
      unpushedCount: 0,
      countsByDir: { _site: 7, docs: 3 },
      matchedPaths: [],
    });
    // _site should appear before docs in the joined header.
    assert.match(text, /^Pages: _site\+docs/);
  });

  it('returns empty string for non-show verdicts', () => {
    assert.equal(formatPillText({
      verdict: 'hide-clean',
      totalCount: 0,
      workingTreeCount: 0,
      unpushedCount: 0,
      countsByDir: {},
      matchedPaths: [],
    }), '');
  });
});

describe('F147 - buildPillTooltip', () => {
  it('renders heading + path list', () => {
    const md = buildPillTooltip({
      state: {
        verdict: 'show',
        totalCount: 2,
        workingTreeCount: 2,
        unpushedCount: 0,
        countsByDir: { docs: 2 },
        matchedPaths: ['docs/a.md', 'docs/b.md'],
      },
    });
    assert.match(md, /GitHub Pages preview/);
    assert.match(md, /2 doc changes/);
    assert.match(md, /- docs\/a\.md/);
    assert.match(md, /- docs\/b\.md/);
  });

  it('singularises "1 doc change"', () => {
    const md = buildPillTooltip({
      state: {
        verdict: 'show',
        totalCount: 1,
        workingTreeCount: 1,
        unpushedCount: 0,
        countsByDir: { docs: 1 },
        matchedPaths: ['docs/a.md'],
      },
    });
    assert.match(md, /1 doc change\b/);
    assert.doesNotMatch(md, /doc changes/);
  });

  it('breaks out working-tree vs unpushed counts', () => {
    const md = buildPillTooltip({
      state: {
        verdict: 'show',
        totalCount: 5,
        workingTreeCount: 2,
        unpushedCount: 3,
        countsByDir: { docs: 5 },
        matchedPaths: [],
      },
    });
    assert.match(md, /2 working tree/);
    assert.match(md, /3 unpushed/);
  });

  it('caps shown paths and emits "...and N more"', () => {
    const matched = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const md = buildPillTooltip({
      state: {
        verdict: 'show',
        totalCount: 5,
        workingTreeCount: 5,
        unpushedCount: 0,
        countsByDir: { docs: 5 },
        matchedPaths: matched,
      },
      maxPathsShown: 2,
    });
    assert.match(md, /- a\.md/);
    assert.match(md, /- b\.md/);
    assert.doesNotMatch(md, /- c\.md/);
    assert.match(md, /and 3 more/);
  });

  it('emits empty string for non-show verdicts', () => {
    assert.equal(buildPillTooltip({
      state: {
        verdict: 'hide-clean',
        totalCount: 0,
        workingTreeCount: 0,
        unpushedCount: 0,
        countsByDir: {},
        matchedPaths: [],
      },
    }), '');
  });
});

describe('F147 - workflowsAdvertisePages', () => {
  it('detects peaceiris/actions-gh-pages', () => {
    const yaml = `name: deploy
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: peaceiris/actions-gh-pages@v3
`;
    assert.equal(workflowsAdvertisePages([yaml]), true);
  });

  it('detects actions/deploy-pages', () => {
    assert.equal(workflowsAdvertisePages([
      'uses: actions/deploy-pages@v4',
    ]), true);
  });

  it('detects cloudflare/pages-action', () => {
    assert.equal(workflowsAdvertisePages([
      'uses: cloudflare/pages-action@v1',
    ]), true);
  });

  it('returns false for unrelated workflows', () => {
    const yaml = `name: ci
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    assert.equal(workflowsAdvertisePages([yaml]), false);
  });

  it('tolerates empty + nullish entries', () => {
    assert.equal(workflowsAdvertisePages(['', null as any, undefined as any]), false);
  });
});

describe('F147 - hasPagesSurface compose', () => {
  it('true when either signal is true', () => {
    assert.equal(hasPagesSurface({ apiSaysEnabled: true,  workflowSaysEnabled: false }), true);
    assert.equal(hasPagesSurface({ apiSaysEnabled: false, workflowSaysEnabled: true  }), true);
  });

  it('false when both are false', () => {
    assert.equal(hasPagesSurface({ apiSaysEnabled: false, workflowSaysEnabled: false }), false);
  });

  it('true when both are true', () => {
    assert.equal(hasPagesSurface({ apiSaysEnabled: true, workflowSaysEnabled: true }), true);
  });
});
