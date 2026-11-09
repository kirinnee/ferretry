import { basename, dirname } from 'node:path';
import type { RuntimeAssetSkills, RuntimeHome, RuntimeHomeReader } from '@ferretry/plugin-runtimes/contract';
import { MAX_SKILLS_PER_ROOT, type SkillDirectoryEntry, type SkillFilesPort } from '../lib/inventory.ts';
import type { InstalledSkillFiles } from './installed-store.ts';
import type { ProjectSkillFiles } from './project-skill-files.ts';

const SKILL_FILE = 'SKILL.md';
/** `<folder>/skills/<name>/SKILL.md`: the folder (a home's, or the fleet's `assets`) and the skill's name. */
const SKILL_MANIFEST = /^(.+)\/skills\/([^/]+)\/SKILL\.md$/u;

export interface SkillFilesRouting {
  /** Runtimes' published homes, asked on every call. */
  readonly homes: () => Promise<readonly RuntimeHome[]>;
  /** The bounded reader of one published home; `undefined` for an id that is not (or no longer) published. */
  readonly home: (id: string) => RuntimeHomeReader | undefined;
  /** Runtimes' fleet asset tree (the v4-installed skills); `undefined` when the provider offers none. */
  readonly assets: () => RuntimeAssetSkills | undefined;
  /** Skills' own installed store. */
  readonly installed: InstalledSkillFiles;
  /** The registered projects' skills folders. */
  readonly projects: ProjectSkillFiles;
  /** A ferret's own working folder, when this is a ferret's view: read through its `work` root, as before. */
  readonly work?: { readonly files: SkillFilesPort; readonly base: string };
}

const insideFolder = (base: string, path: string): boolean =>
  path === base || path.startsWith(`${base.replace(/\/+$/u, '')}/`);

/**
 * `SkillFilesPort` as one router over every place a skill lives: a published home (through Runtimes' bounded reader),
 * the fleet's asset tree (through Runtimes), Skills' own installed store, a registered project's skills folders, and a
 * ferret's working folder. Each path goes to exactly ONE of them by what the path IS; a path none of them claims is
 * nothing. The router holds no root of its own: whatever may be read is the reader's decision.
 */
export class SkillFilesRouter implements SkillFilesPort {
  constructor(private readonly routing: SkillFilesRouting) {}

  async list(directory: string, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    const { work } = this.routing;
    if (work !== undefined && insideFolder(work.base, directory)) return await work.files.list(directory, limit);
    const home = (await this.routing.homes()).find(candidate => `${candidate.home}/skills` === directory);
    if (home !== undefined) return await this.#homeList(home, limit);
    return await this.routing.projects.list(directory, limit);
  }

  async read(path: string, maxBytes: number): Promise<string | undefined> {
    const { work } = this.routing;
    if (work !== undefined && insideFolder(work.base, path)) return await work.files.read(path, maxBytes);
    if (this.routing.installed.claims(path)) return await this.routing.installed.read(path, maxBytes);
    const match = SKILL_MANIFEST.exec(path);
    if (match !== null) {
      const [, folder, name] = match as unknown as [string, string, string];
      const home = (await this.routing.homes()).find(candidate => candidate.home === folder);
      if (home !== undefined) return await this.#homeManifest(home, name, maxBytes);
      const asset = await this.#assetManifest(path, name, maxBytes);
      if (asset !== undefined) return asset;
    }
    return await this.routing.projects.read(path, maxBytes);
  }

  async #homeList(home: RuntimeHome, limit: number): Promise<readonly SkillDirectoryEntry[]> {
    const reader = this.routing.home(home.id);
    if (reader === undefined) return [];
    const listed = await reader.skills(limit).catch(() => []);
    return listed.map(entry => ({ manifest: entry.manifest, managed: entry.managed }));
  }

  async #homeManifest(home: RuntimeHome, name: string, maxBytes: number): Promise<string | undefined> {
    return await this.routing
      .home(home.id)
      ?.skillManifest(name, maxBytes)
      .catch(() => undefined);
  }

  /** The asset tree's SKILL.md, only when the asset listing itself names `path` (a path the tree does not list is nothing). */
  async #assetManifest(path: string, name: string, maxBytes: number): Promise<string | undefined> {
    const assets = this.routing.assets();
    if (assets === undefined || basename(path) !== SKILL_FILE || basename(dirname(path)) !== name) return undefined;
    const listed = await assets.skills(MAX_SKILLS_PER_ROOT).catch(() => []);
    if (!listed.some(entry => entry.manifest === path)) return undefined;
    return await assets.skillManifest(name, maxBytes).catch(() => undefined);
  }
}
