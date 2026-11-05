import type { CatalogInstallTarget } from '@ferretry/protocol';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import type { FreshStepUpContext } from '../../../src/lib/fleet/catalog-service.ts';
import { LocalMcpPreviews } from '../../../src/lib/local-mcp-installs/previews.ts';
import { type LocalMcpCaller, LocalMcpInstallService } from '../../../src/lib/local-mcp-installs/service.ts';
import type { LocalMcpInventoryServer } from '../../../src/lib/local-mcp-installs/source.ts';
import {
  EMPTY_LOCAL_MCP_INSTALL_STATE,
  type LocalMcpInstallState,
  type LocalMcpInstallStore,
} from '../../../src/lib/local-mcp-installs/store.ts';
import { crypto } from '../../support/catalog-fixtures.ts';
import { FakeFleet, FakeFolders, FakeMcpFiles } from '../catalog-installs/service-support.ts';

export const GOVERNANCE = { governed: false } as unknown as CallerGovernance;
export const STEP_UP: FreshStepUpContext = { presentation: undefined, spend: () => undefined, agent: false };
export const ROOT = '/work/app';
export const CALLER: LocalMcpCaller = { id: 'device:dev_a', mayListSecrets: true };

/** Obviously fake: nothing here is, or looks like, a real credential. */
export const FAKE_VALUE = 'fake-value-not-a-real-key';

/** Ids the inventory would list: 24 hex digits. */
export const ACCOUNT_ID = '0123456789abcdef01234567';
export const PROJECT_ID = 'fedcba9876543210fedcba98';
export const COMPONENT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
export const URL_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
export const BAD_ID = 'cccccccccccccccccccccccc';

class MemoryStore implements LocalMcpInstallStore {
  state: LocalMcpInstallState = EMPTY_LOCAL_MCP_INSTALL_STATE;
  writes = 0;
  async read(): Promise<LocalMcpInstallState> {
    return structuredClone(this.state);
  }

  async write(state: LocalMcpInstallState): Promise<void> {
    this.writes += 1;
    this.state = structuredClone(state);
  }
}

export const stdioServer = (extra: Partial<LocalMcpInventoryServer> = {}): LocalMcpInventoryServer => ({
  id: ACCOUNT_ID,
  name: 'search',
  scope: 'user',
  harness: 'claude',
  source: '/home/me/.claude.json',
  declaration: {
    name: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'search-mcp'],
    env: { API_TOKEN: FAKE_VALUE, REGION: 'eu' },
  },
  runtimes: ['claude-work'],
  ...extra,
});

const servers = (): LocalMcpInventoryServer[] => [
  stdioServer(),
  stdioServer({
    id: PROJECT_ID,
    scope: 'project',
    source: '/work/other/.mcp.json',
    project: { root: '/work/other' },
    declaration: { name: 'search', transport: 'stdio', command: 'node', args: ['s.js'], env: {} },
  }),
  stdioServer({
    id: COMPONENT_ID,
    name: 'docs',
    scope: 'component',
    declaration: null,
    component: { command: 'docs-mcp', args: [], env: { DOCS_KEY: '${secret:DOCS_KEY}' } },
  }),
  stdioServer({
    id: URL_ID,
    name: 'remote',
    declaration: { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
  }),
  stdioServer({
    id: BAD_ID,
    name: 'bad one',
    declaration: { name: 'bad one', transport: 'stdio', command: 'x', args: [], env: {} },
  }),
];

export interface Rig {
  readonly service: LocalMcpInstallService;
  readonly store: MemoryStore;
  readonly mcp: FakeMcpFiles;
  readonly folders: FakeFolders;
  readonly fleet: FakeFleet;
  readonly previews: LocalMcpPreviews;
  readonly clock: { now: number };
  servers: LocalMcpInventoryServer[];
  secrets: Set<string>;
  roots: string[];
}

export function rig(options: { maxKept?: number } = {}): Rig {
  const store = new MemoryStore();
  const mcp = new FakeMcpFiles();
  const folders = new FakeFolders();
  const fleet = new FakeFleet(folders);
  const clock = { now: Date.parse('2026-11-02T10:00:00.000Z') };
  const previews = new LocalMcpPreviews(600_000, options.maxKept);
  let minted = 0;
  const state = {
    store,
    mcp,
    folders,
    fleet,
    previews,
    clock,
    servers: servers(),
    secrets: new Set(['MY_TOKEN', 'MY_VAR', 'lower_case']),
    roots: [ROOT, '/work/app/'],
  } as unknown as Rig;
  const service = new LocalMcpInstallService(
    {
      crypto,
      store,
      servers: async () => state.servers,
      projectRoots: async () => state.roots,
      mcpFiles: mcp,
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
  options: { id?: string; bindings?: Record<string, string | null>; caller?: LocalMcpCaller } = {},
) {
  const caller = options.caller ?? CALLER;
  const preview = await rigged.service.preview(
    target.scope,
    { source: { id: options.id ?? ACCOUNT_ID }, target },
    caller,
  );
  const bindings =
    options.bindings ?? Object.fromEntries(preview.secrets.map(secret => [secret.placeholder, null] as const));
  const installed = await rigged.service.apply(target.scope, preview.previewId, bindings, caller, GOVERNANCE);
  return { preview, installed };
}
