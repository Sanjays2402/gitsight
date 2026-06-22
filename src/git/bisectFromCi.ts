/**
 * Pure helpers for the F76 Bisect-from-CI-Failure flow.
 *
 * Given the JSON output of `gh run view --json jobs,headSha,workflowName`
 * for a failing CI run, locate the first failing job + step and emit a
 * `git bisect run` wrapper shell script that re-runs that step locally
 * for each candidate commit during the bisect.
 *
 * Extends F55 commit-by-commit test runner — same "isolate the regression"
 * goal, but driven by what CI actually flagged rather than a user-supplied
 * command. The two pair nicely: F55 walks <upstream>..HEAD with a fixed
 * command; F76 generates the command FROM the CI failure and hands it to
 * git's native bisect.
 *
 * Pure — no vscode, no child_process. Tests in test/git/bisectFromCi.test.ts.
 */

export interface GhJob {
  name: string;
  status?: string;       // 'completed' / 'in_progress' / ...
  conclusion?: string;   // 'failure' / 'success' / 'cancelled' / ...
  startedAt?: string;
  completedAt?: string;
  steps?: GhStep[];
  databaseId?: number;
  url?: string;
}

export interface GhStep {
  name: string;
  status?: string;
  conclusion?: string;
  number?: number;
}

export interface GhRunView {
  workflowName?: string;
  headSha?: string;
  status?: string;
  conclusion?: string;
  jobs?: GhJob[];
  url?: string;
}

export interface FailingStep {
  jobName: string;
  stepName: string;
  /** 1-indexed step number within the job. Useful for `gh run view --log`. */
  stepNumber?: number;
  /** URL to the failing job page on github.com (when present). */
  jobUrl?: string;
}

/**
 * Parse the raw `gh run view --json ...` blob (the CALLER passes the parsed
 * object — we don't take a string so the caller controls JSON.parse error
 * handling).
 *
 * Tolerates missing optional fields and shapes from older `gh` versions.
 * Returns undefined when the input is null/non-object.
 */
export function parseGhRunView(value: unknown): GhRunView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const jobs: GhJob[] = Array.isArray(r.jobs)
    ? (r.jobs as unknown[]).map(j => normaliseJob(j)).filter((j): j is GhJob => !!j)
    : [];
  return {
    workflowName: stringOr(r.workflowName) ?? stringOr(r.name),
    headSha: stringOr(r.headSha),
    status: stringOr(r.status),
    conclusion: stringOr(r.conclusion),
    jobs,
    url: stringOr(r.url),
  };
}

function normaliseJob(value: unknown): GhJob | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const j = value as Record<string, unknown>;
  const name = stringOr(j.name);
  if (!name) return undefined;
  const stepsRaw = Array.isArray(j.steps) ? (j.steps as unknown[]) : [];
  const steps: GhStep[] = [];
  for (const s of stepsRaw) {
    if (!s || typeof s !== 'object') continue;
    const sr = s as Record<string, unknown>;
    const sName = stringOr(sr.name);
    if (!sName) continue;
    steps.push({
      name: sName,
      status: stringOr(sr.status),
      conclusion: stringOr(sr.conclusion),
      number: typeof sr.number === 'number' ? sr.number : undefined,
    });
  }
  return {
    name,
    status: stringOr(j.status),
    conclusion: stringOr(j.conclusion),
    startedAt: stringOr(j.startedAt),
    completedAt: stringOr(j.completedAt),
    databaseId: typeof j.databaseId === 'number' ? j.databaseId : undefined,
    url: stringOr(j.url),
    steps,
  };
}

function stringOr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Find the first failing step across all jobs in the run.
 *
 * Strategy:
 *   1. Walk jobs in order, looking for `conclusion === 'failure'`.
 *   2. Within that job, find the first step whose conclusion is `failure`.
 *   3. If the job is `failure` but no step is, fall back to the LAST
 *      non-success step (covers the case where the job timed out without
 *      a step-level conclusion).
 *   4. Returns undefined when no job/step indicates a failure.
 *
 * We deliberately return ONLY the first failure — bisect against
 * everything would muddy the signal. Users can re-invoke for a second
 * failing job after fixing the first.
 */
export function findFirstFailingStep(run: GhRunView): FailingStep | undefined {
  for (const job of run.jobs ?? []) {
    if ((job.conclusion ?? '').toLowerCase() !== 'failure') continue;
    const steps = job.steps ?? [];
    const failed = steps.find(s => (s.conclusion ?? '').toLowerCase() === 'failure');
    if (failed) {
      return {
        jobName: job.name,
        stepName: failed.name,
        stepNumber: failed.number,
        jobUrl: job.url,
      };
    }
    // Fallback: last step that wasn't a clean success.
    const nonSuccess = [...steps].reverse().find(s => (s.conclusion ?? '').toLowerCase() !== 'success');
    if (nonSuccess) {
      return {
        jobName: job.name,
        stepName: nonSuccess.name,
        stepNumber: nonSuccess.number,
        jobUrl: job.url,
      };
    }
    // Truly empty — surface the job-level signal with a placeholder step.
    return { jobName: job.name, stepName: '(no step output)', jobUrl: job.url };
  }
  return undefined;
}

/**
 * Map a known well-known step name to a shell command that approximates
 * it locally. The list is intentionally small and conservative —
 * unrecognised steps fall through to a generic "echo + manual edit"
 * marker that the user adapts to their project.
 *
 * Heuristic priority:
 *   1. Exact-match common npm/yarn/pnpm scripts (Run tests, Lint, Build,
 *      Type check, Format check).
 *   2. Substring matches inside the step name (case-insensitive).
 *   3. Default: a placeholder the user must fill in.
 */
export interface InferredCommand {
  /** Shell command line. Single string, runs under /bin/sh. */
  command: string;
  /** True when the inference was confident (1 or 2 above); false for the placeholder. */
  confident: boolean;
}

export function inferLocalCommand(stepName: string): InferredCommand {
  const name = (stepName ?? '').trim().toLowerCase();
  if (!name) return placeholder();

  // Exact-match popular CI step names.
  const exact: Record<string, string> = {
    'run tests': 'npm test',
    'test': 'npm test',
    'tests': 'npm test',
    'unit tests': 'npm test',
    'lint': 'npm run lint',
    'eslint': 'npm run lint',
    'typecheck': 'npm run lint',
    'type check': 'npm run lint',
    'type-check': 'npm run lint',
    'build': 'npm run build',
    'compile': 'npm run compile',
    'format check': 'npm run format -- --check',
    'prettier check': 'npx prettier --check .',
  };
  if (exact[name]) return { command: exact[name], confident: true };

  // Substring fallbacks (less confident, still useful).
  if (/\b(jest|vitest|mocha|tap)\b/.test(name)) {
    return { command: 'npm test', confident: true };
  }
  if (/\beslint\b/.test(name)) {
    return { command: 'npm run lint', confident: true };
  }
  if (/\btsc\b|\btype[- ]?script\b/.test(name)) {
    return { command: 'npx tsc --noEmit', confident: true };
  }
  if (/\bbuild\b/.test(name)) {
    return { command: 'npm run build', confident: true };
  }
  if (/\bcargo\b/.test(name)) {
    return { command: 'cargo test', confident: true };
  }
  if (/\bgo\s+test\b/.test(name) || /\bgolang\b/.test(name)) {
    return { command: 'go test ./...', confident: true };
  }
  if (/\bpytest\b|\bpython\s+-m\s+test\b/.test(name)) {
    return { command: 'pytest', confident: true };
  }

  return placeholder();
}

function placeholder(): InferredCommand {
  return {
    command: 'echo "TODO: replace with the command that reproduces this CI step" >&2; exit 125',
    confident: false,
  };
}

/**
 * Build the shell script that `git bisect run` will invoke against each
 * candidate commit. The script:
 *
 *   1. Exits 125 (UNTESTABLE, skip this commit) when the install command
 *      fails — bisect should skip dirty/uninstallable commits, not
 *      attribute the regression to them.
 *   2. Exits 0 when the recovery command succeeds (= good commit).
 *   3. Exits 1 when the recovery command fails (= bad commit).
 *
 * The install step is optional but recommended — it ensures `node_modules`
 * is fresh for each commit when lockfiles changed mid-range. Pass
 * `includeInstall: false` to skip it (useful for hot loops).
 */
export interface BuildBisectScriptArgs {
  failing: FailingStep;
  workflowName?: string;
  headSha?: string;
  /** Recovery command (typically inferLocalCommand(failing.stepName).command). */
  command: string;
  /** When true, runs `npm ci || npm install` (or yarn / pnpm equivalents) before the command. */
  includeInstall?: boolean;
  /** Install command. Defaults to 'npm ci || npm install'. */
  installCommand?: string;
}

export function buildBisectScript(args: BuildBisectScriptArgs): string {
  const includeInstall = args.includeInstall ?? true;
  const installCommand = args.installCommand ?? 'npm ci || npm install';
  const headLabel = args.headSha ? args.headSha.slice(0, 7) : 'unknown';
  const workflow = args.workflowName || '(unnamed workflow)';
  const lines: string[] = [];
  lines.push('#!/bin/sh');
  lines.push('# Generated by GitSight (F76 - bisect from CI failure)');
  lines.push(`# Failing run: ${workflow} @ ${headLabel}`);
  lines.push(`# Failing job: ${args.failing.jobName}`);
  lines.push(`# Failing step: ${args.failing.stepName}${args.failing.stepNumber ? ` (#${args.failing.stepNumber})` : ''}`);
  if (args.failing.jobUrl) {
    lines.push(`# Job URL: ${args.failing.jobUrl}`);
  }
  lines.push('#');
  lines.push('# Exit codes for `git bisect run`:');
  lines.push('#   0   = commit is GOOD');
  lines.push('#   1   = commit is BAD');
  lines.push('#   125 = commit is UNTESTABLE (install failed, skip)');
  lines.push('');
  lines.push('set -u');
  lines.push('');
  if (includeInstall) {
    lines.push('# Refresh dependencies for the current commit. Skip the commit when this fails.');
    lines.push(`if ! ${installCommand}; then`);
    lines.push('  echo "gitsight-bisect: install failed at $(git rev-parse --short HEAD); skipping commit." >&2');
    lines.push('  exit 125');
    lines.push('fi');
    lines.push('');
  }
  lines.push('# Recovery command derived from the failing CI step.');
  lines.push(args.command);
  lines.push('status=$?');
  lines.push('');
  lines.push('if [ "$status" -eq 0 ]; then');
  lines.push('  echo "gitsight-bisect: GOOD at $(git rev-parse --short HEAD)"');
  lines.push('  exit 0');
  lines.push('fi');
  lines.push('echo "gitsight-bisect: BAD at $(git rev-parse --short HEAD) (exit $status)" >&2');
  lines.push('exit 1');
  return lines.join('\n') + '\n';
}

/**
 * Convenience wrapper that classifies + plans in one call. Returns a
 * full plan object suitable for previewing in a webview / scratch doc
 * before the user kicks off `git bisect run`.
 */
export interface BisectPlan {
  failing: FailingStep;
  inferred: InferredCommand;
  script: string;
  /** Suggested temp-path for the script — caller writes there. */
  scriptFileName: string;
}

export function planBisectFromRun(run: GhRunView): BisectPlan | undefined {
  const failing = findFirstFailingStep(run);
  if (!failing) return undefined;
  const inferred = inferLocalCommand(failing.stepName);
  const script = buildBisectScript({
    failing,
    workflowName: run.workflowName,
    headSha: run.headSha,
    command: inferred.command,
  });
  const scriptFileName = `gitsight-bisect-${slug(failing.jobName)}-${slug(failing.stepName)}.sh`;
  return { failing, inferred, script, scriptFileName };
}

function slug(s: string): string {
  return (s || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'step';
}
