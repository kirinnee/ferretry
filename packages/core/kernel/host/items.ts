import type { ConfigPort } from '../contract/ports.ts';
import type { ItemKind, Manifest } from '../manifest/types.ts';
import type { HostFs } from './adapters/node-fs.ts';
import type { ItemReach, ItemReachOf } from './permissions.ts';
import { readConfigText } from '@ferretry/std/yaml';

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
        // The shared bounded reader (alias budget, no YAML 1.1 tags, duplicate keys refused): a file that does
        // not read names nothing, as one that did not parse always did.
        // Read with a hard bound, at most one byte past the cap: the size above was read before the bytes, and a file
        // that grew in between is never read whole — only far enough to see it is over the cap.
        const file = await fs.openRead(resolved);
        let bytes: Uint8Array;
        try {
          bytes = await file.read(ITEM_FILE_MAX_BYTES + 1);
        } finally {
          await file.close();
        }
        if (bytes.byteLength > ITEM_FILE_MAX_BYTES) continue;
        const read = readConfigText(new TextDecoder().decode(bytes));
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

/**
 * One item kind whose items live in its OWNER's config collection (`config/mcp/<name>.yaml`): the `item` plugin whose
 * collection declares `itemKind` for it. `read` answers the collection in effect NOW (never a held edit).
 */
export interface ConfigOwnedKind {
  readonly kind: ItemKind;
  readonly read: () => ReadonlyMap<string, unknown>;
}

/**
 * The kinds whose items a plugin owns as a config collection: an `item` plugin's collection that DECLARES `itemKind`.
 * A collection is never a reach source because of its name.
 */
export function configOwnedKinds(
  manifests: readonly Manifest[],
  configOf: (plugin: string) => ConfigPort,
): readonly ConfigOwnedKind[] {
  const owned: ConfigOwnedKind[] = [];
  for (const manifest of manifests) {
    if (!manifest.kinds.includes('item')) continue;
    for (const def of manifest.data?.config ?? []) {
      if (def.shape !== 'collection' || def.itemKind === undefined) continue;
      const port = configOf(manifest.id);
      owned.push({ kind: def.itemKind, read: () => port.collection(def) });
    }
  }
  return owned;
}

/**
 * What the items of each kind name now: the installed data plugins' (`installed`, fixed at boot: an install is pinned)
 * united with the items of the kind's owner config collection (`configOwned`), READ WHEN THE CALL IS MADE. Nothing is
 * cached and nothing waits for a change notice: the collection answers the version in effect, so an edit that drops
 * an item takes its reach away on the very next check, even while a reload is still running and even if the reload
 * then fails. The same rules apply to both: only `command` and `url` are read, and one with `*` in it names nothing.
 * A collection that cannot be read names nothing (fail closed).
 */
export function itemReach(input: {
  readonly installed: ItemReachOf;
  readonly configOwned: readonly ConfigOwnedKind[];
}): ItemReachOf {
  return (kind: ItemKind) => {
    const fromInstall = input.installed(kind);
    const sources = input.configOwned.filter(source => source.kind === kind);
    if (sources.length === 0) return fromInstall;
    const programs = new Set(fromInstall.programs);
    const hosts = new Set(fromInstall.hosts);
    for (const source of sources) {
      try {
        const named = [...source.read().values()].map(reachOf);
        for (const reach of named) {
          if (reach.program !== undefined) programs.add(reach.program);
          if (reach.host !== undefined) hosts.add(reach.host);
        }
      } catch {
        // an unreadable collection names nothing: the installed items above are all that count
      }
    }
    return { programs: [...programs], hosts: [...hosts] };
  };
}
