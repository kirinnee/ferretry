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
 * (`--token=v`, `--token v`, `-k=v`, `-Hv`) or nested in a value (`API_KEY=v`, `Authorization: v`, a URL's
 * password or `?token=v`) keeps its flag and loses only the value — `./command-line.ts`, the one rule the
 * component detail follows too. An MCP server's own environment is never listed, and a server's `url` loses its
 * query and its user.
 *
 * Pure.
 */
import { type Conflict, type FlatLayer, type ResolvedProfile, settingsKey } from '../account/layering.ts';
import { harnessKey } from './foreign.ts';
import { looksSecret } from '@ferretry/std/credential-words';
import {
  commandWordsOf,
  refusedIndexes,
  shownLine,
  shownWords,
  valueWithheld,
  writtenWithheld,
} from './command-line.ts';
import {
  HIDDEN_WORD_TEXT,
  type ResolvedEntry,
  type ResolvedField,
  type ResolvedSetter,
  WITHHELD_WORDS_TEXT,
} from '../../../contract/index.ts';

type FlagView = Pick<ResolvedSetter, 'value' | 'hidden'>;

/** What a hidden value is replaced by. */
const RESOLVED_HIDDEN_TEXT = HIDDEN_WORD_TEXT;

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * A value in words, hidden when it looks like a credential under this name: the NAME the document holds it under (the
 * last path segment, unquoted), never the displayed key, which quotes a segment with a dot or a space.
 */
function said(name: string, value: unknown): Pick<ResolvedSetter, 'value' | 'hidden'> {
  const text = shown(value);
  return looksSecret(name, text) || valueWithheld(name, value)
    ? { value: RESOLVED_HIDDEN_TEXT, hidden: true }
    : { value: text };
}

/** A path with its %-escapes read back, or as it is when they do not parse. */
function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Where a server is reached, without a query, a fragment or a user in it. */
function bareUrl(text: string): string {
  try {
    const url = new URL(text);
    const bare = `${url.origin}${url.pathname}`;
    // THE NET, as the detail's `urlWithheld`: a path that holds a refused value (`/mcp --token v`, shown %20-encoded) is not shown.
    return writtenWithheld('url', bare) || writtenWithheld('url', decodedPath(url.pathname))
      ? WITHHELD_WORDS_TEXT
      : bare;
  } catch {
    return RESOLVED_HIDDEN_TEXT;
  }
}

/** How an MCP server starts: its command line, any credential in it hidden. */
function serverLine(server: {
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
}): string {
  if (server.url !== undefined) return bareUrl(server.url);
  const words = [...commandWordsOf(server.command ?? ''), ...(server.args ?? [])].filter(word => word !== '');
  const line = shownLine(words);
  // THE NET: the write rule still refuses a word the cutter showed: the whole line is withheld, never a part of it.
  if (line.withheld) return WITHHELD_WORDS_TEXT;
  const text = line.words.map(word => word.text).join(' ');
  // The write rule reads the command as one field and the line as the text it makes: a pair across the blanks of a
  // command (`Authorization: v`, one word to the document) or across its end and the first argument is caught here.
  return valueWithheld('command', server.command ?? '') || valueWithheld('line', text) ? WITHHELD_WORDS_TEXT : text;
}

/**
 * The launch flags as they may be shown, each judged with the flag before it on the command line. THE NET: a flag the
 * write rule still refuses once the cutter has had its say is withheld, as a hidden value.
 */
function flagValues(flags: readonly string[]): readonly Pick<ResolvedSetter, 'value' | 'hidden'>[] {
  const shown = shownWords(flags);
  const refused = refusedIndexes(shown);
  return shown.map((word, index) =>
    refused.has(index)
      ? { value: WITHHELD_WORDS_TEXT, hidden: true }
      : word.hidden
        ? { value: word.text, hidden: true }
        : { value: word.text },
  );
}

/**
 * One harness's final values, in merge order: instructions, MCP servers, skills, settings keys,
 * environment, flags, hooks, then the model.
 */
export function resolvedEntries(resolved: ResolvedProfile): readonly ResolvedEntry[] {
  const { harness } = resolved;
  const flagViews = flagValues(resolved.flags.map(({ flag }) => flag));
  const beaten = (field: Conflict['field'], key: string): readonly ResolvedSetter[] =>
    resolved.conflicts
      .filter(conflict => conflict.field === field && conflict.key === key)
      .flatMap(conflict =>
        conflict.overridden.map(setter => ({
          ...said(conflict.path.findLast(part => typeof part === 'string') ?? key, setter.value),
          from: setter.layer.origin,
        })),
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
      entry(
        'settings',
        leaf.key,
        said(leaf.path.at(-1) ?? leaf.key, leaf.value),
        leaf.layer,
        beaten('settings', leaf.key),
      ),
    ),
    ...Object.entries(resolved.env).map(([name, { value, layer }]) => {
      const key = settingsKey(['env', name]);
      return entry('env', key, said(name, value), layer, beaten('env', key));
    }),
    ...resolved.flags.map(({ layer }, index) => entry('flags', 'flag', flagViews[index] as FlagView, layer)),
    ...resolved.hooks.map(({ layer, component }) =>
      entry('hooks', layer.name, { value: component.file ?? component.directory ?? 'a hooks document' }, layer),
    ),
    ...(resolved.modelSet.source === 'model-set'
      ? [
          entry(
            'model',
            'model',
            said('model', resolved.modelSet.declaredDefault),
            resolved.modelSet.layer,
            beaten('model', 'model'),
          ),
        ]
      : []),
  ];
}
