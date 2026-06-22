/**
 * Pure helpers for the GitHub Releases companion (F74).
 *
 * `gh release list --json tagName,name,publishedAt,isDraft,isPrerelease,url`
 * returns a JSON array; this module parses + ranks + filters those entries
 * so the view layer can render them in a picker.
 *
 * `gh release view <tag> --json tagName,name,body,publishedAt,url` returns
 * a single release with its rendered notes; we expose a tiny markdown
 * formatter that wraps it in a nice scratch-buffer header.
 *
 * Pure — no vscode, no child_process. Tests in test/git/githubReleases.test.ts.
 */

export interface ReleaseListEntry {
  tagName: string;
  name: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  url: string;
}

export interface ReleaseDetail extends ReleaseListEntry {
  body: string;
}

/**
 * Parse the stdout of `gh release list --json ...`. Returns [] for
 * empty/invalid input rather than throwing — the view treats no-releases
 * the same as "show fallback action".
 */
export function parseReleaseList(raw: string): ReleaseListEntry[] {
  if (!raw || !raw.trim()) return [];
  let arr: any;
  try { arr = JSON.parse(raw); }
  catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: ReleaseListEntry[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const tagName = String(r.tagName ?? '');
    if (!tagName) continue;
    out.push({
      tagName,
      name: String(r.name ?? tagName),
      publishedAt: String(r.publishedAt ?? ''),
      isDraft: !!r.isDraft,
      isPrerelease: !!r.isPrerelease,
      url: String(r.url ?? ''),
    });
  }
  return out;
}

/**
 * Parse the stdout of `gh release view <tag> --json ...` into a
 * ReleaseDetail. Returns undefined when the JSON isn't a shape we
 * recognise.
 */
export function parseReleaseDetail(raw: string): ReleaseDetail | undefined {
  if (!raw || !raw.trim()) return undefined;
  let obj: any;
  try { obj = JSON.parse(raw); }
  catch { return undefined; }
  if (!obj || typeof obj !== 'object') return undefined;
  const tagName = String(obj.tagName ?? '');
  if (!tagName) return undefined;
  return {
    tagName,
    name: String(obj.name ?? tagName),
    publishedAt: String(obj.publishedAt ?? ''),
    isDraft: !!obj.isDraft,
    isPrerelease: !!obj.isPrerelease,
    url: String(obj.url ?? ''),
    body: String(obj.body ?? ''),
  };
}

/**
 * Build a short, single-line picker label for a release entry.
 *
 *   "v1.16.0  ·  3d ago"
 *   "v1.17.0-rc.1  ·  prerelease  ·  6h ago"
 *   "draft-name  ·  draft  ·  not published"
 *
 * `relativeDate` should be the project's existing timeAgo() output;
 * pass '' when publishedAt isn't set (drafts).
 */
export function describeReleaseListEntry(e: ReleaseListEntry, relativeDate: string): string {
  const tags: string[] = [];
  if (e.isDraft) tags.push('draft');
  if (e.isPrerelease) tags.push('prerelease');
  const datePart = relativeDate || (e.isDraft ? 'not published' : '\u2014');
  const tagSuffix = tags.length ? `  \u00b7  ${tags.join(' \u00b7 ')}` : '';
  return `${e.tagName}${tagSuffix}  \u00b7  ${datePart}`;
}

/**
 * Render a single release as markdown for an in-editor scratch buffer.
 * Stable shape so the tests can assert on it without coupling to UI.
 *
 *   # name (tagName)
 *
 *   *Published <relativeDate>*  ·  [Open on GitHub](url)
 *
 *   <body>
 *
 * When body is empty we render a placeholder so the buffer isn't blank.
 */
export function renderReleaseMarkdown(detail: ReleaseDetail, relativeDate: string): string {
  const heading = `# ${detail.name || detail.tagName} (${detail.tagName})`;
  const tags: string[] = [];
  if (detail.isDraft) tags.push('draft');
  if (detail.isPrerelease) tags.push('prerelease');
  const dateLine = detail.isDraft
    ? '*Not yet published*'
    : `*Published ${relativeDate || detail.publishedAt}*`;
  const linkLine = detail.url ? `  \u00b7  [Open on GitHub](${detail.url})` : '';
  const tagLine = tags.length ? `\n\n_${tags.join(' \u00b7 ')}_` : '';
  const body = detail.body.trim() || '_No release notes._';
  return `${heading}\n\n${dateLine}${linkLine}${tagLine}\n\n${body}\n`;
}

/**
 * Decide whether the "Create release from latest tag" action should be
 * offered. Returns the candidate tag when the latest local tag has no
 * matching release entry; undefined otherwise.
 *
 * Inputs:
 *   - `localTags` is the output of `git tag --sort=-creatordate`
 *     (one tag per line, newest first).
 *   - `releases` is the parsed `gh release list` array.
 *
 * The simple rule: if the newest local tag isn't in the releases list,
 * offer to create a release from it. Skips empty tag lists and
 * already-released tags.
 */
export function suggestCreateFromTag(localTags: string, releases: ReleaseListEntry[]): string | undefined {
  const latest = (localTags ?? '').split('\n').map(s => s.trim()).find(Boolean);
  if (!latest) return undefined;
  const released = new Set(releases.map(r => r.tagName));
  if (released.has(latest)) return undefined;
  return latest;
}
