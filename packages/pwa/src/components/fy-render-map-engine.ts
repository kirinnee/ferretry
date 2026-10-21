/**
 * The map engine: Leaflet, drawing a {@link MapSpec} into one element.
 *
 * LOADED ONLY WHEN A MAP IS NEAR (`fy-render-map.tsx` imports it dynamically), so the ~150 KB library, its
 * stylesheet and the YAML reader are a chunk no transcript without a map ever downloads.
 *
 * TRUSTED TYPES SHAPES EVERYTHING HERE. The page refuses a plain string at `innerHTML`, so this file uses
 * none of Leaflet's string-markup paths: its zoom and attribution controls are off (the component draws its
 * own buttons and the attribution), popups and pins receive DOM ELEMENTS built with `textContent`, and no
 * popup gets Leaflet's close button, which is the one place the library writes markup for it. Leaflet's own
 * feature test that does (`div.innerHTML = '<svg/>'` at load) is replaced at build time by a plugin in
 * `vite.config.ts`; `build-contract.test.ts` proves the bundle carries no such write.
 *
 * THE AUTHOR'S TEXT NEVER BECOMES MARKUP. A label or popup is placed with `textContent`; a colour arrives
 * already resolved to `#rrggbb` (`fy-render-map.ts`) and reaches a pin as a CSS custom property.
 *
 * THE TILE REQUEST CARRIES AN ORIGIN REFERER. The page sends `Referrer-Policy: no-referrer`, and
 * OpenStreetMap's tile policy asks for a valid Referer; the per-image `referrerPolicy` attribute is the one
 * narrow exception, for the tile host and nothing else.
 */

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { MAP_DEFAULT_ZOOM, MAP_MAX_ZOOM, type MapColor, type MapPoint, type MapSpec } from '../lib/fy-render-map.ts';
import { MAP_ATTRIBUTION, MAP_TILE_URL } from '../lib/fy-render-map-tiles.ts';

export interface MapHandle {
  zoomIn(): void;
  zoomOut(): void;
  /** Whether the map has the whole plane: fullscreen turns on the drag and wheel an inline map leaves to the page. */
  roomy(roomy: boolean): void;
  destroy(): void;
}

const FIT_PADDING_START: L.PointTuple = [36, 44];
/** The end side is wider: a pin's label sits to the right of it. */
const FIT_PADDING_END: L.PointTuple = [112, 28];
/** A lone pin should not zoom to the rooftops when no zoom was asked for. */
const FIT_MAX_ZOOM = 15;

const element = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const latLng = (point: MapPoint): L.LatLngTuple => [point.lat, point.lng];

const pinIcon = (label: string | null, color: MapColor): L.DivIcon => {
  const wrap = element('div', 'fy-map-pin');
  if (color !== null) wrap.style.setProperty('--fy-map-pin', color);
  wrap.appendChild(element('span', 'fy-map-pin-dot'));
  if (label !== null) wrap.appendChild(element('span', 'fy-map-pin-label', label));
  // An ELEMENT, never a string: a string (even '') would be assigned to innerHTML.
  return L.divIcon({ className: 'fy-map-pin-icon', html: wrap, iconAnchor: [11, 27], iconSize: [22, 30] });
};

const popupOf = (title: string | null, body: string | null): HTMLElement | null => {
  if (title === null && body === null) return null;
  const node = element('div', 'fy-map-popup');
  if (title !== null) node.appendChild(element('strong', 'fy-map-popup-title', title));
  if (body !== null) node.appendChild(element('p', 'fy-map-popup-body', body));
  return node;
};

const shapeStyle = (color: MapColor, fill: boolean): L.PathOptions => ({
  // theme-literal-ok: the route colour when the author named none; a route keeps its colour in every theme
  color: color ?? '#2563eb',
  fillOpacity: fill ? 0.18 : 0,
  lineCap: 'round',
  lineJoin: 'round',
  opacity: 0.9,
  weight: fill ? 2 : 4,
});

export function mountMap(host: HTMLElement, spec: MapSpec): MapHandle {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const map = L.map(host, {
    attributionControl: false,
    // A phone's one finger scrolls the transcript; the map is dragged in fullscreen (`roomy`).
    dragging: !coarse,
    maxZoom: MAP_MAX_ZOOM,
    minZoom: 2,
    scrollWheelZoom: false,
    zoomControl: false,
    zoomSnap: 0.5,
  });
  L.tileLayer(MAP_TILE_URL, {
    attribution: MAP_ATTRIBUTION.text,
    keepBuffer: 1,
    maxZoom: MAP_MAX_ZOOM,
    // OSM's policy asks for a Referer, and the page's own policy sends none; this is the tile images' alone.
    referrerPolicy: 'strict-origin-when-cross-origin',
    updateWhenIdle: true,
  }).addTo(map);

  const fitted: L.LatLngTuple[] = spec.center === null ? [] : [latLng(spec.center)];
  for (const marker of spec.markers) {
    fitted.push(latLng(marker));
    const pin = L.marker(latLng(marker), {
      alt: marker.label ?? 'Marker',
      icon: pinIcon(marker.label, marker.color),
      keyboard: true,
      title: marker.label ?? '',
    }).addTo(map);
    const popup = popupOf(marker.label, marker.popup);
    if (marker.popup !== null && popup !== null)
      pin.bindPopup(popup, { closeButton: false, maxWidth: 260, offset: [0, -22] });
  }
  const shapes = [
    ...spec.lines.map(line => ({ ...line, fill: false })),
    ...spec.polygons.map(polygon => ({ ...polygon, fill: true })),
  ];
  for (const shape of shapes) {
    const points = shape.points.map(latLng);
    fitted.push(...points);
    const path = shape.fill
      ? L.polygon(points, shapeStyle(shape.color, true))
      : L.polyline(points, shapeStyle(shape.color, false));
    path.addTo(map);
    const popup = popupOf(shape.label, null);
    if (popup !== null) path.bindPopup(popup, { closeButton: false, maxWidth: 260 });
  }

  const place = (): void => {
    if (spec.fit && fitted.length > 0) {
      map.fitBounds(L.latLngBounds(fitted), {
        maxZoom: spec.zoom ?? FIT_MAX_ZOOM,
        paddingBottomRight: FIT_PADDING_END,
        paddingTopLeft: FIT_PADDING_START,
      });
    } else {
      map.setView(
        spec.center === null ? (fitted[0] as L.LatLngTuple) : latLng(spec.center),
        spec.zoom ?? MAP_DEFAULT_ZOOM,
      );
    }
  };
  place();

  let sized = host.clientWidth > 0 && host.clientHeight > 0;
  const watcher =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const nowSized = host.clientWidth > 0 && host.clientHeight > 0;
          map.invalidateSize();
          // A map first laid out at zero size was placed against nothing: place it again once it has a size.
          if (nowSized && !sized) place();
          sized = nowSized;
        });
  watcher?.observe(host);

  return {
    destroy: () => {
      watcher?.disconnect();
      map.remove();
    },
    roomy: roomy => {
      if (roomy) {
        map.dragging.enable();
        map.scrollWheelZoom.enable();
      } else {
        if (coarse) map.dragging.disable();
        map.scrollWheelZoom.disable();
      }
      map.invalidateSize();
    },
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
  };
}
