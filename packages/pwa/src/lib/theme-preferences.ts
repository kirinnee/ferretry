/**
 * SOLE OWNER of the `fy-theme-v1` browser-storage key.
 *
 * Ported from kteam `ui/src/hooks/useTheme.ts`, whose pure half this is. Theme
 * state is a FAMILY (which look) plus a MODE PREFERENCE (system / light / dark)
 * plus a TEXT SCALE, and the resolved pair is published as ONE root attribute:
 *
 *     <html data-theme="<family>-<mode>">     // mode already resolved
 *
 * `styles/themes.css` declares the tokens for every one of those 22 values and
 * mirrors each on `[data-swatch='<family>-<mode>']`, so a preview element can
 * render in the theme it advertises while the rest of the page stays in the
 * current one. Nothing here may hardcode a colour.
 *
 * Deliberately NOT daemon-scoped, and the survey agrees — "theme selection stays
 * browser-local" (`docs/migration/surveys/pwa-shape.md:240`). A family is a
 * property of the reader's eyes and screen; keying it by `(daemonId, …)` would
 * repaint the app every time the reader switched daemon. Everything that carries
 * daemon *data* is keyed in `daemon-scope.ts`.
 *
 * Two departures from kteam, both forced by this repo's shape:
 *
 * 1. THE KEY IS `fy-theme-v1`, not `kteam-theme`, matching `DRAFTS_KEY` and
 *    `SIDE_PANE_PREFERENCES_KEY`. kteam's key held bare `'light'`/`'dark'`
 *    strings in an earlier life and carried a migration for them; this key has
 *    no history, so what survives here is not a migration but tolerance for a
 *    hand-written or bootstrap-written value (see `parseThemePreference`).
 * 2. THE SNAPSHOT IS INSTANCE STATE on `ThemePreferenceStore` with storage
 *    injected, matching `SidePanePreferenceStore` — kteam kept it in `useState`
 *    inside the hook, which cannot be shared by two consumers or inspected
 *    without rendering.
 *
 * PRE-PAINT AGREEMENT. The host document is expected to resolve the same
 * preference in an inline script before first paint, so there is no flash of the
 * wrong theme. That script and this module MUST agree on the key, the accepted
 * values, the attribute shape and the manifest-link id. This module is the
 * definition; the document follows it.
 */

/** The sole browser-storage key for theme preferences. */
export const THEME_PREFERENCES_KEY = 'fy-theme-v1';

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

export const THEME_MODES: readonly ThemeMode[] = Object.freeze(['system', 'light', 'dark'] as const);
export const TEXT_SCALES: readonly TextScale[] = Object.freeze(['default', 'large', 'larger'] as const);

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

/**
 * Parse whatever is in storage into a valid preference. Accepts, in order: the
 * current JSON shape, a bare mode (`'dark'`), and a bare resolved attribute
 * (`'mission-dark'`) in case one was written by the pre-paint bootstrap or by
 * hand. Anything unrecognised — including a bad field inside otherwise valid
 * JSON — falls back per field, so one corrupt value never resets the others.
 *
 * A WITHDRAWN FAMILY IS AN UNRECOGNISED VALUE, and that is the whole migration
 * story for one. `ember` and `notebook` were retired; a reader still holding
 * `{"family":"ember","mode":"dark","textScale":"large"}` keeps their mode and
 * text scale and lands on Studio, because `isFamily` answers against the CURRENT
 * catalogue and each field falls back on its own. Nothing anywhere maps a dead
 * id to a live one: the alternative — leaving the id to reach the root attribute
 * and matching no block in `themes.css` — is the unstyled render this guards.
 */
export const parseThemePreference = (raw: string | null | undefined): ThemePreference => {
  if (!raw) return { ...DEFAULT_THEME_PREFERENCE };
  const text = raw.trim();
  if (!text) return { ...DEFAULT_THEME_PREFERENCE };

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...DEFAULT_THEME_PREFERENCE };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_THEME_PREFERENCE };
    const fields = parsed as Record<string, unknown>;
    return {
      family: isFamily(fields.family) ? fields.family : DEFAULT_THEME_PREFERENCE.family,
      mode: isMode(fields.mode) ? fields.mode : DEFAULT_THEME_PREFERENCE.mode,
      textScale: isTextScale(fields.textScale) ? fields.textScale : DEFAULT_THEME_PREFERENCE.textScale,
    };
  }

  // A bare mode keeps the reader's mode and adopts the house family.
  if (isMode(text)) return { ...DEFAULT_THEME_PREFERENCE, mode: text };

  // A bare resolved attribute, e.g. what `<html data-theme>` itself carries.
  const cut = text.lastIndexOf('-');
  if (cut > 0) {
    const family = text.slice(0, cut);
    const mode = text.slice(cut + 1);
    if (isFamily(family) && (mode === 'light' || mode === 'dark')) {
      return { family, mode, textScale: DEFAULT_THEME_PREFERENCE.textScale };
    }
  }
  return { ...DEFAULT_THEME_PREFERENCE };
};

/** The mode in force once `system` has been answered by the OS. */
export const resolveThemeMode = (mode: ThemeMode, systemDark: boolean): ResolvedMode =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

/** The value published on `<html data-theme>` and mirrored by `[data-swatch]`. */
export const themeAttribute = (family: ThemeFamilyId, resolved: ResolvedMode): string => `${family}-${resolved}`;

/**
 * Publish the text scale on the root. `text-size-adjust` is intentional: this UI
 * contains both tokenised and legacy pixel typography, and the property scales
 * both without changing the CSS-pixel coordinate system used by visualViewport,
 * fixed shell sizing, safe areas, or the 44px target floor. The prefixed
 * spelling covers WebKit; browser/pinch zoom remains enabled and composes
 * normally. Never use root `zoom` here — it makes `--app-h` itself grow and can
 * put the composer behind a software keyboard.
 */
export const applyTextScale = (root: HTMLElement, scale: TextScale): void => {
  root.dataset.textScale = scale;
  const percent = `${TEXT_SCALE_FACTORS[scale] * 100}%`;
  root.style.removeProperty('zoom');
  root.style.setProperty('text-size-adjust', percent);
  root.style.setProperty('-webkit-text-size-adjust', percent);
};

export type CssSupports = (property: string, value: string) => boolean;

/**
 * Percentage support is the capability that matters. Some engines recognise the
 * property name but accept only `auto`/`none`; treating that as support would
 * leave an enabled control that silently does nothing.
 */
export const supportsTextScale = (probe?: CssSupports): boolean => {
  const supports =
    probe ?? (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' ? CSS.supports.bind(CSS) : undefined);
  if (!supports) return false;
  return supports('text-size-adjust', '125%') || supports('-webkit-text-size-adjust', '125%');
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

export interface ThemePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): ThemePreferenceStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: ThemePreferenceStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    // Private mode / blocked storage is an ordinary browser condition.
    return undefined;
  }
};

/**
 * The shared theme preference snapshot, shaped for `useSyncExternalStore`:
 * `snapshot()` is identity-stable between commits so React does not re-render a
 * consumer whose preference did not change.
 */
export class ThemePreferenceStore {
  readonly #storage: ThemePreferenceStorage | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: ThemePreference | null = null;

  constructor(storage: ThemePreferenceStorage | undefined = browserStorage()) {
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
   * Take on a preference another tab wrote. Deliberately does NOT write back:
   * the value is already in storage, and echoing it would race the tab that owns
   * the change. A no-op adoption keeps the previous snapshot identity so React
   * does not re-render every consumer on an unrelated `storage` event.
   */
  adopt(raw: string | null | undefined): ThemePreference {
    const next = parseThemePreference(raw);
    const current = this.snapshot();
    if (next.family === current.family && next.mode === current.mode && next.textScale === current.textScale) {
      return current;
    }
    return this.#commit(next, false);
  }

  #commit(next: ThemePreference, persist: boolean): ThemePreference {
    this.#snapshot = next;
    if (persist) this.#save(next);
    for (const listener of this.#listeners) listener();
    return next;
  }

  #load(): ThemePreference {
    if (!this.#storage) return { ...DEFAULT_THEME_PREFERENCE };
    try {
      return parseThemePreference(this.#storage.getItem(THEME_PREFERENCES_KEY));
    } catch {
      return { ...DEFAULT_THEME_PREFERENCE };
    }
  }

  /**
   * A failed persistence write never blocks a theme change; the in-memory
   * preference still applies for the rest of the tab.
   */
  #save(preference: ThemePreference): boolean {
    if (!this.#storage) return false;
    try {
      this.#storage.setItem(THEME_PREFERENCES_KEY, JSON.stringify(preference));
      return true;
    } catch {
      return false;
    }
  }
}
