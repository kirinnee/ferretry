import { createHash } from 'node:crypto';
import type { RenderKind } from '../../../contract/index.ts';
import { RENDER_ID_ALPHABET, RENDER_ID_MAX_LENGTH } from './constants.ts';

/**
 * The digest a render is addressed by: SHA-256 of `kind`, a zero byte, `alt`, a zero byte and the payload.
 * The separators make `("svg", "a", "b")` and `("svg", "ab", "")` different content. The same kind, alt and
 * payload always give the same digest, which is what makes a retried save the same render.
 */
export function renderDigest(kind: RenderKind, alt: string, payload: string): Buffer {
  return createHash('sha256').update(kind).update('\0').update(alt).update('\0').update(payload).digest();
}

/** The first `length` characters of the digest in lowercase Crockford base32 (`RENDER_ID_ALPHABET`), five bits each. */
export function renderIdPrefix(digest: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && text.length < length) {
      text += RENDER_ID_ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (text.length >= length) return text;
  }
  // 256 bits is 51 full characters and a sixth of a 52nd: pad the last with zero bits.
  if (bits > 0 && text.length < Math.min(length, RENDER_ID_MAX_LENGTH))
    text += RENDER_ID_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  return text;
}
