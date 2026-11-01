import { describe, it } from 'bun:test';
import should from 'should';
import { AGENT_BASE_INSTRUCTION, CLAUDE_QUESTION_HOOKS, tomlString } from '../../src/lib/account/fixed-layer.ts';
import { EMPTY_RUNTIME_IDS, type RuntimeIds } from '../../src/lib/account/ids.ts';
import {
  FIXED_SETTINGS_FILE,
  FleetMaterialiseError,
  MATERIALISED_RECORD_FILE,
  type MaterialiseInput,
  materialiseFleet,
  RUNTIME_STATE_DIRECTORY,
} from '../../src/lib/account/materialise.ts';
import { type AccountModel, type AccountModelDocument, parseAccountModel } from '../../src/lib/account/schema.ts';
import { builtInModelCatalogs } from '../../src/lib/models/catalog.ts';
import { builtInPresets } from '../../src/lib/presets/catalog.ts';
import type { FleetLayout, FleetModelApplyPlan, FleetWriteOperation } from '../../src/lib/provisioning.ts';
import { MANAGED_MARKER, shellQuote } from '../../src/lib/wrappers.ts';

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

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';
const HOME_A = `/fy/fleet/homes/${ID_A}`;
const HOME_B = `/fy/fleet/homes/${ID_B}`;

const COMPONENTS = {
  instructions: { main: { file: 'components/instructions/main.md' } },
  mcp: { github: { command: 'npx', args: ['server-github'], env: { GITHUB_TOKEN: '${secret:GH_TOKEN}' } } },
  skills: { mine: { items: ['review'] } },
  modelSets: {
    claude: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], default: 'claude-opus-5-5' },
    codex: { models: ['gpt-6'], default: 'gpt-6' },
  },
} satisfies AccountModelDocument['components'];

const DEFAULT_LAYERS = ['instructions/main', 'mcp/github', 'skills/mine', 'modelSets/claude', 'modelSets/codex'];

/** A two-runtime machine: Claude on the person's own login, Codex on a login Ferretry keeps. */
const modelOf = (overrides: Partial<AccountModelDocument> = {}): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: {
      'claude-you': { harness: 'claude', store: 'host' },
      'codex-work': { harness: 'codex', store: 'ferretry' },
    },
    components: COMPONENTS,
    profiles: { default: { layers: DEFAULT_LAYERS } },
    runtimes: {
      'claude-default': { credential: 'claude-you', profile: 'default' },
      'codex-default': { credential: 'codex-work', profile: 'default' },
    },
    ...overrides,
  });

/** Mints ids in order, so a test knows which runtime gets which. */
const minter = (...ids: string[]) => {
  const queue = [...ids];
  return () => queue.shift() ?? 'exhausted';
};

const plan = (model: AccountModel, overrides: Partial<MaterialiseInput> = {}): FleetModelApplyPlan =>
  materialiseFleet({
    model,
    layout: LAYOUT,
    ids: EMPTY_RUNTIME_IDS,
    mint: minter(ID_A, ID_B, ID_C),
    generatedAt: '2026-10-13T08:00:00.000Z',
    claudeStatusline: own => (own === undefined ? "'fy' statusline" : `'fy' statusline --then '${own}'`),
    fyCommand: '/opt/ferretry/bin/fy',
    hostCodexHome: '/home/person/.codex',
    acceptsAutoPermissionMode: true,
    ...overrides,
  });

const at = (result: FleetModelApplyPlan, path: string): FleetWriteOperation[] =>
  result.operations.filter(operation => operation.path === path);

const only = (result: FleetModelApplyPlan, path: string): FleetWriteOperation => {
  const found = at(result, path);
  should(found).have.length(1);
  return found[0] as FleetWriteOperation;
};

const wrapperOf = (result: FleetModelApplyPlan, name: string): string => {
  const operation = only(result, `/fy/fleet/bin/${name}`);
  if (operation.kind !== 'file') throw new Error(`${name} is not a file`);
  return operation.content;
};

const failure = (run: () => unknown): FleetMaterialiseError => {
  try {
    run();
  } catch (error) {
    if (error instanceof FleetMaterialiseError) return error;
    throw error;
  }
  throw new Error('expected the plan to be refused');
};

describe('materialiseFleet', () => {
  it('should mint an id per runtime and write ids.json inside the same plan', () => {
    // Arrange / Act
    const result = plan(modelOf());

    // Assert
    should(result.ids.runtimes).eql({
      'claude-default': { id: ID_A, formerNames: [] },
      'codex-default': { id: ID_B, formerNames: [] },
    });
    const ids = only(result, '/fy/fleet/ids.json');
    should(ids).match({ kind: 'file', mode: 0o600 });
    should(JSON.parse((ids as { content: string }).content).runtimes['claude-default'].id).equal(ID_A);
  });

  it('should keep an existing id and put a migrated runtime in the config directory it already has', () => {
    // Arrange
    const ids: RuntimeIds = {
      version: 1,
      runtimes: { 'claude-default': { id: ID_C, formerNames: ['claude-old'], home: 'claude-default' } },
    };

    // Act
    const result = plan(modelOf(), { ids });

    // Assert
    should(result.ids.runtimes['claude-default']).eql({
      id: ID_C,
      formerNames: ['claude-old'],
      home: 'claude-default',
    });
    should(at(result, '/fy/fleet/homes/claude-default')).not.be.empty();
    should(result.manifest.runtimes?.[0]).match({ id: ID_C, name: 'claude-default' });
  });

  it('should refuse two runtimes recorded with one config directory', () => {
    // Arrange
    const ids: RuntimeIds = {
      version: 1,
      runtimes: {
        'claude-default': { id: ID_A, formerNames: [], home: 'shared' },
        'codex-default': { id: ID_B, formerNames: [], home: 'shared' },
      },
    };

    // Act
    const error = failure(() => plan(modelOf(), { ids }));

    // Assert
    should(error.problems).eql([
      {
        runtime: 'codex-default',
        message: `its config directory /fy/fleet/homes/shared is already runtime "claude-default"'s`,
      },
    ]);
    should(error.message).startWith('the fleet cannot be applied: codex-default: its config directory');
  });

  it('should create the fleet directories, every Ferretry-kept login and the Codex SQLite pool', () => {
    // Act
    const result = plan(modelOf());

    // Assert
    should(result.operations.slice(0, 3)).eql([
      { kind: 'directory', path: '/fy/fleet', mode: 0o700 },
      { kind: 'directory', path: '/fy/fleet/bin', mode: 0o700 },
      { kind: 'directory', path: '/fy/fleet/homes', mode: 0o700 },
    ]);
    should(only(result, '/fy/fleet/credentials/codex-work')).eql({
      kind: 'directory',
      path: '/fy/fleet/credentials/codex-work',
      mode: 0o700,
    });
    should(at(result, '/fy/fleet/credentials/claude-you')).be.empty();
    should(only(result, '/fy/fleet/shared/codex/sqlite')).match({ kind: 'directory', mode: 0o700 });
  });

  it('should leave the Codex SQLite pool alone on a machine with no Codex runtime', () => {
    // Arrange
    const model = modelOf({ runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default' } } });

    // Act / Assert
    should(at(plan(model), '/fy/fleet/shared/codex/sqlite')).be.empty();
  });

  it('should materialise a Claude config directory with links, the narrowed sweep and the record last', () => {
    // Act
    const result = plan(modelOf());
    const inHome = result.operations.filter(operation => operation.path.startsWith(HOME_A));

    // Assert
    should(inHome.map(operation => [operation.kind, operation.path.slice(HOME_A.length)])).eql([
      ['directory', ''],
      ['directory', '/.fy'],
      ['prune-directory', '/.fy'],
      ['prune-directory', ''],
      ['symlink', '/CLAUDE.md'],
      ['directory', '/skills'],
      ['symlink', '/skills/review'],
      ['prune-directory', '/skills'],
      ['settings', '/settings.json'],
      ['settings', '/.claude.json'],
      ['file', '/.fy/materialised.json'],
    ]);
    should(inHome[3]).eql({
      kind: 'prune-directory',
      path: HOME_A,
      keep: [],
      only: ['hooks'],
      record: `${HOME_A}/${RUNTIME_STATE_DIRECTORY}/${MATERIALISED_RECORD_FILE}`,
    });
    should(inHome[2]).eql({ kind: 'prune-directory', path: `${HOME_A}/.fy`, keep: ['materialised.json'] });
    should(inHome[4]).eql({
      kind: 'symlink',
      source: '/fy/fleet/assets/components/instructions/main.md',
      path: `${HOME_A}/CLAUDE.md`,
    });
    should(inHome[6]).eql({
      kind: 'symlink',
      source: '/fy/fleet/assets/skills/review',
      path: `${HOME_A}/skills/review`,
    });
    should(inHome[7]).eql({ kind: 'prune-directory', path: `${HOME_A}/skills`, keep: ['review'] });
    should(inHome[8]).eql({
      kind: 'settings',
      path: `${HOME_A}/settings.json`,
      format: 'json',
      layers: [{ from: 'inline', settings: { statusLine: { type: 'command', command: "'fy' statusline" } } }],
      mode: 0o600,
      preserveExisting: true,
    });
    should(inHome[9]).eql({
      kind: 'settings',
      path: `${HOME_A}/.claude.json`,
      format: 'json',
      layers: [
        {
          from: 'inline',
          settings: {
            mcpServers: {
              github: {
                type: 'stdio',
                command: 'npx',
                args: ['server-github'],
                env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
              },
            },
          },
        },
      ],
      mode: 0o600,
      preserveExisting: true,
      replaceKeys: ['mcpServers'],
    });
    should(inHome[10]).eql({
      kind: 'file',
      path: `${HOME_A}/.fy/materialised.json`,
      content: '{"version":1,"entries":["CLAUDE.md"]}\n',
      mode: 0o600,
    });
  });

  it('should link a Codex config directory to its canonical auth.json and never sweep .system', () => {
    // Act
    const result = plan(modelOf());

    // Assert
    should(only(result, `${HOME_B}/auth.json`)).eql({
      kind: 'symlink',
      source: '/fy/fleet/credentials/codex-work/auth.json',
      path: `${HOME_B}/auth.json`,
      dangling: true,
    });
    should(at(result, `${HOME_B}/skills`)[0]).eql({ kind: 'directory', path: `${HOME_B}/skills`, mode: 0o700 });
    const sweeps = result.operations.filter(
      operation => operation.kind === 'prune-directory' && operation.path === `${HOME_B}/skills`,
    );
    should(sweeps).eql([{ kind: 'prune-directory', path: `${HOME_B}/skills`, keep: ['review', '.system'] }]);
    should(only(result, `${HOME_B}/config.toml`)).match({
      kind: 'settings',
      format: 'toml',
      preserveExisting: true,
      layers: [
        {
          from: 'inline',
          settings: {
            mcp_servers: { github: { command: 'npx', args: ['server-github'], env_vars: ['GITHUB_TOKEN'] } },
            cli_auth_credentials_store: 'file',
            sqlite_home: '/fy/fleet/shared/codex/sqlite',
          },
        },
      ],
    });
    should(JSON.parse((only(result, `${HOME_B}/.fy/materialised.json`) as { content: string }).content)).eql({
      version: 1,
      entries: ['AGENTS.md', 'auth.json'],
    });
  });

  it("should link a host Codex runtime to the person's own auth.json", () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': { harness: 'claude', store: 'host' },
        'codex-work': { harness: 'codex', store: 'host' },
      },
    });

    // Act
    const result = plan(model);

    // Assert
    should(only(result, `${HOME_B}/auth.json`)).match({ source: '/home/person/.codex/auth.json', dangling: true });
    should(at(result, '/fy/fleet/credentials/codex-work')).be.empty();
  });

  it('should make a host Codex runtime unlaunchable, not the fleet, when the Codex home cannot be named', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': { harness: 'claude', store: 'host' },
        'codex-work': { harness: 'codex', store: 'host' },
      },
    });

    // Act
    const result = plan(model, { hostCodexHome: undefined });

    // Assert
    const reason =
      'its login "codex-work" cannot be reached: your own Codex home could not be named, because CODEX_HOME is set to a relative path';
    should(wrapperOf(result, 'codex-default')).containEql(
      `echo 'ferretry: codex-default cannot start: ${reason}' >&2\nexit 1`,
    );
    should(wrapperOf(result, 'codex-default')).not.containEql('exec codex');
    should(result.manifest.accounts[1]).match({ available: false, unavailableReason: reason });
    should(at(result, `${HOME_B}/auth.json`)).be.empty();
  });

  it('should write a wrapper that exports the config directory, the credential store and the FY variables', () => {
    // Act
    const wrapper = wrapperOf(plan(modelOf()), 'claude-default');

    // Assert
    should(wrapper.startsWith(`#!/bin/sh\n${MANAGED_MARKER}\n# runtime claude-default ${ID_A} (claude)\n`)).be.true();
    should(wrapper).containEql(`export CLAUDE_CONFIG_DIR='${HOME_A}'`);
    should(wrapper).containEql("export CLAUDE_SECURESTORAGE_CONFIG_DIR=''");
    should(wrapper).containEql("export FY_CREDENTIAL='claude-you'");
    should(wrapper).containEql("export FY_RUNTIME='claude-default'");
    should(wrapper).containEql("export FY_HOME='/fy'");
    should(wrapper).containEql('${GITHUB_TOKEN:?ferretry: GITHUB_TOKEN is not set');
    should(wrapper).not.match(/export HOME=/);
    should(wrapper).containEql("'/opt/ferretry/bin/fy' history claim --harness claude --pid $$ --from-arguments");
    // A runtime that is not an agent behaves like the person's own CLI: no mode, no seeding.
    should(wrapper).not.containEql('--permission-mode');
    should(wrapper).not.containEql('FY_SEED_FIRST_RUN');
    should(wrapper).endWith(`exec claude '--model' 'claude-opus-5-5' "$@"\n`);
  });

  it("should export a Ferretry-kept Claude login's own store and the Codex SQLite pool", () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': { harness: 'claude', store: 'ferretry' },
        'codex-work': { harness: 'codex', store: 'ferretry' },
      },
    });

    // Act
    const result = plan(model);

    // Assert
    should(wrapperOf(result, 'claude-default')).containEql(
      "export CLAUDE_SECURESTORAGE_CONFIG_DIR='/fy/fleet/credentials/claude-you'",
    );
    should(only(result, '/fy/fleet/credentials/claude-you')).match({ kind: 'directory', mode: 0o700 });
    should(wrapperOf(result, 'codex-default')).containEql("export CODEX_SQLITE_HOME='/fy/fleet/shared/codex/sqlite'");
    should(wrapperOf(result, 'codex-default')).containEql(`exec codex '-c' 'model="gpt-6"' "$@"`);
  });

  it("should export an environment credential's variables and publish only the secret references", () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } },
        'codex-work': { harness: 'codex', store: 'ferretry' },
      },
      advanced: { secretsFile: '~/.secrets' },
    });

    // Act
    const result = plan(model);

    // Assert
    const wrapper = wrapperOf(result, 'claude-default');
    should(wrapper).containEql('if [ -r "$HOME/.secrets" ]; then');
    should(wrapper).containEql('${ANTHROPIC_API_KEY:?ferretry: ANTHROPIC_API_KEY is not set');
    should(wrapper).not.containEql('CLAUDE_SECURESTORAGE_CONFIG_DIR');
    should(result.manifest.accounts[0]?.secretEnv).eql({
      ANTHROPIC_API_KEY: '${secret:WORK_KEY}',
      GITHUB_TOKEN: '${secret:GH_TOKEN}',
    });
  });

  it("should start a Codex environment login on its model provider, before the profile's own flags", () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': { harness: 'claude', store: 'host' },
        'codex-work': {
          harness: 'codex',
          store: 'environment',
          env: { KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}' },
          codexProvider: {
            id: 'kimi',
            name: 'Kimi',
            baseUrl: 'https://api.moonshot.ai/v1',
            keyVariable: 'KIMI_API_KEY',
            model: 'kimi-k3',
          },
        },
      },
      profiles: { default: { layers: DEFAULT_LAYERS }, bare: { layers: ['instructions/main'] } },
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default' },
        'codex-default': { credential: 'codex-work', profile: 'default' },
        'codex-bare': { credential: 'codex-work', profile: 'bare' },
      },
    });

    // Act
    const result = plan(model);

    // Assert — a profile that names a model keeps it; one that names none starts on the provider's
    const named = wrapperOf(result, 'codex-default');
    should(named).containEql(
      `'-c' 'model_providers.kimi.base_url="https://api.moonshot.ai/v1"' '-c' 'model_providers.kimi.env_key="KIMI_API_KEY"'`,
    );
    should(named).containEql(`'model="gpt-6"'`);
    should(named).not.containEql('kimi-k3');
    should(wrapperOf(result, 'codex-bare')).containEql(`'-c' 'model_provider="kimi"' '-c' 'model="kimi-k3"'`);
    should(result.manifest.accounts.find(account => account.displayName === 'codex-default')?.secretEnv).eql({
      GITHUB_TOKEN: '${secret:GH_TOKEN}',
      KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}',
    });
  });

  it('should keep a runtime from launching when its Codex provider cannot be put together, and say why', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': { harness: 'claude', store: 'host' },
        'codex-work': {
          harness: 'codex',
          store: 'environment',
          env: { RESOURCE: 'not a host', AZURE_OPENAI_API_KEY: '${secret:AZURE_OPENAI_API_KEY}' },
          codexProvider: {
            id: 'azure-openai',
            name: 'Azure OpenAI',
            baseUrl: 'https://{RESOURCE}.openai.azure.com/openai/v1',
            keyVariable: 'AZURE_OPENAI_API_KEY',
          },
        },
      },
    });

    // Act
    const result = plan(model);

    // Assert
    const row = result.manifest.accounts.find(account => account.kind === 'codex');
    should(row?.available).be.false();
    should(row?.unavailableReason).match(/its login "codex-work" cannot launch: .*RESOURCE/u);
  });

  it('should hand a cloud credential reference over by name, never a copy', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'claude-you': {
          harness: 'claude',
          store: 'environment',
          env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
          cloudCredential: 'aws-profile:acme',
        },
        'codex-work': { harness: 'codex', store: 'ferretry' },
      },
    });

    // Act
    const wrapper = wrapperOf(plan(model), 'claude-default');

    // Assert
    should(wrapper).containEql(`export AWS_PROFILE='acme'`);
  });

  it('should publish each runtime and a version-1 account row beside it', () => {
    // Act
    const result = plan(
      modelOf({ runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } } }),
    );

    // Assert
    should(result.manifest.runtimes).eql([
      {
        id: ID_A,
        name: 'claude-default',
        harness: 'claude',
        credential: 'claude-you',
        profile: 'default',
        agent: true,
        wrapper: '/fy/fleet/bin/claude-default',
        models: [
          { id: 'claude-opus-5-5', available: true },
          { id: 'claude-sonnet-5-5', available: true },
        ],
        defaultModel: 'claude-opus-5-5',
      },
    ]);
    should(result.manifest.accounts).eql([
      {
        id: ID_A,
        kind: 'claude',
        mode: 'auto',
        wrapper: '/fy/fleet/bin/claude-default',
        home: HOME_A,
        displayName: 'claude-default',
        defaultModel: 'claude-opus-5-5',
        models: [
          { id: 'claude-opus-5-5', available: true },
          { id: 'claude-sonnet-5-5', available: true },
        ],
        available: true,
        unavailableReason: null,
        secretEnv: { GITHUB_TOKEN: '${secret:GH_TOKEN}' },
      },
    ]);
    should(result.manifestPath).equal('/fy/fleet/manifest.json');
  });

  it('should strike out a model the credential cannot use and fall back to one it can (E23)', () => {
    // Act
    const result = plan(modelOf(), { availableModels: { 'claude-you': ['claude-sonnet-5-5'] } });

    // Assert
    should(result.manifest.runtimes?.[0]).match({
      models: [
        { id: 'claude-opus-5-5', available: false, unavailableReason: 'Not available on this login' },
        { id: 'claude-sonnet-5-5', available: true },
      ],
      defaultModel: 'claude-sonnet-5-5',
    });
    should(wrapperOf(result, 'claude-default')).containEql("'--model' 'claude-sonnet-5-5'");
  });

  it('should publish a runtime with no model set as one the old account surface cannot start', () => {
    // Arrange
    const model = modelOf({ profiles: { default: { layers: ['instructions/main'] } } });

    // Act
    const result = plan(model);

    // Assert
    should(result.manifest.runtimes?.[0]).match({ models: [], defaultModel: null });
    should(result.manifest.accounts[0]).match({
      available: false,
      unavailableReason: 'profile "default" names no model it can use',
    });
    should(wrapperOf(result, 'claude-default')).endWith('exec claude "$@"\n');
  });

  it('should have each wrapper exec the harness path the caller resolved, per harness', () => {
    // Arrange
    const model = modelOf();

    // Act
    const located = plan(model, { harnessCommands: { claude: '/opt/h/claude' } });
    const unlocated = plan(model);

    // Assert
    should(wrapperOf(located, 'claude-default')).containEql(`exec '/opt/h/claude' `);
    should(wrapperOf(located, 'codex-default')).containEql('exec codex ');
    should(wrapperOf(unlocated, 'claude-default')).containEql('exec claude ');
  });

  it('should pool every harness, every runtime of it included', () => {
    // Act / Assert
    should(plan(modelOf()).sharedHistoryRequests).eql([
      { kind: 'claude', poolRoot: '/fy/fleet/shared', homes: [{ account: ID_A, path: HOME_A }] },
      { kind: 'codex', poolRoot: '/fy/fleet/shared', homes: [{ account: ID_B, path: HOME_B }] },
    ]);
  });

  it('should sweep stale wrappers from the bin directory, keeping every runtime and command', () => {
    // Arrange
    const model = modelOf({
      advanced: {
        commands: [{ wrapper: 'review', runtime: 'claude-default', flags: ['--agent', 'reviewer'] }],
        aliases: {
          fast: { claude: '--model  haiku', codex: ['-m', 'gpt-6-mini'] },
          deep: { codex: ['-c', 'effort=high'] },
        },
      },
    });

    // Act
    const result = plan(model);

    // Assert
    should(result.operations.at(-1)).eql({
      kind: 'prune',
      path: '/fy/fleet/bin',
      marker: MANAGED_MARKER,
      keep: [
        'claude-default',
        'codex-default',
        'review',
        'deep-codex-default',
        'fast-claude-default',
        'fast-codex-default',
      ],
    });
    should(wrapperOf(result, 'review')).containEql(`exec '/fy/fleet/bin/claude-default' '--agent' 'reviewer' "$@"`);
    should(wrapperOf(result, 'fast-claude-default')).containEql(
      `exec '/fy/fleet/bin/claude-default' '--model' 'haiku' "$@"`,
    );
    should(wrapperOf(result, 'fast-codex-default')).containEql(`'-m' 'gpt-6-mini'`);
    should(at(result, '/fy/fleet/bin/deep-claude-default')).be.empty();
  });

  it('should refuse a command and an alias that would be one executable', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default' },
        'x-claude-default': { credential: 'claude-you', profile: 'default' },
      },
      advanced: { aliases: { x: { claude: '--verbose' } } },
    });

    // Act
    const error = failure(() => plan(model));

    // Assert
    should(error.problems).eql([
      {
        runtime: 'x-claude-default',
        message: 'alias x and runtime x-claude-default would both be the executable "x-claude-default"',
      },
    ]);
  });

  describe('agent runtimes', () => {
    const agents = (agentPermissions: 'auto' | 'skip'): AccountModel =>
      modelOf({
        machine: { agentPermissions },
        runtimes: {
          'claude-agent': { credential: 'claude-you', profile: 'default', agent: true },
          'codex-agent': { credential: 'codex-work', profile: 'default', agent: true },
        },
      });

    it('should launch a Claude agent with an explicit Auto mode and re-assert trust and onboarding', () => {
      // Act
      const result = plan(agents('auto'));
      const wrapper = wrapperOf(result, 'claude-agent');

      // Assert — the overlay names the mode too, so no one-shot dialog offers to change it.
      const overlay = `${HOME_A}/.fy/${FIXED_SETTINGS_FILE}`;
      should(wrapper).containEql('FY_SEED_FIRST_RUN');
      should(wrapper).containEql('hasSeenAutoDefaultNudge');
      should(wrapper).endWith(
        `exec claude '--model' 'claude-opus-5-5' '--permission-mode' 'auto' '--mcp-config={"mcpServers":{"ferretry":{"type":"stdio","command":"/opt/ferretry/bin/fy","args":["mcp","serve"],"env":{"FY_TOKEN":""}}}}' ${shellQuote(`--append-system-prompt=${AGENT_BASE_INSTRUCTION('fy')}`)}"$_fy_sections" '--settings' '${overlay}' "$@"\n`,
      );
      should(JSON.parse((only(result, overlay) as { content: string }).content)).eql({
        permissions: { defaultMode: 'auto' },
        remoteControlAtStartup: false,
        skipAutoPermissionPrompt: true,
        hooks: CLAUDE_QUESTION_HOOKS,
      });
      should(only(result, `${HOME_A}/settings.json`)).match({
        layers: [{ settings: { permissions: { defaultMode: 'auto' } } }],
      });
    });

    it('should give a Claude agent on Skip the settings overlay and keep the placeholder folder out of every file', () => {
      // Act
      const result = plan(agents('skip'));
      const wrapper = wrapperOf(result, 'claude-agent');

      // Assert
      const overlay = `${HOME_A}/.fy/fixed.json`;
      should(wrapper).endWith(
        `exec claude '--model' 'claude-opus-5-5' '--permission-mode' 'bypassPermissions' '--mcp-config={"mcpServers":{"ferretry":{"type":"stdio","command":"/opt/ferretry/bin/fy","args":["mcp","serve"],"env":{"FY_TOKEN":""}}}}' ${shellQuote(`--append-system-prompt=${AGENT_BASE_INSTRUCTION('fy')}`)}"$_fy_sections" '--settings' '${overlay}' "$@"\n`,
      );
      should(only(result, overlay)).eql({
        kind: 'file',
        path: overlay,
        content: `${JSON.stringify(
          {
            permissions: { defaultMode: 'bypassPermissions' },
            remoteControlAtStartup: false,
            skipDangerousModePermissionPrompt: true,
            hooks: CLAUDE_QUESTION_HOOKS,
          },
          null,
          2,
        )}\n`,
        mode: 0o600,
      });
      should(
        result.operations.find(operation => operation.path === `${HOME_A}/.fy` && operation.kind === 'prune-directory'),
      ).eql({ kind: 'prune-directory', path: `${HOME_A}/.fy`, keep: ['materialised.json', 'fixed.json'] });
      should(JSON.stringify(result.operations)).not.containEql('ferretry-launch-folder');
    });

    it('should launch a Codex agent with its approval and sandbox, trusting the real folder at launch', () => {
      // Act
      const result = plan(agents('auto'));
      const wrapper = wrapperOf(result, 'codex-agent');

      // Assert
      should(wrapper).endWith(
        `exec codex '-c' 'model="gpt-6"' '-c' 'approval_policy="on-request"' '-c' 'sandbox_mode="workspace-write"' '--no-alt-screen' '-c' 'notice={hide_full_access_warning=true,hide_world_writable_warning=true,hide_rate_limit_model_nudge=true,hide_gpt5_1_migration_prompt=true,"hide_gpt-5.1-codex-max_migration_prompt"=true}' '-c' 'mcp_servers.ferretry.command="/opt/ferretry/bin/fy"' '-c' 'mcp_servers.ferretry.args=["mcp","serve"]' '-c' 'mcp_servers.ferretry.env_vars=["FY_HOME","FY_URL","FY_SESSION_ID","FY_SESSION_TOKEN","FY_SESSION_BOARD_CAPABILITY"]' '-c' ${shellQuote(`developer_instructions=${tomlString(AGENT_BASE_INSTRUCTION('fy')).slice(0, -1)}`)}"$_fy_sections"'"' "$@"\n`,
      );
      should(wrapper).containEql('set -- -c "projects={\\"$_fy_cwd\\"={trust_level=\\"trusted\\"}}" "$@"');
      should(wrapper).not.containEql('ferretry-launch-folder');
      should(only(result, `${HOME_B}/config.toml`)).match({
        layers: [{ settings: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } }],
      });
      should(JSON.stringify(only(result, `${HOME_B}/config.toml`))).not.containEql('projects');
    });

    it('should refuse to launch a Claude agent in Auto mode on a Claude that does not accept it (O4)', () => {
      // Act
      const result = plan(agents('auto'), { acceptsAutoPermissionMode: false });

      // Assert
      const wrapper = wrapperOf(result, 'claude-agent');
      should(wrapper).containEql(
        'ferretry: claude-agent cannot start: Claude Code on this machine does not accept Auto mode',
      );
      should(wrapper).containEql('exit 1');
      should(wrapper).not.containEql('exec claude');
      should(result.manifest.accounts[0]).match({ available: false, mode: 'auto' });
      // Codex is unaffected by what Claude accepts.
      should(wrapperOf(result, 'codex-agent')).containEql('exec codex');
    });
  });

  describe('profiles a runtime cannot use', () => {
    it('should make a runtime whose profile has nothing for its harness unlaunchable (P5)', () => {
      // Arrange
      const model = modelOf({
        components: { ...COMPONENTS, settings: { codex: { harness: 'codex', flags: ['--search'] } } },
        profiles: {
          default: { layers: DEFAULT_LAYERS },
          codexOnly: { layers: ['settings/codex'] },
          empty: { layers: [] },
        },
        runtimes: {
          'claude-default': { credential: 'claude-you', profile: 'codexOnly' },
          'codex-default': { credential: 'codex-work', profile: 'empty' },
        },
      });

      // Act
      const result = plan(model);

      // Assert
      should(result.manifest.accounts[0]?.unavailableReason).equal(
        'nothing in profile "codexOnly" applies to Claude Code',
      );
      should(result.manifest.accounts[1]?.unavailableReason).equal('profile "empty" has no layers');
    });

    it('should pass a settings component’s flags and environment to the launch', () => {
      // Arrange
      const model = modelOf({
        components: {
          ...COMPONENTS,
          settings: {
            claude: { harness: 'claude', flags: ['--verbose'], env: { LOG_LEVEL: 'debug' }, file: 'claude.json' },
          },
        },
        profiles: { default: { layers: [...DEFAULT_LAYERS, 'settings/claude'] } },
      });

      // Act
      const result = plan(model, { bodies: { settings: { claude: { theme: 'dark' } } } });

      // Assert
      const wrapper = wrapperOf(result, 'claude-default');
      should(wrapper).containEql("export LOG_LEVEL='debug'");
      should(wrapper).endWith(`exec claude '--model' 'claude-opus-5-5' '--verbose' "$@"\n`);
      should(only(result, `${HOME_A}/settings.json`)).match({ layers: [{ settings: { theme: 'dark' } }] });
    });

    it('should generate one instructions document from several, and copy one from outside the asset tree', () => {
      // Arrange
      const model = modelOf({
        components: {
          ...COMPONENTS,
          instructions: {
            main: { file: 'components/instructions/main.md' },
            extra: { file: 'components/instructions/extra.md', harness: 'claude' },
            mine: { file: '/home/person/AGENTS.md', harness: 'codex' },
          },
        },
        profiles: {
          default: { layers: [...DEFAULT_LAYERS, 'instructions/extra'] },
          codex: { layers: ['instructions/mine'] },
        },
        runtimes: {
          'claude-default': { credential: 'claude-you', profile: 'default' },
          'codex-default': { credential: 'codex-work', profile: 'codex' },
        },
      });

      // Act
      const result = plan(model, { bodies: { instructions: { main: 'Main.', extra: 'Extra.' } } });

      // Assert
      should(only(result, `${HOME_A}/CLAUDE.md`)).match({ kind: 'file', mode: 0o600 });
      should((only(result, `${HOME_A}/CLAUDE.md`) as { content: string }).content).containEql('Main.\n\nExtra.');
      should(only(result, `${HOME_B}/AGENTS.md`)).eql({
        kind: 'copy',
        source: '/home/person/AGENTS.md',
        path: `${HOME_B}/AGENTS.md`,
      });
    });

    it('should refuse, naming every problem, what no apply can write', () => {
      // Arrange
      const model = modelOf({
        components: {
          ...COMPONENTS,
          instructions: { main: { file: 'a.md' }, extra: { file: 'b.md' } },
          settings: {
            claude: { harness: 'claude', file: 'claude.json', env: { HOME: '/elsewhere' } },
            codex: { harness: 'codex', env: { FY_RUNTIME: 'other' } },
          },
        },
        profiles: {
          default: {
            layers: [
              'instructions/main',
              'instructions/extra',
              'settings/claude',
              'settings/codex',
              'modelSets/claude',
            ],
          },
        },
      });

      // Act
      const error = failure(() => plan(model));

      // Assert
      should(error.problems).eql([
        { runtime: 'claude-default', message: 'settings "claude" could not be read' },
        {
          runtime: 'claude-default',
          message: 'instructions "main" could not be read, so CLAUDE.md cannot be put together',
        },
        {
          runtime: 'claude-default',
          message: 'instructions "extra" could not be read, so CLAUDE.md cannot be put together',
        },
        {
          runtime: 'claude-default',
          message:
            'it may not set HOME: a runtime keeps your real home, because that is where your own login and keychain are found; its config directory is what keeps it separate',
        },
        {
          runtime: 'codex-default',
          message: 'instructions "main" could not be read, so AGENTS.md cannot be put together',
        },
        {
          runtime: 'codex-default',
          message: 'instructions "extra" could not be read, so AGENTS.md cannot be put together',
        },
        { runtime: 'codex-default', message: "it may not set FY_RUNTIME: Ferretry sets it to the runtime's own name" },
      ]);
    });

    it('should run one Claude and one Codex runtime off one dual login, each on its own half', () => {
      // Arrange — docs/provider-presets.md § One login, both CLIs: one secret, two runtimes
      const model = modelOf({
        credentials: {
          glm: {
            harness: 'claude',
            store: 'environment',
            claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
            codex: {
              env: { OPENROUTER_API_KEY: '${secret:S}' },
              codexProvider: {
                id: 'openrouter',
                name: 'OpenRouter',
                keyVariable: 'OPENROUTER_API_KEY',
                baseUrl: 'https://openrouter.ai/api/v1',
              },
            },
          },
        },
        runtimes: {
          'claude-default': { credential: 'glm', profile: 'default', harness: 'claude' },
          'codex-default': { credential: 'glm', profile: 'default', harness: 'codex' },
        },
      });

      // Act
      const result = plan(model);

      // Assert — each runtime's wrapper and home carry only its own half
      const claudeWrapper = wrapperOf(result, 'claude-default');
      should(claudeWrapper).containEql('${ANTHROPIC_AUTH_TOKEN:?ferretry: ANTHROPIC_AUTH_TOKEN is not set');
      should(claudeWrapper).not.containEql('OPENROUTER_API_KEY');
      should(claudeWrapper).endWith(`exec claude '--model' 'claude-opus-5-5' "$@"\n`);

      const codexWrapper = wrapperOf(result, 'codex-default');
      should(codexWrapper).containEql('${OPENROUTER_API_KEY:?ferretry: OPENROUTER_API_KEY is not set');
      should(codexWrapper).not.containEql('ANTHROPIC_AUTH_TOKEN');
      should(codexWrapper).containEql('model_provider="openrouter"');

      should(result.manifest.accounts.map(account => account.kind)).deepEqual(['claude', 'codex']);
      should(result.manifest.accounts.every(account => account.available)).be.true();
    });

    it('should refuse a hand-built model whose runtime names a profile that does not exist', () => {
      // Arrange: the schema refuses this, so only a model built without parsing can get here.
      const model = {
        ...modelOf(),
        runtimes: { 'claude-default': { credential: 'claude-you', profile: 'gone', agent: false } },
      };

      // Act
      const error = failure(() => plan(model));

      // Assert
      should(error.problems).have.length(1);
      should(error.problems[0]).match({ runtime: 'claude-default', message: /^profile "gone" cannot be read: / });
    });
  });

  describe('with model catalogs (docs/model-catalog.md)', () => {
    const sources = { catalogs: builtInModelCatalogs(), presets: builtInPresets() };
    const glmModel = (env: Record<string, string>) =>
      modelOf({
        credentials: {
          'claude-you': {
            harness: 'claude',
            store: 'environment',
            preset: 'zai-glm',
            env: {
              ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
              ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
              ...env,
            },
          },
          'codex-work': { harness: 'codex', store: 'ferretry' },
        },
      });

    it("should offer the login's catalog, launch on its default and pin the tier slots over a stale copy", () => {
      // Act — the login file still holds the tier pin an older preset copied into it
      const result = plan(glmModel({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6' }), { modelCatalogs: sources });

      // Assert
      const wrapper = wrapperOf(result, 'claude-default');
      should(wrapper).containEql("export ANTHROPIC_DEFAULT_OPUS_MODEL='glm-5.3'");
      should(wrapper).containEql("export ANTHROPIC_DEFAULT_HAIKU_MODEL='glm-5.3-flash'");
      should(wrapper).not.containEql('glm-4.6');
      should(wrapper).containEql("'--model' 'glm-5.3'");
      const account = result.manifest.accounts[0];
      should(account?.modelCatalog).eql({ id: 'zai', label: 'GLM / Z.ai', customIds: false });
      should(account?.defaultModel).equal('glm-5.3');
      should(account?.models[0]).match({
        id: 'glm-5.3',
        displayName: 'GLM-5.3',
        tier: 'best',
        efforts: ['low', 'high', 'max'],
      });
      // A sign-in Codex login reads OpenAI's catalog.
      should(result.manifest.accounts[1]?.modelCatalog?.id).equal('openai');
      should(result.manifest.accounts[1]?.defaultModel).equal('gpt-6.1-sol');
    });

    it('should mark a catalog model the login cannot use, as it marks a model set’s', () => {
      // Act
      const result = plan(glmModel({}), {
        modelCatalogs: sources,
        availableModels: { 'claude-you': ['glm-5.3-flash'] },
      });

      // Assert
      should(result.manifest.accounts[0]?.models[0]).match({ id: 'glm-5.3', available: false });
      should(result.manifest.accounts[0]?.defaultModel).equal('glm-5.3-flash');
    });

    describe("a Codex runtime's own picker", () => {
      const deepseekModel = (settings?: Record<string, unknown>) =>
        modelOf({
          credentials: {
            'claude-you': { harness: 'claude', store: 'host' },
            'codex-work': {
              harness: 'codex',
              store: 'environment',
              preset: 'deepseek',
              env: { DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}' },
              codexProvider: {
                id: 'deepseek',
                name: 'DeepSeek',
                baseUrl: 'https://api.deepseek.com/',
                keyVariable: 'DEEPSEEK_API_KEY',
                model: 'deepseek-flash',
              },
            },
          },
          ...(settings === undefined
            ? {}
            : {
                components: { ...COMPONENTS, settings: { own: { harness: 'codex', file: 'own.toml' } } },
                profiles: { default: { layers: [...DEFAULT_LAYERS, 'settings/own'] } },
              }),
        });
      const CATALOG_FILE = `${HOME_B}/.fy/codex-model-catalog.json`;

      it("should be given the login's catalog models as the list it offers, from a file Ferretry owns", () => {
        // Act
        const result = plan(deepseekModel(), { modelCatalogs: sources });

        // Assert — the file lists the catalog's models and nothing of OpenAI's
        const file = only(result, CATALOG_FILE);
        should(file).match({ kind: 'file', mode: 0o600 });
        const catalog = JSON.parse((file as { content: string }).content) as {
          models: { slug: string; display_name: string; priority: number }[];
        };
        // the model the runtime launches with comes first: Codex calls its first model the default
        should(catalog.models.map(model => [model.slug, model.display_name, model.priority])).eql([
          ['deepseek-flash', 'DeepSeek Flash', 1],
          ['deepseek-v4-pro', 'DeepSeek V4 Pro', 2],
        ]);
        should(wrapperOf(result, 'codex-default')).containEql(`'-c' 'model_catalog_json="${CATALOG_FILE}"'`);
        // The manifest says the runtime has one, so a machine that has none republishes.
        should(result.manifest.accounts.find(account => account.displayName === 'codex-default')?.codexCatalog).equal(
          1,
        );
        should(
          result.manifest.accounts.find(account => account.displayName === 'claude-default')?.codexCatalog,
        ).be.undefined();
        // The sweep of Ferretry's corner keeps it.
        should(
          result.operations.find(
            operation => operation.kind === 'prune-directory' && operation.path === `${HOME_B}/.fy`,
          ),
        ).match({ keep: [MATERIALISED_RECORD_FILE, 'codex-model-catalog.json'] });
      });

      it("should leave Codex's own list alone for a catalog of models Codex ships, and for a sign-in", () => {
        // Act — a sign-in Codex login reads OpenAI's catalog
        const result = plan(modelOf(), { modelCatalogs: sources });

        // Assert
        should(at(result, CATALOG_FILE)).be.empty();
        should(wrapperOf(result, 'codex-default')).not.containEql('model_catalog_json');
        should(result.manifest.accounts.find(account => account.displayName === 'codex-default')).not.have.property(
          'codexCatalog',
        );
      });

      it('should write no catalog on a machine that reads none, nor for a Claude runtime', () => {
        // Act
        const result = plan(deepseekModel());

        // Assert
        should(at(result, CATALOG_FILE)).be.empty();
        should(wrapperOf(result, 'codex-default')).not.containEql('model_catalog_json');
        should(wrapperOf(result, 'claude-default')).not.containEql('model_catalog_json');
      });

      it('should leave a catalog the person set in their own Codex settings as it is', () => {
        // Act
        const result = plan(deepseekModel({}), {
          modelCatalogs: sources,
          bodies: { settings: { own: { model_catalog_json: '/home/person/models.json' } } },
        });

        // Assert
        should(at(result, CATALOG_FILE)).be.empty();
        should(wrapperOf(result, 'codex-default')).not.containEql('model_catalog_json');
        should(only(result, `${HOME_B}/config.toml`)).match({
          layers: [{ settings: { model_catalog_json: '/home/person/models.json' } }],
        });
      });
    });
  });
});
