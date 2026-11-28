/**
 * The word Runtimes stores for a harness (`harness: claude` in a login, runtime, instruction or settings file and in the
 * fleet manifest), and the ONE place that says which harnesses Runtimes has behaviour for.
 *
 * Why this file exists (runtimes plan U4b). The stored word is the harness's catalog half (`harnessFacts(key).catalogHalf`:
 * `claude` for the plugin `claude-code`, `codex` for `codex`), and it stays exactly what it was on disk: no value of any
 * file changes. A plugin key reaches Runtimes OPEN (`HarnessKey`); this file is the door, and a key it has no row for is
 * REFUSED by name ({@link unsupportedHarnessSentence}) and never quietly handed Claude's paths, flags or parser. What a
 * harness DOES inside Runtimes is its plugin's kit (`../../contract/harness-kit.ts`), looked up by {@link HarnessKind}; this
 * file only names which harnesses there are. Inside Runtimes a stored word is the closed type {@link HarnessKind} DERIVED from
 * the one table below, so the compiler lists every place a third harness still needs a row.
 *
 * A third harness arrives by adding its row to {@link KEY_OF_KIND}, and its plugin's kit.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import { harnessName, harnessWords, unsupportedHarnessSentence } from '../../contract/harness-words.ts';

/** What a harness is called when something refuses it: one sentence, written once. */
export { unsupportedHarnessSentence };

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
/** The plugin key of a shipped harness: the keys `KEY_OF_KIND` holds, which are the ones Runtimes can run. */
export type HarnessKeyOfKind = (typeof KEY_OF_KIND)[HarnessKind];

export const harnessKeyOfKind = (kind: HarnessKind): HarnessKeyOfKind => KEY_OF_KIND[kind];

/** The stored word a plugin key `K` names. */
export type KindOfKey<K> = { [Kind in HarnessKind]: (typeof KEY_OF_KIND)[Kind] extends K ? Kind : never }[HarnessKind];

/** The stored word of `harness` (a stored word or a plugin key), or `undefined` when Runtimes has no behaviour for it. */
export const kindOrUndefined = (harness: string): HarnessKind | undefined =>
  isSupportedKind(harness) ? harness : supportedKindOfKey(harness);

/** The stored word of `harness` (a stored word or a plugin key). Refuses a harness Runtimes has no behaviour for, by name. */
export const kindOf = (harness: string): HarnessKind => {
  const kind = kindOrUndefined(harness);
  if (kind === undefined) throw new UnsupportedHarnessError(harness);
  return kind;
};

/** The kit members a harness cannot be planned or launched without, by what each needs. */
type NeededMember = 'runtimeExtras' | 'fixedLayer' | 'ownedSkillEntries' | 'assets';

/** Claude Code's own model aliases, accepted by `--model` in place of a full id. */
const CLAUDE_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/**
 * Three facts about a harness that hold WHETHER OR NOT its plugin is on, so a kit cannot be where they are read from: a runtime
 * whose plugin is off is still planned and refused by name, and the plan it makes is byte for byte what it always was. They are
 * rows of this table of words (not behaviour), and the plugins' own kits say the same: a drift test per kit pins
 * `keepsSharedState` and the members each kit gives against this table.
 *  - `keepsSharedState`: its runtimes keep one state database in the shared history pool, so that directory is made for them.
 *  - `needs`: the kit members a runtime of it is refused without, to plan (`planned`) and then to launch (`launched`).
 *  - `ownsModel`: which model ids are its own, given an id in lower case without its context suffix. A harness whose plugin is off
 *    still owns them, so another harness's runtime never takes a model set that is not its own just because that plugin is off:
 *    a Claude id is `claude-…` or one of Claude Code's aliases; a Codex id is `gpt-…`, `codex-…` or an `o<n>…` reasoning model.
 */
const KIT_FACTS = {
  claude: {
    keepsSharedState: false,
    needs: { planned: [], launched: [] },
    ownsModel: (id: string) => id.startsWith('claude-') || CLAUDE_ALIASES.has(id),
  },
  codex: {
    keepsSharedState: true,
    ownsModel: (id: string) => id.startsWith('gpt-') || id.startsWith('codex-') || /^o\d/.test(id),
    needs: { planned: ['runtimeExtras', 'fixedLayer'], launched: ['ownedSkillEntries', 'assets'] },
  },
} as const satisfies Readonly<
  Record<
    HarnessKind,
    {
      readonly keepsSharedState: boolean;
      readonly ownsModel: (id: string) => boolean;
      readonly needs: { readonly planned: readonly NeededMember[]; readonly launched: readonly NeededMember[] };
    }
  >
>;

/** Whether runtimes of `kind` keep their state database in the shared history pool (made for them even when their plugin is off). */
export const keepsSharedStateOf = (kind: HarnessKind): boolean => KIT_FACTS[kind].keepsSharedState;

/** The harness that owns a model id (lower case, no context suffix), or `undefined` when none does: a third-party model. */
export const modelOwnerOf = (id: string): HarnessKind | undefined =>
  supportedKinds().find(kind => KIT_FACTS[kind].ownsModel(id));

/** The kit members a runtime of `kind` needs: to be planned, and then (`launched`) to be started. */
export const neededKitMembers = (kind: HarnessKind, stage: 'planned' | 'launched'): readonly NeededMember[] =>
  KIT_FACTS[kind].needs[stage];

/** What the product calls a harness ("Claude Code"): the contract's one table of words, so a daemon sentence and a surface say the same. */
export const displayNameOf = (kind: HarnessKind): string => harnessName(KEY_OF_KIND[kind]);

/** The short name of a harness for mid-sentence use ("Claude"), from the same table of words. */
export const shortNameOf = (kind: HarnessKind): string => harnessWords(KEY_OF_KIND[kind])?.short ?? KEY_OF_KIND[kind];

/** The folder in the person's home that a harness keeps its own setup in (`.claude`), from the contract's one table of words. */
export const hostFolderOf = (kind: HarnessKind): string => harnessWords(KEY_OF_KIND[kind])?.hostFolder ?? `.${kind}`;
