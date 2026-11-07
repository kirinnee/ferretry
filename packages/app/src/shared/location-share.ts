/**
 * SHARE MY LOCATION — one reading, on a tap, as text in a message.
 *
 * WHAT IT IS NOT. It is not tracking. A fix is requested only by the reader pressing "Share my
 * location", exactly once per press (`getCurrentPosition`, never `watchPosition`), and what comes back
 * is held in the message box until the message is sent or the chip is removed. Nothing is stored,
 * polled or sent anywhere else, and the draft store never sees it.
 *
 * WHAT THE AGENT RECEIVES is plain text inside the message — a fenced block an agent reads like any
 * other words and this page draws as a chip:
 *
 *     ```fy-location
 *     latitude: 51.50735
 *     longitude: -0.12776
 *     accuracy: 20 m
 *     captured: 2026-10-21T12:00:00.000Z
 *     place: Home
 *     ```
 *
 * `place` is optional and written by the reader. Coordinates are rounded to five decimals (about a
 * metre), which is finer than any phone's accuracy and so discloses nothing the fix did not.
 *
 * THE BROWSER CALL IS MADE IN THE TAP. `locate` starts `getCurrentPosition` before its first `await`;
 * iOS shows the location prompt only for a call made inside the gesture.
 */

/** A single reading. `capturedAt` is epoch milliseconds, the browser's own timestamp for the fix. */
export interface LocationFix {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly capturedAt: number;
  readonly place?: string;
}

export type LocationFailureCode = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export class LocationError extends Error {
  readonly code: LocationFailureCode;

  constructor(code: LocationFailureCode, message: string) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
  }
}

export const LOCATION_FENCE_LANGUAGE = 'fy-location';
const PLACE_MAX = 80;
const COORDINATE_DECIMALS = 5;

const rounded = (value: number): string => value.toFixed(COORDINATE_DECIMALS).replace(/\.?0+$/u, '');

/** A place name the reader typed, made safe to sit on one line of a fenced block. */
export const cleanPlace = (value: string): string =>
  value.replaceAll('`', "'").replace(/\s+/gu, ' ').trim().slice(0, PLACE_MAX);

/** The block that goes into the message. */
export const formatLocationBlock = (fix: LocationFix): string => {
  const place = fix.place === undefined ? '' : cleanPlace(fix.place);
  return [
    `\`\`\`${LOCATION_FENCE_LANGUAGE}`,
    `latitude: ${rounded(fix.latitude)}`,
    `longitude: ${rounded(fix.longitude)}`,
    `accuracy: ${Math.round(fix.accuracyMeters)} m`,
    `captured: ${new Date(fix.capturedAt).toISOString()}`,
    ...(place === '' ? [] : [`place: ${place}`]),
    '```',
  ].join('\n');
};

/**
 * The fix a `fy-location` fence body describes, or `null` for anything that is not exactly one.
 * Strict on purpose: a block that does not parse stays an ordinary code fence.
 */
export const parseLocationBlock = (body: string): LocationFix | null => {
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const split = line.indexOf(':');
    if (split < 1) return null;
    fields.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
  }
  const latitude = Number(fields.get('latitude'));
  const longitude = Number(fields.get('longitude'));
  const accuracy = /^(\d+) m$/u.exec(fields.get('accuracy') ?? '');
  const capturedAt = Date.parse(fields.get('captured') ?? '');
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || fields.get('latitude') === '') return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || fields.get('longitude') === '') return null;
  if (accuracy === null || Number.isNaN(capturedAt)) return null;
  const place = cleanPlace(fields.get('place') ?? '');
  return {
    latitude,
    longitude,
    accuracyMeters: Number(accuracy[1]),
    capturedAt,
    ...(place === '' ? {} : { place }),
  };
};

/** "51.50735, -0.12776" — the pair a person can paste into a map. */
export const coordinatePair = (fix: LocationFix): string => `${rounded(fix.latitude)}, ${rounded(fix.longitude)}`;

/** "About 20 m" / "About 1.2 km" — how far to trust the pin. */
export const accuracyLabel = (meters: number): string =>
  meters >= 1000 ? `About ${(meters / 1000).toFixed(1)} km` : `About ${Math.round(meters)} m`;

/* ---------- the port -------------------------------------------------------- */

export interface LocationShareHost {
  /** One reading. Rejects with a `LocationError`. Call it from a tap. */
  locate(): Promise<LocationFix>;
}

interface PositionLike {
  readonly coords: { readonly latitude: number; readonly longitude: number; readonly accuracy: number };
  readonly timestamp: number;
}

export interface LocationEnvironment {
  readonly geolocation?:
    | {
        getCurrentPosition(
          success: (position: PositionLike) => void,
          failure: (error: { readonly code: number }) => void,
          options: { readonly enableHighAccuracy: boolean; readonly maximumAge: number; readonly timeout: number },
        ): void;
      }
    | undefined;
}

export const LOCATION_TIMEOUT_MS = 20_000;

const FAILURES: Readonly<Record<number, LocationError>> = {
  1: new LocationError('denied', 'Location is turned off for Ferretry on this device.'),
  3: new LocationError(
    'timeout',
    'Your device did not answer in time. Move somewhere with a clearer view of the sky and try again.',
  ),
};
const UNAVAILABLE = new LocationError(
  'unavailable',
  'Your device could not work out where it is. Try again in a moment.',
);

export const browserLocationShareHost = (environment: LocationEnvironment): LocationShareHost => ({
  locate: () => {
    const geolocation = environment.geolocation;
    if (geolocation === undefined) {
      return Promise.reject(new LocationError('unsupported', 'This browser cannot share a location.'));
    }
    // Started HERE, synchronously, so the prompt rides the tap.
    return new Promise<LocationFix>((resolve, reject) => {
      geolocation.getCurrentPosition(
        position =>
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy,
            capturedAt: position.timestamp,
          }),
        error => reject(FAILURES[error.code] ?? UNAVAILABLE),
        // Fresh (`maximumAge: 0`) because "where I am NOW" is the point of a share.
        { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS },
      );
    });
  },
});

/** Any failure, as a `LocationError` the reader can be told about. */
export const asLocationError = (reason: unknown): LocationError =>
  reason instanceof LocationError ? reason : UNAVAILABLE;
