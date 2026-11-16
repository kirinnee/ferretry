/**
 * What a patch of top-level keys makes of a config value — the one rule the real writer (`./service.ts`) and the
 * testing host both apply, so the two can never disagree about what an edit means.
 *
 * - A key the patch gives a value is set to it; a key it gives `undefined` is removed; every other key stays.
 * - A key named in `within` (only `ConfigPort.writeAsOwner` passes one) whose new value is a mapping MERGES into the
 *   mapping already there ONE level deep: each sub-key the patch names is replaced (`undefined` removes it), and every
 *   sub-key it does not name is kept. A sub-key's value is replaced whole, never merged further.
 * - A named key whose new value is not a mapping (a scalar, a list, `null`), or whose current value is not one (absent,
 *   a scalar, a list), is replaced as a plain patch replaces it; the schema then judges the result like any other edit.
 *
 * - What a merge extends is the mapping the file ITSELF holds (`base`, the file's own value when the caller has one
 *   apart from `current`): a section the file lacks is not given the schema's defaults by a merge, so an unchanged
 *   default stays unwritten, exactly as a plain patch of that section would leave it.
 * - NOTE (pinned in `owner-write-within.test.ts`): a section the file lacks is merged from nothing, so a sub-key the
 *   patch does not name reads as ITS OWN default afterwards. Where a section's default differs from its sub-keys'
 *   defaults the unnamed sub-key changes meaning. No declared schema has that shape; a schema that does must name every
 *   sub-key it cares about in the patch.
 *
 * The result is built from entries, never by assignment, so a key spelled `__proto__` is an ordinary key (a value
 * inherited from the prototype has no entries of its own, so nothing is merged from one).
 */
export function patchedValue(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  within: readonly string[] = [],
  base: Readonly<Record<string, unknown>> = current,
): Record<string, unknown> {
  // A `within` that is not a list (untyped JS) names nothing: a string must never be read as its letters.
  const named = new Set(Array.isArray(within) ? within : []);
  const entries = new Map(Object.entries(current));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) entries.delete(key);
    else entries.set(key, named.has(key) ? mergedMapping(base[key], value) : value);
  }
  return Object.fromEntries(entries);
}

/** Whether `within` is what the contract says: absent, or a list. Anything else is refused by the writers, not guessed at. */
export const isWithinList = (within: unknown): boolean => within === undefined || Array.isArray(within);

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One level: `change`'s sub-keys over `existing`'s, `undefined` removing one; anything but two mappings is `change`. */
function mergedMapping(existing: unknown, change: unknown): unknown {
  if (!isMapping(change)) return change;
  const entries = new Map(Object.entries(isMapping(existing) ? existing : {}));
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) entries.delete(key);
    else entries.set(key, value);
  }
  return Object.fromEntries(entries);
}
