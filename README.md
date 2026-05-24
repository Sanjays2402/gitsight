# GitSight

**Git visualization for VS Code, supercharged.** A free, open-source alternative to GitLens — with the headline Pro features built in.

> Commit Graph. Inline Blame. File & Line History. Worktrees. Branch & Tag Explorer. Compare. AI Commit Messages. All free.

## Features

### 🔀 Commit Graph
Multi-lane interactive graph webview with all branches, refs (branches/tags/HEAD highlighted), authors, and dates. Live search, click any commit for the full diff, click any SHA to copy.

### 👤 Inline Blame
Current-line blame annotation showing author, age, and commit message. Fully configurable format.

### 🌡️ Heatmap & Author Gutter
- **Heatmap** — gutter dots colour-graded by commit age (hot = recent, cold = old).
- **Author gutter** — overview ruler stripe per author.

### 📜 File & Line History
- **File History** sidebar — every commit touching the active file (with rename tracking).
- **Line History** sidebar — every commit touching the current line (`git log -L`).

### 🌳 Worktrees (first-class)
Create, remove, switch. One-click "open in new window."

### 🌿 Branch & Tag Explorer
- Local + remote branches grouped, with ahead/behind tracking.
- Checkout / rename / delete / merge / rebase / compare from the context menu.
- Tags sidebar with annotated tooltips, create/delete.

### ☁️ Remotes
List, add, remove. One-click open commits on GitHub/GitLab/Bitbucket.

### 📦 Stashes
List with branch + age. Apply / Pop / Drop / Save.

### 👥 Contributors
Top-100 contributors sorted by commit count.

### 🔍 Search & Compare
- Search commit messages across all branches.
- Compare any two branches with a unified diff view.

### ✨ AI Commit Messages & Explanations
- **Generate** — Conventional Commits message from your staged diff, written by GitHub Copilot's built-in Language Model API (no extra key) or Ollama (fully local).
- **Explain** — plain-English summary of any commit's intent + risk.

### ⚙️ Quick Branch Ops
Cherry-pick, revert, reset (soft/mixed/hard), checkout — right-click any commit.

### 📊 Status Bar
Current branch + ahead/behind indicator. Click to open the Commit Graph.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `gitsight.blame.enabled` | `true` | Inline blame annotation |
| `gitsight.blame.format` | `${author}, ${ago} • ${message}` | Annotation template |
| `gitsight.blame.delay` | `200` | Delay before annotation appears (ms) |
| `gitsight.heatmap.enabled` | `false` | Gutter heatmap by commit age |
| `gitsight.heatmap.coldDays` | `365` | Days at which a line is fully "cold" |
| `gitsight.authors.enabled` | `false` | Per-line author colour in overview ruler |
| `gitsight.statusBar.enabled` | `true` | Status bar branch info |
| `gitsight.graph.maxCommits` | `1000` | Max commits in graph |
| `gitsight.graph.showAllBranches` | `true` | Include all branches in graph |
| `gitsight.ai.provider` | `copilot` | `copilot`, `ollama`, `none` |
| `gitsight.ai.model` | `gpt-4o-mini` | Model name (Ollama) |

## Develop

```bash
npm install
npm run compile
# F5 in VS Code → Extension Development Host
```

## Package & Install

```bash
npm run package         # outputs gitsight-1.0.0.vsix
code --install-extension gitsight-1.0.0.vsix
```

## Why?

GitLens is excellent, but its highest-value features — Commit Graph, Worktrees view, AI commits, search & compare — sit behind a Pro subscription. GitSight delivers those features, free and open, with a smaller install footprint and a clean modern UI.

## License

MIT. Contributions welcome.
