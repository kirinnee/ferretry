/**
 * The two pure decisions the secret subsystem rests on: what a reference resolves to, and what a
 * value looks like once it has been scrubbed out of text.
 *
 * BOTH FAIL CLOSED. An unresolvable reference REFUSES rather than substituting an empty string —
 * `curl -H "Authorization: Bearer "` is a 401 twenty minutes later with nothing to point at, which is
 * exactly the confusing-failure-much-later shape this module exists to prevent. And redaction masks
 * every occurrence of every known value, so a value that appears in text nobody expected it in is
 * still masked.
 */

import { type SecretName, secretMask, secretReferencePattern, secretReferencesIn } from '@ferretry/protocol';
import { UnknownSecretError } from './types.ts';

/** Where a configured recipe lives, spelled the way an operator would go and find it. */
export function recipeOrigin(key: string): string {
  return `config/daemon.json → secretEnvironment.${key}`;
}

/**
 * Every secret the operator's recipes name, with the entry each came from.
 *
 * This is what turns "a missing secret fails at launch" into something a person can SEE beforehand:
 * the management surface lists each reference and whether the store holds it.
 */
export function configuredReferences(
  recipes: Readonly<Record<string, string>>,
): readonly { readonly name: SecretName; readonly origin: string }[] {
  return Object.entries(recipes).flatMap(([key, value]) =>
    secretReferencesIn(value).map(name => ({ name, origin: recipeOrigin(key) })),
  );
}

/**
 * One configured value with every `${secret:NAME}` replaced by the value it names.
 *
 * Raises `UnknownSecretError` naming EVERY missing secret rather than the first: a person fixing a
 * configuration wants the whole list, and reporting one at a time turns one mistake into four
 * round trips.
 */
export function expandSecretReferences(value: string, values: ReadonlyMap<SecretName, string>): string {
  const missing: SecretName[] = [];
  const expanded = value.replace(secretReferencePattern(), (_match, name: string) => {
    const resolved = values.get(name);
    if (resolved === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return resolved;
  });
  if (missing.length > 0) throw new UnknownSecretError(missing);
  return expanded;
}

/**
 * The environment a use child is given: the secrets it named, exported under their own names, plus
 * the caller's extra entries with their references expanded.
 *
 * THE NAMED SECRETS ARE APPLIED FIRST so a caller's own `env` entry can override the plain export
 * with a composed one (`AUTH=Bearer ${secret:TOKEN}`) without needing a second request field.
 *
 * A named secret that does not exist REFUSES here, before anything is spawned. That is the loud
 * failure the brief asks for: a child launched with an empty string in place of a credential fails
 * somewhere else entirely, with an error about the remote service rather than about the vault.
 */
export function resolveChildEnvironment(
  named: readonly SecretName[],
  configured: Readonly<Record<string, string>>,
  values: ReadonlyMap<SecretName, string>,
): Readonly<Record<string, string>> {
  const missing = named.filter(name => !values.has(name));
  if (missing.length > 0) throw new UnknownSecretError(missing);
  const environment: Record<string, string> = {};
  for (const name of named) {
    const value = values.get(name);
    // Unreachable while the filter above stands; kept as a total function rather than an assertion,
    // because the alternative is a non-null claim that becomes wrong the moment somebody reorders.
    if (value !== undefined) environment[name] = value;
  }
  for (const [key, raw] of Object.entries(configured)) environment[key] = expandSecretReferences(raw, values);
  return environment;
}

/**
 * Which configured entries a request has earned.
 *
 * An operator's `secretEnvironment` recipe is only injected when EVERY secret it names is one the
 * caller explicitly asked for. Without that rule a recipe referencing `PRODUCTION_KEY` would be
 * handed to a child that only asked for `STAGING_KEY`, and the operator's convenience would have
 * silently widened the caller's request into a leak.
 */
export function earnedRecipes(
  recipes: Readonly<Record<string, string>>,
  named: readonly SecretName[],
): Readonly<Record<string, string>> {
  const allowed = new Set<string>(named);
  return Object.fromEntries(
    Object.entries(recipes).filter(([, value]) =>
      [...value.matchAll(secretReferencePattern())].every(match => allowed.has(match[1] ?? '')),
    ),
  );
}

/**
 * Every known secret value in `text`, replaced by its mask.
 *
 * LONGEST FIRST. Two secrets where one is a substring of the other — a token and the same token with
 * a prefix — would otherwise mask the short one inside the long one and leave the remaining
 * characters of the long one in plain view.
 *
 * WHAT THIS CATCHES: an agent or tool that incidentally prints a value, an error message that quotes
 * a request header, a credential echoed by a shell trace.
 *
 * WHAT IT CANNOT CATCH: a value the caller TRANSFORMED first. `echo $KEY | base64` produces text
 * that shares no substring with the secret, and no scrubber can recognise an encoding it was not
 * told about. The boundary this draws is against accidents and casual reading, not against a holder
 * of the capability who is trying to get the value out. Say so wherever this promise is made.
 */
export function redactSecretValues(text: string, values: ReadonlyMap<SecretName, string>): string {
  const ordered = [...values.entries()].sort(([, a], [, b]) => b.length - a.length);
  let result = text;
  for (const [name, value] of ordered) result = result.split(value).join(secretMask(name));
  return result;
}

/** JSON data with every string inside it scrubbed, structure untouched, so a redacted tool result is
 *  still the shape its reader parses. */
export function redactJsonValue(value: unknown, values: ReadonlyMap<SecretName, string>): unknown {
  if (typeof value === 'string') return redactSecretValues(value, values);
  if (Array.isArray(value)) return value.map(item => redactJsonValue(item, values));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactJsonValue(item, values)]),
    );
  return value;
}
