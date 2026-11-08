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
import { looksSecret } from '../account/import.ts';
import { shownWord, shownWords } from './command-line.ts';
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
      entry('instructions', layer.name, { value: component.file }, layer),
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
      entry('hooks', layer.name, { value: (component.file ?? component.directory) as string }, layer),
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
