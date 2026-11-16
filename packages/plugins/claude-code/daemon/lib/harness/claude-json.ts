/**
 * The fixed keys a launch asserts in a ferret home's `.claude.json`, MERGED into the document that is already there —
 * the fixed-layer keys and the Chrome keys of today's wrapper seed (`fleet/src/lib/wrappers.ts`, `SEED_FILTER` /
 * `SEED_NEW_DOCUMENT`), copied; the API-key tail is seeded by the child, never here (`api-key-seed.ts`). Claude writes its
 * own decisions into the same document (`projects[<root>].disabledMcpjsonServers`, `enabledMcpjsonServers`, …), so a
 * launch that replaced it would undo a decision the person made in the previous session.
 *
 * Today's rules, leaf by leaf: a `true` is set; a number is a count the harness shows a screen until it reaches, so the
 * larger one is kept (jq's `[(.x // 0), n] | max`, whose order ranks a string, list or object above a number); an
 * object is walked into. A default (`CLAUDE_JSON_DEFAULTS`) is set only where the key is absent or `null`, so a value
 * the person chose stays. Every other key is kept as it is.
 *
 * A home with no document, or an empty or whitespace-only one, gets the fixed document whole (today's jq printed nothing
 * for an empty file, and that empty output was written back on every launch).
 *
 * A document that cannot be merged — not JSON, or a value where the walk needs an object — is LEFT AS IT IS, the way
 * today's jq run fails and discards its temporary file: nothing in it is dropped, and the launch goes on. MCP's
 * approvals read then answers `unreadable` for a document that is not JSON, and binds no project server (fail closed).
 */
import { CLAUDE_JSON_DEFAULTS, RELEASE_NOTES_KEY } from './fixed-layer.ts';

/**
 * Larger than any real one: a busy `.claude.json` runs to a few hundred kilobytes. The one limit for reading a home
 * document, by the launch merge and by MCP's approvals read alike.
 */
export const MAX_HOME_DOCUMENT_BYTES = 16 * 1024 * 1024;

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
 * Today's `if .x == null then .x = <default> else . end`, for each default: absent or `null` only. An object default is
 * walked into, so a leaf the person already set (even to another value) stays and only the missing ones are filled.
 */
function fillAbsent(target: JsonObject, defaults: { readonly [key: string]: Json }): void {
  for (const [key, value] of Object.entries(defaults)) {
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isObject(value) && isObject(current)) fillAbsent(current, value);
    else if (current === undefined || current === null) target[key] = value;
  }
}

function applyDefaults(target: JsonObject, version: string | undefined): void {
  fillAbsent(target, CLAUDE_JSON_DEFAULTS);
  // Not a choice anybody makes: the installed version, so an upgrade shows no "what's new" summary (re-seeded each launch).
  if (version !== undefined) target[RELEASE_NOTES_KEY] = version;
}

/**
 * The text to write for `.claude.json`, or `undefined` when nothing is to be written: the document already holds
 * every fixed key, or it cannot be merged (see the header). `existing` is the document on disk (`undefined` when there
 * is none); `fresh` is the fixed layer's whole document, which (with the defaults) is what a home with none, or an
 * empty one, gets. `version` is the installed Claude's, for `lastReleaseNotesSeen` (absent: that key is not asserted).
 */
export function mergeClaudeJson(
  existing: string | undefined,
  fresh: string,
  version?: string | undefined,
): string | undefined {
  const seed: unknown = JSON.parse(fresh);
  if (!isObject(seed)) throw new Error('the fixed .claude.json layer is not an object');
  if (existing === undefined || existing.trim() === '') {
    const document: JsonObject = { ...seed };
    applyDefaults(document, version);
    return `${JSON.stringify(document, null, 2)}\n`;
  }
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
  applyDefaults(target, version);
  const text = `${JSON.stringify(target, null, 2)}\n`;
  // Already seeded: an ordinary launch writes nothing (today's `SEEDED_ALREADY` check).
  return document !== null && JSON.stringify(target) === JSON.stringify(JSON.parse(existing)) ? undefined : text;
}
