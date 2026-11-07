import type { ConfigCollectionDef, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import {
  type FerretSkills,
  type FerretSkillsInventory,
  SKILLS_CONFIG,
  type SkillsApi,
  type SkillsItem,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { RootSkillFiles } from './adapters/skill-files.ts';
import { RootSkillFolderReader } from './adapters/skill-folder-reader.ts';
import { StateLocalSkillInstallStore } from './adapters/install-store.ts';
import { composerSkills } from './lib/composer.ts';
import { MAX_SKILL_MANIFEST_BYTES, SkillsInventoryService } from './lib/inventory.ts';
import { LocalSkillInstallService } from './lib/installs/service.ts';
import { unavailable } from './lib/installs/ports.ts';
import { installRoutes } from './install-routes.ts';
import { inventoryRoutes } from './routes.ts';
import { skillParts, type SkillFolderResolver } from './lib/launch-parts.ts';
import { skillReferenceProvider } from './lib/reference-catalog.ts';

/**
 * Skills (§2.3): the inventory of every skill a ferret sees, and the reviewed copy of one skill from this machine.
 *
 * SEAMS NOT BOUND HERE (declared GAPS, each refuses in words instead of guessing): runtime homes, the registered
 * projects, a project's skill files, a runtime's skill assets and the catalog installer's review belong to Runtimes,
 * Projects and Catalogs, whose contracts Skills may not import yet. The inventory therefore lists what a ferret's own
 * working folder holds; a project or runtime copy answers `local_skill_target_unknown` until those are bound.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const ferrets = ctx.needs.ferrets;

    const filesFor = (ferret: FerretId, folder: string): RootSkillFiles =>
      new RootSkillFiles(kernel.roots.root('work', { ferret }), folder);
    const servicePorts = (files: RootSkillFiles) => ({
      files,
      homes: async () => [],
      projects: async () => [],
      fleetDirectory: '',
      assetsDirectory: '',
      userHome: '',
    });

    const ferretView = async (id: string): Promise<FerretSkillsInventory | undefined> => {
      const ferret = await ferrets.get(id as FerretId);
      if (ferret === undefined) return undefined;
      const service = new SkillsInventoryService(servicePorts(filesFor(ferret.id, ferret.folder)));
      return await service.ferret({
        id: ferret.id,
        harness: ferret.harness,
        folder: ferret.folder,
        ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
      });
    };

    const machine = new SkillsInventoryService({
      files: { list: async () => [], read: async () => undefined },
      homes: async () => [],
      projects: async () => [],
      fleetDirectory: '',
      assetsDirectory: '',
      userHome: '',
    });

    const api: SkillsApi = {
      inventory: async () => await machine.machine(),
      ferretInventory: ferretView,
      forComposer: async (ferret): Promise<FerretSkills | undefined> => {
        const view = await ferretView(ferret);
        return view === undefined ? undefined : composerSkills(view);
      },
      file: async (path, ferret) => {
        if (ferret === undefined) return await machine.file(path, await machine.machinePaths());
        const view = await ferretView(ferret);
        const summary = await ferrets.get(ferret as FerretId);
        if (view === undefined || summary === undefined) return undefined;
        if (!view.skills.some(skill => skill.path === path)) return undefined;
        return await filesFor(summary.id, summary.folder).read(path, MAX_SKILL_MANIFEST_BYTES);
      },
      installs: async () => await installs.list(),
    };

    // The store's folders are not addressable through a kernel port yet: no item resolves, so no part is added.
    const folderOf: SkillFolderResolver = () => undefined;

    const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
    const mint = (prefix: 'lsp' | 'lsi'): string => String(kernel.ids.mint(prefix)).replace(/^.*?_/u, `${prefix}_`);

    const installs = new LocalSkillInstallService({
      crypto: { sha256 },
      store: new StateLocalSkillInstallStore(kernel.state),
      skills: { list: async () => await machine.machinePaths() },
      skillTree: new RootSkillFolderReader((folder, boundary) => ({
        root: kernel.roots.root('imports', { subfolder: folder }),
        boundary: kernel.roots.root('imports', { subfolder: boundary }),
      })),
      fleetDirectory: '',
      projectRoots: async () => [],
      skillFiles: {
        inspect: async () => unavailable('A project folder'),
        apply: async () => unavailable('A project folder'),
      },
      runtimeSkills: {
        inspect: async () => unavailable('A runtime profile'),
        remove: async () => unavailable('A runtime profile'),
      },
      fleet: {
        runtimes: async () => [],
        profiles: async () => [],
        storedComponent: async () => undefined,
        install: async () => unavailable('A runtime profile'),
        removeComponent: async () => unavailable('A runtime profile'),
      },
      reviewer: { review: () => unavailable('The catalog review') },
      now: () => kernel.clock.nowMs(),
      mint,
    });

    return {
      routes: {
        ...inventoryRoutes(api),
        ...installRoutes({
          list: () => installs.list(),
          preview: (scope, request, caller) => installs.preview(scope, request, caller),
          apply: (scope, previewId, caller) => installs.apply(scope, previewId, caller),
          remove: (scope, installId) => installs.remove(scope, installId),
        }),
      },
      provides: { skills: api },
      hooks: {
        // The composer's `/` and `$` menus: one provider, because Claude's `/name` and Codex's `$name` are one skill.
        'reference.catalog:/': skillReferenceProvider(api.forComposer),
        'reference.catalog:$': skillReferenceProvider(api.forComposer),
        'launch.parts': () => [
          {
            id: 'skills',
            item: {
              parts: async spec =>
                skillParts(
                  kernel.config.collection(SKILLS_CONFIG as ConfigCollectionDef<SkillsItem>),
                  spec.harness,
                  folderOf,
                ),
            },
          },
        ],
      },
    };
  },
});
