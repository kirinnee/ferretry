/**
 * A value on its way in, padded to a bucket (today's `protocol/src/lib/input-request.ts`, copied: the Vault's wire
 * pads alike), so the halves of this plugin agree to the bit. The other helpers today's wire took from elsewhere are
 * `./foreign.ts` and `./sha256.ts`.
 */
import { INPUT_PAD_BUCKET_BYTES, INPUT_VALUE_MAX_BYTES } from '@ferretry/core-vault/contract';

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
