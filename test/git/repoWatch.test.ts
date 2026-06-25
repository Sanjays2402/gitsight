import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyGitChange,
  gitChangeTriggersRefresh,
  formatSseMessage,
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from '../../src/shared/repoWatch';

// ── classifyGitChange ────────────────────────────────────────────────

test('classifyGitChange tags HEAD-family files', () => {
  assert.equal(classifyGitChange('HEAD'), 'head');
  assert.equal(classifyGitChange('ORIG_HEAD'), 'head');
  assert.equal(classifyGitChange('MERGE_HEAD'), 'head');
  assert.equal(classifyGitChange('FETCH_HEAD'), 'head');
});

test('classifyGitChange tags refs + packed-refs + reflogs', () => {
  assert.equal(classifyGitChange('refs/heads/main'), 'ref');
  assert.equal(classifyGitChange('refs/remotes/origin/main'), 'ref');
  assert.equal(classifyGitChange('refs/tags/v1.0.0'), 'ref');
  assert.equal(classifyGitChange('packed-refs'), 'ref');
  assert.equal(classifyGitChange('logs/HEAD'), 'ref');
  assert.equal(classifyGitChange('logs/refs/heads/main'), 'ref');
});

test('classifyGitChange tags stash separately from generic refs', () => {
  assert.equal(classifyGitChange('refs/stash'), 'stash');
  assert.equal(classifyGitChange('logs/refs/stash'), 'stash');
});

test('classifyGitChange tags the index + lock files', () => {
  assert.equal(classifyGitChange('index'), 'index');
  assert.equal(classifyGitChange('refs/heads/main.lock'), 'lock');
  assert.equal(classifyGitChange('index.lock'), 'lock');
  assert.equal(classifyGitChange('packed-refs.lock'), 'lock');
});

test('classifyGitChange returns other for unrelated paths + empty', () => {
  assert.equal(classifyGitChange('objects/pack/pack-abc.pack'), 'other');
  assert.equal(classifyGitChange('config'), 'other');
  assert.equal(classifyGitChange(''), 'other');
});

test('classifyGitChange normalises backslashes + leading ./', () => {
  assert.equal(classifyGitChange('refs\\heads\\main'), 'ref');
  assert.equal(classifyGitChange('./HEAD'), 'head');
});

// ── gitChangeTriggersRefresh ─────────────────────────────────────────

test('gitChangeTriggersRefresh fires for head/ref/stash, not index/lock/other', () => {
  assert.equal(gitChangeTriggersRefresh('HEAD'), true);
  assert.equal(gitChangeTriggersRefresh('refs/heads/main'), true);
  assert.equal(gitChangeTriggersRefresh('refs/stash'), true);
  assert.equal(gitChangeTriggersRefresh('index'), false);
  assert.equal(gitChangeTriggersRefresh('refs/heads/main.lock'), false);
  assert.equal(gitChangeTriggersRefresh('objects/pack/x.idx'), false);
});

// ── formatSseMessage ─────────────────────────────────────────────────

test('formatSseMessage serialises a named event with JSON data', () => {
  const out = formatSseMessage({ event: 'refresh', id: 7, data: { head: 'main' } });
  assert.equal(out, 'id: 7\nevent: refresh\ndata: {"head":"main"}\n\n');
});

test('formatSseMessage splits multi-line string data into data: lines', () => {
  const out = formatSseMessage({ data: 'line1\nline2' });
  assert.equal(out, 'data: line1\ndata: line2\n\n');
});

test('formatSseMessage emits a comment keep-alive', () => {
  assert.equal(formatSseMessage({ comment: 'ping' }), ': ping\n\n');
});

test('formatSseMessage includes a retry hint', () => {
  const out = formatSseMessage({ event: 'hello', retry: 3000, data: 'hi' });
  assert.ok(out.includes('retry: 3000'));
  assert.ok(out.includes('event: hello'));
  assert.ok(out.endsWith('\n\n'));
});

// ── reconnectDelay ───────────────────────────────────────────────────

test('reconnectDelay doubles per attempt and caps at the ceiling', () => {
  assert.equal(reconnectDelay(0), RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(1), RECONNECT_BASE_MS * 2);
  assert.equal(reconnectDelay(2), RECONNECT_BASE_MS * 4);
  // Far out -> capped.
  assert.equal(reconnectDelay(99), RECONNECT_MAX_MS);
});

test('reconnectDelay treats negative/garbage attempts as the first retry', () => {
  assert.equal(reconnectDelay(-3), RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(NaN), RECONNECT_BASE_MS);
});

test('reconnectDelay honours custom base/max', () => {
  assert.equal(reconnectDelay(0, 100, 800), 100);
  assert.equal(reconnectDelay(4, 100, 800), 800); // 100*16=1600 capped to 800
});
