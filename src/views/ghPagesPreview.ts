/**
 * F79 - Local-branch GitHub Pages preview.
 *
 * New command (`gitsight.ghPagesPreview`) that, for the current branch:
 *
 *   1. Probes `gh api repos/:o/:r/pages` to find the configured Pages
 *      source (branch + path). Degrades gracefully when Pages isn't
 *      enabled or when gh is missing.
 *   2. Computes the docs/_site/site change set across `<base>..HEAD`
 *      using git diff --name-only.
 *   3. Classifies the verdict (serving / serving-from-docs / pr-preview
 *      / pages-disabled / unknown) and shows a picker with:
 *        - Open production URL
 *        - Open report (markdown buffer with deep links per changed doc)
 *        - Copy production URL
 *        - Copy deep link of the first changed doc
 *
 * Composes with F87 + F88 + F100 (the "branch context dashboards"
 * pattern); pure helpers + classifier live in src/git/ghPagesPreview.ts.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parseRemote } from '../git/hostDetect';
import {
  buildPagesProductionUrl,
  classifyPagesBranch,
  classifyDocsImpact,
  buildDocDeepLink,
  describePagesPreview,
  buildPagesReport,
  PagesSourceInfo,
  PagesBranchVerdict,
  DocsImpactResult,
  ParsedRemoteSlug,
} from '../git/ghPagesPreview';

const pexec = promisify(execFile);

export async function showGhPagesPreview(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  const slug = await resolveRepoSlug(git);
  if (!slug) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub remote - GitHub Pages preview unavailable.');
    return;
  }
  const branch = await resolveBranch(git);
  if (!branch) {
    vscode.window.showInformationMessage('GitSight: detached HEAD - no branch to preview.');
    return;
  }

  const probe = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: probing GitHub Pages for \`${slug.owner}/${slug.repo}\`\u2026`,
    },
    async () => {
      const [pagesSource, defaultBranch, changedFiles] = await Promise.all([
        probePagesSource(slug),
        resolveDefaultBranch(git),
        resolveChangedFiles(git, branch),
      ]);
      const docsDirs = vscode.workspace.getConfiguration('gitsight.ghPagesPreview')
        .get<string[]>('docsDirs');
      const cap = vscode.workspace.getConfiguration('gitsight.ghPagesPreview')
        .get<number>('matchedPathCap', 50);
      const docsImpact = classifyDocsImpact({
        changedFiles,
        pagesDirs: Array.isArray(docsDirs) && docsDirs.length > 0 ? docsDirs : undefined,
        cap,
      });
      const verdict = classifyPagesBranch({
        branch,
        defaultBranch,
        pagesSource: pagesSource.source,
        probeFailed: pagesSource.probeFailed,
      });
      return { pagesSource: pagesSource.source, verdict, docsImpact };
    },
  );

  const productionUrl = buildPagesProductionUrl(slug);
  const summary = describePagesPreview({
    verdict: probe.verdict,
    branch,
    pagesSource: probe.pagesSource,
    docsImpact: probe.docsImpact,
  });

  await runPicker({
    branch,
    slug,
    verdict: probe.verdict,
    pagesSource: probe.pagesSource,
    docsImpact: probe.docsImpact,
    productionUrl,
    summary,
  });
}

interface PickerArgs {
  branch: string;
  slug: ParsedRemoteSlug;
  verdict: PagesBranchVerdict;
  pagesSource: PagesSourceInfo | undefined;
  docsImpact: DocsImpactResult;
  productionUrl: string;
  summary: string;
}

async function runPicker(args: PickerArgs): Promise<void> {
  type Pk = vscode.QuickPickItem & {
    _act?: 'open-prod' | 'open-report' | 'copy-prod' | 'copy-first-deep' | 'open-deep';
    _path?: string;
  };
  const items: Pk[] = [];
  items.push({
    label: `$(${glyphForVerdict(args.verdict)}) ${args.summary}`,
    detail: args.productionUrl ? `Production URL: ${args.productionUrl}` : 'No production URL',
  });
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
  if (args.productionUrl) {
    items.push({ label: '$(globe) Open production URL', _act: 'open-prod' });
    items.push({ label: '$(copy) Copy production URL', _act: 'copy-prod' });
  }
  if (args.docsImpact.affectsPages) {
    items.push({ label: '$(file) Open full report', _act: 'open-report' });
  }
  const docsDir = args.pagesSource?.path?.replace(/^\//, '') || '';
  const deepLinks = args.docsImpact.matchedPaths
    .map(p => ({ p, url: buildDocDeepLink({ productionBase: args.productionUrl, path: p, pagesDir: docsDir }) }))
    .filter(d => !!d.url);
  if (deepLinks.length > 0) {
    items.push({
      label: '$(link-external) Copy first deep link',
      description: deepLinks[0].url,
      _act: 'copy-first-deep',
    });
    items.push({ label: 'Deep links', kind: vscode.QuickPickItemKind.Separator } as any);
    for (const d of deepLinks.slice(0, 20)) {
      items.push({
        label: `$(arrow-right) ${d.p}`,
        description: d.url,
        _act: 'open-deep',
        _path: d.url,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: args.summary,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  switch (picked._act) {
    case 'open-prod':
      if (args.productionUrl) await vscode.env.openExternal(vscode.Uri.parse(args.productionUrl));
      break;
    case 'copy-prod':
      if (args.productionUrl) {
        await vscode.env.clipboard.writeText(args.productionUrl);
        vscode.window.setStatusBarMessage('GitSight: copied Pages URL', 3000);
      }
      break;
    case 'open-report': {
      const md = buildPagesReport({
        branch: args.branch,
        pagesSource: args.pagesSource,
        verdict: args.verdict,
        productionUrl: args.productionUrl,
        docsImpact: args.docsImpact,
        ownerRepoSlug: args.slug,
      });
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      break;
    }
    case 'copy-first-deep': {
      if (deepLinks[0]?.url) {
        await vscode.env.clipboard.writeText(deepLinks[0].url);
        vscode.window.setStatusBarMessage('GitSight: copied deep link', 3000);
      }
      break;
    }
    case 'open-deep':
      if (picked._path) await vscode.env.openExternal(vscode.Uri.parse(picked._path));
      break;
  }
}

function glyphForVerdict(v: PagesBranchVerdict): string {
  switch (v) {
    case 'serving':
    case 'serving-from-docs': return 'rocket';
    case 'pr-preview':        return 'preview';
    case 'pages-disabled':    return 'circle-slash';
    case 'unknown':           return 'question';
  }
}

async function probePagesSource(slug: ParsedRemoteSlug): Promise<{ source: PagesSourceInfo | undefined; probeFailed: boolean }> {
  // Try gh CLI first - it handles auth.
  try {
    const { stdout } = await pexec('gh', [
      'api', `repos/${slug.owner}/${slug.repo}/pages`,
    ], { timeout: 8000, maxBuffer: 256 * 1024 });
    const obj = JSON.parse(stdout);
    const source = obj?.source;
    if (source && typeof source === 'object') {
      return {
        source: {
          branch: typeof source.branch === 'string' ? source.branch : undefined,
          path: typeof source.path === 'string' ? source.path : undefined,
        },
        probeFailed: false,
      };
    }
    return { source: undefined, probeFailed: false };
  } catch (e: any) {
    const msg = (e?.stderr ?? e?.message ?? '').toString();
    // 404 means Pages isn't configured - not a probe failure.
    if (/HTTP 404|not found/i.test(msg)) {
      return { source: undefined, probeFailed: false };
    }
    return { source: undefined, probeFailed: true };
  }
}

async function resolveRepoSlug(git: Git): Promise<ParsedRemoteSlug | undefined> {
  try {
    const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
    const info = parseRemote(url);
    if (!info || info.host !== 'github') return undefined;
    return { owner: info.owner, repo: info.repo };
  } catch {
    return undefined;
  }
}

async function resolveBranch(git: Git): Promise<string | undefined> {
  try {
    const b = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return (!b || b === 'HEAD') ? undefined : b;
  } catch {
    return undefined;
  }
}

async function resolveDefaultBranch(git: Git): Promise<string | undefined> {
  try {
    const out = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out.replace(/^origin\//, '');
  } catch { /* may not be set */ }
  for (const cand of ['main', 'master']) {
    try { await git.raw(['rev-parse', '--verify', cand]); return cand; } catch { /* skip */ }
  }
  return undefined;
}

async function resolveChangedFiles(git: Git, branch: string): Promise<string[]> {
  // Compute against origin's default branch when possible, else fall
  // back to the merge-base of origin/HEAD..HEAD.
  const defaultBranch = await resolveDefaultBranch(git);
  const candidateBases = defaultBranch
    ? [`origin/${defaultBranch}...HEAD`, `${defaultBranch}...HEAD`]
    : ['origin/HEAD...HEAD'];
  for (const range of candidateBases) {
    try {
      const out = await git.raw(['diff', '--name-only', range]);
      return out.split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* try next */ }
  }
  // Last-resort: look at the latest 30 commits on the current branch
  // for any docs/_site touches.
  try {
    const out = await git.raw(['log', '-30', '--name-only', '--pretty=format:', branch]);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
