/**
 * Pure helpers for the Pre-Commit Hook Bridge (F45).
 *
 * When a `.git/hooks/pre-commit` script fails on commit, the user gets a
 * raw dump from whatever tool fired (eslint / prettier / tsc / lint-staged /
 * husky / a hand-rolled shell script). The output format varies wildly and
 * the actionable bits are buried.
 *
 * This module classifies the hook output into:
 *   - the runner (which framework/tool produced it)
 *   - per-file findings (path + optional line + optional message)
 *   - whether the failure is fixable with `--no-verify` (almost always yes,
 *     it just bypasses the hook) and whether re-staging is plausible
 *
 * The controller turns this into a quick-pick with "Open file at line N",
 * "Copy --no-verify command", "Show full hook output", and "Disable hook".
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/preCommitBridge.test.ts.
 */

export type PreCommitRunner =
  | 'husky-lint-staged'
  | 'lint-staged'
  | 'husky'
  | 'eslint'
  | 'prettier'
  | 'tsc'
  | 'pre-commit'   // the Python pre-commit framework
  | 'rubocop'
  | 'black'
  | 'shellscript'  // hand-rolled shell hook with no recognisable tool output
  | 'unknown';

export interface PreCommitFinding {
  /** Absolute or repo-relative file path mentioned in the failure. */
  file: string;
  /** 1-indexed line number, when the tool emitted one. */
  line?: number;
  /** 1-indexed column number, when present. */
  column?: number;
  /** Short human description ("error: 'foo' is defined but never used"). */
  message: string;
  /** Rule id when present (e.g. "no-unused-vars", "prettier/prettier"). */
  rule?: string;
  /** Tool/runner that produced this finding. */
  source: PreCommitRunner;
}

export interface PreCommitResult {
  /** Best-effort runner identification, derived from the output text. */
  runner: PreCommitRunner;
  /** Parsed findings (one per "file [line] message"). */
  findings: PreCommitFinding[];
  /** Raw hook output, lightly trimmed. */
  raw: string;
  /** The hook's exit code; 0 means success and the bridge is moot. */
  exitCode: number;
  /** True when there's at least one finding pointing at a file we can open. */
  hasOpenableTarget: boolean;
}

/**
 * Identify the runner from hook output. Detection is keyword-anchored to
 * the distinctive sentences each tool emits — no parsing the file list.
 */
export function detectRunner(raw: string): PreCommitRunner {
  const text = (raw ?? '').toLowerCase();
  if (/lint-staged/.test(text) && /husky/.test(text)) return 'husky-lint-staged';
  if (/lint-staged/.test(text)) return 'lint-staged';
  if (/husky\s*-\s*pre-commit/.test(text) || /husky\b/.test(text)) return 'husky';
  // pre-commit (Python framework) prints "[INFO] Running hook" / "Passed" / "Failed"
  if (/^\[info\]\s+running hook/m.test(text) || /^\[info\]\s+installing/m.test(text)) return 'pre-commit';
  if (/error\s+\S+\s+\(@typescript-eslint\)/.test(text) || /\beslint\b/.test(text)) return 'eslint';
  if (/\bprettier\b/.test(text) || /\[warn\]\s+code style issues/.test(text)) return 'prettier';
  if (/error ts\d+/.test(text) || /\btsc\b/.test(text)) return 'tsc';
  if (/\brubocop\b/.test(text)) return 'rubocop';
  if (/\bblack\b.*would reformat/.test(text)) return 'black';
  if (/\/bin\/(sh|bash)/.test(text) || /^\+ /m.test(text)) return 'shellscript';
  return 'unknown';
}

/**
 * Parse hook output into findings. We try several common formats and
 * coalesce; each line that looks like a finding is emitted once.
 *
 *   eslint:        /abs/path/foo.ts:12:5  error  'x' is defined…  no-unused-vars
 *   tsc:           src/foo.ts(12,5): error TS2304: Cannot find name 'foo'.
 *   prettier:      [warn] src/foo.ts
 *                  [warn] Code style issues found in the above file(s).
 *   pytest-style:  File "foo.py", line 12, in ...
 *   stylish/generic: foo.ts:12:5: error: ...
 *
 * Lines that don't match any pattern are skipped (NOT treated as findings).
 */
export function parseHookOutput(raw: string, runner: PreCommitRunner): PreCommitFinding[] {
  const out: PreCommitFinding[] = [];
  const seen = new Set<string>();
  const push = (f: PreCommitFinding) => {
    const key = `${f.file}:${f.line ?? ''}:${f.column ?? ''}:${f.message.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  const lines = (raw ?? '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;

    // 1. tsc / generic: `src/foo.ts(12,5): error TS2304: Cannot find name 'foo'.`
    let m = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning)(?:\s+([A-Z]+\d+))?:?\s*(.*)$/.exec(line);
    if (m && isPathish(m[1])) {
      push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: m[3] ? parseInt(m[3], 10) : undefined,
        message: m[6].trim() || m[4],
        rule: m[5] && /^(TS|E)\d+$/i.test(m[5]) ? m[5] : undefined,
        source: runner,
      });
      continue;
    }

    // 2. eslint "stylish": `  12:5  error  'x' is defined but never used  no-unused-vars`
    //    File path appears on its own preceding line.
    m = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(line);
    if (m) {
      // Look backwards for the most recent path-shaped line.
      const fileLine = findRecentPathLine(lines, i);
      if (fileLine) {
        push({
          file: fileLine,
          line: parseInt(m[1], 10),
          column: parseInt(m[2], 10),
          message: m[4].trim(),
          rule: m[5]?.trim(),
          source: runner,
        });
        continue;
      }
    }

    // 3. generic `path:line:col: message`
    m = /^(\S[^\s:]*?\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?:\s*(.+)$/.exec(line);
    if (m && isPathish(m[1])) {
      push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: m[3] ? parseInt(m[3], 10) : undefined,
        message: m[4].trim(),
        source: runner,
      });
      continue;
    }

    // 4. prettier `[warn] src/foo.ts` (no line info — open the file)
    m = /^\[(warn|error)\]\s+(\S+\.\S+)\s*$/i.exec(line);
    if (m && isPathish(m[2])) {
      push({
        file: m[2],
        message: 'Code style issues',
        source: runner,
      });
      continue;
    }

    // 5. Python: `File "foo.py", line 12`
    m = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)/.exec(line);
    if (m) {
      push({
        file: m[1],
        line: parseInt(m[2], 10),
        message: nextNonBlank(lines, i) ?? 'Python error',
        source: runner,
      });
      continue;
    }

    // 6. pre-commit framework: `- hook id: foo` + `- files were modified by this hook`
    m = /^\s*-\s+hook id:\s+(\S+)/.exec(line);
    if (m && i + 1 < lines.length) {
      const detail = lines.slice(i + 1, Math.min(lines.length, i + 6)).join(' ');
      const filePat = /(\S+\.\S+)/.exec(detail);
      if (filePat && isPathish(filePat[1])) {
        push({ file: filePat[1], message: `pre-commit hook '${m[1]}' modified files`, rule: m[1], source: runner });
      }
      continue;
    }
  }

  return out;
}

function findRecentPathLine(lines: string[], at: number): string | undefined {
  for (let j = at - 1; j >= Math.max(0, at - 30); j--) {
    const t = (lines[j] ?? '').trim();
    if (!t) continue;
    if (isPathish(t) && !/\s/.test(t)) return t;
    // eslint stylish puts the path bare on its own line; stop at a non-path
    // non-blank to avoid grabbing a header from way above.
    if (/^[A-Za-z\s].{0,40}$/.test(t)) return undefined;
  }
  return undefined;
}

function nextNonBlank(lines: string[], from: number): string | undefined {
  for (let j = from + 1; j < Math.min(lines.length, from + 10); j++) {
    const t = (lines[j] ?? '').trim();
    if (t) return t;
  }
  return undefined;
}

function isPathish(s: string): boolean {
  if (!s) return false;
  if (s.length > 400) return false;
  // Require at least one path separator OR a recognisable extension.
  return /[\\/]/.test(s) || /\.[a-zA-Z0-9]{1,8}$/.test(s);
}

export interface PreCommitSummary {
  /** Total finding count across all files. */
  total: number;
  /** Distinct files mentioned. */
  files: number;
  /** True when re-running the hook is unlikely to help (compiler errors etc.) */
  needsCodeEdit: boolean;
  /** True when re-staging the file might be enough (lint-staged auto-fixed). */
  rerunMaybeHelps: boolean;
}

const NEEDS_EDIT_RUNNERS: PreCommitRunner[] = ['eslint', 'tsc', 'rubocop'];

export function summarise(result: PreCommitResult): PreCommitSummary {
  const files = new Set(result.findings.map(f => f.file));
  return {
    total: result.findings.length,
    files: files.size,
    needsCodeEdit: NEEDS_EDIT_RUNNERS.includes(result.runner) && result.findings.length > 0,
    rerunMaybeHelps: result.runner === 'prettier' || result.runner === 'black' ||
                     (result.runner === 'husky-lint-staged' && /reformat|fixed/i.test(result.raw)),
  };
}

/**
 * Build the user-facing one-line summary used in the quick-pick header
 * and status-bar messages.
 */
export function describeResult(result: PreCommitResult): string {
  if (result.exitCode === 0) return 'pre-commit hook passed';
  if (!result.findings.length) {
    return `pre-commit hook failed (${result.runner}) — no parseable findings`;
  }
  const files = new Set(result.findings.map(f => f.file)).size;
  return `pre-commit (${result.runner}) — ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`;
}

/**
 * The escape-hatch command the user can run to bypass the hook.
 * Always returns a real, runnable string — no shell quoting needed since
 * git itself doesn't accept any extra args.
 */
export function bypassCommand(message?: string): string {
  if (!message) return 'git commit --no-verify';
  const escaped = message.replace(/'/g, `'\\''`);
  return `git commit --no-verify -m '${escaped}'`;
}
