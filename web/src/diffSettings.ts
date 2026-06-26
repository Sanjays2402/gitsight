/**
 * Pure diff display-settings model (W31).
 *
 * DOM-free + framework-free + NO @shared import, so it's unit-tested under
 * node --test. Holds the per-file diff render options the user can toggle:
 *
 *   - wrap             — soft-wrap long lines vs horizontal scroll.
 *   - ignoreWhitespace — ask the server for a `-w` diff so reindents /
 *                        trailing-space churn drops out of the hunks.
 *
 * The detail panel + compare view own the toggle UI + a localStorage
 * wrapper; this module is just the shape, the defaults, the immutable
 * toggles, and the param mapping. Keeping it pure means the coercion of a
 * corrupt stored blob is covered without a DOM.
 *
 * Tests: web/src/diffSettings.test.mjs
 */

export interface DiffSettings {
  /** Soft-wrap long diff lines instead of scrolling horizontally. */
  wrap: boolean;
  /** Request a whitespace-insensitive diff (server passes git `-w`). */
  ignoreWhitespace: boolean;
}

/** The out-of-the-box settings: scroll long lines, show whitespace changes. */
export function defaultDiffSettings(): DiffSettings {
  return { wrap: false, ignoreWhitespace: false };
}

/** Flip the wrap flag. Returns a NEW object. */
export function toggleWrap(s: DiffSettings): DiffSettings {
  return { ...s, wrap: !s.wrap };
}

/** Flip the ignore-whitespace flag. Returns a NEW object. */
export function toggleIgnoreWhitespace(s: DiffSettings): DiffSettings {
  return { ...s, ignoreWhitespace: !s.ignoreWhitespace };
}

/**
 * The `ws` query-param value for `/api/diff`: 'ignore' when whitespace is
 * being ignored, else undefined (so the URL stays clean for the default).
 */
export function wsParam(s: DiffSettings): 'ignore' | undefined {
  return s.ignoreWhitespace ? 'ignore' : undefined;
}

/**
 * Validate + coerce a parsed-JSON value into clean settings (defensive
 * against a corrupt / hand-edited localStorage blob). Unknown shapes fall
 * back to the defaults; each flag is read as a strict boolean.
 */
export function coerceDiffSettings(value: unknown): DiffSettings {
  const base = defaultDiffSettings();
  if (!value || typeof value !== 'object') return base;
  const o = value as Record<string, unknown>;
  return {
    wrap: o.wrap === true,
    ignoreWhitespace: o.ignoreWhitespace === true,
  };
}

/** True when two settings objects are value-equal (skip needless re-renders). */
export function diffSettingsEqual(a: DiffSettings, b: DiffSettings): boolean {
  return a.wrap === b.wrap && a.ignoreWhitespace === b.ignoreWhitespace;
}
