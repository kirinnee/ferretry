import { describe, test } from 'bun:test';
import should from 'should';
import { readMap } from '../../../../app/render/fy-render-map-model.ts';
import {
  chooseMapDrawing,
  DEFAULT_MAP_CHOICE,
  GOOGLE_EMBED_FRAME_SOURCE,
  GOOGLE_KEY_NEEDED_NOTE,
  loadMapChoice,
  MAP_STYLE_STORAGE_NAME,
  type MapChoiceStorage,
  type MapEnvironment,
  parseMapChoice,
  readEmbedKey,
  saveMapChoice,
} from '../../../../app/render/fy-render-map-style.ts';

/** A FAKE key of the right shape. No real key is ever written in a test, a capture or a message. */
const FAKE_KEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0';
const PLAIN: MapEnvironment = { credentialless: false, isolated: false };

const specOf = (payload: string) => {
  const reading = readMap(payload);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.spec;
};

const PIN = 'center: [51.5, -0.12]\nzoom: 12\nmarkers:\n  - {at: [51.5, -0.12], label: Home, popup: Hello}';
const VIEW = 'center: [51.5, -0.12]\nzoom: 9';

const memory = (): MapChoiceStorage & { readonly data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: name => data.get(name) ?? null,
    removeItem: name => void data.delete(name),
    setItem: (name, value) => void data.set(name, value),
  };
};

const blocked: MapChoiceStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('map style — the choice', () => {
  test('should default to OpenStreetMap with no key', () => {
    should(loadMapChoice(memory())).eql(DEFAULT_MAP_CHOICE);
    should(DEFAULT_MAP_CHOICE).eql({ key: null, style: 'osm' });
  });

  test('should read only a key shaped like one', () => {
    should(readEmbedKey(FAKE_KEY)).equal(FAKE_KEY);
    should(readEmbedKey(`  ${FAKE_KEY}\n`)).equal(FAKE_KEY);
    for (const bad of ['', 'short', 'has space in it that is long enough', 'a&b=c'.repeat(8), 42, null])
      should(readEmbedKey(bad)).be.null();
  });

  test('should round-trip the style and the key through storage', () => {
    const storage = memory();
    should(saveMapChoice({ key: FAKE_KEY, style: 'google' }, storage)).be.true();
    should(loadMapChoice(storage)).eql({ key: FAKE_KEY, style: 'google' });
  });

  test('should drop the stored value when the choice is the default again', () => {
    const storage = memory();
    saveMapChoice({ key: FAKE_KEY, style: 'google' }, storage);
    saveMapChoice(DEFAULT_MAP_CHOICE, storage);
    should(storage.data.has(MAP_STYLE_STORAGE_NAME)).be.false();
  });

  test('should treat unreadable storage as the default and never throw', () => {
    should(loadMapChoice(blocked)).eql(DEFAULT_MAP_CHOICE);
    should(loadMapChoice(null)).eql(DEFAULT_MAP_CHOICE);
    should(saveMapChoice({ key: FAKE_KEY, style: 'google' }, blocked)).be.false();
    should(saveMapChoice({ key: FAKE_KEY, style: 'google' }, null)).be.false();
    for (const raw of ['{', 'null', '[]', '"google"', undefined])
      should(parseMapChoice(raw as string | undefined)).eql(DEFAULT_MAP_CHOICE);
  });

  test('should refuse a stored key that is not shaped like one', () => {
    should(parseMapChoice('{"style":"google","key":"nope"}')).eql({ key: null, style: 'google' });
  });
});

describe('map style — the drawing', () => {
  const google = { environment: PLAIN, key: FAKE_KEY, style: 'google' } as const;

  test('should keep OpenStreetMap, with no note, unless Google was chosen', () => {
    should(chooseMapDrawing(specOf(PIN), { ...google, style: 'osm' })).eql({ note: null, via: 'osm' });
  });

  test('should say the key is needed when Google was chosen and none is kept', () => {
    should(chooseMapDrawing(specOf(PIN), { ...google, key: null })).eql({ note: GOOGLE_KEY_NEEDED_NOTE, via: 'osm' });
  });

  test('should frame one marker as a Google place with its label as a caption', () => {
    const drawing = chooseMapDrawing(specOf(PIN), google);
    if (drawing.via !== 'google') throw new Error('expected google');
    const url = new URL(drawing.src);
    should(drawing.src.startsWith(GOOGLE_EMBED_FRAME_SOURCE)).be.true();
    should(url.pathname).equal('/maps/embed/v1/place');
    should(url.searchParams.get('q')).equal('51.500000,-0.120000');
    should(url.searchParams.get('zoom')).equal('12');
    should(url.searchParams.get('key')).equal(FAKE_KEY);
    should(drawing.caption).equal('Home — Hello');
  });

  test('should frame a plain centred map as a Google view', () => {
    const drawing = chooseMapDrawing(specOf(VIEW), google);
    if (drawing.via !== 'google') throw new Error('expected google');
    should(new URL(drawing.src).pathname).equal('/maps/embed/v1/view');
    should(drawing.caption).be.null();
  });

  test('should fall back to OpenStreetMap, saying why, for what Google cannot draw', () => {
    const many = 'markers:\n  - {at: [1, 1]}\n  - {at: [2, 2]}';
    const route = 'center: [1, 1]\nlines:\n  - {points: [[1, 1], [2, 2]]}';
    const off = 'center: [51.5, -0.12]\nmarkers:\n  - {at: [10, 10]}';
    const none = 'zoom: 3\ngeojson: {type: Point, coordinates: [0, 0]}';
    for (const payload of [many, route, off]) {
      const drawing = chooseMapDrawing(specOf(payload), google);
      should(drawing.via).equal('osm');
      should(drawing.via === 'osm' ? drawing.note : '').startWith('Shown with OpenStreetMap: ');
    }
    should(chooseMapDrawing(specOf(none), google).via).equal('google');
  });

  test('should refuse a Google frame under isolation unless the browser can make it credentialless', () => {
    const isolated = { credentialless: false, isolated: true };
    should(chooseMapDrawing(specOf(PIN), { ...google, environment: isolated }).via).equal('osm');
    const both = chooseMapDrawing(specOf(PIN), { ...google, environment: { credentialless: true, isolated: true } });
    should(both.via === 'google' && both.credentialless).be.true();
  });

  test('should never put the key in a note or caption', () => {
    for (const payload of [PIN, VIEW, 'markers:\n  - {at: [1, 1]}\n  - {at: [2, 2]}']) {
      const drawing = chooseMapDrawing(specOf(payload), google);
      const text = drawing.via === 'google' ? (drawing.caption ?? '') : (drawing.note ?? '');
      should(text).not.containEql(FAKE_KEY);
    }
  });
});
