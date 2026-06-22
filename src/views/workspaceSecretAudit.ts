/**
 * F94 — Workspace Secret Audit Summary.
 *
 * Sister command to F89 (single-repo pill). Where the pill warns about
 * the active repo's missing workflow secrets, F94 walks EVERY git repo
 * in the workspace and surfaces a single tree-of-trees:
 *
 *   foo-app (3 missing)
 *     NPM_TOKEN     ci.yml:7
 *     SLACK_TOKEN   deploy.yml:12, deploy.yml:18
 *     ROUTE_KEY     deploy.yml:14
 *   bar-service (healthy)
 *
 * Each row is clickable: missing-secret rows open the workflow at the
 * first reference; the "healthy" row is a tooltip-only entry. The
 * summary is also written into a scratch markdown buffer so it can be
 * shared/copied verbatim. Refreshes are explicit (no background poll —
 * the per-repo pill already handles its own refresh).
 *
 * Why workspace-wide as a tree instead of "loop the pill"? Because in
 * a multi-repo VS Code window (monorepo with linked submodules,
 * polyglot workspace) the per-repo pill only ever reflects the primary
 * repo. Users with 5+ services in one workspace need an at-a-glance
 * "which one is bleeding?" view.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  scanWorkflowBody,
  buildAudit,
  workflowFilesFromDir,
} from '../git/secretAudit';
import {
  RepoAuditEntry,
  rankEntries,
  summariseEntries,
  glyphFor,
  describeEntryShort,
  describeEntryDetail,
  renderMarkdownReport,
} from '../git/workspaceSecretAudit';

const pexec = promisify(execFile);

export async function showWorkspaceSecretAudit(repos: RepoManager): Promise<void> {
  const allRepos = repos.all();
  if (!allRepos.length) {
    vscode.window.showInformationMessage('GitSight: no Git repos in this workspace.');
    return;
  }

  if (!(await ghCliAvailable())) {
    vscode.window.showWarningMessage(
      'GitSight: gh CLI not on PATH (install: brew install gh) \u2014 workspace secret audit requires gh.',
    );
    return;
  }

  const entries = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: auditing ${allRepos.length} repo${allRepos.length === 1 ? '' : 's'}\u2026`,
    },
    async (progress) => {
      const out: RepoAuditEntry[] = [];
      for (let i = 0; i < allRepos.length; i++) {
        const git = allRepos[i];
        const name = path.basename(git.cwd);
        progress.report({ message: name, increment: 100 / allRepos.length });
        out.push(await auditOne(git, name));
      }
      return out;
    },
  );

  // Show the picker tree.
  type Pk = vscode.QuickPickItem & { _action: 'open-file' | 'set-secret' | 'noop' | 'show-report'; _entry?: RepoAuditEntry; _name?: string; _workflow?: string; _line?: number };
  const items: Pk[] = [];
  const ranked = rankEntries(entries);
  items.push({
    label: summariseEntries(ranked),
    kind: vscode.QuickPickItemKind.Separator,
    _action: 'noop',
  } as any);
  for (const entry of ranked) {
    items.push({
      label: `$(${glyphFor(entry)}) ${entry.name}`,
      description: describeEntryShort(entry),
      detail: describeEntryDetail(entry),
      _action: 'noop',
      _entry: entry,
    });
    if (entry.applies && entry.audit?.missing.length) {
      for (const name of entry.audit.missing) {
        const refs = entry.audit.refs.filter(r => r.name === name);
        const first = refs[0];
        items.push({
          label: `    $(warning) ${name}`,
          description: describeRefs(refs),
          detail: `Open ${first.workflow}:${first.line}`,
          _action: 'open-file',
          _entry: entry,
          _name: name,
          _workflow: first.workflow,
          _line: first.line,
        });
      }
    }
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, _action: 'noop' } as any);
  items.push({
    label: '$(file-text) Open full report in scratch buffer',
    description: 'Markdown summary of all repos in this workspace',
    _action: 'show-report',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Workspace secret audit \u00b7 ${ranked.length} repo${ranked.length === 1 ? '' : 's'}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'show-report') return showFullReport(ranked);
  if (picked._action === 'open-file' && picked._entry && picked._workflow !== undefined && picked._line !== undefined) {
    await openWorkflowAtLine(picked._entry.cwd, picked._workflow, picked._line);
  }
}

async function auditOne(git: Git, name: string): Promise<RepoAuditEntry> {
  const entry: RepoAuditEntry = { cwd: git.cwd, name, applies: false };
  const url = (await safe(git, ['config', '--get', 'remote.origin.url'])).trim();
  if (!/github\.com[:/]/.test(url)) {
    entry.skippedReason = 'not a github.com origin';
    return entry;
  }
  const slugMatch = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (slugMatch) entry.slug = `${slugMatch[1]}/${slugMatch[2]}`;
  const wfDir = path.join(git.cwd, '.github', 'workflows');
  let wfFiles: string[] = [];
  try {
    const dirEntries = await fs.readdir(wfDir);
    wfFiles = workflowFilesFromDir(dirEntries);
  } catch {
    entry.skippedReason = 'no .github/workflows directory';
    return entry;
  }
  if (!wfFiles.length) {
    entry.skippedReason = 'no workflow files';
    return entry;
  }
  entry.applies = true;
  const scans = await Promise.all(wfFiles.map(async f => {
    const body = await fs.readFile(path.join(wfDir, f), 'utf8').catch(() => '');
    const { refs, dynamicRefCount } = scanWorkflowBody(f, body);
    return { workflow: f, refs, dynamicRefCount };
  }));
  const configured = await loadConfiguredSecrets(git);
  entry.audit = buildAudit({ scans, configured });
  return entry;
}

async function loadConfiguredSecrets(git: Git): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { stdout } = await pexec('gh', ['secret', 'list', '--json', 'name'], {
      cwd: git.cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    });
    const arr = JSON.parse(stdout);
    if (Array.isArray(arr)) for (const r of arr) if (r && typeof r.name === 'string') out.add(r.name);
  } catch {
    /* offline / unauthed: leave empty (we'll flag everything) */
  }
  return out;
}

/**
 * Rank entries: missing-secret repos FIRST (most missing first), then
 * applies-but-healthy repos, then skipped repos at the bottom.
 * Within each tier, alphabetical name.
 *
 * Re-exported from the pure helper module so existing callers that
 * imported `RepoAuditEntry` / `renderMarkdownReport` from the view
 * layer keep working without code churn.
 */
export { rankEntries, summariseEntries, glyphFor, describeEntryShort, describeEntryDetail, renderMarkdownReport };
export type { RepoAuditEntry as RepoAuditEntryType } from '../git/workspaceSecretAudit';

function describeRefs(refs: { workflow: string; line: number }[]): string {
  if (!refs.length) return '';
  return refs.map(r => `${r.workflow}:${r.line}`).join('  \u00b7  ');
}

async function openWorkflowAtLine(repoCwd: string, workflow: string, line: number): Promise<void> {
  const abs = path.join(repoCwd, '.github', 'workflows', workflow);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lineZero = Math.max(0, line - 1);
    const pos = new vscode.Position(lineZero, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: cannot open ${workflow}: ${e.message ?? e}`);
  }
}

async function showFullReport(entries: RepoAuditEntry[]): Promise<void> {
  const body = renderMarkdownReport(entries, new Date());
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: body });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function ghCliAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000, maxBuffer: 64 * 1024 }); return true; }
  catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
