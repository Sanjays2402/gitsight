import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  detectRunner,
  parseHookOutput,
  describeResult,
  summarise,
  bypassCommand,
  PreCommitResult,
} from '../../src/git/preCommitBridge';

test('detectRunner: husky + lint-staged combo', () => {
  const out = '> husky - pre-commit\n> lint-staged\n... eslint output ...';
  assert.equal(detectRunner(out), 'husky-lint-staged');
});

test('detectRunner: lint-staged alone', () => {
  assert.equal(detectRunner('lint-staged: prettier --write'), 'lint-staged');
});

test('detectRunner: husky alone', () => {
  assert.equal(detectRunner('husky - pre-commit hook failed'), 'husky');
});

test('detectRunner: python pre-commit framework', () => {
  const out = '[INFO] Installing environment for ...\n[INFO] Running hook: ruff\nFailed\n- hook id: ruff\n- exit code: 1';
  assert.equal(detectRunner(out), 'pre-commit');
});

test('detectRunner: tsc by error code', () => {
  const out = 'src/foo.ts(12,5): error TS2304: Cannot find name';
  assert.equal(detectRunner(out), 'tsc');
});

test('detectRunner: eslint by rule namespace', () => {
  const out = "src/foo.ts\n  12:5  error  'x' is defined but never used  no-unused-vars";
  assert.equal(detectRunner(out), 'unknown'); // no eslint substring or @typescript-eslint
});

test('detectRunner: eslint by explicit mention', () => {
  assert.equal(detectRunner('eslint failed with 3 errors'), 'eslint');
});

test('detectRunner: prettier by signature line', () => {
  assert.equal(detectRunner('[warn] Code style issues found in the above file(s).'), 'prettier');
});

test('detectRunner: rubocop', () => {
  assert.equal(detectRunner('running rubocop on changed files'), 'rubocop');
});

test('detectRunner: black', () => {
  assert.equal(detectRunner('black would reformat foo.py'), 'black');
});

test('detectRunner: shellscript fallback', () => {
  assert.equal(detectRunner('+ echo hello\n+ exit 1'), 'shellscript');
});

test('detectRunner: unknown when nothing matches', () => {
  assert.equal(detectRunner('random gibberish'), 'unknown');
});

test('parseHookOutput: tsc format with rule code', () => {
  const out = "src/foo.ts(12,5): error TS2304: Cannot find name 'foo'.";
  const findings = parseHookOutput(out, 'tsc');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/foo.ts');
  assert.equal(findings[0].line, 12);
  assert.equal(findings[0].column, 5);
  assert.equal(findings[0].rule, 'TS2304');
});

test('parseHookOutput: eslint stylish layout', () => {
  const out = [
    '',
    '/Users/sanjay/src/foo.ts',
    "  12:5  error  'x' is defined but never used  no-unused-vars",
    "  15:1  warning  Missing semicolon  semi",
    '',
    '2 problems',
  ].join('\n');
  const findings = parseHookOutput(out, 'eslint');
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, '/Users/sanjay/src/foo.ts');
  assert.equal(findings[0].line, 12);
  assert.equal(findings[0].rule, 'no-unused-vars');
  assert.equal(findings[1].line, 15);
});

test('parseHookOutput: generic path:line:col:message', () => {
  const out = 'src/bar.ts:42:8: warning: unused import';
  const findings = parseHookOutput(out, 'unknown');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/bar.ts');
  assert.equal(findings[0].line, 42);
});

test('parseHookOutput: prettier file-only lines', () => {
  const out = '[warn] src/foo.ts\n[warn] src/bar.ts\n[warn] Code style issues found in the above file(s).';
  const findings = parseHookOutput(out, 'prettier');
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'src/foo.ts');
  assert.equal(findings[1].file, 'src/bar.ts');
});

test('parseHookOutput: python File "x", line N', () => {
  const out = '  File "src/app.py", line 42, in foo\n    something = bar()\nValueError: nope';
  const findings = parseHookOutput(out, 'pre-commit');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/app.py');
  assert.equal(findings[0].line, 42);
});

test('parseHookOutput: dedupes identical findings', () => {
  const out = "src/foo.ts(12,5): error TS2304: Cannot find name 'foo'.\nsrc/foo.ts(12,5): error TS2304: Cannot find name 'foo'.";
  const findings = parseHookOutput(out, 'tsc');
  assert.equal(findings.length, 1);
});

test('parseHookOutput: rejects path-less garbage', () => {
  const out = 'This is just a random log message with no file.\nAnother random line.';
  const findings = parseHookOutput(out, 'unknown');
  assert.equal(findings.length, 0);
});

test('describeResult: pass case', () => {
  const r: PreCommitResult = { runner: 'eslint', findings: [], raw: '', exitCode: 0, hasOpenableTarget: false };
  assert.equal(describeResult(r), 'pre-commit hook passed');
});

test('describeResult: no findings parseable', () => {
  const r: PreCommitResult = { runner: 'shellscript', findings: [], raw: 'random', exitCode: 1, hasOpenableTarget: false };
  assert.equal(describeResult(r), 'pre-commit hook failed (shellscript) — no parseable findings');
});

test('describeResult: counted findings', () => {
  const r: PreCommitResult = {
    runner: 'eslint',
    findings: [
      { file: 'a.ts', line: 1, message: 'x', source: 'eslint' },
      { file: 'a.ts', line: 2, message: 'y', source: 'eslint' },
      { file: 'b.ts', line: 1, message: 'z', source: 'eslint' },
    ],
    raw: '',
    exitCode: 1,
    hasOpenableTarget: true,
  };
  assert.equal(describeResult(r), 'pre-commit (eslint) — 3 findings in 2 files');
});

test('summarise: eslint needs an edit', () => {
  const r: PreCommitResult = {
    runner: 'eslint',
    findings: [{ file: 'a.ts', line: 1, message: 'x', source: 'eslint' }],
    raw: '',
    exitCode: 1,
    hasOpenableTarget: true,
  };
  const s = summarise(r);
  assert.equal(s.total, 1);
  assert.equal(s.files, 1);
  assert.equal(s.needsCodeEdit, true);
  assert.equal(s.rerunMaybeHelps, false);
});

test('summarise: prettier rerun helps', () => {
  const r: PreCommitResult = {
    runner: 'prettier',
    findings: [{ file: 'a.ts', message: 'style', source: 'prettier' }],
    raw: '',
    exitCode: 1,
    hasOpenableTarget: true,
  };
  const s = summarise(r);
  assert.equal(s.rerunMaybeHelps, true);
  assert.equal(s.needsCodeEdit, false);
});

test('bypassCommand: no message → bare', () => {
  assert.equal(bypassCommand(), 'git commit --no-verify');
});

test('bypassCommand: escapes single quotes', () => {
  const cmd = bypassCommand("don't break");
  assert.match(cmd, /git commit --no-verify -m 'don'\\''t break'/);
});

test('parseHookOutput: caps absurdly long lines', () => {
  const huge = 'x'.repeat(5000);
  const findings = parseHookOutput(`${huge}\nsrc/foo.ts(1,1): error TS1: oops`, 'tsc');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/foo.ts');
});
