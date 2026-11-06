/**
 * The `type: map` renderer: an interactive map drawn in the page itself.
 *
 * NO FRAME, NO AUTHOR CODE. A map's payload is JSON or YAML — data. It is read by `fy-render-map.ts`,
 * drawn by Leaflet from DOM nodes the engine creates, and never reaches a markup sink
 * (`fy-render-map-engine.ts` says how Trusted Types is kept satisfied). The only network it opens is the
 * tile host the PWA's `img-src` names, which is why it needs no sandbox of its own.
 *
 * LAZY, TWICE. The block mounts it when it is near the screen, and this component fetches the engine and
 * the reader as one chunk only then (`load`, injectable so the test tier needs no bundler).
 *
 * A MAP THAT CANNOT BE DRAWN IS STILL READABLE. A payload the reader refuses, or an engine that will not
 * load, shows the coordinates it could find as a plain list under one muted line saying why — never a
 * blank rectangle.
 *
 * THE CONTROLS ARE THIS COMPONENT'S, not Leaflet's: zoom buttons that are real buttons, and the
 * attribution OpenStreetMap's licence requires, always visible. On a phone an inline map leaves the one
 * finger to the page's scroll; fullscreen gives the map the whole plane.
 *
 * GOOGLE IS AN OPT-IN SECOND STYLE (`lib/map-style.ts` decides, this file draws). When the reader chose
 * Google Maps and this build carries the Ferretry key, a map Google's Embed API can draw (one marker, or a
 * plain view) is a framed embed instead of Leaflet — no engine mounted, no tile request. Anything it cannot
 * draw stays on OpenStreetMap with one muted line saying why. The frame is the ONE third-party frame the
 * page allows (`frame-src` in `public/_headers`), and it is built to give Google as little as it can:
 * `credentialless` (no cookies, and the only kind of Google frame cross-origin isolation admits), an
 * origin-only Referer (the key is restricted by it; the page itself sends none) and a sandbox.
 */

import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from '../features/browser/external-link.tsx';
import type { MapSpec, readMap as ReadMap } from '../lib/fy-render-map.ts';
import { MAP_ATTRIBUTION } from '../lib/fy-render-map-tiles.ts';
import { chooseMapDrawing, type MapEnvironment, readMapEnvironment } from '../lib/map-style.ts';
import { useMapStyle } from '../lib/map-style-context.tsx';
import type { MapHandle } from './fy-render-map-engine.ts';

export interface FyRenderMapModules {
  readonly readMap: typeof ReadMap;
  readonly mountMap: (host: HTMLElement, spec: MapSpec) => MapHandle;
}

const loadModules = async (): Promise<FyRenderMapModules> => {
  const [lib, engine] = await Promise.all([import('../lib/fy-render-map.ts'), import('./fy-render-map-engine.ts')]);
  return { mountMap: engine.mountMap, readMap: lib.readMap };
};

type MapState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'drawn'; readonly note: string | null }
  | { readonly kind: 'google'; readonly src: string; readonly credentialless: boolean; readonly caption: string | null }
  | { readonly kind: 'listing'; readonly note: string; readonly lines: readonly string[] };

export interface FyRenderMapProps {
  readonly alt: string;
  readonly payload: string;
  readonly mode: 'light' | 'dark';
  readonly fullscreen: boolean;
  /** Told when the block is showing the coordinate list rather than a map, so it can drop what a list cannot use. */
  readonly onListing: (listing: boolean) => void;
  readonly load?: () => Promise<FyRenderMapModules>;
  /** What this browser can do with a Google frame; read from the window unless a test says otherwise. */
  readonly environment?: MapEnvironment;
}

export function FyRenderMap({
  alt,
  payload,
  mode,
  fullscreen,
  onListing,
  load = loadModules,
  environment,
}: FyRenderMapProps) {
  const { style, key } = useMapStyle();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handle = useRef<MapHandle | null>(null);
  const [state, setState] = useState<MapState>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    let mounted: MapHandle | null = null;
    setState({ kind: 'loading' });
    load().then(
      modules => {
        const host = hostRef.current;
        if (!live || host === null) return;
        const reading = modules.readMap(payload);
        if (!reading.ok) {
          setState({ kind: 'listing', lines: reading.listing, note: reading.reason });
          return;
        }
        const drawing = chooseMapDrawing(reading.spec, {
          environment: environment ?? readMapEnvironment(),
          key,
          style,
        });
        if (drawing.via === 'google') {
          setState({
            caption: drawing.caption,
            credentialless: drawing.credentialless,
            kind: 'google',
            src: drawing.src,
          });
          return;
        }
        mounted = modules.mountMap(host, reading.spec);
        handle.current = mounted;
        setState({ kind: 'drawn', note: drawing.note });
      },
      () => {
        if (live) setState({ kind: 'listing', lines: [], note: 'The map could not be loaded' });
      },
    );
    return () => {
      live = false;
      mounted?.destroy();
      handle.current = null;
    };
  }, [payload, load, style, key, environment]);

  useEffect(() => {
    onListing(state.kind === 'listing');
  }, [state.kind, onListing]);
  useEffect(() => {
    if (state.kind === 'drawn') handle.current?.roomy(fullscreen);
  }, [fullscreen, state.kind]);

  // ONE STABLE TREE. The map's host (`<section ref>`) is rendered in every state — hidden when the block shows
  // a Google frame or a listing — and sits at the same position in the same parent each time, so React never
  // unmounts it. The load effect reads `hostRef` when its promise resolves, which can be before the render
  // that follows `setState(loading)` has committed; a host that only existed in some states would be null
  // then (a blank map forever, or a Google → OpenStreetMap switch that never drew).
  const showsMap = state.kind === 'loading' || state.kind === 'drawn';
  return (
    <div className="fy-render-map-block">
      {state.kind === 'listing' ? (
        <div className="fy-render-map-listing" data-fy-render-map="listing">
          <p className="fy-render-stopped">{state.note}.</p>
          {state.lines.length === 0 ? null : (
            <ul aria-label={`Coordinates: ${alt}`}>
              {state.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a static, ordered, never-reordered list
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div
        className="fy-render-map"
        data-fy-render-map={state.kind === 'listing' ? undefined : state.kind}
        data-fy-render-map-mode={mode}
        hidden={state.kind === 'listing'}
        // Inline, because the fullscreen rule gives `.fy-render-map` a `display` that would beat `hidden`.
        style={state.kind === 'listing' ? { display: 'none' } : undefined}
      >
        <section aria-label={`Map: ${alt}`} className="fy-render-map-canvas" hidden={!showsMap} ref={hostRef} />
        {state.kind === 'google' ? (
          <iframe
            className="fy-render-map-canvas fy-render-map-frame"
            // The Embed key is restricted by Referer and the page sends none (`no-referrer`): this frame alone
            // sends the origin, no path. `credentialless` is an attribute React does not know, hence the spread.
            {...(state.credentialless ? { credentialless: '' } : {})}
            loading="lazy"
            referrerPolicy="origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            src={state.src}
            title={`Map: ${alt} (Google Maps)`}
          />
        ) : showsMap ? (
          <>
            <div className="fy-render-map-zoom">
              <button
                aria-label="Zoom in"
                className="fy-render-tool"
                disabled={state.kind !== 'drawn'}
                onClick={() => handle.current?.zoomIn()}
                type="button"
              >
                <Plus aria-hidden="true" size={14} />
              </button>
              <button
                aria-label="Zoom out"
                className="fy-render-tool"
                disabled={state.kind !== 'drawn'}
                onClick={() => handle.current?.zoomOut()}
                type="button"
              >
                <Minus aria-hidden="true" size={14} />
              </button>
            </div>
            <ExternalLink className="fy-render-map-attribution" href={MAP_ATTRIBUTION.href}>
              {MAP_ATTRIBUTION.text}
            </ExternalLink>
          </>
        ) : null}
      </div>
      {state.kind === 'google' && state.caption !== null ? <p className="fy-render-map-note">{state.caption}</p> : null}
      {state.kind === 'drawn' && state.note !== null ? <p className="fy-render-map-note">{state.note}</p> : null}
    </div>
  );
}
