import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import {
  CatalogItemRefusal,
  type CatalogInstallChange,
  type CatalogRuntimeInstaller,
} from '@ferretry/plugin-catalogs/contract';
import type { ProfileLayerOutcome, RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { McpItem } from '../../contract/index.ts';

/** What the installer reads and writes of Runtimes: the runtimes and profiles, and the one layer act. */
type InstallRuntimes = Pick<RuntimesApi, 'list' | 'profiles' | 'changeProfileLayers'>;

export interface McpCatalogRuntimeDeps {
  /** Runtimes, when that plugin is on; `undefined` makes every install refuse in words and writes nothing. */
  readonly runtimes: () => InstallRuntimes | undefined;
  /** The server items this machine has, live. */
  readonly items: () => ReadonlyMap<string, McpItem>;
  /** This plugin's own item file, through the kernel's config writer, as the CALLER (the kernel judges the caller). */
  readonly writeItem: (
    name: string,
    patch: Readonly<Record<string, unknown>>,
    ifMatch: 'absent' | undefined,
  ) => Promise<ConfigWriteOutcome>;
  /** Removes `config/mcp/<name>.yaml`. */
  readonly removeItem: (name: string) => Promise<ConfigWriteOutcome>;
}

const NO_RUNTIMES = 'Runtimes is not available on this machine, so there is no runtime to install the server into.';

/** The keys that SAY what a server is: a replaced item loses the old ones, so a url never keeps a stale command. */
const DEFINITION_KEYS = ['command', 'args', 'env', 'url', 'auth'] as const;

const layerOf = (name: string) => `mcp/${name}` as const;

function itemRefusal(outcome: Exclude<ConfigWriteOutcome, { readonly kind: 'written' }>): CatalogItemRefusal {
  if (outcome.kind === 'held')
    return new CatalogItemRefusal(
      'catalog_install_conflict',
      `The server is not in effect: the owner has to confirm it first. ${outcome.sentences.join(' ')}`.trim(),
    );
  if (outcome.kind === 'conflict')
    return new CatalogItemRefusal('catalog_install_conflict', 'This server changed while it was being installed.');
  const issues = 'issues' in outcome ? outcome.issues.map(issue => `${issue.path}: ${issue.message}`).join(' ') : '';
  return new CatalogItemRefusal('catalog_install_conflict', `The server was not written. ${issues}`.trim());
}

function layerRefusal(outcome: Exclude<ProfileLayerOutcome, { readonly kind: 'written' }>): CatalogItemRefusal {
  if (outcome.kind === 'held')
    return new CatalogItemRefusal(
      'catalog_install_conflict',
      `The profile change is held for the owner to confirm: ${outcome.sentence}`,
    );
  if (outcome.kind === 'conflict')
    return new CatalogItemRefusal(
      'catalog_install_conflict',
      `The profile ${outcome.profile} changed since you looked.`,
    );
  return new CatalogItemRefusal(
    outcome.code === 'fleet_change_unknown' ? 'fleet_change_unknown' : 'catalog_install_conflict',
    outcome.sentence,
  );
}

/**
 * The runtime half of an MCP item install and removal (v4's fleet catalog deps): the server in `config/mcp/<name>.yaml`
 * and the one `mcp/<name>` layer in the profile the runtime launches with (Runtimes' act, which judges the caller). A
 * failure after the item is written takes it back, so a refused install never leaves a half-installed server behind.
 * Secrets arrive as `${secret:NAME}` references the Catalogs installer already bound; no value passes through here.
 */
export function mcpCatalogRuntime(deps: McpCatalogRuntimeDeps): CatalogRuntimeInstaller {
  const runtimes = (): InstallRuntimes => {
    const held = deps.runtimes();
    if (held === undefined) throw new CatalogItemRefusal('catalog_target_unknown', NO_RUNTIMES);
    return held;
  };
  const removals = new Map<string, string>();
  return {
    runtimes: async () => ({
      runtimes: ((await deps.runtimes()?.list()) ?? []).map(runtime => ({
        id: runtime.id,
        name: runtime.id,
        profile: runtime.profile,
        harness: runtime.harness === 'codex' ? ('codex' as const) : ('claude' as const),
      })),
    }),
    profiles: async () => ({
      profiles: ((await deps.runtimes()?.profiles()) ?? []).map(profile => ({ name: profile.name })),
    }),
    storedComponent: async name => deps.items().get(name),
    propose: async change => {
      const id = `remove:${change.name}`;
      removals.set(id, change.name);
      return { id };
    },
    apply: async (id, governance: CallerGovernance | undefined) => {
      const name = removals.get(id);
      removals.delete(id);
      if (name === undefined)
        throw new CatalogItemRefusal('fleet_change_unknown', 'The server removal proposal is no longer held.');
      const layers = await runtimes().changeProfileLayers(
        { kind: 'remove-everywhere', layer: layerOf(name) },
        governance,
      );
      if (layers.kind !== 'written') throw layerRefusal(layers);
      const removed = await deps.removeItem(name);
      if (removed.kind !== 'written') throw itemRefusal(removed);
      return { removed: name };
    },
    installCatalogItem: async (change: CatalogInstallChange, governance) => {
      const { name, component, profile, installedFrom, replace } = change;
      if (component.kind !== 'mcp')
        throw new CatalogItemRefusal(
          'catalog_not_installable',
          `${name} is not an MCP server, so MCP cannot install it.`,
        );
      const held = runtimes();
      const target = (await held.profiles()).find(candidate => candidate.name === profile);
      if (target === undefined)
        throw new CatalogItemRefusal('catalog_target_unknown', `${profile} is not a profile on this machine.`);
      const existed = deps.items().has(name);
      if (existed && !replace)
        throw new CatalogItemRefusal(
          'catalog_install_conflict',
          `${name} is already a server on this machine, and no install of ours put it there.`,
        );
      const patch: Record<string, unknown> = { installedFrom };
      for (const key of DEFINITION_KEYS) patch[key] = component[key as keyof typeof component];
      try {
        const written = await deps.writeItem(name, patch, existed ? undefined : 'absent');
        if (written.kind !== 'written') throw itemRefusal(written);
        if (!target.layers.includes(layerOf(name))) {
          const layered = await held.changeProfileLayers(
            { kind: 'add', profile: target.name, layer: layerOf(name), ifMatch: target.etag },
            governance,
          );
          if (layered.kind !== 'written') throw layerRefusal(layered);
        }
      } catch (error) {
        if (!existed) await deps.removeItem(name).catch(() => undefined);
        throw error;
      }
      return { component: deps.items().get(name) };
    },
  };
}
