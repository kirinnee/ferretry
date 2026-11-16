import type { AccessApi } from '../../../contract/index.ts';

/**
 * WHICH LINES A PLUGIN MAY TAKE DOWN THROUGH ACCESS'S PORT (`AccessApi.clear`). A clear names tags and nothing else, and
 * a tag is a line some plugin's buzz put on every device, so a plugin may clear only the lines of its OWN namespace:
 * Accounts its approvals' (`pa-<id>`), Agenda its asks' and stops' (`agenda-…`, `attention-…`). A plugin outside this
 * table is handed no `clear` at all, and a core caller keeps the whole reach. Fails closed: an unknown plugin clears nothing.
 */
export const CLEAR_NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  accounts: ['pa-'],
  agenda: ['agenda-', 'attention-'],
};

/** The tags of `tags` that begin with one of `prefixes`. */
export const withinNamespace = (tags: readonly string[], prefixes: readonly string[]): readonly string[] =>
  tags.filter(tag => prefixes.some(prefix => tag.startsWith(prefix)));

/**
 * The port one plugin is handed: `clear` narrowed to its namespace (a tag outside it is dropped, so a clear naming only
 * other plugins' lines reaches no one), or removed where the plugin has none. Everything else is shared as it is.
 */
export function accessPortFor(port: AccessApi, neederId: string, core: boolean): AccessApi {
  if (core) return port;
  const prefixes = CLEAR_NAMESPACES[neederId];
  const { clear, ...rest } = port;
  if (clear === undefined || prefixes === undefined) return rest;
  return {
    ...rest,
    clear: async (tags, except, ferret) => {
      const own = withinNamespace(tags, prefixes);
      return own.length === 0 ? 0 : await clear(own, except, ferret);
    },
  };
}
