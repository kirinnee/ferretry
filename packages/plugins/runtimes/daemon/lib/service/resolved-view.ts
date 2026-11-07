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
 * follows. An MCP server's own environment is never listed, and a URL loses its query and its user.
 *
 * Pure.
 */
import { type Conflict, type FlatLayer, looksSecret, type ResolvedProfile, settingsKey } from '@ferretry/fleet';
import type { FleetResolvedEntry, FleetResolvedField, FleetResolvedSetter } from '@ferretry/protocol';

/** What a hidden value is replaced by. */
export const RESOLVED_HIDDEN_TEXT = '‹hidden›';

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** A value in words, hidden when it looks like a credential under this name. */
function said(name: string, value: unknown): Pick<FleetResolvedSetter, 'value' | 'hidden'> {
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

/** How an MCP server starts: its command line, any credential-looking argument hidden. */
function serverLine(server: {
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
}): string {
  if (server.url !== undefined) return bareUrl(server.url);
  const words = [server.command ?? '', ...(server.args ?? [])].filter(word => word !== '');
  return words.map(word => (looksSecret('', word) ? RESOLVED_HIDDEN_TEXT : word)).join(' ');
}

/**
 * One harness's final values, in merge order: instructions, MCP servers, skills, settings keys,
 * environment, flags, hooks, then the model.
 */
export function resolvedEntries(resolved: ResolvedProfile): readonly FleetResolvedEntry[] {
  const { harness } = resolved;
  const beaten = (field: Conflict['field'], key: string): readonly FleetResolvedSetter[] =>
    resolved.conflicts
      .filter(conflict => conflict.field === field && conflict.key === key)
      .flatMap(conflict =>
        conflict.overridden.map(setter => ({ ...said(key, setter.value), from: setter.layer.origin })),
      );
  const entry = (
    field: FleetResolvedField,
    key: string,
    value: Pick<FleetResolvedSetter, 'value' | 'hidden'>,
    layer: FlatLayer,
    overridden: readonly FleetResolvedSetter[] = [],
  ): FleetResolvedEntry => ({ harness, field, key, ...value, from: layer.origin, overridden });

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
    ...resolved.flags.map(({ flag, layer }) => entry('flags', 'flag', said('', flag), layer)),
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
