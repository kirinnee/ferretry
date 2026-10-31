import { createHmac } from 'node:crypto';
import type { TotpParameters } from '@ferretry/protocol';

/**
 * A 2FA code from a saved seed (RFC 6238 over RFC 4226), made INSIDE the daemon.
 *
 * The seed is opened only to make the code and the code only to type it: nothing here is returned to a
 * route, logged or kept. Pure apart from the HMAC, so the RFC test vectors pin it with a fixed clock.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The bytes of a base32 seed (RFC 4648, no padding), or `undefined` when it is not base32. */
export function base32Bytes(seed: string): Uint8Array | undefined {
  const clean = seed.replaceAll(/[\s=-]/gu, '').toUpperCase();
  if (clean === '') return undefined;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index === -1) return undefined;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

const HMAC_NAMES = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' } as const;

/** RFC 4226 HOTP for one counter. */
export function hotp(key: Uint8Array, counter: number, digits: number, algorithm: TotpParameters['algorithm']): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(HMAC_NAMES[algorithm], key).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code a seed shows at `nowMs`, or `undefined` for a seed that is not base32. */
export function totpCode(seed: string, parameters: TotpParameters, nowMs: number): string | undefined {
  const key = base32Bytes(seed);
  if (key === undefined || key.length === 0) return undefined;
  return hotp(key, Math.floor(nowMs / 1000 / parameters.period), parameters.digits, parameters.algorithm);
}
