import type { SkillEntry, SkillInstallTarget } from '../../contract/index.ts';
import { LocalSkillInstallService, type LocalSkillCaller } from '../../daemon/lib/installs/service.ts';
import { LocalSkillPreviews } from '../../daemon/lib/installs/previews.ts';
import {
  type ProjectSkillFiles,
  type ReadSkillFolder,
  type RuntimeSkillAssets,
  type RuntimeSkillTarget,
  SkillFolderChanged,
  type SkillFolderChange,
  SkillFolderRefused,
  type SkillFolderReader,
  type SkillFolderReading,
} from '../../daemon/lib/installs/ports.ts';
import {
  EMPTY_LOCAL_SKILL_INSTALL_STATE,
  type LocalSkillInstallState,
  type LocalSkillInstallStore,
} from '../../daemon/lib/installs/store.ts';

export const FLEET_DIRECTORY = '/fleet';
export const SKILL_MD = '---\nname: demo\ndescription: Does the demo thing\n---\nBody\n';

const sha = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

type Marker = 'symlink' | 'other' | 'deep' | 'hardlink';

/**
 * A skill folder reader held in memory. Like the real one it reports a link, a device or a too-deep folder as a
 * skipped problem and carries the rest; when given a boundary a folder whose RESOLVED place (set with `resolveTo`) is
 * outside it is not read. `swapAfterList` moves the folder outside once it has been read once.
 */
export class MemoryTree implements SkillFolderReader {
  readonly folders = new Map<string, Map<string, string | Marker>>();
  readonly boundaries: { readonly manifest: string; readonly confinedTo?: string }[] = [];
  readonly #resolved = new Map<string, string>();
  swapAfterList: string | undefined;

  set(manifest: string, files: Record<string, string | Marker>): void {
    this.folders.set(manifest, new Map(Object.entries(files)));
  }

  resolveTo(manifest: string, place: string): void {
    this.#resolved.set(manifest, place);
  }

  async read(manifest: string, boundary: string): Promise<ReadSkillFolder> {
    this.boundaries.push({ manifest, confinedTo: boundary });
    const folder = this.folders.get(manifest);
    const place = this.#resolved.get(manifest);
    const outside = place !== undefined && place !== boundary && !place.startsWith(`${boundary}/`);
    if (this.swapAfterList !== undefined) this.#resolved.set(manifest, this.swapAfterList);
    if (folder === undefined || outside)
      return {
        files: [],
        problems: [],
        refusal: 'The skill folder cannot be read any more. It may have been moved or deleted.',
      };
    const files: { path: string; content: string }[] = [];
    const problems: { subject: string; reason: string }[] = [];
    for (const [path, value] of folder) {
      if (value === 'symlink' || value === 'hardlink' || value === 'other' || value === 'deep')
        problems.push({ subject: path, reason: `not carried: ${value}` });
      else files.push({ path, content: value });
    }
    if (!files.some(file => file.path === 'SKILL.md'))
      return { files, problems, refusal: 'SKILL.md cannot be carried: it is not in the folder.' };
    return { files, problems };
  }
}

/** A folder store that hashes like the real adapter, so the service compares real hashes. */
export class FakeFolders {
  readonly folders = new Map<string, Map<string, string>>();
  refuse: string | undefined;
  fail: Error | undefined;
  racing = false;

  async read(key: string): Promise<SkillFolderReading> {
    if (this.fail !== undefined) throw this.fail;
    if (this.refuse !== undefined) throw new SkillFolderRefused(this.refuse);
    const files = this.folders.get(key);
    if (files === undefined) return { exists: false, files: new Map() };
    return {
      exists: true,
      files: new Map(await Promise.all([...files].map(async ([path, text]) => [path, await sha(text)] as const))),
    };
  }

  async change(key: string, change: SkillFolderChange): Promise<void> {
    const current = await this.read(key);
    for (const [path, expected] of change.expected)
      if (this.racing || (current.files.get(path) ?? null) !== expected) throw new SkillFolderChanged();
    const files = this.folders.get(key) ?? new Map<string, string>();
    for (const file of change.write) files.set(file.path, file.content);
    for (const path of change.remove) files.delete(path);
    if (files.size === 0) this.folders.delete(key);
    else this.folders.set(key, files);
  }
}

interface FakeComponent {
  name: string;
  detail?: unknown;
  provenance?: unknown;
}

export class FakeFleet implements RuntimeSkillTarget {
  readonly proposed: Record<string, unknown>[] = [];
  readonly components = new Map<'mcp' | 'skills', FakeComponent[]>([
    ['mcp', []],
    ['skills', []],
  ]);
  failApply: Error | undefined;
  constructor(private readonly assets: FakeFolders) {}

  async runtimes() {
    return [
      { id: 'rt-claude', name: 'claude-work', profile: 'work' },
      { id: 'rt-codex', name: 'codex-work', profile: 'work' },
      { id: 'rt-orphan', name: 'orphan', profile: 'gone' },
    ];
  }

  async profiles() {
    return [{ name: 'work' }, { name: 'play' }];
  }

  async storedComponent(name: string): Promise<unknown> {
    const found = (this.components.get('skills') ?? []).find(component => component.name === name);
    return found === undefined ? undefined : { ...(found.detail as object), installedFrom: found.provenance };
  }

  async install(change: Parameters<RuntimeSkillTarget['install']>[0]): Promise<{ component: unknown }> {
    this.proposed.push({ kind: 'catalog.install', ...change, installedFrom: change.provenance });
    if (this.failApply !== undefined) throw this.failApply;
    const list = (this.components.get('skills') ?? []).filter(component => component.name !== change.name);
    const stored: FakeComponent = {
      name: change.name,
      detail: { kind: 'skills', items: [change.name] },
      provenance: change.provenance,
    };
    list.push(stored);
    this.components.set('skills', list);
    for (const file of change.files) {
      const folder = this.assets.folders.get(`runtime/${change.name}`) ?? new Map<string, string>();
      folder.set(file.path, file.content);
      this.assets.folders.set(`runtime/${change.name}`, folder);
    }
    return { component: { ...(stored.detail as object), installedFrom: stored.provenance } };
  }

  async removeComponent(name: string): Promise<void> {
    this.proposed.push({ kind: 'component.remove', componentKind: 'skills', name });
    if (this.failApply !== undefined) throw this.failApply;
    this.components.set(
      'skills',
      (this.components.get('skills') ?? []).filter(component => component.name !== name),
    );
  }
}

class FakeProjectSkills implements ProjectSkillFiles {
  constructor(readonly folders: FakeFolders) {}
  inspect(root: string, folder: string): Promise<SkillFolderReading> {
    return this.folders.read(`${root}/${folder}`);
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

  async remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void> {
    if (this.failRemove !== undefined) throw this.failRemove;
    await this.folders.change(`runtime/${name}`, { write: [], remove: [...expected.keys()], expected });
  }
}

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

export const ROOT = '/work/app';
export const CALLER: LocalSkillCaller = { id: 'device:dev_a' };

/** An account's skill and a project's skill, as the machine inventory would list them. */
export const ACCOUNT_SKILL = '/home/me/.claude/skills/demo/SKILL.md';
export const PROJECT_SKILL = '/work/other/.claude/skills/tool/SKILL.md';

const entry = (path: string, extra: Partial<SkillEntry> = {}): SkillEntry =>
  ({
    name: 'x',
    description: 'd',
    harness: 'claude-code',
    scope: 'user',
    path,
    runtimes: ['claude-work'],
    toggle: { supported: false, enabled: true, reason: 'r' },
    ...extra,
  }) as SkillEntry;

export interface Rig {
  readonly service: LocalSkillInstallService;
  readonly store: MemoryStore;
  readonly tree: MemoryTree;
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
  const tree = new MemoryTree();
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
      crypto: { sha256: async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))) },
      store,
      skills: { list: async () => state.skills },
      skillTree: tree,
      fleetDirectory: FLEET_DIRECTORY,
      projectRoots: async () => state.roots,
      skillFiles: new FakeProjectSkills(folders),
      runtimeSkills,
      fleet,
      reviewer: {
        review: (_name, files) => ({
          review: files.map(file => ({ label: file.path, text: file.content, document: true })),
          warnings: [],
        }),
      },
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

export const projectTarget = (
  harness: 'claude-code' | 'codex' = 'claude-code',
  projectRoot = ROOT,
): SkillInstallTarget => ({ scope: 'project', projectRoot, harness });
export const runtimeTarget = (runtime = 'claude-work', profile = 'work'): SkillInstallTarget => ({
  scope: 'runtime',
  runtime,
  profile,
});

/** Preview then apply: the two steps a person takes. */
export async function copy(
  rigged: Rig,
  target: SkillInstallTarget,
  path = ACCOUNT_SKILL,
  caller: LocalSkillCaller = CALLER,
) {
  const preview = await rigged.service.preview(target.scope, { source: { path }, target }, caller);
  const installed = await rigged.service.apply(target.scope, preview.previewId, caller);
  return { preview, installed };
}
