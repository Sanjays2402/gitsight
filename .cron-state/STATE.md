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
- For passive watchers that compare HEAD@{prev}..HEAD@{now} (lockfile,
  submodule auto-pull), use `git diff --raw -z` rather than `--name-only`
  when you need the mode bits. The raw format includes `<src-mode>
  <dst-mode>` per record, which is the only way to distinguish a
  gitlink (`160000`) change from a normal file edit. NUL-separated
  output also avoids the "path with newlines" parsing failure that
  bites name-only.
- For rename rows in `--raw -z`, advance the tokeniser past BOTH path
  tokens (src AND dst), not one. Same trap as parseNameStatusZ from
  tick 10 — if you only consume one, the next record's header gets
  treated as the rename's dest path and the row after gets shifted.
- For status-bar pills that depend on an external CLI (`gh`, `ssh`),
  silently hide when the CLI isn't on PATH rather than surfacing an
  error toast every poll cycle. Hostile UX otherwise — the user
  knows they don't have `gh` installed; the pill just being invisible
  is a fine signal.
- For full-reflog parsers vs the checkout-only F32 parser, classify
  amend commits BEFORE plain commits — `commit (amend):` would
  otherwise match `^commit:?` and lose its kind. Same shape lesson
  as cherryPickScout's trailer-before-subject ordering.
- For the reflog reset summary, the raw action is `reset: moving to
  HEAD~3` — the obvious format string `reset to ${m[1]}` yields
  "reset to moving to HEAD~3" (redundant "to"). Strip the optional
  `moving to ` prefix inside the regex so the summary reads
  naturally regardless of what git's wording was.
- For pure-helper unit tests that fall back to a field via `??`, make
  sure the fallback handles falsy strings too: `s.branch ?? undefined`
  preserves empty strings, but `(s.branch || undefined)` collapses
  them. The detached-HEAD stash subject parses to `sourceBranch =
  undefined`, but `s.branch` defaults to `''` in the porcelain output
  — the test caught the wrong fallback. Always normalise to undefined
  for the "absent" semantic.
- For CodeAction providers that show on every file (F23 selection
  history, F66 last-touched), DO NOT shell out from
  `provideCodeActions` — that callback runs on every selection change
  and would explode on a hot key-bash. Decide *whether* to offer the
  action (cheap path check + repo lookup is fine) and defer the actual
  mining to the command the action invokes.
- For commands invoked from multiple surfaces (CodeAction + Recent
  Files tree-item menu + command palette), accept the raw `any` arg
  and route through a tiny `normaliseArg` helper that handles the
  `{file: '/abs/path'}`, the `{kind, entry: {path}, git}` tree shape,
  the bare URI shape, and the bare string. Saves a stack of overloads
  and makes the command keyboard-friendly too.
- For rename-aware file-history walks, the `--name-status` output for
  a rename is `R<percent>\t<old>\t<new>` — when the user asked about
  `<new>`, we still want to return the commit + record `renamedFrom`
  so the picker can show the old name. The renamedFrom value drives
  the diff URI choice: standard diff uses same-path-both-sides; rename
  diff has to construct gitsight:// + file:// URIs manually because
  diffRevisions aligns paths.
- For the gh branch protection API, an exit-code non-zero with stderr
  matching `/branch\s+not\s+protected/i` is the canonical "unprotected"
  signal — NOT a 404 alone (a 404 might mean wrong repo, missing scope,
  or rate limit). Match the literal phrase. Fall back to "unknown" for
  any other failure so the user gets a chance to override rather than
  having the guard silently allow a destructive push.
- For trailer-block append logic, the git interpret-trailers
  convention is: blank line between body and the first trailer;
  subsequent trailers append directly to an existing trailer block
  with NO blank line. Detect the existing trailer block by checking
  whether the last non-empty line of the message starts with any
  registered trailer key (case-insensitive). Mirrors how
  `git interpret-trailers --in-place` writes its output.
- For BREAKING CHANGE dedup, do NOT lowercase the value — two distinct
  notes with the same words-different-case ARE meant to land as two
  trailers (e.g. an editor pass that re-cased something). All other
  trailer kinds compare case-insensitively on value so the same
  Co-authored-by email isn't doubled.
- For `gh pr list --search "review-requested:@me"`, the search query
  can append `draft:false` to exclude drafts at the API level rather
  than client-side. Cheaper round-trip and the result count matches
  the user's expectation. Wrap the whole search expression in one
  `--search` arg, not multiple — gh treats them as additive but the
  shape is uglier.
- For `gh pr checkout` integration, ALWAYS guard against the
  workspace's origin not matching the PR's repo. The command will
  happily land PR #42 from `other/repo` in a clone of `foo/bar` and
  the user won't notice until tests fail. Single modal warning with
  an "Open in browser instead?" fallback is the right shape.
- For repository-shape parsing across gh JSON variants, `repository`
  can be `{name, owner: {login}}` (current) or a plain `'owner/name'`
  string (older). Tolerate both in one extractor — production gh
  versions in the wild span 6+ months of breaking JSON-shape changes
  and the picker shouldn't crash on a stale install.
- For multi-file `git diff --cached -U0` parsers, RESET the per-hunk
  `+`-side line counter when you see `diff --git a/... b/...` —
  otherwise file2's marker at the file's line 5 gets reported at
  "file1's last hunkLine + 5". Same trap as parseNameStatusZ from
  tick 10. The hunk header `@@ -X,Y +A,B @@` initialises hunkLine
  to A; bump only on `+` rows (in `-U0` mode there are no context
  rows to skip).
- For "managed block" round-trip rewrites (PR body sync, commit
  trailers, scaffolds), use a marker pair (`<!-- GITSIGHT:... -->`)
  to bound the block. On rewrite, splice between the open and close
  markers and leave everything outside untouched byte-for-byte. If
  the block already exists, normalise the whitespace adjacent to
  the markers so repeated syncs don't drift toward a wall of blank
  lines. Compare-for-changes should mask the timestamp line so a
  cosmetic clock advance doesn't trigger a no-op `gh pr edit` call.
- For colour-input sanitisers in SVG/HTML output, allow-list
  `#hex(3|4|6|8)`, `rgb(...)`, `rgba(...)` and a tiny set of named
  colours (`white|black|transparent|none`). Reject anything else
  and demote to the default. Stops a hostile config from splicing
  `javascript:` or `expression(eval(...))` into a fill attribute.
- For FileDecorationProvider performance, never scan the whole
  repo on `register()`. VS Code calls `provideFileDecoration` lazily
  for visible explorer rows only; cache per `${absPath}@${mtime}`
  and fire `onDidChangeFileDecorations(uri)` from inside the lazy
  load so the explorer re-paints once the badge becomes available.
  Drop the cache on `RepoManager.onDidChange` so a `git pull`
  refreshes everyone's badges.
- For "scientific notation" in test regex assertions, JavaScript
  `Number.prototype.toString` emits `e[+-]?\d+` form for very small
  or very large values. A regex like `/^hsl\(0(\.\d+)?, ...` will
  flake on time-based tests where the input is `Date.now() - now`
  and the clock is fast enough that the delta rounds to single-
  digit microseconds. Always permit an optional `(?:e[+-]?\d+)?`
  suffix on the fractional part.
- For webview-export features, structure the renderer to return
  `{ html, exportData }` rather than just `html`. The export
  command can then re-emit the same SVG fragments the webview is
  showing without re-running the lane-assignment / graph-layout
  pass. Cache the exportData on the panel object so click \u2192
  message \u2192 file-write works without a second `git log` call.
- For "after a successful checkout" hooks (F80 stash-on-switch),
  always fire-and-forget — never throw, never block. The checkout
  ALREADY succeeded; an error in the follow-up surface (network
  hiccup loading stashes, etc.) shouldn't surface as a modal that
  would make the user think the switch failed. Session-only
  dismissal caches keyed by NORMALISED branch name (strip
  `origin/` / `refs/heads/`, lower-case) so a per-tick dismissal
  doesn't accidentally re-prompt when the user types the same
  branch differently next time.
- For "manual regenerate that might clobber typed input" UX (F84),
  build a drift classifier (`untouched` / `extended` / `replaced`)
  on top of a remembered scaffold string. `untouched` skips the
  confirm because the user hasn't typed anything yet; `extended`
  and `replaced` go through a modal preview showing the
  before -> after transition. The trailing-whitespace tolerance
  (`replace(/\s+$/, '')` on both sides) catches editors that
  append a newline on focus loss — a common source of false
  "extended" verdicts.
- For semver-bump comparisons across a discriminated union
  (`'major' | 'minor' | 'patch' | 'none'`), use a numeric rank
  table (`{none:0, patch:1, minor:2, major:3}`) instead of
  chained `&& !== 'major' && !== 'minor'` conditionals. The
  chained form trips TypeScript's narrowing analysis and emits
  TS2367 ("comparison appears unintentional"); the rank table
  is also cleaner to extend when a new bump kind lands.
- For "no previous tag" seed semantics (F86 suggestNextTag),
  emit `v0.0.1` for patch and `v0.1.0` for minor OR major. The
  0.x semver convention treats majors-within-0.x as minor
  bumps; the user can manually pick v1.0.0 when they want to
  declare API stability. Don't try to be clever and pre-bump.
- For language fence tags in markdown output (F87), GitHub's
  markdown renderer accepts a small allow-list but tolerates
  unknown tags by ignoring them. Common VS Code language ids
  that DON'T match GitHub conventions: typescriptreact (use
  `tsx`), javascriptreact (use `jsx`), plaintext (use ''). For
  anything else, strip non-alphanumerics and lowercase — guards
  against weird custom-grammar ids like `csv (custom)` that
  would otherwise break the fence parser.
- For large-context truncation in AI prompts, head + tail with
  an explicit `// ...N lines omitted...` marker beats a simple
  head-only truncate. The model uses the surrounding context as
  orientation; cutting only the head loses the "what comes
  after" signal that often disambiguates the meaning of a
  function. Split the budget 50/50 between head and tail.
- For `git bisect run` script convention, the exit codes MATTER
  and are not the same as a normal shell command:
    0   = commit is GOOD (continue bisect)
    1   = commit is BAD (regression is here-or-before)
    125 = commit is UNTESTABLE (skip; install failure, missing
          dep, etc.) — bisect will skip and continue
  Treating an install failure as exit 1 (BAD) would falsely
  attribute the regression to a commit that just happened to
  have a broken `npm ci`. Always wrap the install step in an
  `|| exit 125`.
- For "infer a local command from a CI step name" (F76), use
  exact-match first for the most common step names ("Run tests",
  "Lint", "Build", "Type check") then substring fallbacks for
  ecosystem-specific patterns (`/\bjest\b/`, `/\bpytest\b/`,
  `/\bcargo\b/`). Always return a `confident: boolean` so the
  preview can warn the user when the result is a placeholder
  — a confident-looking command that doesn't exist locally
  would silently `exit 127` and bisect every commit as BAD.

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

### Tick 12 (2026-06-21 16:41 PT) — SHIPPED
- [x] **F67**: Stash Trash Bin (age + branch-survival classifier, multi-pick + drop-from-highest-index-down) — `0771104`
- [x] **F68**: Reflog Explorer (full reflog picker w/ kind classifier + filter chips + reset/diff/copy menu) — `faa805f`
- [x] **F69**: Pre-Push Commit-Message Gate (runs `lintCommitMessage` against `<upstream>..HEAD` range, configurable severity floor) — `770e3ea`
- [x] **F70**: Submodule Auto-Pull Watcher (passive watcher on ref moves, parses `git diff --raw -z` for mode-160000 gitlink changes) — `fafd5b2`
- [x] **F62**: GitHub Actions Run Pill (status-bar pill, gh CLI + workflow file pre-filter, click → rerun/logs/cancel/open) — `658706d`

### Tick 12 candidates (RESOLVED above)
- [x] F62: GitHub Actions run watcher — DONE tick 12.
- [x] F67: Stash Trash Bin — DONE tick 12.
- [x] F68: Reflog Explorer — DONE tick 12.
- [x] F69: Pre-push commit-message gate — DONE tick 12.
- [x] F70: Submodule auto-pull — DONE tick 12.

### Tick 13 (2026-06-21 19:43 PT) — SHIPPED
- [x] **F66**: Open at Last Touched Commit (CodeAction + Recent Files menu, rename-aware, picker → open/diff/show) — `c4cf10b`
- [x] **F71**: Force-Push Protection Guard (gh branch protection API probe, modal refusal + confirmation, lease/no-lease variants) — `1a6ac23`
- [x] **F73**: Commit Footer Composer (multi-pick of Co-authored-by/Reviewed-by/Signed-off-by/Closes/Fixes/Refs/BREAKING, validated values, dedup) — `b6a383d`
- [x] **F74**: GitHub Releases Companion (gh release list picker, notes preview, copy-tag, create-from-latest-unreleased-tag) — `fc5f560`
- [x] **F75**: PR Review-Request Inbox (gh pr list review-requested:@me, urgency-sorted, open/copy/checkout with same-repo guard) — `7b50fed`

### Tick 13 candidates (RESOLVED above)
- [x] F66: Recent-File CodeAction `Open at last touched commit` — DONE tick 13.
- [x] F71: Branch protection guard for force-push — DONE tick 13.
- [x] F73: Conventional Commit footer composer — DONE tick 13.
- [x] F74: `gh release` companion — DONE tick 13.
- [x] F75: PR review-request inbox — DONE tick 13.

### Tick 14 (2026-06-21 22:47 PT) — SHIPPED
- [x] **F77**: PR Draft Auto-Sync — post-push, rewrite open draft PR body from `<base>..HEAD` via `gh pr edit --body-file` inside `<!-- GITSIGHT:PR-DRAFT-SYNC -->` marker block — `69106b0`
- [x] **F78**: Staged Conflict Marker Gate — pill + Problems diagnostics + picker for `<<<<<<<` markers in staged `+` hunks, with `Unstage all flagged` escape — `3bb3772`
- [x] **F80**: Stash-on-Branch-Switch — after checkout, toast offering Apply newest / Pick from list / Dismiss for stashes made on the destination branch — `988f5ff`
- [x] **F81**: Recent Contributors Decoration — FileDecorationProvider puts a unique-contributor count badge on every tracked file with markdown tooltip listing them + a `show recent contributors` picker — `87015ff`
- [x] **F61**: Commit Graph SVG Export — `Export SVG` button on CommitGraphPanel writes standalone self-contained SVG to workspace root with timestamped filename, opens cleanly in browsers/Figma — `625e906`

### Tick 14 candidates (drafted now so future ticks don't restart cold) — RESOLVED
- [x] F61: Branch-graph PNG/SVG export — DONE tick 14 (shipped as SVG which is the more useful vector output for designers; PNG can be a follow-up if needed).
- [x] F77: PR draft auto-sync — DONE tick 14.
- [x] F78: Conflict marker pre-stage gate — DONE tick 14.
- [x] F80: Stash-on-branch-switch picker — DONE tick 14.
- [x] F81: Recent contributors hover — DONE tick 14 (shipped as FileDecorationProvider badge + tooltip rather than a HoverProvider — VS Code's FileDecorationProvider is the right surface for "explorer hover-like" data and avoids conflicting with the per-line F11 blameHover).

### Tick 15 (2026-06-22 02:02 PT) — SHIPPED
- [x] **F84**: SCM input box `Regenerate from staged` button — manual force-rebuild of conventional-commit header on the SCM-title bar, with drift classifier (untouched / extended / replaced) gating a modal preview before clobbering user input — `e7b5596`
- [x] **F85**: Reviewer round-robin — within each CODEOWNERS coverage tier, re-rank suggestions by recent request load (`gh pr list --search reviewRequests,latestReviews`) so least-loaded handles float to the top; degrades to plain coverage when gh missing — `3ad487b`
- [x] **F86**: Tag-on-merge prompt — classify range bump from conventional-commit prefixes + BREAKING CHANGE trailers (major/minor/patch/none), suggest next semver tag preserving v-prefix, build grouped release notes (Breaking → Features → Fixes → Performance → Other + Contributors), preview-then-create annotated tag with optional push — `1b30d23`
- [x] **F87**: PR description from selection (AI) — micro-PR description scoped to the editor's current selection, with +/-30 line context window, language-aware fenced block, sanity-gated (`empty`/`too-small`/`too-large`), suggests a PR title from recentSubject or verb-heuristic — `f68f552`
- [x] **F76**: Bisect from CI failure — picks first failing job/step from `gh run view --json`, heuristically infers local recovery command (npm test / lint / build / tsc / cargo / go / pytest), generates `git bisect run` wrapper with install-failure -> 125 skip, opens preview + drops user into a terminal preloaded with `git bisect start/run/reset` — `adcfc0e`

### Tick 15 candidates (RESOLVED above)
- [ ] F53: Commit-Detail Webview (F13 carry-over, multi-tick) — CARRIED TO TICK 16.
- [ ] F72: Worktree-graph webview — CARRIED TO TICK 16.
- [x] F76: Bisect script from CI failure — DONE tick 15.
- [ ] F79: Local-branch GitHub Pages preview — CARRIED TO TICK 16.
- [ ] F82: Per-commit benchmark scorer — CARRIED TO TICK 16.
- [ ] F83: Commit graph PNG export — CARRIED TO TICK 16.
- [x] F84: SCM input box "regenerate from staged" — DONE tick 15.
- [x] F85: Reviewer round-robin — DONE tick 15.
- [x] F86: Tag-on-merge prompt — DONE tick 15.
- [x] F87: PR description from selection — DONE tick 15.

### Tick 16 candidates (drafted now so future ticks don't restart cold)
- [ ] F53: Commit-Detail Webview (multi-tick carry-over) — rich webview with header/stats/per-file-diff tabs + per-file blame links. The existing showCommitDetail dumps a flat diff into a scratch buffer; this is the polish counterpart that matches CommitGraphPanel + StashVisualizer.
- [ ] F72: Worktree-graph webview — visualise all worktrees as a tree with their HEAD shas, branch attachments, and dirty status. Pairs with F64 pruner.
- [ ] F79: Local-branch GitHub Pages preview — for branches that have changed `docs/` or `_site/`, generate the local preview URL that gh-pages would serve (or run `python -m http.server` in `_site/`).
- [ ] F82: Per-commit benchmark scorer — for `<upstream>..HEAD`, run a configured benchmark command per commit and chart the result. Extends F55 with quantitative output.
- [ ] F83: Commit graph PNG export — companion to F61 SVG export. Inside the webview, rasterise the standalone SVG via canvas drawImage + toBlob('image/png') and write through the same message-pipe.
- [ ] F88: PR comments inbox — `gh pr view <num> --json comments,reviewComments` picker that opens each comment at the right file:line in the editor. Pairs with F75 review-request inbox.
- [ ] F89: `gh secret` audit pill — status-bar pill that warns when the repo references secrets that aren't actually set on the GitHub side (parse workflows for `${{ secrets.X }}` and check against `gh secret list`).
- [ ] F90: SCM diff size heuristic — diagnostic on the SCM input box when the staged diff exceeds N lines/files (`diffStat threshold`) suggesting the user split the commit. Pairs with F60 scaffold + F84 regenerate.
- [ ] F91: Reviewer round-robin LITE for non-CODEOWNERS repos (F85 extension) — when no CODEOWNERS file is present, fall back to the top-N committers from `git shortlog -sne --no-merges` over the changed files, with the same round-robin re-rank applied.
- [ ] F92: Tag-on-merge auto-push prompt (F86 extension) — when the user picks `Create + push`, optionally chain into `gh release create <tag> --notes-file -` for a one-shot release flow.

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
- 2026-06-21 16:41 PT — 5 features shipped: F67 `0771104`, F68 `faa805f`, F69 `770e3ea`, F70 `fafd5b2`, F62 `658706d`. Gate: lint ok, compile ok, 795/795 tests green (716 → 795, +79 new). New configs: 13 (stashTrash.{staleAfterDays,ancientAfterDays,extraLiveBranches}, reflogExplorer.{windowSize,defaultFilter}, prePushMessageGate.{enabled,blockAt,options}, submoduleAutoPull.{enabled,cooldownMinutes}, actionsPill.{enabled,refreshSeconds,hideOnSuccess}). New commands: 4 (stashTrashBin, reflogExplorer, refreshActionsPill; F69 hooks into existing gitsight.push, F70 is a passive watcher). New menus: 1 (stashes.stashTrashBin). New status-bar pills: 1 (ActionsPill at priority 90 — sits just left of the F59 SubmodulePill at 92). New files: 15 (5 pure helpers + 5 view controllers + 5 test files).
- 2026-06-21 19:43 PT — 5 features shipped: F66 `c4cf10b`, F71 `1a6ac23`, F73 `b6a383d`, F74 `fc5f560`, F75 `7b50fed`. Gate: lint ok, compile ok, 873/873 tests green (795 → 873, +78 new). New configs: 6 (openAtLastTouched.scanCommits, forcePushGuard.enabled, releasesCompanion.listLimit, prReviewInbox.{scope,listLimit,includeDrafts}). New commands: 7 (openAtLastTouchedCommit, forcePush, forcePushDangerous, checkBranchProtection, commitFooterComposer, releasesCompanion, prReviewInbox). New menus: 1 (recentFiles.openAtLastTouchedCommit). New providers: 1 CodeAction (Refactor-kind for "Open at last touched commit", scoped to non-binary files inside git repos). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Notable patterns added: (1) gh-api JSON classifier with 404-as-unprotected fallback (forcePushGuard); (2) committed-trailer-block detection with case-insensitive dedup on name-email but case-sensitive on BREAKING CHANGE (commitFooter); (3) urgency-state ordering with drafts-always-last + within-state recency tiebreak (prReviewInbox); (4) rename-aware "last touched" walker that returns the rename's destination commit + renamedFrom hint (openAtLastTouched); (5) same-repo guard before `gh pr checkout` so we never land PR #X from `other/repo` in a clone of `foo/bar`.
- 2026-06-21 22:47 PT — 5 features shipped: F77 `69106b0`, F78 `3bb3772`, F80 `988f5ff`, F81 `87015ff`, F61 `625e906`. Gate: lint ok, compile ok, 940/940 tests green across 10 consecutive runs (873 → 940, +67 new). Also caught + fixed a pre-existing flake: `heatmapColor` test regex didn't accept scientific-notation hues like `6.97e-9`, which `new Date()` + fast clocks occasionally produce; widened the regex to allow `e[+-]?\d+` suffixes (`93cbc54`). New configs: 12 (prDraftSync.{enabled,maxCommits,maxFiles,baseRef}, stagedConflictGate.{enabled,severity}, stashOnSwitch.{enabled,freshDays,agingDays}, recentContributors.{enabled,scanCommits,maxInTooltip}, graphExport.directory). New commands: 4 (stagedConflictGate.show, stagedConflictGate.rescan, recentContributors.show; F77 + F80 are passive hooks into push + checkout). New providers: 1 FileDecorationProvider (recentContributors, scoped to non-binary tracked files). New webview message types: 1 (`exportSvg` in commitGraph). New files: 15 (5 pure helpers + 5 view controllers + 5 test files). Notable patterns added: (1) marker-bracketed managed body block with timestamp-ignored diff so we don't make no-op `gh pr edit` calls (prDraftSync); (2) `git diff --cached -U0` parser that only flags markers on the `+` side so resolution commits stay silent (stagedConflictGate); (3) per-hunk hunkLine reset across files so a second file's marker doesn't inherit the first file's line offset (stagedConflictGate); (4) session-only dismissal cache keyed by normalised branch name so the same toast doesn't re-appear on the next checkout (stashOnSwitch); (5) FileDecorationProvider with per-file-mtime cache that lets VS Code lazily request decorations only for currently-visible explorer rows (recentContributors); (6) standalone SVG with allow-listed colour sanitiser that rejects `javascript:` / `expression()` inputs and demotes them to defaults (commitGraphExport); (7) renderGraph now returns `{ html, exportData }` so the export command can re-emit the same row SVG fragments the webview is showing without re-running the lane-assignment pass.

CAUGHT MID-TICK: 4 tests failed on first gate run (cherryPickScout: subject-exact matched empty='' vs empty=''; commitScaffold: composeScaffoldHeader returned `docs(docs): ` instead of `docs: ` when type==scope; same for `ci(ci): `; worktreePruner test expected upstreamGone=1 but classifier correctly counts both reasons when one entry has missing-on-disk AND upstream-gone). Fixed via 2 source fixes (subject-exact gated on truthy source.subject; composeScaffoldHeader drops redundant scope when scope==type) + 1 test expectation correction. All three landed as `--fixup` commits and were autosquashed into their parents before push, so each feature commit stays self-passing.

POLICY UPDATE this tick: stopped using `feature/autoship` — commits on that branch never showed on Sanjay's GitHub contribution graph. The wrapper now gates on `main` directly and trusts the end-of-tick lint+compile gate to keep the line green. The 5 features above were committed straight to main, gated together, then pushed once.

CAUGHT MID-TICK: 4 tests failed on first run (parseGitHubRemote ssh://port shape lost to SCP regex; tailLines split count off-by-one on trailing newline; classifyAuthFailure repo-not-found shadowed by connection-closed pattern; parseNameStatusZ truncated rename pushed an empty-string path). Fixed via 4 targeted `--fixup` commits + autosquash so each feature commit stays self-passing — never shipped a red commit. New SHAs in the log above reflect post-rebase state.

- 2026-06-22 02:02 PT — 5 features shipped: F84 `e7b5596`, F85 `3ad487b`, F86 `1b30d23`, F87 `f68f552`, F76 `adcfc0e`. Gate: lint ok, compile ok, 1056/1056 tests green (940 → 1056, +116 new). New configs: 2 (defaultReviewers.{roundRobin, roundRobinWindow}). New commands: 5 (commitScaffold.regenerate, tagFromMerged, prDescriptionFromSelection, bisectFromCi, plus the existing scaffold.apply unchanged). New menus: 2 (scm/title.commitScaffold.regenerate via $(refresh); editor/context.prDescriptionFromSelection gated on editorHasSelection). New files: 9 (3 fresh pure helpers + 3 view controllers + 3 test files; F84 + F85 extended existing modules in place rather than creating new ones). Notable patterns added: (1) drift classifier (untouched / extended / replaced) that lets a manual regenerate know when to ask vs. when to silently overwrite — same idea as F60's lastWrittenScaffold but flipped from "skip" to "confirm" semantics; (2) coverage-tier preserving load-rerank in F85 — high-coverage owners NEVER demote below low-coverage even when their load is huge, ensuring CODEOWNERS coverage stays the primary signal; (3) semver bump rank table in F86 (`{none:0, patch:1, minor:2, major:3}`) avoids the trap of "minor && best !== 'major'" comparisons triggering TS2367 narrowing errors when SemverBump unions tighten; (4) suggestNextTag seeds with v0.0.1 (patch) or v0.1.0 (minor/major) when no prior tag exists, respecting the 0.x semver convention that majors-within-0.x are expressed as minor bumps; (5) language fence-tag normaliser (typescriptreact→tsx, javascriptreact→jsx, plaintext→'', else strip non-alphanumerics + lowercase); (6) selection-context truncator with head + tail + omitted-lines marker so a 500-line context block doesn't blow the prompt budget; (7) `inferLocalCommand` exact-match + substring fallback with confidence flag so the bisect preview can warn the user when the inferred command is just a placeholder; (8) `git bisect run` script convention: exit 125 (UNTESTABLE) on install failure, 0 (good) on recovery success, 1 (bad) on failure — matches `git bisect run`'s contract exactly.

