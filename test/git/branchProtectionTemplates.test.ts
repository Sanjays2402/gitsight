import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TEMPLATES,
  TemplateId,
  getTemplate,
  buildTemplateSuggestions,
  buildTemplatePreview,
  describeTemplateDelta,
  classifyTemplateCoverage,
} from '../../src/git/branchProtectionTemplates';
import type { ProtectionRule } from '../../src/git/forcePushGuard';

function ids(...rs: Array<ProtectionRule['id']>) { return new Set<ProtectionRule['id']>(rs); }

// ── TEMPLATES + getTemplate ───────────────────────────────────────────

test('TEMPLATES has the three documented templates', () => {
  const got = TEMPLATES.map(t => t.id).sort();
  assert.deepEqual(got, ['internal-strict', 'open-source-friendly', 'release-only']);
});

test('TEMPLATES: each has non-empty label/description/rationale/rules', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.label, `${t.id} label`);
    assert.ok(t.description, `${t.id} description`);
    assert.ok(t.rationale, `${t.id} rationale`);
    assert.ok(t.rules.length > 0, `${t.id} rules`);
  }
});

test('open-source-friendly: leaves enforce-admins OFF', () => {
  const t = getTemplate('open-source-friendly')!;
  assert.ok(!t.rules.includes('enforce-admins'),
    'OSS template intentionally leaves admin bypass available - documented behaviour');
});

test('internal-strict: includes signatures + linear + enforce-admins', () => {
  const t = getTemplate('internal-strict')!;
  assert.ok(t.rules.includes('required-signatures'));
  assert.ok(t.rules.includes('required-linear-history'));
  assert.ok(t.rules.includes('enforce-admins'));
});

test('release-only: locks the branch + linear + no force/delete', () => {
  const t = getTemplate('release-only')!;
  assert.ok(t.rules.includes('lock-branch'));
  assert.ok(t.rules.includes('required-linear-history'));
  assert.ok(t.rules.includes('force-push'));
  assert.ok(t.rules.includes('deletions'));
  // release-only doesn't require PR review by design - it's append-only
  // after the cut, not under active development.
  assert.ok(!t.rules.includes('required-reviews'),
    'release-only is for append-only refs; pre-merge review is not the gate');
});

test('getTemplate: unknown id returns undefined', () => {
  assert.equal(getTemplate('nope' as TemplateId), undefined);
});

// ── buildTemplateSuggestions ──────────────────────────────────────────

test('buildTemplateSuggestions: returns one suggestion per rule when nothing enabled', () => {
  const t = getTemplate('open-source-friendly')!;
  const out = buildTemplateSuggestions({ template: t, currentlyEnabled: ids() });
  assert.equal(out.length, t.rules.length);
  for (const s of out) {
    assert.equal(s.strength, 'recommended');
  }
});

test('buildTemplateSuggestions: drops rules already enabled', () => {
  const t = getTemplate('open-source-friendly')!;
  const out = buildTemplateSuggestions({
    template: t,
    currentlyEnabled: ids('force-push', 'deletions'),
  });
  const outIds = out.map(s => s.id).sort();
  assert.deepEqual(outIds, ['required-reviews', 'required-status-checks']);
});

test('buildTemplateSuggestions: empty when every rule is already on', () => {
  const t = getTemplate('open-source-friendly')!;
  const out = buildTemplateSuggestions({
    template: t,
    currentlyEnabled: ids(...t.rules),
  });
  assert.equal(out.length, 0);
});

test('buildTemplateSuggestions: preserves template authoring order via weight', () => {
  const t = getTemplate('internal-strict')!;
  const out = buildTemplateSuggestions({ template: t, currentlyEnabled: ids() });
  // First-in-template should have higher weight than last-in-template.
  assert.ok(out[0].weight > out[out.length - 1].weight);
  // Same ordering when sorted by weight desc.
  const sortedIds = [...out].sort((a, b) => b.weight - a.weight).map(s => s.id);
  assert.deepEqual(sortedIds, out.map(s => s.id));
});

test('buildTemplateSuggestions: labels come from the documented label map', () => {
  const t = getTemplate('internal-strict')!;
  const out = buildTemplateSuggestions({ template: t, currentlyEnabled: ids() });
  for (const s of out) {
    assert.ok(s.label && !s.label.startsWith('required-'),
      `id ${s.id} should have a friendly label, not the raw id`);
  }
});

test('buildTemplateSuggestions: internal-strict rationale calls out the philosophy on review', () => {
  const t = getTemplate('internal-strict')!;
  const out = buildTemplateSuggestions({ template: t, currentlyEnabled: ids() });
  const review = out.find(s => s.id === 'required-reviews');
  assert.ok(review);
  assert.match(review!.rationale, /Internal strict/);
});

// ── buildTemplatePreview ──────────────────────────────────────────────

test('buildTemplatePreview: full preview with rules + review count', () => {
  const t = getTemplate('open-source-friendly')!;
  const suggestions = buildTemplateSuggestions({ template: t, currentlyEnabled: ids() });
  const md = buildTemplatePreview({ template: t, branch: 'main', suggestions });
  assert.match(md, /# Template: Open-source friendly/);
  assert.match(md, /Applying to branch: `main`/);
  assert.match(md, /## 4 rules to enable/);
  assert.match(md, /Require PR review/);
  assert.match(md, /Required approving reviews: 1/);
});

test('buildTemplatePreview: already-covered shows the all-on copy', () => {
  const t = getTemplate('open-source-friendly')!;
  const md = buildTemplatePreview({
    template: t,
    branch: 'main',
    suggestions: [],
  });
  assert.match(md, /already all enabled/);
});

test('buildTemplatePreview: release-only does not list a review count', () => {
  const t = getTemplate('release-only')!;
  const suggestions = buildTemplateSuggestions({ template: t, currentlyEnabled: ids() });
  const md = buildTemplatePreview({ template: t, branch: 'release/1.0', suggestions });
  assert.doesNotMatch(md, /Required approving reviews/);
  assert.match(md, /append-only after the release cut/);
});

// ── describeTemplateDelta ─────────────────────────────────────────────

test('describeTemplateDelta: partial coverage', () => {
  const t = getTemplate('open-source-friendly')!;
  const suggestions = buildTemplateSuggestions({
    template: t,
    currentlyEnabled: ids('force-push'),
  });
  const s = describeTemplateDelta({ template: t, suggestions });
  assert.match(s, /3 of 4 rules to enable/);
});

test('describeTemplateDelta: already covered', () => {
  const t = getTemplate('open-source-friendly')!;
  const s = describeTemplateDelta({ template: t, suggestions: [] });
  assert.match(s, /already covered/);
});

// ── classifyTemplateCoverage ──────────────────────────────────────────

test('classifyTemplateCoverage: all rules on -> already-covered', () => {
  const t = getTemplate('open-source-friendly')!;
  assert.equal(
    classifyTemplateCoverage({ template: t, currentlyEnabled: ids(...t.rules) }),
    'already-covered',
  );
});

test('classifyTemplateCoverage: zero rules on -> none', () => {
  const t = getTemplate('open-source-friendly')!;
  assert.equal(
    classifyTemplateCoverage({ template: t, currentlyEnabled: ids() }),
    'none',
  );
});

test('classifyTemplateCoverage: some rules on -> partial', () => {
  const t = getTemplate('open-source-friendly')!;
  assert.equal(
    classifyTemplateCoverage({ template: t, currentlyEnabled: ids('force-push') }),
    'partial',
  );
});

test('classifyTemplateCoverage: counts only rules that match the template', () => {
  const t = getTemplate('release-only')!;
  // 'required-reviews' is NOT in release-only - having it on should
  // not contribute to coverage of release-only.
  assert.equal(
    classifyTemplateCoverage({
      template: t,
      currentlyEnabled: ids('required-reviews'),
    }),
    'none',
  );
});
