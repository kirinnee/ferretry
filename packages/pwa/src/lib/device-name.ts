/**
 * WHAT A BROWSER CALLS ITSELF WHEN IT ASKS A MACHINE TO TRUST IT.
 *
 * Every browser used to pair as "Ferretry PWA", so the second one made every name ambiguous: `fy device
 * revoke "Ferretry PWA"` and `fy passkey window "Ferretry PWA"` could no longer pick one, and the device
 * list at the machine was a column of identical rows. So the default is what a person would call it —
 * the browser and the system it runs on — plus a short suffix that tells two of the same apart. It is a
 * DEFAULT: the confirm screen shows it in a field the person can change before pairing.
 *
 * Read from the user-agent string, which is a hint and nothing more. A name is a label for a person; it
 * authorises nothing, so a browser that lies about itself only mislabels itself.
 */

import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '@ferretry/protocol';

/** Letters and digits that cannot be misread for one another (no 0/O, 1/I/L). */
const SUFFIX_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SUFFIX_LENGTH = 4;

/** Which browser, in the words its own maker uses. Order matters: Edge and Opera also say "Chrome". */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdgA?\//u, 'Edge'],
  [/\b(?:OPR|Opera)\//u, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//u, 'Firefox'],
  [/\bCriOS\/|\bChrome\//u, 'Chrome'],
  [/\bSafari\//u, 'Safari'],
];

/** Which system. iPadOS asks for desktop sites and says "Macintosh", so a touch Mac is not told apart. */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPad\b/u, 'iPadOS'],
  [/\biPhone\b|\biPod\b/u, 'iOS'],
  [/\bAndroid\b/u, 'Android'],
  [/\bCrOS\b/u, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/u, 'macOS'],
  [/\bWindows\b/u, 'Windows'],
  [/\bLinux\b/u, 'Linux'],
];

const firstMatch = (table: readonly (readonly [RegExp, string])[], text: string): string | undefined =>
  table.find(([pattern]) => pattern.test(text))?.[1];

/** A short suffix from `random` bytes, one character per byte. */
export function deviceNameSuffix(random: (length: number) => Uint8Array): string {
  return [...random(SUFFIX_LENGTH)].map(byte => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join('');
}

/** "Chrome on macOS · K7Q2" — or as much of it as the user-agent says. */
export function defaultDeviceName(userAgent: string, suffix: string): string {
  const browser = firstMatch(BROWSERS, userAgent) ?? 'Browser';
  const system = firstMatch(SYSTEMS, userAgent);
  return `${system === undefined ? browser : `${browser} on ${system}`} · ${suffix}`;
}

/**
 * The name a person typed, made sendable: control and format characters (which the pairing schema
 * refuses) dropped, trimmed, and cut to the schema's length without splitting a character.
 * `undefined` for a name with nothing left in it, which the confirm screen refuses to send.
 */
export function normalizedDeviceName(typed: string): string | undefined {
  const cleaned = typed.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (cleaned === '') return undefined;
  let out = '';
  for (const character of cleaned) {
    if (out.length + character.length > PAIRING_DEVICE_NAME_MAX_LENGTH) break;
    out += character;
  }
  return out.trim();
}
