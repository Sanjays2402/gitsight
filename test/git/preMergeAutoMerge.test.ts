import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAutoMergeOffer,
  normaliseAutoMergeStrategy,
  buildAutoMergeArgs,
  describeAutoMergeCommand,
  describeAutoMergeRow,
  shouldShowAutoMergeRow,
  describeAutoMergeBreadcrumb,
  decideAutoMergeRow,
} from '../../src/git/preMergeAutoMerge';
import { MergeReport } from '../../src/git/preMergeChecklist';

function fakeReport(verdict: MergeReport['verdict']): MergeReport {
  return {
    checks: [],
    verdict,
    counts: { ok: 0, warning: 0, error: 0 },
  };
}

describe('F144 - classifyAutoMergeOffer', () => {
  it('offers when verdict is ready with pending checks', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'ready',
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 3,
    });
    assert.equal(v, 'offer');
  });

  it('offers when caution verdict has pending checks', () => {
    // Caution is allowed - --auto still works, user has time to read
    // the warnings while CI runs.
    const v = classifyAutoMergeOffer({
      verdict: 'caution',
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 2,
    });
    assert.equal(v, 'offer');
  });

  it('unnecessary when ready with no pending checks', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'ready',
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
    });
    assert.equal(v, 'unnecessary');
  });

  it('unnecessary when caution with no pending checks', () => {
    // The caution is something semantic - the user should see it
    // before merging, NOT have auto-merge bypass it.
    const v = classifyAutoMergeOffer({
      verdict: 'caution',
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
    });
    assert.equal(v, 'unnecessary');
  });

  it('blocked when verdict is blocked', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'blocked',
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 2,
    });
    assert.equal(v, 'blocked');
  });

  it('blocked when PR is draft', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'ready',
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 1,
      isDraft: true,
    });
    assert.equal(v, 'blocked');
  });

  it('blocked when DIRTY', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'caution',
      mergeStateStatus: 'DIRTY',
      pendingCheckCount: 1,
    });
    assert.equal(v, 'blocked');
  });

  it('unsupported when mergeStateStatus UNKNOWN', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'caution',
      mergeStateStatus: 'UNKNOWN',
      pendingCheckCount: 1,
    });
    assert.equal(v, 'unsupported');
  });

  it('auto-already-on wins over everything else', () => {
    const v = classifyAutoMergeOffer({
      verdict: 'blocked',
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 2,
      autoMergeEnabled: true,
    });
    assert.equal(v, 'auto-already-on');
  });

  it('auto-already-on wins even on a draft PR', () => {
    // Edge case: GitHub permits enabling auto on a draft if it was
    // enabled BEFORE the draft toggle. Surface the disable option.
    const v = classifyAutoMergeOffer({
      verdict: 'ready',
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
      autoMergeEnabled: true,
      isDraft: true,
    });
    assert.equal(v, 'auto-already-on');
  });
});

describe('F144 - normaliseAutoMergeStrategy', () => {
  it('passes through canonical lowercase strategies', () => {
    assert.deepEqual(normaliseAutoMergeStrategy('squash'), { strategy: 'squash', coerced: false });
    assert.deepEqual(normaliseAutoMergeStrategy('rebase'), { strategy: 'rebase', coerced: false });
    assert.deepEqual(normaliseAutoMergeStrategy('merge'),  { strategy: 'merge',  coerced: false });
  });

  it('lowercases mixed-case inputs', () => {
    assert.deepEqual(normaliseAutoMergeStrategy('Squash'),  { strategy: 'squash', coerced: false });
    assert.deepEqual(normaliseAutoMergeStrategy('REBASE'),  { strategy: 'rebase', coerced: false });
  });

  it('coerces unknown shapes to merge', () => {
    assert.deepEqual(normaliseAutoMergeStrategy('fast-forward'),
                     { strategy: 'merge', coerced: true });
    assert.deepEqual(normaliseAutoMergeStrategy(''),  { strategy: 'merge', coerced: true });
    assert.deepEqual(normaliseAutoMergeStrategy(undefined), { strategy: 'merge', coerced: true });
  });
});

describe('F144 - buildAutoMergeArgs', () => {
  it('builds the enable-auto command for squash', () => {
    const argv = buildAutoMergeArgs({ prNumber: 42, strategy: 'squash' });
    assert.deepEqual(argv, ['pr', 'merge', '42', '--auto', '--squash']);
  });

  it('builds the enable-auto command for rebase', () => {
    const argv = buildAutoMergeArgs({ prNumber: 7, strategy: 'rebase' });
    assert.deepEqual(argv, ['pr', 'merge', '7', '--auto', '--rebase']);
  });

  it('builds the enable-auto command for merge (default)', () => {
    const argv = buildAutoMergeArgs({ prNumber: 100, strategy: 'merge' });
    assert.deepEqual(argv, ['pr', 'merge', '100', '--auto', '--merge']);
  });

  it('builds the disable-auto command with no strategy flag', () => {
    const argv = buildAutoMergeArgs({ prNumber: 42, strategy: 'merge', disable: true });
    assert.deepEqual(argv, ['pr', 'merge', '42', '--disable-auto']);
    // Critical: no `--merge` flag - GitHub remembers the strategy.
    assert.equal(argv.includes('--merge'), false);
  });

  it('appends --subject when supplied', () => {
    const argv = buildAutoMergeArgs({
      prNumber: 1,
      strategy: 'squash',
      subject: 'feat: ship F144',
    });
    assert.ok(argv.includes('--subject=feat: ship F144'));
  });

  it('appends --body when supplied', () => {
    const argv = buildAutoMergeArgs({
      prNumber: 1,
      strategy: 'merge',
      body: 'Multi-line body here.',
    });
    assert.ok(argv.includes('--body=Multi-line body here.'));
  });

  it('skips --subject when value is whitespace only', () => {
    const argv = buildAutoMergeArgs({ prNumber: 1, strategy: 'merge', subject: '   ' });
    assert.equal(argv.some(a => a.startsWith('--subject=')), false);
  });

  it('returns empty array for an invalid PR number', () => {
    assert.deepEqual(buildAutoMergeArgs({ prNumber: 0, strategy: 'merge' }), []);
    assert.deepEqual(buildAutoMergeArgs({ prNumber: -1, strategy: 'merge' }), []);
    assert.deepEqual(buildAutoMergeArgs({ prNumber: Number.NaN, strategy: 'merge' }), []);
  });
});

describe('F144 - describeAutoMergeCommand', () => {
  it('joins safe argv unquoted', () => {
    const cmd = describeAutoMergeCommand(['pr', 'merge', '42', '--auto', '--squash']);
    assert.equal(cmd, 'gh pr merge 42 --auto --squash');
  });

  it('quotes args containing spaces', () => {
    const cmd = describeAutoMergeCommand([
      'pr', 'merge', '1', '--auto', '--merge',
      '--subject=feat: ship F144',
    ]);
    assert.ok(cmd.includes(`'--subject=feat: ship F144'`));
  });

  it('escapes embedded single quotes', () => {
    const cmd = describeAutoMergeCommand([
      'pr', 'merge', '1', '--auto', '--merge', `--body=It's working`,
    ]);
    // The shell-safe escape: close-quote -> escaped-quote -> reopen-quote.
    assert.match(cmd, /'\\''/);
  });

  it('returns empty string on empty argv', () => {
    assert.equal(describeAutoMergeCommand([]), '');
  });
});

describe('F144 - describeAutoMergeRow', () => {
  it('singular pending check', () => {
    const c = describeAutoMergeRow('offer', 1);
    assert.equal(c.label, 'Enable auto-merge');
    assert.match(c.detail, /remaining required check/);
  });

  it('plural pending checks', () => {
    const c = describeAutoMergeRow('offer', 4);
    assert.match(c.detail, /all 4 required checks/);
  });

  it('describes the unnecessary state', () => {
    const c = describeAutoMergeRow('unnecessary', 0);
    assert.match(c.label, /not needed/);
    assert.match(c.detail, /Merge now/);
  });

  it('describes the disable case', () => {
    const c = describeAutoMergeRow('auto-already-on', 0);
    assert.equal(c.label, 'Disable auto-merge');
  });

  it('describes the blocked state', () => {
    const c = describeAutoMergeRow('blocked', 0);
    assert.match(c.label, /blocked/);
  });
});

describe('F144 - shouldShowAutoMergeRow', () => {
  it('shows offer / unnecessary / auto-already-on', () => {
    assert.equal(shouldShowAutoMergeRow('offer'), true);
    assert.equal(shouldShowAutoMergeRow('unnecessary'), true);
    assert.equal(shouldShowAutoMergeRow('auto-already-on'), true);
  });

  it('hides blocked / unsupported', () => {
    assert.equal(shouldShowAutoMergeRow('blocked'), false);
    assert.equal(shouldShowAutoMergeRow('unsupported'), false);
  });
});

describe('F144 - describeAutoMergeBreadcrumb', () => {
  it('emits pending count for offer', () => {
    const s = describeAutoMergeBreadcrumb({
      verdict: 'caution',
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 2,
    });
    assert.match(s, /2 required checks still pending/);
  });

  it('singularises the one-check case', () => {
    const s = describeAutoMergeBreadcrumb({
      verdict: 'ready',
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 1,
    });
    assert.match(s, /1 required check still pending/);
  });

  it('emits empty string for blocked/unsupported', () => {
    assert.equal(describeAutoMergeBreadcrumb({
      verdict: 'blocked',
      mergeStateStatus: 'DIRTY',
      pendingCheckCount: 0,
    }), '');
    assert.equal(describeAutoMergeBreadcrumb({
      verdict: 'caution',
      mergeStateStatus: 'UNKNOWN',
      pendingCheckCount: 0,
    }), '');
  });

  it('says "not needed" for ready+0', () => {
    const s = describeAutoMergeBreadcrumb({
      verdict: 'ready',
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
    });
    assert.match(s, /not needed/);
  });

  it('says "already enabled" when auto is on', () => {
    const s = describeAutoMergeBreadcrumb({
      verdict: 'ready',
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
      autoMergeEnabled: true,
    });
    assert.match(s, /already enabled/);
  });
});

describe('F144 - decideAutoMergeRow (compose helper)', () => {
  it('composes verdict + copy + shown flag', () => {
    const d = decideAutoMergeRow(fakeReport('ready'), {
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 3,
    });
    assert.equal(d.shown, true);
    assert.equal(d.verdict, 'offer');
    assert.match(d.copy.detail, /all 3 required checks/);
  });

  it('hides the row when verdict is blocked', () => {
    const d = decideAutoMergeRow(fakeReport('blocked'), {
      mergeStateStatus: 'BLOCKED',
      pendingCheckCount: 2,
    });
    assert.equal(d.shown, false);
  });

  it('still shows unnecessary as a discoverability row', () => {
    const d = decideAutoMergeRow(fakeReport('ready'), {
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
    });
    assert.equal(d.shown, true);
    assert.equal(d.verdict, 'unnecessary');
  });

  it('shows the disable row when auto is already on', () => {
    const d = decideAutoMergeRow(fakeReport('ready'), {
      mergeStateStatus: 'CLEAN',
      pendingCheckCount: 0,
      autoMergeEnabled: true,
    });
    assert.equal(d.verdict, 'auto-already-on');
    assert.equal(d.shown, true);
    assert.equal(d.copy.label, 'Disable auto-merge');
  });
});
