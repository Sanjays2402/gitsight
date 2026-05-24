# Changelog

## 1.6.0 — 2026-05-24
### Added
- **Worktree quick-switcher** — `GitSight: Switch Worktree…` (Cmd+Shift+W / Ctrl+Shift+W) opens a quick-pick listing every worktree with branch, lock status, and current-marker. One click opens it in a new VS Code window. Inline shortcuts for *Create new worktree…* and *Remove a worktree…*.
- Keybinding `Cmd+Alt+M` / `Ctrl+Alt+M` for `GitSight: Pick AI Model`.

## 1.5.0 — 2026-05-24
### Changed — Enterprise AI
- **GitHub Copilot is now the only supported AI provider.** Removed Ollama and any local-model code paths so GitSight is safe to deploy in enterprise environments (Microsoft, regulated orgs, etc.) where local LLMs and third-party API keys are prohibited.
- Added **`GitSight: Pick AI Model`** — quick-pick lists every Copilot Chat model the user has access to (GPT-4o, Claude Sonnet, o1, etc.) and persists the choice in `globalState`.
- Added **`GitSight: Sign in to GitHub Copilot`** — one-click sign-in / install prompt when no Copilot models are detected. Routes through the official `GitHub.copilot-chat` extension.
- Added **`GitSight: Show AI Status / Available Models`** — diagnostic command showing active model + every model the user can pick from.
- AI commit messages and commit explanations now route through the selected Copilot model.

## 1.4.0 — 2026-05-24
### Added
- **Filter Pull Requests by author** — three new commands in the PR view title bar:
  - `Filter Pull Requests by Author…` → quick-pick with `@me`, all current PR authors, custom input.
  - `Show My Pull Requests (@me)` → one-click "just mine" view (resolves login via `gh api user` / `az account show`).
  - `Clear PR Author Filter` (only shown when a filter is active).
- Persistent filter — selection survives reloads via `workspaceState`.
- Inline filter chip at top of PR sidebar (click ✕ to clear) + group counts show `N of TOTAL` while filtered.

## 1.3.0 — 2026-05-24
### Added
- **Split-diff range viewer** — Compare any two refs (`main` ↔ `feature/foo`) in a GitHub-style side-by-side view with file tree, per-file +/- stats, and chunk-level highlighting. Command: `GitSight: Compare Refs (Split Diff)`.
- **Merge conflict 3-pane resolver** — Visual conflict resolution with Accept Ours / Accept Theirs / Accept Both / Edit per chunk. Saves and stages in one click. Command: `GitSight: Resolve Merge Conflicts`.
- **GitHub Issues sidebar** — Full Issues view alongside Pull Requests. Filter by All / Assigned to Me / Created by Me. Click any issue to open a rich webview with full body and comment thread. Backed by `gh` CLI.
- **Contribution Activity Heatmap** — GitHub-style year-long contribution grid with current streak, longest streak, total commits, active days. Filter by author. Pure local git log — no API calls.

## 1.2.0 — 2026-05-24
### Added
- **Azure DevOps support** — Pull Requests sidebar now auto-detects ADO remotes (`dev.azure.com`, legacy `*.visualstudio.com`) and lists PRs via `az repos pr` CLI alongside existing GitHub support.
- Multi-provider PR abstraction (`PrProvider` interface) — easy path to GitLab/Bitbucket next.
- Provider badge in PR sidebar + webview ("GitHub" / "Azure DevOps").
- Remote URL parser (`hostDetect.ts`) supporting GitHub, ADO (new + legacy), GitLab, Bitbucket with correct commit/PR/MR web URLs per host.

### Changed
- PR sidebar gracefully degrades with actionable error messages when `gh` or `az` CLI is missing / unauthenticated.
- `gitsight.openPr` webview now provider-aware (renders ADO reviewer vote → APPROVED/REJECTED/WAITING_FOR_AUTHOR).

## 1.1.0 — 2026-05-24
### Added
- Blame Heatmap webview — full-file blame with red→blue heat strip, author dots, legend.
- Interactive Rebase webview — drag-to-reorder commits, action dropdowns, inline message editing. Applies via `git rebase -i` with temp sequencer editor.
- Historic file virtual filesystem (`gitsight://`) — open any file at any commit as a real editor tab; supports diff-against-working.
- GitHub Pull Requests sidebar — grouped by Open/Draft/Merged/Closed, status check + review badges, rich PR webview, checkout command. Requires `gh` CLI.
- Standalone screenshot renderers in `scripts/` for documentation/marketplace listing.

### Changed
- Sidebar grew from 11 to 12 tree views.
- README expanded with screenshots for all major features.

## 1.0.0 — 2026-05-24
### Added
- Initial release. Commit Graph webview, inline blame, file/line history, worktrees, branches, tags, stashes, contributors, remotes, AI commit messages, AI commit explanations, status bar.
