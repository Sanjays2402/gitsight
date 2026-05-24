export function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function formatBlame(fmt: string, d: { author: string; ago: string; date: string; sha: string; message: string }): string {
  return fmt
    .replace(/\$\{author\}/g, d.author)
    .replace(/\$\{ago\}/g, d.ago)
    .replace(/\$\{date\}/g, d.date)
    .replace(/\$\{sha\}/g, d.sha)
    .replace(/\$\{message\}/g, d.message);
}

export function colorForAuthor(author: string): string {
  let h = 0;
  for (const c of author) h = (h << 5) - h + c.charCodeAt(0);
  return `hsl(${Math.abs(h) % 360}, 65%, 60%)`;
}

export function heatmapColor(date: Date, coldDays: number): string {
  const days = (Date.now() - date.getTime()) / 86400000;
  const ratio = Math.min(1, Math.max(0, days / coldDays));
  // Hot (red) at 0 → cold (blue) at 1
  const hue = 220 * ratio;
  return `hsl(${hue}, 70%, 50%)`;
}

export function gravatarUrl(email: string, size = 40): string {
  // No crypto for portability; use first 16 chars of simple md5-like hash via subtle? Skip — use identicon fallback service.
  return `https://www.gravatar.com/avatar/${simpleHash(email.toLowerCase())}?s=${size}&d=identicon`;
}

function simpleHash(s: string): string {
  let h = 0;
  for (const c of s) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return Math.abs(h).toString(16).padStart(8, '0').repeat(4);
}
