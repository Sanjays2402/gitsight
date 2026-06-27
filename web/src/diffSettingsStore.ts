/**
 * Diff display-settings controller (W31).
 *
 * Owns the user's diff render preferences (wrap / ignore-whitespace),
 * persists them to localStorage, and reflects the wrap flag onto the
 * document root as `data-diff-wrap` so already-rendered diffs respond to a
 * wrap toggle via CSS alone (no re-fetch). The pure model + coercion live in
 * diffSettings.ts (unit-tested); this class is just the side effects +
 * change notification.
 *
 * Listeners are notified on every change so the detail panel / compare view
 * can re-fetch when ignore-whitespace flips (that one DOES need a new diff).
 */

import {
  defaultDiffSettings,
  toggleWrap,
  toggleIgnoreWhitespace,
  toggleSplit,
  coerceDiffSettings,
  diffSettingsEqual,
  layoutForSurface,
  toggleSurfaceLayout,
  coerceSurfaceLayouts,
  type DiffSettings,
  type DiffSurface,
  type SurfaceLayouts,
} from './diffSettings';

const STORE_KEY = 'gitsight.diffSettings';
const SURFACE_KEY = 'gitsight.diffSurfaceLayouts';

export class DiffSettingsStore {
  private settings: DiffSettings;
  private surfaces: SurfaceLayouts;
  private listeners = new Set<(s: DiffSettings) => void>();

  constructor() {
    this.settings = coerceDiffSettings(read(STORE_KEY));
    this.surfaces = coerceSurfaceLayouts(read(SURFACE_KEY));
  }

  get(): DiffSettings {
    return this.settings;
  }

  /** Reflect the wrap flag onto <html> so CSS can soft-wrap existing diffs. */
  applyToRoot(): void {
    document.documentElement.setAttribute('data-diff-wrap', this.settings.wrap ? 'on' : 'off');
  }

  toggleWrap(): void {
    this.set(toggleWrap(this.settings));
  }

  toggleIgnoreWhitespace(): void {
    this.set(toggleIgnoreWhitespace(this.settings));
  }

  /** Flip the global side-by-side layout (W38). */
  toggleSplit(): void {
    this.set(toggleSplit(this.settings));
  }

  /**
   * The resolved diff layout for a surface (W46): its own remembered choice,
   * else the global split flag. The detail panel + compare view each call
   * this with their own surface id so they can differ.
   */
  layoutFor(surface: DiffSurface): 'split' | 'unified' {
    return layoutForSurface(this.settings, this.surfaces, surface);
  }

  /**
   * Flip one surface's layout (W46) and persist it. Notifies listeners so the
   * affected surface re-renders its diffs in the new mode.
   */
  toggleSurfaceLayout(surface: DiffSurface): void {
    this.surfaces = toggleSurfaceLayout(this.settings, this.surfaces, surface);
    write(SURFACE_KEY, this.surfaces);
    for (const fn of this.listeners) fn(this.settings);
  }

  /** Subscribe to changes; returns an unsubscribe fn. */
  onChange(fn: (s: DiffSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: DiffSettings): void {
    if (diffSettingsEqual(next, this.settings)) return;
    this.settings = next;
    write(STORE_KEY, next);
    this.applyToRoot();
    for (const fn of this.listeners) fn(next);
  }
}

export { defaultDiffSettings };

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / disabled storage — non-fatal */
  }
}
