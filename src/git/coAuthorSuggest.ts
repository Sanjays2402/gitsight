/**
 * Pure helpers for the Find Co-Authors feature (F18).
 *
 * Given a stream of commit metadata (author + body) plus a list of self-aliases
 * (current `user.email`s the user considers themselves), produce a ranked list
 * of suggested co-authors derived from:
 *
 *   1. Co-authored-by trailers across the scanned range.
 *   2. Authors who co-touched files with the user but aren't the user themselves.
 *
 * Ranking factors:
 *
 *   - frequency  (commits where this person appeared)
 *   - recency    (lower-decay weight for older appearances)
 *
 * Returned shape is plain data — the picker UI lives in src/views/findCoAuthors.ts.
 */

import { parseCoAuthors, CoAuthor } from './coAuthors';

export interface SuggestionInput {
  /** SHA of the commit (unique). */
  sha: string;
  /** Commit author name (raw). */
  authorName: string;
  /** Commit author email, lower-cased. */
  authorEmail: string;
  /** Full commit body (subject + body); used to extract trailers. */
  message: string;
  /** Author date. */
  date: Date;
}

export interface CoAuthorSuggestion {
  name: string;
  email: string;
  /** Number of commits the person appeared in (as author or trailer). */
  count: number;
  /** Most recent date this person was seen. */
  lastSeen: Date;
  /** Sort-time score (higher = better suggestion). */
  score: number;
  /** Where the suggestion came from. */
  sources: Set<'author' | 'trailer'>;
}

const HALF_LIFE_DAYS = 30; // commits older than 30d count half as much.

function recencyWeight(date: Date, now: Date): number {
  const dDays = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
  return Math.pow(0.5, dDays / HALF_LIFE_DAYS);
}

/**
 * Build co-author suggestions from a list of commits and the user's self-aliases.
 *
 * `self` is the lowercase set of email addresses the user owns. People matching
 * those emails are excluded from suggestions (you can't co-author with yourself).
 */
export function buildCoAuthorSuggestions(
  commits: SuggestionInput[],
  selfEmails: Iterable<string>,
  now: Date = new Date(),
): CoAuthorSuggestion[] {
  const self = new Set<string>();
  for (const e of selfEmails) {
    const trimmed = e.trim().toLowerCase();
    if (trimmed) self.add(trimmed);
  }

  const byEmail = new Map<string, CoAuthorSuggestion>();
  const bump = (name: string, emailLower: string, date: Date, src: 'author' | 'trailer') => {
    if (self.has(emailLower)) return;
    if (!emailLower) return;
    const existing = byEmail.get(emailLower);
    const weight = recencyWeight(date, now);
    if (existing) {
      existing.count += 1;
      if (date.getTime() > existing.lastSeen.getTime()) {
        existing.lastSeen = date;
        if (name) existing.name = name; // prefer the most recent display name.
      }
      existing.score += weight;
      existing.sources.add(src);
    } else {
      byEmail.set(emailLower, {
        name: name || emailLower,
        email: emailLower,
        count: 1,
        lastSeen: date,
        score: weight,
        sources: new Set([src]),
      });
    }
  };

  for (const c of commits) {
    const authorEmail = c.authorEmail.toLowerCase();
    bump(c.authorName, authorEmail, c.date, 'author');
    for (const co of parseCoAuthors(c.message)) {
      bump(co.name, co.email.toLowerCase(), c.date, 'trailer');
    }
  }

  return [...byEmail.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen.getTime() - a.lastSeen.getTime();
  });
}

/** Render the trailer block to append to a commit message. */
export function buildTrailerBlock(picks: CoAuthor[]): string {
  if (!picks.length) return '';
  return picks.map(p => `Co-authored-by: ${p.name} <${p.email}>`).join('\n');
}

/**
 * Insert a trailer block into an existing commit message, preserving any
 * trailing whitespace/newlines that the user already typed and de-duplicating
 * trailers that are already present.
 */
export function insertTrailers(currentMessage: string, picks: CoAuthor[]): string {
  if (!picks.length) return currentMessage;
  const existing = parseCoAuthors(currentMessage);
  const existingEmails = new Set(existing.map(e => e.email.toLowerCase()));
  const fresh = picks.filter(p => !existingEmails.has(p.email.toLowerCase()));
  if (!fresh.length) return currentMessage;
  const block = buildTrailerBlock(fresh);
  const trimmed = currentMessage.replace(/[\s\n]+$/, '');
  // If the message already ends with a trailer line, append more trailers
  // immediately after; otherwise insert with a blank line separator.
  if (existing.length > 0 && currentMessage.match(/Co-authored-by:.*$/m)) {
    return `${trimmed}\n${block}\n`;
  }
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}
