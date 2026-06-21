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

## Pattern notes (learned shipping ticks 1-4)

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
- Rebase state lives in `.git/rebase-merge/` (`-i` / `--merge` style) or
  `.git/rebase-apply/` (classic / `am`). Read with `fs/promises`; `rev-parse --git-dir`
  gives the absolute path even when a worktree's git dir is detached.
- `git rev-list --left-right --count base...head` returns "behind <TAB> ahead"
  (left = base, right = head). Don't transpose.
- `git checkout --detach <tag>` is the explicit form for tag inspection — plain
  `checkout <tag>` works but may silently create a local branch if a refname
  collides. Prefer the explicit form when the user picked a tag.
- For "write to commit message" features, gracefully degrade to clipboard when
  the built-in git extension isn't loaded/active.
- `git reflog` output is newest-first; when writing test fixtures for reflog
  parsers, put the newest timestamp FIRST or your tests will assert the
  reverse order and waste 10 minutes debugging.
- For "open on remote" features, host detection via `remoteWebUrl(url)` returns
  the bare repo base; layer host-specific paths on top (`/releases/tag/X`,
  `/compare/A...B`, `/-/tags/X`) using `base.includes('github.com')` checks.
- For autosquash from code, the magic incantation is
  `GIT_SEQUENCE_EDITOR=':' GIT_EDITOR=':' git rebase -i --autosquash <base>` —
  the `:` editor is the no-op, so `--autosquash` arranges the plan and we
  accept it as-is. Surface a modal warning before kicking it off; rebase
  is destructive and the user needs to know.
- For large `git rev-list --objects --all` outputs, use Node's `spawn` with
  `child.stdin.write()` + `.end()` rather than `execFile` — the rev-list
  output can be > 10MB on a real repo and you don't want to bump into
  exec arg-length limits when piping into `cat-file --batch-check`.
- For the "I just pulled and lockfiles changed" detection, compare
  `git diff --name-only HEAD@{1}..HEAD` rather than reading `git status`.
  HEAD@{1}..HEAD catches the pull/merge/rebase/checkout case (changes the
  user *received*) while status catches user-typed edits too (noise).
  Use a debounce + cooldown so a multi-step rebase fires one toast.
- CodeActionProviders with `providedCodeActionKinds: [Refactor]` show in
  the lightbulb without polluting quick-fix. The `provideCodeActions`
  callback should be cheap (it runs on every selection change) — only
  decide *whether* to offer the action, defer the actual work to the
  command the action invokes.

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

### Tick 4 (2026-06-20 12:04 PT) — SHIPPED
- [x] **F10**: Smart Rebase Conflict Coach (pill + quick-pick next-action) — `17a4436`
- [x] **F16**: Tag Quick-Switcher (semver-sorted, detached-HEAD safe) — `1f7212a`
- [x] **F18**: Find Co-Authors (mine recent commits, append trailers to SCM box) — `777fe9c`
- [x] **F26**: Branch Compare Summary (one-line ahead/behind/files/contrib) — `ef7fb6c`
- [x] **F29**: Conventional Commit Quick-Insert (type + auto-scope + breaking) — `d31638b`

### Tick 5 (2026-06-20 18:53 PT) — SHIPPED
- [x] **F31**: Stash Quick-Switcher (Cmd+Shift+J + pop/apply/show/drop) — `ac2a166`
- [x] **F34**: Conflict Marker Linter (diagnostics + jump-next/prev) — `e54387a`
- [x] **F32**: Recent Branches MRU (reflog mining + previous-branch jump) — `5771cfc`
- [x] **F30**: Last-Shown-Tag pill (status bar + tag action menu) — `d93c3b6`
- [x] **F33**: What Will Push? (pending-range picker with copy/compare/changelog) — `2c3b2ad`

### Tick 6 (2026-06-20 21:47 PT) — SHIPPED
- [x] **F37**: WIP Commit Hunter (find WIP/fixup!/squash!/amend! + one-click autosquash) — `342c685`
- [x] **F40**: Repo Size + Biggest Files Report (rev-list | cat-file ranking + filter-repo expunge command) — `5522362`
- [x] **F38**: Open Last Pushed Branch (reflog mining + host-aware tree/compare/PR URLs) — `7aea8ff`
- [x] **F28**: Lockfile Change Watcher (HEAD@{1}..HEAD diff → install-command toast, 12 ecosystems) — `8d3a834`
- [x] **F23**: Show History for Selection (CodeAction + `git log -L<a>,<b>:<file>` markdown report) — `1e96978`

### Tick 7+
- [ ] F12: AI "Explain Diff" for the current selection (not just commits) — uses `vscode.lm`.
- [ ] F13: Commit Detail Webview — open a commit in a rich webview with stats + per-file diff tabs.
- [ ] F14: Pre-Push Lint Hook bridge — a `git push`-time prompt that warns about WIP commits in the to-push range.
- [ ] F19: SSH Key sanity check — at activation, detect "git push" auth failures and surface a one-click "Open ~/.ssh/config" or "Use GH CLI" prompt.
- [ ] F22: Per-author Sparkline status item — **ALREADY COVERED** by `gitsight.sparkline.author=me` config on the existing CommitSparkline. Removed from roadmap.
- [ ] F24: Worktree disk-usage report — pick a worktree, get a size breakdown (du under the worktree).
- [ ] F27: "Open in GitHub Codespaces" — for repos with a github.com remote, command + branch-tree action that crafts the Codespaces URL and launches it.
- [ ] F35: GitHub Default-Reviewers picker — when opening a PR, parse `.github/CODEOWNERS` and pre-fill reviewers from the changed files.

### Tick 6 candidates (drafted now so future ticks don't restart cold)
- [x] F36: Branch divergence visualiser — when a checkout lands you behind a remote, surface a compact "you're N commits behind, top contributor is X" toast with a one-click rebase.
- [x] F37: WIP commit hunter — DONE tick 6 — see above.
- [x] F38: "Open last pushed PR" — DONE tick 6 — see above.
- [x] F39: Forgotten-file diagnostic — when committing, flag any file that's been edited in the last 7 days but is staged-clean now (likely an oversight).
- [x] F40: Repo size + biggest-files report — DONE tick 6 — see above.

### Tick 7 candidates (drafted now so future ticks don't restart cold)
- [ ] F36 (carry-over): Branch divergence visualiser on checkout — toast with "N commits behind, top contributor is X, [Rebase]".
- [ ] F39 (carry-over): Forgotten-file diagnostic — flag files edited in the last 7d but not staged when committing.
- [ ] F41: Commit-by-commit Test Runner — for `<upstream>..HEAD`, optionally checkout each, run `npm test` (or configured cmd), report which commit broke things.
- [ ] F42: `.gitattributes` Diagnostics — surface attributes that conflict with detected file content (e.g. `text` for a binary, missing `eol=lf` for LF-only repos).
- [ ] F43: Stash Naming Helper — when running `git stash`, suggest a name from the WIP area's filenames/branch (`auth-refactor-WIP`), exposed via the existing Stash Quick-Switcher's stashSave action.
- [ ] F44: "Compare working tree to any commit" — quick-pick commit, get a multi-file diff against the working tree (uses the existing diffRevisions helper).

## TICK LOG

- 2026-06-19 23:17 PT — 5 features shipped: F1 `dccdb02`, F2 `dce7dfc`, F3 `b9ab869`, F4 `a62d979`, F5 `3cda082`. Gate: lint ok, compile ok, 20/20 tests green. Bootstrap commit: `c684b0b`.
- 2026-06-20 04:11 PT — 5 features shipped: F6 `f59ee4b`, F7 `43bf023`, F11 `82573ad`, F15 `2f2171f`, F20 `8055e27`. Gate: lint ok, compile ok (56s), 50/50 tests green. 30 new tests added (workingTreeStatus, recentFiles, coAuthors, gitignoreInsight, fileStats — 6 each). New configs: 11. New files: 15.
- 2026-06-20 07:45 PT — 5 features shipped: F8 `b6efb5b`, F9 `2862c74`, F21 `3a97b28`, F17 `f693121`, F25 `48e6362`. Gate: lint ok, compile ok (<1s, warm cache), 85/85 tests green. 35 new tests added (rangeAuthors 6, branchCleanup 6, commitLint 9, restorePick 6, branchAge 8). New configs: 13 (commitLint 10, branchAge 3). New files: 14.
- 2026-06-20 12:04 PT — 5 features shipped: F10 `17a4436`, F16 `1f7212a`, F18 `777fe9c`, F26 `ef7fb6c`, F29 `d31638b`. Gate: lint ok, compile ok (<1s, warm cache), 140/140 tests green. 55 new tests added (rebaseState 10, tagSort 9, coAuthorSuggest 9, branchCompare 9, conventionalCommit 18). New configs: 3 (rebaseCoach.enabled, coAuthors.scanCommits, coAuthors.selfEmails). New commands: 5 (rebaseCoach + refreshRebaseCoach, tagQuickSwitcher, findCoAuthors, branchCompareSummary, conventionalCommitInsert). New files: 15 (5 pure helpers + 5 view controllers + 5 test files).
- 2026-06-20 18:53 PT — 5 features shipped: F31 `ac2a166`, F34 `e54387a`, F32 `5771cfc`, F30 `d93c3b6`, F33 `2c3b2ad`. Gate: lint ok, compile ok (1.1s), 191/191 tests green. 51 new tests added (stashSort 10, conflictMarkers 12, recentBranches 8, latestTag 11, pendingPush 10). New configs: 6 (conflictMarker.enabled, conflictMarker.showPill, recentBranches.reflogWindow, recentBranches.showLimit, lastTagPill.enabled, lastTagPill.preferStable). New commands: 8 (stashQuickSwitcher, conflictMarker.jumpNext/Prev/rescan, recentBranches, checkoutPreviousBranch, refreshLastTagPill, whatWillPush). New keybindings: 3 (Cmd+Shift+J for stash, Cmd+Alt+[/] for conflict jump). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). NOTE: F31 + F34 were committed mid-afternoon by a tick that crashed before the gate; this tick rescued them, ran the gate, and shipped 3 more on top to fill the batch.
- 2026-06-20 21:47 PT — 5 features shipped: F37 `342c685`, F40 `5522362`, F38 `7aea8ff`, F28 `8d3a834`, F23 `1e96978`. Gate: lint ok, compile ok (0.9s), 251/251 tests green. 60 new tests added (wipCommits 15, repoSize 10, lastPushedBranch 11, lockfileWatch 11, selectionHistory 13). New configs: 1 (lockfileWatch.enabled). New commands: 5 (wipHunter, repoSizeReport, openLastPushedBranch, showSelectionHistory; LockfileWatcher registers no commands — it's a passive watcher). New providers: 1 CodeActionProvider (Refactor-kind on every file in a git repo). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Also pruned F22 from roadmap (already covered by existing sparkline.author=me config) and drafted 4 fresh Tick-7 candidates so we never restart cold.

