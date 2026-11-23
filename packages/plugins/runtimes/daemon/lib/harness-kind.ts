/**
 * The word Runtimes stores for a harness (`harness: claude` in a login, runtime, instruction or settings file and in the
 * fleet manifest), and the ONE place that says which harnesses Runtimes has behaviour for.
 *
 * Why this file exists (runtimes plan U4b). The stored word is the harness's catalog half (`harnessFacts(key).catalogHalf`:
 * `claude` for the plugin `claude-code`, `codex` for `codex`), and it stays exactly what it was on disk: no value of any
 * file changes. A plugin key reaches Runtimes OPEN (`HarnessKey`); this file is the door, and a key it has no row for is
 * REFUSED by name ({@link unsupportedHarnessSentence}) and never quietly handed Claude's paths, flags or parser. Runtimes'
 * own behaviour is written per harness (Claude's MCP shape, Codex's config.toml, each one's launch flags), so inside
 * Runtimes a stored word is the closed type {@link HarnessKind} DERIVED from the one table below: the compiler then lists
 * every place a third harness still needs a case, and every old `x === 'claude' ? <Claude> : <Codex>` is a
 * {@link byHarness} call that names both behaviours and refuses any other.
 *
 * A third harness arrives by adding its row to {@link KEY_OF_KIND} and its case to each {@link byHarness} call, and not before.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';

/** What a harness is called when something refuses it: one sentence, written once. */
export const unsupportedHarnessSentence = (word: string): string => `${word} is not supported here`;

/** Thrown where a harness Runtimes has no behaviour for reaches code that would otherwise have assumed one of two. */
export class UnsupportedHarnessError extends Error {
  constructor(readonly harness: string) {
    super(unsupportedHarnessSentence(harness));
    this.name = 'UnsupportedHarnessError';
  }
}

/** The plugin key each stored word names. The only table: its rows are the harnesses Runtimes has behaviour for. */
const KEY_OF_KIND = { claude: 'claude-code', codex: 'codex' } as const satisfies Readonly<Record<string, HarnessKey>>;

/** The stored word of a harness Runtimes can run: derived from the table, so no second list can drift from it. */
export type HarnessKind = keyof typeof KEY_OF_KIND;

/** The stored words of every harness Runtimes can run, in the order it lists them (Claude first). */
export const supportedKinds = (): readonly HarnessKind[] => Object.keys(KEY_OF_KIND) as HarnessKind[];

/** Whether Runtimes has behaviour for the stored word `kind`. */
export const isSupportedKind = (kind: string): kind is HarnessKind => Object.hasOwn(KEY_OF_KIND, kind);

/**
 * A `harness:` in an owner's file. Any other word parses as an issue worded {@link unsupportedHarnessSentence}, so the
 * loader names the file and keeps its last good version, exactly as it did for a word `z.enum` refused.
 */
export const HarnessKindSchema = z
  .string()
  .refine(isSupportedKind, { error: issue => unsupportedHarnessSentence(String(issue.input)) });

/** The stored word a plugin key names, or `undefined` when Runtimes has no behaviour for that key. */
export const supportedKindOfKey = (key: string): HarnessKind | undefined =>
  supportedKinds().find(word => KEY_OF_KIND[word] === key);

/** The harness a plugin key names, as Runtimes stores it. Refuses a key it has no behaviour for. */
export const harnessKindOfKey = (key: HarnessKey): HarnessKind => {
  const kind = supportedKindOfKey(key);
  if (kind === undefined) throw new UnsupportedHarnessError(key);
  return kind;
};

/** The plugin key a stored word names. */
export const harnessKeyOfKind = (kind: HarnessKind): (typeof KEY_OF_KIND)[HarnessKind] => KEY_OF_KIND[kind];

/** The behaviour of each harness Runtimes runs: both are written out, and any other harness is refused. */
export interface ByHarness<T> {
  readonly claude: () => T;
  readonly codex: () => T;
}

/**
 * Runs the case for `harness` (a stored word or a plugin key). A harness with no case THROWS
 * {@link UnsupportedHarnessError}: this replaces every `x === 'claude' ? <Claude> : <Codex>` and every `x !== 'claude'`
 * guard, which would have treated a third harness as one of the two.
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
 * Whether `harness` (a stored word or a plugin key) is exactly the harness `kind`. For a check that names ONE harness and
 * does nothing for the rest (a filter, an early return); a choice between harnesses is {@link byHarness}, never this.
 */
export const isKind = (harness: string, kind: HarnessKind): boolean =>
  harness === kind || supportedKindOfKey(harness) === kind;
