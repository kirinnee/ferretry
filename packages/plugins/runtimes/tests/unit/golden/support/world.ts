/**
 * The one synthetic world every E-276 golden is captured in: absolute paths that exist nowhere, ids from a fixed queue,
 * a fixed `generatedAt`, a fixed `fy` command. Nothing here reads the host (no clock, no environment, no disk).
 */
import { EMPTY_RUNTIME_IDS } from '../../../../daemon/lib/account/ids.ts';
import { type MaterialiseInput, materialiseFleet } from '../../../../daemon/lib/account/materialise.ts';
import { type AccountModel, type Credential, parseAccountModel } from '../../../../daemon/lib/account/schema.ts';
import { GOLDEN_CATALOGS } from './catalogs.ts';
import type { FleetLayout, FleetModelApplyPlan } from '../../../../daemon/lib/provisioning.ts';

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
};

export const FY_COMMAND = '/opt/ferretry/bin/fy';
const GENERATED_AT = '2026-10-13T08:00:00.000Z';
export const RUNTIME_ID = '00000000-0000-4000-8000-00000000000a';

export interface WorldOptions {
  /** `false`: the profile has no model set, so the runtime has no model to start on. */
  readonly defaultModel?: boolean;
  /** Hand the machine the synthetic model catalogs, and make an environment login read the `golden-gateway` preset's. */
  readonly catalogs?: boolean;
}

export type GoldenHarness = 'claude' | 'codex';
export type GoldenStore = 'host' | 'ferretry' | 'environment' | 'environment-provider';
export type GoldenPermissions = 'auto-accepted' | 'auto-refused' | 'skip';

/** The credential stores each harness has a golden for (a model provider is a Codex-only kind of environment login). */
export const STORES: Readonly<Record<GoldenHarness, readonly GoldenStore[]>> = {
  claude: ['host', 'ferretry', 'environment'],
  codex: ['host', 'ferretry', 'environment', 'environment-provider'],
};

export const PERMISSIONS: readonly GoldenPermissions[] = ['auto-accepted', 'auto-refused', 'skip'];

const credentialOf = (harness: GoldenHarness, store: GoldenStore, preset: boolean): Credential => {
  const named = preset ? { preset: 'golden-gateway' } : {};
  if (store === 'host') return { harness, store: 'host' };
  if (store === 'ferretry') return { harness, store: 'ferretry' };
  if (harness === 'claude') {
    return {
      harness,
      store: 'environment',
      ...named,
      env: { ANTHROPIC_API_KEY: '${secret:GOLDEN_KEY}', ANTHROPIC_BASE_URL: 'https://llm.example.test' },
    };
  }
  if (store === 'environment')
    return { harness, store: 'environment', ...named, env: { OPENAI_API_KEY: '${secret:GOLDEN_KEY}' } };
  return {
    harness,
    store: 'environment',
    env: { PROVIDER_API_KEY: '${secret:GOLDEN_KEY}' },
    codexProvider: {
      id: 'golden',
      name: 'Golden',
      baseUrl: 'https://llm.example.test/v1',
      keyVariable: 'PROVIDER_API_KEY',
      model: 'golden-model',
    },
  };
};

/** The three MCP server kinds every profile carries: a started command, a reached URL, a server signed in to from Ferretry. */
const MCP = {
  files: {
    command: 'npx',
    args: ['server-files', '--root', '/srv/files'],
    env: { FILES_TOKEN: '${secret:GOLDEN_FILES}', FILES_MODE: 'read' },
  },
  docs: { url: 'https://docs.example.test/mcp' },
  feed: { url: 'https://feed.example.test/sse' },
  notes: { url: 'https://notes.example.test/mcp', auth: 'oauth' as const },
};

/**
 * One machine with ONE runtime on the chosen harness, login store and Agent permissions, its profile carrying
 * instructions, all three MCP kinds, a skill and a model set that names a default model (or, with `defaultModel: false`, no model set at all).
 */
function worldModel(
  harness: GoldenHarness,
  store: GoldenStore,
  permissions: GoldenPermissions,
  options: WorldOptions = {},
): AccountModel {
  const withoutModel = options.defaultModel === false;
  const models = harness === 'claude' ? ['claude-opus-5-5', 'claude-sonnet-5-5'] : ['gpt-6', 'gpt-6-mini'];
  const credentialId = `${harness}-${store}`;
  return parseAccountModel({
    version: 1,
    machine: { agentPermissions: permissions === 'skip' ? 'skip' : 'auto' },
    credentials: { [credentialId]: credentialOf(harness, store, options.catalogs === true) },
    components: {
      instructions: { main: { file: 'components/instructions/main.md' } },
      mcp: MCP,
      skills: { mine: { items: ['review'] } },
      modelSets: { golden: { models, default: models[0] as string } },
    },
    profiles: {
      default: {
        layers: [
          'instructions/main',
          'mcp/files',
          'mcp/docs',
          'mcp/feed',
          'mcp/notes',
          'skills/mine',
          ...(withoutModel ? [] : ['modelSets/golden']),
        ],
      },
    },
    runtimes: { [`${harness}-golden`]: { credential: credentialId, profile: 'default' } },
  });
}

/** Where Logins keeps the Ferretry-kept login a world names (`LoginsApi.launchStores`): the one place a runtime learns its store. */
const loginStoresFor = (harness: GoldenHarness, credentialId: string): NonNullable<MaterialiseInput['loginStores']> => [
  harness === 'claude'
    ? {
        id: credentialId,
        variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `/fy/state/logins/credentials/${credentialId}` },
      }
    : { id: credentialId, variables: {}, signInFile: `/fy/state/logins/credentials/${credentialId}/auth.json` },
];

/** The plan the base produces for one world: every operation, the manifest, the ids and the shared-history requests. */
export function planOf(
  harness: GoldenHarness,
  store: GoldenStore,
  permissions: GoldenPermissions,
  options: WorldOptions = {},
): FleetModelApplyPlan {
  const model = worldModel(harness, store, permissions, options);
  return materialiseFleet({
    model,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: () => RUNTIME_ID,
    generatedAt: GENERATED_AT,
    claudeStatusline: own => (own === undefined ? "'fy' statusline" : `'fy' statusline --then '${own}'`),
    fyCommand: FY_COMMAND,
    harnessCommands: { claude: '/opt/harness/bin/claude', codex: '/opt/harness/bin/codex' },
    hostCodexHome: '/home/person/.codex',
    acceptsAutoPermissionMode: permissions !== 'auto-refused',
    loginStores: loginStoresFor(harness, `${harness}-${store}`),
    ...(options.catalogs === true ? { modelCatalogs: GOLDEN_CATALOGS } : {}),
    bodies: {
      instructions: { main: 'Be kind.\n' },
      skillFrontmatter: { review: ['name', 'description'] },
    },
  });
}
