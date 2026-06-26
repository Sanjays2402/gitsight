/**
 * Snapshot data client (W4).
 *
 * Fetches the live GraphSnapshot from the companion server's /api/graph.
 * When the server isn't running (e.g. opened straight from a static
 * build with no backend), the caller falls back to the demo snapshot so
 * the app is never blank.
 */

import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';
import type { CommitDetail } from '@shared/commitDetail';
import type { FileDiff } from '@shared/diffParse';
import type { RepoEntry } from '@shared/repoPicker';
import type { BlameModel } from '@shared/blame';
import type { ActivityCalendar } from '@shared/activity';
import type { ContributorStats } from '@shared/contributors';
import type { AuthorDetail } from '@shared/authorDetail';
import type { RangeComparison } from '@shared/rangeCompare';
import type { StashList } from '@shared/stashes';

export type LoadResult =
  | { ok: true; snapshot: GraphSnapshot }
  | { ok: false; error: string; offline: boolean };

export type CommitDetailResult =
  | { ok: true; detail: CommitDetail }
  | { ok: false; error: string; offline: boolean };

export interface ReposPayload {
  repos: RepoEntry[];
  root: string | null;
}

export type ReposResult =
  | { ok: true; repos: RepoEntry[]; root: string | null }
  | { ok: false; error: string; offline: boolean };

/** A parsed single-file diff (file is null for an empty/unchanged path). */
export interface FileDiffPayload {
  rev: string;
  path: string;
  file: FileDiff | null;
}

export type FileDiffResult =
  | { ok: true; diff: FileDiffPayload }
  | { ok: false; error: string; offline: boolean };

/**
 * Validate that a parsed JSON payload has the GraphSnapshot shape before
 * we hand it to the renderer. Guards against a proxy returning HTML or a
 * server error object.
 */
export function isGraphSnapshot(v: unknown): v is GraphSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.repo === 'string' &&
    typeof o.head === 'string' &&
    typeof o.commitCount === 'number' &&
    Array.isArray(o.commits)
  );
}

/** Validate a parsed payload has the CommitDetail shape. */
export function isCommitDetail(v: unknown): v is CommitDetail {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sha === 'string' &&
    typeof o.subject === 'string' &&
    Array.isArray(o.files) &&
    Array.isArray(o.parents)
  );
}

export async function loadCommitDetail(
  sha: string,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<CommitDetailResult> {
  const qs = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : '';
  try {
    const res = await fetch(`/api/commit/${encodeURIComponent(sha)}${qs}`, {
      signal: opts.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: detail, offline: false };
    }
    const body: unknown = await res.json();
    if (!isCommitDetail(body)) {
      return { ok: false, error: 'Unexpected response shape from /api/commit', offline: false };
    }
    return { ok: true, detail: body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, offline: true };
  }
}

/** Validate a parsed payload has the FileDiffPayload shape. */
export function isFileDiffPayload(v: unknown): v is FileDiffPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.rev === 'string' && typeof o.path === 'string' && 'file' in o;
}

export async function loadFileDiff(
  rev: string,
  path: string,
  opts: { signal?: AbortSignal; repo?: string; ignoreWhitespace?: boolean } = {},
): Promise<FileDiffResult> {
  const repoParam = opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : '';
  const wsParam = opts.ignoreWhitespace ? '&ws=ignore' : '';
  const qs = `?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}${repoParam}${wsParam}`;
  try {
    const res = await fetch(`/api/diff${qs}`, {
      signal: opts.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: detail, offline: false };
    }
    const body: unknown = await res.json();
    if (!isFileDiffPayload(body)) {
      return { ok: false, error: 'Unexpected response shape from /api/diff', offline: false };
    }
    return { ok: true, diff: body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, offline: true };
  }
}

export async function loadSnapshot(opts: { max?: number; signal?: AbortSignal; repo?: string } = {}): Promise<LoadResult> {
  const params = new URLSearchParams();
  if (opts.max) params.set('max', String(opts.max));
  if (opts.repo) params.set('repo', opts.repo);
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetch(`/api/graph${qs}`, { signal: opts.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: detail, offline: false };
    }
    const body: unknown = await res.json();
    if (!isGraphSnapshot(body)) {
      return { ok: false, error: 'Unexpected response shape from /api/graph', offline: false };
    }
    return { ok: true, snapshot: body };
  } catch (e) {
    // Network error / server not running -> treat as offline.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, offline: true };
  }
}

/** Validate a parsed payload has the ReposPayload shape. */
export function isReposPayload(v: unknown): v is ReposPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.repos);
}

// ── Health (W25 — surfaces allowMutations) ───────────────────────────

export interface HealthPayload {
  ok: boolean;
  repo: string;
  head: string;
  root: string | null;
  allowMutations: boolean;
}

export type HealthResult =
  | { ok: true; health: HealthPayload }
  | { ok: false; error: string; offline: boolean };

export function isHealthPayload(v: unknown): v is HealthPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.ok === true && typeof o.repo === 'string';
}

/** Fetch the companion's health, including whether mutations are enabled. */
export async function loadHealth(opts: { signal?: AbortSignal } = {}): Promise<HealthResult> {
  return fetchJson<HealthPayload>('/api/health', isHealthPayload, opts.signal).then(r =>
    r.ok
      ? {
          ok: true,
          health: {
            ...r.value,
            root: r.value.root ?? null,
            allowMutations: r.value.allowMutations === true,
          },
        }
      : r,
  );
}

/** Fetch the switchable repo list (W8). */
export async function loadRepos(opts: { signal?: AbortSignal } = {}): Promise<ReposResult> {
  try {
    const res = await fetch('/api/repos', {
      signal: opts.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status}`, offline: false };
    }
    const body: unknown = await res.json();
    if (!isReposPayload(body)) {
      return { ok: false, error: 'Unexpected response shape from /api/repos', offline: false };
    }
    return { ok: true, repos: body.repos, root: body.root ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, offline: true };
  }
}

// ── Blame heatmap (W12) ──────────────────────────────────────────────

export interface BlamePayload extends BlameModel {
  rev: string;
  path: string;
}

export type BlameResult =
  | { ok: true; blame: BlamePayload }
  | { ok: false; error: string; offline: boolean };

/** Validate a parsed payload has the BlamePayload shape. */
export function isBlamePayload(v: unknown): v is BlamePayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.path === 'string' && Array.isArray(o.lines) && Array.isArray(o.authors);
}

/** Fetch a file's per-line blame heatmap model (W12). */
export async function loadBlame(
  rev: string,
  path: string,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<BlameResult> {
  const repoParam = opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : '';
  const qs = `?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}${repoParam}`;
  return fetchJson<BlamePayload>(`/api/blame${qs}`, isBlamePayload, opts.signal).then(r =>
    r.ok ? { ok: true, blame: r.value } : r,
  );
}

// ── Activity calendar (W13) ──────────────────────────────────────────

export interface ActivityPayload extends ActivityCalendar {
  repo: string;
  head: string;
}

export type ActivityResult =
  | { ok: true; activity: ActivityPayload }
  | { ok: false; error: string; offline: boolean };

export function isActivityPayload(v: unknown): v is ActivityPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.weeks) && Array.isArray(o.months) && typeof o.total === 'number';
}

/** Fetch the contribution calendar (W13). */
export async function loadActivity(
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<ActivityResult> {
  const qs = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : '';
  return fetchJson<ActivityPayload>(`/api/activity${qs}`, isActivityPayload, opts.signal).then(r =>
    r.ok ? { ok: true, activity: r.value } : r,
  );
}

// ── Activity day drill-down (W22) ────────────────────────────────────

/** One day's commits (the subset of the snapshot bucketed to that day). */
export interface DayPayload {
  repo: string;
  head: string;
  date: string;
  commits: GraphSnapshotCommit[];
  total: number;
}

export type DayResult =
  | { ok: true; day: DayPayload }
  | { ok: false; error: string; offline: boolean };

export function isDayPayload(v: unknown): v is DayPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.date === 'string' && Array.isArray(o.commits) && typeof o.total === 'number';
}

/** Fetch the commit list for one author-local day (W22 drill-down). */
export async function loadDay(
  date: string,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<DayResult> {
  const repoParam = opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : '';
  const qs = `?date=${encodeURIComponent(date)}${repoParam}`;
  return fetchJson<DayPayload>(`/api/day${qs}`, isDayPayload, opts.signal).then(r =>
    r.ok ? { ok: true, day: r.value } : r,
  );
}

// ── Contributors (W14) ───────────────────────────────────────────────

export interface ContributorsPayload extends ContributorStats {
  repo: string;
  head: string;
}

export type ContributorsResult =
  | { ok: true; stats: ContributorsPayload }
  | { ok: false; error: string; offline: boolean };

export function isContributorsPayload(v: unknown): v is ContributorsPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.contributors) && typeof o.totalCommits === 'number';
}

/** Fetch the contributor leaderboard (W14). */
export async function loadContributors(
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<ContributorsResult> {
  const qs = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : '';
  return fetchJson<ContributorsPayload>(`/api/contributors${qs}`, isContributorsPayload, opts.signal).then(r =>
    r.ok ? { ok: true, stats: r.value } : r,
  );
}

// ── Author detail (W23) ──────────────────────────────────────────────

export type AuthorDetailPayload = AuthorDetail & { repo: string; head: string };

export type AuthorResult =
  | { ok: true; detail: AuthorDetailPayload }
  | { ok: false; error: string; offline: boolean };

export function isAuthorPayload(v: unknown): v is AuthorDetailPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.email === 'string' &&
    typeof o.commits === 'number' &&
    Array.isArray(o.files) &&
    !!o.sparkline &&
    typeof o.sparkline === 'object'
  );
}

/** Fetch the per-author detail dashboard (W23). */
export async function loadAuthor(
  email: string,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<AuthorResult> {
  const repoParam = opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : '';
  const qs = `?email=${encodeURIComponent(email)}${repoParam}`;
  return fetchJson<AuthorDetailPayload>(`/api/author${qs}`, isAuthorPayload, opts.signal).then(r =>
    r.ok ? { ok: true, detail: r.value } : r,
  );
}

// ── Range compare (W18) ──────────────────────────────────────────────

export type ComparePayload = RangeComparison;

export type CompareResult =
  | { ok: true; comparison: ComparePayload }
  | { ok: false; error: string; offline: boolean };

export function isComparePayload(v: unknown): v is ComparePayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.base === 'string' &&
    typeof o.head === 'string' &&
    Array.isArray(o.ahead) &&
    Array.isArray(o.behind) &&
    Array.isArray(o.files)
  );
}

/** Fetch a symmetric range comparison between two refs (W18). */
export async function loadCompare(
  base: string,
  head: string,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<CompareResult> {
  const repoParam = opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : '';
  const qs = `?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}${repoParam}`;
  return fetchJson<ComparePayload>(`/api/compare${qs}`, isComparePayload, opts.signal).then(r =>
    r.ok ? { ok: true, comparison: r.value } : r,
  );
}

// ── Stashes (W19) ────────────────────────────────────────────────────

export type StashesPayload = StashList;

export type StashesResult =
  | { ok: true; stashes: StashesPayload }
  | { ok: false; error: string; offline: boolean };

export function isStashesPayload(v: unknown): v is StashesPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.stashes) && typeof o.total === 'number';
}

/** Fetch the stash list with per-entry file changes (W19). */
export async function loadStashes(opts: { signal?: AbortSignal; repo?: string } = {}): Promise<StashesResult> {
  const qs = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : '';
  return fetchJson<StashesPayload>(`/api/stashes${qs}`, isStashesPayload, opts.signal).then(r =>
    r.ok ? { ok: true, stashes: r.value } : r,
  );
}

/** Fetch one stash file's parsed diff (W19). Reuses FileDiffPayload. */
export async function loadStashDiff(
  index: number,
  path: string,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<FileDiffResult> {
  const repoParam = opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : '';
  const qs = `?index=${encodeURIComponent(String(index))}&path=${encodeURIComponent(path)}${repoParam}`;
  return fetchJson<FileDiffPayload>(`/api/stash-diff${qs}`, isFileDiffPayload, opts.signal).then(r =>
    r.ok ? { ok: true, diff: r.value } : r,
  );
}

// ── Stash mutations (W25) ────────────────────────────────────────────

export type StashActionKind = 'apply' | 'pop' | 'drop';

/** The post-action payload: the outcome + the refreshed stash list. */
export interface StashActionPayload extends StashList {
  action: StashActionKind;
  index: number;
  removed: boolean;
  message: string;
}

export type StashActionResult =
  | { ok: true; result: StashActionPayload }
  | { ok: false; error: string; offline: boolean };

export function isStashActionPayload(v: unknown): v is StashActionPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.action === 'string' && Array.isArray(o.stashes) && typeof o.total === 'number';
}

/**
 * Run a local-only stash mutation (W25): apply / pop / drop. POSTs to the
 * companion's single mutating endpoint; the companion re-validates the
 * action + index and returns the refreshed list.
 */
export async function runStashAction(
  action: StashActionKind,
  index: number,
  opts: { signal?: AbortSignal; repo?: string } = {},
): Promise<StashActionResult> {
  const qs = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : '';
  try {
    const res = await fetch(`/api/stash-action${qs}`, {
      method: 'POST',
      signal: opts.signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ action, index }),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: detail, offline: false };
    }
    const body: unknown = await res.json();
    if (!isStashActionPayload(body)) {
      return { ok: false, error: 'Unexpected response shape from /api/stash-action', offline: false };
    }
    return { ok: true, result: body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, offline: true };
  }
}

// ── Shared JSON fetch ────────────────────────────────────────────────

type JsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; offline: boolean };

/**
 * Fetch + validate a JSON endpoint with the project's error contract:
 * a non-2xx reads `{ error }` from the body when present; a network
 * failure is reported as `offline` so callers can fall back gracefully.
 */
async function fetchJson<T>(
  url: string,
  guard: (v: unknown) => v is T,
  signal?: AbortSignal,
): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: detail, offline: false };
    }
    const body: unknown = await res.json();
    if (!guard(body)) {
      return { ok: false, error: `Unexpected response shape from ${url}`, offline: false };
    }
    return { ok: true, value: body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, offline: true };
  }
}
