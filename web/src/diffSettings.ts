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
  /** Render side-by-side (old | new) instead of a unified column (W38). */
  split: boolean;
}

/** The out-of-the-box settings: scroll long lines, show whitespace, unified. */
export function defaultDiffSettings(): DiffSettings {
  return { wrap: false, ignoreWhitespace: false, split: false };
}

/** Flip the wrap flag. Returns a NEW object. */
export function toggleWrap(s: DiffSettings): DiffSettings {
  return { ...s, wrap: !s.wrap };
}

/** Flip the ignore-whitespace flag. Returns a NEW object. */
export function toggleIgnoreWhitespace(s: DiffSettings): DiffSettings {
  return { ...s, ignoreWhitespace: !s.ignoreWhitespace };
}

/** Flip the split-view flag (W38). Returns a NEW object. */
export function toggleSplit(s: DiffSettings): DiffSettings {
  return { ...s, split: !s.split };
}

/** The `view` arg the diff renderer takes: split when enabled, else unified. */
export function diffViewMode(s: DiffSettings): 'split' | 'unified' {
  return s.split ? 'split' : 'unified';
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
    split: o.split === true,
  };
}

/** True when two settings objects are value-equal (skip needless re-renders). */
export function diffSettingsEqual(a: DiffSettings, b: DiffSettings): boolean {
  return a.wrap === b.wrap && a.ignoreWhitespace === b.ignoreWhitespace && a.split === b.split;
}

// ── Per-surface layout (W46) ─────────────────────────────────────────

/**
 * The diff surfaces that can remember their own layout (W46). The commit
 * detail panel and the compare view each carry a per-file diff list; a user
 * often wants split in one and unified in the other (e.g. unified for a quick
 * commit read, split for a careful branch comparison), so each remembers its
 * own choice rather than sharing the single global flag.
 */
export type DiffSurface = 'detail' | 'compare';

export const DIFF_SURFACES: DiffSurface[] = ['detail', 'compare'];

/** Per-surface layout overrides: a surface maps to split (true) / unified (false). */
export type SurfaceLayouts = Partial<Record<DiffSurface, boolean>>;

/**
 * Resolve the layout for a surface (W46): the surface's own override when set,
 * else the global `split` flag (so a fresh surface inherits the user's last
 * global choice). Returns the diff renderer's `view` arg directly.
 */
export function layoutForSurface(
  global: DiffSettings,
  surfaces: SurfaceLayouts,
  surface: DiffSurface,
): 'split' | 'unified' {
  const own = surfaces[surface];
  const split = own === undefined ? global.split : own;
  return split ? 'split' : 'unified';
}

/** Flip a surface's layout override (W46). Returns a NEW map. */
export function toggleSurfaceLayout(
  global: DiffSettings,
  surfaces: SurfaceLayouts,
  surface: DiffSurface,
): SurfaceLayouts {
  const current = layoutForSurface(global, surfaces, surface) === 'split';
  return { ...surfaces, [surface]: !current };
}

/**
 * Validate + coerce a parsed-JSON value into clean per-surface overrides
 * (W46), defensive against a corrupt localStorage blob. Only known surfaces
 * with strict-boolean values survive.
 */
export function coerceSurfaceLayouts(value: unknown): SurfaceLayouts {
  if (!value || typeof value !== 'object') return {};
  const o = value as Record<string, unknown>;
  const out: SurfaceLayouts = {};
  for (const surface of DIFF_SURFACES) {
    if (typeof o[surface] === 'boolean') out[surface] = o[surface] as boolean;
  }
  return out;
}
