/**
 * The live theme, as React state. Ported from kteam `ui/src/hooks/useTheme.ts`
 * — its effectful half; the preference model, parsing and persistence are in
 * `lib/theme-preferences.ts`.
 *
 * The hook owns exactly three things the pure module cannot:
 *
 *   1. the OS answer to `system` (`prefers-color-scheme`, followed live),
 *   2. cross-tab agreement (a `storage` event adopts the other tab's value),
 *   3. publication — `<html data-theme>`, the text scale, the manifest link and
 *      the `theme-color` meta, all in ONE effect and in that order, because the
 *      window colour is read back from the computed style and that read is only
 *      correct once `data-theme` is applied.
 *
 * The store is injectable so a test — or a second consumer that must not share
 * a snapshot — can supply its own. Default is the module-level store, so every
 * `useTheme()` in one tab renders the same preference.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  applyTextScale,
  manifestHrefFor,
  MANIFEST_LINK_ID,
  resolveThemeMode,
  supportsTextScale,
  themeAttribute,
  themeColorFromComputedStyle,
  THEME_FAMILIES,
  THEME_PREFERENCES_KEY,
  ThemePreferenceStore,
  type ResolvedMode,
  type TextScale,
  type ThemeFamily,
  type ThemeFamilyId,
  type ThemeMode,
  type ThemePreference,
} from '../lib/theme-preferences.ts';

/** The one store every consumer in a tab shares unless a test injects another. */
export const themePreferences = new ThemePreferenceStore();

const DARK_QUERY = '(prefers-color-scheme: dark)';

const osPrefersDark = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;

export interface ThemeState extends ThemePreference {
  /** The mode actually in force — never `system`. */
  readonly resolved: ResolvedMode;
  /** The value on `<html data-theme>`, e.g. `mission-dark`. */
  readonly attr: string;
  readonly families: readonly ThemeFamily[];
  readonly textScaleSupported: boolean;
  readonly setFamily: (family: ThemeFamilyId) => void;
  readonly setMode: (mode: ThemeMode) => void;
  readonly setTextScale: (scale: TextScale) => void;
}

export function useTheme(store: ThemePreferenceStore = themePreferences): ThemeState {
  // ONE reader for both the client and the server snapshot: the store is the
  // same object in either environment (a preference nobody has touched is the
  // house default), so a separate server reader would be a second thing to keep
  // true for no gain.
  const readPreference = useCallback(() => store.snapshot(), [store]);
  const preference = useSyncExternalStore(store.subscribe, readPreference, readPreference);
  const [systemDark, setSystemDark] = useState<boolean>(osPrefersDark);
  const textScaleSupported = supportsTextScale();

  // Follow the OS live. Subscribed unconditionally — it is one listener, the
  // reader can flip to `system` at any moment, and the value only *matters*
  // when the preference is `system`.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    // The OS may have flipped between the lazy initial state and this effect.
    setSystemDark(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // A second tab changing the theme must not leave this one stale.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_PREFERENCES_KEY) store.adopt(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  const resolved = resolveThemeMode(preference.mode, systemDark);
  const attr = themeAttribute(preference.family, resolved);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = attr;
    applyTextScale(root, preference.textScale);

    const link = document.getElementById(MANIFEST_LINK_ID);
    if (link) {
      const current = link.getAttribute('href') ?? '';
      const next = manifestHrefFor(current, preference.family, resolved);
      // Only on a real change: assigning the same href re-fetches the manifest
      // in some browsers, and this effect runs on every mode flip.
      if (next !== current) link.setAttribute('href', next);
    }

    // ONE identified meta element, created on demand. The host document ships
    // without a `theme-color`: a static one would be wrong for six of the seven
    // families, and briefly painting the wrong colour is worse than none.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    const color = themeColorFromComputedStyle(root);
    if (color && meta.content !== color) meta.content = color;
  }, [attr, preference.family, preference.textScale, resolved]);

  const setFamily = useCallback((family: ThemeFamilyId) => store.setFamily(family), [store]);
  const setMode = useCallback((mode: ThemeMode) => store.setMode(mode), [store]);
  const setTextScale = useCallback(
    (scale: TextScale) => {
      // An unsupported scale must not be persisted: it would follow the reader
      // to a browser that DOES support it and silently enlarge everything.
      if (textScaleSupported) store.setTextScale(scale);
    },
    [store, textScaleSupported],
  );

  return useMemo(
    () => ({
      family: preference.family,
      mode: preference.mode,
      textScale: preference.textScale,
      resolved,
      attr,
      families: THEME_FAMILIES,
      textScaleSupported,
      setFamily,
      setMode,
      setTextScale,
    }),
    [
      preference.family,
      preference.mode,
      preference.textScale,
      resolved,
      attr,
      textScaleSupported,
      setFamily,
      setMode,
      setTextScale,
    ],
  );
}
