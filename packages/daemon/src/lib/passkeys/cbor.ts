/**
 * A minimal CBOR reader for the two CBOR documents a WebAuthn verifier meets: the attestation object
 * and the COSE public key inside it (RFC 8949).
 *
 * It reads only what those documents use — unsigned and negative integers, byte and text strings,
 * arrays, maps, and the simple values true, false and null — with definite lengths only. Everything
 * else is refused rather than skipped: an indefinite length, a tag, a float, a reserved encoding, a
 * map with a duplicate or non-scalar key, nesting deeper than {@link MAX_CBOR_DEPTH}, a length that
 * runs past the buffer, and an integer beyond `Number.MAX_SAFE_INTEGER`. A reader that tolerated
 * any of these would let two parsers disagree about what an authenticator said.
 *
 * Every function is total: a refusal is `undefined`, never a throw.
 */

import { utf8Text } from '@ferretry/relay';

/** One decoded CBOR item. Maps keep their keys as the integers or strings they were encoded as. */
export type CborValue = number | string | boolean | null | Uint8Array | readonly CborValue[] | CborMap;
export type CborMap = ReadonlyMap<number | string, CborValue>;

/** Deeper nesting than this is refused; neither document the verifier reads nests past three. */
export const MAX_CBOR_DEPTH = 8;

/** A decoded item and the offset of the first byte after it. */
export interface CborItem {
  readonly value: CborValue;
  readonly end: number;
}

interface Head {
  readonly major: number;
  readonly argument: number;
  readonly next: number;
}

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;

/** Decode exactly one item that fills the whole buffer; trailing bytes are a refusal. */
export function decodeCbor(bytes: Uint8Array): CborValue | undefined {
  const item = decodeCborItem(bytes, 0);
  return item !== undefined && item.end === bytes.length ? item.value : undefined;
}

/** Decode one item starting at `offset`, for a CBOR value that other bytes follow (authenticatorData). */
export function decodeCborItem(bytes: Uint8Array, offset: number): CborItem | undefined {
  return readItem(bytes, offset, 0);
}

/** True for a decoded CBOR map. */
export function isCborMap(value: CborValue | undefined): value is CborMap {
  return value instanceof Map;
}

function readItem(bytes: Uint8Array, offset: number, depth: number): CborItem | undefined {
  if (depth > MAX_CBOR_DEPTH) return undefined;
  const initial = bytes[offset];
  if (initial === undefined) return undefined;
  if (initial >> 5 === 7) return readSimple(initial & 0x1f, offset + 1);
  const head = readHead(bytes, offset, initial);
  if (head === undefined) return undefined;
  switch (head.major) {
    case 0:
      return { value: head.argument, end: head.next };
    case 1:
      return { value: -1 - head.argument, end: head.next };
    case 2:
      return readBytes(bytes, head);
    case 3:
      return readText(bytes, head);
    case 4:
      return readArray(bytes, head, depth);
    case 5:
      return readMap(bytes, head, depth);
    default:
      // Major type 6 is a tag, which neither document uses.
      return undefined;
  }
}

function readHead(bytes: Uint8Array, offset: number, initial: number): Head | undefined {
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, argument: info, next: offset + 1 };
  // 28–30 are reserved and 31 is an indefinite length; both are refused.
  if (info > 27) return undefined;
  const size = 1 << (info - 24);
  if (offset + 1 + size > bytes.length) return undefined;
  let argument = 0;
  for (let index = 0; index < size; index += 1) argument = argument * 256 + (bytes[offset + 1 + index] ?? 0);
  // An 8-byte argument can exceed a double's exact range; past it two encodings would decode alike.
  if (!Number.isSafeInteger(argument)) return undefined;
  return { major, argument, next: offset + 1 + size };
}

function readSimple(info: number, next: number): CborItem | undefined {
  if (info === SIMPLE_FALSE) return { value: false, end: next };
  if (info === SIMPLE_TRUE) return { value: true, end: next };
  if (info === SIMPLE_NULL) return { value: null, end: next };
  return undefined;
}

function readBytes(bytes: Uint8Array, head: Head): CborItem | undefined {
  const end = head.next + head.argument;
  if (end > bytes.length) return undefined;
  return { value: bytes.slice(head.next, end), end };
}

function readText(bytes: Uint8Array, head: Head): CborItem | undefined {
  const end = head.next + head.argument;
  if (end > bytes.length) return undefined;
  const text = utf8Text(bytes.subarray(head.next, end));
  return text === null ? undefined : { value: text, end };
}

function readArray(bytes: Uint8Array, head: Head, depth: number): CborItem | undefined {
  // Every item is at least one byte, so a count beyond the remaining bytes is a lie told up front.
  if (head.argument > bytes.length - head.next) return undefined;
  const items: CborValue[] = [];
  let offset = head.next;
  for (let index = 0; index < head.argument; index += 1) {
    const item = readItem(bytes, offset, depth + 1);
    if (item === undefined) return undefined;
    items.push(item.value);
    offset = item.end;
  }
  return { value: items, end: offset };
}

function readMap(bytes: Uint8Array, head: Head, depth: number): CborItem | undefined {
  if (head.argument * 2 > bytes.length - head.next) return undefined;
  const map = new Map<number | string, CborValue>();
  let offset = head.next;
  for (let index = 0; index < head.argument; index += 1) {
    const key = readItem(bytes, offset, depth + 1);
    if (key === undefined) return undefined;
    if ((typeof key.value !== 'number' && typeof key.value !== 'string') || map.has(key.value)) return undefined;
    const value = readItem(bytes, key.end, depth + 1);
    if (value === undefined) return undefined;
    map.set(key.value, value.value);
    offset = value.end;
  }
  return { value: map, end: offset };
}
