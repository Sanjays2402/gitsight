# GitSight Autoship State

**Branch**: `main` (commit straight to main, push every tick — quality gate protects the line)
**Identity**: Cake (cron) — `51058514+Sanjays2402@users.noreply.github.com`
**Quality gates**: `npm run lint` + `npm run compile` (both = `tsc -p ./ --noEmit` and `tsc -p ./`)
**No emoji in git/code chrome. Monochrome glyphs only.**
**Policy change (tick 10, 2026-06-21)**: stopped using `feature/autoship` — commits on feature branches never show on the GitHub contribution graph. The wrapper now gates on `main` and we trust the end-of-tick gate.

## Studied (1st tick, 2026-06-19)

- VS Code extension, TS, strict mode, no test runner installed.
- 19 source files across `git/`, `views/`, `webviews/`, `blame/`, `ai/`.
- `Git` class wraps `git` CLI via `execFile` with `raw()` escape hatch.
- `RepoManager` tracks repos + emits `onDidChange` on `.git/{HEAD,refs,...}` changes.
- 13 tree views + status-bar items (StatusBar, CommitSparkline, WorktreePill).
- AI via Copilot (`vscode.lm`). `ai/commitMessage.ts`, `ai/changelog.ts`, `ai/review.ts`.
- Host detection in `git/hostDetect.ts`: GitHub / Azure DevOps / GitLab / Bitbucket.
- `package.json` 866 lines, 70+ commands, three keybindings, configurable.

## Pattern notes (learned shipping ticks 1-7)

- Pure helpers belong in `src/git/<name>.ts`; UI/wiring goes in `src/views/`.
- Add every new pure helper to `tsconfig.test.json` `include` so tests compile.
- Tests live under `test/git/` with the same filename. Use `node:test`.
- New CodeLens providers should skip files handled by other lenses (avoid clash).
- `git check-ignore --stdin` is the only safe way to attribute huge `node_modules`.
- `git check-attr --stdin -z --all` is the equivalent for attribute lookups —
  feed a NUL-separated path list, parse a NUL-separated `path attr value`
  triple stream. Drop entries whose every attr is `unspecified` to skip the
  big "no opinion" middle.
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
- For "branch divergence" checks on checkout, use
  `git rev-list --left-right --count <upstream>...<head>` with upstream on
  the LEFT — that way left=behind, right=ahead. The picker order
  `<base>...<head>` is the project convention; don't transpose. Pair it
  with `git shortlog -sne --no-merges <branch>..<upstream>` to surface
  who's been pushing to the diverged side (useful for "ping X for
  conflict context" before rebasing).
- For "files the user edited recently" detection, restrict the
  `git log --since=Nd --name-only` to `--author=<self-email>` — shared
  worktrees and bot commits otherwise create false positives.
- For "things I forgot to stage" UX, gate the surface on the SCM input
  box having text. Outside of commit-composing, the pill is just noise.
  2s polling matches the existing commitLint cadence.
- For attribute-vs-content checks, an 8 KB head sniff is enough for the
  text/binary/eol heuristics — bigger reads are wasted I/O and risk
  triggering the OS file-cache eviction on monorepos.
- For "smart stash name" derivation, the right shape is
  `<branch-fragment>-<common-dir>-wip` for 3+ files, fallback to single-
  file basename for 1-2 files, and bare branch-only when paths span the
  repo. Always end in `-wip` so the names are trivially greppable later
  in the reflog.
- For "compare working tree to <sha>" picker UX, sit the global actions
  (Open full diff, Open report) above a `Files` separator with per-file
  rows below. Users want either "show me everything" or "let me drill
  into the one file I care about" — separating them with a label removes
  the "what do these top items mean?" pause.
- For HTML inside vscode `MarkdownString`, supportHtml ONLY permits a
  small allow-list (span, basic formatting) — even then the renderer
  strips event handlers + scripts. Still, escape author-controlled
  strings before injection so `</span>` injection can't break the
  styling context on a malicious commit author name.
- For checkout-error classification, anchor the regex on the
  distinctive sentence ("Your local changes to the following files
  would be overwritten by checkout"). The same sentence appears for
  switch/merge/rebase verbs — accept all of them. Don't try to be
  clever and parse the file list with `\s+` — git emits `\t` and a
  one-leading-space-per-line indent that varies by version; just
  strip leading whitespace per line.
- For "pre-push lint" patch scanning, fetch with
  `git show -U0 --format=` to get a zero-context diff — saves ~10x I/O
  on real-world ranges and conflict markers (which are line-anchored)
  still surface 1:1. Skip the fetch entirely on commits already flagged
  as WIP-shape — they're going to be flagged regardless.
- For the worktree disk-usage walk, an iterative DFS with a per-frame
  `{topLevelName, topLevelFullPath}` lets you attribute size to the
  *initial* top-level bucket regardless of depth. Don't recurse into
  Promise.all on directory contents — it explodes parallelism on a
  monorepo and the OS just round-robins anyway. One file/dir at a
  time, sequentially, hits the same throughput with bounded RAM.
- For CODEOWNERS-based reviewer suggestions, normalise owner tokens
  into user|team|email|invalid first — `gh pr edit --add-reviewer` only
  accepts handles and team slugs (`org/team`), not email addresses, so
  emails get silently dropped. Team handles are kept in the picker
  because GitHub expands them server-side; the user can untick if they
  prefer individual notifications.
- For SCM scaffold features, write the header verbatim into the input
  box and REMEMBER the exact string. Only rescaffold when staging
  changes AND the input still equals that remembered string — the
  moment the user types past the prefix, leave the box alone forever.
  This matches how lint-staged etc. avoid stomping the user.
- For "redundant scope" detection in conventional-commit headers,
  collapse `docs(docs): ` and `ci(ci): ` to the short form when scope
  equals type case-insensitively. The auto-detector returns scope='docs'
  for docs-only changes, but the scope tag is just noise when it
  duplicates the type already.
- For rerere cache walking, resolve the cache dir via
  `git rev-parse --git-path rr-cache` rather than hardcoding
  `.git/rr-cache` — linked worktrees have a detached gitdir and
  `.git/` may be a file pointing elsewhere. Same trick as `rebaseState`.
- For rerere safety, gate all filesystem deletions on
  `/^[0-9a-f]{40}$/.test(name)` — a malformed entry name slipping
  through the picker would otherwise let an attacker target
  `.git/rr-cache/../` paths via crafted listings. Cheap defence,
  rules out an entire class of mishaps.
- For worktree upstream-gone detection, intersect with
  `refs/remotes/<remote>/<name>` refs rather than the local
  `branch.upstream` config. A fresh clone has the remote ref but no
  tracking config yet — relying on config alone would mark every
  branch as upstream-gone after a clone.
- For worktree age, prefer `.git/index` mtime over the working dir
  mtime. The index is bumped on every `git add`/checkout so it tracks
  actual git activity; the workdir gets touched by editors, builds,
  and OS metadata reads which all create false "recent activity".
- For dirty-worktree detection ahead of a batch prune, instantiate
  a `Git(worktreePath)` per worktree and run `status --porcelain` in
  its own cwd. The top-level git wrapper would otherwise report the
  parent worktree's state for every entry.
- For cherry-pick double-pick detection, the strongest cross-team
  signal is subject collision after a tight normaliser. The
  `(cherry picked from commit X)` trailer is only present when
  someone passed `-x`, which most workflows don't. The normaliser
  must strip Conventional-Commit headers + `(#PR)` suffix + leading
  `[backport]` tags + trailing period + lowercase — anything less
  misses the "reword on merge" case that GitHub's squash-merge UI
  creates on every PR.
- For pre-action scout warnings, ALWAYS gate "exact subject match"
  on a truthy source subject. `'' === ''` is a useless verdict that
  fires on every commit with an empty header (rare but happens with
  amend-no-edit + empty title). Same trap as the empty-string
  rangeAuthors bug from tick 6.

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

### Tick 7 (2026-06-21 00:25 PT) — SHIPPED
- [x] **F36**: Branch Divergence Visualiser (on-checkout toast w/ top contributors + Rebase/Merge) — `ea02d89`
- [x] **F39**: Forgotten-File Diagnostic (status-bar pill + Stage-all picker while composing commit) — `117f269`
- [x] **F44**: Compare Working Tree to Any Commit (commit picker → per-file diff editor) — `fe41818`
- [x] **F43**: Smart Stash Save (branch + dirty-paths → suggested kebab name w/ picker) — `270e61e`
- [x] **F42**: .gitattributes Diagnostics (check-attr × content sniff for text/binary/eol mismatches) — `a1c0416`

### Tick 8 (2026-06-21 03:55 PT) — SHIPPED
- [x] **F46**: Blame Hover Author-Age Tint (yellow / orange / red tint on author by commit age) — `ab89b4a`
- [x] **F14**: Pre-Push Lint Hook (scan to-push range for WIP/fixup/conflict markers + missing-issue regex) — `fccaf03`
- [x] **F47**: "Files I own" Picker (CODEOWNERS + shortlog dominance fusion ranking) — `bb4e228`
- [x] **F48**: Auto-Stash Before Checkout (classify error, smart-name stash, retry, offer re-apply) — `899a1e5`
- [x] **F24**: Worktree Disk-Usage Report (iterative DFS walk, top-level + largest-files breakdown) — `e0b216b`

### Tick 9 (2026-06-21 06:49 PT) — SHIPPED
- [x] **F45**: Pre-Commit Hook Bridge (run `.git/hooks/pre-commit`, classify output by runner, picker w/ open-at-line + bypass + disable) — `67f48ff`
- [x] **F49**: Rebase Plan Preview (autosquash plan builder w/ peel-chained fixups, orphan demotion, side-by-side MD preview, confirm-before-run) — `7c371c7`
- [x] **F50**: Fixture-Author CodeLens (path classifier for __snapshots__/__fixtures__/testdata/cassettes + .snap/.golden/.expected, last-3-authors lens at line 1) — `b3adf03`
- [x] **F51**: Advanced Commit Search (live QuickPick w/ author:/path:/since:/re:/case:/max: query syntax, debounced + abortable, per-row buttons) — `ade84c9`
- [x] **F52**: Branch Staleness Pruner (multi-select picker for merged stale branches, hard-protected names, includeUnmerged toggle, `-d`/`-D` swap) — `40b385d`

### Tick 8+
- [ ] F12: AI "Explain Diff" for the current selection (not just commits) — uses `vscode.lm`.
- [ ] F13: Commit Detail Webview — open a commit in a rich webview with stats + per-file diff tabs.
- [ ] F19: SSH Key sanity check — at activation, detect "git push" auth failures and surface a one-click "Open ~/.ssh/config" or "Use GH CLI" prompt.
- [ ] F22: Per-author Sparkline status item — **ALREADY COVERED** by `gitsight.sparkline.author=me` config on the existing CommitSparkline. Removed from roadmap.
- [ ] F27: "Open in GitHub Codespaces" — for repos with a github.com remote, command + branch-tree action that crafts the Codespaces URL and launches it.
- [ ] F35: GitHub Default-Reviewers picker — when opening a PR, parse `.github/CODEOWNERS` and pre-fill reviewers from the changed files.
- [ ] F41: Commit-by-commit Test Runner — for `<upstream>..HEAD`, optionally checkout each, run `npm test` (or configured cmd), report which commit broke things.
- [x] F46: Blame Hover author-age tint — DONE tick 8.
- [x] F47: "Files I own" picker — DONE tick 8.
- [x] F48: Auto-stash before checkout — DONE tick 8.

### Tick 8 candidates (drafted now so future ticks don't restart cold) — RESOLVED
- [ ] F45: Pre-commit hook bridge — detect `.git/hooks/pre-commit` failures and surface a friendly diff of which rule fired, with a "skip with --no-verify" escape hatch. CARRIED TO TICK 9.
- [x] F46: Blame Hover author age tint — DONE tick 8.
- [x] F47: "Files I own" picker — DONE tick 8.
- [x] F48: Auto-stash before checkout — DONE tick 8.

### Tick 9 candidates (drafted now so future ticks don't restart cold) — RESOLVED
- [x] F45: Pre-commit hook bridge — DONE tick 9 — see above.
- [x] F49: Rebase plan preview — DONE tick 9 — see above.
- [x] F50: "Who touched this fixture?" CodeLens — DONE tick 9 — see above.
- [x] F51: Commit search webview — DONE tick 9 (shipped as QuickPick rather than full webview; richer search needed an interactive input, picker matches existing GitSight design language).
- [x] F52: Branch staleness pruner — DONE tick 9 — see above.

### Tick 10 candidates (drafted now so future ticks don't restart cold) — RESOLVED
- [x] F53: Commit-Detail Webview (F13 carry-over) — CARRIED TO TICK 11 (still pending).
- [x] F54: SSH Key Sanity Check (F19 carry-over) — DONE tick 10 — see above.
- [x] F55: Commit-by-Commit Test Runner (F41 carry-over) — DONE tick 10 — see above.
- [x] F56: Open in GitHub Codespaces (F27) — DONE tick 10 — see above.
- [x] F57: GitHub Default-Reviewers Picker (F35) — CARRIED TO TICK 11.
- [x] F58: Stash Diff Browser — DONE tick 10 — see above.
- [x] F59: Submodule status pill — DONE tick 10 — see above.

### Tick 10 (2026-06-21 09:54 PT) — SHIPPED
- [x] **F54**: SSH Key Sanity Check (classifier + recovery picker on push/fetch/pull failures) — `bfa7a08`
- [x] **F56**: Open in GitHub Codespaces (URL builder + auto-devcontainer detection + branch context-menu) — `539d1ce`
- [x] **F58**: Stash Diff Browser (NUL-delimited parser + per-file picker with native diff editors) — `83bdbf7`
- [x] **F59**: Submodule status pill (status-bar pill + init/update menu) — `1326570`
- [x] **F55**: Commit-by-Commit Test Runner (detached-HEAD walker with save+restore + bisect candidate report) — `2412c1c`

### Tick 11 (2026-06-21 13:08 PT) — SHIPPED
- [x] **F57**: Default-Reviewers Picker (CODEOWNERS → ranked suggestions → gh pr edit --add-reviewer) — `60e34b5`
- [x] **F60**: SCM Commit-Message Scaffold (passive controller writes conventional header to empty input box from staged paths) — `a3d0056`
- [x] **F63**: rerere Cache Visualizer (status classifier + per-entry forget + clear-all w/ modal confirm) — `0ee2d1b`
- [x] **F64**: Worktree Pruner (missing-on-disk + upstream-gone classifier, dirty detection, batched remove/prune) — `c58f9de`
- [x] **F65**: Cherry-Pick Scout (trailer/subject/normalised match scanner, wraps cherryPick with modal warning) — `9b2c5ab`

### Tick 12 candidates (drafted now so future ticks don't restart cold)
- [ ] F53: Commit-Detail Webview (F13 carry-over, multi-tick) — open a commit in a rich webview with header/stats/per-file-diff tabs and per-file blame links. The existing showCommitDetail dumps a flat diff into a scratch buffer; this is the polish counterpart that matches CommitGraphPanel + StashVisualizer.
- [ ] F61: Branch-graph PNG export (F61 carry-over) — for the existing CommitGraphPanel, add an "Export as PNG" toolbar button (canvas2img via the webview, drop the file into the workspace root with a timestamped filename).
- [ ] F62: GitHub Actions run watcher — for repos with a github.com remote + .github/workflows, surface a status-bar pill showing the latest run state for the current branch (`gh run list -L 1 --branch <branch>`), click to open the run page.
- [ ] F66: Recent-File CodeAction `Open at last touched commit` — for files in `gitsight.recentFiles` view, a CodeAction in the editor that opens the file at its last-touch sha so you can diff-vs-now in two clicks.
- [ ] F67: Stash Trash Bin — long-lived stashes (>90d) listed in a picker w/ "drop selected" multi-pick, mirrors the F52/F64 staleness shape.
- [ ] F68: Reflog Explorer — a flat scrollable picker of the last N reflog entries with shortcuts to checkout / show diff / cherry-pick. The existing recentBranches scope only surfaces checkout events; this one covers the full reflog including resets and rebases.
- [ ] F69: Pre-push commit-message gate — run the existing commit-message linter against the to-push range and refuse the push when any commit violates (configurable severity).
- [ ] F70: Submodule auto-pull — when the parent repo's pull lands a gitlink change, prompt `git submodule update --init` for the changed submodules. Mirrors the F28 lockfile-change watcher shape.

## TICK LOG

- 2026-06-19 23:17 PT — 5 features shipped: F1 `dccdb02`, F2 `dce7dfc`, F3 `b9ab869`, F4 `a62d979`, F5 `3cda082`. Gate: lint ok, compile ok, 20/20 tests green. Bootstrap commit: `c684b0b`.
- 2026-06-20 04:11 PT — 5 features shipped: F6 `f59ee4b`, F7 `43bf023`, F11 `82573ad`, F15 `2f2171f`, F20 `8055e27`. Gate: lint ok, compile ok (56s), 50/50 tests green. 30 new tests added (workingTreeStatus, recentFiles, coAuthors, gitignoreInsight, fileStats — 6 each). New configs: 11. New files: 15.
- 2026-06-20 07:45 PT — 5 features shipped: F8 `b6efb5b`, F9 `2862c74`, F21 `3a97b28`, F17 `f693121`, F25 `48e6362`. Gate: lint ok, compile ok (<1s, warm cache), 85/85 tests green. 35 new tests added (rangeAuthors 6, branchCleanup 6, commitLint 9, restorePick 6, branchAge 8). New configs: 13 (commitLint 10, branchAge 3). New files: 14.
- 2026-06-20 12:04 PT — 5 features shipped: F10 `17a4436`, F16 `1f7212a`, F18 `777fe9c`, F26 `ef7fb6c`, F29 `d31638b`. Gate: lint ok, compile ok (<1s, warm cache), 140/140 tests green. 55 new tests added (rebaseState 10, tagSort 9, coAuthorSuggest 9, branchCompare 9, conventionalCommit 18). New configs: 3 (rebaseCoach.enabled, coAuthors.scanCommits, coAuthors.selfEmails). New commands: 5 (rebaseCoach + refreshRebaseCoach, tagQuickSwitcher, findCoAuthors, branchCompareSummary, conventionalCommitInsert). New files: 15 (5 pure helpers + 5 view controllers + 5 test files).
- 2026-06-20 18:53 PT — 5 features shipped: F31 `ac2a166`, F34 `e54387a`, F32 `5771cfc`, F30 `d93c3b6`, F33 `2c3b2ad`. Gate: lint ok, compile ok (1.1s), 191/191 tests green. 51 new tests added (stashSort 10, conflictMarkers 12, recentBranches 8, latestTag 11, pendingPush 10). New configs: 6 (conflictMarker.enabled, conflictMarker.showPill, recentBranches.reflogWindow, recentBranches.showLimit, lastTagPill.enabled, lastTagPill.preferStable). New commands: 8 (stashQuickSwitcher, conflictMarker.jumpNext/Prev/rescan, recentBranches, checkoutPreviousBranch, refreshLastTagPill, whatWillPush). New keybindings: 3 (Cmd+Shift+J for stash, Cmd+Alt+[/] for conflict jump). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). NOTE: F31 + F34 were committed mid-afternoon by a tick that crashed before the gate; this tick rescued them, ran the gate, and shipped 3 more on top to fill the batch.
- 2026-06-20 21:47 PT — 5 features shipped: F37 `342c685`, F40 `5522362`, F38 `7aea8ff`, F28 `8d3a834`, F23 `1e96978`. Gate: lint ok, compile ok (0.9s), 251/251 tests green. 60 new tests added (wipCommits 15, repoSize 10, lastPushedBranch 11, lockfileWatch 11, selectionHistory 13). New configs: 1 (lockfileWatch.enabled). New commands: 5 (wipHunter, repoSizeReport, openLastPushedBranch, showSelectionHistory; LockfileWatcher registers no commands — it's a passive watcher). New providers: 1 CodeActionProvider (Refactor-kind on every file in a git repo). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Also pruned F22 from roadmap (already covered by existing sparkline.author=me config) and drafted 4 fresh Tick-7 candidates so we never restart cold.
- 2026-06-21 00:25 PT — 5 features shipped: F36 `ea02d89`, F39 `117f269`, F44 `fe41818`, F43 `270e61e`, F42 `a1c0416`. Gate: lint ok, compile ok, 320/320 tests green (251 → 320, +69 new). New configs: 4 (branchDivergence.enabled, forgottenFiles.enabled, forgottenFiles.days, forgottenFiles.includeClean). New commands: 6 (compareWorkingTreeToCommit, stashSaveSmart, stashSuggestNames, forgottenFiles.show, forgottenFiles.rescan, gitattributesDiagnostics). New providers: 0 (BranchDivergenceWatcher + ForgottenFilesController are passive watchers). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Also drafted Tick-8 candidates (F45 pre-commit hook bridge, F46 hover-author-age tint, F47 "files I own" picker, F48 auto-stash before checkout) and absorbed F41 forward as the only Tick-7 carry-over.
- 2026-06-21 03:55 PT — 5 features shipped: F46 `ab89b4a`, F14 `fccaf03`, F47 `bb4e228`, F48 `899a1e5`, F24 `e0b216b`. Gate: lint ok, compile ok, 395/395 tests green (320 → 395, +75 new). New configs: 16 (blameHover.authorTint*, prePushLint.*, filesIOwn.*, autoStash.*, worktreeDu.*). New commands: 3 (filesIOwn, worktreeDiskUsage; F14 + F48 hook into existing commands gitsight.push and gitsight.checkoutBranch rather than register new). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). NOTE: F14 changes the user-visible behaviour of `gitsight.push` (added pre-push lint gate); F48 changes `gitsight.checkoutBranch` (auto-stash recovery). Both gracefully no-op when their `.enabled` config is false. New Tick-9 candidates drafted: F45 pre-commit bridge (carried over), F49 rebase plan preview, F50 fixture-author CodeLens, F51 commit search webview, F52 branch-age batch pruner.
- 2026-06-21 06:49 PT — 5 features shipped: F45 `67f48ff`, F49 `7c371c7`, F50 `b3adf03`, F51 `ade84c9`, F52 `40b385d`. Gate: lint ok, compile ok, 538/538 tests green (395 → 538, +143 new). New configs: 9 (preCommitBridge.enabled, fixtureLens.{enabled,maxCommits,topAuthors}, commitSearch.defaultMaxCount, branchPruner.{defaultBase,minAgeDays,includeUnmerged,protectedBranches}). New commands: 5 (preCommitBridge, rebasePlanPreview, searchCommitsAdvanced, branchStalenessPruner; F50 registers no command — it's a CodeLens provider). New providers: 1 CodeLens (FixtureLensProvider scoped to fixture/snapshot paths only). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Quality stat for the tick: largest test deltas were preCommitBridge (27) and fixtureLens (38) — both pure-classifier-heavy slices. Drafted Tick-10 candidates: F53 commit-detail webview (F13 carry-over), F54 SSH key sanity check (F19), F55 commit-by-commit test runner (F41), F56 Codespaces opener (F27), F57 default-reviewers picker (F35), F58 stash diff browser, F59 submodule status pill.
- 2026-06-21 09:54 PT — 5 features shipped: F54 `bfa7a08`, F56 `539d1ce`, F58 `83bdbf7`, F59 `1326570`, F55 `2412c1c`. Gate: lint ok, compile ok (warm cache), 629/629 tests green (538 → 629, +91 new). New configs: 12 (sshKeyCheck.{enabled,autoCheckOnActivate}, codespaces.{machine,location,devcontainerPath}, submodules.{enabled,hideWhenNone,recursive}, commitTestRunner.{command,timeoutMs,stopOnFirstFail,maxCommits}). New commands: 7 (checkSshKey, openInCodespaces, stashDiffBrowser, submoduleMenu, refreshSubmodules, commitTestRunner; F54 also wraps the existing push/fetch/pull commands with auth-failure recovery). New menus: 3 (branches.openInCodespaces, stashes.stashDiffBrowser, branch-context Codespaces action). New status-bar pills: 1 (SubmodulePill, position 92 between the working-tree pill at 94 and the worktree pill). New files: 15 (5 pure helpers + 5 view controllers + 5 test files).
- 2026-06-21 13:08 PT — 5 features shipped: F57 `60e34b5`, F60 `a3d0056`, F63 `0ee2d1b`, F64 `c58f9de`, F65 `9b2c5ab`. Gate: lint ok, compile ok, 716/716 tests green (629 → 716, +87 new). New configs: 16 (defaultReviewers.{fallbackBase,includeTeams,exclude}, commitScaffold.{enabled,maxPaths,minConfidence,scaffoldWithoutScope}, rerereCache.{staleAfterDays,maxEntries}, worktreePruner.{minAgeDays,includeStaleOnly,forceDirty}, cherryPickScout.{enabled,scanCommits,scanSince}). New commands: 5 (defaultReviewersPicker, commitScaffold.apply, rerereCacheVisualizer, worktreePruner; F65 wraps the existing cherryPick rather than registering new). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Notable patterns added: (1) auto-degradation when `gh` CLI isn't on PATH (F57 falls back to clipboard); (2) git-internal-dir resolution via `git rev-parse --git-path rr-cache` so the rerere visualizer works in linked worktrees too; (3) refs/remotes intersection for branchesWithUpstream (more reliable than local branch.upstream config on fresh clones); (4) subject normalisation that handles conventional-commit prefix + PR-merge suffix + backport tag in one pass.

CAUGHT MID-TICK: 4 tests failed on first gate run (cherryPickScout: subject-exact matched empty='' vs empty=''; commitScaffold: composeScaffoldHeader returned `docs(docs): ` instead of `docs: ` when type==scope; same for `ci(ci): `; worktreePruner test expected upstreamGone=1 but classifier correctly counts both reasons when one entry has missing-on-disk AND upstream-gone). Fixed via 2 source fixes (subject-exact gated on truthy source.subject; composeScaffoldHeader drops redundant scope when scope==type) + 1 test expectation correction. All three landed as `--fixup` commits and were autosquashed into their parents before push, so each feature commit stays self-passing.

POLICY UPDATE this tick: stopped using `feature/autoship` — commits on that branch never showed on Sanjay's GitHub contribution graph. The wrapper now gates on `main` directly and trusts the end-of-tick lint+compile gate to keep the line green. The 5 features above were committed straight to main, gated together, then pushed once.

CAUGHT MID-TICK: 4 tests failed on first run (parseGitHubRemote ssh://port shape lost to SCP regex; tailLines split count off-by-one on trailing newline; classifyAuthFailure repo-not-found shadowed by connection-closed pattern; parseNameStatusZ truncated rename pushed an empty-string path). Fixed via 4 targeted `--fixup` commits + autosquash so each feature commit stays self-passing — never shipped a red commit. New SHAs in the log above reflect post-rebase state.

