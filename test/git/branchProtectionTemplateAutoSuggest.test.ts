import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTemplateAutoSuggest,
  pickRecommendedTemplate,
  buildAutoSuggestHeadline,
  buildAutoSuggestDetail,
  buildAutoSuggestPayload,
  listAlternativeTemplates,
} from '../../src/git/branchProtectionTemplateAutoSuggest';
import { ProtectionDecision } from '../../src/git/forcePushGuard';

describe('F146 - classifyTemplateAutoSuggest verdicts', () => {
  it('recommend when decision is undefined', () => {
    assert.equal(
      classifyTemplateAutoSuggest({ decision: undefined, role: 'default' }),
      'recommend',
    );
  });

  it('recommend on unprotected', () => {
    const d: ProtectionDecision = { kind: 'unprotected' };
    assert.equal(classifyTemplateAutoSuggest({ decision: d, role: 'default' }), 'recommend');
  });

  it('recommend on unknown', () => {
    const d: ProtectionDecision = { kind: 'unknown', reason: 'gh missing' };
    assert.equal(classifyTemplateAutoSuggest({ decision: d, role: 'default' }), 'recommend');
  });

  it('recommend on protected-with-zero-rules', () => {
    const d: ProtectionDecision = {
      kind: 'protected',
      allowsForcePush: true,
      rules: [
        { id: 'enforce-admins', enabled: false, label: 'admins' },
        { id: 'force-push', enabled: false, label: 'force-push' },
      ],
    };
    assert.equal(classifyTemplateAutoSuggest({ decision: d, role: 'default' }), 'recommend');
  });

  it('show-secondary on partial protection (1-4 rules)', () => {
    const d: ProtectionDecision = {
      kind: 'protected',
      allowsForcePush: false,
      rules: [
        { id: 'force-push', enabled: true, label: 'force-push' },
        { id: 'deletions', enabled: true, label: 'deletions' },
      ],
    };
    assert.equal(classifyTemplateAutoSuggest({ decision: d, role: 'default' }), 'show-secondary');
  });

  it('suppress on comprehensive protection (5+ rules)', () => {
    const d: ProtectionDecision = {
      kind: 'protected',
      allowsForcePush: false,
      rules: [
        { id: 'force-push', enabled: true, label: 'force-push' },
        { id: 'deletions', enabled: true, label: 'deletions' },
        { id: 'required-reviews', enabled: true, label: 'reviews' },
        { id: 'required-status-checks', enabled: true, label: 'checks' },
        { id: 'enforce-admins', enabled: true, label: 'admins' },
      ],
    };
    assert.equal(classifyTemplateAutoSuggest({ decision: d, role: 'default' }), 'suppress');
  });
});

describe('F146 - pickRecommendedTemplate', () => {
  it('default + open-source -> open-source-friendly', () => {
    const t = pickRecommendedTemplate({ role: 'default', isOpenSource: true });
    assert.equal(t?.id, 'open-source-friendly');
  });

  it('default + internal -> internal-strict', () => {
    const t = pickRecommendedTemplate({ role: 'default', isOpenSource: false });
    assert.equal(t?.id, 'internal-strict');
  });

  it('default + unknown -> open-source-friendly (safer default)', () => {
    const t = pickRecommendedTemplate({ role: 'default' });
    assert.equal(t?.id, 'open-source-friendly');
  });

  it('release -> release-only', () => {
    const t = pickRecommendedTemplate({ role: 'release', isOpenSource: true });
    assert.equal(t?.id, 'release-only');
  });

  it('hotfix -> release-only', () => {
    const t = pickRecommendedTemplate({ role: 'hotfix' });
    assert.equal(t?.id, 'release-only');
  });

  it('long-lived -> open-source-friendly', () => {
    const t = pickRecommendedTemplate({ role: 'long-lived' });
    assert.equal(t?.id, 'open-source-friendly');
  });

  it('feature -> undefined', () => {
    assert.equal(pickRecommendedTemplate({ role: 'feature' }), undefined);
  });

  it('other -> undefined', () => {
    assert.equal(pickRecommendedTemplate({ role: 'other' }), undefined);
  });
});

describe('F146 - buildAutoSuggestHeadline', () => {
  const tpl = pickRecommendedTemplate({ role: 'default', isOpenSource: true })!;

  it('builds recommend headline', () => {
    const s = buildAutoSuggestHeadline(tpl, 'recommend');
    assert.match(s, /Apply.*Open-source friendly.*recommended/);
  });

  it('builds secondary headline', () => {
    const s = buildAutoSuggestHeadline(tpl, 'show-secondary');
    assert.match(s, /Reset to.*Open-source friendly/);
  });

  it('empty string for suppress', () => {
    assert.equal(buildAutoSuggestHeadline(tpl, 'suppress'), '');
  });
});

describe('F146 - buildAutoSuggestDetail', () => {
  const tpl = pickRecommendedTemplate({ role: 'default' })!;

  it('explains role + template for recommend', () => {
    const s = buildAutoSuggestDetail({
      template: tpl,
      role: 'default',
      verdict: 'recommend',
    });
    assert.match(s, /default branch/);
    // Detail also includes the template description.
    assert.match(s, /PR review/);
  });

  it('says "replace existing" for secondary', () => {
    const s = buildAutoSuggestDetail({
      template: tpl,
      role: 'default',
      verdict: 'show-secondary',
    });
    assert.match(s, /Replace existing/);
  });

  it('empty for suppress', () => {
    const s = buildAutoSuggestDetail({
      template: tpl,
      role: 'default',
      verdict: 'suppress',
    });
    assert.equal(s, '');
  });

  it('describes release-fit for release branches', () => {
    const release = pickRecommendedTemplate({ role: 'release' })!;
    const s = buildAutoSuggestDetail({
      template: release,
      role: 'release',
      verdict: 'recommend',
    });
    assert.match(s, /Release branches/);
  });
});

describe('F146 - buildAutoSuggestPayload (compose)', () => {
  it('returns full payload for default + first-time + OSS', () => {
    const p = buildAutoSuggestPayload({
      decision: { kind: 'unprotected' },
      role: 'default',
      isOpenSource: true,
    });
    assert.ok(p);
    assert.equal(p?.template.id, 'open-source-friendly');
    assert.equal(p?.verdict, 'recommend');
    assert.equal(p?.prePick, true);
    assert.match(p!.headline, /recommended/);
  });

  it('returns undefined for suppress verdict', () => {
    const p = buildAutoSuggestPayload({
      decision: {
        kind: 'protected',
        allowsForcePush: false,
        rules: [
          { id: 'force-push', enabled: true, label: 'force-push' },
          { id: 'deletions', enabled: true, label: 'deletions' },
          { id: 'required-reviews', enabled: true, label: 'reviews' },
          { id: 'required-status-checks', enabled: true, label: 'checks' },
          { id: 'enforce-admins', enabled: true, label: 'admins' },
        ],
      },
      role: 'default',
    });
    assert.equal(p, undefined);
  });

  it('returns undefined for feature role even with no protection', () => {
    const p = buildAutoSuggestPayload({
      decision: { kind: 'unprotected' },
      role: 'feature',
    });
    assert.equal(p, undefined);
  });

  it('returns show-secondary payload without prePick for partial protection', () => {
    const p = buildAutoSuggestPayload({
      decision: {
        kind: 'protected',
        allowsForcePush: false,
        rules: [
          { id: 'force-push', enabled: true, label: 'force-push' },
          { id: 'deletions', enabled: true, label: 'deletions' },
        ],
      },
      role: 'default',
      isOpenSource: true,
    });
    assert.ok(p);
    assert.equal(p?.verdict, 'show-secondary');
    assert.equal(p?.prePick, false);
    assert.match(p!.headline, /Reset to/);
  });
});

describe('F146 - listAlternativeTemplates', () => {
  it('excludes the recommended template from alternatives', () => {
    const alts = listAlternativeTemplates({ role: 'default', recommended: 'open-source-friendly' });
    assert.ok(!alts.find(t => t.id === 'open-source-friendly'),
      'recommended should be excluded');
    assert.ok(alts.find(t => t.id === 'internal-strict'),
      'other templates should remain');
  });

  it('hides release-only from non-release/non-hotfix branches', () => {
    const alts = listAlternativeTemplates({ role: 'long-lived', recommended: 'open-source-friendly' });
    assert.equal(alts.find(t => t.id === 'release-only'), undefined);
  });

  it('shows release-only when on a release branch', () => {
    const alts = listAlternativeTemplates({ role: 'release', recommended: 'open-source-friendly' });
    assert.ok(alts.find(t => t.id === 'release-only'),
      'release-only should be available on release branches');
  });

  it('shows release-only on the default branch too (admins might want lock semantics)', () => {
    const alts = listAlternativeTemplates({ role: 'default', recommended: 'internal-strict' });
    assert.ok(alts.find(t => t.id === 'release-only'));
  });
});
