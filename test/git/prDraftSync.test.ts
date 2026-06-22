import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseOpenDraftPr,
  buildSyncBlock,
  injectSyncBlock,
  parseCommitsForSync,
  parseFilesForSync,
  needsRewrite,
  SYNC_OPEN_MARKER,
  SYNC_CLOSE_MARKER,
} from '../../src/git/prDraftSync';

test('parseOpenDraftPr extracts the draft PR details', () => {
  const raw = JSON.stringify({
    number: 42,
    url: 'https://github.com/foo/bar/pull/42',
    headRefName: 'feature/x',
    isDraft: true,
    body: 'hello world',
  });
  const r = parseOpenDraftPr(raw);
  assert.ok(r);
  assert.equal(r!.number, 42);
  assert.equal(r!.isDraft, true);
  assert.equal(r!.headRefName, 'feature/x');
  assert.equal(r!.body, 'hello world');
});

test('parseOpenDraftPr keeps non-draft PRs (caller decides what to do)', () => {
  const raw = JSON.stringify({ number: 1, url: 'u', headRefName: 'h', isDraft: false, body: 'b' });
  const r = parseOpenDraftPr(raw);
  assert.ok(r);
  assert.equal(r!.isDraft, false);
});

test('parseOpenDraftPr returns undefined for invalid input', () => {
  assert.equal(parseOpenDraftPr(''), undefined);
  assert.equal(parseOpenDraftPr('not json'), undefined);
  assert.equal(parseOpenDraftPr('null'), undefined);
  assert.equal(parseOpenDraftPr(JSON.stringify({ number: 0 })), undefined);
  assert.equal(parseOpenDraftPr(JSON.stringify({ number: -1 })), undefined);
});

test('buildSyncBlock renders the canonical structure', () => {
  const block = buildSyncBlock({
    commits: [
      { shortSha: 'abc1234', subject: 'fix: foo' },
      { shortSha: 'def5678', subject: 'refactor: bar' },
    ],
    files: ['src/foo.ts', 'src/bar.ts'],
    syncedAt: '2026-06-21 22:47 PDT',
  });
  assert.ok(block.startsWith(SYNC_OPEN_MARKER));
  assert.ok(block.endsWith(SYNC_CLOSE_MARKER));
  assert.ok(block.includes('## Commits (2)'));
  assert.ok(block.includes('- abc1234 fix: foo'));
  assert.ok(block.includes('## Files (2)'));
  assert.ok(block.includes('- src/foo.ts'));
  assert.ok(block.includes('_Last synced 2026-06-21 22:47 PDT by GitSight._'));
});

test('buildSyncBlock handles empty commits and files', () => {
  const block = buildSyncBlock({ commits: [], files: [], syncedAt: 'now' });
  assert.ok(block.includes('_No commits ahead of base yet._'));
  assert.ok(block.includes('_No file changes yet._'));
});

test('buildSyncBlock collapses newlines in commit subjects', () => {
  const block = buildSyncBlock({
    commits: [{ shortSha: 'aaa1111', subject: 'fix\nbreaking\nthing' }],
    files: [],
    syncedAt: 'now',
  });
  assert.ok(block.includes('- aaa1111 fix breaking thing'));
});

test('injectSyncBlock appends to a body that has no existing block', () => {
  const body = 'Existing PR body here.\n\nMore prose.';
  const block = buildSyncBlock({ commits: [{ shortSha: 'aaa1111', subject: 'x' }], files: [], syncedAt: 't' });
  const out = injectSyncBlock(body, block);
  assert.ok(out.startsWith('Existing PR body here.'));
  assert.ok(out.includes(SYNC_OPEN_MARKER));
  assert.ok(out.includes(SYNC_CLOSE_MARKER));
});

test('injectSyncBlock replaces an existing block in place, preserves prologue + epilogue', () => {
  const old = buildSyncBlock({ commits: [{ shortSha: 'old1', subject: 'old work' }], files: [], syncedAt: 'then' });
  const body = `Prologue here.\n\n${old}\n\nEpilogue here.`;
  const fresh = buildSyncBlock({ commits: [{ shortSha: 'new1', subject: 'new work' }], files: ['src/foo.ts'], syncedAt: 'now' });
  const out = injectSyncBlock(body, fresh);
  assert.ok(out.startsWith('Prologue here.'));
  assert.ok(out.includes('new work'));
  assert.ok(!out.includes('old work'));
  assert.ok(out.endsWith('Epilogue here.\n') || out.endsWith('Epilogue here.'));
});

test('injectSyncBlock returns just the block for an empty body', () => {
  const block = buildSyncBlock({ commits: [], files: [], syncedAt: 't' });
  assert.equal(injectSyncBlock('', block), block);
  assert.equal(injectSyncBlock('   \n\n', block), block);
});

test('parseCommitsForSync returns commits oldest-first and caps at max', () => {
  // git log is newest-first by default.
  const raw = 'fff9999|newest\nbbb2222|middle\naaa1111|oldest';
  const commits = parseCommitsForSync(raw, 10);
  assert.equal(commits.length, 3);
  assert.equal(commits[0].shortSha, 'aaa1111'); // oldest first
  assert.equal(commits[2].shortSha, 'fff9999');
});

test('parseCommitsForSync caps at max (keeps the newest N when reversed)', () => {
  const raw = 'eee5555|e\nddd4444|d\nccc3333|c\nbbb2222|b\naaa1111|a';
  const commits = parseCommitsForSync(raw, 2);
  // After reverse, the list is a,b,c,d,e — slice(-2) yields the last 2,
  // i.e. the two newest in chronological order.
  assert.equal(commits.length, 2);
  assert.deepEqual(commits.map(c => c.shortSha), ['ddd4444', 'eee5555']);
});

test('parseCommitsForSync handles empty input and malformed rows', () => {
  assert.deepEqual(parseCommitsForSync('', 10), []);
  assert.deepEqual(parseCommitsForSync('\n\n\n', 10), []);
  assert.deepEqual(parseCommitsForSync('no-pipe-here', 10), []);
  assert.deepEqual(parseCommitsForSync('|no-sha', 10), []);
});

test('parseFilesForSync sorts and dedupes', () => {
  const raw = 'src/b.ts\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts\n';
  const files = parseFilesForSync(raw, 100);
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
});

test('parseFilesForSync caps at max', () => {
  const raw = 'a\nb\nc\nd\ne';
  assert.deepEqual(parseFilesForSync(raw, 2), ['a', 'b']);
});

test('needsRewrite is true when the body has no managed block', () => {
  const block = buildSyncBlock({ commits: [], files: [], syncedAt: 't' });
  assert.equal(needsRewrite('plain body, no markers', block), true);
});

test('needsRewrite is false when contents match (timestamp ignored)', () => {
  const oldBlock = buildSyncBlock({ commits: [{ shortSha: 'aaa1111', subject: 'fix' }], files: ['a.ts'], syncedAt: 'then' });
  const newBlock = buildSyncBlock({ commits: [{ shortSha: 'aaa1111', subject: 'fix' }], files: ['a.ts'], syncedAt: 'now' });
  const body = `prologue\n\n${oldBlock}\n\nepilogue`;
  assert.equal(needsRewrite(body, newBlock), false);
});

test('needsRewrite is true when commit list changes', () => {
  const oldBlock = buildSyncBlock({ commits: [{ shortSha: 'aaa1111', subject: 'fix' }], files: [], syncedAt: 'then' });
  const newBlock = buildSyncBlock({ commits: [{ shortSha: 'bbb2222', subject: 'feat' }], files: [], syncedAt: 'now' });
  const body = `prose\n${oldBlock}\nmore prose`;
  assert.equal(needsRewrite(body, newBlock), true);
});

test('round-trip: inject, re-inject with new contents, prologue/epilogue intact', () => {
  const first = buildSyncBlock({ commits: [{ shortSha: 'aaa1111', subject: 'init' }], files: [], syncedAt: 't1' });
  let body = injectSyncBlock('## My PR\n\nWhat this does:\n- thing one\n', first);
  const second = buildSyncBlock({
    commits: [{ shortSha: 'aaa1111', subject: 'init' }, { shortSha: 'bbb2222', subject: 'more' }],
    files: ['src/foo.ts'],
    syncedAt: 't2',
  });
  body = injectSyncBlock(body, second);
  assert.ok(body.startsWith('## My PR'));
  assert.ok(body.includes('thing one'));
  assert.ok(body.includes('- aaa1111 init'));
  assert.ok(body.includes('- bbb2222 more'));
  // Only one managed block in the final body.
  const openCount = body.split(SYNC_OPEN_MARKER).length - 1;
  const closeCount = body.split(SYNC_CLOSE_MARKER).length - 1;
  assert.equal(openCount, 1);
  assert.equal(closeCount, 1);
});
