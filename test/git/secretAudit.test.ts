import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scanWorkflowBody,
  buildAudit,
  pillLabel,
  pillTooltip,
  workflowFilesFromDir,
} from '../../src/git/secretAudit';

test('scanWorkflowBody: extracts dot-access secret names', () => {
  const body = [
    'name: ci',
    'on: push',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ${{ secrets.NPM_TOKEN }}',
    '      - run: echo ${{ secrets.SLACK_WEBHOOK }}',
  ].join('\n');
  const out = scanWorkflowBody('ci.yml', body);
  assert.equal(out.refs.length, 2);
  const names = out.refs.map(r => r.name).sort();
  assert.deepEqual(names, ['NPM_TOKEN', 'SLACK_WEBHOOK']);
  assert.equal(out.dynamicRefCount, 0);
});

test('scanWorkflowBody: extracts single + double quoted bracket access', () => {
  const body = [
    'env:',
    "  TOKEN: ${{ secrets['MY_TOKEN'] }}",
    '  KEY:   ${{ secrets["MY_KEY"] }}',
  ].join('\n');
  const out = scanWorkflowBody('w.yml', body);
  const names = out.refs.map(r => r.name).sort();
  assert.deepEqual(names, ['MY_KEY', 'MY_TOKEN']);
});

test('scanWorkflowBody: counts dynamic references separately', () => {
  const body = [
    'env:',
    '  X: ${{ secrets[matrix.envName] }}',
    '  Y: ${{ secrets[inputs.name] }}',
    '  Z: ${{ secrets.STATIC_ONE }}',
  ].join('\n');
  const out = scanWorkflowBody('w.yml', body);
  assert.equal(out.refs.length, 1);
  assert.equal(out.refs[0].name, 'STATIC_ONE');
  assert.equal(out.dynamicRefCount, 2);
});

test('scanWorkflowBody: line numbers reflect 1-based source position', () => {
  const body = [
    'line1',
    'line2 ${{ secrets.A }}',
    'line3',
    'line4 ${{ secrets.B }}',
  ].join('\n');
  const out = scanWorkflowBody('w.yml', body);
  const byName = Object.fromEntries(out.refs.map(r => [r.name, r.line]));
  assert.equal(byName.A, 2);
  assert.equal(byName.B, 4);
});

test('scanWorkflowBody: empty body returns empty result', () => {
  const out = scanWorkflowBody('w.yml', '');
  assert.deepEqual(out.refs, []);
  assert.equal(out.dynamicRefCount, 0);
});

test('buildAudit: flags missing names, keeps configured + built-ins', () => {
  const scans = [
    {
      workflow: 'ci.yml',
      refs: [
        { name: 'NPM_TOKEN',     workflow: 'ci.yml',     line: 5 },
        { name: 'GITHUB_TOKEN',  workflow: 'ci.yml',     line: 6 },
        { name: 'MISSING_KEY',   workflow: 'ci.yml',     line: 7 },
      ],
      dynamicRefCount: 0,
    },
    {
      workflow: 'deploy.yml',
      refs: [
        { name: 'NPM_TOKEN',     workflow: 'deploy.yml', line: 3 },
        { name: 'ANOTHER_MISS',  workflow: 'deploy.yml', line: 4 },
      ],
      dynamicRefCount: 1,
    },
  ];
  const configured = new Set(['NPM_TOKEN']);
  const audit = buildAudit({ scans, configured });
  assert.deepEqual(audit.referenced.sort(), ['ANOTHER_MISS', 'GITHUB_TOKEN', 'MISSING_KEY', 'NPM_TOKEN']);
  assert.deepEqual(audit.missing, ['ANOTHER_MISS', 'MISSING_KEY']);
  assert.equal(audit.refs.length, 5);
  assert.equal(audit.dynamicRefCount, 1);
});

test('buildAudit: empty input gives empty audit', () => {
  const audit = buildAudit({ scans: [], configured: new Set() });
  assert.deepEqual(audit.referenced, []);
  assert.deepEqual(audit.missing, []);
  assert.equal(audit.dynamicRefCount, 0);
});

test('buildAudit: case-sensitive comparison', () => {
  const audit = buildAudit({
    scans: [{ workflow: 'w.yml', refs: [
      { name: 'My_Token', workflow: 'w.yml', line: 1 },
      { name: 'MY_TOKEN', workflow: 'w.yml', line: 2 },
    ], dynamicRefCount: 0 }],
    configured: new Set(['MY_TOKEN']),
  });
  // Only My_Token (mixed case) is missing — MY_TOKEN matches configured.
  assert.deepEqual(audit.missing, ['My_Token']);
});

test('pillLabel: missing count gets singular/plural right', () => {
  const oneMissing = buildAudit({
    scans: [{ workflow: 'w.yml', refs: [{ name: 'A', workflow: 'w.yml', line: 1 }], dynamicRefCount: 0 }],
    configured: new Set(),
  });
  assert.equal(pillLabel(oneMissing), '1 missing secret');
  const threeMissing = buildAudit({
    scans: [{ workflow: 'w.yml', refs: [
      { name: 'A', workflow: 'w.yml', line: 1 },
      { name: 'B', workflow: 'w.yml', line: 2 },
      { name: 'C', workflow: 'w.yml', line: 3 },
    ], dynamicRefCount: 0 }],
    configured: new Set(),
  });
  assert.equal(pillLabel(threeMissing), '3 missing secrets');
});

test('pillLabel: ok state shows referenced count', () => {
  const allOk = buildAudit({
    scans: [{ workflow: 'w.yml', refs: [
      { name: 'A', workflow: 'w.yml', line: 1 },
      { name: 'B', workflow: 'w.yml', line: 2 },
    ], dynamicRefCount: 0 }],
    configured: new Set(['A', 'B']),
  });
  assert.equal(pillLabel(allOk), '2 secrets ok');
});

test('pillTooltip: lists missing with occurrence detail + workflow names', () => {
  const audit = buildAudit({
    scans: [
      { workflow: 'ci.yml',     refs: [{ name: 'MISS_A', workflow: 'ci.yml',     line: 1 }], dynamicRefCount: 0 },
      { workflow: 'ci.yml',     refs: [{ name: 'MISS_A', workflow: 'ci.yml',     line: 2 }], dynamicRefCount: 0 },
      { workflow: 'deploy.yml', refs: [{ name: 'MISS_B', workflow: 'deploy.yml', line: 5 }], dynamicRefCount: 0 },
    ],
    configured: new Set(),
  });
  const tip = pillTooltip(audit);
  assert.match(tip, /Missing on GitHub/);
  assert.match(tip, /MISS_A.*ci\.yml.*\u00d72/);
  assert.match(tip, /MISS_B.*deploy\.yml/);
  assert.match(tip, /2 referenced, 0 configured/);
});

test('pillTooltip: surfaces dynamic-ref count', () => {
  const audit = buildAudit({
    scans: [{ workflow: 'w.yml', refs: [], dynamicRefCount: 3 }],
    configured: new Set(),
  });
  const tip = pillTooltip(audit);
  assert.match(tip, /3 dynamic references not statically resolved/);
});

test('pillTooltip: escapes html-ish characters in secret names', () => {
  // Defensive — secret names can't actually contain < > backtick under
  // GitHub's rules, but we shield anyway against a hostile workflow file
  // that defines `secrets['<weird>']` so the tooltip doesn't break.
  const audit = buildAudit({
    scans: [{ workflow: 'a<b>.yml', refs: [{ name: '<weird>', workflow: 'a<b>.yml', line: 1 }], dynamicRefCount: 0 }],
    configured: new Set(),
  });
  const tip = pillTooltip(audit);
  assert.match(tip, /&lt;weird&gt;/);
  assert.match(tip, /a&lt;b&gt;\.yml/);
});

test('workflowFilesFromDir: keeps yaml/yml, drops others, sorted', () => {
  const entries = ['z.yml', 'README.md', 'a.yaml', 'b.json', 'c.YAML', 'd.ts'];
  assert.deepEqual(workflowFilesFromDir(entries), ['a.yaml', 'c.YAML', 'z.yml']);
});
