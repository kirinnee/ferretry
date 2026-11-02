import type {
  CatalogInstalled,
  CatalogInstallPreview,
  CatalogInstall,
  CatalogInstallPrefsRequest,
  CatalogInstallPreviewRequest,
  CatalogInstallRequest,
  CatalogInstallScope,
  CatalogInstallTarget,
  FleetAccountChange,
  FleetAccountChangeView,
  FleetCatalogInstallChange,
  FleetLayeredProfileCatalog,
  FleetRuntimeCatalog,
  SignedCatalogItemVersions,
} from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import {
  type CatalogCaller,
  CatalogInstallService,
  type CatalogInstallServiceDeps,
} from '../../../src/lib/catalog-installs/service.ts';
import {
  type CatalogInstallState,
  type CatalogInstallStore,
  EMPTY_CATALOG_INSTALL_STATE,
} from '../../../src/lib/catalog-installs/store.ts';
import {
  type ProjectSkillFiles,
  type RuntimeSkillAssets,
  SkillFolderChanged,
  SkillFolderRefused,
  type SkillFolderChange,
  type SkillFilesReading,
  type SkillFolderReading,
} from '../../../src/lib/catalog-installs/ports.ts';
import {
  type CatalogInstallPrefsState,
  type CatalogInstallPrefsStore,
  EMPTY_CATALOG_INSTALL_PREFS,
} from '../../../src/lib/catalog-installs/prefs.ts';
import { CatalogPreviews } from '../../../src/lib/catalog-installs/previews.ts';
import type { FreshStepUpContext } from '../../../src/lib/fleet/catalog-service.ts';
import {
  McpProjectFileChanged,
  type McpProjectFileReading,
  type McpProjectFiles,
} from '../../../src/lib/session-mcp/service.ts';
import { crypto, publish, type Published } from '../../support/catalog-fixtures.ts';

export const GOVERNANCE = { governed: false } as unknown as CallerGovernance;
export const STEP_UP: FreshStepUpContext = { presentation: undefined, spend: () => undefined, agent: false };
export const ROOT = '/work/app';
export const CALLER: CatalogCaller = { id: 'device:dev_a', mayListSecrets: true };

/** The service as ONE caller sees it: the caller is fixed, so a case reads as the two steps it is. */
export class AsCaller {
  constructor(
    private readonly inner: CatalogInstallService,
    readonly caller: CatalogCaller,
  ) {}

  preview(scope: CatalogInstallScope, request: CatalogInstallPreviewRequest): Promise<CatalogInstallPreview> {
    return this.inner.preview(scope, request, this.caller);
  }

  apply(
    scope: CatalogInstallScope,
    request: CatalogInstallRequest,
    governance: CallerGovernance | undefined,
    _stepUp?: FreshStepUpContext,
  ): Promise<CatalogInstalled> {
    return this.inner.apply(scope, request, this.caller, governance);
  }

  setPrefs(
    scope: CatalogInstallScope,
    installId: string,
    request: CatalogInstallPrefsRequest,
  ): Promise<CatalogInstall> {
    return this.inner.setPrefs(scope, installId, request);
  }

  list: CatalogInstallService['list'] = () => this.inner.list();
  remove: CatalogInstallService['remove'] = (scope, installId, governance, stepUp) =>
    this.inner.remove(scope, installId, governance, stepUp);
}

const sha = async (text: string): Promise<string> =>
  Array.from(await crypto.sha256(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('');

class MemoryStore implements CatalogInstallStore {
  state: CatalogInstallState = EMPTY_CATALOG_INSTALL_STATE;
  writes = 0;
  async read(): Promise<CatalogInstallState> {
    return structuredClone(this.state);
  }

  async write(state: CatalogInstallState): Promise<void> {
    this.writes += 1;
    this.state = structuredClone(state);
  }
}

class MemoryPrefs implements CatalogInstallPrefsStore {
  state: CatalogInstallPrefsState = EMPTY_CATALOG_INSTALL_PREFS;
  failWrite: Error | undefined;
  async read(): Promise<CatalogInstallPrefsState> {
    return structuredClone(this.state);
  }

  async write(state: CatalogInstallPrefsState): Promise<void> {
    if (this.failWrite !== undefined) throw this.failWrite;
    this.state = structuredClone(state);
  }
}

class FakeMcpFiles implements McpProjectFiles {
  text: string | null = null;
  version = 0;
  failRead: Error | undefined;
  racing = false;
  async read(): Promise<McpProjectFileReading> {
    if (this.failRead !== undefined) throw this.failRead;
    return { text: this.text, etag: this.text === null ? null : `e${this.version}` };
  }

  async replace(_path: string, text: string, expected: string | null): Promise<string> {
    const current = this.text === null ? null : `e${this.version}`;
    if (this.racing || expected !== current) throw new McpProjectFileChanged();
    this.text = text;
    this.version += 1;
    return `e${this.version}`;
  }
}

/** A folder store that hashes like the real adapter, so the service compares real hashes. */
export class FakeFolders {
  readonly folders = new Map<string, Map<string, string>>();
  refuse: string | undefined;
  fail: Error | undefined;
  racing = false;
  /** Paths whose bytes are "too large" for the bounded read. */
  readonly tooLarge = new Set<string>();
  failReadFiles: Error | undefined;

  async readFiles(key: string, paths: readonly string[]): Promise<SkillFilesReading> {
    if (this.failReadFiles !== undefined) throw this.failReadFiles;
    const files = new Map<string, string>();
    const tooLarge: string[] = [];
    for (const path of paths) {
      const text = this.folders.get(key)?.get(path);
      if (text === undefined) continue;
      if (this.tooLarge.has(path)) tooLarge.push(path);
      else files.set(path, text);
    }
    return { files, tooLarge };
  }

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

class FakeProjectSkills implements ProjectSkillFiles {
  constructor(readonly folders: FakeFolders) {}
  inspect(root: string, folder: string): Promise<SkillFolderReading> {
    return this.folders.read(`${root}/${folder}`);
  }

  apply(root: string, folder: string, change: SkillFolderChange): Promise<void> {
    return this.folders.change(`${root}/${folder}`, change);
  }

  read(root: string, folder: string, paths: readonly string[]): Promise<SkillFilesReading> {
    return this.folders.readFiles(`${root}/${folder}`, paths);
  }
}

class FakeRuntimeSkills implements RuntimeSkillAssets {
  constructor(readonly folders: FakeFolders) {}
  inspect(name: string): Promise<SkillFolderReading> {
    return this.folders.read(`runtime/${name}`);
  }

  read(name: string, paths: readonly string[]): Promise<SkillFilesReading> {
    return this.folders.readFiles(`runtime/${name}`, paths);
  }

  async remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void> {
    await this.folders.change(`runtime/${name}`, { write: [], remove: [...expected.keys()], expected });
  }
}

interface FakeComponent {
  name: string;
  detail?: unknown;
  installedFrom?: { digest: string };
}

/** A component as the fleet hands it back: the record itself, with where it came from. */
const asStored = (component: FakeComponent | undefined): unknown =>
  component === undefined
    ? undefined
    : {
        ...(component.detail as object),
        ...(component.installedFrom === undefined ? {} : { installedFrom: component.installedFrom }),
      };

export class FakeFleet {
  readonly proposed: (FleetAccountChange | FleetCatalogInstallChange)[] = [];
  readonly applied: string[] = [];
  readonly components = new Map<'mcp' | 'skills', FakeComponent[]>([
    ['mcp', []],
    ['skills', []],
  ]);
  failApply: Error | undefined;

  constructor(private readonly assets: FakeFolders) {}

  readonly api: CatalogInstallServiceDeps['fleet'] = {
    runtimes: async () =>
      ({
        format: 'version-2',
        runtimes: [
          { id: 'rt-claude', name: 'claude-work', profile: 'work', harness: 'claude' },
          { id: 'rt-codex', name: 'codex-work', profile: 'work', harness: 'codex' },
          { id: 'rt-orphan', name: 'orphan', profile: 'gone', harness: 'claude' },
        ],
      }) as unknown as FleetRuntimeCatalog,
    profiles: async () =>
      ({
        format: 'version-2',
        profiles: [{ name: 'work' }, { name: 'play' }],
      }) as unknown as FleetLayeredProfileCatalog,
    storedComponent: async (kind, name) =>
      asStored(this.components.get(kind)?.find(component => component.name === name)),
    propose: async change => {
      this.proposed.push(change);
      return { id: `change-${this.proposed.length}` } as FleetAccountChangeView;
    },
    installCatalogItem: async change => {
      this.proposed.push(change);
      this.applied.push(`change-${this.proposed.length}`);
      if (this.failApply !== undefined) throw this.failApply;
      const kind = change.component.kind === 'mcp' ? 'mcp' : 'skills';
      const list = (this.components.get(kind) ?? []).filter(component => component.name !== change.name);
      const stored: FakeComponent = {
        name: change.name,
        detail: change.component,
        installedFrom: change.installedFrom,
      };
      list.push(stored);
      this.components.set(kind, list);
      for (const file of change.files) {
        const folder = this.assets.folders.get(`runtime/${change.name}`) ?? new Map<string, string>();
        folder.set(file.path, file.content);
        this.assets.folders.set(`runtime/${change.name}`, folder);
      }
      return { outcome: { outcome: 'executed', executor: 'setup', summary: 'done' }, component: asStored(stored) };
    },
    apply: async id => {
      this.applied.push(id);
      if (this.failApply !== undefined) throw this.failApply;
      const change = this.proposed[Number(id.slice('change-'.length)) - 1] as FleetAccountChange;
      if (change.kind === 'component.remove')
        this.components.set(
          change.componentKind as 'mcp' | 'skills',
          (this.components.get(change.componentKind as 'mcp' | 'skills') ?? []).filter(
            component => component.name !== change.name,
          ),
        );
      return { outcome: 'executed', executor: 'setup', summary: 'done' };
    },
  };
}

export interface Rig {
  readonly service: AsCaller;
  /** The service itself, for a case that is about who is calling. */
  readonly inner: CatalogInstallService;
  as(caller: CatalogCaller): AsCaller;
  readonly store: MemoryStore;
  readonly prefs: MemoryPrefs;
  readonly mcp: FakeMcpFiles;
  readonly folders: FakeFolders;
  readonly fleet: FakeFleet;
  readonly previews: CatalogPreviews;
  readonly clock: { now: number };
  secrets: Set<string>;
  roots: string[];
}

export function rig(options: { maxKept?: number } = {}): Rig {
  const store = new MemoryStore();
  const prefs = new MemoryPrefs();
  const mcp = new FakeMcpFiles();
  const folders = new FakeFolders();
  const fleet = new FakeFleet(folders);
  const clock = { now: Date.parse('2026-10-31T10:00:00.000Z') };
  const previews = new CatalogPreviews(600_000, options.maxKept);
  let minted = 0;
  const state: Rig = {
    store,
    prefs,
    mcp,
    folders,
    fleet,
    previews,
    clock,
    secrets: new Set(['ACME_TOKEN_OWN', 'OTHER']),
    roots: [ROOT, '/work/app/'],
    service: undefined as unknown as AsCaller,
    inner: undefined as unknown as CatalogInstallService,
    as: undefined as unknown as Rig['as'],
  };
  const service = new CatalogInstallService(
    {
      crypto,
      store,
      prefs,
      projectRoots: async () => state.roots,
      mcpFiles: mcp,
      skillFiles: new FakeProjectSkills(folders),
      runtimeSkills: new FakeRuntimeSkills(folders),
      fleet: fleet.api,
      secretNames: async () => state.secrets,
      now: () => clock.now,
      mint: prefix => {
        minted += 1;
        return `${prefix}_${String(minted).padStart(22, 'a')}`;
      },
    },
    previews,
  );
  return Object.assign(state, {
    service: new AsCaller(service, CALLER),
    inner: service,
    as: (caller: CatalogCaller) => new AsCaller(service, caller),
  });
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

export async function request(
  identity: DaemonIdentity,
  item: Published['items'][number],
  target: CatalogInstallTarget,
  options: {
    revision?: number;
    catalogId?: string;
    allowOlder?: true;
    replaceEdited?: true;
    signedVersions?: SignedCatalogItemVersions;
  } = {},
): Promise<CatalogInstallPreviewRequest> {
  const published = await publish(identity, [item], options);
  return {
    signedManifest: published.signedManifest,
    item,
    target,
    ...(options.allowOlder === true ? { allowOlder: true as const } : {}),
    ...(options.replaceEdited === true ? { replaceEdited: true as const } : {}),
    ...(options.signedVersions === undefined ? {} : { signedVersions: options.signedVersions }),
  };
}
