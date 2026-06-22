/**
 * Pure helpers for the Reviewer-from-Shortlog fallback (F91).
 *
 * When a repo has no CODEOWNERS file, F57's default-reviewers picker
 * has nothing to suggest. F91 fills that gap: rank reviewers from the
 * top-N committers across the changed-file subset (`git shortlog -sne
 * --no-merges -- <changed paths>` per file, aggregated), with the
 * F85 round-robin re-rank applied on top.
 *
 * Why this is its own helper rather than a branch inside F47's
 * filesIOwn:
 *   - F47 asks "do I own this?" (single-user, dominance-based).
 *   - F91 asks "who else has been editing this?" (multi-user, ranked).
 *   - The two share the per-path shortlog signal but differ on the
 *     output shape — F91 needs the same ReviewerSuggestion shape that
 *     buildReviewerSuggestions emits so the picker UI is uniform.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/reviewersFromShortlog.test.ts.
 */
import { ReviewerSuggestion, ReviewerKind, AuthorIdentity } from './defaultReviewers';
import { ShortlogEntry } from './filesIOwn';

export interface BuildFromShortlogArgs {
  /** Per-file shortlog entries from parseShortlog (filesIOwn). */
  shortlog: ShortlogEntry[];
  /** Paths changed by the PR (repo-relative). */
  changedPaths: string[];
  /** Author identity — dropped from suggestions (you can't review your own PR). */
  author: AuthorIdentity;
  /**
   * Extra handles to permanently exclude (config `exclude`). Compared
   * case-insensitively against the email-local-part AND the full email.
   */
  extraExcluded?: string[];
  /**
   * Maximum number of suggestions to return per coverage tier. Default
   * is 5 — anything more drowns the picker and the round-robin re-rank
   * provides the variety we need.
   */
  perTierLimit?: number;
  /**
   * Map a shortlog identity (lower-case email or name) to a GitHub
   * handle. Optional but recommended: when provided, the displayHandle
   * uses `@handle` so the picker UX matches F57's CODEOWNERS-driven
   * output. When omitted, we fall back to the email local-part as the
   * "handle" (still copy-pasteable, just less polished).
   */
  identityToHandle?: Map<string, string>;
}

/**
 * Aggregate the per-path commit counts into per-handle scores, then
 * shape them as ReviewerSuggestion[] so the F57 picker can render
 * them uniformly.
 *
 * Tiers come from "how many of the changed paths did this person touch
 * at least once?" — same coverage semantics as F57. Within a tier,
 * insertion is alphabetical (round-robin re-rank applies afterwards).
 */
export function buildFromShortlog(args: BuildFromShortlogArgs): ReviewerSuggestion[] {
  const {
    shortlog,
    changedPaths,
    author,
    extraExcluded = [],
    perTierLimit = 5,
    identityToHandle,
  } = args;
  if (!changedPaths.length || !shortlog.length) return [];

  const excluded = new Set<string>();
  for (const h of [author.handle, ...(extraExcluded ?? [])]) {
    if (!h) continue;
    excluded.add(h.toLowerCase().replace(/^@/, ''));
  }
  if (author.email) excluded.add(author.email.toLowerCase());

  // Index shortlog by path for fast lookup.
  const byPath = new Map<string, Record<string, number>>();
  for (const entry of shortlog) byPath.set(entry.path, entry.byAuthor);

  // Per-handle owned paths.
  const byHandle = new Map<string, { paths: Set<string>; commits: number }>();
  for (const p of changedPaths) {
    const authors = byPath.get(p);
    if (!authors) continue;
    for (const [identity, count] of Object.entries(authors)) {
      if (excluded.has(identity)) continue;
      // Exclude the author's local-part (alice@foo vs alice@bar) by
      // checking the email-local-part too.
      const localPart = identity.includes('@') ? identity.slice(0, identity.indexOf('@')) : identity;
      if (excluded.has(localPart)) continue;
      const handle = resolveHandle(identity, localPart, identityToHandle);
      if (!handle) continue;
      const key = handle.toLowerCase();
      if (excluded.has(key)) continue;
      let slot = byHandle.get(key);
      if (!slot) {
        slot = { paths: new Set(), commits: 0 };
        byHandle.set(key, slot);
      }
      slot.paths.add(p);
      slot.commits += count;
    }
  }

  const total = changedPaths.length;
  const out: ReviewerSuggestion[] = [];
  for (const [handleLower, slot] of byHandle) {
    const ownedPaths = [...slot.paths].sort();
    out.push({
      handle: handleLower,
      displayHandle: handleLower.startsWith('@') ? handleLower : `@${handleLower}`,
      kind: 'user' satisfies ReviewerKind,
      ownedPaths,
      coverage: ownedPaths.length / total,
    });
  }

  // Sort: coverage desc, then commit-count desc (busiest first), then
  // alphabetical. Round-robin re-rank applies afterwards.
  out.sort((a, b) => {
    if (b.ownedPaths.length !== a.ownedPaths.length) {
      return b.ownedPaths.length - a.ownedPaths.length;
    }
    return a.handle.localeCompare(b.handle);
  });

  // Per-tier limit.
  if (perTierLimit > 0) {
    const tiers = new Map<number, ReviewerSuggestion[]>();
    for (const s of out) {
      const tier = s.ownedPaths.length;
      let bucket = tiers.get(tier);
      if (!bucket) {
        bucket = [];
        tiers.set(tier, bucket);
      }
      bucket.push(s);
    }
    const capped: ReviewerSuggestion[] = [];
    const tiersSorted = [...tiers.keys()].sort((a, b) => b - a);
    for (const tier of tiersSorted) {
      const bucket = tiers.get(tier)!;
      for (const s of bucket.slice(0, perTierLimit)) capped.push(s);
    }
    return capped;
  }

  return out;
}

function resolveHandle(
  identity: string,
  localPart: string,
  identityToHandle: Map<string, string> | undefined,
): string | undefined {
  if (identityToHandle) {
    const direct = identityToHandle.get(identity);
    if (direct) return direct.toLowerCase().replace(/^@/, '');
    const viaLocal = identityToHandle.get(localPart);
    if (viaLocal) return viaLocal.toLowerCase().replace(/^@/, '');
  }
  // Fall back to the email local-part as a pseudo-handle. Skip when the
  // local-part is obviously a bot / noreply pattern so we don't suggest
  // "@49699333+dependabot[bot]" as a reviewer.
  if (!localPart) return undefined;
  if (isBotIdentity(localPart, identity)) return undefined;
  return localPart.toLowerCase();
}

const BOT_PATTERNS = [
  /\bbot\b/i,
  /\bdependabot\b/i,
  /\brenovate\b/i,
  /noreply@/i,
  /\[bot\]/i,
  /github-actions/i,
];

function isBotIdentity(localPart: string, identity: string): boolean {
  for (const re of BOT_PATTERNS) {
    if (re.test(localPart) || re.test(identity)) return true;
  }
  return false;
}

/**
 * Build the `identityToHandle` map from `gh api users -F q=<email>`
 * results or a config map. The view layer fills this in (or leaves it
 * empty when offline) — the helper just consumes whatever is provided.
 */
export function buildIdentityIndex(entries: Array<{ identity: string; handle: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!e?.identity || !e?.handle) continue;
    out.set(e.identity.toLowerCase(), e.handle.toLowerCase());
  }
  return out;
}

/**
 * F96 — Self-review verdict.
 *
 * When the F91 fallback drains to an empty suggestion list, the user
 * needs to know WHY (so they don't think the feature is broken). This
 * verdict explains the empty result and suggests the next step:
 *
 *   - `self-dominant`: the author IS the top shortlog contributor for
 *     these paths — no one else has been editing them. The user should
 *     consider the F47 "files I own" picker explicitly, or accept that
 *     a peer-fresh-eyes review may not be available for this PR slice.
 *
 *   - `bot-only`: every other contributor in scope is a bot/noreply
 *     identity (dependabot, renovate, github-actions). Falls back to
 *     the same self-dominant action.
 *
 *   - `no-history`: paths have no commit history at all (new files in
 *     the PR). Reviewer-picker is the wrong tool — suggest CODEOWNERS
 *     or a manual mention.
 *
 *   - `degraded`: shortlog ran but returned 0 entries (most likely
 *     because `git log` was empty on the requested range — e.g. a
 *     shallow clone). Different UX than no-history: we should show
 *     the deepen-clone hint rather than the new-file hint.
 *
 *   - `ok`: there ARE suggestions — caller should NOT bother showing
 *     a self-review hint at all.
 *
 * Pure — operates on the same inputs as buildFromShortlog plus its
 * already-computed suggestion list.
 */
export type SelfReviewVerdict =
  | 'ok'
  | 'self-dominant'
  | 'bot-only'
  | 'no-history'
  | 'degraded';

export interface SelfReviewArgs {
  /** Suggestions produced by buildFromShortlog (post-cap, post-rerank). */
  suggestions: ReviewerSuggestion[];
  /** Per-file shortlog entries (the same input fed to buildFromShortlog). */
  shortlog: ShortlogEntry[];
  /** Paths the PR is changing. */
  changedPaths: string[];
  /** Author identity. */
  author: AuthorIdentity;
}

export function classifySelfReview(args: SelfReviewArgs): SelfReviewVerdict {
  const { suggestions, shortlog, changedPaths, author } = args;
  if (suggestions.length > 0) return 'ok';
  if (!changedPaths.length) return 'no-history';

  // Did the shortlog return anything for these paths?
  const relevantEntries = shortlog.filter(e => changedPaths.includes(e.path));
  if (!relevantEntries.length) return 'no-history';

  const authorEmail = (author.email || '').toLowerCase();
  const authorLocal = authorEmail.includes('@') ? authorEmail.slice(0, authorEmail.indexOf('@')) : authorEmail;
  let sawAuthor = false;
  let sawOther = false;
  let sawNonBot = false;
  for (const entry of relevantEntries) {
    for (const identity of Object.keys(entry.byAuthor)) {
      const id = identity.toLowerCase();
      if (id === authorEmail || (authorLocal && id === authorLocal) || id === (authorEmail.includes('@') ? authorEmail.slice(0, authorEmail.indexOf('@')) : '')) {
        sawAuthor = true;
        continue;
      }
      sawOther = true;
      if (!isBotIdentity(id.includes('@') ? id.slice(0, id.indexOf('@')) : id, id)) {
        sawNonBot = true;
      }
    }
  }
  if (!sawOther) {
    // Shortlog has entries but none from non-author identities.
    return sawAuthor ? 'self-dominant' : 'degraded';
  }
  if (!sawNonBot) return 'bot-only';
  // Other humans WERE in scope but buildFromShortlog filtered them all
  // (extraExcluded, etc.). Treat as self-dominant — the picker did its
  // job; the user explicitly told us to exclude them.
  return 'self-dominant';
}

export interface SelfReviewHint {
  verdict: SelfReviewVerdict;
  summary: string;
  detail: string;
  /** Suggested follow-up command name (mirrors a registered VS Code command). */
  suggestedCommand?: string;
}

/**
 * Human-readable hint shape for the F57 picker UI to render when the
 * suggestion list is empty. Keeps the verdict classification + the
 * UI copy decoupled so we can A/B the wording later without touching
 * the classifier.
 */
export function buildSelfReviewHint(verdict: SelfReviewVerdict, paths: number): SelfReviewHint {
  const filesWord = paths === 1 ? '1 file' : `${paths} files`;
  switch (verdict) {
    case 'self-dominant':
      return {
        verdict,
        summary: `You are the dominant contributor across ${filesWord} \u2014 no peers in scope.`,
        detail:
          'Shortlog ranks YOU as the busiest editor of these paths over the lookback window. ' +
          'No teammates appear in scope, so the reviewer picker has nothing to suggest. ' +
          'If you still want a review, mention a teammate directly or open the "Files I own" picker to see the full author breakdown per file.',
        suggestedCommand: 'gitsight.filesIOwn',
      };
    case 'bot-only':
      return {
        verdict,
        summary: `Only bot accounts have touched these ${filesWord} besides you.`,
        detail:
          'Dependabot / Renovate / github-actions and similar automated identities show up in the shortlog but are filtered out as reviewer suggestions. ' +
          'You will likely need to manually mention a human reviewer; the "Files I own" picker can help identify nearby maintainers.',
        suggestedCommand: 'gitsight.filesIOwn',
      };
    case 'no-history':
      return {
        verdict,
        summary: `${filesWord} are new — no commit history to mine.`,
        detail:
          'The changed paths have no git history yet, so the shortlog reviewer-picker has nothing to rank. ' +
          'For brand-new files, fall back to CODEOWNERS, a team-wide mention, or pick a peer who owns adjacent code.',
      };
    case 'degraded':
      return {
        verdict,
        summary: 'Shortlog ran empty \u2014 possibly a shallow clone.',
        detail:
          'git shortlog returned no entries for the changed paths. Most common cause: this is a shallow clone (CI default) and the relevant commits live deeper in history. ' +
          'Try `git fetch --unshallow` and re-run, or fall back to CODEOWNERS / a manual mention.',
      };
    case 'ok':
    default:
      return { verdict: 'ok', summary: '', detail: '' };
  }
}
