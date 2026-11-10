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
import { InstalledSkillFiles } from './adapters/installed-store.ts';
import { ProjectSkillFiles } from './adapters/project-skill-files.ts';
import { SkillFilesRouter } from './adapters/skill-files-router.ts';
import { RootSkillFiles } from './adapters/skill-files.ts';
import { composerSkills } from './lib/composer.ts';
import { MAX_SKILL_MANIFEST_BYTES, MAX_SKILLS_PER_ROOT, SkillsInventoryService } from './lib/inventory.ts';
import { inventoryRoutes } from './routes.ts';
import { skillParts } from './lib/launch-parts.ts';
import { skillsComponentSource } from './lib/profile-component-source.ts';
import { SkillStore } from './lib/skill-store.ts';
import { skillReferenceProvider } from './lib/reference-catalog.ts';

/**
 * Skills (§2.3): the inventory of every skill a ferret sees.
 *
 * Where the skills come from (S1):
 * - an ACCOUNT HOME's skills through Runtimes' bounded reader (`homes`, `home(id)`): a plain folder is `user`, a link the
 *   reader says is Ferretry's own is `ferretry`. A home is never a path Skills opens;
 * - the v4-installed skills straight from the fleet's `assets/skills/<name>` (Runtimes' `assetSkills`, source
 *   `ferretry`), so a link from a home into `assets/` is the same skill listed once, never followed. Unbound while the
 *   Runtimes provider offers no asset tree;
 * - the skill items a runtime's profile selects (`layers(runtime).skills`), resolved to Skills' own installed store;
 * - a REGISTERED PROJECT's `.claude/skills` and `.agents/skills`, through the kernel's read-only `imports` root scoped to
 *   that one folder, and a ferret's own folder through its `work` root.
 * A ferret that runs no published account lists its project skills and the items its launch carries, and nothing from
 * the daemon user's own harness home: a 5.0 ferret never reads `~/.claude` or `~/.codex`.
 *
 * Runtimes or Projects off: that part is empty (no homes, no projects), and a launch carries no skill item, because the
 * profile that would select one cannot be read.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const ferrets = ctx.needs.ferrets;
    const { runtimes, projects } = ctx.uses;

    const items = (): ReadonlyMap<string, SkillsItem> =>
      kernel.config.collection(SKILLS_CONFIG as ConfigCollectionDef<SkillsItem>);

    // ── where skills live ──────────────────────────────────────────────────────────────────────────────────────────
    // A fleet that cannot be read (a manifest damaged mid-apply) lists no home: the inventory answers, it does not fail.
    const publishedHomes = async () =>
      (await runtimes
        .current()
        ?.homes()
        .catch(() => undefined)) ?? [];
    const registeredRoots = async (): Promise<readonly string[]> =>
      ((await projects.current()?.list()) ?? []).map(project => project.path);
    const store = new SkillStore(kernel.state, kernel.roots);
    const installed = new InstalledSkillFiles(kernel.state);
    const projectFiles = new ProjectSkillFiles(registeredRoots, folder =>
      kernel.roots.root('imports', { subfolder: folder }),
    );
    const routing = (work?: { readonly files: RootSkillFiles; readonly base: string }) =>
      new SkillFilesRouter({
        homes: publishedHomes,
        home: id => runtimes.current()?.home(id),
        assets: () => runtimes.current()?.assetSkills?.(),
        installed,
        projects: projectFiles,
        ...(work === undefined ? {} : { work }),
      });

    // What a runtime's profile stack selects, as the installed skills the launch hands over (a profile that cannot be
    // resolved selects nothing: never a guess).
    const selectedItems = async (runtime: string): Promise<ReadonlySet<string>> => {
      const layers = await runtimes
        .current()
        ?.layers(runtime as never)
        .catch(() => undefined);
      return new Set(layers?.skills ?? []);
    };
    const selectedEntries = async (runtime: string) => {
      const chosen = await selectedItems(runtime);
      const folders = [...items()].filter(([name]) => chosen.has(name)).flatMap(([, item]) => item.items);
      return await installed.entries(folders);
    };
    const portsFor = (files: SkillFilesRouter) => ({
      files,
      homes: async () =>
        (await publishedHomes()).map(home => ({ runtimes: home.runtimes, harness: home.harness, home: home.home })),
      projects: async () =>
        ((await projects.current()?.list()) ?? []).map(project => ({
          id: project.id,
          name: project.name,
          path: project.path,
        })),
      ferretry: async () => {
        const assets = runtimes.current()?.assetSkills?.();
        const listed = (await assets?.skills(MAX_SKILLS_PER_ROOT).catch(() => undefined)) ?? [];
        return listed.map(entry => ({ manifest: entry.manifest, managed: true }));
      },
      selected: selectedEntries,
    });

    const ferretView = async (id: string): Promise<FerretSkillsInventory | undefined> => {
      const ferret = await ferrets.get(id as FerretId);
      if (ferret === undefined) return undefined;
      const work = {
        files: new RootSkillFiles(kernel.roots.root('work', { ferret: ferret.id }), ferret.folder),
        base: ferret.folder,
      };
      const service = new SkillsInventoryService(portsFor(routing(work)));
      return await service.ferret({
        id: ferret.id,
        harness: ferret.harness,
        folder: ferret.folder,
        ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
      });
    };

    const machine = new SkillsInventoryService(portsFor(routing()));

    const api: SkillsApi = {
      inventory: async () => await machine.machine(),
      ferretInventory: ferretView,
      forComposer: async (ferret): Promise<FerretSkills | undefined> => {
        const view = await ferretView(ferret);
        return view === undefined ? undefined : composerSkills(view);
      },
      // The listed-only rule (G175's read twin): a path is read only when an inventory this caller may see names it.
      file: async (path, ferret) => {
        if (ferret === undefined) return await machine.file(path, await machine.machinePaths());
        const view = await ferretView(ferret);
        if (view === undefined || !view.skills.some(skill => skill.path === path)) return undefined;
        const summary = await ferrets.get(ferret as FerretId);
        if (summary === undefined) return undefined;
        const work = {
          files: new RootSkillFiles(kernel.roots.root('work', { ferret: summary.id }), summary.folder),
          base: summary.folder,
        };
        return await routing(work).read(path, MAX_SKILL_MANIFEST_BYTES);
      },
    };

    return {
      routes: inventoryRoutes(api),
      provides: { skills: api },
      hooks: {
        // The composer's `/` and `$` menus: one provider, because Claude's `/name` and Codex's `$name` are one skill.
        'reference.catalog:/': skillReferenceProvider(api.forComposer),
        'reference.catalog:$': skillReferenceProvider(api.forComposer),
        // Runtimes' read of the `skills` components a profile names: this plugin's own items, live, no cache.
        'runtimes.components.skills:components': skillsComponentSource(items),
        // Skills' own installed skills (`installed/<name>/`) go to a launch only for an item the runtime's profile selects.
        'launch.parts': () => [
          {
            id: 'skills',
            item: {
              parts: async spec =>
                spec.runtime === undefined
                  ? []
                  : await skillParts(
                      items(),
                      spec.harness,
                      name => store.tree(name),
                      await selectedItems(spec.runtime),
                    ),
            },
          },
        ],
      },
    };
  },
});
