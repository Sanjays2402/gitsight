import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildPagesProductionUrl,
  classifyPagesBranch,
  classifyDocsImpact,
  buildDocDeepLink,
  describePagesPreview,
  buildPagesReport,
} from '../../src/git/ghPagesPreview';

// ── buildPagesProductionUrl ────────────────────────────────────────

test('buildPagesProductionUrl: project page', () => {
  assert.equal(buildPagesProductionUrl({ owner: 'Sanjays2402', repo: 'gitsight' }),
    'https://sanjays2402.github.io/gitsight/');
});

test('buildPagesProductionUrl: org page (repo == owner.github.io)', () => {
  assert.equal(buildPagesProductionUrl({ owner: 'NousResearch', repo: 'nousresearch.github.io' }),
    'https://nousresearch.github.io/');
});

test('buildPagesProductionUrl: case-insensitive owner/repo match for org page', () => {
  assert.equal(buildPagesProductionUrl({ owner: 'Foo', repo: 'FOO.GITHUB.IO' }),
    'https://foo.github.io/');
});

test('buildPagesProductionUrl: empty inputs -> empty', () => {
  assert.equal(buildPagesProductionUrl({ owner: '', repo: 'x' }), '');
  assert.equal(buildPagesProductionUrl({ owner: 'x', repo: '' }), '');
});

// ── classifyPagesBranch ────────────────────────────────────────────

test('classifyPagesBranch: probe failed -> unknown', () => {
  assert.equal(
    classifyPagesBranch({ branch: 'main', pagesSource: undefined, probeFailed: true }),
    'unknown',
  );
});

test('classifyPagesBranch: no pagesSource -> pages-disabled', () => {
  assert.equal(
    classifyPagesBranch({ branch: 'main', pagesSource: undefined }),
    'pages-disabled',
  );
});

test('classifyPagesBranch: on source branch with / path -> serving', () => {
  assert.equal(
    classifyPagesBranch({
      branch: 'gh-pages',
      pagesSource: { branch: 'gh-pages', path: '/' },
    }),
    'serving',
  );
});

test('classifyPagesBranch: on source branch with /docs path -> serving-from-docs', () => {
  assert.equal(
    classifyPagesBranch({
      branch: 'main',
      pagesSource: { branch: 'main', path: '/docs' },
    }),
    'serving-from-docs',
  );
});

test('classifyPagesBranch: feature branch with pages configured -> pr-preview', () => {
  assert.equal(
    classifyPagesBranch({
      branch: 'feature/docs',
      pagesSource: { branch: 'main', path: '/docs' },
    }),
    'pr-preview',
  );
});

// ── classifyDocsImpact ─────────────────────────────────────────────

test('classifyDocsImpact: docs/ + _site/ changes detected', () => {
  const r = classifyDocsImpact({
    changedFiles: ['docs/foo.md', '_site/bar.html', 'src/x.ts'],
  });
  assert.equal(r.affectsPages, true);
  assert.equal(r.countsByDir.docs, 1);
  assert.equal(r.countsByDir._site, 1);
  assert.equal(r.matchedPaths.length, 2);
});

test('classifyDocsImpact: src/ only -> not affected', () => {
  const r = classifyDocsImpact({
    changedFiles: ['src/foo.ts', 'src/bar.ts'],
  });
  assert.equal(r.affectsPages, false);
  assert.equal(Object.keys(r.countsByDir).length, 0);
});

test('classifyDocsImpact: custom dirs honoured', () => {
  const r = classifyDocsImpact({
    changedFiles: ['blog/post.md', 'docs/x.md'],
    pagesDirs: ['blog'],
  });
  assert.equal(r.affectsPages, true);
  assert.equal(r.countsByDir.blog, 1);
  assert.equal(r.countsByDir.docs, undefined);
});

test('classifyDocsImpact: cap limits matchedPaths length', () => {
  const files = Array.from({ length: 100 }, (_, i) => `docs/page${i}.md`);
  const r = classifyDocsImpact({ changedFiles: files, cap: 10 });
  assert.equal(r.countsByDir.docs, 100);
  assert.equal(r.matchedPaths.length, 10);
});

test('classifyDocsImpact: leading ./ stripped', () => {
  const r = classifyDocsImpact({
    changedFiles: ['./docs/foo.md', './src/x.ts'],
  });
  assert.equal(r.affectsPages, true);
  assert.equal(r.countsByDir.docs, 1);
});

test('classifyDocsImpact: directory-named file does not false-match', () => {
  // `docsy.md` at root should NOT count as a docs/ change.
  const r = classifyDocsImpact({
    changedFiles: ['docsy.md', 'docs-readme.md'],
  });
  assert.equal(r.affectsPages, false);
});

// ── buildDocDeepLink ───────────────────────────────────────────────

test('buildDocDeepLink: docs/foo.md -> /foo/', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo/',
      path: 'docs/foo.md',
      pagesDir: 'docs',
    }),
    'https://owner.github.io/repo/foo/',
  );
});

test('buildDocDeepLink: docs/index.md -> root', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo/',
      path: 'docs/index.md',
      pagesDir: 'docs',
    }),
    'https://owner.github.io/repo/',
  );
});

test('buildDocDeepLink: nested doc - docs/guides/install.md', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo',
      path: 'docs/guides/install.md',
      pagesDir: 'docs',
    }),
    'https://owner.github.io/repo/guides/install/',
  );
});

test('buildDocDeepLink: _site/about/index.html -> /about/', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo',
      path: '_site/about/index.html',
      pagesDir: '_site',
    }),
    'https://owner.github.io/repo/about/',
  );
});

test('buildDocDeepLink: asset path -> undefined', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo',
      path: 'docs/img/logo.png',
      pagesDir: 'docs',
    }),
    undefined,
  );
});

test('buildDocDeepLink: layout partial -> undefined', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo',
      path: 'docs/_includes/nav.html',
      pagesDir: 'docs',
    }),
    undefined,
  );
});

test('buildDocDeepLink: non-Pages extension -> undefined', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo',
      path: 'docs/page.ts',
      pagesDir: 'docs',
    }),
    undefined,
  );
});

test('buildDocDeepLink: empty production base -> undefined', () => {
  assert.equal(
    buildDocDeepLink({ productionBase: '', path: 'docs/foo.md', pagesDir: 'docs' }),
    undefined,
  );
});

test('buildDocDeepLink: mdx + markdown extension variants honoured', () => {
  assert.equal(
    buildDocDeepLink({
      productionBase: 'https://owner.github.io/repo',
      path: 'docs/foo.mdx',
      pagesDir: 'docs',
    }),
    'https://owner.github.io/repo/foo/',
  );
});

// ── describePagesPreview ───────────────────────────────────────────

test('describePagesPreview: serving + docs counts', () => {
  const docs = classifyDocsImpact({ changedFiles: ['docs/a.md', 'docs/b.md'] });
  const s = describePagesPreview({
    verdict: 'serving-from-docs',
    branch: 'main',
    pagesSource: { branch: 'main', path: '/docs' },
    docsImpact: docs,
  });
  assert.match(s, /serving from `main\/docs`/);
  assert.match(s, /2 docs changes/);
});

test('describePagesPreview: pr-preview path mentions Actions check', () => {
  const docs = classifyDocsImpact({ changedFiles: ['docs/a.md'] });
  const s = describePagesPreview({
    verdict: 'pr-preview',
    branch: 'feature/x',
    pagesSource: { branch: 'main', path: '/docs' },
    docsImpact: docs,
  });
  assert.match(s, /PR-preview/);
  assert.match(s, /Actions preview comment/);
});

test('describePagesPreview: pages-disabled copy', () => {
  const docs = classifyDocsImpact({ changedFiles: [] });
  const s = describePagesPreview({
    verdict: 'pages-disabled', branch: 'main', pagesSource: undefined, docsImpact: docs,
  });
  assert.match(s, /not configured/);
});

test('describePagesPreview: zero docs changes uses singular "no" copy', () => {
  const docs = classifyDocsImpact({ changedFiles: [] });
  const s = describePagesPreview({
    verdict: 'serving', branch: 'main',
    pagesSource: { branch: 'main', path: '/' }, docsImpact: docs,
  });
  assert.match(s, /no docs changes/);
});

// ── buildPagesReport ───────────────────────────────────────────────

test('buildPagesReport: serving-from-docs writes deep links per doc', () => {
  const docs = classifyDocsImpact({
    changedFiles: ['docs/foo.md', 'docs/guides/install.md', 'docs/img/x.png'],
  });
  const md = buildPagesReport({
    branch: 'main',
    pagesSource: { branch: 'main', path: '/docs' },
    verdict: 'serving-from-docs',
    productionUrl: 'https://owner.github.io/repo/',
    docsImpact: docs,
    ownerRepoSlug: { owner: 'owner', repo: 'repo' },
  });
  assert.match(md, /# GitHub Pages preview - `main`/);
  assert.match(md, /Verdict: \*\*serving from docs\*\*/);
  assert.match(md, /Production URL: <https:\/\/owner\.github\.io\/repo\/>/);
  assert.match(md, /## Deep links/);
  assert.match(md, /\[`docs\/foo\.md`\]\(https:\/\/owner\.github\.io\/repo\/foo\/\)/);
  // Asset should not appear in deep links.
  assert.doesNotMatch(md, /img\/x\.png/);
});

test('buildPagesReport: pr-preview mentions Actions pattern', () => {
  const docs = classifyDocsImpact({ changedFiles: ['docs/a.md'] });
  const md = buildPagesReport({
    branch: 'feature/x',
    pagesSource: { branch: 'main', path: '/docs' },
    verdict: 'pr-preview',
    productionUrl: 'https://owner.github.io/repo/',
    docsImpact: docs,
    ownerRepoSlug: { owner: 'owner', repo: 'repo' },
  });
  assert.match(md, /## Preview pattern/);
  assert.match(md, /Actions-driven preview/);
});

test('buildPagesReport: no docs changes -> short report', () => {
  const docs = classifyDocsImpact({ changedFiles: ['src/x.ts'] });
  const md = buildPagesReport({
    branch: 'main',
    pagesSource: { branch: 'main', path: '/docs' },
    verdict: 'serving-from-docs',
    productionUrl: 'https://owner.github.io/repo/',
    docsImpact: docs,
    ownerRepoSlug: { owner: 'owner', repo: 'repo' },
  });
  assert.match(md, /No docs changes/);
  assert.doesNotMatch(md, /## Deep links/);
});

test('buildPagesReport: docs/ counts sorted churn-desc', () => {
  const docs = classifyDocsImpact({
    changedFiles: [
      '_site/a.html',
      'docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md',
    ],
  });
  const md = buildPagesReport({
    branch: 'main',
    pagesSource: { branch: 'main', path: '/docs' },
    verdict: 'serving-from-docs',
    productionUrl: 'https://owner.github.io/repo/',
    docsImpact: docs,
    ownerRepoSlug: { owner: 'owner', repo: 'repo' },
  });
  const docsIdx = md.indexOf('`docs/`');
  const siteIdx = md.indexOf('`_site/`');
  assert.ok(docsIdx > 0);
  assert.ok(siteIdx > 0);
  assert.ok(docsIdx < siteIdx, 'docs (4 files) should appear before _site (1 file)');
});
