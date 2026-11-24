/**
 * What Runtimes' surfaces (the app, the CLI) say about a harness, and the ONE sentence for a harness they cannot show.
 *
 * Why this file exists (runtimes plan U4b). A harness key reaches a surface OPEN (`HarnessKey`), so a surface never indexes a
 * table by it and never reads "not Claude" as "Codex". It asks {@link harnessWords} for the words, and a key with no row is
 * shown as unusable with {@link unsupportedHarnessSentence} and never offered Claude's controls. The daemon's
 * `harness-kind.ts` says the same sentence through this function, so the wording exists once.
 *
 * A third harness arrives by adding its row to {@link HARNESS_WORDS} (and its case in the daemon's `harness-kind.ts`).
 */

/** What a harness is called when something refuses it: one sentence, written once. */
export const unsupportedHarnessSentence = (word: string): string => `${word} is not supported here`;

/** The words one harness is read by. */
export interface HarnessWords {
  /** What a person reads: "Claude Code". */
  readonly name: string;
  /** The short name used mid-sentence: "Claude settings will be skipped on Codex". */
  readonly short: string;
  /** The word a runtime's suggested name starts with (the CLI's own name): `claude-default`. */
  readonly commandWord: string;
  /**
   * How a running ferret's model is switched in place: `allowlist` (the wrapper's own list of models, one step, a custom id
   * where the login's provider takes one) or `two-step` (the app-server's model list, then a reasoning level).
   */
  readonly picker: 'allowlist' | 'two-step';
  /** The folder in the person's home the harness keeps its own setup in, as the import wizard names it. */
  readonly hostFolder: string;
}

/** The harnesses Runtimes has behaviour for, by plugin key, in the order its surfaces list them (Claude Code first). */
const HARNESS_WORDS = {
  'claude-code': {
    name: 'Claude Code',
    short: 'Claude',
    commandWord: 'claude',
    picker: 'allowlist',
    hostFolder: '.claude',
  },
  codex: { name: 'Codex', short: 'Codex', commandWord: 'codex', picker: 'two-step', hostFolder: '.codex' },
} as const satisfies Readonly<Record<string, HarnessWords>>;

/** The key of a harness Runtimes has behaviour for: derived from the table, so no second list can drift from it. */
export type SupportedHarnessKey = keyof typeof HARNESS_WORDS;

/**
 * Whether Runtimes has behaviour for the harness `key`. A consumer that still holds its own closed type for the shipped
 * harnesses (until its own part of the sweep) narrows an open key with this and refuses the rest.
 */
export const isSupportedHarnessKey = (key: string): key is SupportedHarnessKey => Object.hasOwn(HARNESS_WORDS, key);

/** The words of a harness Runtimes has behaviour for, or `undefined` for any other key: show that one as unusable. */
export const harnessWords = (key: string): HarnessWords | undefined =>
  isSupportedHarnessKey(key) ? HARNESS_WORDS[key] : undefined;

/** A harness's name as a person reads it; a key with no row is shown as it is. */
export const harnessName = (key: string): string => harnessWords(key)?.name ?? key;

/** The keys of the harnesses Runtimes has behaviour for, in the order its surfaces list them. */
export const supportedHarnessKeys = (): readonly SupportedHarnessKey[] =>
  Object.keys(HARNESS_WORDS) as SupportedHarnessKey[];
