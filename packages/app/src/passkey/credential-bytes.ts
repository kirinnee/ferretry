/**
 * READING THE CREDENTIAL A CEREMONY GOT BACK, WHOEVER MADE IT.
 *
 * `navigator.credentials.create()`/`get()` is not always the browser's own: a passkey manager extension (1Password,
 * Bitwarden, Proton Pass) replaces both and resolves with an object it built itself. 1Password's is a plain object that
 * only MIMICS a `PublicKeyCredential` — its `response` may carry none of the byte fields, which are reachable only
 * through its `toJSON()` (base64url strings, the WebAuthn Level 3 JSON) — and a wrapper's buffers can come from another
 * realm, where `instanceof ArrayBuffer` is false. A check that demanded real `ArrayBuffer`s refused every such credential
 * AFTER the manager had saved it, so nothing reached the machine and the person was left with a passkey it never knew.
 *
 * So what is RECEIVED is read leniently: an `ArrayBuffer` from any realm, any typed array or `DataView`, or — when the
 * object's own fields do not hold every byte field — its `toJSON()`. What is SENT stays strict: every field is the
 * base64url of real bytes this module decoded itself, never a string passed through as it came, and a credential that
 * yields none of these is refused here rather than half-sent.
 */

import { fromBase64Url, toBase64Url } from '../session/session-transport.ts';

/** The fields a ceremony reads off `response`, besides `rawId`. */
type ResponseField = 'clientDataJSON' | 'attestationObject' | 'authenticatorData' | 'signature';

/** The bytes a field holds: an ArrayBuffer from any realm, a typed array or a DataView; anything else is none. */
function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // Another realm's ArrayBuffer: not `instanceof` this one, but the same internal slot, which the constructor reads.
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value as ArrayBuffer);
  return undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** The credential's own JSON (`toJSON()`), or nothing: a wrapper's may throw ("Illegal invocation") or be absent. */
function jsonOf(credential: Record<string, unknown>): Record<string, unknown> | undefined {
  const toJSON = credential.toJSON;
  if (typeof toJSON !== 'function') return undefined;
  try {
    return record((toJSON as () => unknown).call(credential));
  } catch {
    return undefined;
  }
}

/** One field from the JSON form: a base64url string that decodes, as the bytes it names. */
const jsonBytes = (value: unknown): Uint8Array | undefined =>
  typeof value === 'string' ? (fromBase64Url(value) ?? undefined) : undefined;

/**
 * `rawId` and the named response fields as base64url of real bytes, all from ONE source — the object's own fields,
 * else its JSON — so an id and a signature never come from two different readings. `undefined` when neither holds
 * every field.
 */
export function credentialFields<Field extends ResponseField>(
  credential: unknown,
  fields: readonly Field[],
): ({ readonly rawId: string } & Readonly<Record<Field, string>>) | undefined {
  const own = record(credential);
  if (own === undefined) return undefined;
  const read = (source: Record<string, unknown> | undefined, decode: (value: unknown) => Uint8Array | undefined) => {
    const response = record(source?.response);
    const rawId = decode(source?.rawId);
    if (rawId === undefined || response === undefined) return undefined;
    const out: Record<string, string> = { rawId: toBase64Url(rawId) };
    for (const field of fields) {
      const bytes = decode(response[field]);
      if (bytes === undefined) return undefined;
      out[field] = toBase64Url(bytes);
    }
    return out as { readonly rawId: string } & Readonly<Record<Field, string>>;
  };
  return read(own, bytesOf) ?? read(jsonOf(own), jsonBytes);
}
