import { describe, expect, it } from 'bun:test';

import { LANDING_MARKER_KEY, syncLandingMarker, type LandingMarkerStorage } from '../../src/lib/store.tsx';

const memoryStorage = (): LandingMarkerStorage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
};

describe('the landing pairing marker', () => {
  it('records only whether the pairing set is non-empty, then removes that hint when it is empty', () => {
    const storage = memoryStorage();

    syncLandingMarker(storage, 2);
    expect(storage.values).toEqual(new Map([[LANDING_MARKER_KEY, '1']]));

    syncLandingMarker(storage, 0);
    expect(storage.values).toEqual(new Map());
  });

  it('treats unavailable or refusing browser storage as a harmless fail-open condition', () => {
    const refusing: LandingMarkerStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };

    expect(() => syncLandingMarker(undefined, 1)).not.toThrow();
    expect(() => syncLandingMarker(refusing, 1)).not.toThrow();
  });
});
