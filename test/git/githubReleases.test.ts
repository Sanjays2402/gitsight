import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseReleaseList,
  parseReleaseDetail,
  describeReleaseListEntry,
  renderReleaseMarkdown,
  suggestCreateFromTag,
} from '../../src/git/githubReleases';

const sampleList = JSON.stringify([
  { tagName: 'v1.16.0', name: 'v1.16.0', publishedAt: '2026-06-19T10:00:00Z', isDraft: false, isPrerelease: false, url: 'https://github.com/foo/bar/releases/tag/v1.16.0' },
  { tagName: 'v1.16.0-rc.1', name: 'v1.16.0-rc.1', publishedAt: '2026-06-15T10:00:00Z', isDraft: false, isPrerelease: true, url: 'https://github.com/foo/bar/releases/tag/v1.16.0-rc.1' },
  { tagName: 'next', name: 'Next (draft)', publishedAt: '', isDraft: true, isPrerelease: false, url: 'https://github.com/foo/bar/releases/edit/untagged-abc' },
]);

test('parseReleaseList returns one entry per JSON record with defaults', () => {
  const out = parseReleaseList(sampleList);
  assert.equal(out.length, 3);
  assert.equal(out[0].tagName, 'v1.16.0');
  assert.equal(out[0].isDraft, false);
  assert.equal(out[0].isPrerelease, false);
  assert.equal(out[1].isPrerelease, true);
  assert.equal(out[2].isDraft, true);
});

test('parseReleaseList drops entries without a tagName', () => {
  const raw = JSON.stringify([{ tagName: '' }, { tagName: 'real', name: 'Real' }]);
  const out = parseReleaseList(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].tagName, 'real');
});

test('parseReleaseList returns [] for empty / invalid input', () => {
  assert.deepEqual(parseReleaseList(''), []);
  assert.deepEqual(parseReleaseList('   '), []);
  assert.deepEqual(parseReleaseList('not-json'), []);
  assert.deepEqual(parseReleaseList(JSON.stringify({ not: 'array' })), []);
});

test('parseReleaseList defaults missing fields rather than throwing', () => {
  const raw = JSON.stringify([{ tagName: 'v1' }]);
  const out = parseReleaseList(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'v1');
  assert.equal(out[0].publishedAt, '');
  assert.equal(out[0].isDraft, false);
  assert.equal(out[0].url, '');
});

test('parseReleaseDetail extracts body + flags', () => {
  const raw = JSON.stringify({
    tagName: 'v1.16.0', name: 'v1.16.0', publishedAt: '2026-06-19T10:00:00Z',
    isDraft: false, isPrerelease: false, url: 'https://x', body: '## What changed\n\n- thing',
  });
  const out = parseReleaseDetail(raw);
  assert.ok(out);
  assert.equal(out!.tagName, 'v1.16.0');
  assert.match(out!.body, /What changed/);
});

test('parseReleaseDetail returns undefined for invalid input', () => {
  assert.equal(parseReleaseDetail(''), undefined);
  assert.equal(parseReleaseDetail('not-json'), undefined);
  assert.equal(parseReleaseDetail(JSON.stringify({})), undefined); // no tagName
});

test('describeReleaseListEntry produces a stable single-line summary', () => {
  const r = parseReleaseList(sampleList);
  assert.equal(describeReleaseListEntry(r[0], '3d ago'), 'v1.16.0  \u00b7  3d ago');
  assert.equal(describeReleaseListEntry(r[1], '6h ago'), 'v1.16.0-rc.1  \u00b7  prerelease  \u00b7  6h ago');
  assert.equal(describeReleaseListEntry(r[2], ''),       'next  \u00b7  draft  \u00b7  not published');
});

test('describeReleaseListEntry falls back to em-dash when no relativeDate', () => {
  const e = { tagName: 'v1', name: 'v1', publishedAt: '', isDraft: false, isPrerelease: false, url: '' };
  assert.equal(describeReleaseListEntry(e, ''), 'v1  \u00b7  \u2014');
});

test('renderReleaseMarkdown produces a complete markdown buffer', () => {
  const detail = {
    tagName: 'v1.16.0', name: 'v1.16.0', publishedAt: '2026-06-19T10:00:00Z',
    isDraft: false, isPrerelease: false,
    url: 'https://github.com/foo/bar/releases/tag/v1.16.0',
    body: '- shiny\n- new thing',
  };
  const out = renderReleaseMarkdown(detail, '3d ago');
  assert.match(out, /^# v1\.16\.0 \(v1\.16\.0\)/);
  assert.match(out, /\*Published 3d ago\*/);
  assert.match(out, /\[Open on GitHub\]\(https/);
  assert.match(out, /- shiny\n- new thing/);
});

test('renderReleaseMarkdown shows a placeholder when body is empty', () => {
  const detail = {
    tagName: 'v0', name: 'v0', publishedAt: '2026-01-01T00:00:00Z',
    isDraft: false, isPrerelease: false, url: '', body: '',
  };
  const out = renderReleaseMarkdown(detail, '');
  assert.match(out, /_No release notes\._/);
});

test('renderReleaseMarkdown flags drafts as Not yet published', () => {
  const detail = {
    tagName: 'v0', name: 'v0', publishedAt: '', isDraft: true,
    isPrerelease: false, url: '', body: '',
  };
  const out = renderReleaseMarkdown(detail, '');
  assert.match(out, /\*Not yet published\*/);
});

test('renderReleaseMarkdown includes draft/prerelease tag line', () => {
  const detail = {
    tagName: 'v0', name: 'v0', publishedAt: '2026-01-01T00:00:00Z',
    isDraft: false, isPrerelease: true, url: '', body: 'body',
  };
  const out = renderReleaseMarkdown(detail, '1d ago');
  assert.match(out, /_prerelease_/);
});

test('suggestCreateFromTag returns the newest local tag when unreleased', () => {
  const tags = 'v2.0.0\nv1.16.0\nv1.15.0';
  const releases = parseReleaseList(sampleList);
  assert.equal(suggestCreateFromTag(tags, releases), 'v2.0.0');
});

test('suggestCreateFromTag returns undefined when latest tag has a matching release', () => {
  const tags = 'v1.16.0\nv1.15.0';
  const releases = parseReleaseList(sampleList);
  assert.equal(suggestCreateFromTag(tags, releases), undefined);
});

test('suggestCreateFromTag returns undefined for empty tag list', () => {
  assert.equal(suggestCreateFromTag('', []), undefined);
  assert.equal(suggestCreateFromTag('\n\n\n', []), undefined);
});

test('suggestCreateFromTag handles a freshly tagged repo with no releases', () => {
  assert.equal(suggestCreateFromTag('v0.1.0', []), 'v0.1.0');
});
