/**
 * GitSight shared graph-snapshot contract (W2).
 *
 * STACK-AGNOSTIC. The JSON shape the bundled companion server emits and
 * the standalone web app consumes. Defined here (not in web/ or the
 * server) so BOTH ends type-check against one source of truth and never
 * drift. The pure `buildGraphSnapshot` builder is added in W3.
 *
 * Dates are ISO strings (not Date objects) so the snapshot survives
 * JSON.stringify over the wire; the web app parses them for relative-time
 * display.
 *
 * Tests: test/git/graphSnapshot.test.ts (added in W3 with the builder).
 */

import type { GraphInputCommit } from './graphCore';

/** One commit in a graph snapshot. Extends the lane-algorithm input
 *  (`sha` + `parents`) so it can be fed straight to `assignLanes`. */
export interface GraphSnapshotCommit extends GraphInputCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  /** Decoration refs (`%D`): branch names, `tag: x`, `HEAD -> y`. */
  refs: string[];
}

/** A full snapshot of a repository's commit graph. */
export interface GraphSnapshot {
  /** Repo display name (basename of the working tree). */
  repo: string;
  /** Current branch name, or a short sha when detached. */
  head: string;
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  /** Number of commits in `commits` (may be capped below total history). */
  commitCount: number;
  /** Commits in `git log` order (newest first). */
  commits: GraphSnapshotCommit[];
  /**
   * The `origin` remote URL, when the repo has one (W28). Lets the web app
   * build "Open on remote" links for a commit via the shared remoteUrl
   * helper. Omitted when there's no origin (a local-only repo).
   */
  remote?: string;
}

/** The current snapshot wire-format version. Bumped if the shape changes
 *  so a stale web build can warn instead of silently mis-rendering. */
export const SNAPSHOT_VERSION = 1;
