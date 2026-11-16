/**
 * THE NAME A PERSON TYPED FOR THIS BROWSER, made sendable. The default name itself (browser, system and a short
 * suffix) is the shell's one copy, `browserDeviceName` in `@ferretry/app`, shared with Catalogs.
 */

import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '../../contract/index.ts';

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
