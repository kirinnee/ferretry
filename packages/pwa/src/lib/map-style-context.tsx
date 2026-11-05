/**
 * The reader's map style, and the key that makes Google possible, offered to every `map` block under it.
 *
 * A block is rendered deep inside Markdown, far from the controls store, so the choice travels the way
 * "Open links in" does (`features/browser/link-behaviour.tsx`): one provider near the root, one hook at the
 * block. With no provider — every test that does not care, and any surface that does not bind one — the
 * default is OpenStreetMap and no key, which is what a build without the Ferretry key does anyway.
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { DEFAULT_MAP_STYLE, type MapStyle } from './map-style.ts';

export interface MapStyleChoice {
  readonly style: MapStyle;
  /** The build's Google Maps Embed key, or null: with none there is no Google option at all. */
  readonly key: string | null;
}

const NONE: MapStyleChoice = { key: null, style: DEFAULT_MAP_STYLE };

const MapStyleContext = createContext<MapStyleChoice>(NONE);

export function MapStyleProvider({
  style,
  embedKey,
  children,
}: {
  readonly style: MapStyle;
  readonly embedKey: string | null;
  readonly children: ReactNode;
}) {
  const value = useMemo<MapStyleChoice>(() => ({ key: embedKey, style }), [embedKey, style]);
  return <MapStyleContext.Provider value={value}>{children}</MapStyleContext.Provider>;
}

export const useMapStyle = (): MapStyleChoice => useContext(MapStyleContext);
