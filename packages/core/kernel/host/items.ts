import type { ItemKind } from '../manifest/types.ts';
import type { HostFs } from './adapters/node-fs.ts';
import type { ItemReach, ItemReachOf } from './permissions.ts';
import { readConfigText } from './config/yaml-text.ts';

/** One installed data plugin's items, as `loadDataPlugins` accepted them. */
export interface InstalledItems {
  readonly id: string;
  readonly items?: readonly { readonly kind: string; readonly id: string; readonly file: string }[];
}

/** The most an item file may hold before it is not read for its reach. */
const ITEM_FILE_MAX_BYTES = 256 * 1024;

const isPlainRelative = (file: string): boolean =>
  file !== '' && !file.startsWith('/') && !file.split('/').some(part => part === '..' || part === '' || part === '.');

/** A name with `*` in it is a pattern, and a pattern is a core piece's alone: an item never grants one. */
const literal = (name: string | undefined): string | undefined =>
  name === undefined || name.includes('*') ? undefined : name;

/**
 * The program an item's `command` names, and the host its `url` names; nothing else in the item is read. A program or
 * host with `*` in it (`command: '*'`, a url whose host is `*`) names nothing.
 */
function reachOf(value: unknown): { readonly program?: string; readonly host?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const { command, url } = value as { command?: unknown; url?: unknown };
  let host: string | undefined;
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') host = parsed.hostname;
    } catch {
      host = undefined;
    }
  }
  const program = literal(typeof command === 'string' && command.trim() !== '' ? command.trim() : undefined);
  host = literal(host);
  return {
    ...(program === undefined ? {} : { program }),
    ...(host === undefined ? {} : { host }),
  };
}

/**
 * What the owner-installed, pinned items name, by kind (`permissions.spawn: [{ items: 'mcp' }]`): read once at boot from
 * the installed data plugins under `state/kernel/plugins/<id>/` — installing one is the owner's act, and an install
 * is pinned until the owner replaces it (§3.6). An item file that is missing, too large, outside its folder or not a
 * mapping names nothing. Only `command` (a program) and `url` (a host) are read.
 */
export async function installedItemReach(
  fs: HostFs,
  home: string,
  installed: readonly InstalledItems[],
): Promise<ItemReachOf> {
  const byKind = new Map<string, { programs: Set<string>; hosts: Set<string> }>();
  for (const plugin of installed) {
    if (!isPlainRelative(plugin.id) || plugin.id.includes('/')) continue;
    for (const item of plugin.items ?? []) {
      if (!isPlainRelative(item.file)) continue;
      const path = `${home}/state/kernel/plugins/${plugin.id}/${item.file}`;
      let value: unknown;
      try {
        // Resolve every parent before reading permission-bearing data. A lexical child (including a plugin
        // folder itself) may be a link to another install or somewhere outside the installed-plugin root.
        const plugins = await fs.realpath(`${home}/state/kernel/plugins`);
        const root = await fs.realpath(`${home}/state/kernel/plugins/${plugin.id}`);
        if (root !== `${plugins}/${plugin.id}`) continue;
        const resolved = await fs.realpath(path);
        if (!resolved.startsWith(`${root}/`)) continue;
        const info = await fs.lstat(path);
        if (info?.kind !== 'file' || info.size > ITEM_FILE_MAX_BYTES) continue;
        // The kernel's own bounded reader (alias budget, no YAML 1.1 tags, duplicate keys refused): a file that does
        // not read names nothing, as one that did not parse always did.
        const read = readConfigText(await fs.readText(resolved));
        if (!read.ok) continue;
        value = read.read.value;
      } catch {
        continue;
      }
      const reach = reachOf(value);
      const entry = byKind.get(item.kind) ?? { programs: new Set<string>(), hosts: new Set<string>() };
      if (reach.program !== undefined) entry.programs.add(reach.program);
      if (reach.host !== undefined) entry.hosts.add(reach.host);
      byKind.set(item.kind, entry);
    }
  }
  const frozen = new Map<string, ItemReach>(
    [...byKind].map(([kind, entry]) => [
      kind,
      Object.freeze({ programs: [...entry.programs], hosts: [...entry.hosts] }),
    ]),
  );
  return (kind: ItemKind) => frozen.get(kind) ?? { programs: [], hosts: [] };
}
