import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseGhRunView,
  findFirstFailingStep,
  inferLocalCommand,
  buildBisectScript,
  planBisectFromRun,
} from '../../src/git/bisectFromCi';

const RUN_JSON = {
  workflowName: 'CI',
  headSha: 'abcdef0123456789abcdef0123456789abcdef01',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/example/example/actions/runs/42',
  jobs: [
    {
      name: 'lint',
      conclusion: 'success',
      steps: [
        { name: 'Checkout', conclusion: 'success', number: 1 },
        { name: 'Run lint', conclusion: 'success', number: 2 },
      ],
    },
    {
      name: 'test',
      conclusion: 'failure',
      url: 'https://github.com/example/example/actions/runs/42/job/77',
      steps: [
        { name: 'Checkout', conclusion: 'success', number: 1 },
        { name: 'Install dependencies', conclusion: 'success', number: 2 },
        { name: 'Run tests', conclusion: 'failure', number: 3 },
      ],
    },
  ],
};

// ── parseGhRunView ──────────────────────────────────────────────

test('parseGhRunView: extracts workflow + sha + jobs', () => {
  const r = parseGhRunView(RUN_JSON);
  assert.ok(r);
  assert.equal(r!.workflowName, 'CI');
  assert.equal(r!.headSha, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(r!.jobs?.length, 2);
  assert.equal(r!.jobs![0].steps?.length, 2);
});

test('parseGhRunView: returns undefined for non-object input', () => {
  assert.equal(parseGhRunView(null), undefined);
  assert.equal(parseGhRunView('not json'), undefined);
  assert.equal(parseGhRunView(42), undefined);
});

test('parseGhRunView: tolerates missing jobs array', () => {
  const r = parseGhRunView({ workflowName: 'CI' });
  assert.ok(r);
  assert.deepEqual(r!.jobs, []);
});

test('parseGhRunView: drops jobs with no name', () => {
  const r = parseGhRunView({
    jobs: [
      { conclusion: 'failure' },                              // no name → dropped
      { name: 'kept', conclusion: 'failure', steps: [] },
    ],
  });
  assert.equal(r!.jobs?.length, 1);
  assert.equal(r!.jobs![0].name, 'kept');
});

test('parseGhRunView: falls back to top-level `name` when workflowName absent', () => {
  const r = parseGhRunView({ name: 'fallback workflow' });
  assert.equal(r!.workflowName, 'fallback workflow');
});

// ── findFirstFailingStep ────────────────────────────────────────

test('findFirstFailingStep: returns the failing step inside the failing job', () => {
  const run = parseGhRunView(RUN_JSON)!;
  const f = findFirstFailingStep(run);
  assert.ok(f);
  assert.equal(f!.jobName, 'test');
  assert.equal(f!.stepName, 'Run tests');
  assert.equal(f!.stepNumber, 3);
  assert.equal(f!.jobUrl, 'https://github.com/example/example/actions/runs/42/job/77');
});

test('findFirstFailingStep: falls back to last non-success step when no step-level failure', () => {
  const run = parseGhRunView({
    jobs: [{
      name: 'test', conclusion: 'failure',
      steps: [
        { name: 'a', conclusion: 'success' },
        { name: 'b', conclusion: 'cancelled' },   // not success
        { name: 'c', conclusion: 'success' },
      ],
    }],
  })!;
  const f = findFirstFailingStep(run);
  assert.ok(f);
  assert.equal(f!.stepName, 'b');
});

test('findFirstFailingStep: surfaces placeholder when job has no steps', () => {
  const run = parseGhRunView({
    jobs: [{ name: 'mystery', conclusion: 'failure' }],
  })!;
  const f = findFirstFailingStep(run);
  assert.ok(f);
  assert.equal(f!.jobName, 'mystery');
  assert.equal(f!.stepName, '(no step output)');
});

test('findFirstFailingStep: returns undefined when no job failed', () => {
  const run = parseGhRunView({
    jobs: [{ name: 'ok', conclusion: 'success', steps: [] }],
  })!;
  assert.equal(findFirstFailingStep(run), undefined);
});

// ── inferLocalCommand ───────────────────────────────────────────

test('inferLocalCommand: exact-match common CI step names', () => {
  assert.equal(inferLocalCommand('Run tests').command, 'npm test');
  assert.equal(inferLocalCommand('Run tests').confident, true);
  assert.equal(inferLocalCommand('Lint').command, 'npm run lint');
  assert.equal(inferLocalCommand('Type check').command, 'npm run lint');
  assert.equal(inferLocalCommand('Build').command, 'npm run build');
  assert.equal(inferLocalCommand('Compile').command, 'npm run compile');
});

test('inferLocalCommand: case + whitespace normalised', () => {
  assert.equal(inferLocalCommand('  RUN TESTS  ').command, 'npm test');
});

test('inferLocalCommand: substring match for jest/vitest/etc.', () => {
  assert.equal(inferLocalCommand('Run jest unit suite').command, 'npm test');
  assert.equal(inferLocalCommand('vitest typecheck').command, 'npm test');
});

test('inferLocalCommand: substring match for tsc / typescript', () => {
  assert.equal(inferLocalCommand('Run tsc').command, 'npx tsc --noEmit');
  assert.equal(inferLocalCommand('TypeScript build').command, 'npx tsc --noEmit');
});

test('inferLocalCommand: cargo + go + pytest paths', () => {
  assert.equal(inferLocalCommand('Cargo test all').command, 'cargo test');
  assert.equal(inferLocalCommand('Go test integration').command, 'go test ./...');
  assert.equal(inferLocalCommand('Run pytest').command, 'pytest');
});

test('inferLocalCommand: unknown step name returns placeholder', () => {
  const r = inferLocalCommand('Trigger custom Rube Goldberg machine');
  assert.equal(r.confident, false);
  assert.match(r.command, /TODO.*replace/);
});

test('inferLocalCommand: empty step name returns placeholder', () => {
  const r = inferLocalCommand('');
  assert.equal(r.confident, false);
});

// ── buildBisectScript ───────────────────────────────────────────

test('buildBisectScript: contains shebang, install block, command, and exit logic', () => {
  const script = buildBisectScript({
    failing: { jobName: 'test', stepName: 'Run tests', stepNumber: 3 },
    workflowName: 'CI',
    headSha: 'abcdef0123456789',
    command: 'npm test',
  });
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /npm ci \|\| npm install/);
  assert.match(script, /\nnpm test\n/);
  assert.match(script, /exit 125/);                         // skip on install failure
  assert.match(script, /gitsight-bisect: GOOD/);
  assert.match(script, /gitsight-bisect: BAD/);
});

test('buildBisectScript: header comment carries job + step + URL for traceability', () => {
  const script = buildBisectScript({
    failing: {
      jobName: 'test', stepName: 'Run tests', stepNumber: 3,
      jobUrl: 'https://github.com/example/example/actions/runs/42/job/77',
    },
    workflowName: 'CI',
    headSha: 'abcdef0',
    command: 'npm test',
  });
  assert.match(script, /Failing job: test/);
  assert.match(script, /Failing step: Run tests \(#3\)/);
  assert.match(script, /Job URL: https:\/\/github\.com.*\/runs\/42\/job\/77/);
});

test('buildBisectScript: includeInstall=false omits the install block', () => {
  const script = buildBisectScript({
    failing: { jobName: 'test', stepName: 'x' },
    command: 'npm test',
    includeInstall: false,
  });
  assert.doesNotMatch(script, /npm ci/);
  assert.doesNotMatch(script, /exit 125/);
  assert.match(script, /\nnpm test\n/);
});

test('buildBisectScript: custom installCommand respected', () => {
  const script = buildBisectScript({
    failing: { jobName: 'test', stepName: 'x' },
    command: 'pnpm test',
    installCommand: 'pnpm install --frozen-lockfile',
  });
  assert.match(script, /pnpm install --frozen-lockfile/);
});

test('buildBisectScript: ends with a single trailing newline', () => {
  const script = buildBisectScript({
    failing: { jobName: 'j', stepName: 's' },
    command: 'true',
  });
  assert.ok(script.endsWith('\n'));
  assert.ok(!script.endsWith('\n\n'));
});

// ── planBisectFromRun ───────────────────────────────────────────

test('planBisectFromRun: end-to-end on the fixture', () => {
  const run = parseGhRunView(RUN_JSON)!;
  const plan = planBisectFromRun(run);
  assert.ok(plan);
  assert.equal(plan!.failing.stepName, 'Run tests');
  assert.equal(plan!.inferred.command, 'npm test');
  assert.equal(plan!.inferred.confident, true);
  assert.match(plan!.script, /npm test/);
  assert.match(plan!.scriptFileName, /^gitsight-bisect-test-run-tests\.sh$/);
});

test('planBisectFromRun: returns undefined when nothing failed', () => {
  const run = parseGhRunView({
    jobs: [{ name: 'ok', conclusion: 'success', steps: [] }],
  })!;
  assert.equal(planBisectFromRun(run), undefined);
});

test('planBisectFromRun: handles steps with weird characters in script filename', () => {
  const run = parseGhRunView({
    jobs: [{
      name: 'build (linux)', conclusion: 'failure',
      steps: [{ name: 'Run e2e :: smoke!', conclusion: 'failure', number: 5 }],
    }],
  })!;
  const plan = planBisectFromRun(run);
  assert.ok(plan);
  // No spaces, colons, parens, exclamation in the filename.
  assert.match(plan!.scriptFileName, /^gitsight-bisect-[a-z0-9-]+-[a-z0-9-]+\.sh$/);
});
