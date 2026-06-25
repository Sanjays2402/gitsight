/**
 * Theme controller (W5).
 *
 * Two independent axes, both persisted to localStorage:
 *   1. CHROME theme — light vs dark, applied as data-theme on <html>.
 *      Defaults to the OS preference (prefers-color-scheme).
 *   2. LANE palette — the branch-lane colour set, one of the shared
 *      THEMES keys. Drives the graph render only.
 *
 * The pure resolution logic lives in themeResolve.ts (DOM-free, so it's
 * unit-tested). This class owns the side effects: localStorage + the
 * <html data-theme> attribute + matchMedia.
 */

import { type ThemeName } from '@shared/graphPalette';
import {
  resolveInitialChrome,
  resolveInitialPalette,
  nextChrome,
  cyclePalette,
  type ChromeTheme,
} from './themeResolve';

export type { ChromeTheme };

const CHROME_KEY = 'gitsight.chrome';
const PALETTE_KEY = 'gitsight.palette';

export class ThemeController {
  chrome: ChromeTheme;
  palette: ThemeName;

  constructor() {
    const prefersDark =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-color-scheme: dark)').matches;
    this.chrome = resolveInitialChrome(read(CHROME_KEY), prefersDark);
    this.palette = resolveInitialPalette(read(PALETTE_KEY));
  }

  /** Apply the current chrome theme to the document root. */
  applyChrome(): void {
    document.documentElement.setAttribute('data-theme', this.chrome);
  }

  toggleChrome(): ChromeTheme {
    this.chrome = nextChrome(this.chrome);
    write(CHROME_KEY, this.chrome);
    this.applyChrome();
    return this.chrome;
  }

  setPalette(name: ThemeName): void {
    this.palette = name;
    write(PALETTE_KEY, name);
  }

  nextPalette(): ThemeName {
    this.setPalette(cyclePalette(this.palette));
    return this.palette;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / disabled storage — non-fatal */
  }
}
