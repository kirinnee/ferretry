/**
 * Which API keys a repeat copy offers again, decided from TIMESTAMPS ALONE (docs/secrets.md, "Sign-ins are
 * not copied; API keys are"; docs/design/account-model.md §3.8).
 *
 * A key a copy filed here is remembered by two instants: when the SOURCE last changed it (`updatedAt` in its
 * secrets list) and when THIS machine did (the same field here, right after the sealed copy landed). A later
 * copy compares those two with what each side lists now:
 *
 * | the source…            | this machine…                      | outcome   |
 * | ---------------------- | ---------------------------------- | --------- |
 * | holds it, we do not    | —                                  | `missing` |
 * | changed it since       | has not changed it since           | `newer`   |
 * | changed it since       | changed it since                   | `both`    |
 * | has not changed it     | (any), or there is no earlier copy | `same`    |
 *
 * **No value and no digest of a value is ever compared, stored or returned**: not here, not in the record,
 * not in the review. A secret's value does not reach this module at all — it is handed names and instants.
 * A name that cannot be copied (a sign-in's) is not an outcome: it is left out, so no review ever names one.
 */
import type { Instant } from '@ferretry/std';
import { type CloneReviewKey, CloneableSecretNameSchema } from '../../../contract/index.ts';
import { type CloneBase, CloneSourceIdSchema } from './clone-base.ts';

/** A secret as its list shows it: a name and when it last changed. Never a value. */
export interface HeldKey {
  readonly name: string;
  readonly updatedAt: string;
}

export interface CloneKeyInputs {
  /** What the source's secrets list shows. */
  readonly source: readonly HeldKey[];
  /** What this machine's secrets list shows. */
  readonly target: readonly HeldKey[];
  /** The names a copy of this bundle would spend (its API-key logins' references). Only these can be `missing`. */
  readonly wanted: Iterable<string>;
  /** What the last copy from this source recorded. */
  readonly recorded: NonNullable<CloneBase['sources'][string]['keys']> | undefined;
}

const instant = (text: string): number => Date.parse(text);

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * How each key the review concerns stands, sorted by name. The concern is the keys the bundle's logins
 * name that the source holds, and every key a copy from this source recorded before. A key only this
 * machine holds is no concern: there is nothing on the source to copy.
 */
export function classifyCloneKeys(input: CloneKeyInputs): CloneReviewKey[] {
  const sourceAt = new Map(input.source.map(key => [key.name, key.updatedAt] as const));
  const targetAt = new Map(input.target.map(key => [key.name, key.updatedAt] as const));
  const concern = new Set([...input.wanted, ...Object.keys(input.recorded ?? {})]);
  const keys: CloneReviewKey[] = [];
  for (const name of [...concern].toSorted()) {
    const parsed = CloneableSecretNameSchema.safeParse(name);
    const there = sourceAt.get(name);
    if (!parsed.success || there === undefined) continue;
    const here = targetAt.get(name);
    if (here === undefined) {
      keys.push({ name: parsed.data, outcome: 'missing' });
      continue;
    }
    const before = own(input.recorded, name);
    // No earlier copy of this key, or a timestamp that does not read: nothing says the source moved on.
    const newerThere = before !== undefined && instant(there) > instant(before.sourceUpdatedAt);
    const changedHere = before !== undefined && instant(here) !== instant(before.targetUpdatedAt);
    keys.push({ name: parsed.data, outcome: newerThere ? (changedHere ? 'both' : 'newer') : 'same' });
  }
  return keys;
}

/** One key's pair of instants, as the record holds it. */
export interface RecordedKey {
  readonly name: string;
  readonly sourceUpdatedAt: Instant;
  readonly targetUpdatedAt: Instant;
}

/**
 * The record once a sealed copy has filed these keys from one source. Only that source's `keys` change,
 * only for the names given; every other source, item and key is exactly as it was. A source the record
 * does not hold is left unrecorded: there is nothing it could link a later copy to, and the keys would
 * outlive the copy they belong to.
 */
export function recordCloneKeys(previous: CloneBase, sourceId: string, recorded: readonly RecordedKey[]): CloneBase {
  if (!CloneSourceIdSchema.safeParse(sourceId).success || !Object.hasOwn(previous.sources, sourceId)) return previous;
  const source = previous.sources[sourceId];
  if (source === undefined || recorded.length === 0) return previous;
  const keys: Record<string, { sourceUpdatedAt: Instant; targetUpdatedAt: Instant }> = Object.create(null) as Record<
    string,
    { sourceUpdatedAt: Instant; targetUpdatedAt: Instant }
  >;
  for (const [name, at] of Object.entries(source.keys ?? {})) keys[name] = at;
  for (const key of recorded) {
    if (!CloneableSecretNameSchema.safeParse(key.name).success) continue;
    keys[key.name] = { sourceUpdatedAt: key.sourceUpdatedAt, targetUpdatedAt: key.targetUpdatedAt };
  }
  return {
    ...previous,
    sources: { ...previous.sources, [sourceId]: { ...source, keys: { ...keys } } },
  };
}
