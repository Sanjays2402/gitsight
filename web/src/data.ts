/**
 * Snapshot data client (W4).
 *
 * Fetches the live GraphSnapshot from the companion server's /api/graph.
 * When the server isn't running (e.g. opened straight from a static
 * build with no backend), the caller falls back to the demo snapshot so
 * the app is never blank.
 */

import type { GraphSnapshot } from '@shared/graphSnapshot';

export type LoadResult =
  | { ok: true; snapshot: GraphSnapshot }
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
