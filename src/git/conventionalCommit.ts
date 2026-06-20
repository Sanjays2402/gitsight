/**
 * Pure helpers for the Conventional Commit Quick-Insert feature (F29).
 *
 * Conventional Commits canonical types:
 *   feat, fix, chore, docs, refactor, perf, test, build, ci, style, revert
 *
 * Scope auto-detection from a list of changed file paths picks the most
 * meaningful path segment shared by the largest cluster of files, e.g.:
 *
 *   ['src/git/git.ts', 'src/git/format.ts', 'src/views/sync.ts']  → 'git'
 *   ['src/extension.ts']                                          → 'extension'
 *   ['README.md']                                                 → 'docs'
 *
 * The composer writes a properly formatted header:
 *
 *   feat(scope): subject
 *   feat!: subject                ← breaking
 *   feat(scope)!: subject
 *
 * All pure. The picker UI lives in src/views/conventionalCommit.ts.
 */

export interface ConventionalType {
  type: string;
  /** Human description (shown as picker `description`). */
  description: string;
  /** Optional preferred default scope hint (e.g. 'deps' for build). */
  defaultScope?: string;
}

export const CONVENTIONAL_TYPES: ConventionalType[] = [
  { type: 'feat',     description: 'A new user-facing feature' },
  { type: 'fix',      description: 'A bug fix' },
  { type: 'docs',     description: 'Documentation only' },
  { type: 'refactor', description: 'Code change that neither fixes a bug nor adds a feature' },
  { type: 'perf',     description: 'Performance improvement' },
  { type: 'test',     description: 'Tests only' },
  { type: 'chore',    description: 'Tooling, infra, repo hygiene' },
  { type: 'build',    description: 'Build system or external dependencies' },
  { type: 'ci',       description: 'CI configuration' },
  { type: 'style',    description: 'Formatting / whitespace; no logic' },
  { type: 'revert',   description: 'Revert a previous commit' },
];

/** Compose a Conventional Commit header line. */
export function composeHeader(
  type: string,
  scope: string | undefined,
  subject: string,
  breaking: boolean = false,
): string {
  const cleanScope = (scope ?? '').trim();
  const cleanSubject = subject.trim();
  const scopeFrag = cleanScope ? `(${cleanScope})` : '';
  const bang = breaking ? '!' : '';
  return `${type}${scopeFrag}${bang}: ${cleanSubject}`;
}

/**
 * Suggest a scope from a list of changed file paths.
 *
 * Strategy: strip a leading `src/`, take the next segment, and pick the most
 * common one across the input. Special cases:
 *
 *   - README/CHANGELOG/LICENSE/docs only → 'docs'
 *   - package.json / package-lock / pnpm-lock / yarn.lock / Cargo.toml only → 'deps'
 *   - .github/workflows/ files → 'ci'
 *   - Empty input → undefined
 */
export function suggestScope(paths: string[]): string | undefined {
  if (!paths.length) return undefined;

  const docs = paths.every(p => /^(README|CHANGELOG|LICENSE)(\.md|\.txt)?$/i.test(p) || /^docs\//i.test(p));
  if (docs) return 'docs';

  const deps = paths.every(p =>
    /^package(-lock)?\.json$/.test(p)
    || /^pnpm-lock\.ya?ml$/.test(p)
    || /^yarn\.lock$/.test(p)
    || /^Cargo\.(toml|lock)$/.test(p)
    || /^requirements.*\.txt$/.test(p)
    || /^Gemfile(\.lock)?$/.test(p)
  );
  if (deps) return 'deps';

  const ci = paths.every(p => /^\.github\/workflows\//.test(p) || /^\.gitlab-ci\.yml$/.test(p) || /^azure-pipelines\.yml$/.test(p));
  if (ci) return 'ci';

  // Frequency of the most meaningful path segment.
  const counts = new Map<string, number>();
  for (const raw of paths) {
    const seg = meaningfulSegment(raw);
    if (!seg) continue;
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  // Only suggest when the leader covers > 50% of paths, otherwise the scope is too noisy.
  const [name, count] = sorted[0];
  if (count * 2 <= paths.length) return undefined;
  return name;
}

function meaningfulSegment(p: string): string | undefined {
  const parts = p.split('/').filter(Boolean);
  if (!parts.length) return undefined;
  // Strip a leading 'src' / 'lib' / 'app' / 'packages' / 'test' / 'tests'.
  const skip = new Set(['src', 'lib', 'app', 'packages', 'test', 'tests', 'spec']);
  let i = 0;
  while (i < parts.length && skip.has(parts[i].toLowerCase())) i++;
  // For a single remaining segment that's a file, strip its extension.
  if (i >= parts.length) return undefined;
  if (i === parts.length - 1) {
    const file = parts[i];
    return file.includes('.') ? file.split('.').slice(0, -1).join('.') : file;
  }
  return parts[i];
}

/**
 * Suggest a type from changed file paths. Rough heuristic only; the user is
 * the source of truth. Returns the suggested type and a confidence in [0, 1].
 */
export function suggestType(paths: string[]): { type: string; confidence: number } {
  if (!paths.length) return { type: 'chore', confidence: 0 };

  const onlyDocs = paths.every(p => /\.(md|mdx|rst|adoc|txt)$/i.test(p) || /^docs\//i.test(p));
  if (onlyDocs) return { type: 'docs', confidence: 0.9 };

  const onlyTests = paths.every(p => /(^|\/)(test|tests|spec)\//i.test(p) || /\.test\.[a-z]+$/i.test(p));
  if (onlyTests) return { type: 'test', confidence: 0.9 };

  const onlyCi = paths.every(p => /^\.github\/workflows\//.test(p) || /^\.gitlab-ci\.yml$/.test(p));
  if (onlyCi) return { type: 'ci', confidence: 0.95 };

  const onlyDeps = paths.every(p =>
    /^package(-lock)?\.json$/.test(p)
    || /^pnpm-lock\.ya?ml$/.test(p)
    || /^yarn\.lock$/.test(p)
    || /^Cargo\.(toml|lock)$/.test(p)
  );
  if (onlyDeps) return { type: 'build', confidence: 0.7 };

  // Default suggestion: feat. User overrides.
  return { type: 'feat', confidence: 0.4 };
}

/**
 * Replace (or insert) the conventional header on the first line of a message.
 * Preserves anything after the first line as-is.
 */
export function applyHeader(currentMessage: string, header: string): string {
  if (!currentMessage) return header;
  const newline = currentMessage.indexOf('\n');
  if (newline === -1) return header;
  return `${header}${currentMessage.slice(newline)}`;
}
