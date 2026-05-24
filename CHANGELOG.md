# Changelog

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
