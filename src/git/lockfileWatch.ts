/**
 * Pure helpers for the Lockfile Watcher (F28).
 *
 * Defines the lockfile -> install-command mapping and the helper that
 * compares two `git status --porcelain` snapshots to spot lockfiles that
 * just landed via a pull/merge/rebase. We deliberately watch the working
 * tree rather than `git pull` exit, because the same nudge is useful after
 * a stash-pop, a branch switch, or any other ref move that delivers new
 * lockfile bytes.
 *
 * Pure — no vscode, no child_process. Tests in test/git/lockfileWatch.test.ts.
 */

export interface LockfileEntry {
  /** Repo-relative path. */
  path: string;
  /** Human label for the ecosystem (npm, pnpm, …). */
  ecosystem: string;
  /** Suggested install command lines, ordered by preference. */
  installCommands: string[];
}

/**
 * The supported lockfiles. Order matters for tie-breaks — when a repo has
 * both `package-lock.json` and `pnpm-lock.yaml` (a migration in progress),
 * we surface them both but prefer pnpm's suggestion first since the pnpm
 * lock is the source of truth in that hybrid state.
 *
 * Each row maps a basename → ecosystem label + install commands.
 */
export const LOCKFILE_TABLE: { basename: string; ecosystem: string; installCommands: string[] }[] = [
  { basename: 'pnpm-lock.yaml',     ecosystem: 'pnpm',       installCommands: ['pnpm install'] },
  { basename: 'yarn.lock',          ecosystem: 'yarn',       installCommands: ['yarn install --frozen-lockfile', 'yarn'] },
  { basename: 'package-lock.json',  ecosystem: 'npm',        installCommands: ['npm ci', 'npm install'] },
  { basename: 'bun.lockb',          ecosystem: 'bun',        installCommands: ['bun install --frozen-lockfile', 'bun install'] },
  { basename: 'Cargo.lock',         ecosystem: 'cargo',      installCommands: ['cargo fetch', 'cargo build'] },
  { basename: 'go.sum',             ecosystem: 'go',         installCommands: ['go mod download', 'go mod tidy'] },
  { basename: 'Gemfile.lock',       ecosystem: 'bundler',    installCommands: ['bundle install --frozen', 'bundle install'] },
  { basename: 'poetry.lock',        ecosystem: 'poetry',     installCommands: ['poetry install --sync', 'poetry install'] },
  { basename: 'uv.lock',            ecosystem: 'uv',         installCommands: ['uv sync'] },
  { basename: 'composer.lock',      ecosystem: 'composer',   installCommands: ['composer install --no-dev', 'composer install'] },
  { basename: 'mix.lock',           ecosystem: 'mix (elixir)', installCommands: ['mix deps.get'] },
  { basename: 'Pipfile.lock',       ecosystem: 'pipenv',     installCommands: ['pipenv sync', 'pipenv install --deploy'] },
];

/**
 * Resolve a path's basename to a LockfileEntry, or undefined when the path
 * doesn't match anything in the table. Case-sensitive: lockfiles have
 * canonical capitalisation and we shouldn't paper over typos.
 */
export function classifyLockfile(repoRelPath: string): LockfileEntry | undefined {
  const i = repoRelPath.lastIndexOf('/');
  const basename = i >= 0 ? repoRelPath.slice(i + 1) : repoRelPath;
  const row = LOCKFILE_TABLE.find(r => r.basename === basename);
  if (!row) return undefined;
  return { path: repoRelPath, ecosystem: row.ecosystem, installCommands: row.installCommands };
}

/**
 * Compute lockfiles that recently changed in the working tree. Reads
 * `git status --porcelain` output and returns the entries whose path
 * matches a known lockfile. We don't try to distinguish "changed by pull"
 * from "changed by you" here — the controller layers debouncing/repo-event
 * gating on top.
 *
 * Index OR worktree dirty both count: a `git pull --rebase --autostash`
 * can land lockfile changes in either column depending on conflict
 * resolution. We dedupe by path so a `MM` entry counts once.
 */
export function findChangedLockfiles(porcelain: string): LockfileEntry[] {
  const seen = new Set<string>();
  const out: LockfileEntry[] = [];
  for (const raw of (porcelain ?? '').split('\n')) {
    if (!raw) continue;
    if (raw.length < 3) continue;
    const x = raw[0], y = raw[1];
    // Skip untracked (??) — a new lockfile probably means the user just
    // bootstrapped a new project; the prompt would be premature. Skip
    // ignored too (!!).
    if (x === '?' || y === '?' || x === '!' || y === '!') continue;
    // Skip purely clean rows — shouldn't appear in porcelain output but
    // defensive against trailing whitespace tricks.
    if (x === ' ' && y === ' ') continue;
    // Rename rows have form "R  old -> new"; we want the new path.
    let path = raw.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.trim();
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const cls = classifyLockfile(path);
    if (cls) out.push(cls);
  }
  return out;
}

/**
 * Render the toast title. Keeps it short and informative.
 *
 *   "1 lockfile changed: pnpm-lock.yaml"
 *   "2 lockfiles changed: pnpm-lock.yaml, Cargo.lock"
 */
export function summariseChanged(entries: LockfileEntry[]): string {
  if (!entries.length) return 'No lockfile changes';
  const word = entries.length === 1 ? 'lockfile' : 'lockfiles';
  const list = entries.map(e => e.path.split('/').slice(-1)[0]).join(', ');
  return `${entries.length} ${word} changed: ${list}`;
}

/**
 * Build a deduplicated, ordered list of install commands across all changed
 * lockfiles. Used for the "Run all" composite action.
 */
export function aggregateInstallCommands(entries: LockfileEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const first = e.installCommands[0];
    if (!first || seen.has(first)) continue;
    seen.add(first);
    out.push(first);
  }
  return out;
}
