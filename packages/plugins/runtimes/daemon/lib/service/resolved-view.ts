/**
 * A resolved profile as the Resolved view reads it (R5): every FINAL value one harness gets, the
 * content item it came from, and the earlier values it overrode.
 *
 * The layering module decides what wins (`resolveProfile`, §3.4); this only says it value by value,
 * so the browser draws the merge without a second reading of the merge rules. `from` is always the
 * profile's OWN content item that brought a value in — a component it names, or the `profile/<name>`
 * the value arrived through — because that is the row a person drags.
 *
 * NO SECRET LEAVES. A settings or environment value that looks like a credential, and an MCP argument
 * that does, is replaced by `‹hidden›` and marked `hidden`, the same rule the component content
 * follows. A launch flag or an MCP argument that carries a credential as a flag's value
 * (`--token=v`, `--token v`, `-k=v`, `-Hv`) keeps its flag and loses only the value. An MCP
 * server's own environment is never listed, and a URL loses its query and its user.
 *
 * Pure.
 */
import { type Conflict, type FlatLayer, type ResolvedProfile, settingsKey } from '../account/layering.ts';
import { harnessKey } from './foreign.ts';
import { looksSecret } from '../account/import.ts';
import type { ResolvedEntry, ResolvedField, ResolvedSetter } from '../../../contract/index.ts';

/** What a hidden value is replaced by. */
const RESOLVED_HIDDEN_TEXT = '‹hidden›';

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** A value in words, hidden when it looks like a credential under this name. */
function said(name: string, value: unknown): Pick<ResolvedSetter, 'value' | 'hidden'> {
  const text = shown(value);
  return looksSecret(name, text) ? { value: RESOLVED_HIDDEN_TEXT, hidden: true } : { value: text };
}

/** Where a server is reached, without a query, a fragment or a user in it. */
function bareUrl(text: string): string {
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`;
  } catch {
    return RESOLVED_HIDDEN_TEXT;
  }
}

// ── Command lines ────────────────────────────────────────────────────────────────────────────────
//
// A launch flag and an MCP argument are words of a command line, and a credential sits in one in
// three ways: a word that IS a token (`sk-…`), a value glued to its flag (`--token=v`, `-k=v`,
// `--token v` written as one word, `-Hv`), and the word after a flag (`--token`, `v`). The name
// is the flag's (`looksSecret` reads `--api-key` as the words API and KEY, so dashes need no
// stripping); the value is unquoted first, so `--token="$TOKEN"` stays the pointer it is; and a
// token is looked for at the start of every piece of the value, so `--header=Bearer sk-…` is caught
// under a harmless name. Only the VALUE is replaced: the flag's own spelling stays, because that is
// what tells a person which flag it is.
//
// Every word today hid is still hidden: such a word starts with a token prefix, so it is no flag and
// reaches the last test, whose `looksSecret` under any name hides at least what it hides under none.

/** A word that is a flag on its own: one or two dashes and a name, with no value in it. */
const FLAG_WORD = /^-{1,2}[A-Za-z0-9][^=\s]*$/u;

/** A flag and its value in one word, glued by `=` or by spaces: `--token=v`, `-k=v`, `--token v`. */
const GLUED_VALUE = /^(-{1,2}[A-Za-z0-9][^=\s]*)(=|\s+)([\s\S]*)$/u;

/** A one-letter flag with its value stuck straight to it: `-Hv`. */
const STUCK_VALUE = /^(-[A-Za-z])([^-=\s][\s\S]*)$/u;

/** What splits a value into the pieces a token may start at: spaces, quotes and separators. */
const PIECE_BREAK = /[\s"'`:,;=]+/u;

/** A value without one pair of matching quotes around it. */
const unquoted = (value: string): string => /^(["'])([\s\S]*)\1$/u.exec(value)?.[2] ?? value;

/** Whether a flag's value looks like a credential under the flag's name, or holds a token. */
function secretValue(name: string, value: string): boolean {
  return looksSecret(name, unquoted(value)) || value.split(PIECE_BREAK).some(piece => looksSecret('', piece));
}

interface ShownWord {
  readonly text: string;
  readonly hidden: boolean;
}

/** One command-line word as it may be shown, judged with the word before it. */
function shownWord(word: string, before: string | undefined): ShownWord {
  const hidden = (text: string): ShownWord => ({ text, hidden: true });
  const glued = GLUED_VALUE.exec(word);
  if (glued !== null) {
    const [, flag = '', separator = '', value = ''] = glued;
    if (secretValue(flag, value)) return hidden(`${flag}${separator}${RESOLVED_HIDDEN_TEXT}`);
  }
  const stuck = STUCK_VALUE.exec(word);
  if (stuck !== null && secretValue('', stuck[2] ?? '')) return hidden(`${stuck[1] ?? ''}${RESOLVED_HIDDEN_TEXT}`);
  const name = before !== undefined && FLAG_WORD.test(before) && !word.startsWith('-') ? before : '';
  return secretValue(name, word) ? hidden(RESOLVED_HIDDEN_TEXT) : { text: word, hidden: false };
}

/** A command line's words as they may be shown, in order. */
const shownWords = (words: readonly string[]): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, words[index - 1]));

/** How an MCP server starts: its command line, any credential in it hidden. */
function serverLine(server: {
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
}): string {
  if (server.url !== undefined) return bareUrl(server.url);
  const words = [server.command ?? '', ...(server.args ?? [])].filter(word => word !== '');
  return shownWords(words)
    .map(word => word.text)
    .join(' ');
}

/** One launch flag as it may be shown, judged with the flag before it on the command line. */
function flagValue(flag: string, before: string | undefined): Pick<ResolvedSetter, 'value' | 'hidden'> {
  const word = shownWord(flag, before);
  return word.hidden ? { value: word.text, hidden: true } : { value: word.text };
}

/**
 * One harness's final values, in merge order: instructions, MCP servers, skills, settings keys,
 * environment, flags, hooks, then the model.
 */
export function resolvedEntries(resolved: ResolvedProfile): readonly ResolvedEntry[] {
  const { harness } = resolved;
  const beaten = (field: Conflict['field'], key: string): readonly ResolvedSetter[] =>
    resolved.conflicts
      .filter(conflict => conflict.field === field && conflict.key === key)
      .flatMap(conflict =>
        conflict.overridden.map(setter => ({ ...said(key, setter.value), from: setter.layer.origin })),
      );
  const entry = (
    field: ResolvedField,
    key: string,
    value: Pick<ResolvedSetter, 'value' | 'hidden'>,
    layer: FlatLayer,
    overridden: readonly ResolvedSetter[] = [],
  ): ResolvedEntry => ({ harness: harnessKey(harness), field, key, ...value, from: layer.origin, overridden });

  return [
    ...resolved.instructions.map(({ layer, component }) =>
      entry('instructions', layer.name, { value: component.file ?? `instructions/${layer.name}` }, layer),
    ),
    ...resolved.mcp.map(({ layer, component }) => entry('mcp', layer.name, { value: serverLine(component) }, layer)),
    ...resolved.skills.map(({ item, layer }) => entry('skills', item, { value: 'included' }, layer)),
    ...resolved.settings.leaves.map(leaf =>
      entry('settings', leaf.key, said(leaf.key, leaf.value), leaf.layer, beaten('settings', leaf.key)),
    ),
    ...Object.entries(resolved.env).map(([name, { value, layer }]) => {
      const key = settingsKey(['env', name]);
      return entry('env', key, said(name, value), layer, beaten('env', key));
    }),
    ...resolved.flags.map(({ flag, layer }, index) =>
      entry('flags', 'flag', flagValue(flag, resolved.flags[index - 1]?.flag), layer),
    ),
    ...resolved.hooks.map(({ layer, component }) =>
      entry('hooks', layer.name, { value: component.file ?? component.directory ?? 'a hooks document' }, layer),
    ),
    ...(resolved.modelSet.source === 'model-set'
      ? [
          entry(
            'model',
            'model',
            { value: resolved.modelSet.declaredDefault },
            resolved.modelSet.layer,
            beaten('model', 'model'),
          ),
        ]
      : []),
  ];
}
