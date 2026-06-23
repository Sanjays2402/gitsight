/**
 * F131 - Stash Patch Import (companion to F127 export).
 *
 * New command (`gitsight.importStashPatch`) that:
 *   1. Asks the user to pick a `.patch` file via the OS file picker
 *      (or via a quick-pick over patches discovered next to the
 *      configured export directory).
 *   2. Inspects the payload to confirm it's a real patch.
 *   3. Runs `git apply --3way <path>` and classifies the outcome.
 *   4. On 'applied-with-conflicts', offers to launch the F107
 *      conflict-coach on the first conflicted file.
 *   5. On 'rejected' / 'failed', shows the structured error and
 *      offers to copy the patch body so the user can investigate.
 *
 * Composes with F107 conflict-coach + F109 stash-on-pull recovery
 * pattern (structured outcome + recovery branch).
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  inspectPatchPayload,
  classifyApplyResult,
  buildPatchPickerLabel,
  buildPatchPickerDetail,
  sortPatchCandidates,
  PatchCandidate,
  PatchPayloadInfo,
  ApplyClassification,
} from '../git/stashPatchImport';

const pexec = promisify(execFile);

export async function importStashPatch(repos: RepoManager, opts?: { preselectPath?: string }): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }

  // F133 - if discovery passed a preselected path, jump straight to load+confirm.
  let picked: PickResult | undefined;
  if (opts?.preselectPath) {
    try {
      const body = await fs.readFile(opts.preselectPath, 'utf8');
      const info = inspectPatchPayload(body, opts.preselectPath);
      picked = { filename: opts.preselectPath, info };
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: could not read patch: ${e?.message ?? e}`);
      return;
    }
  } else {
    const candidates = await collectPatchCandidates(git);
    picked = await pickCandidate(git, candidates);
  }
  if (!picked) return;

  const info = picked.info;
  if (!info.looksValid) {
    const choice = await vscode.window.showWarningMessage(
      `GitSight: '${path.basename(picked.filename)}' doesn't look like a patch (no diff --git or From: headers).`,
      'Apply anyway',
      'Cancel',
    );
    if (choice !== 'Apply anyway') return;
  }

  const confirmed = await confirmApply(picked, info);
  if (!confirmed) return;

  const result = await runGitApply(git, picked.filename);
  await reportOutcome(git, picked, result);
}

async function collectPatchCandidates(git: Git): Promise<PatchCandidate[]> {
  const cfg = vscode.workspace.getConfiguration('gitsight.stashTrash');
  const exportDirRaw = cfg.get<string>('patchExportDir', '');
  const exportDir = exportDirRaw ? path.resolve(git.cwd, exportDirRaw) : git.cwd;
  const list: PatchCandidate[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(exportDir);
  } catch {
    return list;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.patch')) continue;
    const abs = path.join(exportDir, entry);
    try {
      const body = await fs.readFile(abs, 'utf8');
      const info = inspectPatchPayload(body, entry);
      list.push({ filename: abs, info });
    } catch {
      // Skip unreadable.
    }
  }
  return sortPatchCandidates(list);
}

interface PickResult {
  filename: string;
  info: PatchPayloadInfo;
}

async function pickCandidate(_git: Git, candidates: PatchCandidate[]): Promise<PickResult | undefined> {
  type Pk = vscode.QuickPickItem & { _candidate?: PatchCandidate; _browse?: true };
  const items: Pk[] = [];
  if (candidates.length > 0) {
    items.push({ label: 'Discovered patches', kind: vscode.QuickPickItemKind.Separator } as any);
    for (const c of candidates) {
      items.push({
        label: `$(file-binary) ${buildPatchPickerLabel(c.filename, c.info)}`,
        description: path.basename(c.filename),
        detail: buildPatchPickerDetail(c.info),
        _candidate: c,
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
  }
  items.push({
    label: '$(folder-opened) Browse for a .patch file\u2026',
    description: 'open the OS file picker',
    _browse: true,
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: candidates.length > 0
      ? `${candidates.length} patch file${candidates.length === 1 ? '' : 's'} discovered \u00b7 pick one or browse`
      : 'No patches discovered \u00b7 browse for a file',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  if (picked._browse) {
    return await browseAndLoad();
  }
  if (picked._candidate) {
    return { filename: picked._candidate.filename, info: picked._candidate.info };
  }
  return undefined;
}

async function browseAndLoad(): Promise<PickResult | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
    title: 'Pick a patch file',
  });
  if (!uris || !uris.length) return undefined;
  const filename = uris[0].fsPath;
  try {
    const body = await fs.readFile(filename, 'utf8');
    const info = inspectPatchPayload(body, filename);
    return { filename, info };
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: could not read patch: ${e?.message ?? e}`);
    return undefined;
  }
}

async function confirmApply(pick: PickResult, info: PatchPayloadInfo): Promise<boolean> {
  const base = path.basename(pick.filename);
  const lines = [
    `File: ${base}`,
    info.fileCount > 0 ? `Files in patch: ${info.fileCount}` : '',
    info.hasBinary ? 'Contains binary files - 3-way merge may not apply cleanly' : '',
    info.gitsightMeta?.sourceBranch ? `Source branch: ${info.gitsightMeta.sourceBranch}` : '',
    info.gitsightMeta?.subject ? `Subject: ${info.gitsightMeta.subject}` : '',
  ].filter(Boolean);
  const detail = lines.join('\n');
  const ans = await vscode.window.showWarningMessage(
    `GitSight: apply patch \`${base}\` to the working tree?`,
    { modal: true, detail },
    'Apply (--3way)',
  );
  return ans === 'Apply (--3way)';
}

async function runGitApply(git: Git, filename: string): Promise<ApplyClassification> {
  try {
    const { stdout, stderr } = await pexec('git', ['apply', '--3way', filename], {
      cwd: git.cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return classifyApplyResult({ exitCode: 0, stderr: `${stdout}\n${stderr}` });
  } catch (e: any) {
    const exitCode = typeof e?.code === 'number' ? e.code : 1;
    const stderr = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}\n${e?.message ?? ''}`;
    return classifyApplyResult({ exitCode, stderr });
  }
}

async function reportOutcome(_git: Git, pick: PickResult, result: ApplyClassification): Promise<void> {
  const base = path.basename(pick.filename);
  switch (result.outcome) {
    case 'applied': {
      vscode.window.setStatusBarMessage(`GitSight: applied ${base} cleanly`, 5000);
      break;
    }
    case 'already-applied': {
      vscode.window.showInformationMessage(`GitSight: ${base} is already applied to the working tree.`);
      break;
    }
    case 'applied-with-conflicts': {
      await offerConflictCoach(pick, result);
      break;
    }
    case 'rejected': {
      await reportRejected(pick, result);
      break;
    }
    case 'failed': {
      await vscode.window.showErrorMessage(
        `GitSight: git apply failed: ${result.reason}`,
        'Copy reason',
      ).then(c => {
        if (c === 'Copy reason') vscode.env.clipboard.writeText(result.reason);
      });
      break;
    }
  }
}

async function offerConflictCoach(pick: PickResult, result: ApplyClassification): Promise<void> {
  const base = path.basename(pick.filename);
  const fileList = result.conflictedFiles.length > 0
    ? `\n\nConflicted files:\n  - ${result.conflictedFiles.slice(0, 8).join('\n  - ')}${result.conflictedFiles.length > 8 ? `\n  - +${result.conflictedFiles.length - 8} more` : ''}`
    : '';
  const choice = await vscode.window.showWarningMessage(
    `GitSight: applied ${base} with conflicts in ${result.conflictedFiles.length} file${result.conflictedFiles.length === 1 ? '' : 's'}.${fileList}`,
    { modal: true },
    'Open conflict coach',
    'Open first conflicted file',
  );
  if (!choice) return;
  if (choice === 'Open first conflicted file' && result.conflictedFiles[0]) {
    await openConflictedFile(result.conflictedFiles[0]);
    return;
  }
  if (choice === 'Open conflict coach') {
    if (result.conflictedFiles[0]) {
      await openConflictedFile(result.conflictedFiles[0]);
    }
    await vscode.commands.executeCommand('gitsight.conflictCoach');
  }
}

async function openConflictedFile(relOrAbs: string): Promise<void> {
  try {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : (wsRoot ? path.join(wsRoot, relOrAbs) : relOrAbs);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc);
  } catch {
    // Best-effort - user might still want the coach even if file open fails.
  }
}

async function reportRejected(pick: PickResult, result: ApplyClassification): Promise<void> {
  const base = path.basename(pick.filename);
  const choice = await vscode.window.showErrorMessage(
    `GitSight: ${base} was rejected: ${result.reason}`,
    'Copy patch body',
    'Open patch in editor',
  );
  if (!choice) return;
  if (choice === 'Copy patch body') {
    try {
      const body = await fs.readFile(pick.filename, 'utf8');
      await vscode.env.clipboard.writeText(body);
      vscode.window.setStatusBarMessage(`GitSight: copied ${base} body to clipboard`, 3000);
    } catch {/* ignore */}
  } else if (choice === 'Open patch in editor') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.filename));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }
}
