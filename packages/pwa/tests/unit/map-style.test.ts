import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { MAP_DEFAULT_ZOOM, readMap } from '../../src/lib/fy-render-map.ts';
import {
  chooseMapDrawing,
  GOOGLE_EMBED_FRAME_SOURCE,
  type MapEnvironment,
  readEmbedKey,
} from '../../src/lib/map-style.ts';

/**
 * The decision between OpenStreetMap and Google's Embed API, and the one string the page's CSP shares with it.
 * Nothing here touches a network: the fake key below is shaped like a key and is nobody's.
 */

const KEY = 'AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake00';
const PLAIN: MapEnvironment = { credentialless: false, isolated: false };
const CHROMIUM: MapEnvironment = { credentialless: true, isolated: false };
const ISOLATED_CHROMIUM: MapEnvironment = { credentialless: true, isolated: true };
const ISOLATED_SAFARI: MapEnvironment = { credentialless: false, isolated: true };

const spec = (payload: string) => {
  const reading = readMap(payload);
  if (!reading.ok) throw new Error(`fixture refused: ${reading.reason}`);
  return reading.spec;
};

const LONE_PIN = spec(
  'center: [51.5007, -0.1246]\nzoom: 12\nmarkers:\n  - {at: [51.5007, -0.1246], label: Big Ben, popup: Clock tower}',
);
const PLAIN_VIEW = spec('center: [48.8566, 2.3522]\nzoom: 10');

const google = (map: ReturnType<typeof spec>, environment: MapEnvironment = PLAIN) =>
  chooseMapDrawing(map, { environment, key: KEY, style: 'google' });

describe('readEmbedKey', () => {
  test.each([
    ['a key-shaped value', KEY, KEY],
    ['a padded value', `  ${KEY}\n`, KEY],
    ['a blank', '   ', null],
    ['a short value', 'abc', null],
    ['a value with a space or a quote', `AIza FAKE"fake${'x'.repeat(20)}`, null],
    ['an absent value', undefined, null],
    ['a non-string', 42, null],
  ])('should read %s', (_name, value, expected) => {
    should(readEmbedKey(value)).equal(expected);
  });
});

describe('chooseMapDrawing', () => {
  test('should stay on OpenStreetMap, silently, when that is the style', () => {
    should(chooseMapDrawing(LONE_PIN, { environment: PLAIN, key: KEY, style: 'osm' })).eql({ note: null, via: 'osm' });
  });

  test('should stay on OpenStreetMap, silently, when the build has no key', () => {
    should(chooseMapDrawing(LONE_PIN, { environment: PLAIN, key: null, style: 'google' })).eql({
      note: null,
      via: 'osm',
    });
  });

  test('should frame a lone marker in place mode and keep its label for a caption', () => {
    const drawing = google(LONE_PIN, CHROMIUM);

    should(drawing.via).equal('google');
    if (drawing.via !== 'google') return;
    const address = new URL(drawing.src);
    should(`${address.origin}${address.pathname}`).equal('https://www.google.com/maps/embed/v1/place');
    should(address.searchParams.get('key')).equal(KEY);
    should(address.searchParams.get('q')).equal('51.500700,-0.124600');
    should(address.searchParams.get('zoom')).equal('12');
    should(drawing.caption).equal('Big Ben — Clock tower');
    should(drawing.credentialless).be.true();
  });

  test('should give a lone marker with no centre the engine fit ceiling, as it is fitted', () => {
    const drawing = google(spec('markers:\n  - {at: [10, 20]}'));

    should(drawing.via === 'google' && new URL(drawing.src).searchParams.get('zoom')).equal('15');
    should(drawing.via === 'google' && drawing.caption).equal(null);
  });

  test('should give a lone marker with a centre and no fit or zoom the default zoom', () => {
    const drawing = google(spec('center: [10, 20]\nmarkers:\n  - {at: [10, 20]}'));

    should(drawing.via === 'google' && new URL(drawing.src).searchParams.get('zoom')).equal(String(MAP_DEFAULT_ZOOM));
    should(MAP_DEFAULT_ZOOM).equal(13);
  });

  test('should give a lone marker with a centre and fit the fit ceiling', () => {
    const drawing = google(spec('center: [10, 20]\nfit: true\nmarkers:\n  - {at: [10, 20]}'));

    should(drawing.via === 'google' && new URL(drawing.src).searchParams.get('zoom')).equal('15');
  });

  test('should frame a plain centred map in view mode', () => {
    const drawing = google(PLAIN_VIEW);

    should(drawing.via).equal('google');
    if (drawing.via !== 'google') return;
    const address = new URL(drawing.src);
    should(address.pathname).equal('/maps/embed/v1/view');
    should(address.searchParams.get('center')).equal('48.856600,2.352200');
    should(address.searchParams.get('zoom')).equal('10');
  });

  test('should only ever build an address inside the frame source the CSP names', () => {
    for (const drawing of [google(LONE_PIN), google(PLAIN_VIEW)]) {
      should(drawing.via === 'google' && drawing.src.startsWith(GOOGLE_EMBED_FRAME_SOURCE)).be.true();
    }
  });

  test.each([
    ['several markers', 'markers:\n  - {at: [1, 2]}\n  - {at: [3, 4]}', 'more than one marker'],
    ['a route', 'center: [1, 2]\nlines:\n  - {points: [[1, 2], [3, 4]]}', 'routes or shapes'],
    ['a polygon', 'center: [1, 2]\npolygons:\n  - {points: [[1, 2], [3, 4], [5, 6]]}', 'routes or shapes'],
    ['a centre away from its marker', 'center: [9, 9]\nmarkers:\n  - {at: [1, 2]}', 'centre away from the marker'],
  ])('should fall back to OpenStreetMap, and say why, for %s', (_name, payload, why) => {
    const drawing = google(spec(payload));

    should(drawing.via).equal('osm');
    should(drawing.via === 'osm' && drawing.note)
      .startWith('Shown with OpenStreetMap:')
      .and.containEql(why);
  });

  test('should refuse Google in an isolated browser that has no credentialless frames', () => {
    const drawing = google(LONE_PIN, ISOLATED_SAFARI);

    should(drawing.via).equal('osm');
    should(drawing.via === 'osm' && drawing.note).containEql('several cores');
  });

  test('should allow Google in an isolated browser that has credentialless frames', () => {
    const drawing = google(LONE_PIN, ISOLATED_CHROMIUM);

    should(drawing.via === 'google' && drawing.credentialless).be.true();
  });

  test('should not claim credentialless where the browser lacks it and nothing is isolated', () => {
    should(
      google(LONE_PIN, PLAIN).via === 'google' &&
        (google(LONE_PIN, PLAIN) as { credentialless: boolean }).credentialless,
    ).be.false();
  });
});

describe('the CSP and the build', () => {
  const headers = readFileSync(join(import.meta.dir, '../../public/_headers'), 'utf8');

  test('should frame only itself and the Google embed path, once', () => {
    const sources = headers.match(/frame-src ([^;]*);/g) ?? [];

    should(sources).eql([`frame-src 'self' ${GOOGLE_EMBED_FRAME_SOURCE};`]);
  });

  test('should hand the build key to the page as a define, validated by the same reader', () => {
    const config = readFileSync(join(import.meta.dir, '../../vite.config.ts'), 'utf8');

    should(config).containEql('__FY_GOOGLE_MAPS_EMBED_KEY__: JSON.stringify(googleEmbedKey)');
    should(config).containEql('readEmbedKey(raw)');
  });
});
