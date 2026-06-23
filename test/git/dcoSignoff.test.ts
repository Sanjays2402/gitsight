import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  detectDcoRequirement,
  hasSignoffTrailer,
  composeSignoffLine,
  lintCommitMessageForDco,
  appendSignoffTrailer,
  DCO_CANDIDATE_FILES,
} from '../../src/git/dcoSignoff';

test('detectDcoRequirement: top-level DCO file alone forces required', () => {
  const r = detectDcoRequirement([
    { path: 'DCO', body: 'Developer Certificate of Origin, version 1.1' },
  ]);
  assert.equal(r.verdict, 'required');
  assert.equal(r.source, 'DCO');
});

test('detectDcoRequirement: DCO.md treated same as DCO', () => {
  const r = detectDcoRequirement([
    { path: 'DCO.md', body: 'short stub' },
  ]);
  assert.equal(r.verdict, 'required');
});

test('detectDcoRequirement: CONTRIBUTING with required verb triggers required', () => {
  const r = detectDcoRequirement([
    {
      path: 'CONTRIBUTING.md',
      body: '## Contributions\nWe require all commits to be signed-off (DCO). Use git commit -s.',
    },
  ]);
  assert.equal(r.verdict, 'required');
  assert.equal(r.source, 'CONTRIBUTING.md');
});

test('detectDcoRequirement: CONTRIBUTING with prefer/encourage triggers suggested', () => {
  const r = detectDcoRequirement([
    {
      path: 'CONTRIBUTING.md',
      body: 'We encourage sign-off (Signed-off-by) but do not enforce it.',
    },
  ]);
  assert.equal(r.verdict, 'suggested');
});

test('detectDcoRequirement: plain mention without verb still surfaces as suggested', () => {
  const r = detectDcoRequirement([
    {
      path: 'CONTRIBUTING.md',
      body: 'Some contributors use Signed-off-by trailers; YMMV.',
    },
  ]);
  assert.equal(r.verdict, 'suggested');
});

test('detectDcoRequirement: no mention anywhere returns unknown', () => {
  const r = detectDcoRequirement([
    { path: 'CONTRIBUTING.md', body: 'open an issue to discuss; PRs welcome' },
    { path: 'CODE_OF_CONDUCT.md', body: 'be nice' },
  ]);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.source, undefined);
});

test('detectDcoRequirement: DCO file wins over CONTRIBUTING mention', () => {
  const r = detectDcoRequirement([
    { path: 'CONTRIBUTING.md', body: 'We require sign-off (DCO).' },
    { path: 'DCO', body: 'official DCO 1.1' },
  ]);
  assert.equal(r.verdict, 'required');
  assert.equal(r.source, 'DCO');  // not CONTRIBUTING.md
});

test('detectDcoRequirement: required verbs include must / mandate / enforce', () => {
  for (const verb of ['must', 'mandate', 'enforces']) {
    const r = detectDcoRequirement([
      { path: 'CONTRIBUTING.md', body: `All commits ${verb} a Signed-off-by trailer.` },
    ]);
    assert.equal(r.verdict, 'required', `verb=${verb}`);
  }
});

test('hasSignoffTrailer: matches any sign-off when no identity', () => {
  const msg = 'feat: x\n\nSigned-off-by: Alice <alice@example.com>';
  assert.equal(hasSignoffTrailer(msg), true);
});

test('hasSignoffTrailer: identity match is case-insensitive on email', () => {
  const msg = 'fix: y\n\nSigned-off-by: Bob <Bob@Example.COM>';
  assert.equal(hasSignoffTrailer(msg, { name: 'Bob', email: 'bob@example.com' }), true);
});

test('hasSignoffTrailer: returns false when identity email does not match', () => {
  const msg = 'fix: y\n\nSigned-off-by: Bob <bob@example.com>';
  assert.equal(hasSignoffTrailer(msg, { name: 'Alice', email: 'alice@example.com' }), false);
});

test('hasSignoffTrailer: empty message is false', () => {
  assert.equal(hasSignoffTrailer(''), false);
  assert.equal(hasSignoffTrailer('feat: no body'), false);
});

test('composeSignoffLine renders Name <email>', () => {
  const line = composeSignoffLine({ name: 'Alice Smith', email: 'alice@example.com' });
  assert.equal(line, 'Signed-off-by: Alice Smith <alice@example.com>');
});

test('composeSignoffLine returns empty for missing fields', () => {
  assert.equal(composeSignoffLine({ name: '', email: 'x@y.z' }), '');
  assert.equal(composeSignoffLine({ name: 'a', email: '' }), '');
});

test('lintCommitMessageForDco: missing trailer produces problem with composed example', () => {
  const problems = lintCommitMessageForDco(
    'feat: x\n\nbody here',
    { identity: { name: 'A', email: 'a@b.c' }, severity: 'error' },
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'missing-signoff');
  assert.equal(problems[0].severity, 'error');
  assert.match(problems[0].message, /Signed-off-by: A <a@b\.c>/);
});

test('lintCommitMessageForDco: wrong email produces a wrong-email-signoff problem', () => {
  const problems = lintCommitMessageForDco(
    'feat: x\n\nbody\n\nSigned-off-by: Other <other@nowhere.com>',
    { identity: { name: 'Me', email: 'me@here.com' } },
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'wrong-email-signoff');
});

test('lintCommitMessageForDco: matching sign-off returns empty', () => {
  const problems = lintCommitMessageForDco(
    'feat: x\n\nbody\n\nSigned-off-by: Me <me@here.com>',
    { identity: { name: 'Me', email: 'me@here.com' } },
  );
  assert.equal(problems.length, 0);
});

test('lintCommitMessageForDco: no identity required just means any sign-off counts', () => {
  const problems = lintCommitMessageForDco('feat: x\n\nbody\n\nSigned-off-by: A <a@b.c>');
  assert.equal(problems.length, 0);
});

test('lintCommitMessageForDco: default severity is warning', () => {
  const problems = lintCommitMessageForDco('feat: x');
  assert.equal(problems[0].severity, 'warning');
});

test('appendSignoffTrailer: adds blank line + trailer when body has no trailers', () => {
  const out = appendSignoffTrailer(
    'feat: x\n\nthe body',
    { name: 'A', email: 'a@b.c' },
  );
  assert.match(out, /\n\nSigned-off-by: A <a@b\.c>$/);
});

test('appendSignoffTrailer: subject-only message gets blank line + trailer', () => {
  const out = appendSignoffTrailer(
    'feat: x',
    { name: 'A', email: 'a@b.c' },
  );
  assert.match(out, /^feat: x\n\nSigned-off-by:/);
});

test('appendSignoffTrailer: idempotent when same identity already signed', () => {
  const msg = 'feat: x\n\nbody\n\nSigned-off-by: A <a@b.c>';
  assert.equal(appendSignoffTrailer(msg, { name: 'A', email: 'a@b.c' }), msg);
});

test('appendSignoffTrailer: appends inline when existing trailer block present', () => {
  const msg = 'feat: x\n\nbody\n\nCo-authored-by: X <x@y.z>';
  const out = appendSignoffTrailer(msg, { name: 'Me', email: 'me@here.com' });
  // Should NOT introduce a second blank line between Co-authored-by and Signed-off-by.
  assert.match(out, /Co-authored-by: X <x@y\.z>\nSigned-off-by: Me <me@here\.com>$/);
});

test('appendSignoffTrailer: empty message returns just the trailer line', () => {
  const out = appendSignoffTrailer('', { name: 'A', email: 'a@b.c' });
  assert.equal(out, 'Signed-off-by: A <a@b.c>');
});

test('DCO_CANDIDATE_FILES has DCO ahead of CONTRIBUTING in priority order', () => {
  const dcoIdx = DCO_CANDIDATE_FILES.findIndex(p => /^DCO/.test(p));
  const contribIdx = DCO_CANDIDATE_FILES.findIndex(p => /CONTRIBUTING/.test(p));
  assert.ok(dcoIdx >= 0 && contribIdx >= 0);
  assert.ok(dcoIdx < contribIdx, 'DCO must come first');
});

test('hasSignoffTrailer: multiple sign-offs in body work', () => {
  const msg = 'feat: x\n\nbody\n\nSigned-off-by: A <a@b.c>\nSigned-off-by: B <b@c.d>';
  assert.equal(hasSignoffTrailer(msg, { name: 'B', email: 'b@c.d' }), true);
  assert.equal(hasSignoffTrailer(msg, { name: 'A', email: 'a@b.c' }), true);
  assert.equal(hasSignoffTrailer(msg, { name: 'C', email: 'c@d.e' }), false);
});

test('appendSignoffTrailer: preserves CRLF input as LF + trailer in output', () => {
  const msg = 'feat: x\r\n\r\nbody';
  const out = appendSignoffTrailer(msg, { name: 'A', email: 'a@b.c' });
  // Output is LF; trailer present.
  assert.equal(/\r/.test(out), false);
  assert.match(out, /Signed-off-by: A <a@b\.c>$/);
});
