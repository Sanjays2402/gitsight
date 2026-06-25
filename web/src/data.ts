/**
 * Snapshot data client (W4).
 *
 * Fetches the live GraphSnapshot from the companion server's /api/graph.
 * When the server isn't running (e.g. opened straight from a static
 * build with no backend), the caller falls back to the demo snapshot so
 * the app is never blank.
 */

import type { GraphSnapshot } from '@shared/graphSnapshot';
import type { CommitDetail } from '@shared/commitDetail';

export type LoadResult =
  | { ok: true; snapshot: GraphSnapshot }
  | { ok: false; error: string; offline: boolean };

export type CommitDetailResult =
  | { ok: true; detail: CommitDetail }
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
  opts: { signal?: AbortSignal } = {},
): Promise<CommitDetailResult> {
  try {
    const res = await fetch(`/api/commit/${encodeURIComponent(sha)}`, {
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

export async function loadSnapshot(opts: { max?: number; signal?: AbortSignal } = {}): Promise<LoadResult> {
  const qs = opts.max ? `?max=${opts.max}` : '';
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
