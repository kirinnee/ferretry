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
import { composerSkills } from './lib/composer.ts';
import { MAX_SKILL_MANIFEST_BYTES, SkillsInventoryService } from './lib/inventory.ts';
import { inventoryRoutes } from './routes.ts';
import { skillParts } from './lib/launch-parts.ts';
import { skillsComponentSource } from './lib/profile-component-source.ts';
import { SkillStore } from './lib/skill-store.ts';
import { skillReferenceProvider } from './lib/reference-catalog.ts';

/**
 * Skills (§2.3): the inventory of every skill a ferret sees.
 *
 * SEAMS NOT BOUND HERE (declared GAPS): runtime homes and the registered projects belong to Runtimes and Projects, whose
 * contracts Skills may not import yet. The inventory therefore lists what a ferret's own working folder holds.
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
    };

    // Ferretry's own installed skills (`installed/<name>/`), shared one folder at a time (kernel.roots.share) for the harness that links them into a ferret home.
    const store = new SkillStore(kernel.state, kernel.roots);

    return {
      routes: inventoryRoutes(api),
      provides: { skills: api },
      hooks: {
        // The composer's `/` and `$` menus: one provider, because Claude's `/name` and Codex's `$name` are one skill.
        'reference.catalog:/': skillReferenceProvider(api.forComposer),
        'reference.catalog:$': skillReferenceProvider(api.forComposer),
        // Runtimes' read of the `skills` components a profile names: this plugin's own items, live, no cache.
        'runtimes.components.skills:components': skillsComponentSource(() =>
          kernel.config.collection(SKILLS_CONFIG as ConfigCollectionDef<SkillsItem>),
        ),
        'launch.parts': () => [
          {
            id: 'skills',
            item: {
              parts: async spec =>
                skillParts(
                  kernel.config.collection(SKILLS_CONFIG as ConfigCollectionDef<SkillsItem>),
                  spec.harness,
                  name => store.tree(name),
                ),
            },
          },
        ],
      },
    };
  },
});
