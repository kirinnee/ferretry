/**
 * What Logins says about a harness, in the contract, the app and the CLI, and the ONE sentence for a harness it cannot serve.
 *
 * Why this file exists (runtimes plan U4b). A harness key reaches Logins OPEN (`HarnessKey`, the plugin's id), so nothing
 * here indexes a table by it and nothing reads "not Claude" as "Codex". A caller asks {@link harnessWords} and a key with
 * no row is REFUSED with {@link unsupportedHarnessSentence}: never given Claude's sign-in, paths, flags or parser.
 *
 * The stored words do not move. A login file, a preset and a model catalog keep a `claude:` / `codex:` half and a
 * `harness: claude` word on disk; {@link HarnessWords.half} is that word, read from this table exactly as before.
 *
 * A third harness arrives by adding its row to {@link HARNESS_WORDS} (and its case in the daemon's `lib/shared/harness.ts`).
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';

/** What a harness is called when something refuses it: one sentence, written once. */
export const unsupportedHarnessSentence = (word: string): string => `${word} is not supported here`;

/** The words one harness is read by. */
export interface HarnessWords {
  /** What a person reads: "Claude Code". */
  readonly name: string;
  /** The short name used mid-sentence and on a scope chip: "Claude only". */
  readonly short: string;
  /** The CLI's own command, which also starts a login's suggested id: `claude-work`. */
  readonly commandWord: string;
  /** One line a choice card says about the harness: "Anthropic’s coding agent". */
  readonly blurb: string;
  /** The stored word and the key of this harness's half in a login, a preset and a model catalog (`claude`, `codex`). */
  readonly half: string;
}

/** The harnesses Logins has behaviour for, by plugin key, in the order its surfaces list them (Claude Code first). */
const HARNESS_WORDS = {
  'claude-code': {
    name: 'Claude Code',
    short: 'Claude',
    commandWord: 'claude',
    blurb: 'Anthropic’s coding agent',
    half: 'claude',
  },
  codex: { name: 'Codex', short: 'Codex', commandWord: 'codex', blurb: 'OpenAI’s coding agent', half: 'codex' },
} as const satisfies Readonly<Record<string, HarnessWords>>;

/** The key of a harness Logins has behaviour for: derived from the table, so no second list can drift from it. */
export type SupportedHarnessKey = keyof typeof HARNESS_WORDS;

/** The stored word of a harness Logins has behaviour for (`claude`, `codex`), derived from the same table. */
export type HarnessHalf = (typeof HARNESS_WORDS)[SupportedHarnessKey]['half'];

/** Whether Logins has behaviour for the harness `key`. */
export const isSupportedHarnessKey = (key: string): key is SupportedHarnessKey => Object.hasOwn(HARNESS_WORDS, key);

/** The words of a harness Logins has behaviour for, or `undefined` for any other key: refuse that one. */
export const harnessWords = (key: string): HarnessWords | undefined =>
  isSupportedHarnessKey(key) ? HARNESS_WORDS[key] : undefined;

/** A harness's name as a person reads it; a key with no row is shown as it is. */
export const harnessName = (key: string): string => harnessWords(key)?.name ?? key;

/** The keys of the harnesses Logins has behaviour for, in the order its surfaces list them. */
export const supportedHarnessKeys = (): readonly SupportedHarnessKey[] =>
  Object.keys(HARNESS_WORDS) as SupportedHarnessKey[];

/**
 * A harness key on Logins' wire: the plugin's id, shaped as any harness key is, and REFUSED (worded
 * {@link unsupportedHarnessSentence}) unless Logins has behaviour for it. The refusal is the same one a key this build
 * does not ship got before; what changed is that the list it checks is the table above and not a closed type.
 */
export const HarnessKeyOnWireSchema = z.custom<HarnessKey>(
  value => typeof value === 'string' && isSupportedHarnessKey(value),
  {
    error: issue => unsupportedHarnessSentence(String(issue.input)),
  },
);

/** The stored word of a harness Logins has behaviour for (`claude`, `codex`). */
export const harnessHalf = (key: SupportedHarnessKey): HarnessHalf => HARNESS_WORDS[key].half;

/**
 * Whether a record tagged with a harness key (a sign-in flow on the wire) is exactly the member for `key`, narrowing it to
 * that member. For a check that names ONE harness and does nothing for the rest; a choice between harnesses is a `switch`
 * over `harness` whose `default` refuses, never this.
 */
export const isHarnessKey = <T extends { readonly harness: string }, K extends SupportedHarnessKey>(
  value: T,
  key: K,
): value is T & { readonly harness: K } => value.harness === key;

/** The CLI's command word of a harness Logins has behaviour for; any other key is REFUSED, never given Claude's. */
export const harnessCommandWord = (key: string): string => {
  const words = harnessWords(key);
  if (words === undefined) throw new Error(unsupportedHarnessSentence(key));
  return words.commandWord;
};

/** The harness whose CLI command is `command` (`claude`, `codex`), or `undefined`: a panel subject names a tool this way. */
export const harnessKeyOfCommand = (command: string): SupportedHarnessKey | undefined =>
  supportedHarnessKeys().find(key => HARNESS_WORDS[key].commandWord === command);

/** The harness a person's word names: its plugin key (`claude-code`) or its command (`claude`), or `undefined`. */
export const harnessKeyOfWord = (word: string): SupportedHarnessKey | undefined => {
  const spelled = word.trim().toLowerCase();
  return supportedHarnessKeys().find(key => key === spelled || HARNESS_WORDS[key].commandWord === spelled);
};
