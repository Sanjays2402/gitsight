/**
 * "Files I own" picker (F47).
 *
 * Combines CODEOWNERS rules and recent-shortlog dominance into a ranked
 * picker of files the current user is the primary owner of. Picking an
 * entry opens the file in the editor.
 *
 * Configurable via:
 *   gitsight.filesIOwn.days        (default 365) — shortlog scan window
 *   gitsight.filesIOwn.maxFiles    (default 500) — quickpick cap
 *   gitsight.filesIOwn.handles     (default [])  — extra GitHub handles
 *                                                  to treat as "me"
 *   gitsight.filesIOwn.emails      (default [])  — extra emails to treat
 *                                                  as "me" (in addition
 *                                                  to git config user.email)
 *
 * The expensive bit is shortlog collection. We use
 * `git log --since=Nd --no-merges --pretty=format:'%aE|%aN' --name-only`
 * which streams just enough metadata. Output is cached for the duration
 * of the command invocation; rerun the command to refresh.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import {
  buildFilesIOwn,
  parseShortlog,
  parseCodeownersBody,
  UserIdentity,
  FileOwnership,
} from '../git/filesIOwn';

export async function showFilesIOwnPicker(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.filesIOwn');
  const days = clamp(cfg.get<number>('days', 365), 1, 3650);
  const maxFiles = clamp(cfg.get<number>('maxFiles', 500), 10, 10000);
  const extraHandles = cfg.get<string[]>('handles', []) ?? [];
  const extraEmails = cfg.get<string[]>('emails', []) ?? [];

  const user = await loadUser(git, extraHandles, extraEmails);
  if (!user.email && !user.name) {
    vscode.window.showWarningMessage(
      'GitSight: no git user.email / user.name configured — cannot identify "me".',
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: scanning files I own (last ${days}d)…`,
    },
    async () => {
      const codeowners = await loadCodeowners(git);
      const tracked = (await safe(git, ['ls-files']))
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      const shortlogRaw = await safe(git, [
        'log',
        `--since=${days}.days`,
        '--no-merges',
        '--pretty=format:%aE|%aN',
        '--name-only',
      ]);
      const shortlog = parseShortlog(shortlogRaw);
      const owned = buildFilesIOwn({
        user,
        rules: codeowners.rules,
        trackedFiles: tracked,
        shortlog,
      });
      if (!owned.length) {
        vscode.window.showInformationMessage(
          codeowners.found
            ? `GitSight: no CODEOWNERS rule names you, and you haven't been the dominant author on any file in the last ${days}d.`
            : `GitSight: no CODEOWNERS file in this repo, and you haven't been the dominant author on any file in the last ${days}d.`,
        );
        return;
      }
      const trimmed = owned.slice(0, maxFiles);
      await offerPicker(git, trimmed, owned.length, days);
    },
  );
}

async function offerPicker(
  git: Git,
  owned: FileOwnership[],
  totalKnown: number,
  days: number,
): Promise<void> {
  type Pk = vscode.QuickPickItem & { _file: FileOwnership };
  const items: Pk[] = owned.map(o => ({
    label: `$(file) ${o.path}`,
    description: descFor(o),
    detail: detailFor(o),
    _file: o,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      `${owned.length}${owned.length < totalKnown ? `/${totalKnown}` : ''} owned files (scan window: ${days}d)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const uri = vscode.Uri.file(path.join(git.cwd, picked._file.path));
  await vscode.commands.executeCommand('vscode.open', uri);
}

function descFor(o: FileOwnership): string {
  if (o.source === 'both') return `CODEOWNERS · ${o.myCommits}/${o.totalCommits} commits`;
  if (o.source === 'codeowners') return 'CODEOWNERS';
  return `${o.myCommits}/${o.totalCommits} commits · ${Math.round(o.ownershipShare * 100)}%`;
}

function detailFor(o: FileOwnership): string | undefined {
  if (o.codeownersOwners.length) {
    return `Owners: ${o.codeownersOwners.join(', ')}`;
  }
  return undefined;
}

async function loadUser(
  git: Git,
  extraHandles: string[],
  extraEmails: string[],
): Promise<UserIdentity> {
  const email = (await safe(git, ['config', 'user.email'])).trim();
  const name = (await safe(git, ['config', 'user.name'])).trim();
  // Derive a default handle from a GitHub-style noreply email
  //   51058514+Sanjays2402@users.noreply.github.com  → @Sanjays2402
  let handle: string | undefined;
  const m = /^[0-9]+\+([A-Za-z0-9-]+)@users\.noreply\.github\.com$/.exec(email);
  if (m) handle = '@' + m[1];
  const aliases: string[] = [];
  for (const h of extraHandles) {
    if (!h) continue;
    aliases.push(h.startsWith('@') ? h : '@' + h);
  }
  for (const e of extraEmails) {
    if (!e) continue;
    aliases.push(e);
  }
  return { email, name, handle, aliases };
}

async function loadCodeowners(git: Git): Promise<{ rules: ReturnType<typeof parseCodeownersBody>; found: boolean }> {
  const candidates = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
  for (const rel of candidates) {
    try {
      const body = await fs.readFile(path.join(git.cwd, rel), 'utf8');
      return { rules: parseCodeownersBody(body), found: true };
    } catch {
      continue;
    }
  }
  return { rules: [], found: false };
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function clamp(v: number | undefined, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
