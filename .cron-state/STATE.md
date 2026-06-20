# GitSight Autoship State

**Branch**: `feature/autoship` (off `origin/main` — never merge, never PR)
**Identity**: Cake (cron) — `51058514+Sanjays2402@users.noreply.github.com`
**Quality gates**: `npm run lint` + `npm run compile` (both = `tsc -p ./ --noEmit` and `tsc -p ./`)
**No emoji in git/code chrome. Monochrome glyphs only.**

## Studied (1st tick, 2026-06-19)

- VS Code extension, TS, strict mode, no test runner installed.
- 19 source files across `git/`, `views/`, `webviews/`, `blame/`, `ai/`.
- `Git` class wraps `git` CLI via `execFile` with `raw()` escape hatch.
- `RepoManager` tracks repos + emits `onDidChange` on `.git/{HEAD,refs,...}` changes.
- 13 tree views + status-bar items (StatusBar, CommitSparkline, WorktreePill).
- AI via Copilot (`vscode.lm`). `ai/commitMessage.ts`, `ai/changelog.ts`, `ai/review.ts`.
- Host detection in `git/hostDetect.ts`: GitHub / Azure DevOps / GitLab / Bitbucket.
- `package.json` 866 lines, 70+ commands, three keybindings, configurable.

## Pattern notes (learned shipping ticks 1-3)

- Pure helpers belong in `src/git/<name>.ts`; UI/wiring goes in `src/views/`.
- Add every new pure helper to `tsconfig.test.json` `include` so tests compile.
- Tests live under `test/git/` with the same filename. Use `node:test`.
- New CodeLens providers should skip files handled by other lenses (avoid clash).
- `git check-ignore --stdin` is the only safe way to attribute huge `node_modules`.
- VS Code status-bar pills hide themselves when their config is off OR when
  there's nothing to show and `hideWhenClean`-style config is true.
- For diff-against-historic, use the existing `diffRevisions` helper from
  `src/git/virtualFs.ts` (`'WORKING'` sentinel as the right side) — don't roll a fresh URI scheme.
- For SCM input integration, poll the built-in git extension's `inputBox.value`
  on a 1.5s timer; the API has no change event and direct activation is rude.
- Status-bar tooltips render rich content when fed a `MarkdownString`; plain strings work too but lose formatting.

## ROADMAP (chronological, ≥15 fat slices)

### Tick 1 (2026-06-19 23:17 PT) — SHIPPED
- [x] **F1**: Branch Quick-Switcher (`Cmd+Shift+B`) — `dccdb02`
- [x] **F2**: AI-Generated PR Description — `dce7dfc`
- [x] **F3**: Open-on-Remote suite (repo/branch/file, multi-host) — `b9ab869`
- [x] **F4**: One-Click Sync + status-bar pill — `a62d979`
- [x] **F5**: `node:test` harness + 20 tests for `format` & `hostDetect` — `3cda082`

### Tick 2 (2026-06-20 04:11 PT) — SHIPPED
- [x] **F6**: Working-Tree status pill — `f59ee4b`
- [x] **F7**: Recent Files Touched view — `43bf023`
- [x] **F11**: Inline blame Hover provider — `82573ad`
- [x] **F15**: Gitignore Insight CodeLens — `2f2171f`
- [x] **F20**: Per-file commit count CodeLens — `8055e27`

### Tick 3 (2026-06-20 07:45 PT) — SHIPPED
- [x] **F8**: Show Authors of Range (leaderboard + per-author commits) — `b6efb5b`
- [x] **F9**: Branch Cleanup multi-select picker — `2862c74`
- [x] **F21**: Commit-Message linter (diagnostics + SCM pill) — `3a97b28`
- [x] **F17**: Restore File from any commit (view / diff / restore) — `f693121`
- [x] **F25**: Branch-age decoration (fresh/aging/stale/ancient) — `48e6362`

### Tick 4+
- [ ] F10: Smart Rebase Conflict Coach — detects rebase-in-progress and offers a quick-pick of next action (continue/skip/abort) with conflict file list.
- [ ] F12: AI "Explain Diff" for the current selection (not just commits) — uses `vscode.lm`.
- [ ] F13: Commit Detail Webview — open a commit in a rich webview with stats + per-file diff tabs.
- [ ] F14: Pre-Push Lint Hook bridge — registers a SCM input box validation that warns when the commit message starts with WIP/fixup (now partially overlaps with F21 — narrow F14 to a `git push`-time prompt that warns about WIP commits in the to-push range).
- [ ] F16: Tag Quick-Switcher / "Checkout Tag" with detached-HEAD safety prompt.
- [ ] F18: "Find Co-Authors" — analyzes Co-authored-by trailers across last N commits; suggests adding co-authors to the next commit.
- [ ] F19: SSH Key sanity check — at activation, detect "git push" auth failures and surface a one-click "Open ~/.ssh/config" or "Use GH CLI" prompt.
- [ ] F22: Per-author Sparkline status item — show commits-by-you over N days when `gitsight.sparkline.author` is `me`.
- [ ] F23: "Reveal in History" CodeAction on any selection — opens line history scoped to that range.
- [ ] F24: Worktree disk-usage report — pick a worktree, get a size breakdown (du under the worktree).

### Tick 4 candidates (drafted now so future ticks don't restart cold)
- [ ] F26: Branch comparison summary — pick two branches, get a one-line stat (commits ahead/behind, files changed, top contributors).
- [ ] F27: "Open in GitHub Codespaces" — for repos with a github.com remote, command + branch-tree action that crafts the Codespaces URL and launches it.
- [ ] F28: Lock-file change watcher — when `package-lock.json` / `pnpm-lock.yaml` / `Cargo.lock` lands in the working tree via pull, surface a notification with "Run install" actions per ecosystem.
- [ ] F29: Conventional Commit Quick-Insert — quick-pick of `feat / fix / chore / docs / refactor / perf / test / build / ci / style` with auto-scope from the file under SCM cursor.
- [ ] F30: Last-shown-tag pill — status-bar item showing the most recent tag and its age; click to open release notes or copy.

## TICK LOG

- 2026-06-19 23:17 PT — 5 features shipped: F1 `dccdb02`, F2 `dce7dfc`, F3 `b9ab869`, F4 `a62d979`, F5 `3cda082`. Gate: lint ok, compile ok, 20/20 tests green. Bootstrap commit: `c684b0b`.
- 2026-06-20 04:11 PT — 5 features shipped: F6 `f59ee4b`, F7 `43bf023`, F11 `82573ad`, F15 `2f2171f`, F20 `8055e27`. Gate: lint ok, compile ok (56s), 50/50 tests green. 30 new tests added (workingTreeStatus, recentFiles, coAuthors, gitignoreInsight, fileStats — 6 each). New configs: 11. New files: 15.
- 2026-06-20 07:45 PT — 5 features shipped: F8 `b6efb5b`, F9 `2862c74`, F21 `3a97b28`, F17 `f693121`, F25 `48e6362`. Gate: lint ok, compile ok (<1s, warm cache), 85/85 tests green. 35 new tests added (rangeAuthors 6, branchCleanup 6, commitLint 9, restorePick 6, branchAge 8). New configs: 13 (commitLint 10, branchAge 3). New files: 14.
