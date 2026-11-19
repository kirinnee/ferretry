/**
 * SOLE OWNER of this device's theme preference (`fy:app:theme`, §9.4) — a device setting (§5.2): it applies to this
 * device only and needs no daemon and no hash check. Copied from today's PWA `lib/theme-preferences.ts`.
 *
 * Theme state is a STYLE (how things are drawn) plus a PALETTE (which colours) plus a MODE PREFERENCE (system / light /
 * dark) plus a TEXT SCALE, and the resolved axes are published as root attributes:
 *
 *     <html data-style="<style>" data-palette="<palette>" data-mode="<light|dark>" data-theme="<palette>-<mode>">
 *
 * `data-theme` is the pre-split single attribute, kept only for consumers that need the MODE or a change signal; no
 * stylesheet rule reads it. `styles/themes.css` declares the tokens for every style and palette and mirrors them on any
 * element carrying `data-swatch`, so a preview can render in the theme it advertises. Nothing here may hardcode a
 * colour. A theme ITEM (data, `./tokens.ts`) overrides tokens on top of the theme in force.
 *
 * STORAGE. The record stays `{ format: 1, value }` (`storage/records.ts` knows one format); the VALUE moved from
 * `{ family, mode, textScale }` to `{ style, palette, mode, textScale }`. A stored `family` is read through
 * `lookOfFamily` (the same table `public/pre-paint.js` restates) and rewritten in the new shape on the next change.
 *
 * PRE-PAINT AGREEMENT. `public/pre-paint.js` resolves the same preference before first paint, so there is no flash
 * of the wrong theme. It and this module MUST agree on the key, the record shape, the accepted values and the
 * attribute shape. This module is the definition; the script follows it.
 */
import { z } from 'zod';
import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, writeRecord } from '../storage/records.ts';
import {
  DEFAULT_PALETTE,
  DEFAULT_STYLE,
  isFamilyId,
  isPaletteId,
  isStyleId,
  lookOfFamily,
  type PaletteId,
  type StyleId,
  type ThemeFamilyId,
} from './catalog.ts';

export type { PaletteId, StyleId, ThemeFamilyId };

/** The browser-storage key for theme preferences. */
export const THEME_PREFERENCES_KEY = APP_STORAGE.theme;

export type ThemeMode = 'system' | 'light' | 'dark';
/** The mode actually in force — never `system`. */
export type ResolvedMode = 'light' | 'dark';
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
 * The single-pick LOOKS the picker still offers until Appearance shows the axes: each is a palette plus the style it was
 * drawn for (`PaletteEntry.suggestedStyle`). Order is the order shown: the four house looks, the accessibility look,
 * then the six characterful palettes. Choosing one sets the style AND the palette; the axes can then be changed apart.
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
    blurb: 'Technical drawing — drafting caps on a hairline grid, plates, not boxes.',
  },
  {
    id: 'broadsheet',
    label: 'Broadsheet',
    blurb: 'Newsprint: serif at column density, hairline rules, no boxes at all.',
  },
  { id: 'wayfinding', label: 'Wayfinding', blurb: 'Transit signage — heavy grotesque, colour bars, huge targets.' },
  { id: 'ledger', label: 'Ledger', blurb: 'Green-bar accounting paper: banded rows, tabular figures, restrained ink.' },
  { id: 'ma', label: 'Ma', blurb: 'Extreme restraint — enormous whitespace, one accent per screen.' },
] as const);

const THEME_MODES: readonly ThemeMode[] = Object.freeze(['system', 'light', 'dark'] as const);
const TEXT_SCALES: readonly TextScale[] = Object.freeze(['default', 'large', 'larger'] as const);

/** What is stored: the two look axes, the mode preference and the text scale. */
export interface StoredThemePreference {
  readonly style: StyleId;
  readonly palette: PaletteId;
  readonly mode: ThemeMode;
  readonly textScale: TextScale;
}

/**
 * What a reader gets: the stored axes plus `family`, the single-pick look that names the current PALETTE (a palette id is a
 * family id). It is derived, never stored, and exists so the pre-split picker keeps working until Appearance shows the axes.
 */
export interface ThemePreference extends StoredThemePreference {
  readonly family: ThemeFamilyId;
}

const withFamily = (stored: StoredThemePreference): ThemePreference => ({ ...stored, family: stored.palette });

export const DEFAULT_THEME_PREFERENCE: ThemePreference = Object.freeze(
  withFamily({ style: DEFAULT_STYLE, palette: DEFAULT_PALETTE, mode: 'system', textScale: 'default' }),
);

const isMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
const isTextScale = (value: unknown): value is TextScale =>
  typeof value === 'string' && (TEXT_SCALES as readonly string[]).includes(value);

/**
 * The stored preference (inside `{ format: 1, value }`). Each field falls back on its own. A pre-split value carries
 * `family` instead of `style` + `palette`: it is read through the family table, and an explicit `style` / `palette`
 * beside it wins.
 */
export const ThemePreferenceSchema = z
  .looseObject({
    family: z.unknown().optional(),
    style: z.unknown().optional(),
    palette: z.unknown().optional(),
    mode: z.string().transform(value => (isMode(value) ? value : DEFAULT_THEME_PREFERENCE.mode)),
    textScale: z.string().transform(value => (isTextScale(value) ? value : DEFAULT_THEME_PREFERENCE.textScale)),
  })
  .transform((value): StoredThemePreference => {
    const fromFamily = isFamilyId(value.family) ? lookOfFamily(value.family) : undefined;
    return {
      style: isStyleId(value.style) ? value.style : (fromFamily?.style ?? DEFAULT_STYLE),
      palette: isPaletteId(value.palette) ? value.palette : (fromFamily?.palette ?? DEFAULT_PALETTE),
      mode: value.mode,
      textScale: value.textScale,
    };
  });

/** The mode in force once `system` has been answered by the OS. */
export const resolveThemeMode = (mode: ThemeMode, systemDark: boolean): ResolvedMode =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

/** The legacy single attribute, `<html data-theme>`: the palette and the resolved mode. Only the MODE is meant to be read from it. */
export const themeAttribute = (palette: PaletteId, resolved: ResolvedMode): string => `${palette}-${resolved}`;

/** Publish the three axes on the root (and keep the legacy `data-theme`). */
export const applyThemeAxes = (root: HTMLElement, preference: StoredThemePreference, resolved: ResolvedMode): void => {
  root.dataset.style = preference.style;
  root.dataset.palette = preference.palette;
  root.dataset.mode = resolved;
  root.dataset.theme = themeAttribute(preference.palette, resolved);
};

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

  /** A single-pick look: the palette AND the style it was drawn for. */
  setFamily(family: ThemeFamilyId): ThemePreference {
    return this.#commit(withFamily({ ...this.snapshot(), ...lookOfFamily(family) }), true);
  }

  setStyle(style: StyleId): ThemePreference {
    return this.#commit(withFamily({ ...this.snapshot(), style }), true);
  }

  setPalette(palette: PaletteId): ThemePreference {
    return this.#commit(withFamily({ ...this.snapshot(), palette }), true);
  }

  setMode(mode: ThemeMode): ThemePreference {
    return this.#commit(withFamily({ ...this.snapshot(), mode }), true);
  }

  setTextScale(textScale: TextScale): ThemePreference {
    return this.#commit(withFamily({ ...this.snapshot(), textScale }), true);
  }

  /**
   * Take on a preference another tab wrote. Deliberately does NOT write back: the value is already in storage, and
   * echoing it would race the tab that owns the change. A no-op adoption keeps the previous snapshot identity.
   */
  adopt(): ThemePreference {
    const next = this.#load();
    const current = this.snapshot();
    if (
      next.style === current.style &&
      next.palette === current.palette &&
      next.mode === current.mode &&
      next.textScale === current.textScale
    ) {
      return current;
    }
    return this.#commit(next, false);
  }

  #commit(next: ThemePreference, persist: boolean): ThemePreference {
    this.#snapshot = next;
    if (persist) {
      const { style, palette, mode, textScale } = next;
      writeRecord(this.#storage, THEME_PREFERENCES_KEY, { style, palette, mode, textScale });
    }
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): ThemePreference {
    const stored = readRecord(this.#storage, THEME_PREFERENCES_KEY, ThemePreferenceSchema);
    return stored === undefined ? { ...DEFAULT_THEME_PREFERENCE } : withFamily(stored);
  }
}
