/**
 * Canonical JSON: RFC 8785, the JSON Canonicalization Scheme (JCS).
 *
 * A signature covers bytes, and two programs that agree on a document's MEANING can still write it
 * as different bytes — key order, `1.0` against `1`, `é` against `é`. A signed catalog is written
 * on the publisher, checked in the subscriber's app and checked again on the subscriber's own daemon
 * (docs/catalogs.md § Signed manifests), so all three must turn one document into one string. This is
 * that one function (one fact, one owner); nothing else in the codebase may hash a document it means to
 * sign.
 *
 * The scheme, in short:
 *
 * - object keys sorted by their UTF-16 code units, which is what `Array.prototype.sort` compares;
 * - numbers written the way ECMAScript's `Number.prototype.toString` writes them (`-0` is `0`);
 * - strings escaped the way `JSON.stringify` escapes them: `"`, `\` and controls below U+0020 only;
 * - no whitespace.
 *
 * The input must be I-JSON (RFC 7493): no `NaN` or infinity, and no lone surrogate in a string or a key,
 * because either would have no single spelling. Those are refused with a sentence rather than written.
 * So is anything that is not JSON at all (`undefined` in an array, a function, a `bigint`, a `Date`), and
 * a document deeper than {@link CANONICAL_JSON_MAX_DEPTH}, so the function is total on whatever it is
 * handed. An object property whose value is `undefined` is left out, as `JSON.stringify` does: that is
 * how an absent optional field reads after a schema parse, and it means the same document.
 */

/** Deeper than this, a document is refused rather than walked. Every signed shape is a handful deep. */
export const CANONICAL_JSON_MAX_DEPTH = 64;

export type CanonicalJsonResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/** A lone surrogate: the `u` flag makes a well-formed pair one code point, so only a lone half matches. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

class NotCanonical extends Error {}

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const writeString = (text: string, where: string): string => {
  if (LONE_SURROGATE.test(text)) throw new NotCanonical(`${where} holds a lone surrogate, which has no one spelling`);
  return JSON.stringify(text);
};

const write = (value: unknown, depth: number, where: string): string => {
  if (depth > CANONICAL_JSON_MAX_DEPTH) throw new NotCanonical(`${where} is deeper than ${CANONICAL_JSON_MAX_DEPTH}`);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new NotCanonical(`${where} is ${String(value)}, which JSON cannot hold`);
      // ECMAScript's own number serialisation IS the scheme's (RFC 8785 §3.2.2.3); `-0` writes as `0`.
      return String(value);
    case 'string':
      return writeString(value, where);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((element: unknown, index) => {
            if (element === undefined)
              throw new NotCanonical(`${where}[${index}] is undefined, which JSON cannot hold`);
            return write(element, depth + 1, `${where}[${index}]`);
          })
          .join(',')}]`;
      }
      if (!isPlainObject(value)) throw new NotCanonical(`${where} is not a plain object`);
      const record = value as Readonly<Record<string, unknown>>;
      const members = Object.keys(record)
        .filter(key => record[key] !== undefined)
        .toSorted()
        .map(key => `${writeString(key, `a key under ${where}`)}:${write(record[key], depth + 1, `${where}.${key}`)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new NotCanonical(`${where} is a ${typeof value}, which JSON cannot hold`);
  }
};

/** The one canonical spelling of `value`, or why it has none. Pure and total. */
export function canonicalJson(value: unknown): CanonicalJsonResult {
  try {
    return { ok: true, text: write(value, 0, 'the document') };
  } catch (error) {
    if (error instanceof NotCanonical) return { ok: false, reason: error.message };
    throw error;
  }
}
