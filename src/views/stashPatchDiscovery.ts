/**
 * F133 - Stash Patch Auto-Discovery (companion to F131).
 *
 * Passive controller that watches the configured patch export directory
 * (defaulting to the workspace root) for new .patch / .diff files.
 * When one appears within the freshness window, surface a one-time
 * toast offering to apply it via the F131 import flow.
 *
 * Mirrors the same "watcher + session-only dismissal cache" pattern
 * used by F80 stash-on-switch and F70 submoduleAutoPull.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RepoManager } from '../git/repoManager';
import { inspectPatchPayload } from '../git/stashPatchImport';
import {
  classifyDiscoveredPatch,
  describeDiscoveryToast,
  looksLikePatchPath,
  buildDiscoveryDetail,
} from '../git/stashPatchDiscovery';

const RECENT_DEBOUNCE_MS = 1200;

export class StashPatchDiscoveryController implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];
  private dismissed = new Set<string>();
  private inflight = new Set<string>(); // de-dup overlapping toasts on the same path
  private cooldown = new Map<string, number>(); // path -> last-fire mtime
  private cfgDisposable: vscode.Disposable;
  private repoDisposable: vscode.Disposable;

  constructor(private repos: RepoManager) {
    this.rebuildWatchers();
    this.cfgDisposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gitsight.stashPatchDiscovery')
          || e.affectsConfiguration('gitsight.stashTrash.patchExportDir')) {
        this.rebuildWatchers();
      }
    });
    this.repoDisposable = repos.onDidChange(() => this.rebuildWatchers());
  }

  dispose() {
    this.disposeWatchers();
    this.cfgDisposable.dispose();
    this.repoDisposable.dispose();
  }

  private disposeWatchers() {
    for (const w of this.watchers) {
      try { w.dispose(); } catch { /* ignore */ }
    }
    this.watchers = [];
  }

  private rebuildWatchers() {
    this.disposeWatchers();
    const cfg = vscode.workspace.getConfiguration('gitsight.stashPatchDiscovery');
    if (!cfg.get<boolean>('enabled', true)) return;
    const git = this.repos.primary();
    if (!git) return;
    const stashCfg = vscode.workspace.getConfiguration('gitsight.stashTrash');
    const exportDirRaw = stashCfg.get<string>('patchExportDir', '');
    const exportDir = exportDirRaw ? path.resolve(git.cwd, exportDirRaw) : git.cwd;

    // Watch the export directory + the workspace root (in case the user
    // drops a patch directly in the project root rather than the config dir).
    const candidates = new Set<string>();
    candidates.add(exportDir);
    candidates.add(git.cwd);
    for (const dir of candidates) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(dir, '*.{patch,diff}'),
        );
        w.onDidCreate(uri => this.scheduleHandle(uri.fsPath));
        w.onDidChange(uri => this.scheduleHandle(uri.fsPath));
        this.watchers.push(w);
      } catch { /* ignore unwatchable dir */ }
    }
  }

  private scheduleHandle(absPath: string) {
    if (!looksLikePatchPath(absPath)) return;
    if (this.inflight.has(absPath)) return;
    this.inflight.add(absPath);
    setTimeout(() => {
      this.handle(absPath).catch(() => { /* swallow - passive */ })
        .finally(() => this.inflight.delete(absPath));
    }, RECENT_DEBOUNCE_MS);
  }

  private async handle(absPath: string) {
    let st;
    try { st = await fs.stat(absPath); } catch { return; }
    if (!st.isFile()) return;
    const cooldownAt = this.cooldown.get(absPath);
    if (cooldownAt && cooldownAt >= st.mtimeMs) return;
    let body: string;
    try { body = await fs.readFile(absPath, 'utf8'); }
    catch { return; }
    const filename = path.basename(absPath);
    const info = inspectPatchPayload(body, filename);
    const cfg = vscode.workspace.getConfiguration('gitsight.stashPatchDiscovery');
    const windowMin = cfg.get<number>('freshnessWindowMinutes', 60);

    const decision = classifyDiscoveredPatch({
      absPath,
      info,
      mtimeMs: st.mtimeMs,
      nowMs: Date.now(),
      dismissed: this.dismissed,
      freshnessWindowMinutes: windowMin,
    });
    if (decision.verdict !== 'offer' && decision.verdict !== 'silent-gitsight') return;

    this.cooldown.set(absPath, st.mtimeMs);

    const message = describeDiscoveryToast(filename, info, decision.verdict);
    const detail = buildDiscoveryDetail(info, st.size);
    const apply = 'Apply\u2026';
    const browse = 'Open file';
    const skip = 'Not now';
    const choice = await vscode.window.showInformationMessage(
      detail ? `${message}\n${detail}` : message,
      apply,
      browse,
      skip,
    );
    if (choice === skip || choice === undefined) {
      this.dismissed.add(absPath);
      return;
    }
    if (choice === browse) {
      try { await vscode.window.showTextDocument(vscode.Uri.file(absPath)); }
      catch { /* best-effort */ }
      return;
    }
    if (choice === apply) {
      // Route through the F131 command so all the conflict-coach plumbing fires.
      // Passing the path as the first arg lets the command pre-select it.
      try {
        await vscode.commands.executeCommand('gitsight.importStashPatch', { preselectPath: absPath });
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: could not start patch import - ${e?.message ?? e}`);
      }
    }
  }
}
