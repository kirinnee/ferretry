/**
 * The `type: map` payload, read: JSON or YAML in, a bounded drawing plan out.
 *
 * THE PAYLOAD IS DATA, NEVER MARKUP. Everything an author writes — a label, a popup, a colour — leaves this
 * module as a plain string or number that the engine places with `textContent` and `setAttribute`; no
 * string here ever reaches `innerHTML`, which Trusted Types would refuse anyway. A colour is therefore a
 * name from a short palette or a `#hex` literal, resolved here, so a style value is never an author's text.
 *
 * ONE READER, NEVER A THROW. {@link readMap} returns `{ ok: false }` with a reason and a best-effort
 * coordinate listing for anything it cannot draw — malformed YAML, a coordinate outside the globe, more
 * pins than the cap — because the owner's rule is that a map which cannot be drawn is still readable. The
 * same listing is what the reader sees if the map engine itself cannot start.
 *
 * It parses with `yaml` (JSON is a YAML subset) with aliases refused outright, so no document can expand
 * into more than its bytes say; the byte cap is the grammar's (`FY_RENDER_LIMITS.mapBytes`).
 */

import { parse } from 'yaml';
import { FY_RENDER_LIMITS } from './fy-render-bounds.ts';

export interface MapPoint {
  readonly lat: number;
  readonly lng: number;
}

/** A colour an author may ask for: a palette name or a hex literal, already resolved to `#rrggbb`. */
export type MapColor = string | null;

interface MapMarker extends MapPoint {
  readonly label: string | null;
  readonly popup: string | null;
  readonly color: MapColor;
}

interface MapShape {
  readonly points: readonly MapPoint[];
  readonly label: string | null;
  readonly color: MapColor;
}

export interface MapSpec {
  readonly center: MapPoint | null;
  readonly zoom: number | null;
  /** Whether the view is fitted to everything drawn: explicit, or implied by having no centre. */
  readonly fit: boolean;
  readonly markers: readonly MapMarker[];
  readonly lines: readonly MapShape[];
  readonly polygons: readonly MapShape[];
}

export type MapReading =
  | { readonly ok: true; readonly spec: MapSpec; readonly listing: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly listing: readonly string[] };

/** The closest zoom the engine may be asked for: street level, and no deeper than the tile policy wants. */
export const MAP_MAX_ZOOM = 18;
export const MAP_DEFAULT_ZOOM = 13;
/** The most listing lines a fallback prints. */
export const MAP_LISTING_LINES = 200;

const PALETTE: Readonly<Record<string, string>> = {
  amber: '#d97706', // theme-literal-ok: a colour the author names is data and must not follow the theme
  blue: '#2563eb', // theme-literal-ok: a colour the author names is data and must not follow the theme
  green: '#16a34a', // theme-literal-ok: a colour the author names is data and must not follow the theme
  purple: '#7c3aed', // theme-literal-ok: a colour the author names is data and must not follow the theme
  red: '#dc2626', // theme-literal-ok: a colour the author names is data and must not follow the theme
};
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

type Entry = Readonly<Record<string, unknown>>;
const isEntry = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const colorOf = (value: unknown): MapColor => {
  if (typeof value !== 'string') return null;
  const named = PALETTE[value.toLowerCase()];
  if (named !== undefined) return named;
  if (!HEX_COLOR.test(value)) return null;
  const hex = value.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex}`;
};

const cut = (value: string, limit: number): string => {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join('')}…`;
};

const textOf = (value: unknown, limit: number): string | null => {
  const text = typeof value === 'string' ? value : isNumber(value) ? String(value) : '';
  return text.trim() === '' ? null : cut(text.trim(), limit);
};

const validPoint = (lat: unknown, lng: unknown): MapPoint | null =>
  isNumber(lat) && isNumber(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;

/**
 * A point in any of the three spellings an author reaches for: `[lat, lng]`, `{lat, lng}` (`lon` also
 * accepted) or — inside GeoJSON, where the standard order is longitude first — `[lng, lat]`.
 */
const readPoint = (value: unknown, geojson: boolean): MapPoint | null => {
  if (Array.isArray(value)) return geojson ? validPoint(value[1], value[0]) : validPoint(value[0], value[1]);
  if (!isEntry(value)) return null;
  return validPoint(value.lat, value.lng ?? value.lon);
};

const pointText = (point: MapPoint): string => `${round(point.lat)}, ${round(point.lng)}`;
const round = (value: number): number => Math.round(value * 100_000) / 100_000;

/** Every point of a list, or the first one that is not a point. */
const readPoints = (value: unknown, geojson: boolean): readonly MapPoint[] | null => {
  if (!Array.isArray(value)) return null;
  const points: MapPoint[] = [];
  for (const entry of value) {
    const point = readPoint(entry, geojson);
    if (point === null) return null;
    points.push(point);
  }
  return points;
};

class Refusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Refusal';
  }
}
function refuse(reason: string): never {
  throw new Refusal(reason);
}

/** The shared collector: it counts against the caps as things are added, so a payload fails early. */
interface Plan {
  readonly markers: MapMarker[];
  readonly lines: MapShape[];
  readonly polygons: MapShape[];
  marker(entry: MapMarker): void;
  shape(into: 'lines' | 'polygons', entry: MapShape): void;
}

const newPlan = (): Plan => {
  const markers: MapMarker[] = [];
  const lines: MapShape[] = [];
  const polygons: MapShape[] = [];
  const into = { lines, polygons };
  let vertices = 0;
  return {
    lines,
    marker: entry => {
      if (markers.length >= FY_RENDER_LIMITS.mapMarkers)
        refuse(`A map shows at most ${FY_RENDER_LIMITS.mapMarkers} markers`);
      markers.push(entry);
    },
    markers,
    polygons,
    shape: (kind, entry) => {
      if (lines.length + polygons.length >= FY_RENDER_LIMITS.mapShapes)
        refuse(`A map shows at most ${FY_RENDER_LIMITS.mapShapes} lines and polygons`);
      vertices += entry.points.length;
      if (vertices > FY_RENDER_LIMITS.mapVertices)
        refuse(`A map draws at most ${FY_RENDER_LIMITS.mapVertices} points in its lines and polygons`);
      into[kind].push(entry);
    },
  };
};

const readMarker = (entry: unknown, index: number): MapMarker => {
  const where = `markers[${index}]`;
  if (!isEntry(entry)) return refuse(`${where} must be an object with a position`);
  const point = readPoint(entry.at, false) ?? readPoint(entry, false);
  if (point === null) return refuse(`${where} needs a position: at: [lat, lng], or lat and lng`);
  return {
    ...point,
    color: colorOf(entry.color),
    label: textOf(entry.label, FY_RENDER_LIMITS.mapLabelCharacters),
    popup: textOf(entry.popup, FY_RENDER_LIMITS.mapPopupCharacters),
  };
};

const readShape = (entry: unknown, where: string, minimum: number): MapShape => {
  const bare = Array.isArray(entry);
  if (!bare && !isEntry(entry)) return refuse(`${where} must be a list of points or an object with points`);
  const raw = bare ? entry : (entry as Entry).points;
  const points = readPoints(raw, false);
  if (points === null) return refuse(`${where} points must each be [lat, lng] or {lat, lng} on the globe`);
  if (points.length < minimum) return refuse(`${where} needs at least ${minimum} points`);
  const object: Entry = bare ? {} : (entry as Entry);
  return { color: colorOf(object.color), label: textOf(object.label, FY_RENDER_LIMITS.mapLabelCharacters), points };
};

const list = (value: unknown, key: string): readonly unknown[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : refuse(`${key} must be a list`);
};

/** The properties a GeoJSON feature may label itself with, in the order they are tried. */
const geoLabel = (properties: unknown): { label: string | null; popup: string | null } => {
  const bag: Entry = isEntry(properties) ? properties : {};
  return {
    label: textOf(bag.name ?? bag.title ?? bag.label, FY_RENDER_LIMITS.mapLabelCharacters),
    popup: textOf(bag.description ?? bag.popup, FY_RENDER_LIMITS.mapPopupCharacters),
  };
};

const addGeometry = (plan: Plan, geometry: unknown, properties: unknown, depth: number): void => {
  if (!isEntry(geometry) || depth > 4) refuse('geojson contains a geometry that is not an object');
  const { label, popup } = geoLabel(properties);
  const { type, coordinates } = geometry;
  const ring = (value: unknown): readonly MapPoint[] =>
    readPoints(value, true) ?? refuse('geojson coordinates must be [longitude, latitude] on the globe');
  const color = colorOf(isEntry(properties) ? properties.color : undefined);
  if (type === 'Point') {
    const point = readPoint(coordinates, true) ?? refuse('geojson Point needs [longitude, latitude]');
    plan.marker({ ...point, color, label, popup });
  } else if (type === 'MultiPoint') {
    for (const entry of list(coordinates, 'coordinates')) {
      const point = readPoint(entry, true) ?? refuse('geojson MultiPoint needs [longitude, latitude] entries');
      plan.marker({ ...point, color, label, popup });
    }
  } else if (type === 'LineString') plan.shape('lines', { color, label, points: ring(coordinates) });
  else if (type === 'MultiLineString')
    for (const entry of list(coordinates, 'coordinates')) plan.shape('lines', { color, label, points: ring(entry) });
  else if (type === 'Polygon') {
    // Only the outer ring: a hole is detail a hand-written map seldom wants, and drawing it needs a fill rule.
    const outer = list(coordinates, 'coordinates')[0];
    plan.shape('polygons', { color, label, points: ring(outer) });
  } else if (type === 'MultiPolygon') {
    for (const polygon of list(coordinates, 'coordinates'))
      plan.shape('polygons', { color, label, points: ring(list(polygon, 'coordinates')[0]) });
  } else if (type === 'GeometryCollection') {
    for (const member of list(geometry.geometries, 'geometries')) addGeometry(plan, member, properties, depth + 1);
  } else
    refuse('geojson geometry type is not one of Point, LineString, Polygon, their Multi forms or GeometryCollection');
};

const addGeoJson = (plan: Plan, value: unknown): void => {
  if (!isEntry(value)) refuse('geojson must be an object');
  if (value.type === 'FeatureCollection') {
    for (const feature of list(value.features, 'features')) addGeoJson(plan, feature);
  } else if (value.type === 'Feature') addGeometry(plan, value.geometry, value.properties, 0);
  else addGeometry(plan, value, undefined, 0);
};

const closeTo = (value: unknown, key: string, low: number, high: number): number | null => {
  if (value === undefined) return null;
  return isNumber(value) && value >= low && value <= high
    ? value
    : refuse(`${key} must be a number from ${low} to ${high}`);
};

const draw = (document: Entry): MapSpec => {
  const plan = newPlan();
  const centre = document.center === undefined ? null : readPoint(document.center, false);
  if (document.center !== undefined && centre === null) refuse('center must be [lat, lng] or {lat, lng} on the globe');
  const zoom = closeTo(document.zoom, 'zoom', 0, MAP_MAX_ZOOM);
  if (document.fit !== undefined && typeof document.fit !== 'boolean') refuse('fit must be true or false');
  for (const [index, entry] of list(document.markers, 'markers').entries()) plan.marker(readMarker(entry, index));
  const lines = list(document.lines ?? document.routes ?? document.polylines, 'lines');
  for (const [index, entry] of lines.entries()) plan.shape('lines', readShape(entry, `lines[${index}]`, 2));
  for (const [index, entry] of list(document.polygons, 'polygons').entries())
    plan.shape('polygons', readShape(entry, `polygons[${index}]`, 3));
  if (document.geojson !== undefined) addGeoJson(plan, document.geojson);
  const drawn = plan.markers.length + plan.lines.length + plan.polygons.length;
  if (centre === null && drawn === 0)
    refuse('A map needs a center, or something to draw (markers, lines, polygons, geojson)');
  return {
    center: centre,
    fit: document.fit === true || (centre === null && document.fit !== false),
    lines: plan.lines,
    markers: plan.markers,
    polygons: plan.polygons,
    zoom,
  };
};

const named = (label: string | null, fallback: string): string => (label === null ? fallback : label);

/** The map as text, one coordinate per line: what the reader gets when it cannot be drawn. */
export function mapListing(spec: MapSpec): readonly string[] {
  const out: string[] = [];
  if (spec.center !== null) out.push(`Center: ${pointText(spec.center)}`);
  for (const marker of spec.markers) out.push(`${named(marker.label, 'Marker')}: ${pointText(marker)}`);
  for (const [index, line] of spec.lines.entries())
    out.push(`${named(line.label, `Line ${index + 1}`)}: ${line.points.map(pointText).join(' → ')}`);
  for (const [index, polygon] of spec.polygons.entries())
    out.push(`${named(polygon.label, `Area ${index + 1}`)}: ${polygon.points.map(pointText).join(' → ')}`);
  return out.slice(0, MAP_LISTING_LINES);
}

/**
 * EVERYTHING THAT LOOKS LIKE A COORDINATE, from a document that did not pass: any `[a, b]` pair of numbers
 * on the globe or `{lat, lng}` object, found by walking whatever parsed. Under a `geojson` or `coordinates`
 * key the order is longitude first. Bounded in lines and in how deep it looks, so a hostile document costs
 * a constant.
 */
function scavenge(root: unknown): readonly string[] {
  const out: string[] = [];
  const walk = (value: unknown, geojson: boolean, depth: number): void => {
    if (out.length >= MAP_LISTING_LINES || depth > 12) return;
    const point = readPoint(value, geojson);
    if (point !== null) {
      const label = isEntry(value) ? textOf(value.label ?? value.name, FY_RENDER_LIMITS.mapLabelCharacters) : null;
      out.push(`${named(label, 'Point')}: ${pointText(point)}`);
      return;
    }
    const children = Array.isArray(value) ? value : isEntry(value) ? Object.entries(value) : [];
    for (const child of children) {
      if (Array.isArray(value)) walk(child, geojson, depth + 1);
      else {
        const [key, inner] = child as [string, unknown];
        walk(inner, geojson || key === 'geojson' || key === 'coordinates', depth + 1);
      }
    }
  };
  walk(root, false, 0);
  return out;
}

const parseDocument = (payload: string): unknown => parse(payload, { maxAliasCount: 0 });

export function readMap(payload: string): MapReading {
  let document: unknown;
  try {
    document = parseDocument(payload);
  } catch {
    return { listing: [], ok: false, reason: 'The map description is not valid JSON or YAML' };
  }
  if (!isEntry(document))
    return { listing: scavenge(document), ok: false, reason: 'A map description must be an object' };
  try {
    const spec = draw(document);
    return { listing: mapListing(spec), ok: true, spec };
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : 'The map description could not be drawn';
    return { listing: scavenge(document), ok: false, reason };
  }
}
