import { describe, test } from 'bun:test';
import should from 'should';
import { FY_RENDER_LIMITS } from '../../src/lib/fy-render-bounds.ts';
import { MAP_LISTING_LINES, type MapSpec, mapListing, readMap } from '../../src/lib/fy-render-map.ts';
import { MAP_ATTRIBUTION, MAP_TILE_ORIGIN, MAP_TILE_URL } from '../../src/lib/fy-render-map-tiles.ts';

/**
 * The map reader, read as a reader: bytes in, a bounded drawing plan or a refusal with a coordinate
 * listing out. Nothing here draws; the engine and component tiers do that.
 */

const spec = (payload: string): MapSpec => {
  const reading = readMap(payload);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.spec;
};

const refusal = (payload: string): { reason: string; listing: readonly string[] } => {
  const reading = readMap(payload);
  if (reading.ok) throw new Error('expected a refusal');
  return { listing: reading.listing, reason: reading.reason };
};

const reasonOf = (payload: string): string => refusal(payload).reason;

describe('fy-render map reader — accepted shapes', () => {
  test('should read a centre and zoom from JSON', () => {
    should(spec('{"center":[51.5,-0.12],"zoom":11}')).eql({
      center: { lat: 51.5, lng: -0.12 },
      fit: false,
      lines: [],
      markers: [],
      polygons: [],
      zoom: 11,
    });
  });

  test('should read the same map from YAML with object centres and `lon`', () => {
    const read = spec('center: {lat: 1, lon: 2}\nzoom: 4.5');
    should(read.center).eql({ lat: 1, lng: 2 });
    should(read.zoom).equal(4.5);
  });

  test('should read markers in every spelling with label, popup and colour', () => {
    const read = spec(
      [
        'markers:',
        '  - {at: [1, 2], label: One, popup: First, color: red}',
        '  - {lat: 3, lng: 4, color: "#ABC"}',
        '  - {at: {lat: 5, lng: 6}, label: 7, color: "#112233"}',
        '  - {at: [8, 9], color: nonsense}',
        '  - {at: [8, 9], color: 5, label: "  "}',
      ].join('\n'),
    );
    should(read.markers).eql([
      { color: '#dc2626', label: 'One', lat: 1, lng: 2, popup: 'First' },
      { color: '#aabbcc', label: null, lat: 3, lng: 4, popup: null },
      { color: '#112233', label: '7', lat: 5, lng: 6, popup: null },
      { color: null, label: null, lat: 8, lng: 9, popup: null },
      { color: null, label: null, lat: 8, lng: 9, popup: null },
    ]);
    should(read.fit).be.true();
  });

  test('should cut a long label and popup to their caps', () => {
    const read = spec(
      `markers: [{at: [1, 2], label: "${'l'.repeat(200)}", popup: "${'p'.repeat(900)}"}]\ncenter: [1, 2]`,
    );
    const marker = read.markers[0];
    should([...(marker?.label ?? '')].length).equal(FY_RENDER_LIMITS.mapLabelCharacters);
    should([...(marker?.popup ?? '')].length).equal(FY_RENDER_LIMITS.mapPopupCharacters);
    should(marker?.label?.endsWith('…')).be.true();
  });

  test('should read lines under any of their three names and polygons', () => {
    const read = spec(
      [
        'lines:',
        '  - [[1, 2], [3, 4]]',
        '  - {label: Route, color: blue, points: [[5, 6], {lat: 7, lng: 8}]}',
        'routes:',
        '  - [[0, 0], [1, 1]]',
        'polygons:',
        '  - {label: Park, points: [[0, 0], [0, 1], [1, 1]]}',
      ].join('\n'),
    );
    // `lines` wins over `routes` when both are written.
    should(read.lines.map(line => line.label)).eql([null, 'Route']);
    should(read.lines[1]?.color).equal('#2563eb');
    should(read.polygons[0]?.label).equal('Park');
    should(spec('routes: [[[0, 0], [1, 1]]]').lines).have.length(1);
    should(spec('polylines: [[[0, 0], [1, 1]]]').lines).have.length(1);
  });

  test('should honour fit: true with a centre and fit: false without one', () => {
    should(spec('center: [1, 2]\nfit: true\nmarkers: [[1, 2]]'.replace('[[1, 2]]', '[{at: [1, 2]}]')).fit).be.true();
    should(spec('fit: false\nmarkers: [{at: [1, 2]}]').fit).be.false();
  });

  test('should accept an empty-list centre-only map as drawable', () => {
    should(spec('center: [0, 0]\nmarkers: []').markers).eql([]);
  });
});

describe('fy-render map reader — GeoJSON', () => {
  const geo = (value: unknown): MapSpec => spec(JSON.stringify({ geojson: value }));

  test('should read a FeatureCollection of every geometry with longitude first', () => {
    const read = geo({
      features: [
        {
          geometry: { coordinates: [2, 1], type: 'Point' },
          properties: { color: 'green', name: 'Pt', popup: 'Hi' },
          type: 'Feature',
        },
        {
          geometry: {
            coordinates: [
              [4, 3],
              [6, 5],
            ],
            type: 'MultiPoint',
          },
          properties: { title: 'Multi' },
          type: 'Feature',
        },
        {
          geometry: {
            coordinates: [
              [1, 2],
              [3, 4],
            ],
            type: 'LineString',
          },
          properties: { label: 'Line' },
          type: 'Feature',
        },
        {
          geometry: {
            coordinates: [
              [
                [1, 2],
                [3, 4],
              ],
              [
                [5, 6],
                [7, 8],
              ],
            ],
            type: 'MultiLineString',
          },
          type: 'Feature',
        },
        {
          geometry: {
            coordinates: [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
              [
                [0, 0],
                [0, 0.1],
                [0.1, 0.1],
              ],
            ],
            type: 'Polygon',
          },
          properties: { description: 'Area' },
          type: 'Feature',
        },
        {
          geometry: {
            coordinates: [
              [
                [
                  [0, 0],
                  [0, 1],
                  [1, 1],
                  [0, 0],
                ],
              ],
              [
                [
                  [2, 2],
                  [2, 3],
                  [3, 3],
                  [2, 2],
                ],
              ],
            ],
            type: 'MultiPolygon',
          },
          type: 'Feature',
        },
      ],
      type: 'FeatureCollection',
    });
    should(read.markers.map(marker => [marker.lat, marker.lng, marker.label, marker.popup, marker.color])).eql([
      [1, 2, 'Pt', 'Hi', '#16a34a'],
      [3, 4, 'Multi', null, null],
      [5, 6, 'Multi', null, null],
    ]);
    should(read.lines).have.length(3);
    should(read.lines[0]?.points[0]).eql({ lat: 2, lng: 1 });
    // Only the outer ring of a polygon is drawn.
    should(read.polygons.map(polygon => polygon.points.length)).eql([4, 4, 4]);
  });

  test('should read a bare Feature, a bare geometry and a GeometryCollection', () => {
    should(geo({ geometry: { coordinates: [2, 1], type: 'Point' }, type: 'Feature' }).markers).have.length(1);
    should(geo({ coordinates: [2, 1], type: 'Point' }).markers).have.length(1);
    const collection = geo({
      geometries: [
        { coordinates: [2, 1], type: 'Point' },
        {
          coordinates: [
            [1, 2],
            [3, 4],
          ],
          type: 'LineString',
        },
      ],
      type: 'GeometryCollection',
    });
    should([collection.markers.length, collection.lines.length]).eql([1, 1]);
  });

  test('should refuse every malformed GeoJSON shape with its own reason', () => {
    const reason = (value: unknown): string => reasonOf(JSON.stringify({ geojson: value }));
    should(reason('text')).equal('geojson must be an object');
    should(reason({ features: 5, type: 'FeatureCollection' })).equal('features must be a list');
    should(reason({ geometry: 'x', type: 'Feature' })).equal('geojson contains a geometry that is not an object');
    should(reason({ coordinates: [999, 999], type: 'Point' })).equal('geojson Point needs [longitude, latitude]');
    should(reason({ coordinates: [1, 2, 3].slice(0, 1), type: 'MultiPoint' })).equal(
      'geojson MultiPoint needs [longitude, latitude] entries',
    );
    should(reason({ coordinates: [[999, 999]], type: 'MultiPoint' })).equal(
      'geojson MultiPoint needs [longitude, latitude] entries',
    );
    should(reason({ coordinates: 'x', type: 'LineString' })).equal(
      'geojson coordinates must be [longitude, latitude] on the globe',
    );
    should(reason({ coordinates: 'x', type: 'MultiLineString' })).equal('coordinates must be a list');
    should(reason({ coordinates: 'x', type: 'Polygon' })).equal('coordinates must be a list');
    should(reason({ coordinates: 'x', type: 'MultiPolygon' })).equal('coordinates must be a list');
    should(reason({ coordinates: ['x'], type: 'MultiPolygon' })).equal('coordinates must be a list');
    should(reason({ geometries: 'x', type: 'GeometryCollection' })).equal('geometries must be a list');
    should(reason({ coordinates: [], type: 'Circle' })).equal(
      'geojson geometry type is not one of Point, LineString, Polygon, their Multi forms or GeometryCollection',
    );
  });

  test('should refuse a GeometryCollection nested deeper than the walk allows', () => {
    let nested: unknown = { coordinates: [1, 2], type: 'Point' };
    for (let level = 0; level < 6; level += 1) nested = { geometries: [nested], type: 'GeometryCollection' };
    should(reasonOf(JSON.stringify({ geojson: nested }))).equal('geojson contains a geometry that is not an object');
  });
});

describe('fy-render map reader — refusals', () => {
  test('should refuse text that is neither JSON nor YAML, with nothing to list', () => {
    should(refusal('a: [1, 2')).eql({ listing: [], reason: 'The map description is not valid JSON or YAML' });
  });

  test('should refuse aliases outright', () => {
    should(reasonOf('a: &x [1, 2]\nb: *x')).equal('The map description is not valid JSON or YAML');
  });

  test('should refuse a document that is not an object and still scavenge its coordinates', () => {
    const { reason, listing } = refusal('- [51.5, -0.12]\n- {lat: 1, lng: 2, name: Home}\n- nothing');
    should(reason).equal('A map description must be an object');
    should(listing).eql(['Point: 51.5, -0.12', 'Home: 1, 2']);
  });

  test('should refuse each wrong field with a reason naming it', () => {
    should(reasonOf('center: 5')).equal('center must be [lat, lng] or {lat, lng} on the globe');
    should(reasonOf('center: [1, 2]\nzoom: 40')).equal('zoom must be a number from 0 to 18');
    should(reasonOf('center: [1, 2]\nzoom: far')).equal('zoom must be a number from 0 to 18');
    should(reasonOf('center: [1, 2]\nfit: maybe')).equal('fit must be true or false');
    should(reasonOf('center: [1, 2]\nmarkers: 5')).equal('markers must be a list');
    should(reasonOf('markers: [5]')).equal('markers[0] must be an object with a position');
    should(reasonOf('markers: [{label: x}]')).equal('markers[0] needs a position: at: [lat, lng], or lat and lng');
    should(reasonOf('markers: [{at: [95, 0]}]')).equal('markers[0] needs a position: at: [lat, lng], or lat and lng');
    should(reasonOf('lines: [5]')).equal('lines[0] must be a list of points or an object with points');
    should(reasonOf('lines: [[[1, 2], "x"]]')).equal(
      'lines[0] points must each be [lat, lng] or {lat, lng} on the globe',
    );
    should(reasonOf('lines: [[[1, 2]]]')).equal('lines[0] needs at least 2 points');
    should(reasonOf('polygons: [[[1, 2], [3, 4]]]')).equal('polygons[0] needs at least 3 points');
    should(reasonOf('{}')).equal('A map needs a center, or something to draw (markers, lines, polygons, geojson)');
  });

  test('should refuse more than the cap of markers, shapes and vertices', () => {
    const markers = Array.from({ length: FY_RENDER_LIMITS.mapMarkers + 1 }, () => '{at: [1, 2]}').join(',');
    should(reasonOf(`markers: [${markers}]`)).equal(`A map shows at most ${FY_RENDER_LIMITS.mapMarkers} markers`);
    const shapes = Array.from({ length: FY_RENDER_LIMITS.mapShapes + 1 }, () => '[[1, 2], [3, 4]]').join(',');
    should(reasonOf(`lines: [${shapes}]`)).equal(
      `A map shows at most ${FY_RENDER_LIMITS.mapShapes} lines and polygons`,
    );
    const points = Array.from({ length: FY_RENDER_LIMITS.mapVertices + 1 }, () => '[1, 2]').join(',');
    should(reasonOf(`lines: [[${points}]]`)).equal(
      `A map draws at most ${FY_RENDER_LIMITS.mapVertices} points in its lines and polygons`,
    );
  });

  test('should list what could be found in a refused map, bounded and shallow', () => {
    const { listing } = refusal(
      [
        'center: [1, 2]',
        'zoom: 99',
        'markers:',
        '  - {at: [3, 4], label: Cafe}',
        'geojson: {type: LineString, coordinates: [[10, 20], [30, 40]]}',
      ].join('\n'),
    );
    // `at` is a pair read lat-first; under `geojson` the pairs are read longitude-first.
    should(listing).eql(['Point: 1, 2', 'Point: 3, 4', 'Point: 20, 10', 'Point: 40, 30']);
  });

  test('should stop listing at the line cap and at the depth limit', () => {
    const many = Array.from({ length: MAP_LISTING_LINES + 20 }, () => '[1, 2]').join(',');
    should(refusal(`zoom: 99\npoints: [${many}]`).listing).have.length(MAP_LISTING_LINES);
    let deep = '[1, 2]';
    for (let level = 0; level < 15; level += 1) deep = `[${deep}]`;
    should(refusal(`zoom: 99\ndeep: ${deep}`).listing).eql([]);
  });
});

describe('fy-render map listing', () => {
  test('should print the centre, markers, lines and areas, naming the unnamed', () => {
    const lines = mapListing(
      spec(
        [
          'center: [1.123456789, 2]',
          'markers: [{at: [3, 4], label: Cafe}, {at: [5, 6]}]',
          'lines: [[[1, 2], [3, 4]], {label: Route, points: [[1, 1], [2, 2]]}]',
          'polygons: [[[0, 0], [0, 1], [1, 1]]]',
        ].join('\n'),
      ),
    );
    should(lines).eql([
      'Center: 1.12346, 2',
      'Cafe: 3, 4',
      'Marker: 5, 6',
      'Line 1: 1, 2 → 3, 4',
      'Route: 1, 1 → 2, 2',
      'Area 1: 0, 0 → 0, 1 → 1, 1',
    ]);
  });

  test('should carry the same listing on an accepted reading', () => {
    const reading = readMap('center: [1, 2]');
    should(reading.ok && reading.listing).eql(['Center: 1, 2']);
  });
});

describe('fy-render map tiles', () => {
  test('should name one HTTPS tile host and a licence-required attribution', () => {
    should(MAP_TILE_ORIGIN).equal('https://tile.openstreetmap.org');
    should(MAP_TILE_URL.startsWith(`${MAP_TILE_ORIGIN}/`)).be.true();
    should(MAP_ATTRIBUTION.text).containEql('OpenStreetMap');
    should(MAP_ATTRIBUTION.href.startsWith('https://www.openstreetmap.org/')).be.true();
  });
});
