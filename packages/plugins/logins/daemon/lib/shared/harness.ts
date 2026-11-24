import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import { unsupportedHarnessSentence } from '../../../contract/harness-words.ts';

/**
 * Which harness a login signs in, as the daemon reasons about it: the word a login file, a preset and a model catalog store
 * (`claude`, `codex`, which are also the keys of their `claude:` / `codex:` halves). The harness PLUGIN keys (`claude-code`,
 * `codex`) are what the wire and the ferrets API carry, and {@link harnessKey} / {@link harnessKind} convert at exactly that
 * boundary.
 *
 * Why it is one table (runtimes plan U4b). The stored word is DERIVED from {@link KEY_OF_KIND}, so no value on disk changes and
 * no second list can drift from it. A key this table has no row for is REFUSED by name ({@link unsupportedHarnessSentence}) and
 * never quietly handed Claude's paths, flags or parser: the compiler lists every {@link byHarness} call a third harness needs
 * a case in, and every old `kind === 'claude' ? <Claude> : <Codex>` is such a call, which refuses any other.
 */
export { unsupportedHarnessSentence };

/** Thrown where a harness Logins has no behaviour for reaches code that would otherwise have assumed one of two. */
export class UnsupportedHarnessError extends Error {
  constructor(readonly harness: string) {
    super(unsupportedHarnessSentence(harness));
    this.name = 'UnsupportedHarnessError';
  }
}

/** The plugin key each stored word names. The only table: its rows are the harnesses Logins has behaviour for. */
const KEY_OF_KIND = { claude: 'claude-code', codex: 'codex' } as const satisfies Readonly<Record<string, HarnessKey>>;

/** The stored word of a harness Logins can serve: derived from the table. */
export type HarnessKind = keyof typeof KEY_OF_KIND;

/** The stored words of every harness Logins serves, Claude first. */
export const supportedKinds = (): readonly HarnessKind[] => Object.keys(KEY_OF_KIND) as HarnessKind[];

/** Whether Logins has behaviour for the stored word `kind`. */
export const isSupportedKind = (kind: string): kind is HarnessKind => Object.hasOwn(KEY_OF_KIND, kind);

/**
 * A stored `harness:` word. Any other word parses as an issue worded {@link unsupportedHarnessSentence}, so the loader names
 * the file exactly as it did for a word `z.enum` refused.
 */
export const HarnessKindSchema = z
  .string()
  .refine(isSupportedKind, { error: issue => unsupportedHarnessSentence(String(issue.input)) })
  .transform(word => word as HarnessKind);

/** The stored word a plugin key names, or `undefined` when Logins has no behaviour for that key. */
export const supportedKindOfKey = (key: string): HarnessKind | undefined =>
  supportedKinds().find(word => KEY_OF_KIND[word] === key);

/** The plugin key of a shipped harness: the keys {@link KEY_OF_KIND} holds. */
export type HarnessKeyOfKind = (typeof KEY_OF_KIND)[HarnessKind];

/** The harness plugin's key for a stored word. */
export const harnessKey = (kind: HarnessKind): HarnessKeyOfKind => KEY_OF_KIND[kind];

/** The stored word a harness plugin's key names. Refuses a key Logins has no behaviour for. */
export const harnessKind = (key: HarnessKey): HarnessKind => {
  const kind = supportedKindOfKey(key);
  if (kind === undefined) throw new UnsupportedHarnessError(key);
  return kind;
};

/** The behaviour of each harness Logins serves: both are written out, and any other harness is refused. */
export interface ByHarness<T> {
  readonly claude: () => T;
  readonly codex: () => T;
}

/**
 * Runs the case for `harness` (a stored word or a plugin key). A harness with no case THROWS
 * {@link UnsupportedHarnessError}: this replaces every `x === 'claude' ? <Claude> : <Codex>`, which would have treated a
 * third harness as one of the two.
 */
export function byHarness<T>(harness: string, cases: ByHarness<T>): T {
  const kind = isSupportedKind(harness) ? harness : supportedKindOfKey(harness);
  switch (kind) {
    case 'claude':
      return cases.claude();
    case 'codex':
      return cases.codex();
    default:
      throw new UnsupportedHarnessError(harness);
  }
}

/**
 * Whether a record tagged with a stored word is exactly the member for `kind`, narrowing it to that member. For a check that
 * names ONE harness and does nothing for the rest (a filter, an early return); a choice between harnesses is
 * {@link byHarness} or a `switch` with a refusing default, never this.
 */
export const isHarness = <T extends { readonly harness: HarnessKind }, K extends HarnessKind>(
  value: T,
  kind: K,
): value is Extract<T, { readonly harness: K }> => value.harness === kind;

/** Whether `harness` (a stored word or a plugin key, any key at all) is exactly the harness `kind`. */
export const isKind = (harness: string, kind: HarnessKind): boolean =>
  harness === kind || supportedKindOfKey(harness) === kind;

/**
 * The refusing `default:` of a `switch` over a stored harness word whose cases are every harness Logins serves: the
 * compiler narrows the value to `never` once each has its case, so a third harness cannot compile in without one, and a
 * hand-built value that still reaches it is refused by name instead of falling into the last case. Used where a value
 * comes in from outside the records Logins builds itself; a record Logins built was already refused at its entry
 * ({@link harnessKind}, {@link byHarness}, {@link HarnessKindSchema}).
 */
export const refuseHarness = (value: never): never => {
  throw new UnsupportedHarnessError(String((value as { readonly harness?: unknown } | undefined)?.harness ?? value));
};
