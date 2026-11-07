/**
 * Pure helpers today's wire took from `protocol/src/lib/{mcp-oauth,secrets,step-up}.ts`, copied as-is so the halves
 * of this plugin agree to the bit.
 */
import { INPUT_PAD_BUCKET_BYTES, INPUT_VALUE_MAX_BYTES } from '@ferretry/core-vault/contract';
import { z } from 'zod';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/**
 * SHA-256 (FIPS 180-4) as lowercase hex, synchronously, with no dependency. Synchronous because the subject a passkey
 * proof is bound to (`addTwoFactorKeySubject`) is computed by pure code, and both halves must agree to the bit.
 */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const length = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(length - 4, (data.length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let index = 0; index < 64; index += 1) {
      const t1 =
        ((h as number) +
          (rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25)) +
          (((e as number) & (f as number)) ^ (~(e as number) & (g as number))) +
          (K[index] as number) +
          (w[index] as number)) >>>
        0;
      const t2 =
        ((rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22)) +
          (((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number)))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h] as number[];
    for (let index = 0; index < 8; index += 1) hash[index] = ((hash[index] as number) + (next[index] as number)) >>> 0;
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

/** Whether a sealed store could be read: a damaged one is said, never shown as empty. */
export const SecretStoreHealthSchema = z.enum(['ready', 'damaged']);
export type SecretStoreHealth = z.infer<typeof SecretStoreHealthSchema>;

/** How long a challenge the daemon issued may be answered. It is spent on its first answer either way. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

/** An instant on the wire, exactly as today's protocol reads one (an ISO date-time with an offset). */
export const InstantSchema = z.iso.datetime({ offset: true });

// ── A value on its way in, padded to a bucket (today's `input-request.ts`, copied: the Vault's wire pads alike) ──

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LENGTH_WIDTH = 5;

/**
 * Round a value up to a bucket for the wire: `NNNNN:` (its UTF-8 length), the value, then spaces to the
 * next multiple of {@link INPUT_PAD_BUCKET_BYTES}. The relay sees a bucket, not a password length. Throws
 * `RangeError` for a value over {@link INPUT_VALUE_MAX_BYTES}.
 */
export function padInputValue(value: string): string {
  const length = encoder.encode(value).length;
  if (length > INPUT_VALUE_MAX_BYTES) throw new RangeError('value too long');
  const head = `${String(length).padStart(LENGTH_WIDTH, '0')}:`;
  const used = head.length + length;
  const total = Math.max(INPUT_PAD_BUCKET_BYTES, Math.ceil(used / INPUT_PAD_BUCKET_BYTES) * INPUT_PAD_BUCKET_BYTES);
  return `${head}${value}${' '.repeat(total - used)}`;
}

/**
 * Take the value back out of {@link padInputValue}'s output, or `undefined` when the string is not exactly
 * that: a wrong prefix, a length that does not fit, padding that is not spaces, or a size off the bucket.
 */
export function unpadInputValue(padded: string): string | undefined {
  const bytes = encoder.encode(padded);
  if (bytes.length === 0 || bytes.length % INPUT_PAD_BUCKET_BYTES !== 0) return undefined;
  const head = String.fromCharCode(...bytes.subarray(0, LENGTH_WIDTH + 1));
  if (!/^[0-9]{5}:$/u.test(head)) return undefined;
  const length = Number(head.slice(0, LENGTH_WIDTH));
  const end = LENGTH_WIDTH + 1 + length;
  if (length > INPUT_VALUE_MAX_BYTES || end > bytes.length) return undefined;
  if (!bytes.subarray(end).every(byte => byte === 0x20)) return undefined;
  if (
    bytes.length !== Math.max(INPUT_PAD_BUCKET_BYTES, Math.ceil(end / INPUT_PAD_BUCKET_BYTES) * INPUT_PAD_BUCKET_BYTES)
  ) {
    return undefined;
  }
  return decoder.decode(bytes.subarray(LENGTH_WIDTH + 1, end));
}
