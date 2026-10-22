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
 */

import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from '../features/browser/external-link.tsx';
import type { MapSpec, readMap as ReadMap } from '../lib/fy-render-map.ts';
import { MAP_ATTRIBUTION } from '../lib/fy-render-map-tiles.ts';
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
  | { readonly kind: 'drawn' }
  | { readonly kind: 'listing'; readonly note: string; readonly lines: readonly string[] };

export interface FyRenderMapProps {
  readonly alt: string;
  readonly payload: string;
  readonly mode: 'light' | 'dark';
  readonly fullscreen: boolean;
  /** Told when the block is showing the coordinate list rather than a map, so it can drop what a list cannot use. */
  readonly onListing: (listing: boolean) => void;
  readonly load?: () => Promise<FyRenderMapModules>;
}

export function FyRenderMap({ alt, payload, mode, fullscreen, onListing, load = loadModules }: FyRenderMapProps) {
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
        mounted = modules.mountMap(host, reading.spec);
        handle.current = mounted;
        setState({ kind: 'drawn' });
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
  }, [payload, load]);

  useEffect(() => {
    onListing(state.kind === 'listing');
  }, [state.kind, onListing]);
  useEffect(() => {
    if (state.kind === 'drawn') handle.current?.roomy(fullscreen);
  }, [fullscreen, state.kind]);

  if (state.kind === 'listing')
    return (
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
    );

  return (
    <div className="fy-render-map" data-fy-render-map={state.kind} data-fy-render-map-mode={mode}>
      <section aria-label={`Map: ${alt}`} className="fy-render-map-canvas" ref={hostRef} />
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
    </div>
  );
}
