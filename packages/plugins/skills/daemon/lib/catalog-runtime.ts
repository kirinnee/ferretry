import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import {
  CatalogItemRefusal,
  type CatalogInstallChange,
  type CatalogRuntimeInstaller,
} from '@ferretry/plugin-catalogs/contract';
import type { ProfileLayerOutcome, RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { SkillsItem } from '../../contract/index.ts';
import { InstalledSkillRefused, type SkillStore } from './skill-store.ts';

/** What the installer reads and writes of Runtimes: the runtimes and profiles, and the one layer act. */
type InstallRuntimes = Pick<RuntimesApi, 'list' | 'profiles' | 'changeProfileLayers'>;

export interface SkillsCatalogRuntimeDeps {
  /** Runtimes, when that plugin is on; `undefined` makes every install refuse in words and writes nothing. */
  readonly runtimes: () => InstallRuntimes | undefined;
  /** The skill items this machine has, live. */
  readonly items: () => ReadonlyMap<string, SkillsItem>;
  /** This plugin's own item file, through the kernel's config writer, as the CALLER (the kernel judges the caller). */
  readonly writeItem: (
    name: string,
    patch: Readonly<Record<string, unknown>>,
    ifMatch: 'absent' | undefined,
  ) => Promise<ConfigWriteOutcome>;
  /** Removes `config/skills/<name>.yaml`. */
  readonly removeItem: (name: string) => Promise<ConfigWriteOutcome>;
  readonly store: Pick<SkillStore, 'install' | 'uninstall'>;
}

const NO_RUNTIMES = 'Runtimes is not available on this machine, so there is no runtime to install the skill into.';

const layerOf = (name: string) => `skills/${name}` as const;

function itemRefusal(outcome: Exclude<ConfigWriteOutcome, { readonly kind: 'written' }>): CatalogItemRefusal {
  if (outcome.kind === 'held')
    return new CatalogItemRefusal(
      'catalog_install_conflict',
      `The skill is not in effect: the owner has to confirm it first. ${outcome.sentences.join(' ')}`.trim(),
    );
  if (outcome.kind === 'conflict')
    return new CatalogItemRefusal('catalog_install_conflict', 'This skill changed while it was being installed.');
  const issues = 'issues' in outcome ? outcome.issues.map(issue => `${issue.path}: ${issue.message}`).join(' ') : '';
  return new CatalogItemRefusal('catalog_install_conflict', `The skill was not written. ${issues}`.trim());
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
 * The runtime half of a Skills item install and removal (v4's fleet catalog deps): the skill's files into Skills' own
 * installed store, its item in `config/skills/<name>.yaml`, and the one `skills/<name>` layer in the profile the runtime
 * launches with (Runtimes' act, which judges the caller). A failure after the first write takes back what THIS call
 * wrote, so a refused install never leaves a half-installed skill behind.
 */
export function skillsCatalogRuntime(deps: SkillsCatalogRuntimeDeps): CatalogRuntimeInstaller {
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
        throw new CatalogItemRefusal('fleet_change_unknown', 'The skill removal proposal is no longer held.');
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
      const { name, component, files, profile, installedFrom, replace } = change;
      if (component.kind !== 'skills')
        throw new CatalogItemRefusal('catalog_not_installable', `${name} is not a skill, so Skills cannot install it.`);
      const held = runtimes();
      const target = (await held.profiles()).find(candidate => candidate.name === profile);
      if (target === undefined)
        throw new CatalogItemRefusal('catalog_target_unknown', `${profile} is not a profile on this machine.`);
      const existed = deps.items().has(name);
      if (existed && !replace)
        throw new CatalogItemRefusal(
          'catalog_install_conflict',
          `${name} is already a skill on this machine, and no install of ours put it there.`,
        );
      try {
        await deps.store.install(name, files);
      } catch (error) {
        if (error instanceof InstalledSkillRefused)
          throw new CatalogItemRefusal('catalog_not_installable', error.message);
        throw error;
      }
      const undo = async (): Promise<void> => {
        if (existed) return;
        await deps.removeItem(name).catch(() => undefined);
        await deps.store.uninstall(name).catch(() => undefined);
      };
      try {
        const written = await deps.writeItem(
          name,
          { items: [...component.items], installedFrom },
          existed ? undefined : 'absent',
        );
        if (written.kind !== 'written') throw itemRefusal(written);
        if (!target.layers.includes(layerOf(name))) {
          const layered = await held.changeProfileLayers(
            { kind: 'add', profile: target.name, layer: layerOf(name), ifMatch: target.etag },
            governance,
          );
          if (layered.kind !== 'written') throw layerRefusal(layered);
        }
      } catch (error) {
        await undo();
        throw error;
      }
      return { component: deps.items().get(name) };
    },
  };
}
