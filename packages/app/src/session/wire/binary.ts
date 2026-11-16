/**
 * Byte helpers the wire format needs on both a daemon and a browser.
 *
 * They are here rather than in a shared utility package because every one of them is part of the
 * protocol definition: the base64url alphabet with no padding, big-endian integers, and a
 * comparison whose running time does not depend on where two secrets first differ.
 */

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

/** Encode bytes as unpadded base64url, the only binary spelling this protocol uses in text. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Decode unpadded base64url, refusing anything that is not exactly that.
 *
 * `atob` is lenient in ways a wire format must not be, so the alphabet is checked first and the
 * round trip is checked after: a decoder that silently accepts padding, whitespace or a truncated
 * final group lets two implementations disagree about what a signature covers.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text)) return null;
  if (text.length % 4 === 1) return null;
  // The alphabet and the group length are already proved, so the padded text is always decodable.
  // A `try` here would be a branch nothing can reach, which reads as a guard and is not one.
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return toBase64Url(bytes) === text ? bytes : null;
}

/** Decode base64url and require an exact length, which every key and signature field has. */
export function fromBase64UrlFixed(text: string, length: number): Uint8Array | null {
  const bytes = fromBase64Url(text);
  return bytes !== null && bytes.length === length ? bytes : null;
}

/** Join byte runs into one buffer. Used wherever a hash or signature covers several fields. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * Prefix a field with its big-endian 32-bit length before it enters a transcript.
 *
 * Concatenating raw fields would let an attacker move a byte from the end of one field to the
 * start of the next and reach the same hash, so every transcript field is length-prefixed.
 */
export function lengthPrefixed(field: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + field.length);
  writeUint32(framed, 0, field.length);
  framed.set(field, 4);
  return framed;
}

/** UTF-8 encode, for the domain-separation labels and JSON payloads the transcript covers. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 decode a payload that a peer supplied, returning null when it is not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
}

export function readUint32(source: Uint8Array, offset: number): number {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, false);
}

/** Sequence numbers are 64 bits on the wire even though {@link MAX_FRAME_SEQUENCE} bounds them. */
export function writeUint64(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setBigUint64(offset, BigInt(value), false);
}

/** Read a 64-bit field, refusing a value above `Number.MAX_SAFE_INTEGER` rather than rounding it. */
export function readUint64(source: Uint8Array, offset: number): number | null {
  const value = new DataView(source.buffer, source.byteOffset, source.byteLength).getBigUint64(offset, false);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

/**
 * Compare two byte runs without an early exit.
 *
 * Fingerprints and authentication tags are compared here. A comparison that stops at the first
 * difference tells an attacker how much of a guess was right, which turns a search over the whole
 * value into a search one byte at a time.
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/** True when every byte is zero — how a degenerate X25519 shared secret is recognised. */
export function isAllZero(bytes: Uint8Array): boolean {
  let bits = 0;
  for (const byte of bytes) bits |= byte;
  return bits === 0;
}
