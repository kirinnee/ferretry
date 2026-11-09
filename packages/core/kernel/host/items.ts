import type { Cancel, ConfigPort } from '../contract/ports.ts';
import type { ItemKind, Manifest } from '../manifest/types.ts';
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
 * One item kind whose items live in its OWNER's config collection (`config/mcp/<name>.yaml`): the plugin whose manifest
 * `kinds` includes `'item'` and which declares the collection named for the kind. `read` answers the collection in
 * effect now (never a held edit); `watch` fires when that version moves.
 */
export interface ConfigOwnedKind {
  readonly kind: ItemKind;
  readonly read: () => ReadonlyMap<string, unknown>;
  readonly watch: (listener: () => void) => Cancel;
}

/** The kinds whose items a plugin owns as a config collection: an `item` plugin's collection named for the kind. */
export function configOwnedKinds(
  manifests: readonly Manifest[],
  configOf: (plugin: string) => ConfigPort,
): readonly ConfigOwnedKind[] {
  const owned: ConfigOwnedKind[] = [];
  for (const manifest of manifests) {
    if (!manifest.kinds.includes('item')) continue;
    for (const def of manifest.data?.config ?? []) {
      if (def.shape !== 'collection') continue;
      const port = configOf(manifest.id);
      owned.push({
        kind: def.collection as ItemKind,
        read: () => port.collection(def),
        watch: listener => port.watch(def, listener),
      });
    }
  }
  return owned;
}

/**
 * What the items of each kind name now: the installed data plugins' (`installed`, fixed at boot: an install is pinned)
 * united with the items of the kind's owner config collection (`configOwned`), which is read again whenever that
 * collection moves, so an edit that drops an item takes its reach away at once. The same rules apply to both: only
 * `command` and `url` are read, and one with `*` in it names nothing. A collection that cannot be read names nothing.
 * `stop` ends the watching.
 */
export function itemReach(input: {
  readonly installed: ItemReachOf;
  readonly configOwned: readonly ConfigOwnedKind[];
}): { readonly of: ItemReachOf; readonly stop: () => void } {
  const owned = new Map<string, ItemReach>();
  const refresh = (source: ConfigOwnedKind): void => {
    const programs = new Set<string>();
    const hosts = new Set<string>();
    try {
      for (const value of source.read().values()) {
        const reach = reachOf(value);
        if (reach.program !== undefined) programs.add(reach.program);
        if (reach.host !== undefined) hosts.add(reach.host);
      }
    } catch {
      programs.clear();
      hosts.clear();
    }
    owned.set(source.kind, Object.freeze({ programs: [...programs], hosts: [...hosts] }));
  };
  const cancels: Cancel[] = [];
  for (const source of input.configOwned) {
    refresh(source);
    cancels.push(source.watch(() => refresh(source)));
  }
  return {
    of: (kind: ItemKind) => {
      const fromInstall = input.installed(kind);
      const fromConfig = owned.get(kind);
      if (fromConfig === undefined) return fromInstall;
      return {
        programs: [...new Set([...fromInstall.programs, ...fromConfig.programs])],
        hosts: [...new Set([...fromInstall.hosts, ...fromConfig.hosts])],
      };
    },
    stop: () => {
      for (const cancel of cancels.splice(0)) cancel();
    },
  };
}
