# Changelog

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
