import { BROWSER_REF_PATTERN } from '../../contract/index.ts';
import { decimal, UsageError } from './args.ts';

/**
 * What one word on the command line points at, and the small shapes a few options take. Pure, and shared by every
 * page verb: the verb table names them, the dispatcher never reads them.
 */

/** A point on the command line: `x,y` in viewport CSS pixels. */
const POINT = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/u;

export type Element = { readonly ref: string } | { readonly selector: string };
export type Target = Element | { readonly x: number; readonly y: number };

/**
 * What a page act points at, from one word: a ref from `read --snapshot` (`e12`), a point (`120,340`, where the act
 * takes one), or else a selector.
 */
export function targetArgument(word: string): Target {
  const value = word.trim();
  if (BROWSER_REF_PATTERN.test(value)) return { ref: value };
  const point = POINT.exec(value);
  if (point !== null) return { x: Number(point[1]), y: Number(point[2]) };
  return { selector: word };
}

/** The same, for an act that takes only an element. */
export function elementArgument(word: string): Element {
  const target = targetArgument(word);
  if ('x' in target) throw new UsageError(`this act takes a ref or a selector, not a point ("${word}")`);
  return target;
}

/** One end of a drag: a target's fields under `from…` or `to…`. */
export function prefixed(prefix: 'from' | 'to', target: Target): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(target).map(([key, value]) => [`${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`, value]),
  );
}

/** `1280x800` as a viewport. */
export function viewportArgument(value: string): { readonly width: number; readonly height: number } {
  const match = /^(\d+)x(\d+)$/iu.exec(value.trim());
  if (match === null) throw new UsageError(`--viewport must be WIDTHxHEIGHT, like 390x844, not "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `52.5,13.4` or `52.5,13.4,50` (latitude, longitude, accuracy in metres) as a position. */
export function geolocationArgument(value: string): {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
} {
  const numbers = value.split(',').map(part => (part.trim() === '' ? Number.NaN : Number(part.trim())));
  if ((numbers.length !== 2 && numbers.length !== 3) || numbers.some(number => !Number.isFinite(number)))
    throw new UsageError(`--geolocation must be LAT,LON or LAT,LON,ACCURACY, not "${value}"`);
  const [latitude, longitude, accuracy] = numbers as [number, number, number | undefined];
  return { latitude, longitude, ...(accuracy === undefined ? {} : { accuracy }) };
}

/** `--by dx,dy` as the scroll tool's deltas. */
export function distanceArgument(value: string): { readonly deltaX: number; readonly deltaY: number } {
  const [x, y, ...rest] = value.split(',');
  if (x === undefined || y === undefined || rest.length > 0)
    throw new UsageError(`--by must be two numbers, dx,dy, not "${value}"`);
  return { deltaX: decimal(x, '--by'), deltaY: decimal(y, '--by') };
}

/** An `att_` attachment id, which an upload names instead of a path. */
const ATTACHMENT_ID = /^att_[a-f0-9]{64}$/u;
export const uploadFile = (file: string): string | { readonly attachment: string } =>
  ATTACHMENT_ID.test(file) ? { attachment: file } : file;

/** Where in history `page navigate` goes instead of to a URL. */
export const HISTORY_STEPS: ReadonlySet<string> = new Set(['back', 'forward', 'reload']);
