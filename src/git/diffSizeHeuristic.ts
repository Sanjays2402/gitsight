/**
 * Pure helpers for the SCM Diff-Size Heuristic (F90).
 *
 * Given a `git diff --cached --shortstat --numstat` output, classify the
 * staged change into a size tier:
 *
 *   ok       — small enough to ship as one commit
 *   warning  — large but not absurd; suggest splitting if the user is
 *              composing a fix/feat (style/chore are exempt — those are
 *              naturally big when run repo-wide)
 *   noisy    — dominated by lockfile / generated-file noise; suggest
 *              committing the lockfile separately or adding it to
 *              .gitignore (when applicable)
 *   huge     — way past any reasonable per-commit size; strongly
 *              suggest split
 *
 * The classifier is parametric on three knobs:
 *   - lineThreshold: total +/- lines (default 400)
 *   - fileThreshold: total changed files (default 20)
 *   - hugeLineThreshold: red-line for definitely-too-large (default 2000)
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/diffSizeHeuristic.test.ts.
 */

export type DiffSizeSeverity = 'ok' | 'warning' | 'noisy' | 'huge';

export interface DiffNumstatRow {
  added: number;
  deleted: number;
  path: string;
  isBinary: boolean;
}

export interface DiffSizeStats {
  files: number;
  added: number;
  deleted: number;
  total: number;
  /** Per-file rows for noisy detection + tooltip. */
  rows: DiffNumstatRow[];
  /** Set of paths recognised as lockfiles / generated / vendored. */
  noisyPaths: string[];
  /** Total +/- contributed by noisyPaths (subset of total). */
  noisyLines: number;
}

/**
 * Parse `git diff --cached --numstat` output. Each row is:
 *
 *   <added>\t<deleted>\t<path>
 *
 * Binary files emit `-\t-\t<path>`. We mark those as `isBinary` and
 * count them as 0/0 lines — the file-count still increments.
 *
 * Handles the rename form too:
 *
 *   <added>\t<deleted>\t<old> => <new>
 *   <added>\t<deleted>\tprefix/{old => new}
 *
 * The path returned for renames is the new path (we never report on the
 * old one to keep the noisy-classifier consistent).
 */
export function parseNumstat(raw: string): DiffNumstatRow[] {
  if (!raw) return [];
  const out: DiffNumstatRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tab1 = line.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const addedTok = line.slice(0, tab1).trim();
    const deletedTok = line.slice(tab1 + 1, tab2).trim();
    const pathTok = line.slice(tab2 + 1).trim();
    if (!pathTok) continue;
    const isBinary = addedTok === '-' && deletedTok === '-';
    const added = isBinary ? 0 : Number(addedTok) || 0;
    const deleted = isBinary ? 0 : Number(deletedTok) || 0;
    out.push({ added, deleted, path: rewriteRenamePath(pathTok), isBinary });
  }
  return out;
}

function rewriteRenamePath(p: string): string {
  // Brace form: `prefix/{old => new}` -> `prefix/new`
  const brace = /\{([^{}]*) => ([^{}]*)\}/.exec(p);
  if (brace) {
    return p.slice(0, brace.index) + brace[2] + p.slice(brace.index + brace[0].length);
  }
  // Simple `old => new` form.
  const arrow = p.indexOf(' => ');
  if (arrow > 0) return p.slice(arrow + 4).trim();
  return p;
}

/**
 * Lockfile / generated / vendored patterns the heuristic deflates so a
 * "I bumped my deps" commit doesn't trigger a false-positive split
 * suggestion. The lockfile set MUST be kept in sync with the F28
 * lockfileWatch ecosystem list; this is the same set minus the
 * directory-only entries (which we keep separately).
 */
const NOISY_FILENAMES = new Set<string>([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'gemfile.lock',
  'cargo.lock',
  'go.sum',
  'composer.lock',
  'mix.lock',
  'podfile.lock',
  'flake.lock',
]);

const NOISY_PREFIXES = [
  'vendor/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  'out/',
  'out-test/',
  'target/',
  'coverage/',
  '__snapshots__/',
];

const NOISY_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.bundle.css',
  '.map',          // sourcemaps
  '.snap',         // jest snapshots
  '.golden',
  '.expected',
];

export function isNoisyPath(p: string): boolean {
  if (!p) return false;
  const lower = p.toLowerCase();
  const base = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
  if (NOISY_FILENAMES.has(base)) return true;
  for (const pre of NOISY_PREFIXES) {
    if (lower === pre.slice(0, -1)) return true;
    if (lower.startsWith(pre)) return true;
    if (lower.includes('/' + pre)) return true;
  }
  for (const suf of NOISY_SUFFIXES) {
    if (lower.endsWith(suf)) return true;
  }
  return false;
}

/**
 * Aggregate per-file rows into top-level stats + a noisy-paths sidecar.
 */
export function computeDiffStats(rows: DiffNumstatRow[]): DiffSizeStats {
  let added = 0;
  let deleted = 0;
  const noisyPaths: string[] = [];
  let noisyLines = 0;
  for (const r of rows) {
    added += r.added;
    deleted += r.deleted;
    if (isNoisyPath(r.path)) {
      noisyPaths.push(r.path);
      noisyLines += r.added + r.deleted;
    }
  }
  return {
    files: rows.length,
    added,
    deleted,
    total: added + deleted,
    rows,
    noisyPaths,
    noisyLines,
  };
}

export interface ClassifyArgs {
  stats: DiffSizeStats;
  /** Total +/- threshold above which we warn. */
  lineThreshold: number;
  /** File-count threshold above which we warn. */
  fileThreshold: number;
  /** Above this lines OR files, we emit `huge`. */
  hugeLineThreshold: number;
  /** Fraction of noisy lines/total above which we report `noisy` instead of `warning`. */
  noisyDominanceThreshold: number;
  /** Subject prefix (conventional-commit type) — style/chore are exempt from `warning`. */
  subjectType?: string;
}

export interface DiffSizeDecision {
  severity: DiffSizeSeverity;
  /** Short label for status-bar pill. */
  pillLabel: string;
  /** One-line picker description. */
  summary: string;
  /** Multi-line detail for the QuickPick / tooltip. */
  detail: string;
  /** Quick suggestions the picker offers. */
  suggestions: string[];
}

const EXEMPT_TYPES = new Set(['style', 'chore', 'docs', 'ci', 'build']);

export function classifyDiffSize(args: ClassifyArgs): DiffSizeDecision {
  const { stats, lineThreshold, fileThreshold, hugeLineThreshold, noisyDominanceThreshold, subjectType } = args;
  const { files, added, deleted, total, noisyLines } = stats;
  const noisyFraction = total > 0 ? noisyLines / total : 0;
  const exempt = subjectType ? EXEMPT_TYPES.has(subjectType.toLowerCase()) : false;
  const sizeDesc = `${files} file${files === 1 ? '' : 's'} \u00b7 +${added} -${deleted}`;

  if (total === 0 && files === 0) {
    return {
      severity: 'ok',
      pillLabel: 'staged: empty',
      summary: 'No staged changes.',
      detail: 'There is nothing in the staging area yet.',
      suggestions: [],
    };
  }

  if (total >= hugeLineThreshold && noisyFraction < 0.7) {
    return {
      severity: 'huge',
      pillLabel: `huge diff: ${sizeDesc}`,
      summary: `Huge staged diff: ${sizeDesc}. Strongly consider splitting.`,
      detail: [
        `Total +${added} / -${deleted} across ${files} file${files === 1 ? '' : 's'}.`,
        `That's ${total} changed lines — way past a clean per-commit slice.`,
        noisyLines > 0 ? `${noisyLines} of those lines are lockfile/generated noise (\u2248${pct(noisyFraction)}).` : '',
        '',
        'Suggestions:',
        '- Stage one logical change at a time (git reset HEAD <unrelated paths>, then re-stage)',
        '- Split into multiple commits (e.g. feat + tests + refactor)',
        '- If this is a generated-output dump, commit lockfiles/snapshots separately',
      ].filter(Boolean).join('\n'),
      suggestions: [
        'Split into multiple commits',
        'Unstage some files',
        'Commit lockfile separately',
      ],
    };
  }

  if (noisyFraction >= noisyDominanceThreshold && noisyLines > 0) {
    return {
      severity: 'noisy',
      pillLabel: `noisy diff: ${sizeDesc}`,
      summary: `${sizeDesc} (${pct(noisyFraction)} lockfile/generated noise).`,
      detail: [
        `${sizeDesc}.`,
        `${noisyLines} of ${total} lines are lockfile / generated / vendored content (\u2248${pct(noisyFraction)}).`,
        '',
        'Suggestions:',
        '- Commit the lockfile/build artefact as its own `chore(deps): bump lockfile` commit',
        '- Or add the generated path to `.gitignore` if it shouldn\'t be tracked',
        '- The real change is buried; reviewers will struggle to spot it',
      ].join('\n'),
      suggestions: [
        'Unstage lockfile / generated files',
        'Open .gitignore',
      ],
    };
  }

  if (total >= lineThreshold || files >= fileThreshold) {
    if (exempt) {
      return {
        severity: 'ok',
        pillLabel: `staged: ${sizeDesc}`,
        summary: `${sizeDesc} (large but exempt for ${subjectType}).`,
        detail: `Large staged diff (${total} lines, ${files} files) but the commit type "${subjectType}" is exempt from split suggestions.`,
        suggestions: [],
      };
    }
    return {
      severity: 'warning',
      pillLabel: `large diff: ${sizeDesc}`,
      summary: `${sizeDesc}. Consider splitting into smaller commits.`,
      detail: [
        `${sizeDesc} (${total} total line${total === 1 ? '' : 's'}).`,
        total >= lineThreshold ? `Above the ${lineThreshold}-line warning threshold.` : '',
        files >= fileThreshold ? `Above the ${fileThreshold}-file warning threshold.` : '',
        '',
        'Suggestions:',
        '- Reviewers struggle with diffs > ~400 lines; smaller commits land faster',
        '- Tip: `git reset HEAD <path>` to unstage; `git add -p` to stage hunks selectively',
        '- Style/chore-only sweeps can use the type prefix to skip this warning',
      ].filter(Boolean).join('\n'),
      suggestions: [
        'Use git add -p',
        'Unstage some files',
      ],
    };
  }

  return {
    severity: 'ok',
    pillLabel: `staged: ${sizeDesc}`,
    summary: `${sizeDesc} — within healthy commit size.`,
    detail: `${sizeDesc}. Below the ${lineThreshold}-line / ${fileThreshold}-file warning thresholds.`,
    suggestions: [],
  };
}

function pct(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Extract the conventional-commit `type` from the first line of the SCM
 * input, if present. Used to exempt `style`/`chore`/`docs` commits from
 * the warning tier (those are naturally big when run repo-wide).
 *
 *   "feat(git): foo"  -> "feat"
 *   "chore: bar"      -> "chore"
 *   "WIP"             -> undefined
 *   ""                -> undefined
 */
export function extractSubjectType(scmInput: string | undefined): string | undefined {
  if (!scmInput) return undefined;
  const first = scmInput.split('\n', 1)[0] ?? '';
  const m = /^([a-z]+)(?:\([^)]+\))?!?:\s/.exec(first);
  return m ? m[1] : undefined;
}
