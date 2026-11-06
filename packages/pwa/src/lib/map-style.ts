/**
 * MAP STYLE — which service draws a `map` block, and the one place Google's address is written.
 *
 * TWO STYLES. `osm` is the default and always works: Leaflet in the page, tiles from OpenStreetMap
 * (`fy-render-map-tiles.ts`). `google` is OPT-IN, per device (Settings › Appearance › Map style), and it
 * is Google's Maps EMBED API: an iframe the page asks for, never the paid JavaScript API. The embed is
 * free and has no usage charge, but it costs the reader privacy — Google sees which places they open —
 * which is why it is a choice and the setting says so in one line.
 *
 * ONE FERRETRY KEY, IT HAS NO OTHER HOME. Ferretry has one public, referrer-restricted browser key; it
 * is a BUILD-TIME value (`FY_GOOGLE_MAPS_EMBED_KEY`, set as a GitHub variable and read by `vite.config.ts`
 * into `__FY_GOOGLE_MAPS_EMBED_KEY__`). Not a runtime advertisement, on purpose: the key only works from
 * the addresses it was restricted to, so a key served at runtime to an app on any OTHER address would be a
 * key that cannot work there, and the only place that knows which build is on which address is the build.
 * A build without it (a fork, a Nix profile, a local `vite build`) simply has no Google option — never an
 * error, and the setting does not appear. `docs/fy-render.md` › Maps has the reasoning and the owner's steps.
 *
 * WHAT THE EMBED CANNOT DRAW falls back to OpenStreetMap, and the block says so: more than one marker, a
 * route, a polygon. Its `place` mode shows ONE point and `view` shows a plain map; there is no API for
 * the rest. A lone marker's label and popup are not drawn by Google either, so they are returned as a
 * caption the block prints under the frame.
 *
 * NOTHING HERE TOUCHES THE NETWORK. This module builds an address and decides; the component puts it in a
 * frame, and the page's `frame-src` (`public/_headers`) is the only thing that lets that frame load —
 * pinned to {@link GOOGLE_EMBED_FRAME_SOURCE} by a unit test and `scripts/validate/pages-config.sh`.
 */

import { MAP_DEFAULT_ZOOM, type MapPoint, type MapSpec } from './fy-render-map.ts';

/** The reader's choice, stored per device (`DeviceControls.mapStyle`). */
export type MapStyle = 'osm' | 'google';

export const DEFAULT_MAP_STYLE: MapStyle = 'osm';

/** The Settings row's one-line privacy note. */
export const GOOGLE_MAPS_PRIVACY_NOTE = 'Google sees which places you open';

/**
 * THE EMBED'S ADDRESS, split so the CSP source is derived and not retyped. `frame-src` names the origin
 * plus the path prefix: a source with a path ending in `/` matches everything beneath it, so every endpoint
 * under `/maps/embed/v1/` is framable (not only `place` and `view`) and nothing else on `www.google.com`
 * (nor the rest of `/maps/`) is — for the INITIAL URL only: CSP ignores paths after a redirect, so a
 * redirect from the embed can land anywhere on an allowed scheme and host, though the scheme and host stay
 * constrained. The frame's sandbox includes `allow-popups-to-escape-sandbox`, so a window it opens is NOT sandboxed.
 */
const GOOGLE_EMBED_ORIGIN = 'https://www.google.com';
const GOOGLE_EMBED_PATH = '/maps/embed/v1/';
export const GOOGLE_EMBED_FRAME_SOURCE = `${GOOGLE_EMBED_ORIGIN}${GOOGLE_EMBED_PATH}`;

/** A Google API key is `AIza` and 35 URL-safe characters; accept the family, refuse anything that is not one token. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,80}$/;

/**
 * The key a build carries, or null. A blank, a malformed or a non-string value is "no key" — the Google
 * option disappears — because a value that is not shaped like a key cannot be one, and sending it to
 * Google as a query parameter would only produce a frame that says so.
 */
export const readEmbedKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return KEY_SHAPE.test(key) ? key : null;
};

declare const __FY_GOOGLE_MAPS_EMBED_KEY__: string | undefined;

/** The key baked into this build (`vite.config.ts`), or null. */
export const bundledEmbedKey = (): string | null =>
  readEmbedKey(typeof __FY_GOOGLE_MAPS_EMBED_KEY__ === 'string' ? __FY_GOOGLE_MAPS_EMBED_KEY__ : null);

/** What this browser can do with a Google frame. Read once per block; injectable so the test tier needs no browser. */
export interface MapEnvironment {
  /** `crossOriginIsolated`: the opt-in several-cores mode (docs/design/voice-modes.md §6). */
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

/**
 * The zoom a lone pin gets when none was asked for, matching what the OpenStreetMap engine does: a FITTED
 * map (`fit`, which is also the default when there is no centre) frames the pin up to its fit ceiling of 15
 * (`FIT_MAX_ZOOM` in the engine); a map with a centre and no `fit` uses `MAP_DEFAULT_ZOOM`.
 */
const FITTED_PIN_ZOOM = 15;
const lonePinZoom = (spec: MapSpec): number => (spec.fit ? FITTED_PIN_ZOOM : MAP_DEFAULT_ZOOM);

const embedAddress = (mode: 'place' | 'view', params: Readonly<Record<string, string>>): string => {
  const query = new URLSearchParams(params);
  return `${GOOGLE_EMBED_ORIGIN}${GOOGLE_EMBED_PATH}${mode}?${query.toString()}`;
};

/**
 * Decides how one map is drawn. Total: every input yields a drawing, and the fallback is always the
 * default style, so a missing key, an unsupported browser or a map Google cannot draw never fails a block.
 */
export const chooseMapDrawing = (
  spec: MapSpec,
  choice: { readonly style: MapStyle; readonly key: string | null; readonly environment: MapEnvironment },
): MapDrawing => {
  const { style, key, environment } = choice;
  // The default style, or no key to draw the other with: nothing to say, because nothing was lost.
  if (style !== 'google' || key === null) return OSM;
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
