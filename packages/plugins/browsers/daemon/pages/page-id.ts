import { BROWSER_IDENTITY_KEY_PATTERN } from '../../contract/wire.ts';

const PAGE_TAG = 'pg-';
const SERIAL_RADIX = 36;

/** The worker's page-id spelling; the router reserves precisely these spellings as names. */
export function browserPageId(prefix: string, serial: number): string {
  return `${prefix}${PAGE_TAG}${serial.toString(SERIAL_RADIX)}`;
}

export function isBrowserPageId(key: string): boolean {
  const tag = key.lastIndexOf(PAGE_TAG);
  if (tag < 0) return false;
  const prefix = key.slice(0, tag);
  if (prefix !== '' && (!prefix.endsWith('-') || !BROWSER_IDENTITY_KEY_PATTERN.test(prefix.slice(0, -1)))) return false;
  const serial = Number.parseInt(key.slice(tag + PAGE_TAG.length), SERIAL_RADIX);
  return serial > 0 && browserPageId(prefix, serial) === key;
}
