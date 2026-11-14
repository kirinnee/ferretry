/**
 * SOLE OWNER of this device's theme preference (`fy:app:theme`, §9.4) — a device setting (§5.2): it applies to this
 * device only and needs no daemon and no hash check. Copied from today's PWA `lib/theme-preferences.ts`.
 *
 * Theme state is a FAMILY (which look) plus a MODE PREFERENCE (system / light / dark) plus a TEXT SCALE, and the
 * resolved pair is published as ONE root attribute:
 *
 *     <html data-theme="<family>-<mode>">     // mode already resolved
 *
 * `styles/themes.css` declares the tokens for every one of those values and mirrors each on
 * `[data-swatch='<family>-<mode>']`, so a preview element can render in the theme it advertises. Nothing here may
 * hardcode a colour. A theme ITEM (data, `./tokens.ts`) overrides tokens on top of the family in force.
 *
 * PRE-PAINT AGREEMENT. `public/pre-paint.js` resolves the same preference before first paint, so there is no flash
 * of the wrong theme. It and this module MUST agree on the key, the record shape, the accepted values and the
 * attribute shape. This module is the definition; the script follows it.
 */
import { z } from 'zod';
import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, writeRecord } from '../storage/records.ts';

/** The browser-storage key for theme preferences. */
export const THEME_PREFERENCES_KEY = APP_STORAGE.theme;

export type ThemeMode = 'system' | 'light' | 'dark';
/** The mode actually in force — never `system`. */
export type ResolvedMode = 'light' | 'dark';
export type ThemeFamilyId =
  | 'studio'
  | 'mission'
  | 'neo'
  | 'geist'
  | 'contrast'
  | 'phosphor'
  | 'blueprint'
  | 'broadsheet'
  | 'wayfinding'
  | 'ledger'
  | 'ma';
export type TextScale = 'default' | 'large' | 'larger';

/**
 * Discrete choices keep the result predictable at narrow widths. There is no
 * sub-default option because shrinking the whole interface would pull existing
 * 44px touch targets below their accessibility floor.
 */
export const TEXT_SCALE_FACTORS: Readonly<Record<TextScale, number>> = Object.freeze({
  default: 1,
  large: 1.125,
  larger: 1.25,
});

export interface ThemeFamily {
  readonly id: ThemeFamilyId;
  /** Picker label. */
  readonly label: string;
  /** One line on what the family is FOR, not what colour it is. */
  readonly blurb: string;
}

/**
 * Metadata for the picker. Order is the order shown: the four house looks, the
 * accessibility mode, then the six characterful families.
 *
 * A family EARNS a row here by differing structurally — typeface pairing,
 * density, shape language, texture, emphasis mechanism — not by recolouring the
 * one before it. Two families that are the same layout in different hex values
 * are one family and a wasted choice, so `ember` (warm Studio) and `notebook`
 * (paper Studio) were withdrawn rather than retuned.
 */
export const THEME_FAMILIES: readonly ThemeFamily[] = Object.freeze([
  { id: 'studio', label: 'Studio', blurb: 'The house look — indigo on cool zinc.' },
  { id: 'mission', label: 'Mission Control', blurb: 'A ruled instrument grid, square mono controls, cyan hairlines.' },
  { id: 'neo', label: 'Neo-Brutalism', blurb: 'Hard rules, flat offset shadows, AA-checked.' },
  { id: 'geist', label: 'Geist', blurb: 'Hairline rules, small precise type, airy engineered minimalism.' },
  { id: 'contrast', label: 'High Contrast', blurb: 'Maximum legibility, AAA-targeted, no effects.' },
  { id: 'phosphor', label: 'Phosphor', blurb: 'A CRT terminal: mono everywhere, square, scanlines, wide caps.' },
  {
    id: 'blueprint',
    label: 'Blueprint',
    blurb: 'Technical drawing — drafting caps on a hairline grid, plates not cards.',
  },
  {
    id: 'broadsheet',
    label: 'Broadsheet',
    blurb: 'Newsprint: serif at column density, hairline rules, no cards at all.',
  },
  { id: 'wayfinding', label: 'Wayfinding', blurb: 'Transit signage — heavy grotesque, colour bars, huge targets.' },
  { id: 'ledger', label: 'Ledger', blurb: 'Green-bar accounting paper: banded rows, tabular figures, restrained ink.' },
  { id: 'ma', label: 'Ma', blurb: 'Extreme restraint — enormous whitespace, one accent per screen.' },
] as const);

const THEME_MODES: readonly ThemeMode[] = Object.freeze(['system', 'light', 'dark'] as const);
const TEXT_SCALES: readonly TextScale[] = Object.freeze(['default', 'large', 'larger'] as const);

const FAMILY_IDS: readonly string[] = THEME_FAMILIES.map(family => family.id);
const DEFAULT_FAMILY: ThemeFamilyId = 'studio';

export interface ThemePreference {
  readonly family: ThemeFamilyId;
  readonly mode: ThemeMode;
  readonly textScale: TextScale;
}

export const DEFAULT_THEME_PREFERENCE: ThemePreference = Object.freeze({
  family: DEFAULT_FAMILY,
  mode: 'system',
  textScale: 'default',
});

const isFamily = (value: unknown): value is ThemeFamilyId => typeof value === 'string' && FAMILY_IDS.includes(value);
const isMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
const isTextScale = (value: unknown): value is TextScale =>
  typeof value === 'string' && (TEXT_SCALES as readonly string[]).includes(value);

/** The stored preference (inside `{ format: 1, value }`). Each field falls back on its own. */
export const ThemePreferenceSchema = z.strictObject({
  family: z.string().transform(value => (isFamily(value) ? value : DEFAULT_THEME_PREFERENCE.family)),
  mode: z.string().transform(value => (isMode(value) ? value : DEFAULT_THEME_PREFERENCE.mode)),
  textScale: z.string().transform(value => (isTextScale(value) ? value : DEFAULT_THEME_PREFERENCE.textScale)),
});

/** The mode in force once `system` has been answered by the OS. */
export const resolveThemeMode = (mode: ThemeMode, systemDark: boolean): ResolvedMode =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

/** The value published on `<html data-theme>` and mirrored by `[data-swatch]`. */
export const themeAttribute = (family: ThemeFamilyId, resolved: ResolvedMode): string => `${family}-${resolved}`;

/**
 * Publish the text scale on the root as `--fy-text-scale`, the factor every type size in the
 * stylesheet is multiplied by (`text-scale-postcss.ts` applies it at build time to the
 * tokenised and the older pixel typography alike). Never `text-size-adjust`: only iPhone-class
 * WebKit text autosizing honours a percentage, so iPadOS Safari, the installed standalone app and
 * desktop Safari ignored the setting. Never root `zoom` either — it makes `--app-h` itself grow and
 * can put the composer behind a software keyboard. Padding, gaps, safe areas and the 44px target
 * floor are not type and stay fixed; browser and pinch zoom compose normally.
 */
export const applyTextScale = (root: HTMLElement, scale: TextScale): void => {
  root.dataset.textScale = scale;
  root.style.removeProperty('zoom');
  root.style.removeProperty('text-size-adjust');
  root.style.removeProperty('-webkit-text-size-adjust');
  root.style.setProperty('--fy-text-scale', String(TEXT_SCALE_FACTORS[scale]));
};

/* ---------- PWA manifest + window colour ----------------------------------
   One generated manifest exists per family+mode, differing ONLY in
   `theme_color`/`background_color`. The active one is selected by rewriting the
   href of the SINGLE identified manifest link the host document created — never
   by appending another link: browsers take the first manifest link, and the
   extras are dead weight that make the DOM lie about which manifest is in force.
   -------------------------------------------------------------------------- */

/** The id of the one manifest link the host document owns. */
export const MANIFEST_LINK_ID = 'fy-manifest';

/**
 * Matches the family+mode segment of a generated manifest filename. Anchored on
 * the `manifest-` prefix and the following `.` so it cannot touch the release
 * hash or the extension — the release must survive the swap untouched, since it
 * names the generation this bundle belongs to.
 */
const MANIFEST_THEME_RE = /manifest-[a-z]+-[a-z]+\./;

/**
 * Repoint a manifest href at a different family+mode, preserving the release.
 *
 * Pure and exported because it is the one piece of this that can be wrong in a
 * way nothing would notice at runtime: a bad swap yields a 404 the browser
 * reports only in an install prompt nobody is watching. Returns the input
 * unchanged if it does not look like a generated manifest name (a dev server, or
 * a hand-edited href) rather than fabricating a URL.
 */
export const manifestHrefFor = (currentHref: string, family: ThemeFamilyId, resolved: ResolvedMode): string => {
  if (!MANIFEST_THEME_RE.test(currentHref)) return currentHref;
  return currentHref.replace(MANIFEST_THEME_RE, `manifest-${family}-${resolved}.`);
};

/**
 * The live window colour for the OS chrome (Android address bar, Chromium title
 * bar, iOS status-bar tint in standalone).
 *
 * READ FROM THE COMPUTED STYLE, never from a colour map in TypeScript.
 * `styles/themes.css` is the only place a theme's `--bg` is defined. A second
 * copy here would be another source of truth and would drift the first time a
 * token is retuned. Reading it computed also means the value is correct for
 * whatever `data-theme` is actually applied, including one this code does not
 * know about.
 */
export const themeColorFromComputedStyle = (root: Element): string =>
  getComputedStyle(root).getPropertyValue('--bg').trim();

/**
 * The shared theme preference snapshot, shaped for `useSyncExternalStore`: `snapshot()` is identity-stable between
 * commits so React does not re-render a consumer whose preference did not change.
 */
export class ThemePreferenceStore {
  readonly #storage: KeyValueStore | null;
  readonly #listeners = new Set<() => void>();
  #snapshot: ThemePreference | null = null;

  constructor(storage: KeyValueStore | null) {
    this.#storage = storage;
  }

  /** Identity-stable snapshot; the first read hydrates from storage. */
  snapshot(): ThemePreference {
    this.#snapshot ??= this.#load();
    return this.#snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  setFamily(family: ThemeFamilyId): ThemePreference {
    return this.#commit({ ...this.snapshot(), family }, true);
  }

  setMode(mode: ThemeMode): ThemePreference {
    return this.#commit({ ...this.snapshot(), mode }, true);
  }

  setTextScale(textScale: TextScale): ThemePreference {
    return this.#commit({ ...this.snapshot(), textScale }, true);
  }

  /**
   * Take on a preference another tab wrote. Deliberately does NOT write back: the value is already in storage, and
   * echoing it would race the tab that owns the change. A no-op adoption keeps the previous snapshot identity.
   */
  adopt(): ThemePreference {
    const next = this.#load();
    const current = this.snapshot();
    if (next.family === current.family && next.mode === current.mode && next.textScale === current.textScale) {
      return current;
    }
    return this.#commit(next, false);
  }

  #commit(next: ThemePreference, persist: boolean): ThemePreference {
    this.#snapshot = next;
    if (persist) writeRecord(this.#storage, THEME_PREFERENCES_KEY, next);
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): ThemePreference {
    const stored = readRecord(this.#storage, THEME_PREFERENCES_KEY, ThemePreferenceSchema);
    return stored === undefined ? { ...DEFAULT_THEME_PREFERENCE } : (stored as ThemePreference);
  }
}
