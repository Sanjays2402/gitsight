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

## ROADMAP (chronological, ≥15 fat slices)

### Tick 1 (this) — picked
- [ ] **F1**: Branch Quick-Switcher (`Cmd+Shift+B`) — keyboard-first switcher with ahead/behind, last commit, fuzzy, recents (Memento), and inline create.
- [ ] **F2**: AI-Generated PR Description — `gitsight.generatePullRequestDescription` produces a markdown PR body from commits between current branch and the merge-base with default branch (auto-detected).
- [ ] **F3**: Open-on-Remote suite — `openRepoOnRemote`, `openBranchOnRemote`, `openFileOnRemote` (active file at HEAD, line-range anchored). Editor/title + editor/context menus.
- [ ] **F4**: One-Click Sync (`gitsight.sync`) — fetch + pull (ff-only or rebase) + push, with a dedicated status-bar pill showing unpushed↑/unpulled↓ + click-to-sync. Progress notification with per-step reporting.
- [ ] **F5**: Test Harness + Unit Tests — `node:test` (built-in, zero deps), `tsconfig.test.json`, `npm test` script, tests for `git/format.ts` and `git/hostDetect.ts`.

### Tick 2+
- [ ] F6: Working-Tree status pill (`gitsight.workingTree.enabled`) with click → SCM view; staged/unstaged/untracked counts.
- [ ] F7: Recent Files Touched view — sidebar of files modified in last N commits with click-to-open.
- [ ] F8: "Show Authors of Range" — pick two refs, get a contributor leaderboard scoped to that range.
- [ ] F9: Branch Cleanup — delete merged branches in batch with a multi-select quick-pick.
- [ ] F10: Smart Rebase Conflict Coach — detects rebase-in-progress and offers a quick-pick of next action (continue/skip/abort) with conflict file list.
- [ ] F11: Inline Hover for blame — `HoverProvider` showing commit subject + co-authors + a "View Commit" action.
- [ ] F12: AI "Explain Diff" for the current selection (not just commits) — uses `vscode.lm`.
- [ ] F13: Commit Detail Webview — open a commit in a rich webview with stats + per-file diff tabs.
- [ ] F14: Pre-Push Lint Hook bridge — registers a SCM input box validation that warns when the commit message starts with WIP/fixup.
- [ ] F15: Gitignore Insight CodeLens — at top of a `.gitignore`, show how many files in the workspace are currently ignored by that file.
- [ ] F16: Tag Quick-Switcher / "Checkout Tag" with detached-HEAD safety prompt.
- [ ] F17: Reset / Restore File from any commit — quick-pick of revs scoped to file.
- [ ] F18: "Find Co-Authors" — analyzes Co-authored-by trailers across last N commits; suggests adding co-authors to the next commit.
- [ ] F19: SSH Key sanity check — at activation, detect "git push" auth failures and surface a one-click "Open ~/.ssh/config" or "Use GH CLI" prompt.
- [ ] F20: Per-file commit count CodeLens (top of file) — "**42** commits over **18mo**" with click-to-history.

## TICK LOG

(empty — first tick in progress)
