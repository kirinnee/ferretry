/**
 * The fixed keys a launch asserts in a ferret home's `.claude.json`, MERGED into the document that is already there —
 * today's wrapper seed (`fleet/src/lib/wrappers.ts`, `SEED_FILTER` / `SEED_NEW_DOCUMENT`), copied. Claude writes its
 * own decisions into the same document (`projects[<root>].disabledMcpjsonServers`, `enabledMcpjsonServers`, …), so a
 * launch that replaced it would undo a decision the person made in the previous session.
 *
 * Today's rules, leaf by leaf: a `true` is set; a number is a count the harness shows a screen until it reaches, so the
 * larger one is kept (jq's `[(.x // 0), n] | max`, whose order ranks a string, list or object above a number); an
 * object is walked into. Every other key is kept as it is.
 *
 * A document that cannot be merged — not JSON, or a value where the walk needs an object — is LEFT AS IT IS, the way
 * today's jq run fails and discards its temporary file: nothing in it is dropped, and the launch goes on. MCP's
 * approvals read then answers `unreadable` for a document that is not JSON, and binds no project server (fail closed).
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = Record<string, Json>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** jq's `[(.x // 0), n] | max`: `null` and booleans sort below numbers, strings, lists and objects above them. */
function countLeaf(current: Json | undefined, seed: number): Json {
  if (typeof current === 'number') return Math.max(current, seed);
  if (current === undefined || current === null || typeof current === 'boolean') return seed;
  return current;
}

/** Walks `seed` into `target` in place; `false` when a value is in the way of an object the seed needs. */
function mergeInto(target: JsonObject, seed: JsonObject): boolean {
  for (const [key, value] of Object.entries(seed)) {
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isObject(value)) {
      if (current === undefined || current === null) {
        const fresh: JsonObject = {};
        if (!mergeInto(fresh, value)) return false;
        target[key] = fresh;
      } else if (isObject(current)) {
        if (!mergeInto(current, value)) return false;
      } else return false;
    } else if (typeof value === 'number') target[key] = countLeaf(current, value);
    else target[key] = value;
  }
  return true;
}

/**
 * The text to write for `.claude.json`, or `undefined` when nothing is to be written: the document already holds
 * every fixed key, or it cannot be merged (see the header). `existing` is the document on disk (`undefined` when there
 * is none); `fresh` is the fixed layer's whole document, which is what a home with none (or an empty one) gets.
 */
export function mergeClaudeJson(existing: string | undefined, fresh: string): string | undefined {
  const seed: unknown = JSON.parse(fresh);
  if (!isObject(seed)) throw new Error('the fixed .claude.json layer is not an object');
  if (existing === undefined || existing.trim() === '') return fresh;
  let document: unknown;
  try {
    document = JSON.parse(existing);
  } catch {
    // The parser's message can quote the document: it is left as it is, and nothing about it is said here.
    return undefined;
  }
  // jq treats a `null` document as an empty one.
  const target: JsonObject | undefined = document === null ? {} : isObject(document) ? document : undefined;
  if (target === undefined) return undefined;
  if (!mergeInto(target, seed)) return undefined;
  const text = `${JSON.stringify(target, null, 2)}\n`;
  // Already seeded: an ordinary launch writes nothing (today's `SEEDED_ALREADY` check).
  return document !== null && JSON.stringify(target) === JSON.stringify(JSON.parse(existing)) ? undefined : text;
}
