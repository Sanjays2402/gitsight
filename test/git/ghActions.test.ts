import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGhRunList,
  classifyRunState,
  glyphForRun,
  severityForRun,
  formatPillLabel,
  formatTooltipMarkdown,
  hasGithubWorkflows,
} from '../../src/git/ghActions';

const RUN_FIXTURE = JSON.stringify([
  {
    databaseId: 42,
    status: 'completed',
    conclusion: 'success',
    name: 'CI',
    workflowName: 'build',
    headSha: 'abcdef0123456789',
    startedAt: '2026-06-21T10:00:00Z',
    updatedAt: '2026-06-21T10:05:00Z',
    url: 'https://github.com/example/example/actions/runs/42',
    event: 'push',
  },
]);

test('parseGhRunList: extracts shape', () => {
  const runs = parseGhRunList(RUN_FIXTURE);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].databaseId, 42);
  assert.equal(runs[0].state, 'success');
  assert.equal(runs[0].workflowName, 'build');
});

test('parseGhRunList: empty string returns []', () => {
  assert.deepEqual(parseGhRunList(''), []);
});

test('parseGhRunList: malformed JSON returns []', () => {
  assert.deepEqual(parseGhRunList('not json'), []);
});

test('parseGhRunList: non-array JSON returns []', () => {
  assert.deepEqual(parseGhRunList('{}'), []);
});

test('parseGhRunList: missing fields default to empty strings', () => {
  const raw = JSON.stringify([{}]);
  const runs = parseGhRunList(raw);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'unknown');
  assert.equal(runs[0].workflowName, '');
});

test('classifyRunState: in_progress/queued/waiting/pending \u2192 running', () => {
  assert.equal(classifyRunState('in_progress', ''), 'running');
  assert.equal(classifyRunState('queued', ''), 'running');
  assert.equal(classifyRunState('waiting', ''), 'running');
  assert.equal(classifyRunState('pending', ''), 'running');
});

test('classifyRunState: completed + conclusion variants', () => {
  assert.equal(classifyRunState('completed', 'success'), 'success');
  assert.equal(classifyRunState('completed', 'failure'), 'failure');
  assert.equal(classifyRunState('completed', 'cancelled'), 'cancelled');
  assert.equal(classifyRunState('completed', 'skipped'), 'skipped');
  assert.equal(classifyRunState('completed', 'neutral'), 'other');
  assert.equal(classifyRunState('completed', 'timed_out'), 'other');
  assert.equal(classifyRunState('completed', ''), 'other');
});

test('classifyRunState: case-insensitive', () => {
  assert.equal(classifyRunState('COMPLETED', 'SUCCESS'), 'success');
  assert.equal(classifyRunState('In_Progress', ''), 'running');
});

test('classifyRunState: empty status \u2192 unknown', () => {
  assert.equal(classifyRunState('', ''), 'unknown');
});

test('glyphForRun: returns codicon names (no emoji)', () => {
  assert.match(glyphForRun('success'), /^[a-z]/);
  assert.match(glyphForRun('failure'), /^[a-z]/);
  assert.match(glyphForRun('running'), /spin/); // animated codicon
});

test('severityForRun: failure \u2192 error, cancelled/other \u2192 warning, rest \u2192 none', () => {
  assert.equal(severityForRun('failure'), 'error');
  assert.equal(severityForRun('cancelled'), 'warning');
  assert.equal(severityForRun('other'), 'warning');
  assert.equal(severityForRun('success'), 'none');
  assert.equal(severityForRun('running'), 'none');
  assert.equal(severityForRun('skipped'), 'none');
  assert.equal(severityForRun('unknown'), 'none');
});

test('formatPillLabel: includes glyph + state + workflow name', () => {
  const runs = parseGhRunList(RUN_FIXTURE);
  const label = formatPillLabel(runs[0]);
  assert.match(label, /CI: success/);
  assert.match(label, /build/);
  assert.match(label, /\$\(/); // codicon
});

test('formatPillLabel: truncates long workflow names', () => {
  const runs = parseGhRunList(JSON.stringify([{
    status: 'completed', conclusion: 'success',
    workflowName: 'this is a really long workflow name that nobody should have',
  }]));
  const label = formatPillLabel(runs[0]);
  // Truncation marker present
  assert.match(label, /\u2026/);
});

test('formatTooltipMarkdown: includes workflow/branch/sha/event/age', () => {
  const runs = parseGhRunList(RUN_FIXTURE);
  const md = formatTooltipMarkdown(runs[0], { branch: 'main', ageLabel: '5m' });
  assert.match(md, /build/);
  assert.match(md, /main/);
  assert.match(md, /abcdef0/);
  assert.match(md, /push/);
  assert.match(md, /5m/);
});

test('formatTooltipMarkdown: handles missing optional fields', () => {
  const runs = parseGhRunList(JSON.stringify([{
    status: 'in_progress', conclusion: '', workflowName: 'tests',
  }]));
  const md = formatTooltipMarkdown(runs[0]);
  assert.match(md, /running/);
  assert.match(md, /tests/);
});

test('hasGithubWorkflows: detects .yml or .yaml files', () => {
  assert.equal(hasGithubWorkflows(['build.yml']), true);
  assert.equal(hasGithubWorkflows(['build.yaml']), true);
  assert.equal(hasGithubWorkflows(['BUILD.YML']), true); // case-insensitive
  assert.equal(hasGithubWorkflows(['README.md']), false);
  assert.equal(hasGithubWorkflows([]), false);
});
