// Standalone renderer that imports the real commitGraph code and outputs HTML
// for a chosen repo. Used for README screenshots.
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const repo = process.argv[2] || process.cwd();
const out  = process.argv[3] || '/tmp/gitsight-graph.html';

const SEP = '\x1f', RECSEP = '\x1e';
const fmt = ['%H','%h','%P','%an','%ae','%aI','%s','%b','%D'].join(SEP) + RECSEP;
const raw = execFileSync('git', ['log', `--pretty=format:${fmt}`, '--max-count=80', '--all'],
  { cwd: repo, maxBuffer: 50*1024*1024 }).toString();

const commits = raw.split(RECSEP).map(s=>s.trim()).filter(Boolean).map(rec=>{
  const [sha,shortSha,parents,author,email,date,subject,body,refs] = rec.split(SEP);
  return {
    sha, shortSha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author, email, date: new Date(date),
    subject, body: body||'',
    refs: refs ? refs.split(',').map(s=>s.trim()).filter(Boolean) : [],
  };
});

// Import the real implementation
const { renderGraphStandalone } = require('./renderGraphStandalone.js');
const html = renderGraphStandalone(commits);

// Wrap with a dark-theme stylesheet that simulates VS Code dark+ tokens
const wrapped = `<!doctype html>
<html><head><meta charset="utf-8"><title>GitSight Commit Graph</title>
<style>
  :root {
    --vscode-font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    --vscode-editor-font-family: "SF Mono", Menlo, Consolas, monospace;
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1e1e1e;
    --vscode-editorWidget-background: #181818;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-panel-border: #2b2b2b;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #4d4d4d;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-button-secondaryHoverBackground: #45494e;
    --vscode-toolbar-hoverBackground: #383b3d;
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #ffffff;
  }
  html, body { background: #1e1e1e; margin: 0; }
</style></head>
<body>${html}</body></html>`;

fs.writeFileSync(out, wrapped);
console.log(out);
