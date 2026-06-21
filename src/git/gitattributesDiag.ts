/**
 * Pure helpers for the .gitattributes Diagnostics feature (F42).
 *
 * Detects common .gitattributes mistakes:
 *
 *   - A file declared `text` (or `text=auto`) that is actually binary
 *     (contains NUL bytes within the first 8 KB).
 *   - A file declared `binary` that is actually text (no NUL bytes,
 *     mostly printable ASCII).
 *   - A file declared `eol=lf` whose worktree copy actually contains CRLF
 *     line endings (and vice versa).
 *
 * Inputs are kept narrow so the controller can shell out at its leisure
 * and feed pure data in. Tests in test/git/gitattributesDiag.test.ts.
 */

/** A single attribute value as reported by `git check-attr -z --all <path>`. */
export interface FileAttrs {
  /** Repo-relative path. */
  path: string;
  /** Map of attr -> value ('set' | 'unset' | 'unspecified' | literal value). */
  attrs: Record<string, string>;
}

/**
 * Parse `git check-attr -z --all -- <paths>` output. The `-z` form NUL-separates
 * three fields per record: path, attr, value (or 'unspecified'/'set'/'unset').
 *
 * We use `-z` because it's the safest with paths that contain spaces or
 * newlines. Output is a single concatenated NUL-separated stream.
 */
export function parseCheckAttrZ(raw: string): FileAttrs[] {
  const fields = (raw ?? '').split('\0');
  // The stream is path\0attr\0value\0 repeated. Trailing NUL may add an empty
  // field — pop it if so.
  while (fields.length && fields[fields.length - 1] === '') fields.pop();
  const byPath = new Map<string, Record<string, string>>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    const attr = fields[i + 1];
    const value = fields[i + 2];
    if (!path || !attr) continue;
    if (!byPath.has(path)) byPath.set(path, {});
    byPath.get(path)![attr] = value;
  }
  return [...byPath.entries()].map(([path, attrs]) => ({ path, attrs }));
}

/** Cheap, allocation-free check: does the buffer contain a NUL within the first 8KB? */
export function looksBinary(content: Uint8Array | Buffer): boolean {
  const limit = Math.min(content.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

/** Detect CRLF in a buffer (any \r\n pair within the first 8 KB). */
export function hasCrlf(content: Uint8Array | Buffer): boolean {
  const limit = Math.min(content.length, 8192);
  for (let i = 0; i < limit - 1; i++) {
    if (content[i] === 0x0d && content[i + 1] === 0x0a) return true;
  }
  return false;
}

/** Detect a bare LF (not preceded by CR) — used for the "should be CRLF" warning. */
export function hasLfOnly(content: Uint8Array | Buffer): boolean {
  const limit = Math.min(content.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (content[i] === 0x0a && (i === 0 || content[i - 1] !== 0x0d)) return true;
  }
  return false;
}

export type DiagnosticCode =
  | 'attr-text-but-binary'
  | 'attr-binary-but-text'
  | 'attr-eol-lf-but-crlf'
  | 'attr-eol-crlf-but-lf';

export interface AttrDiagnostic {
  code: DiagnosticCode;
  path: string;
  message: string;
}

/**
 * Score one file against its declared attributes + content. Returns an
 * empty array when nothing's wrong.
 */
export function diagnoseFile(args: {
  attrs: FileAttrs;
  content: Uint8Array | Buffer;
}): AttrDiagnostic[] {
  const out: AttrDiagnostic[] = [];
  const a = args.attrs.attrs;
  const isBinary = looksBinary(args.content);

  const declaredText = a.text === 'set' || a.text === 'auto';
  const declaredBinary = a.text === 'unset' || a.binary === 'set';
  const declaredEol = a.eol; // 'lf' | 'crlf' | undefined

  if (declaredText && isBinary) {
    out.push({
      code: 'attr-text-but-binary',
      path: args.attrs.path,
      message: `\`${args.attrs.path}\` is declared text${a.text === 'auto' ? ' (text=auto)' : ''} but contains NUL bytes — declare it \`binary\` to avoid corrupt diffs and eol normalisation.`,
    });
  }
  if (declaredBinary && !isBinary) {
    out.push({
      code: 'attr-binary-but-text',
      path: args.attrs.path,
      message: `\`${args.attrs.path}\` is declared binary but looks like text — drop the \`binary\`/\`-text\` attribute to enable proper diffs.`,
    });
  }
  // Don't bother with eol checks on binary files.
  if (!isBinary && declaredEol === 'lf' && hasCrlf(args.content)) {
    out.push({
      code: 'attr-eol-lf-but-crlf',
      path: args.attrs.path,
      message: `\`${args.attrs.path}\` is declared \`eol=lf\` but has CRLF line endings — convert with \`dos2unix\` or let git re-normalise (\`git add --renormalize .\`).`,
    });
  }
  if (!isBinary && declaredEol === 'crlf' && hasLfOnly(args.content) && !hasCrlf(args.content)) {
    out.push({
      code: 'attr-eol-crlf-but-lf',
      path: args.attrs.path,
      message: `\`${args.attrs.path}\` is declared \`eol=crlf\` but has LF-only line endings — convert with \`unix2dos\` or re-normalise.`,
    });
  }
  return out;
}

/**
 * Compact one-line summary used in the report header and pill tooltip.
 *
 *   "0 issues — .gitattributes matches the working tree"
 *   "3 .gitattributes issues across 2 files"
 */
export function summariseDiagnostics(d: AttrDiagnostic[]): string {
  if (!d.length) return 'No .gitattributes issues — looks consistent with the working tree.';
  const files = new Set(d.map(x => x.path)).size;
  const word = d.length === 1 ? 'issue' : 'issues';
  const fileWord = files === 1 ? 'file' : 'files';
  return `${d.length} .gitattributes ${word} across ${files} ${fileWord}`;
}

/**
 * Build the markdown report grouped by file. Each diagnostic is rendered
 * with its code so users can grep/disable specifics if they need to.
 */
export function formatReportMarkdown(diagnostics: AttrDiagnostic[]): string {
  const lines: string[] = [];
  lines.push('# .gitattributes diagnostics');
  lines.push('');
  if (!diagnostics.length) {
    lines.push('_No issues detected — your .gitattributes matches the working tree._');
    return lines.join('\n');
  }
  const byPath = new Map<string, AttrDiagnostic[]>();
  for (const d of diagnostics) {
    if (!byPath.has(d.path)) byPath.set(d.path, []);
    byPath.get(d.path)!.push(d);
  }
  for (const [path, list] of byPath) {
    lines.push(`## \`${path}\``);
    lines.push('');
    for (const d of list) {
      lines.push(`- **${d.code}** — ${d.message}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
