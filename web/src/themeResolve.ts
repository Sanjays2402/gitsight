/**
 * Pure theme-resolution logic (W5).
 *
 * No DOM, no localStorage — just the decision functions, so they're
 * unit-tested under node --test. Imports the shared palette via a
 * relative .ts path (not the @shared Vite alias) so Node can resolve it
 * at test time too; tsc (bundler resolution + allowImportingTsExtensions)
 * and Vite both honour the same import.
 */

import { THEME_NAMES, asThemeName, type ThemeName } from '../../src/shared/graphPalette.ts';

export type ChromeTheme = 'light' | 'dark';

/** Resolve the initial chrome theme: a valid stored value wins, else the
 *  OS preference. */
export function resolveInitialChrome(
  stored: string | null,
  prefersDark: boolean,
): ChromeTheme {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

/** The opposite chrome theme (for the toggle button). */
export function nextChrome(current: ChromeTheme): ChromeTheme {
  return current === 'dark' ? 'light' : 'dark';
}

/** Resolve the initial lane palette: a known stored value, else default. */
export function resolveInitialPalette(stored: string | null): ThemeName {
  return asThemeName(stored ?? undefined) ?? 'default';
}

/** The next palette in the cycle (wraps to the first after the last). */
export function cyclePalette(current: ThemeName): ThemeName {
  const i = THEME_NAMES.indexOf(current);
  // Unknown current -> start at the first palette.
  if (i === -1) return THEME_NAMES[0];
  return THEME_NAMES[(i + 1) % THEME_NAMES.length];
}
