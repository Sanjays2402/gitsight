/**
 * Browser-side helpers for the GitSight web app (W2).
 *
 * Relative-time formatting mirrors the extension's `timeAgo` but takes a
 * Date|string (snapshots carry ISO strings). Kept here rather than
 * imported from src/git/format.ts because that file, while vscode-free,
 * lives in the extension tree and we want the web bundle to depend only
 * on @shared/*.
 */

export function timeAgo(input: Date | string, now: number = Date.now()): string {
  const t = typeof input === 'string' ? Date.parse(input) : input.getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Absolute-time tooltip, e.g. "Jun 24, 2026, 11:42 PM". */
export function absoluteTime(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Tiny tagged-template-free DOM helper: make an element with class + html. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}
