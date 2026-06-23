/**
 * Pure helpers for F122 - per-PR test-impact suggester.
 *
 * Given a list of files changed in a PR (or in `<base>..HEAD`), suggest
 * the test files most likely to exercise them based on:
 *
 *   1. Direct imports - tests that `import` / `require` from any
 *      changed source file (the strongest signal).
 *   2. Path co-location - changed file `foo/bar/baz.ts` -> any test
 *      file under `foo/bar/__tests__/`, `foo/bar/baz.test.ts`,
 *      `foo/bar/baz.spec.ts`.
 *   3. Naming siblings - `src/foo.ts` -> `test/foo.test.ts` or
 *      `tests/test_foo.py` (covers Python / Rust / Go conventions
 *      via configurable suffixes).
 *
 * The view layer is responsible for running the actual `git grep`s;
 * this module owns the parsing + ranking + dedupe + path-normalisation.
 *
 * Pure - no fs, no vscode. Tests in test/git/testImpact.test.ts.
 */

export type TestSignal = 'import' | 'co-located' | 'naming-sibling';

export interface TestImpactRow {
  /** Repo-relative path of the suggested test file. */
  testFile: string;
  /** Source files that suggest this test. */
  sourceFiles: string[];
  /** Signals that led to this test surfacing (deduped). */
  signals: TestSignal[];
  /** Numeric rank score - higher = stronger match. Used for sorting. */
  score: number;
}

export interface TestImpactSummary {
  rows: TestImpactRow[];
  /** Total source files considered (after filtering non-source). */
  consideredSources: number;
  /** Source files that had at least one suggestion. */
  coveredSources: number;
  /** Source files that didn't produce any suggestion. */
  orphanSources: string[];
}

/**
 * Recognised test-file suffix patterns. Each entry matches a basename
 * (NOT a full path). Used for both detection (is X a test?) and for
 * naming-sibling generation (given foo.ts, what test names might
 * exist?).
 */
export const TEST_SUFFIX_PATTERNS: RegExp[] = [
  /\.(?:test|spec)\.[jt]sx?$/i,    // JS/TS: foo.test.ts, foo.spec.js
  /\.test\.tsx?$/i,                 // explicit TSX
  /_test\.go$/i,                    // Go: foo_test.go
  /_(?:test|spec)\.rs$/i,           // Rust: foo_test.rs
  /^test_.*\.py$/i,                 // Python: test_foo.py
  /_test\.py$/i,                    // Python alt: foo_test.py
  /\.test\.rb$/i,                   // Ruby: foo.test.rb
  /_spec\.rb$/i,                    // Ruby/RSpec: foo_spec.rb
  /\.cy\.[jt]sx?$/i,                // Cypress: foo.cy.ts
];

/**
 * Identify any test files in a list. Useful for the "tests changed
 * directly" sub-feed.
 */
export function isTestFile(path: string): boolean {
  if (!path) return false;
  const basename = path.split('/').pop() ?? '';
  if (TEST_SUFFIX_PATTERNS.some(rx => rx.test(basename))) return true;
  // Tests under `__tests__/` or `tests/` directories are also considered
  // tests even without a suffix match (some teams use plain names there).
  const lower = path.toLowerCase();
  if (/(^|\/)__tests__\//.test(lower)) return true;
  return false;
}

/**
 * Filter to source files only (drop tests + non-source binaries).
 */
export function isSourceFile(path: string): boolean {
  if (!path) return false;
  if (isTestFile(path)) return false;
  const lower = path.toLowerCase();
  if (/\.(?:md|json|lock|yaml|yml|toml|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|otf|eot)$/i.test(lower)) return false;
  if (/(?:^|\/)package-lock\.json$/i.test(lower)) return false;
  if (/(?:^|\/)yarn\.lock$/i.test(lower)) return false;
  if (/(?:^|\/)pnpm-lock\.yaml$/i.test(lower)) return false;
  return true;
}

/**
 * Generate plausible test-file paths for a given source file.
 *
 *   src/foo/bar.ts -> [
 *     src/foo/bar.test.ts, src/foo/bar.spec.ts,
 *     src/foo/__tests__/bar.test.ts, src/foo/__tests__/bar.ts,
 *     test/foo/bar.test.ts, tests/foo/bar.test.ts,
 *   ]
 *
 *   foo/bar.py -> [foo/test_bar.py, tests/test_bar.py, foo/bar_test.py]
 *
 * Returned paths are CANDIDATES; the caller does an existence-check
 * before scoring them.
 */
export function generateSiblingCandidates(sourcePath: string): string[] {
  const out = new Set<string>();
  const parts = sourcePath.split('/');
  const basename = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  const ext = extOf(basename);
  const stem = basename.slice(0, basename.length - ext.length);

  // JS / TS suffix variants
  if (/^\.(?:[jt]sx?)$/.test(ext)) {
    for (const suf of ['.test', '.spec']) {
      out.add(joinPath(dir, `${stem}${suf}${ext}`));
      out.add(joinPath(dir, '__tests__', `${stem}${suf}${ext}`));
      out.add(joinPath(dir, '__tests__', `${stem}${ext}`));
    }
    // top-level test/ or tests/ root
    if (dir.startsWith('src/')) {
      const inner = dir.slice('src/'.length);
      out.add(joinPath('test', inner, `${stem}.test${ext}`));
      out.add(joinPath('tests', inner, `${stem}.test${ext}`));
      out.add(joinPath('__tests__', inner, `${stem}.test${ext}`));
    } else {
      out.add(joinPath('test', dir, `${stem}.test${ext}`));
    }
  }

  // Python variants
  if (ext === '.py') {
    out.add(joinPath(dir, `test_${stem}${ext}`));
    out.add(joinPath(dir, `${stem}_test${ext}`));
    out.add(joinPath('tests', `test_${stem}${ext}`));
    out.add(joinPath('tests', dir, `test_${stem}${ext}`));
  }

  // Go convention (foo.go -> foo_test.go in same dir)
  if (ext === '.go') {
    out.add(joinPath(dir, `${stem}_test${ext}`));
  }

  // Rust (foo.rs -> foo_test.rs OR tests/<crate>/foo_test.rs)
  if (ext === '.rs') {
    out.add(joinPath(dir, `${stem}_test${ext}`));
    out.add(joinPath(dir, 'tests', `${stem}.rs`));
  }

  // Ruby (foo.rb -> spec/foo_spec.rb / test/foo_test.rb)
  if (ext === '.rb') {
    out.add(joinPath('spec', dir, `${stem}_spec${ext}`));
    out.add(joinPath('test', dir, `${stem}_test${ext}`));
  }

  return Array.from(out).filter(Boolean);
}

function extOf(basename: string): string {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return '';
  return basename.slice(dot);
}

function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map(p => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * Compose a TestImpactSummary from per-source signals.
 *
 * `importMatches` maps test file path -> source files that test
 * imports. `coLocated` and `namingSiblings` are the other two signal
 * sets (test-file -> source-files map).
 */
export interface ImpactInput {
  /** Source files changed in the PR (already filtered via isSourceFile). */
  sourceFiles: string[];
  /** Test files changed in the PR (already filtered via isTestFile). */
  testFilesChanged: string[];
  /** Map test-file path -> source-file paths that test imports. */
  importMatches: Record<string, string[]>;
  /** Map test-file path -> source-file paths it sits alongside. */
  coLocated: Record<string, string[]>;
  /** Map test-file path -> source-file paths whose naming siblings it matches. */
  namingSiblings: Record<string, string[]>;
}

export function composeImpact(input: ImpactInput): TestImpactSummary {
  const rows = new Map<string, TestImpactRow>();
  const addRow = (testFile: string, sources: string[], signal: TestSignal, weight: number) => {
    const existing = rows.get(testFile);
    if (existing) {
      for (const s of sources) {
        if (!existing.sourceFiles.includes(s)) existing.sourceFiles.push(s);
      }
      if (!existing.signals.includes(signal)) existing.signals.push(signal);
      existing.score += weight * sources.length;
      return;
    }
    rows.set(testFile, {
      testFile,
      sourceFiles: [...sources],
      signals: [signal],
      score: weight * sources.length,
    });
  };

  // Direct imports: highest weight. The PR's own tests don't count
  // as imports (they're already changed).
  for (const [testFile, srcs] of Object.entries(input.importMatches)) {
    if (input.testFilesChanged.includes(testFile)) continue;
    if (srcs.length === 0) continue;
    addRow(testFile, srcs, 'import', 10);
  }

  // Co-located: same directory. Medium weight.
  for (const [testFile, srcs] of Object.entries(input.coLocated)) {
    if (input.testFilesChanged.includes(testFile)) continue;
    if (srcs.length === 0) continue;
    addRow(testFile, srcs, 'co-located', 5);
  }

  // Naming-sibling: same stem under a sibling test dir. Low weight.
  for (const [testFile, srcs] of Object.entries(input.namingSiblings)) {
    if (input.testFilesChanged.includes(testFile)) continue;
    if (srcs.length === 0) continue;
    addRow(testFile, srcs, 'naming-sibling', 3);
  }

  const list = Array.from(rows.values());
  // Sort: score desc, then by source-count desc (more touched sources first),
  // then by testFile asc for stability.
  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.sourceFiles.length !== a.sourceFiles.length) return b.sourceFiles.length - a.sourceFiles.length;
    return a.testFile.localeCompare(b.testFile);
  });

  // Compute orphan sources: source files that didn't appear in any
  // row's sourceFiles list.
  const coveredSet = new Set<string>();
  for (const r of list) for (const s of r.sourceFiles) coveredSet.add(s);
  const orphanSources = input.sourceFiles.filter(s => !coveredSet.has(s)).sort();

  return {
    rows: list,
    consideredSources: input.sourceFiles.length,
    coveredSources: coveredSet.size,
    orphanSources,
  };
}

/**
 * Format the picker header summary.
 *
 *   "test impact - 12 tests cover 5/8 sources (3 orphans)"
 *   "no test impact found"
 */
export function formatImpactHeader(s: TestImpactSummary): string {
  if (s.rows.length === 0 && s.consideredSources === 0) return 'no source files changed';
  if (s.rows.length === 0) return `no test impact found for ${s.consideredSources} source file${s.consideredSources === 1 ? '' : 's'}`;
  const orphans = s.orphanSources.length;
  return `test impact - ${s.rows.length} test${s.rows.length === 1 ? '' : 's'} cover ${s.coveredSources}/${s.consideredSources} source${s.consideredSources === 1 ? '' : 's'}${orphans ? ` (${orphans} orphan${orphans === 1 ? '' : 's'})` : ''}`;
}

/**
 * Build the markdown report body for the "Open full report" action.
 */
export function buildImpactReport(s: TestImpactSummary): string {
  const lines: string[] = [];
  lines.push('# PR Test Impact');
  lines.push('');
  lines.push(`_${formatImpactHeader(s)}_`);
  lines.push('');
  if (s.rows.length === 0) {
    lines.push('No tests detected. Consider adding coverage for:');
    for (const orphan of s.orphanSources) lines.push(`- \`${orphan}\``);
    return lines.join('\n');
  }
  lines.push('## Suggested tests');
  lines.push('');
  lines.push('| Test | Score | Signals | Sources |');
  lines.push('| --- | ---:| --- | --- |');
  for (const row of s.rows) {
    lines.push(
      `| \`${escapePipe(row.testFile)}\` | ${row.score} | ${row.signals.join(', ')} | ${row.sourceFiles.length} |`,
    );
  }
  if (s.orphanSources.length) {
    lines.push('');
    lines.push('## Orphan sources (no suggested tests)');
    lines.push('');
    for (const orphan of s.orphanSources) lines.push(`- \`${orphan}\``);
  }
  return lines.join('\n');
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }

/**
 * Build a `git grep`-friendly regex matching any import of a given
 * source path. We match without extension and tolerate ./ or no
 * prefix.
 *
 *   src/foo/bar.ts -> /(?:from|require)\s*['"](?:\.{1,2}\/)*foo\/bar(?:\.[jt]sx?)?['"]/
 *
 * Caller wraps as `git grep -lE <pattern> -- '<dir>/*.test.ts' ...`
 */
export function buildImportProbe(sourcePath: string): { pattern: string; quoted: string } {
  // Strip leading src/ since most import paths are relative.
  const stripped = sourcePath.replace(/^src\//, '');
  const noExt = stripped.replace(/\.(?:[jt]sx?|py|go|rs|rb)$/, '');
  const escaped = noExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Two patterns: (a) "stripped path" form, (b) basename-only fallback.
  const pattern = `(from|require|import)\\s*[('"\`].*${escaped}[).'"\`]`;
  return { pattern, quoted: `'${pattern}'` };
}
