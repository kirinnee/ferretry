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
 * STORAGE. The record is `{ format: 1, value: { style, palette, keepPalette, mode, textScale } }` (`storage/records.ts`
 * knows one format; an absent `keepPalette` reads as false). A style or palette id with no pack, whatever the reason, reads
 * as the default one; it is NOT rewritten, so the stored record stays until the person's next explicit change. The one
 * exception is the Layouts contract's data-only table of OLD ids (`REMOVED_PALETTE_IDS`, `REMOVED_STYLE_IDS`, the pre-split
 * `family`): an id in it reads as the pack it was renamed to, on READ only.
 *
 * STYLE → PALETTE. Picking a style also sets that style's `defaultPalette`, unless `keepPalette` is on ("Don't change my
 * colours when I change style"). Picking a palette never touches the style, and turns `keepPalette` on: a style's default
 * colours apply only until the person picks a palette, and a chosen palette is never overridden by a later style change
 * (ruling C-5). The switch off hands the colours back to the style.
 *
 * PRE-PAINT AGREEMENT. `public/pre-paint.js` resolves the same preference before first paint, so there is no flash
 * of the wrong theme. It and this module MUST agree on the key, the record shape, the modes, the text scales and the
 * attribute shape. It keeps NO list of style or palette ids (nothing that runs that early can know the packs): it
 * resolves a stored id against the generated id lists (and the same old-id table, which the generator writes into the same
 * file), so the first frame is the look this module then publishes.
 */
import {
  FAMILY_STYLE_OF_PALETTE,
  REMOVED_PALETTE_IDS,
  REMOVED_STYLE_IDS,
  THEME_FAMILY_IDS,
} from '@ferretry/plugin-layouts/contract';
import { z } from 'zod';
import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, writeRecord } from '../storage/records.ts';
import {
  DEFAULT_PALETTE,
  DEFAULT_STYLE,
  defaultPaletteOf,
  isPaletteId,
  isStyleId,
  type PaletteId,
  type StyleId,
} from './catalog.ts';

export type { PaletteId, StyleId };

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

const THEME_MODES: readonly ThemeMode[] = Object.freeze(['system', 'light', 'dark'] as const);
const TEXT_SCALES: readonly TextScale[] = Object.freeze(['default', 'large', 'larger'] as const);

/** What is stored: the two look axes, the mode preference, the text scale and whether a style change keeps the colours. */
export interface ThemePreference {
  readonly style: StyleId;
  readonly palette: PaletteId;
  /** True: picking a style leaves the palette alone. Absent in an older record, which reads as false. */
  readonly keepPalette: boolean;
  readonly mode: ThemeMode;
  readonly textScale: TextScale;
}

export const DEFAULT_THEME_PREFERENCE: ThemePreference = Object.freeze({
  style: DEFAULT_STYLE,
  palette: DEFAULT_PALETTE,
  keepPalette: false,
  mode: 'system',
  textScale: 'default',
});

const isMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
const isTextScale = (value: unknown): value is TextScale =>
  typeof value === 'string' && (TEXT_SCALES as readonly string[]).includes(value);

const has = (table: object, key: unknown): boolean => typeof key === 'string' && Object.hasOwn(table, key);
const renamedPalette = (id: unknown): unknown =>
  has(REMOVED_PALETTE_IDS, id) ? REMOVED_PALETTE_IDS[id as keyof typeof REMOVED_PALETTE_IDS] : id;

/**
 * The look a stored record names. Order, as the first-paint script does it: a pre-split `family` (a palette, and the style
 * that palette read as), then an old style id (which may bring a palette that wins), then the stored style and palette, each
 * renamed through the old-id table when it is in it. Whatever has no pack reads as the default.
 */
const lookOf = (value: {
  readonly family?: unknown;
  readonly style?: unknown;
  readonly palette?: unknown;
}): { readonly style: StyleId; readonly palette: PaletteId } => {
  let style: StyleId = DEFAULT_STYLE;
  let palette: PaletteId = DEFAULT_PALETTE;
  const family = (THEME_FAMILY_IDS as readonly unknown[]).includes(value.family)
    ? renamedPalette(value.family)
    : undefined;
  if (isPaletteId(family)) {
    palette = family;
    const familyStyle = FAMILY_STYLE_OF_PALETTE[family as keyof typeof FAMILY_STYLE_OF_PALETTE];
    if (isStyleId(familyStyle)) style = familyStyle;
  }
  const removed = has(REMOVED_STYLE_IDS, value.style)
    ? (REMOVED_STYLE_IDS[value.style as keyof typeof REMOVED_STYLE_IDS] as { style: string; palette?: string })
    : undefined;
  const storedStyle = removed?.style ?? value.style;
  if (isStyleId(storedStyle)) style = storedStyle;
  const storedPalette = removed?.palette ?? renamedPalette(value.palette);
  if (isPaletteId(storedPalette)) palette = storedPalette;
  return { style, palette };
};

/**
 * The stored preference (inside `{ format: 1, value }`). Each field falls back on its own: a style or palette with no
 * pack reads as the default one (an OLD id reads as the pack it was renamed to), and nothing else is looked up.
 */
export const ThemePreferenceSchema = z
  .looseObject({
    family: z.unknown().optional(),
    style: z.unknown().optional(),
    palette: z.unknown().optional(),
    keepPalette: z.unknown().optional(),
    mode: z.string().transform(value => (isMode(value) ? value : DEFAULT_THEME_PREFERENCE.mode)),
    textScale: z.string().transform(value => (isTextScale(value) ? value : DEFAULT_THEME_PREFERENCE.textScale)),
  })
  .transform(
    (value): ThemePreference => ({
      ...lookOf(value),
      keepPalette: value.keepPalette === true,
      mode: value.mode,
      textScale: value.textScale,
    }),
  );

/** The mode in force once `system` has been answered by the OS. */
export const resolveThemeMode = (mode: ThemeMode, systemDark: boolean): ResolvedMode =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

/** The legacy single attribute, `<html data-theme>`: the palette and the resolved mode. Only the MODE is meant to be read from it. */
export const themeAttribute = (palette: PaletteId, resolved: ResolvedMode): string => `${palette}-${resolved}`;

/** Publish the three axes on the root (and keep the legacy `data-theme`). */
export const applyThemeAxes = (root: HTMLElement, preference: ThemePreference, resolved: ResolvedMode): void => {
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
export const manifestHrefFor = (currentHref: string, palette: PaletteId, resolved: ResolvedMode): string => {
  if (!MANIFEST_THEME_RE.test(currentHref)) return currentHref;
  return currentHref.replace(MANIFEST_THEME_RE, `manifest-${palette}-${resolved}.`);
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

  /** A style, and (unless the device keeps its colours) the palette that comes with it. */
  setStyle(style: StyleId): ThemePreference {
    const current = this.snapshot();
    const palette = current.keepPalette ? current.palette : defaultPaletteOf(style);
    return this.#commit({ ...current, style, palette }, true);
  }

  /** "Don't change my colours when I change style". */
  setKeepPalette(keepPalette: boolean): ThemePreference {
    return this.#commit({ ...this.snapshot(), keepPalette }, true);
  }

  /** An explicit pick: the palette is the person's from now on, so a later style change keeps it. */
  setPalette(palette: PaletteId): ThemePreference {
    return this.#commit({ ...this.snapshot(), palette, keepPalette: true }, true);
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
    if (
      next.style === current.style &&
      next.palette === current.palette &&
      next.keepPalette === current.keepPalette &&
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
      const { style, palette, keepPalette, mode, textScale } = next;
      writeRecord(this.#storage, THEME_PREFERENCES_KEY, { style, palette, keepPalette, mode, textScale });
    }
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): ThemePreference {
    const stored = readRecord(this.#storage, THEME_PREFERENCES_KEY, ThemePreferenceSchema);
    return stored === undefined ? { ...DEFAULT_THEME_PREFERENCE } : stored;
  }
}
