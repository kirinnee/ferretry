import { describe, expect, it } from 'bun:test';

import {
  accuracyLabel,
  asLocationError,
  browserLocationShareHost,
  cleanPlace,
  coordinatePair,
  formatLocationBlock,
  LOCATION_FENCE_LANGUAGE,
  LOCATION_TIMEOUT_MS,
  LocationError,
  type LocationFix,
  parseLocationBlock,
} from '../../src/lib/location-share.ts';

const CAPTURED = Date.parse('2026-10-21T12:00:00.000Z');

const fix = (overrides: Partial<LocationFix> = {}): LocationFix => ({
  latitude: 51.507351234,
  longitude: -0.127758,
  accuracyMeters: 19.6,
  capturedAt: CAPTURED,
  ...overrides,
});

describe('formatLocationBlock', () => {
  it('writes a fenced block with rounded coordinates, whole metres and an ISO timestamp', () => {
    expect(formatLocationBlock(fix())).toBe(
      [
        '```fy-location',
        'latitude: 51.50735',
        'longitude: -0.12776',
        'accuracy: 20 m',
        'captured: 2026-10-21T12:00:00.000Z',
        '```',
      ].join('\n'),
    );
    expect(LOCATION_FENCE_LANGUAGE).toBe('fy-location');
  });

  it('adds the place when there is one, cleaned onto a single line', () => {
    const block = formatLocationBlock(fix({ place: '  Home `sweet`\n home ' }));
    expect(block).toContain("place: Home 'sweet' home");
    expect(block.split('\n')).toHaveLength(7);
  });

  it('leaves a blank place out, and trims a long one', () => {
    expect(formatLocationBlock(fix({ place: '   ' }))).not.toContain('place:');
    expect(cleanPlace('x'.repeat(200))).toHaveLength(80);
  });

  it('writes zero and whole-number coordinates without a dangling decimal point', () => {
    const block = formatLocationBlock(fix({ latitude: 0, longitude: 100 }));
    expect(block).toContain('latitude: 0\n');
    expect(block).toContain('longitude: 100\n');
  });
});

describe('parseLocationBlock', () => {
  it('reads back what formatLocationBlock wrote', () => {
    const body = formatLocationBlock(fix({ place: 'Home' }))
      .split('\n')
      .slice(1, -1)
      .join('\n');
    expect(parseLocationBlock(body)).toEqual({
      latitude: 51.50735,
      longitude: -0.12776,
      accuracyMeters: 20,
      capturedAt: CAPTURED,
      place: 'Home',
    });
  });

  it('reads a block with no place', () => {
    const body = 'latitude: 1\nlongitude: 2\naccuracy: 3 m\ncaptured: 2026-10-21T12:00:00.000Z';
    expect(parseLocationBlock(body)).toEqual({ latitude: 1, longitude: 2, accuracyMeters: 3, capturedAt: CAPTURED });
  });

  it('refuses anything that is not exactly a location', () => {
    const good = ['latitude: 1', 'longitude: 2', 'accuracy: 3 m', 'captured: 2026-10-21T12:00:00.000Z'];
    const without = (key: string) => good.filter(line => !line.startsWith(key)).join('\n');
    expect(parseLocationBlock(without('latitude'))).toBeNull();
    expect(parseLocationBlock(without('longitude'))).toBeNull();
    expect(parseLocationBlock(without('accuracy'))).toBeNull();
    expect(parseLocationBlock(without('captured'))).toBeNull();
    expect(parseLocationBlock('just some words')).toBeNull();
    expect(parseLocationBlock('')).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('latitude: 1', 'latitude: 91'))).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('longitude: 2', 'longitude: 181'))).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('latitude: 1', 'latitude: north'))).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('longitude: 2', 'longitude: '))).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('latitude: 1', 'latitude: '))).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('3 m', '3 km'))).toBeNull();
    expect(parseLocationBlock(good.join('\n').replace('2026-10-21T12:00:00.000Z', 'yesterday'))).toBeNull();
  });
});

describe('labels', () => {
  it('prints the pair a person can paste into a map', () => {
    expect(coordinatePair(fix())).toBe('51.50735, -0.12776');
  });

  it('prints metres up to a kilometre and kilometres after', () => {
    expect(accuracyLabel(19.6)).toBe('About 20 m');
    expect(accuracyLabel(999)).toBe('About 999 m');
    expect(accuracyLabel(1500)).toBe('About 1.5 km');
  });
});

describe('browserLocationShareHost', () => {
  const position = { coords: { latitude: 1.5, longitude: 2.5, accuracy: 8 }, timestamp: CAPTURED };

  it('refuses where there is no geolocation', async () => {
    await expect(browserLocationShareHost({}).locate()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('asks once, right away, for one fresh high-accuracy fix', async () => {
    const calls: unknown[] = [];
    const host = browserLocationShareHost({
      geolocation: {
        getCurrentPosition: (success, _failure, options) => {
          calls.push(options);
          success(position);
        },
      },
    });

    const reading = host.locate();
    expect(calls).toEqual([{ enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS }]);
    expect(await reading).toEqual({ latitude: 1.5, longitude: 2.5, accuracyMeters: 8, capturedAt: CAPTURED });
  });

  it('maps a refusal, a timeout and any other failure onto sentences a reader can act on', async () => {
    const failing = (code: number) =>
      browserLocationShareHost({ geolocation: { getCurrentPosition: (_success, failure) => failure({ code }) } });

    await expect(failing(1).locate()).rejects.toMatchObject({ code: 'denied' });
    await expect(failing(3).locate()).rejects.toMatchObject({ code: 'timeout' });
    await expect(failing(2).locate()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(failing(99).locate()).rejects.toBeInstanceOf(LocationError);
  });
});

describe('asLocationError', () => {
  it('keeps a LocationError and turns anything else into "unavailable"', () => {
    const original = new LocationError('denied', 'no');
    expect(asLocationError(original)).toBe(original);
    expect(asLocationError(new Error('boom')).code).toBe('unavailable');
    expect(asLocationError(undefined).code).toBe('unavailable');
  });
});
