/**
 * Pure helpers for F79 - Local-branch GitHub Pages preview.
 *
 * For a branch with changes under `docs/`, `_site/`, or other configured
 * Pages source directories, generate the preview URL that gh-pages
 * would serve. Useful for "I just pushed a docs branch - what does
 * the preview look like?" without leaving the editor.
 *
 * GitHub Pages serves from:
 *   1. `gh-pages` branch (legacy default) or
 *   2. The default branch's `/docs` folder or
 *   3. Any branch + folder configured in repo settings (via
 *      `gh api repos/:o/:r/pages` -> source.{branch, path}).
 *
 * URL shape (org-page vs project-page):
 *   - Org-page (repo named `<owner>.github.io`):
 *       https://<owner>.github.io/
 *   - Project page:
 *       https://<owner>.github.io/<repo>/
 *
 * For non-default branches we cannot generate a "preview URL" in the
 * Pages sense (Pages serves one branch at a time per source) - but
 * we CAN surface:
 *   - The branch's recent docs changes (for review)
 *   - The PR preview URL when a Pages PR-preview Action is configured
 *     (e.g. `peaceiris/actions-gh-pages` or `cloudflare/pages-action`
 *     posts a comment with the preview URL).
 *
 * Pure - no vscode, no child_process. Tests in test/git/ghPagesPreview.test.ts.
 */

export interface ParsedRemoteSlug {
  owner: string;
  repo: string;
}

/**
 * Build the canonical GitHub Pages production URL for an owner/repo.
 *
 * Org-page case: when repo name matches `<owner>.github.io` (case
 * insensitive). Otherwise: project page under `/repo/`.
 */
export function buildPagesProductionUrl(args: ParsedRemoteSlug): string {
  const owner = (args.owner ?? '').trim();
  const repo = (args.repo ?? '').trim();
  if (!owner || !repo) return '';
  const isOrgPage = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  if (isOrgPage) {
    return `https://${owner.toLowerCase()}.github.io/`;
  }
  return `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

/**
 * Classify whether a branch is the Pages-serving branch.
 *
 * Inputs:
 *   - branch: branch the user is on
 *   - pagesSource: the source descriptor from `gh api repos/.../pages`
 *     (when available; undefined when no Pages config or gh missing)
 *   - defaultBranch: repo default (from origin/HEAD)
 *
 * Verdict states:
 *   - 'serving'           -> this branch is the configured Pages source
 *   - 'serving-from-docs' -> branch is default branch AND Pages serves
 *                            from /docs on the default
 *   - 'pr-preview'        -> branch is NOT the source; we'll look for
 *                            an Actions-driven preview comment instead
 *   - 'pages-disabled'    -> Pages isn't configured for this repo
 *   - 'unknown'           -> probe failed; can't classify
 */
export type PagesBranchVerdict =
  | 'serving'
  | 'serving-from-docs'
  | 'pr-preview'
  | 'pages-disabled'
  | 'unknown';

export interface PagesSourceInfo {
  branch?: string;
  /** Pages path: "/" or "/docs". */
  path?: string;
}

export interface ClassifyPagesArgs {
  branch: string;
  defaultBranch?: string;
  pagesSource: PagesSourceInfo | undefined;
  /** True when we couldn't probe Pages config (gh missing, API failure). */
  probeFailed?: boolean;
}

export function classifyPagesBranch(args: ClassifyPagesArgs): PagesBranchVerdict {
  if (args.probeFailed) return 'unknown';
  if (!args.pagesSource) return 'pages-disabled';
  const onSourceBranch = args.pagesSource.branch
    && args.branch === args.pagesSource.branch;
  if (onSourceBranch) {
    if (args.pagesSource.path === '/docs') return 'serving-from-docs';
    return 'serving';
  }
  return 'pr-preview';
}

// ── Docs change detection ─────────────────────────────────────────────

/**
 * Detect whether a list of changed file paths (e.g. from `git diff
 * --name-only base..HEAD`) includes anything that would affect Pages.
 *
 * Defaults to checking the common Pages source directories: docs/,
 * _site/, site/, public/, build/, dist/, content/. Each is a top-level
 * directory match (leading `./` stripped).
 */
const DEFAULT_PAGES_DIRS = [
  'docs', '_site', 'site', 'public', 'build', 'dist', 'content',
];

export interface DocsImpactResult {
  /** True when at least one changed file lives under a Pages dir. */
  affectsPages: boolean;
  /** Per-dir counts so the picker can rank by churn. */
  countsByDir: Record<string, number>;
  /** Paths matched (capped to keep memory bounded). */
  matchedPaths: string[];
}

export interface ClassifyDocsImpactArgs {
  changedFiles: string[];
  /** Custom directory list; defaults to DEFAULT_PAGES_DIRS. */
  pagesDirs?: string[];
  /** Per-classify cap on matchedPaths returned. */
  cap?: number;
}

export function classifyDocsImpact(args: ClassifyDocsImpactArgs): DocsImpactResult {
  const dirs = (args.pagesDirs ?? DEFAULT_PAGES_DIRS).map(d => normaliseDir(d)).filter(Boolean);
  const counts: Record<string, number> = {};
  const matchedPaths: string[] = [];
  const cap = Math.max(0, args.cap ?? 50);
  for (const raw of args.changedFiles ?? []) {
    const path = normalisePath(raw);
    if (!path) continue;
    for (const dir of dirs) {
      if (path === dir || path.startsWith(`${dir}/`)) {
        counts[dir] = (counts[dir] ?? 0) + 1;
        if (matchedPaths.length < cap) {
          matchedPaths.push(path);
        }
        break;
      }
    }
  }
  return {
    affectsPages: Object.values(counts).some(n => n > 0),
    countsByDir: counts,
    matchedPaths,
  };
}

function normaliseDir(d: string): string {
  return (d ?? '').trim().replace(/^\.?\/+/, '').replace(/\/+$/, '').toLowerCase();
}

function normalisePath(p: string): string {
  return (p ?? '').trim().replace(/^\.?\/+/, '').toLowerCase();
}

// ── Preview URL composition ──────────────────────────────────────────

/**
 * Build a deep-link URL for a documents preview. Given the Pages
 * production base URL + a changed Markdown path, produce the URL
 * that Pages would serve for that path:
 *
 *   docs/foo/bar.md       -> https://owner.github.io/repo/foo/bar
 *   docs/index.md         -> https://owner.github.io/repo/
 *   _site/about/index.html -> https://owner.github.io/repo/about/
 *
 * Returns undefined when the path doesn't look like a Pages-servable
 * resource (e.g. an asset path or a layout/include).
 */
export interface DeepLinkArgs {
  productionBase: string;
  /** Repository-relative path that changed (e.g. "docs/foo.md"). */
  path: string;
  /** Pages dir prefix that should be stripped from the path before
   *  composing the URL (e.g. "docs" -> strip the "docs/" prefix). */
  pagesDir?: string;
}

export function buildDocDeepLink(args: DeepLinkArgs): string | undefined {
  const base = (args.productionBase ?? '').replace(/\/+$/, '');
  if (!base) return undefined;
  let p = normalisePath(args.path);
  if (!p) return undefined;
  const dir = args.pagesDir ? normaliseDir(args.pagesDir) : '';
  if (dir && (p === dir || p.startsWith(`${dir}/`))) {
    p = p.slice(dir.length).replace(/^\/+/, '');
  }
  // Skip private partials / includes / layouts.
  if (/^_/.test(p) || p.includes('/_')) return undefined;
  // Skip assets - these are served at their literal path but we don't
  // generate "preview" URLs for them.
  if (/\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|woff2?)$/i.test(p)) return undefined;
  // Strip the extension for canonical .html / .md routes.
  if (/\.(?:md|markdown|mdx|html|htm)$/i.test(p)) {
    p = p.replace(/\.(?:md|markdown|mdx|html|htm)$/i, '');
    if (p === 'index' || p.endsWith('/index')) {
      p = p.replace(/index$/, '');
    }
  } else {
    // Non-documents file in a docs dir - not preview-servable.
    return undefined;
  }
  if (p && !p.endsWith('/') && !/\.[a-z0-9]+$/i.test(p)) {
    // Keep trailing slash for directory-style URLs to match Jekyll/Pages defaults.
    p = `${p}/`;
  }
  return `${base}/${p}`;
}

/**
 * Build a one-line summary suitable for the picker placeholder:
 *
 *   "Pages: serving from main/docs - 4 docs changes on this branch"
 *   "Pages: PR-preview - 2 docs changes (check for Actions preview comment)"
 *   "Pages: not configured"
 */
export interface DescribePagesArgs {
  verdict: PagesBranchVerdict;
  branch: string;
  pagesSource: PagesSourceInfo | undefined;
  docsImpact: DocsImpactResult;
}

export function describePagesPreview(args: DescribePagesArgs): string {
  const docsCount = sum(Object.values(args.docsImpact.countsByDir));
  const docsBlurb = docsCount > 0
    ? `${docsCount} docs change${docsCount === 1 ? '' : 's'} on \`${args.branch}\``
    : `no docs changes on \`${args.branch}\``;
  switch (args.verdict) {
    case 'serving':
      return `Pages: serving from \`${args.pagesSource?.branch ?? '?'}${args.pagesSource?.path ?? ''}\` - ${docsBlurb}`;
    case 'serving-from-docs':
      return `Pages: serving from \`${args.pagesSource?.branch ?? '?'}/docs\` - ${docsBlurb}`;
    case 'pr-preview':
      return `Pages: PR-preview path - ${docsBlurb} (check for Actions preview comment)`;
    case 'pages-disabled':
      return `Pages: not configured for this repo - ${docsBlurb}`;
    case 'unknown':
      return `Pages: status unknown - ${docsBlurb}`;
  }
}

function sum(arr: number[]): number {
  let n = 0;
  for (const v of arr) n += v;
  return n;
}

/**
 * Full markdown report combining the verdict + production URL +
 * per-changed-doc deep links. Used by the "Open report" action.
 */
export interface PagesReportArgs {
  branch: string;
  pagesSource: PagesSourceInfo | undefined;
  verdict: PagesBranchVerdict;
  productionUrl: string;
  docsImpact: DocsImpactResult;
  ownerRepoSlug: ParsedRemoteSlug;
}

export function buildPagesReport(args: PagesReportArgs): string {
  const lines: string[] = [];
  lines.push(`# GitHub Pages preview - \`${args.branch}\``);
  lines.push('');
  lines.push(`Verdict: **${args.verdict.replace(/-/g, ' ')}**`);
  lines.push('');
  if (args.productionUrl) {
    lines.push(`Production URL: <${args.productionUrl}>`);
    lines.push('');
  }
  if (args.pagesSource?.branch) {
    lines.push(`Pages source: \`${args.pagesSource.branch}${args.pagesSource.path ?? ''}\``);
    lines.push('');
  }
  if (!args.docsImpact.affectsPages) {
    lines.push('_No docs changes detected on this branch._');
    return lines.join('\n');
  }
  lines.push('## Docs changes');
  lines.push('');
  for (const [dir, n] of Object.entries(args.docsImpact.countsByDir).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${dir}/\` - ${n} file${n === 1 ? '' : 's'}`);
  }
  lines.push('');
  if (args.verdict === 'serving' || args.verdict === 'serving-from-docs') {
    const dir = args.verdict === 'serving-from-docs' ? 'docs' : args.pagesSource?.path?.replace(/^\//, '') || '';
    lines.push('## Deep links');
    lines.push('');
    const links: Array<{ src: string; url: string }> = [];
    for (const p of args.docsImpact.matchedPaths) {
      const url = buildDocDeepLink({ productionBase: args.productionUrl, path: p, pagesDir: dir });
      if (url) links.push({ src: p, url });
    }
    if (links.length === 0) {
      lines.push('_No matched paths could be mapped to Pages routes._');
    } else {
      for (const l of links) {
        lines.push(`- [\`${l.src}\`](${l.url})`);
      }
    }
    lines.push('');
  } else if (args.verdict === 'pr-preview') {
    lines.push('## Preview pattern');
    lines.push('');
    lines.push('This branch is not the Pages-serving branch. If your repo uses an Actions-driven preview (e.g. `peaceiris/actions-gh-pages`, `cloudflare/pages-action`), look for a comment on the PR with the preview URL.');
    lines.push('');
  }
  return lines.join('\n');
}
