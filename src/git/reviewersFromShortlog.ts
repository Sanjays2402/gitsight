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
