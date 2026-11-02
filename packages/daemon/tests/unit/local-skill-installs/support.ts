import type { CatalogInstallTarget, SkillEntry } from '@ferretry/protocol';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import {
  type ProjectSkillFiles,
  type RuntimeSkillAssets,
  type SkillFolderChange,
  type SkillFilesReading,
  type SkillFolderReading,
} from '../../../src/lib/catalog-installs/ports.ts';
import type { FreshStepUpContext } from '../../../src/lib/fleet/catalog-service.ts';
import { LocalSkillInstallService, type LocalSkillCaller } from '../../../src/lib/local-skill-installs/service.ts';
import { LocalSkillPreviews } from '../../../src/lib/local-skill-installs/previews.ts';
import {
  EMPTY_LOCAL_SKILL_INSTALL_STATE,
  type LocalSkillInstallState,
  type LocalSkillInstallStore,
} from '../../../src/lib/local-skill-installs/store.ts';
import { FakeFleet, FakeFolders } from '../catalog-installs/service-support.ts';
import { crypto } from '../../support/catalog-fixtures.ts';
import type { SkillFileRead, SkillTreeListing } from '../../../src/lib/shared-catalogs/skill-source.ts';
import { MemoryTree, SKILL_MD } from '../shared-catalogs/support.ts';

export const FLEET_DIRECTORY = '/fleet';

/**
 * A tree that behaves like the real port when it is given a boundary: a folder whose RESOLVED place (set with
 * `resolveTo`) is outside it is neither listed nor read. A folder with no resolved place resolves inside.
 * `swapAfterList` moves the folder outside once it has been listed, as a link put there in between would.
 */
class ConfinedTree extends MemoryTree {
  readonly boundaries: { readonly act: 'list' | 'read'; readonly manifest: string; readonly confinedTo?: string }[] =
    [];
  readonly #resolved = new Map<string, string>();
  swapAfterList: string | undefined;

  resolveTo(manifest: string, place: string): void {
    this.#resolved.set(manifest, place);
  }

  #outside(manifest: string, confinedTo: string | undefined): boolean {
    const place = this.#resolved.get(manifest);
    return (
      confinedTo !== undefined && place !== undefined && place !== confinedTo && !place.startsWith(`${confinedTo}/`)
    );
  }

  override async list(manifest: string, _limits?: unknown, confinedTo?: string): Promise<SkillTreeListing | undefined> {
    this.boundaries.push({ act: 'list', manifest, ...(confinedTo === undefined ? {} : { confinedTo }) });
    if (this.#outside(manifest, confinedTo)) return undefined;
    const listing = await super.list(manifest);
    if (this.swapAfterList !== undefined) this.#resolved.set(manifest, this.swapAfterList);
    return listing;
  }

  override async read(manifest: string, path: string, maxBytes: number, confinedTo?: string): Promise<SkillFileRead> {
    this.boundaries.push({ act: 'read', manifest, ...(confinedTo === undefined ? {} : { confinedTo }) });
    if (this.#outside(manifest, confinedTo)) return { ok: false, reason: 'unreadable' };
    return await super.read(manifest, path, maxBytes);
  }
}

export const GOVERNANCE = { governed: false } as unknown as CallerGovernance;
export const STEP_UP: FreshStepUpContext = { presentation: undefined, spend: () => undefined, agent: false };
export const ROOT = '/work/app';
export const CALLER: LocalSkillCaller = { id: 'device:dev_a' };

/** An account's skill and a project's skill, as the machine inventory would list them. */
export const ACCOUNT_SKILL = '/home/me/.claude/skills/demo/SKILL.md';
export const PROJECT_SKILL = '/work/other/.claude/skills/tool/SKILL.md';

const entry = (path: string, extra: Partial<SkillEntry> = {}): SkillEntry =>
  ({
    name: 'x',
    description: 'd',
    harness: 'claude',
    scope: 'user',
    path,
    runtimes: ['claude-work'],
    toggle: { supported: false, enabled: true, reason: 'r' },
    ...extra,
  }) as SkillEntry;

class MemoryStore implements LocalSkillInstallStore {
  state: LocalSkillInstallState = EMPTY_LOCAL_SKILL_INSTALL_STATE;
  writes = 0;
  async read(): Promise<LocalSkillInstallState> {
    return structuredClone(this.state);
  }

  async write(state: LocalSkillInstallState): Promise<void> {
    this.writes += 1;
    this.state = structuredClone(state);
  }
}

class FakeProjectSkills implements ProjectSkillFiles {
  constructor(readonly folders: FakeFolders) {}
  inspect(root: string, folder: string): Promise<SkillFolderReading> {
    return this.folders.read(`${root}/${folder}`);
  }

  async read(): Promise<SkillFilesReading> {
    return { files: new Map(), tooLarge: [] };
  }

  apply(root: string, folder: string, change: SkillFolderChange): Promise<void> {
    return this.folders.change(`${root}/${folder}`, change);
  }
}

class FakeRuntimeSkills implements RuntimeSkillAssets {
  failRemove: Error | undefined;
  constructor(readonly folders: FakeFolders) {}
  inspect(name: string): Promise<SkillFolderReading> {
    return this.folders.read(`runtime/${name}`);
  }

  async read(): Promise<SkillFilesReading> {
    return { files: new Map(), tooLarge: [] };
  }

  async remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void> {
    if (this.failRemove !== undefined) throw this.failRemove;
    await this.folders.change(`runtime/${name}`, { write: [], remove: [...expected.keys()], expected });
  }
}

export interface Rig {
  readonly service: LocalSkillInstallService;
  readonly store: MemoryStore;
  readonly tree: ConfinedTree;
  readonly folders: FakeFolders;
  readonly fleet: FakeFleet;
  readonly runtimeSkills: FakeRuntimeSkills;
  readonly previews: LocalSkillPreviews;
  readonly clock: { now: number };
  skills: SkillEntry[];
  roots: string[];
}

export function rig(options: { maxKept?: number } = {}): Rig {
  const store = new MemoryStore();
  const tree = new ConfinedTree();
  tree.set(ACCOUNT_SKILL, { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes', link: 'symlink' });
  tree.set(PROJECT_SKILL, { 'SKILL.md': SKILL_MD });
  const folders = new FakeFolders();
  const fleet = new FakeFleet(folders);
  const runtimeSkills = new FakeRuntimeSkills(folders);
  const clock = { now: Date.parse('2026-11-02T10:00:00.000Z') };
  const previews = new LocalSkillPreviews(600_000, options.maxKept);
  let minted = 0;
  const state = {
    store,
    tree,
    folders,
    fleet,
    runtimeSkills,
    previews,
    clock,
    skills: [
      entry(ACCOUNT_SKILL),
      entry(PROJECT_SKILL, { scope: 'project', project: { id: 'p1', root: '/work/other' } }),
    ],
    roots: [ROOT, '/work/app/'],
  } as unknown as Rig;
  const service = new LocalSkillInstallService(
    {
      crypto,
      store,
      skills: { list: async () => state.skills },
      skillTree: tree,
      fleetDirectory: FLEET_DIRECTORY,
      projectRoots: async () => state.roots,
      skillFiles: new FakeProjectSkills(folders),
      runtimeSkills,
      fleet: fleet.api,
      now: () => clock.now,
      mint: prefix => {
        minted += 1;
        return `${prefix}_${String(minted).padStart(22, 'a')}`;
      },
    },
    previews,
  );
  return Object.assign(state, { service });
}

export const projectTarget = (harness: 'claude' | 'codex' = 'claude', projectRoot = ROOT): CatalogInstallTarget => ({
  scope: 'project',
  projectRoot,
  harness,
});
export const runtimeTarget = (runtime = 'claude-work', profile = 'work'): CatalogInstallTarget => ({
  scope: 'runtime',
  runtime,
  profile,
});

/** Preview then apply: the two steps a person takes. */
export async function copy(
  rigged: Rig,
  target: CatalogInstallTarget,
  path = ACCOUNT_SKILL,
  caller: LocalSkillCaller = CALLER,
) {
  const preview = await rigged.service.preview(target.scope, { source: { path }, target }, caller);
  const installed = await rigged.service.apply(target.scope, preview.previewId, caller, GOVERNANCE);
  return { preview, installed };
}
