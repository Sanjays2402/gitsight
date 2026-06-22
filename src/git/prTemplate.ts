/**
 * Pure helpers for PR template integration (F98).
 *
 * GitHub's pull request template convention supports three shapes:
 *
 *   1. Single template at the root:    .github/PULL_REQUEST_TEMPLATE.md
 *      (or PULL_REQUEST_TEMPLATE without extension, or
 *       pull_request_template.md - case-insensitive variants)
 *   2. Multiple templates in a dir:     .github/PULL_REQUEST_TEMPLATE/*.md
 *      The user picks one (the filename is the picker label, sans extension).
 *   3. Repo-root fallback:              PULL_REQUEST_TEMPLATE.md at repo root.
 *
 * When a template exists, the F2 / F77 / F87 PR-description flow folds
 * the AI-generated body INTO the template's section structure rather
 * than replacing it wholesale. This module owns:
 *
 *   - locateTemplates(repoRoot): which template files exist on disk
 *   - parseTemplateSections(md): split a template into named sections
 *     (heading + body) so we can replace section bodies in place
 *   - mergeAiIntoTemplate(template, ai): for each AI heading we
 *     recognise, swap the matching template section's body. Sections
 *     present in the template but missing from the AI output are
 *     LEFT VERBATIM (the user's checklist boxes stay; the AI's prose
 *     wins inside the prose sections).
 *
 * Pure - no fs, no vscode. The view layer handles disk + UI.
 * Tests in test/git/prTemplate.test.ts.
 */

export interface TemplateFile {
  /** Display label for the picker - filename sans extension, prettified. */
  label: string;
  /** Path relative to the repo root, forward-slash separated. */
  relPath: string;
}

/**
 * Decide which of the candidate paths exist. The caller (view layer)
 * does the actual fs probe via `vscode.workspace.fs.stat` and feeds
 * the result back. We expose the canonical candidate list so the
 * tests can exercise the ordering without touching disk.
 *
 * Returned in PRIORITY order - first match wins for the "single
 * template" code path; the directory variant always supersedes the
 * single-file variant because picking between explicit options is
 * better UX than guessing.
 */
export function templateCandidatePaths(): { path: string; isDirectory: boolean }[] {
  return [
    // Directory form (multiple templates) - always checked first.
    { path: '.github/PULL_REQUEST_TEMPLATE',   isDirectory: true },
    { path: '.github/pull_request_template',   isDirectory: true },
    { path: 'docs/PULL_REQUEST_TEMPLATE',      isDirectory: true },
    // Single-file forms.
    { path: '.github/PULL_REQUEST_TEMPLATE.md', isDirectory: false },
    { path: '.github/pull_request_template.md', isDirectory: false },
    { path: '.github/PULL_REQUEST_TEMPLATE',    isDirectory: false }, // extensionless
    { path: 'PULL_REQUEST_TEMPLATE.md',         isDirectory: false },
    { path: 'pull_request_template.md',         isDirectory: false },
    { path: 'docs/PULL_REQUEST_TEMPLATE.md',    isDirectory: false },
  ];
}

/**
 * Prettify a template filename for the picker. `feature_request.md`
 * becomes `Feature request`; `bug-fix.md` becomes `Bug fix`. Anything
 * weirder is left as-is minus the extension.
 */
export function prettifyTemplateName(filename: string): string {
  const base = filename.replace(/\.(md|markdown|txt)$/i, '');
  const tokens = base.split(/[_\-\s]+/).filter(Boolean);
  if (tokens.length === 0) return base;
  // Title-case the first token only; keep the rest lowercase (sentence-case).
  const first = tokens[0];
  const rest = tokens.slice(1).map(t => t.toLowerCase());
  return [first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(), ...rest].join(' ');
}

/**
 * Build the picker entries from a directory listing of template files.
 * Sorts alphabetically with `default.md` first if present (GitHub's
 * convention is for `default.md` to be the unnamed fallback when
 * `template=` query string is omitted).
 */
export function buildTemplatePickerEntries(
  dir: string,
  filenames: string[],
): TemplateFile[] {
  const md = filenames.filter(n => /\.(md|markdown|txt)$/i.test(n));
  const sorted = md.slice().sort((a, b) => {
    const aDefault = /^default\./i.test(a);
    const bDefault = /^default\./i.test(b);
    if (aDefault && !bDefault) return -1;
    if (bDefault && !aDefault) return 1;
    return a.localeCompare(b);
  });
  return sorted.map(name => ({
    label: prettifyTemplateName(name),
    relPath: `${dir.replace(/\/$/, '')}/${name}`,
  }));
}

export interface TemplateSection {
  /** The heading line verbatim, e.g. `## Summary` or `### Test plan`. */
  heading: string;
  /** Lower-cased + trimmed heading text without `#` for matching. */
  key: string;
  /** Heading level (1-6) for re-emission ordering. */
  level: number;
  /** Body lines below the heading (no trailing newline). May be empty. */
  body: string;
}

/**
 * Split a markdown template into:
 *
 *   { preamble, sections }
 *
 * Where `preamble` is everything before the first heading (commonly empty
 * or a top-level `# title`), and `sections` is each heading-block. We
 * preserve the exact heading text and original level so re-emission
 * round-trips byte-for-byte when no section body changes.
 *
 * Notes:
 *   - Code-fence content (``` blocks) is treated as body text - a
 *     `#` inside a fence is NOT a heading. We track fence depth as
 *     we walk so a stray `# python comment` inside a fence doesn't
 *     accidentally start a new section.
 *   - Setext-style underlined headings (`Heading\n=====`) are NOT
 *     parsed - GitHub PR templates use atx-style (`#`) almost
 *     universally and supporting setext would double the test surface.
 *   - HTML-comment delimiters like `<!-- ... -->` are kept verbatim
 *     as part of body text - templates use them for instruction
 *     notes that should survive the AI merge.
 */
export function parseTemplateSections(md: string): {
  preamble: string;
  sections: TemplateSection[];
} {
  if (!md) return { preamble: '', sections: [] };
  const lines = md.split('\n');
  const sections: TemplateSection[] = [];
  let preambleLines: string[] = [];
  let current: TemplateSection | undefined;
  let fenceMarker: string | undefined; // ``` or ~~~ when inside a fence

  const flush = () => {
    if (!current) return;
    // Trim trailing blank lines from body (keeps the markdown tidy)
    while (current.body.endsWith('\n')) current.body = current.body.slice(0, -1);
    sections.push(current);
  };

  for (const line of lines) {
    // Toggle fence state on a bare ``` or ~~~ open/close
    const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fenceMarker) {
        fenceMarker = fenceMatch[2][0];
      } else if (line.trimStart().startsWith(fenceMarker)) {
        fenceMarker = undefined;
      }
    }

    // A heading only counts when we're NOT inside a fence.
    const headingMatch = fenceMarker ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      flush();
      current = {
        heading: line,
        key: headingMatch[2].trim().toLowerCase(),
        level: headingMatch[1].length,
        body: '',
      };
      continue;
    }

    if (!current) {
      preambleLines.push(line);
    } else {
      current.body = current.body ? current.body + '\n' + line : line;
    }
  }
  flush();

  // Trim trailing blanks from preamble too.
  while (preambleLines.length && preambleLines[preambleLines.length - 1].trim() === '') {
    preambleLines.pop();
  }

  return { preamble: preambleLines.join('\n'), sections };
}

/**
 * Render a parsed template back to markdown, faithfully.
 */
export function renderTemplate(parsed: { preamble: string; sections: TemplateSection[] }): string {
  const parts: string[] = [];
  if (parsed.preamble) parts.push(parsed.preamble);
  for (const s of parsed.sections) {
    parts.push(s.heading + (s.body ? '\n' + s.body : ''));
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * Map of equivalent section names. Order doesn't matter; values are
 * lower-cased and trimmed before lookup.
 */
const HEADING_ALIASES: Record<string, string[]> = {
  summary: ['summary', 'description', 'overview', 'what', 'what changed', 'what changes'],
  changes: ['changes', 'change list', 'change-list', 'what changed', 'changelog'],
  motivation: ['motivation', 'why', 'rationale', 'background', 'context'],
  'implementation notes': ['implementation notes', 'implementation', 'notes', 'how', 'how it works', 'approach'],
  'test plan': ['test plan', 'testing', 'tests', 'how to test', 'qa', 'how was this tested', 'test coverage'],
  checklist: ['checklist', 'pre-merge checklist', 'pr checklist'],
  screenshots: ['screenshots', 'screenshot', 'demos', 'demo', 'before / after'],
  'breaking changes': ['breaking changes', 'breaking', 'backwards incompatible', 'backwards-incompatible'],
};

function canonicalSectionKey(raw: string): string | undefined {
  const norm = raw.trim().toLowerCase();
  for (const [canon, aliases] of Object.entries(HEADING_ALIASES)) {
    if (aliases.includes(norm)) return canon;
  }
  return undefined;
}

/**
 * Merge AI-generated PR markdown into the template's section structure.
 *
 * Strategy: for each AI-generated section heading we recognise (via
 * HEADING_ALIASES) AND which the template ALSO contains under any
 * alias, replace the template section's body with the AI body. All
 * other template sections survive untouched - especially the
 * checklist, which the AI is bad at filling in but the user often
 * wants their own boxes preserved.
 *
 * If `appendUnmatched` is true, AI sections with NO template
 * counterpart get appended at the end. Defaults to true; pass false
 * when you want strict template adherence (no extra sections).
 *
 * Returns { merged, replaced, appended, dropped } so the view can
 * show a breadcrumb like "filled 3 sections, appended 1".
 */
export interface MergeResult {
  merged: string;
  /** Canonical names of template sections whose body got replaced. */
  replaced: string[];
  /** Canonical names of AI sections appended at the end. */
  appended: string[];
  /** AI sections we couldn't place (only when appendUnmatched=false). */
  dropped: string[];
}

export function mergeAiIntoTemplate(
  templateMd: string,
  aiMd: string,
  options: { appendUnmatched?: boolean } = {},
): MergeResult {
  const appendUnmatched = options.appendUnmatched !== false;
  const tmpl = parseTemplateSections(templateMd);
  const ai = parseTemplateSections(aiMd);

  // Build a canonical-key index over both sides. Template sections
  // without an alias get a `unknown:<raw key>` index so we don't
  // collapse two unique-but-unaliased headings together.
  const tmplBySection = new Map<string, TemplateSection>();
  for (const s of tmpl.sections) {
    const canon = canonicalSectionKey(s.key) ?? `unknown:${s.key}`;
    tmplBySection.set(canon, s);
  }

  const replaced: string[] = [];
  const appended: string[] = [];
  const dropped: string[] = [];

  for (const aiSection of ai.sections) {
    const canon = canonicalSectionKey(aiSection.key);
    if (canon && tmplBySection.has(canon)) {
      const tgt = tmplBySection.get(canon)!;
      tgt.body = aiSection.body;
      replaced.push(canon);
    } else if (appendUnmatched) {
      // Append at the end, preserving its original heading level so
      // it doesn't outshout the template's structure.
      tmpl.sections.push({ ...aiSection, key: aiSection.key });
      appended.push(canon ?? aiSection.key);
    } else {
      dropped.push(canon ?? aiSection.key);
    }
  }

  return {
    merged: renderTemplate(tmpl),
    replaced,
    appended,
    dropped,
  };
}

/**
 * Convenience: given a parsed template, return the list of section
 * keys (canonical or `unknown:<raw>`) so the AI prompt can be told
 * which headings to fill in. The AI behaves a lot better when the
 * prompt explicitly enumerates the target structure.
 */
export function templateSectionPromptList(parsed: { sections: TemplateSection[] }): string[] {
  const out: string[] = [];
  for (const s of parsed.sections) {
    const canon = canonicalSectionKey(s.key);
    out.push(canon ? '## ' + s.heading.replace(/^#+\s+/, '') : '## ' + s.heading.replace(/^#+\s+/, ''));
  }
  return out;
}
