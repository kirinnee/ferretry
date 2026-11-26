/**
 * MAP STYLE — which service draws a `map` block, and the one place Google's address is written. This file is the
 * whole choice, so it can move with the renderer (`fy-render-map-style-row.tsx` is its Settings row).
 *
 * TWO STYLES. `osm` is the default and always works: Leaflet in the page, tiles from OpenStreetMap
 * (`fy-render-map-tiles.ts`). `google` is OPT-IN, per browser, and is Google's Maps EMBED API: an iframe the page
 * asks for, never the paid JavaScript API. It costs the reader privacy (Google sees which places they open), which is
 * why it is a choice and the setting says so.
 *
 * THE KEY LIVES IN THIS BROWSER ONLY. A Maps Embed key is browser-visible by Google's design (it sits in the frame's
 * address; it is restricted by referrer and to one API in Google Cloud), so it is NOT a secret of the daemon's:
 * the owner types it once per device, it is kept in this browser's storage beside the style, and it is never sent to
 * the daemon. It cannot live in a configuration file either — the raw-secret detector refuses its `AIza…` shape — and
 * the secret store never returns a value, which a frame address needs. docs/fy-render.md › Maps has the reasoning.
 * Storage that is empty, blocked or cleared is simply "no key": maps stay OpenStreetMap and say the key is needed.
 *
 * WHAT THE EMBED CANNOT DRAW stays on OpenStreetMap and the block says so: more than one marker, a route, a polygon.
 * Its `place` mode shows ONE point and `view` shows a plain map. A lone marker's label and popup are returned as a
 * caption the block prints under the frame.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR LOGS A KEY. This module builds an address and decides; the component puts it in
 * a frame, and the page's `frame-src` (`packages/app/public/_headers`) is the only thing that lets that frame load,
 * pinned to {@link GOOGLE_EMBED_FRAME_SOURCE} by a unit test.
 */

import { MAP_DEFAULT_ZOOM, type MapPoint, type MapSpec } from './fy-render-map-model.ts';

/** The reader's choice, stored per browser. */
export type MapStyle = 'osm' | 'google';

export interface MapChoice {
  readonly style: MapStyle;
  /** The Maps Embed key, or null when none is kept on this device. */
  readonly key: string | null;
}

export const DEFAULT_MAP_CHOICE: MapChoice = { key: null, style: 'osm' };

/** The browser-storage name of the choice (one JSON value: style and key). */
export const MAP_STYLE_STORAGE_NAME = 'fy-map-style';

/** The Settings row's one-line privacy note. */
export const GOOGLE_MAPS_PRIVACY_NOTE = 'Google sees which places you open';

/** The Settings row's plain statement of what the key is and where it stays. */
export const GOOGLE_KEY_NOTE =
  "A Google Maps Embed API key is browser-visible by Google's design. It is stored in this browser only and is never sent to the daemon.";

/** What a map says when Google was chosen and this browser holds no key. */
export const GOOGLE_KEY_NEEDED_NOTE =
  'Shown with OpenStreetMap: Google Maps needs its key on this device (Settings › Appearance › Map style).';

/**
 * THE EMBED'S ADDRESS, split so the CSP source is derived and not retyped. `frame-src` names the origin plus the path
 * prefix, so every endpoint under `/maps/embed/v1/` is framable and nothing else on `www.google.com` is.
 */
const GOOGLE_EMBED_ORIGIN = 'https://www.google.com';
const GOOGLE_EMBED_PATH = '/maps/embed/v1/';
export const GOOGLE_EMBED_FRAME_SOURCE = `${GOOGLE_EMBED_ORIGIN}${GOOGLE_EMBED_PATH}`;

/** A Google API key is `AIza` and 35 URL-safe characters; accept the family, refuse anything that is not one token. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,80}$/u;

/** The key in `value`, or null: a blank, a malformed or a non-string value is "no key". */
export const readEmbedKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return KEY_SHAPE.test(key) ? key : null;
};

/** What a stored value says. Total: anything unreadable is the default (OpenStreetMap, no key). */
export const parseMapChoice = (raw: string | null | undefined): MapChoice => {
  if (typeof raw !== 'string') return DEFAULT_MAP_CHOICE;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return DEFAULT_MAP_CHOICE;
    const { style, key } = value as { readonly style?: unknown; readonly key?: unknown };
    return { key: readEmbedKey(key), style: style === 'google' ? 'google' : 'osm' };
  } catch {
    return DEFAULT_MAP_CHOICE;
  }
};

/** The part of `Storage` this module uses, so a test passes a plain object and a blocked browser can throw. */
export interface MapChoiceStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

const browserStorage = (): MapChoiceStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The stored choice; storage that is absent, blocked or empty answers the default. */
export const loadMapChoice = (storage: MapChoiceStorage | null = browserStorage()): MapChoice => {
  try {
    return parseMapChoice(storage?.getItem(MAP_STYLE_STORAGE_NAME));
  } catch {
    return DEFAULT_MAP_CHOICE;
  }
};

/** Keeps the choice; false when this browser refused (the caller says the choice holds for this page only). */
export const saveMapChoice = (choice: MapChoice, storage: MapChoiceStorage | null = browserStorage()): boolean => {
  try {
    if (storage === null) return false;
    if (choice.style === 'osm' && choice.key === null) storage.removeItem(MAP_STYLE_STORAGE_NAME);
    else storage.setItem(MAP_STYLE_STORAGE_NAME, JSON.stringify({ key: choice.key, style: choice.style }));
    return true;
  } catch {
    return false;
  }
};

/** What this browser can do with a Google frame. Read once per block; injectable so the test tier needs no browser. */
export interface MapEnvironment {
  /** `crossOriginIsolated`: the opt-in several-cores mode (docs/voice.md). */
  readonly isolated: boolean;
  /** Whether `<iframe credentialless>` exists here (Chromium; Safari and Firefox lack it). */
  readonly credentialless: boolean;
}

export const readMapEnvironment = (): MapEnvironment => ({
  credentialless: typeof HTMLIFrameElement !== 'undefined' && 'credentialless' in HTMLIFrameElement.prototype,
  isolated: globalThis.crossOriginIsolated === true,
});

/** How a map is drawn. `note` is printed under an OpenStreetMap map when Google was asked for and could not be used. */
export type MapDrawing =
  | {
      readonly via: 'google';
      readonly src: string;
      /** Whether the frame is `credentialless`: no cookies to Google, and allowed under cross-origin isolation. */
      readonly credentialless: boolean;
      /** The one marker's label and popup, which the embed cannot draw. */
      readonly caption: string | null;
    }
  | { readonly via: 'osm'; readonly note: string | null };

const OSM: MapDrawing = { note: null, via: 'osm' };
const osmBecause = (reason: string): MapDrawing => ({ note: `Shown with OpenStreetMap: ${reason}.`, via: 'osm' });

const coordinate = (point: MapPoint): string => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;

const sameSpot = (a: MapPoint, b: MapPoint): boolean => coordinate(a) === coordinate(b);

/** The zoom a lone pin gets when none was asked for, matching what the OpenStreetMap engine does (fit ceiling 15). */
const FITTED_PIN_ZOOM = 15;
const lonePinZoom = (spec: MapSpec): number => (spec.fit ? FITTED_PIN_ZOOM : MAP_DEFAULT_ZOOM);

const embedAddress = (mode: 'place' | 'view', params: Readonly<Record<string, string>>): string =>
  `${GOOGLE_EMBED_FRAME_SOURCE}${mode}?${new URLSearchParams(params).toString()}`;

/**
 * Decides how one map is drawn. Total: every input yields a drawing, and the fallback is always the default style, so a
 * missing key, an unsupported browser or a map Google cannot draw never fails a block.
 */
export const chooseMapDrawing = (
  spec: MapSpec,
  choice: MapChoice & { readonly environment: MapEnvironment },
): MapDrawing => {
  const { style, key, environment } = choice;
  if (style !== 'google') return OSM;
  if (key === null) return { note: GOOGLE_KEY_NEEDED_NOTE, via: 'osm' };
  if (environment.isolated && !environment.credentialless) {
    return osmBecause("this browser can't show Google Maps while several cores are on");
  }
  if (spec.lines.length > 0 || spec.polygons.length > 0) {
    return osmBecause("Google Maps can't draw routes or shapes here");
  }
  if (spec.markers.length > 1) return osmBecause("Google Maps can't draw more than one marker here");
  const credentialless = environment.credentialless;
  const zoom = spec.zoom === null ? null : String(Math.round(spec.zoom));
  const [pin] = spec.markers;
  if (pin !== undefined) {
    if (spec.center !== null && !sameSpot(spec.center, pin)) {
      return osmBecause("Google Maps can't centre away from the marker here");
    }
    const caption = [pin.label, pin.popup].filter((part): part is string => part !== null && part !== '').join(' — ');
    return {
      caption: caption === '' ? null : caption,
      credentialless,
      src: embedAddress('place', {
        key,
        maptype: 'roadmap',
        q: coordinate(pin),
        zoom: zoom ?? String(lonePinZoom(spec)),
      }),
      via: 'google',
    };
  }
  if (spec.center === null) return osmBecause('Google Maps needs a centre or a marker here');
  return {
    caption: null,
    credentialless,
    src: embedAddress('view', {
      center: coordinate(spec.center),
      key,
      maptype: 'roadmap',
      ...(zoom === null ? {} : { zoom }),
    }),
    via: 'google',
  };
};
