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

### Tick 16 candidates (drafted now so future ticks don't restart cold) — RESOLVED
- [ ] F53: Commit-Detail Webview (multi-tick carry-over) — CARRIED TO TICK 17. The existing showCommitDetail dumps a flat diff into a scratch buffer; this is the polish counterpart that matches CommitGraphPanel + StashVisualizer.
- [ ] F72: Worktree-graph webview — CARRIED TO TICK 17. Pairs with F64 pruner.
- [ ] F79: Local-branch GitHub Pages preview — CARRIED TO TICK 17. For branches that have changed `docs/` or `_site/`, generate the local preview URL that gh-pages would serve.
- [ ] F82: Per-commit benchmark scorer — CARRIED TO TICK 17. Extends F55 with quantitative output.
- [ ] F83: Commit graph PNG export — CARRIED TO TICK 17. Companion to F61 SVG export.
- [x] F88: PR comments inbox — DONE tick 16 — see above.
- [x] F89: gh secret audit pill — DONE tick 16 — see above.
- [x] F90: SCM diff size heuristic — DONE tick 16 — see above.
- [x] F91: Reviewer round-robin LITE (shortlog fallback) — DONE tick 16 — see above.
- [x] F92: Tag-on-merge auto-push to gh release — DONE tick 16 — see above.

### Tick 16 (2026-06-22 06:06 PT) — SHIPPED
- [x] **F88**: PR Comments Inbox (gh pr view --json comments,reviewComments,reviews picker that jumps to file:line; classified inline/issue/review-summary with $(comment)/$(pass)/$(verified)/$(issues) glyphs, unresolved-inline-first sort, defaults to current-branch PR or accepts explicit number from PrItem context menu) — `963f540`
- [x] **F89**: GitHub Secret Audit Pill (status-bar pill at priority 88 warning when `${{ secrets.X }}` references in `.github/workflows/*` don't have matching gh secret list entries; tolerates dot-access + quoted bracket + counts dynamic refs separately; click -> open-at-line + "gh secret set" terminal helper; GITHUB_TOKEN built-in + org-secret inclusion via gh api) — `a918174`
- [x] **F90**: SCM Diff Size Heuristic (4-tier classifier: ok/warning/noisy/huge; warns at 400+ lines OR 20+ files; escalates to red at 2000+ lines; detects 70%+ lockfile/generated dominance and suggests separating; style/chore/docs/ci/build types exempt from `warning` but not `huge`; pill at priority 87 + Information/Warning diagnostic on virtual gitsight-diffsize:// URI; click picker offers add -p / multi-unstage / numstat scratch buffer) — `062e439`
- [x] **F91**: Reviewer Shortlog Fallback (F57 extension; when no CODEOWNERS file present, fall back to top committers from `git log --since=Nd --pretty=%aE|%aN --name-only -- <changed paths>`; F85 round-robin re-rank composes on top; bot-identity filter via /\bbot\b/ + /noreply@/ patterns; identityToHandle plumbing for future gh api users lookup; perTier cap defaults to 5) — `a196de8`
- [x] **F92**: Tag-on-Merge -> gh release chain (F86 extension; 3rd "Create + push + release" action chains `gh release create <tag> --notes-file - --draft [--prerelease]` after the tag push; SemVer prerelease auto-detection for -alpha/-beta/-rc/-pre/-canary/-next/-nightly; isPrereleaseTag extracted as pure helper for testability; degrades to warning + breadcrumb when gh missing — tag survives) — `8f0c005`

### Tick 17 (2026-06-22 09:43 PT) — SHIPPED
- [x] **F97**: Release-as trailer bypasses tag-on-merge heuristic (F92 extension; `Release-as: vX.Y.Z` body trailer overrides the conventional-commit suggestion; walks up to 5 commits to catch squash-merge AND merge-commit shapes; sentinel skip/none/no values explicitly return undefined so a future "silence the prompt" semantic has room; preview modal shows `(explicit tag from Release-as: trailer)` breadcrumb) — `f956f8c`
- [x] **F95**: Auto-split commit suggester (F90 extension; coherence classifier groups staged numstat rows by (kind, top-level dir) into 2-6 ranked clusters; kinds: source/tests/docs/snapshots/lockfile; lockfile + snapshots always sink to bottom of the plan; source uses SCM-input conventional type when present; output is markdown preview + bash script (`git reset HEAD` + `git add -- <files>` + `git commit -m <subject>` per cluster); "Open in terminal" / "Copy to clipboard" actions — NEVER auto-executes destructive bits) — `6221ba0`
- [x] **F96**: Reviewer self-review verdict (F91 extension; when shortlog fallback drains empty, classify WHY into 4 states: self-dominant (author IS top contributor) / bot-only / no-history / degraded (likely shallow clone); each verdict has decoupled UI copy + suggested follow-up command; self-dominant + bot-only suggest the F47 Files-I-Own picker as a viable next-step; author matching handles full email AND local-part shapes) — `cf04fe5`
- [x] **F93**: PR comment composer from selection (pair with F88; new `gitsight.composePrComment` command posts top-level PR comments via `gh pr comment <num> --body-file -`; composer attaches host-aware permalink line above code-fence (github/gitlab/bitbucket/azure devops); sanity classifier (empty/prefix-only/selection-only/full/too-large) gates the post; >200-line selection prompts extra confirm; preview document + Copy-to-clipboard fallback before posting; pr-open/pr-draft tree item context menu surface) — `639a316`
- [x] **F94**: Workspace-wide secret audit summary (F89 sister command; new `gitsight.workspaceSecretAudit` walks every git repo in the workspace and surfaces a single tree-of-trees picker with per-repo missing-secret breakdown; click jumps to workflow:line; "Open full report" action writes timestamped markdown summary to scratch buffer; ranking: missing > healthy > skipped, with most-missing first inside the missing tier) — `a0bb206`

### Tick 18 (2026-06-22 13:18 PT) — SHIPPED
- [x] **F98**: PR template integration (parse `.github/PULL_REQUEST_TEMPLATE.md` + directory variant + repo-root + docs/ variant; section parser with code-fence + tilde-fence awareness; alias map collapses Description/Summary/Overview etc; merge fills aliased sections in place, appends unmatched, preserves template checklist + HTML-comment instructions verbatim) — `77a56bd`
- [x] **F99**: GitHub issue link inserter (three commands: cursor `#NN` reference, markdown link, append `Closes/Fixes/Resolves/Refs/Related` trailer; picker over `gh issue list` OPEN-first then updated-at desc; trailer composer respects git-interpret-trailers convention with blank-line separator and same-kind dedup; conventional-commit subject correctly NOT treated as a trailer block; qualified `org/repo#NN` form behind a config) — `9f0863c`
- [x] **F100**: "What's mine?" dashboard (one command, tree-of-trees picker composing 4 feeds: PRs needing review / PRs you authored / issues assigned / your recent commits; urgency classifier overdue/today/this-week/idle with 3-day overdue gate scoped to PR-review review-required only; per-item actions route to Open/Copy/Checkout/Trailer; gracefully degrades when gh missing - still shows local commit stream) — `bdcc4f1`
- [x] **F102**: CODEOWNERS validator (DiagnosticCollection that lints CODEOWNERS files on open/save/change; 6 categories: invalid-owner ERROR, empty-owner INFO, duplicate-pattern WARN, unreachable-rule WARN, dead-pattern INFO, syntax-warning WARN for leading `!`; column-precise highlighting via custom tokeniser; cross-rule shadow detection; one-shot `gitsight.validateCodeowners` command walks every workspace repo + emits a markdown report) — `77aa8b3`
- [x] **F101**: PR checkout pre-flight (5 safety checks before `gh pr checkout`: origin-match ERROR, working-tree WARN, branch-already-local WARN, base-divergence WARN, conflict-risk WARN/ERROR with file-overlap heuristic; aggregate verdict clear/caution/blocked; picker offers Proceed/Open report/Open in browser; wires from F75 review-inbox per-PR menu and accepts interactive PR-number input via command palette) — `d9a3941`

### Tick 19 (2026-06-22 16:34 PT) — SHIPPED
- [x] **F103**: PR template lint diagnostics (composes with F98; passive DiagnosticCollection on PR-body markdown buffers + PULL_REQUEST_TEMPLATE.md; 6 finding categories: verbatim-placeholder TODO/TBD/FIXME/XXX/N/A/Describe/Lorem, instruction-leftover HTML comments, unfilled-link `<link>/<url>/<issue>`, empty-section, untouched-section vs template body, missing required section; opt-in empty-checkbox category; new gitsight.lintPrTemplate quick-pick command jumps to findings) — `9d9b327`
- [x] **F104**: Open GitHub issue from selection (companion to F99 in REVERSE; select a `// TODO:` / `// FIXME:` comment or any code block, get a `gh issue create` draft; comment-stripping across //, #, /*, --, ;, %, <!-- delimiters; marker extraction TODO/FIXME/XXX/HACK/NOTE/OPTIMIZE/REVIEW/BUG with default label mapping FIXME→bug, HACK→tech-debt, OPTIMIZE→performance; host-aware permalink + fenced code quote; preview-then-act with Open via gh / Copy command / Copy body; CodeAction Refactor surface on any non-empty selection in a tracked repo) — `a59f329`
- [x] **F105**: Inactive-reviewer detection + nudge composer (composes with F75; gh pr view --json reviewRequests,reviews,createdAt; classifies each requested reviewer's activity silent/commented/changes-requested/approved with latest-review-wins per author; filters to silent + over staleAfterDays + non-draft PR; multi-pick picker into a tone-aware composer gentle/firm/custom; reviewer normalisation handles all 4 gh shapes including string + Team with org-slug; post via gh pr comment --body-file - or copy clipboard variants; wires from F75 review-inbox per-PR menu) — `f45e4cc`
- [x] **F106**: PR ready-for-review timeline pill (status-bar pill at priority 86 summarising the current branch's open PR; 7 states ready/review-needed/commits-since-review/conflicts/changes-requested/draft/unknown with first-match decision tree; commits-since-last-review gates on hasPriorReview so brand-new PRs don't get a misleading "+N since review" pill; click opens action picker chaining into F105 inactive-reviewers + showCommitDetail per new commit + F88 prCommentsInbox; warning bg for review-needed + commits-since-review, error bg for conflicts + changes-requested; 60s default poll + 2s ref-change debounce + hideWhenReady config knob) — `71c0fef`
- [x] **F107**: Conflict resolution coach (composes with F34 + F78; for the active editor walks every conflict marker block; extracts ours/base/theirs content for each block including diff3-style ||||||| base markers; per-conflict picker with difficulty glyph trivial/small/moderate/large + first-line preview of each side; block menu offers side-by-side preview ours<->theirs, 3-way preview via two adjacent vscode.diff calls base<->ours + base<->theirs, 4 take-* resolutions, and edit-manually jump; auto-suggestion for 5 trivial cases including identical-sides + empty-one-side + ours-matches-base + theirs-matches-base in diff3; virtual gitsight-conflict: scheme caches per-block payloads under encoded URIs; applyResolution re-extracts per call so block indices stay stable across sibling resolutions) — `47c5112`

### Tick 20 (2026-06-22 19:48 PT) — SHIPPED
- [x] **F108**: PR Comment Thread Resolver (composes with F88; gh pr view --json reviewThreads -> aliased GraphQL batch mutation `t0: resolveReviewThread(input:{threadId:"..."}) ... t1: ...` piped through `gh api graphql -F query=@-`; multi-pick UI with default-picked when not outdated AND <=3 comments; outcome classifier walks both single + aliased response shapes; 25-thread batch cap with continue-prompt; degrades gracefully when gh missing/unauthenticated/too old to expose reviewThreads JSON) — `5b96541`
- [x] **F109**: Stash-on-Pull Guard (wraps gitsight.pull; classifyPullError sorts stderr into 7 buckets; 2 are auto-stashable (merge-local-changes + rebase-local-changes), 5 are not (untracked-overwrite + merge-in-progress + rebase-in-progress + no-tracking + other); recovery chain stash push -> pull -> pop with smart prepull naming and captureLatestStashRef plumbing; pop-conflict is NOT treated as failure - stash IS on disk and user can resolve in-editor; new gitsight.stashOnPull.enabled config) — `85fb602`
- [x] **F110**: Branch Namer Assistant (wraps gitsight.createBranch; SCM input parsed as conventional commit, leading ticket markers extracted via `[PROJ-123]`/`PROJ-123 `; selection / dirty paths / active file / repo name fallbacks; picker shows each suggestion with derivation label + Type-custom escape hatch; validateBranchName subset of `git check-ref-format --branch` rules catches empty/leading-slash/`..`/@{ /`.lock`/illegal chars/double-slash before git rejects; scope NOT included in slug — `feat(auth): add logout` -> `feat/add-logout` per GitHub Flow conventions; configurable separator slash/kebab/none) — `e139844`
- [x] **F111**: Per-File Complexity Badge (FileDecorationProvider stamping M/H/X badges on tracked source files; weighted-sum heuristic over decisions + maxNesting + sqrt(logicalLines) + sqrt(functions); buckets <20 low, <60 medium, <150 high, >=150 extreme; stripCommentsAndStrings preserves line numbers while blanking content so doc-blocks don't inflate decision counts; per-file mtime+size cache + lazy provideFileDecoration mirrors F81; new gitsight.complexityBadge.show command opens a markdown report with metric table) — `81b9553`
- [x] **F113**: Auto-Resolve Trivial Conflicts (F107 extension; buildAutoResolvePlan walks every conflict block + filters to `trivial` difficulty from F107's classifier; applyAutoResolvePlan applies resolutions HIGHEST-INDEX-FIRST so earlier blocks keep their indices intact through the batch; outcomes re-sorted to block-index order for stable reporting; preview-modal pattern with markdown table | # | Line | Choice | Reason |; offer-conflict-coach fallback when the file has only non-trivial blocks; WorkspaceEdit replaces whole document body and prompts user to save) — `95c8352`

### Tick 21 (2026-06-22 23:16 PT) — SHIPPED
- [x] **F114**: PR Complexity Aggregate (composes with F111; summarisePrComplexity rolls per-file scores across the PR with topBucket / per-bucket histogram / totalScore; sort by bucket -> score -> path is stable; FILE_CAP=100 keeps huge PRs snappy; gh pr view --json files + per-file `git show <tip-sha>:<path>` body fetch; per-PR-tip-sha cache; picker with jump / open-report / refresh; new "PR complexity breakdown" row in prTimelinePill menu) — `9ffc914`
- [x] **F116**: DCO Signed-off-by Enforcement (detectDcoRequirement 4-state verdict required/suggested/unknown/disabled with DCO-file-wins-over-CONTRIBUTING-mention priority; required-verb regex must|require|mandate|enforce; SCM input watcher on commitLint 1.5s cadence; error background for required + warning for suggested; one-click append using user.name+user.email; appendSignoffTrailer preserves existing trailer block per git-interpret-trailers convention, idempotent for same identity; gitsight.dcoSignoff.addToScm command as a keybinding hook) — `c4c5303`
- [x] **F117**: Last release vs HEAD CHANGELOG Preview (sister to F86 tag-on-merge; passive picker that walks lastTag..HEAD continuously; parseDiffNumstat handles binary `-` marker; summariseAccumulation composes with F86 classifyRangeBump+suggestNextTag so bump verdicts stay in lockstep; buildChangelogPreview emits Breaking->Features->Fixes->Perf->Other + Contributors + sorted Touched files table with commitsCap+filesCap; copy headline / copy markdown / open preview / drill-down to showCommitDetail) — `c33c1cd`
- [x] **F112**: PR Comment AI Summary (>=10 substantive comments triggers offer; buildReviewSummaryPrompt sorts unresolved-first oldest-within-tier with 600-char per-comment cap and head/tail truncation marker; parseReviewSummaryOutput tolerates alt headers `Open issues`/`Unresolved threads`/`Action items` and -/*/1. bullets; sentinel "All threads appear resolved" returns allResolved=true; runCopilotPrompt cancellation wired; view/item/context menu on pr-(open|draft|merged|closed) tree items) — `7046d0b`
- [x] **F115**: GitHub merge queue position + ETA pill (parseMergeQueueEntry tolerates AWAITING_CHECKS/PROCESSING/TESTING->processing, LOCKED/UNMERGEABLE->blocked, MERGED/DEQUEUED; estimateMergeMinutes position * avgMinutes with floor; processing uses half-average; 6-state codicon glyphForQueueState no-emoji; new gitsight.mergeQueueStatus command + extra "Merge queue status" row in the prTimelinePill action menu; 3 new mergeQueue configs averageMinutesPerPr/floorMinutes/refreshSeconds) — `d1b67b7`

### Tick 22 (2026-06-23 02:56 PT) — SHIPPED
- [x] **F119**: Branch Protection Overview picker (companion to F71; classifies each local branch into locked/reviewed/guarded/unprotected/unknown via classifyLevel on top of classifyProtection from F71; per-branch action picker with Open on GitHub + Open settings + Copy + Show all rules + Show probe error; full markdown report action; default branch + current branch sorted first; bounded probeLimit 20 default) — `52d5ecd`
- [x] **F120**: "What's stale?" repo-rot dashboard (composite of F25 branchAge + F67 stashTrash + F64 worktreePruner; pure whatsStale.ts scores each candidate critical/major/minor with numeric score for stable ordering; aggregateRot sorts severity-desc then score-desc then label-asc; secrets scoring exposed for future composition but not in the default scan to keep snappy; per-kind row click routes to that domain's cleanup command) — `61ec15a`
- [x] **F121**: Merge queue enqueue/dequeue commands (wraps `gh pr merge --queue --<strategy>` and `--disable-auto`; classifyEnqueue 6 safety checks: draft/cross-repo/already-queued/DIRTY/BEHIND/no-queue-support; 4 warning-only paths: BLOCKED/HAS_HOOKS/UNSTABLE/UNKNOWN/auto-merge-on; strategy normaliser tolerates SQUASH/Squash shapes and coerces unknowns to 'merge' with coerced flag; classifyDequeue with noop verdict for already-clean PRs) — `c13b647`
- [x] **F122**: Per-PR test-impact suggester (composes with F111+F114; isTestFile classifier handles JS/TS/Go/Rust/Python/Ruby/Cypress + __tests__/ + assets-lockfile rejection; generateSiblingCandidates emits ecosystem-specific test names; composeImpact merges 3 signal maps (import w=10, co-located w=5, naming-sibling w=3) with dedup + stable sort + orphan detection; view does per-source git grep + per-dir readdir cache + per-candidate stat; bounded sourceCap 100 default; works WITHOUT gh by falling back to range diff against origin/HEAD) — `1453423`
- [x] **F123**: PR review submitter (wraps `gh pr review`; ReviewVerdict approve/request-changes/comment; classifyReviewSubmission gates: invalid PR number, body >65k chars, request-changes/comment without body all blocked; verdict<->body tone mismatch warnings via REQUEST_CHANGE_RX + APPROVAL_RX regex; summariseReviewBody head/tail truncation with omitted marker; quick-approve command skips body editor; stdin pipe pattern mirrors F93 prCommentCompose) — `c01d293`

### Tick 21 candidates (RESOLVED above)
- [x] F119: Branch protection grafana — DONE tick 22.
- [x] F120: Repo "what's stale?" dashboard — DONE tick 22.
- [x] F121: Merge queue add/remove command — DONE tick 22.
- [x] F122: Per-PR test-impact suggester — DONE tick 22.
- [x] F123: PR review submitter — DONE tick 22 (NEW slice, not in prior roadmap).

### Tick 23 (2026-06-23 06:35 PT) — SHIPPED
- [x] **F124**: Reviewer load balancer (3-axis score over pending queue + recent throughput + median ack latency; rerankByLoadBalance composes after F85 round-robin; 5-state verdict fast/busy/slow/neutral/unknown with `unknown` reviewers parked at configurable neutral score so they don't displace known-fast handles; identity index from gh user lookup; default-handle source priority CODEOWNERS -> shortlog with GitHub noreply email format extracted to plain handle; bot-identity filter via /\bbot\b/ + noreply + dependabot + renovate + github-actions) — `0ff5dc5`
- [x] **F125**: Test-Impact -> PR body sync (managed `<!-- GITSIGHT:TEST-IMPACT -->` block w/ same round-trip pattern as F77; signal blurbs render imports/co-located/naming-sibling with 1/2/3+ source-list formatting; <details> collapsible orphan section w/ overflow truncation; classifyTestImpactSync 3-state insert/no-change/replace verdict gates a confirm picker with apply/preview/copy/remove actions; computeTestImpactSummary exported from F122's view layer to dedupe scan logic; gh pr edit --body-file - via stdin pipe pattern) — `d5a1640`
- [x] **F126**: Branch protection rule auto-suggester (BranchRole classifier default/release/hotfix/long-lived/feature/other from name + repo default; environment signals from `.github/workflows/*.yml` + CODEOWNERS files + git log -30 --pretty=format:%G? signed-commit count; 3 strength tiers recommended/optional/aggressive with recommended pre-picked; required-status-checks downgrades to optional when CI absent; required-signatures only when history includes signed commits; enforce-admins always aggressive so admin bypass isn't disabled on day 1; buildProtectionPutBody preserves currently-enabled rules so partial picker accept doesn't downgrade) — `03604fa`
- [x] **F127**: Stash patch export safety net (companion to F67 trash bin; deriveStashPatchFilename emits filesystem-safe `gitsight-stash__YYYY-MM-DD-HHMM__on-<branch>__<subject>__<6-char-fp>.patch` with 200-char cap + duplicate-component dedup + FNV-1a fingerprint salt over ref|subject|date; validateFilename rejects illegal chars + trailing dot/space + Windows reserved + over-length; export-priority classifier named/branch-gone/ancient -> export, stale-but-recent -> optional, fresh+unnamed -> low-value; F67 picker gains 3-button modal Save priority/Save ALL/Drop-without-saving; new standalone gitsight.exportStashPatches command; markdown index report written alongside; failure handling stops the drop if write fails) — `b0293c6`
- [x] **F83**: Commit graph PNG export (companion to F61 SVG; two-phase webview round-trip - extension posts SVG data URL via new buildSvgDataUrl helper, webview rasterises via canvas drawImage + toDataURL('image/png') at devicePixelRatio clamped 1-4, posts dataUrl back; new parsePngDataUrl tagged-union helper strictly validates prefix + base64 alphabet + non-empty payload; refactored F61 flow to share buildSvgForExport + resolveExportTarget + surfaceExportSuccess helpers; PNG-doesn't-open-as-text fallback to revealInOS) — `a5a5112`

### Tick 24 (2026-06-23 11:05 PT) — SHIPPED
- [x] **F128**: Reviewer load-balancer integration with F57 picker (composeReviewerRanking pure helper picks load-score over round-robin when scores available with anyMatch invariant; tier-invariant rerankByScores (high-coverage owners never demoted under low-coverage); describeSuggestionWithLoadScore one-decimal precision + explicit no-signal marker; view layer fetches scores in parallel with round-robin counts via Promise.all + 12s race-with-timeout per fan-out + score fetch scoped to USER suggestions only since teams have no review queue of their own; placeholder advertises which signal won) — `203a94b`
- [x] **F129**: Test-impact PR body auto-sync (mirrors F77 PR-draft auto-sync; hasTestImpactBlock pure detector tolerates malformed marker pairs (lone open/close, reverse order); classifyAutoSync 5-state verdict skipped/no-pr/no-block/no-change/refreshed; runTestImpactAutoSyncFireAndForget hook into gitsight.push fires only when block ALREADY exists (opt-in via F125's first run); 12s gh timeout + computeTestImpactSummary cancellation token made optional for the non-interactive path) — `4ae16f5`
- [x] **F130**: Auto-offer branch protection on create (shouldAutoOfferProtection pure verdict over BranchRole - default/release/hotfix/long-lived offer, feature+other skip; describeAutoOfferRationale supplies the toast WHY-copy; offerProtectionForNewBranch view hook reads default branch from refs/remotes/origin/HEAD with init.defaultBranch fallback; session-only dismissed-branches cache keyed by lowercased name; routes through existing gitsight.suggestBranchProtection with branch hint) — `f30b741`
- [x] **F131**: Stash patch import (companion to F127 export; new src/git/stashPatchImport.ts pure helpers - inspectPatchPayload tolerates CRLF + format-patch headers + bare diffs + binary markers; parseGitSightFilename round-trips F127 stamp; classifyApplyResult 5-state verdict applied/applied-with-conflicts/rejected/already-applied/failed with rejected-wins-over-already-applied tiebreak; sortPatchCandidates non-mutating stamped-first then file-count-desc then alpha; view runs git apply --3way + routes conflict outcomes to F107 conflictCoach with first-file open; OS file picker fallback when no .patch files in patchExportDir) — `d534a25`
- [x] **F132**: Commit graph PDF export (third format after F61 SVG + F83 PNG; buildPrintHtml builds @page-sized minimal HTML wrapping the standalone SVG with print-only stylesheet + 0.5in minimum + html/body margin zeroing + media:print color-adjust + escapeXml-protected title; classifyPdfExport 3-state verdict + 50 MB default cap via estimateSvgBytes linear heuristic; webview opens hidden iframe + document.write + 250ms wait + iframe.contentWindow.print so user picks Save-as-PDF from system print dialog; no extension-side filesystem write since webviews don't expose Chromium PDF API) — `188146b`

### Tick 23 candidates (RESOLVED above)
- [x] F124: Reviewer load-balancer — DONE tick 23.
- [x] F125: Test-impact -> PR template comment — DONE tick 23.
- [x] F126: Branch protection rule auto-suggester — DONE tick 23.
- [x] F127: Stale stash auto-export — DONE tick 23.
- [x] F83: Commit graph PNG export — DONE tick 23.

### Tick 23 candidates (RESOLVED above)
- [x] F128: Reviewer load-balancer integration with F57 picker — DONE tick 24.
- [x] F129: Test-impact PR body auto-sync — DONE tick 24.
- [x] F130: Branch protection apply-on-create — DONE tick 24.
- [x] F131: Stash patch import — DONE tick 24.
- [x] F132: Commit graph PDF export — DONE tick 24.

### Tick 25 candidates (drafted now so future ticks don't restart cold)
- [ ] F53: Commit-Detail Webview (multi-tick carry-over) — still pending; flat-diff scratch buffer is the gap. The existing showCommitDetail is functional; this is the polish counterpart matching CommitGraphPanel + StashVisualizer with per-file diff tabs + stats sidebar.
- [ ] F72: Worktree-graph webview — pairs with F64 pruner; render every worktree as a node in a tree with HEAD shas + branch attachments + dirty status.
- [ ] F79: Local-branch GitHub Pages preview — for branches that have changed `docs/` or `_site/`, generate the gh-pages preview URL.
- [ ] F82: Per-commit benchmark scorer — extends F55 with quantitative output (per-commit ms / memory delta against a baseline command).
- [ ] F118: PR description from active diff selection — extends F87 with multi-file gather (instead of single editor selection).
- [ ] F133: Stash patch import auto-discovery on workspace open — passive watcher that surfaces a one-time toast when `.patch` files exist in the workspace root that weren't there at last activation. Composes with F131.
- [ ] F134: Test-impact PR-body diff verdict — when F129 auto-sync runs, optionally post a PR comment showing what changed in the test-impact block (added tests / removed tests / score delta). Cheap signal for reviewers.
- [ ] F135: Branch protection delta-only picker — when re-running F126 on a branch that already has rules, show ONLY the deltas (rules that would change vs stay) rather than the full picker. Reduces noise on iterative protection tightening.
- [ ] F136: Commit graph PNG/SVG/PDF export keybindings — three default chords (Cmd+Alt+S/P/D) for the export buttons when CommitGraphPanel is focused. Mirrors how other webview panels surface their power-actions.
- [ ] F137: Reviewer load-balancer historical trend report — extends F128's standalone report with a "trend over last 4 weeks" line so the user can see whether a reviewer's median ack latency is improving or degrading. Useful for retros.

### Tick 18 candidates (RESOLVED above)
- [x] F103: PR template lint diagnostics — DONE tick 19.
- [x] F104: "Open issue from selection" — DONE tick 19.
- [x] F105: Inactive-reviewer detection — DONE tick 19.
- [x] F106: PR ready-for-review timeline — DONE tick 19.
- [x] F107: Conflict resolution coach extension — DONE tick 19.

### Tick 19 candidates (RESOLVED above)
- [x] F108: PR comment thread resolver — DONE tick 20.
- [x] F109: Stash-on-pull guard — DONE tick 20.
- [x] F110: Branch namer assistant — DONE tick 20.
- [x] F111: Per-file complexity badge — DONE tick 20.
- [x] F113: Auto-resolve trivial conflicts (F107 extension) — DONE tick 20. [F112 (review-comment AI summary) carried forward — needs vscode.lm dependency thread.]

### Tick 20 candidates (RESOLVED above)
- [x] F112: Review-comment AI summary — DONE tick 21.
- [x] F114: Lazy-load complexity score for PR view (extends F111) — DONE tick 21.
- [x] F115: gh-aware merge queue surface — DONE tick 21.
- [x] F116: Pre-commit Signed-off-by enforcement (DCO) — DONE tick 21.
- [x] F117: Last release vs HEAD diff size + CHANGELOG suggestion — DONE tick 21.

### Tick 21 candidates (drafted now so future ticks don't restart cold)
- [ ] F53: Commit-Detail Webview (multi-tick carry-over) — still pending; flat-diff scratch buffer is the gap.
- [ ] F72: Worktree-graph webview — pairs with F64 pruner.
- [ ] F79: Local-branch GitHub Pages preview — for branches that have changed `docs/` or `_site/`.
- [ ] F82: Per-commit benchmark scorer — extends F55 quantitatively.
- [ ] F83: Commit graph PNG export — companion to F61 SVG export.
- [ ] F118: PR description from active diff selection — extends F87 with multi-file gather (instead of single editor selection).
- [ ] F119: Branch protection grafana — overview picker showing protection rules per branch (`gh api repos/:o/:r/branches/<n>/protection`).
- [ ] F120: Repo "what's stale?" dashboard — composite of F25 branch-age + F67 stash-trash + F64 worktree-pruner + F94 secrets-audit into one ranked picker.
- [ ] F121: Merge queue add/remove command — wraps `gh pr merge --auto --merge --queue` with same-repo guard + dirty-tree check.
- [ ] F122: Per-PR test-impact suggester — given changed files, run `git grep` against `**/*.test.ts` for paths importing them and surface a "likely-touched tests" list (composes with F111 + F114).

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

- 2026-06-22 02:02 PT — 5 features shipped: F84 `e7b5596`, F85 `3ad487b`, F86 `1b30d23`, F87 `f68f552`, F76 `adcfc0e`. Gate: lint ok, compile ok, 1056/1056 tests green (940 → 1056, +116 new). [tick-15 narrative truncated; see git log for full detail]

- 2026-06-22 06:06 PT — 5 features shipped: F88 `963f540`, F89 `a918174`, F90 `062e439`, F91 `a196de8`, F92 `8f0c005`. Gate: lint ok, compile ok, 1128/1128 tests green (1056 → 1128, +72 new). New configs: 13 (secretAudit.{enabled,refreshMinutes,hideOnHealthy,includeOrgSecrets} = 4, diffSize.{enabled,lineThreshold,fileThreshold,hugeLineThreshold,noisyDominance,requireSCMInput} = 6, defaultReviewers.{shortlogFallback,shortlogFallbackDays,shortlogPerTier} = 3). New commands: 5 (prCommentsInbox, secretAudit.show, secretAudit.rescan, diffSize.show, diffSize.rescan; F91 + F92 extend existing commands in place). New menus: 1 (view/item/context prCommentsInbox on `pr-(open|draft|merged|closed)` tree items). New status-bar pills: 2 (SecretAuditPill at priority 88, DiffSizeHeuristicController at priority 87 — full pill stack from left now reads: 87 diffSize, 88 secretAudit, 89 stagedConflictGate, 90 actionsPill, 91 forgottenFiles, 92 submodulePill). New diagnostic collections: 1 (gitsight.diffSize on virtual `gitsight-diffsize://<repo>/STAGED` URI). New files: 9 (4 fresh pure helpers + 3 view controllers + 4 test files; F91 + F92 extended `defaultReviewers.ts` + `tagOnMerge.ts` in place). Notable patterns added: (1) bot-identity filter via /\bbot\b/, /noreply@/, /\[bot\]/, /dependabot/, /renovate/, /github-actions/ regex set so noise authors never appear as reviewer suggestions; (2) per-tier cap composed with F85 round-robin — cap THEN rerank, so the rerank's tier-preservation invariant still holds after capping; (3) gh stdin notes-file pipe via execFile + child.stdin.write/end rather than execFileSync with `--notes-file <tmpfile>` — avoids the temp file dance and gracefully closes; (4) SemVer prerelease keyword set with bounded suffix `(?:[.\-+\d]|$)` so `v1.0.0-fix-hotpatch` doesn't false-positive as a prerelease (the next char after `pre` would have to be a dot/dash/plus/digit/end-of-string, not a letter); (5) noisy-path classifier lowercases the path once then matches aga... [truncated]

- 2026-06-22 09:43 PT — 5 features shipped: F97 `f956f8c`, F95 `6221ba0`, F96 `cf04fe5`, F93 `639a316`, F94 `a0bb206`. Gate: lint ok, compile ok, 1214/1214 tests green (1128 → 1214, +86 new). New configs: 0 (every slice this tick was a pure extension of an existing view's existing config surface — Release-as trailer reuses tagOnMerge, split suggester reuses diffSize thresholds, self-review verdict reuses defaultReviewers cohort, comment composer is on-demand, workspace audit walks RepoManager.all()). New commands: 2 (gitsight.composePrComment, gitsight.workspaceSecretAudit; F97 + F95 + F96 hook into existing commands). New menus: 1 (view/item/context composePrComment on `pr-(open|draft)` tree items). New pure helpers: 4 (diffSplitSuggester, prCommentCompose, workspaceSecretAudit — plus a Release-as trailer family added to tagOnMerge.ts in place). New tests: 86 (F97: 13 trailer + 5-commit cap + sentinel handling, F95: 19 cluster classification + churn ranking + shell-quote escaping, F96: 12 verdict states + hint copy, F93: 24 compose shapes + 4-host permalink building + fence-language map, F94: 14 rank tiers + summary counts + markdown report sections). Notable patterns added: (1) `Release-as:` trailer multiline-aware scan with start-of-line anchor + sentinel skip/none/no values reserved for future "silence" semantics; (2) coherence cluster ranking that sinks lockfile + snapshots to the BOTTOM regardless of churn (commit the real change first, then the noise); (3) self-review verdict 4-state classifier with UI-copy decoupled from verdict logic so wording can A/B without touching the verdict; (4) host-aware permalink builder for github/gitlab/bitbucket/azure-devops with single-line `#L<N>` vs range `#L<a>-L<b>` handling; (5) workspace-wide tree-of-trees picker pattern (header summary + indented child rows per parent + trailing global actions) — first reusable surface of this shape in gitsight, future repo-level dashboards can copy.

- 2026-06-22 13:18 PT — 5 features shipped: F98 `77a56bd`, F99 `9f0863c`, F100 `bdcc4f1`, F102 `77aa8b3`, F101 `d9a3941`. Gate: lint ok, compile ok, 1381/1381 tests green (1214 → 1381, +167 new). New configs: 7 (prTemplate.enabled = 1, issueInsert.{listLimit,includeClosed,qualifiedPrompt} = 3, whatsMine.{listLimit,commitWindowDays} = 2, codeownersValidator.enabled = 1, prCheckoutPreflight.recentWindowDays = 1). New commands: 7 (insertIssueReference, insertIssueAsMarkdownLink, appendIssueTrailer, whatsMine, validateCodeowners, prCheckoutPreflight; F98 wraps existing generatePullRequestDescription, F101 also wires from existing prReviewInbox per-PR menu). New pure helpers: 5 (prTemplate, issueInsert, whatsMine, codeownersLint, prCheckoutPreflight). New view-layer files: 5 (issueInsert, whatsMine, codeownersValidator, prCheckoutPreflight; F98 lives inside the existing ai/prDescription.ts). New DiagnosticCollections: 1 (gitsight.codeowners on file:// CODEOWNERS docs). New tests: 167 (F98: 29 candidates + tokeniser + alias merge, F99: 33 parse/sort/format + trailer compose w/ subject-not-trailer guard, F100: 36 four-feed parsers + urgency + summary + label/detail formatters, F102: 39 tokeniser + classifier + 6 finding categories + summary, F101: 32 verdict aggregation + 5 individual checks + composer + markdown render + overlap counter).

- 2026-06-22 16:34 PT — 5 features shipped: F103 `9d9b327`, F104 `a59f329`, F105 `f45e4cc`, F106 `71c0fef`, F107 `47c5112`. Gate: lint ok, compile ok, 1545/1545 tests green (1381 → 1545, +164 new). [tick-19 narrative truncated; see git log for full detail.]

- 2026-06-22 19:48 PT — 5 features shipped: F108 `5b96541`, F109 `85fb602`, F110 `e139844`, F111 `81b9553`, F113 `95c8352`. Gate: lint ok, compile ok, 1688/1688 tests green (1545 → 1688, +143 new). New configs: 5 (stashOnPull.enabled = 1, branchNamer.{enabled,separator} = 2, complexityBadge.{enabled,maxFileBytes} = 2). New commands: 3 (resolvePrCommentThreads, autoResolveTrivialConflicts, complexityBadge.show; F109 + F110 wrap existing gitsight.pull / gitsight.createBranch in place). New menus: 1 (view/item/context resolvePrCommentThreads on pr-(open|draft) tree items, after the F93 compose action). New providers: 1 FileDecorationProvider (ComplexityBadgeProvider, scoped to source-extension non-vendor files inside git repos). New pure helpers: 5 (prThreadResolve, stashOnPull, branchNamer, complexityBadge, conflictAutoResolve). New view-layer files: 5 (prThreadResolve, stashOnPull, branchNamer, complexityBadge, conflictAutoResolve). New tests: 143 (F108: 22 GraphQL mutation builder + classifier across single/aliased shapes + selectResolvable + threadsSummary; F109: 24 classifyPullError across 7 reasons + smart prepull naming + summarise per reason + recovery outcomes including pop-conflict; F110: 39 kebab + parseSubject for 8 conventional shapes + ticket extraction + composeBranchName + validateBranchName subset rules + suggestBranchNames + dedupe; F111: 32 computeComplexity zero/trivial/branchy/nested + 7 stripCommentsAndStrings + bucket boundaries + badgeFor + isAnalysableFile; F113: 24 plan-builder for trivial/diff3/mixed + applyAutoResolvePlan with the descending-index correctness test + outcomes-sort-to-block-order + buildPlanMarkdown + describeAutoResolveOutcome singular/plural).

- 2026-06-22 23:16 PT — 5 features shipped: F114 `9ffc914`, F116 `c4c5303`, F117 `c33c1cd`, F112 `7046d0b`, F115 `d1b67b7`. Gate: lint ok, compile ok, 1791/1791 tests green (1688 -> 1791, +103 new). New configs: 5 (dcoSignoff.{enabled,alwaysEnforce} = 2; mergeQueue.{averageMinutesPerPr,floorMinutes,refreshSeconds} = 3). New commands: 5 (complexityBadge.showForPr, dcoSignoff.addToScm, releaseSinceLastTag, summarisePrComments, mergeQueueStatus). New menus: 1 (view/item/context summarisePrComments on pr-(open|draft|merged|closed) tree items). New controllers: 1 (DcoSignoffController, status-bar pill at priority 85). New pure helpers: 5 (complexityForPr, dcoSignoff, releaseSinceLastTag, reviewSummaryAi, mergeQueue). New view-layer files: 5 (complexityForPr, dcoSignoffController, releaseSinceLastTag, reviewSummaryAi, mergeQueue). New tests: 103 (F114: 14 bucket/score/path sort + capped pill + report markdown shape; F116: 27 4-state verdict + identity case-insensitive email match + trailer block detection + idempotency + CRLF normalisation + candidate file priority + severity defaults; F117: 18 numstat parser + bump-from-body BREAKING + no-previous-tag seed + accumulator math + contributor ranking + caps + churn-desc file sort; F112: 22 threshold gate + header sorting + body truncation + alt header variants + bullet shapes + sentinel parse + paragraph fallback; F115: 22 6-state transitions + position estimation + averageMinutes <= 0 clamping + alternate totalEntries shape + dequeueReason + glyph map). PrTimelinePill gains 2 chained rows (complexity, queue) routing to the new commands so F106 stays the canonical PR-from-status-bar surface.

- 2026-06-23 02:56 PT — 5 features shipped: F119 `52d5ecd`, F120 `61ec15a`, F121 `c13b647`, F122 `1453423`, F123 `c01d293`. Gate: lint ok, compile ok, 1950/1950 tests green (1791 -> 1950, +159 new). New configs: 7 (branchProtectionOverview.probeLimit = 1, whatsStale.includeStaleWorktrees = 1, mergeQueueActions.defaultStrategy = 1, testImpact.{sourceCap,includeNamingSiblings} = 2, prReview.approveBodyPrompt = 1, plus pre-existing config knobs reused throughout). New commands: 7 (branchProtectionOverview, whatsStale, mergeQueueEnqueue, mergeQueueDequeue, testImpact, submitPrReview, submitPrReviewApprove). New pure helpers: 5 (branchProtectionOverview - 8 exports built on top of F71 classifyProtection; whatsStale - 7 exports composing F25+F67+F64; mergeQueueActions - 5 exports with classify/build/format; testImpact - 7 exports with regex-driven test classification + 6-ecosystem sibling generator; prReviewSubmit - 6 exports with verdict<->body tone heuristic). New view-layer files: 5 (branchProtectionOverview, whatsStale, mergeQueueActions, testImpact, prReviewSubmit). New tests: 159 (F119: 23 classifier + describer + glyph + builder + selector + report; F120: 28 per-kind scorers + aggregator + summariser + header + report + edge cases; F121: 36 classifier 6-blocked + 4-warning paths + dequeue verdict + arg builder + strategy normaliser + headline; F122: 34 isTestFile across 7 ecosystems + sibling generator across 5 ecosystems + composeImpact signal merge + sort tiebreak + orphan detection + header format + report; F123: 33 classify 4-blocked + verdict-tone-mismatch warnings + buildArgs body-file gate + truncation + preview + normaliser).

- 2026-06-23 06:35 PT — 5 features shipped: F124 `0ff5dc5`, F125 `d5a1640`, F126 `03604fa`, F127 `b0293c6`, F83 `a5a5112`. Gate: lint ok, compile ok, 2093/2093 tests green (1950 -> 2093, +143 new). New configs: 7 (reviewerLoadBalancer.{lookbackDays,handles} = 2, testImpactPrBody.{maxRows,maxOrphans,includeOrphans} = 3, stashTrash.{exportPatchesByDefault,patchExportDir} = 2). New commands: 4 (reviewerLoadReport, injectTestImpactIntoPr, suggestBranchProtection, exportStashPatches). New pure helpers: 4 (reviewerLoadBalancer - 11 exports scoring 3-axis composite + tier-preserving rerank + ack/throughput parsers + median + describe/verdict/report; testImpactPrBody - 7 exports for managed-block round-trip; branchProtectionSuggest - 9 exports including role classifier + signal-driven suggester + PUT-body builder + preview markdown; stashPatchExport - 8 exports for filesystem-safe filename derivation + export-priority classifier + report builder). New view-layer files: 4 (reviewerLoadBalancer, testImpactPrBody, branchProtectionSuggest; F127 hooks into existing stashTrashBin in place + adds exportStashPatches standalone). New webview wiring: 1 (Export PNG button + rasterisePng / exportPngBytes / exportPngFailed message handlers in commitGraph.ts). New webview helpers: 2 (parsePngDataUrl tagged-union + buildSvgDataUrl with caller-supplied base64 encoder for testability). New tests: 143 (F124: 36 score-weights + tier-invariant rerank + parsePending/parseAckLatency/parseThroughput/median/buildStats + describeLoadStats hours formatting + classifyVerdict 5 states + buildLoadReport sort; F125: 24 buildBlock empty/rows/maxRows/signals/source-list-1-2-3 + injectBlock 4 scenarios + needsRewrite timestamp masking + stripBlock + classify 3 verdicts; F126: 36 classifyBranchRole 6 roles + suggestProtectionRules baselines + skips-already-enabled + signal-gated rules + sorted-by-weight + buildPutBody picked/preserving/null-for-off/object-shapes + buildSuggestionPreview tiers + describeVerdict; F127: 32 sanitiseFilenameComponent + deriveFilename layout/branch-omit/fingerprint-uniqueness/long-fallback/dedup + validateFilename + buildExportPlan rationale-precedence + summariseExportPlan + buildExportReport; F83: 13 parsePngDataUrl 8 negative + 1 ok + buildSvgDataUrl round-trip + custom encoder + unicode preservation, added to existing commitGraphExport.test.ts).

CAUGHT MID-TICK (tick 22): 3 test-only failures on first gate. (a) F119 describeRow test expected "3 rules" in the locked-rule-count string but the implementation correctly counts only ENABLED rules (force-push with enabled=false doesn't count). Fixed expectation to "2 rules" + added a comment explaining the gate so a future regression that starts counting disabled rules gets flagged. (b) F120 summariseRot test expected major=2/minor=1 but the actual scoring puts upstream-gone worktrees at major (not minor), so major=3/minor=0. Fixed expectations + added an inline comment listing the 3 major items so the verdict is locked in. (c) F122 buildImportProbe test expected `foo\\/bar` (escaped slash) in the regex output but JavaScript regex doesn't need slashes escaped - only dots. Fixed assertion to match `foo/bar` literal + the negative assertion for `.ts` extension still holds. Three test edits + zero source fixes - all amended via `--fixup` + autosquash so each feature commit stays self-passing. SHAs above reflect post-rebase state.


CAUGHT MID-TICK (tick 20): 3 test-only failures on first gate. (a) F110 composeBranchName(`feat: x`, 'none') returns `add-logout` (slug only); the test wrongly expected `feat-add-logout`. Fixed the test + added a second assertion documenting the slug-empty-fallback-to-type shape so the contract is double-locked. (b) F110 SCM-input test had a busted self-correcting assertion chain (a `.replace().replace()` typo from earlier iteration). Removed the dead code; the real `feat/add-logout` assertion is correct AND now front-and-centre. (c) F113 NON_TRIVIAL_TWO_SIDED fixture is 5-vs-3 lines (maxLines=5, diff=2) — F107's classifier rule `maxLines<10 && diff<5 -> 'small'` applies, not 'moderate'. Fixed expectation to 'small' + added a regression comment so a future heuristic re-tune that turns small files into trivial ones gets caught (correctness bug — 'small' still needs human eyes, can't be silently auto-resolved). Three test edits, zero source fixes — all amended via `--fixup` + autosquash so each feature commit stays self-passing.

### Tick 19 candidates (drafted now so future ticks don't restart cold)
- [ ] F53: Commit-Detail Webview (multi-tick carry-over). The existing showCommitDetail dumps a flat diff into a scratch buffer; this is the polish counterpart that matches CommitGraphPanel + StashVisualizer.
- [ ] F72: Worktree-graph webview — visualise all worktrees as a tree with their HEAD shas, branch attachments, and dirty status. Pairs with F64 pruner.
- [ ] F79: Local-branch GitHub Pages preview — generate the local preview URL for branches with changes under `docs/` or `_site/`.
- [ ] F82: Per-commit benchmark scorer — extends F55 with quantitative output.
- [ ] F83: Commit graph PNG export — companion to F61 SVG export.
- [ ] F108: PR-comment thread resolver — for unresolved review comments surfaced by F88, offer a "Mark as resolved" action via gh api graphql (the REST endpoint doesn't expose thread resolution).
- [ ] F109: Stash-on-pull guard — when `git pull` is about to overwrite local changes, intercept with a smart-stash suggestion (composes with F43 stashSaveSmart + F80 stashOnSwitch).
- [ ] F110: Branch namer assistant — when creating a branch with `git checkout -b`, suggest a name from the SCM input box's typed conventional-commit subject (e.g. `feat: add logout` → `feat/add-logout`).
- [ ] F111: Per-file complexity badge — FileDecorationProvider showing a cyclomatic-complexity bucket per file (low/med/high) using a quick line-count + nesting-depth heuristic; click jumps to the deepest function.
- [ ] F112: Review-comment AI summary — for PRs with > 10 comments, AI-summarises the discussion into a single paragraph + a list of "open questions" to focus the reviewer.

CAUGHT MID-TICK (tick 18): 3 issues on first test pass. (a) F98 buildTemplatePickerEntries test expected `.txt` excluded but the source intentionally includes `.txt` for GitHub templates that use it — adjusted test to assert the documented behaviour. (b) F99 appendIssueTrailer false-positive: the conventional-commit subject `feat: x` matched the trailer regex (Key: value shape) so a single-line body got treated as a trailer block. Tightened the detector: a trailer block must be preceded by a blank line, AND can never be the entire body (subjects always exist separately from trailers). (c) F100 parseRecentCommits over-permissive: a `||||` row passed the parts.length >= 4 gate but produced shortSha='', subject='|' (truthy after empty rest.join). Added per-field non-empty checks on longSha/shortSha/iso so malformed lines drop. All three fixes amended into the relevant feature commits before push — never shipped a red commit.

POLICY NOTE (carry-forward): the wrapper now gates on `main` directly and trusts the end-of-tick lint+compile+test gate. We commit straight to `main`, run the gate ONCE for the batch, and push only on green. Two-tier strategy: per-feature `--fixup` if a single feature has a problem (then autosquash before push); revert-and-resubmit if a feature is fundamentally broken (rather than red-pushing).

CAUGHT MID-TICK (tick 16): 3 issues on first test pass: (a) diffSizeHeuristic NOISY_FILENAMES set had mixed-case `Cargo.lock`/`Pipfile.lock` but isNoisyPath lowercases the basename before set-lookup, so 'cargo.lock' missed every time; lowercased the set as the fix. (b) reviewersFromShortlog test fixture stamped 10 entries with the SAME path so the Map collapsed them all to one record; fixed the fixture to aggregate into a single byAuthor record on one path entry. (c) reviewersFromShortlog had an over-aggressive author-local-part exclusion that dropped both sanjay@example.com AND sanjay@personal.com from suggestions; pulled it back to literal-email exclusion only (different orgs share names) and adjusted the test to assert the safer behaviour + added a separate test demonstrating the local-part exclusion via `extraExcluded` config. Three test edits + one fixture fix + one source fix — all amended into the relevant feature commits before push so no red commit ever landed.

CAUGHT MID-TICK (tick 23): 2 test-only failures on first gate. (a) F124 scoreReviewerLoad latency-weighted test asserted `r.score === 2.4` but `0.1 * 24` in JS evaluates to 2.4000000000000004 (classic IEEE-754 floating-point); switched to `Math.abs(r.score - 2.4) < 1e-9` with an explanatory comment. (b) F125 buildTestImpactBlock orphan-truncation test asserted `/\.\.\.and 10 more/` but the source uses the Unicode horizontal ellipsis `\u2026` for the truncation marker, not three ASCII dots; switched the regex to `/\u2026and 10 more/` + added a comment noting that a regression to ASCII dots would now surface here. Both were test-only fixes (zero source changes); applied via `--fixup` + autosquash so each feature commit stays self-passing. SHAs above reflect post-rebase state. Also note: the temp disk on the cron host was at 100% (125Mi free) when this tick started which produced "No space left on device" errors on shell-snapshot writes; cleared ~ 530MB via `rm -rf ~/Library/Caches/{go-build,electron,Homebrew,node-gyp}` which restored normal shell operation.

- 2026-06-23 11:05 PT — 5 features shipped: F128 `203a94b`, F129 `4ae16f5`, F130 `f30b741`, F131 `d534a25`, F132 `188146b`. Gate: lint ok, compile ok, 2210/2210 tests green (2093 -> 2210, +117 new). New configs: 3 (defaultReviewers.loadBalancer = 1; testImpactPrBody.autoSync = 1; branchProtectionSuggest.autoOfferOnCreate = 1). New commands: 1 (importStashPatch — F128/F129/F130 hook into existing commands in place; F132 lives entirely inside the commit-graph webview). New pure helpers: 5 patches across existing modules + 1 new file: composeReviewerRanking + describeSuggestionWithLoadScore (defaultReviewers.ts); hasTestImpactBlock + classifyAutoSync + TestImpactAutoSyncOutcome (testImpactPrBody.ts); shouldAutoOfferProtection + describeAutoOfferRationale (branchProtectionSuggest.ts); buildPrintHtml + classifyPdfExport + estimateSvgBytes + widened buildExportFilename (commitGraphExport.ts); NEW src/git/stashPatchImport.ts with 11 exports (inspectPatchPayload + parseGitSightFilename + classifyApplyResult + buildPatchPickerLabel + buildPatchPickerDetail + sortPatchCandidates). New view-layer files: 1 (stashPatchImport.ts). New view-layer hooks: 3 (runTestImpactAutoSyncFireAndForget after push; offerProtectionForNewBranch after createBranch; load-score fetch parallel-Promise.all into showDefaultReviewersPicker). New webview wiring: 1 (Export PDF button + printPdf message handler + iframe-based print flow in commitGraph.ts). New tests: 117 across 5 files (F128: 17 in composeReviewerRanking.test.ts — composition priority + tier invariant + tiebreakers + describe-output shapes; F129: 17 in testImpactAutoSync.test.ts — hasTestImpactBlock across malformed marker pairs + classifyAutoSync 4-state coverage + nonsense-timestamp tolerance + exhaustiveness gate; F130: 25 in branchProtectionAutoOffer.test.ts — every BranchRole -> verdict mapping + 9-shape composition coverage + describeAutoOfferRationale per role; F131: 34 in stashPatchImport.test.ts — 8 payload shapes + 4 filename parses + 10 classifyApplyResult states + 5 picker shapes + 4 sorting invariants; F132: 24 in commitGraphPdfExport.test.ts — PDF filename + 11 buildPrintHtml structural + 6 classifyPdfExport states + 5 estimateSvgBytes shapes). Notable patterns added: (1) composeReviewerRanking returns `{ ranked, source }` discriminated shape so the view layer can render the source-specific description without re-deriving the verdict; (2) `anyMatch` invariant when picking load-score over round-robin — even partial coverage of scoresByHandle wins because unknown handles get +Inf and sort below all known; (3) race-with-timeout helper for opportunistic gh round-trips that should never block a picker; (4) fire-and-forget hook pattern from F77 cleanly extended to test-impact (mirror copy + same structural-outcome contract); (5) session-only dismissed-branches cache via module-level Set, keyed by lowercased branch name so re-creating after Dismiss stays silent; (6) `classifyApplyResult` rejected-wins-over-already-applied tiebreak — when stderr mentions both, the actual failure wins because we can't claim already-applied when git also said "hunk #1 failed"; (7) `extractConflictedFiles` uses a fresh regex object per call to avoid sticky lastIndex bugs; (8) PDF export via iframe.contentWindow.print() with hidden + 0x0 + visibility:hidden + aria-hidden styling so the print iframe doesn't disturb the visible UI; (9) escapeXml-protected title in buildPrintHtml so a hostile title input can't inject a <script> tag into the print document; (10) `computeTestImpactSummary` cancellation token made optional with a never-cancelled stub for the fire-and-forget code path that doesn't have a Progress notification in scope.

