/**
 * The setup service with every port faked: the first-run scan, Import again, the tool install, the
 * Clone export and import, and the first run a booting daemon gives a host.
 *
 * The import plan, the clone plan and the materialised fleet are the fleet library's real ones; only
 * the host scan, the files, the provisioner and the secret store are stand-ins, so what
 * an apply is handed is what a real apply would be.
 */
import { describe, it } from 'bun:test';
import {
  type AccountModel,
  buildCloneBundle,
  builtInModelCatalogs,
  checkConfigFile,
  builtInPresets,
  CLONE_BASE_FILE,
  EXPORT_KEYS_FILE,
  parseCloneBase,
  serializeCloneBase,
  originKeyOfId,
  parseExportKeys,
  FleetApplyFailureError,
  type FleetApplyPlan,
  type FleetDocumentWrite,
  type FleetLayout,
  type HostHarnessScan,
  parseAccountModel,
  RETIRED_FLEET_CONFIG_SENTENCE,
  RetiredFleetConfigError,
} from '@ferretry/fleet';
import {
  CLONE_BUNDLE_KEYS_LIMIT,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_WARDEN_CONFIG,
  type FleetAccountChange,
  FleetCloneBundleSchema,
  type FleetCredentialView,
  type GrantRefusal,
  ORIGIN_KEY_PATTERN,
  sha256Hex,
  FleetSetupScanSchema,
  FleetToolInstallResultSchema,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { ConfigFileConflictError } from '../../../src/lib/config-files/index.ts';
import {
  type AccountDocumentReading,
  type ExecutorCaller,
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
} from '../../../src/lib/fleet/catalog-service.ts';
import {
  CLONE_BUNDLE_MAX_BYTES,
  type CloneConfigFiles,
  createFleetSetupSubsystem,
  FleetSetupRefusal,
  FleetSetupService,
  type FleetSetupServiceDeps,
  type FolderReading,
  IMPORT_RECORD_FILE,
  parseImportRecord,
} from '../../../src/lib/fleet/setup-service.ts';
import {
  type ToolInstallOutcome,
  type ToolInstallPreview,
  ToolInstallRefusal,
} from '../../../src/lib/fleet/tool-install.ts';
import { configReading, configTextOf, modelOfWrites } from '../../support/config-reading.ts';

const LAYOUT: FleetLayout = {
  stateHome: '/state',
  userHome: '/person',
  fleetDirectory: '/state/fleet',
  binDirectory: '/state/fleet/bin',
  homesDirectory: '/state/fleet/homes',
  assetsDirectory: '/state/fleet/assets',
  manifestPath: '/state/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/person/.claude', codex: '/person/.codex' },
};

const RECORD_PATH = `/state/fleet/${IMPORT_RECORD_FILE}`;
const KEYS_PATH = `/state/fleet/${EXPORT_KEYS_FILE}`;
const BASE_PATH = `/state/fleet/${CLONE_BASE_FILE}`;
const SECRET_VALUE = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** A host with Claude Code signed in, instructions, settings holding one secret, and one skill. */
const claudeScan = (overrides: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'claude',
  command: '/usr/bin/claude',
  login: { state: 'signed-in', email: 'you@example.com' },
  instructions: { kind: 'text', source: '/person/.claude/CLAUDE.md', text: 'Be kind.\n', bytes: 9 },
  settings: {
    kind: 'text',
    source: '/person/.claude/settings.json',
    text: JSON.stringify({ theme: 'dark', env: { GITHUB_TOKEN: SECRET_VALUE } }),
    bytes: 80,
  },
  mcp: { kind: 'absent', source: '/person/.claude.json' },
  skills: [{ item: 'review', source: '/person/.claude/skills/review', digest: 'skill-digest' }],
  missingCommands: [],
  problems: [],
  ...overrides,
});

/** Codex is not installed on this host. */
const codexScan = (overrides: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'codex',
  login: { state: 'not-signed-in' },
  instructions: { kind: 'absent', source: '/person/.codex/AGENTS.md' },
  settings: { kind: 'absent', source: '/person/.codex/config.toml' },
  hooks: { kind: 'absent', source: '/person/.codex/hooks.json' },
  skills: [],
  missingCommands: [],
  problems: [],
  ...overrides,
});

const EMPTY_READING = (): AccountDocumentReading => configReading(parseAccountModel({ version: 2 }), 'absent', 'none');

/** A machine that is already set up, for the export and the clone. */
const SET_UP_MODEL = (): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: { 'claude-you': { harness: 'claude', store: 'host', label: 'work' } },
    components: {
      instructions: {
        main: { file: 'components/instructions/main.md' },
        far: { file: '/person/elsewhere.md' },
        lost: { file: 'components/instructions/lost.md' },
      },
      skills: { mine: { items: ['review'] } },
      modelSets: { claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
    },
    profiles: { default: { layers: ['instructions/main', 'skills/mine', 'modelSets/claude'] } },
    runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } },
  });

const credentialRow = (id: string, email?: string): FleetCredentialView =>
  ({
    id,
    harness: 'claude',
    store: 'host',
    ...(email === undefined ? {} : { email }),
  }) as FleetCredentialView;

const RUN_RESULT = {
  accountCount: 1,
  operationCount: 3,
  manifestPath: LAYOUT.manifestPath,
  prunedWrappers: [],
  sharedHistory: [],
};

interface World {
  readonly service: FleetSetupService;
  readonly applied: { plan: FleetApplyPlan; documents: readonly FleetDocumentWrite[] }[];
  readonly secrets: Map<string, string>;
  readonly state: {
    reading: AccountDocumentReading;
    scans: readonly HostHarnessScan[];
    assets: Record<string, string>;
    folders: Record<string, FolderReading>;
    skillItems: () => Promise<readonly string[]>;
    secretNames: () => Promise<readonly string[]>;
    putSecret: (name: string, value: string) => Promise<void>;
    apply: () => Promise<unknown>;
    emails: () => Promise<FleetCredentialView[]>;
    plans: readonly ToolInstallPreview[];
    install: () => Promise<readonly ToolInstallOutcome[]>;
    documentError: unknown;
    scanError: unknown;
    locate: Partial<Record<'claude' | 'codex', string>>;
    daemon: string | undefined;
    /** `setup/export-keys.json` as the machine holds it. */
    keysText: string | undefined;
    keysReadError: unknown;
    keysWriteError: unknown;
    keysWrites: number;
    baseWrites: string[];
  };
}

function world(
  options: { overrides?: Partial<FleetSetupServiceDeps>; catalog?: Partial<FleetSetupServiceDeps['catalog']> } = {},
): World {
  const applied: World['applied'] = [];
  const secrets = new Map<string, string>();
  let minted = 0;
  const state: World['state'] = {
    reading: EMPTY_READING(),
    scans: [claudeScan(), codexScan()],
    assets: {},
    folders: {
      '/person/.claude/skills/review': {
        files: [{ path: 'SKILL.md', content: '---\nname: review\n---\n' }],
        skipped: [],
      },
    },
    skillItems: async () => [],
    secretNames: async () => [...secrets.keys()],
    putSecret: async (name, value) => {
      secrets.set(name, value);
    },
    apply: async () => RUN_RESULT,
    emails: async () => [credentialRow('claude-you', 'you@example.com')],
    plans: [
      { harness: 'claude', installed: true, path: '/usr/bin/claude' },
      {
        harness: 'codex',
        installed: false,
        plan: {
          harness: 'codex',
          kind: 'runnable',
          manager: 'npm',
          executable: '/usr/bin/npm',
          args: ['install', '-g', '@openai/codex'],
          command: 'npm install -g @openai/codex',
        },
      },
    ],
    install: async () => [],
    documentError: undefined,
    scanError: undefined,
    locate: { claude: '/usr/bin/claude' },
    daemon: 'daemon-source',
    keysText: undefined,
    keysReadError: undefined,
    keysWriteError: undefined,
    keysWrites: 0,
    baseWrites: [],
  };
  let drawn = 0;
  const deps: FleetSetupServiceDeps = {
    catalog: {
      document: async () => {
        if (state.documentError !== undefined) throw state.documentError;
        return state.reading;
      },
      readAsset: async path => state.assets[path],
      documentRevision: async path => (state.assets[path] === undefined ? 'absent' : `digest:${path}`),
      ids: async () => undefined,
      locate: harness => state.locate[harness],
      machineName: () => 'studio',
      credentials: {
        list: async () => ({ format: 2, machine: 'studio', credentials: await state.emails() }) as never,
        signOut: async () => {
          throw new Error('not used');
        },
      },
      provisioner: {
        preview: async () => {
          throw new Error('not used');
        },
        apply: async (plan, documents = []) => {
          applied.push({ plan, documents });
          return (await state.apply()) as never;
        },
      },
      layout: LAYOUT,
      mint: () => `00000000-0000-4000-8000-00000000000${++minted}`,
      now: () => Date.parse('2026-10-13T08:00:00.000Z'),
      claudeStatusline: () => "'fy' statusline",
      fyCommand: 'fy',
      acceptsAutoPermissionMode: true,
      ...options.catalog,
    },
    scan: async () => {
      if (state.scanError !== undefined) throw state.scanError;
      return state.scans;
    },
    tools: {
      plans: harnesses => state.plans.filter(plan => harnesses.includes(plan.harness)),
      install: async () => await state.install(),
    },
    secrets: {
      names: async () => await state.secretNames(),
      put: async (name, value) => await state.putSecret(name, value),
    },
    readFolder: async path => state.folders[path] ?? { files: [], skipped: [] },
    skillItems: async () => await state.skillItems(),
    digest: text => `sha:${Bun.hash(text).toString(16)}`,
    daemonId: () => state.daemon,
    randomBytes: length => {
      drawn += 1;
      return Uint8Array.from({ length }, (_, index) => (drawn * 37 + index * 11) % 256);
    },
    exportKeys: {
      read: async path => {
        if (state.keysReadError !== undefined) throw state.keysReadError;
        return path === KEYS_PATH ? state.keysText : undefined;
      },
      write: async (path, text) => {
        if (state.keysWriteError !== undefined) throw state.keysWriteError;
        should(path).equal(KEYS_PATH);
        state.keysText = text;
        state.keysWrites += 1;
      },
    },
    cloneBase: {
      read: async path => state.assets[path],
      write: async (path, text) => {
        should(path).equal(BASE_PATH);
        state.baseWrites.push(text);
        state.assets[path] = text;
      },
    },
    ...options.overrides,
  };
  return {
    service: createFleetSetupSubsystem(deps),
    applied,
    secrets,
    state,
  };
}

const governance = { governed: true } as CallerGovernance;

async function thrown(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );
}

async function setupRefusal(work: Promise<unknown>, code: string): Promise<FleetSetupRefusal> {
  const error = await thrown(work);
  should(error).be.instanceOf(FleetSetupRefusal);
  should((error as FleetSetupRefusal).code).equal(code);
  return error as FleetSetupRefusal;
}

async function catalogRefusal(work: Promise<unknown>, code: string): Promise<FleetCatalogRefusal> {
  const error = await thrown(work);
  should(error).be.instanceOf(FleetCatalogRefusal);
  should((error as FleetCatalogRefusal).code).equal(code);
  return error as FleetCatalogRefusal;
}

const IMPORT = (extra: Partial<Extract<FleetAccountChange, { kind: 'setup.import' }>> = {}) =>
  ({ kind: 'setup.import', ...extra }) as Extract<FleetAccountChange, { kind: 'setup.import' }>;

/** Describe then execute one change object, as the catalogue's change flow does. */
async function importOnce(
  service: FleetSetupService,
  change = IMPORT(),
): Promise<{ description: string; summary: string }> {
  const description = await service.executors.setup.describe(change);
  const summary = await service.executors.setup.execute(change);
  return { description, summary };
}

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────────

describe('scan', () => {
  it('should say what the first run would find, naming secret keys but never their values', async () => {
    // Arrange
    const { service } = world();

    // Act
    const scan = FleetSetupScanSchema.parse(await service.scan());

    // Assert
    should(scan.machine).equal('studio');
    should(scan.format).equal('none');
    should(scan.tools).deepEqual([
      { harness: 'claude', label: 'Claude Code', installed: true },
      {
        harness: 'codex',
        label: 'Codex',
        installed: false,
        install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
      },
    ]);
    const claude = scan.harnesses.find(harness => harness.harness === 'claude');
    should(claude?.account).deepEqual({ state: 'signed-in', email: 'you@example.com' });
    should(claude?.instructions?.name).equal('CLAUDE.md');
    should(claude?.settings?.source).equal('/person/.claude/settings.json');
    should(claude?.skills).deepEqual(['review']);
    should(claude?.secretKeys).deepEqual(['env.GITHUB_TOKEN']);
    should(JSON.stringify(scan)).not.containEql(SECRET_VALUE);
    should(scan.runtimes).deepEqual([{ harness: 'claude', name: 'claude-default', profile: 'claude-default' }]);
    should(scan.updates).deepEqual([]);
    should(scan.duplicates).deepEqual([]);
    should(scan.importing).deepEqual({ available: true });
  });

  it('should say whether the two tools hold the same instructions when both have some', async () => {
    // Arrange
    const same = world();
    same.state.scans = [
      claudeScan(),
      codexScan({
        command: '/usr/bin/codex',
        instructions: { kind: 'text', source: '/person/.codex/AGENTS.md', text: 'Be kind.\n', bytes: 9 },
      }),
    ];
    const different = world();
    different.state.scans = [
      claudeScan(),
      codexScan({
        command: '/usr/bin/codex',
        instructions: { kind: 'text', source: '/person/.codex/AGENTS.md', text: 'Be brief.\n', bytes: 10 },
      }),
    ];
    const lonely = world();

    // Act
    const identical = await same.service.scan();
    const differing = await different.service.scan();
    const single = await lonely.service.scan();

    // Assert
    should(identical.instructionsIdentical).equal(true);
    should(differing.instructionsIdentical).equal(false);
    should(single).not.have.property('instructionsIdentical');
  });

  it('should show a tool with no package manager with the command to run by hand', async () => {
    const { service, state } = world();
    state.plans = [
      {
        harness: 'codex',
        installed: false,
        plan: {
          harness: 'codex',
          kind: 'no-package-manager',
          reason: 'no npm here',
          manualCommand: 'npm i -g @openai/codex',
        },
      },
    ];
    should((await service.scan()).tools).deepEqual([
      {
        harness: 'codex',
        label: 'Codex',
        installed: false,
        install: { kind: 'no-package-manager', reason: 'no npm here', manualCommand: 'npm i -g @openai/codex' },
      },
    ]);
  });

  it('should refuse a configuration in the old account format with the sentence that says how to set up again', async () => {
    const { service, state } = world();
    state.documentError = new RetiredFleetConfigError('/state/fleet/config.yaml');
    const refusal = await setupRefusal(service.scan(), 'fleet_setup_unreadable');
    should(refusal.message).containEql(RETIRED_FLEET_CONFIG_SENTENCE('/state/fleet/config.yaml'));
  });

  it('should offer Import again the components whose source changed, and name an existing twin runtime', async () => {
    // Arrange: one import, then the host's CLAUDE.md changes.
    const { service, state, applied } = world();
    await importOnce(service);
    const written = applied[0]?.documents ?? [];
    for (const document of written) state.assets[document.path] = document.content;
    state.reading = configReading(modelOfWrites(written), 'rev-2');
    state.scans = [
      claudeScan({
        instructions: { kind: 'text', source: '/person/.claude/CLAUDE.md', text: 'Be kinder.\n', bytes: 11 },
      }),
      codexScan(),
    ];

    // Act
    const scan = await service.scan();

    // Assert
    should(scan.updates.map(update => update.reference)).deepEqual(['instructions/main']);
    should(scan.runtimes).deepEqual([]);
  });

  it('should refuse when the configuration or the host setup cannot be read', async () => {
    const { service, state } = world();
    state.documentError = new Error('bad yaml');
    await setupRefusal(service.scan(), 'fleet_setup_unreadable');
    state.documentError = undefined;
    state.scanError = new Error('permission denied');
    const refusal = await setupRefusal(service.scan(), 'fleet_setup_unreadable');
    should(refusal.message).containEql('permission denied');
  });
});

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

describe('installTools', () => {
  it('should answer each outcome without the path a tool landed in', async () => {
    const { service, state } = world();
    state.install = async () => [
      { harness: 'claude', outcome: 'already-installed', path: '/usr/bin/claude' },
      { harness: 'codex', outcome: 'installed', command: 'npm install -g @openai/codex', path: '/usr/bin/codex' },
      {
        harness: 'codex',
        outcome: 'failed',
        cause: 'needs-admin',
        reason: 'npm needs admin rights',
        manualCommand: 'sudo npm install -g @openai/codex',
      },
    ];
    const result = FleetToolInstallResultSchema.parse(
      await service.installTools({ harnesses: ['claude', 'codex'] }, governance),
    );
    should(result.outcomes).deepEqual([
      { harness: 'claude', outcome: 'already-installed' },
      { harness: 'codex', outcome: 'installed', command: 'npm install -g @openai/codex' },
      {
        harness: 'codex',
        outcome: 'failed',
        cause: 'needs-admin',
        reason: 'npm needs admin rights',
        manualCommand: 'sudo npm install -g @openai/codex',
      },
    ]);
  });

  it("should carry the installer's refusals in this surface's codes, and rethrow anything else", async () => {
    const { service, state } = world();
    const cases = [
      ['tool_install_unauthorized', 'fleet_setup_unauthorized'],
      ['tool_install_in_progress', 'fleet_setup_busy'],
      ['tool_install_invalid', 'fleet_setup_refused'],
    ] as const;
    for (const [from, to] of cases) {
      state.install = async () => {
        throw new ToolInstallRefusal(from, `refused: ${from}`);
      };
      const refusal = await setupRefusal(service.installTools({ harnesses: ['codex'] }, governance), to);
      should(refusal.message).equal(`refused: ${from}`);
    }
    state.install = async () => {
      throw new Error('boom');
    };
    should(((await thrown(service.installTools({ harnesses: ['codex'] }, undefined))) as Error).message).equal('boom');
  });
});

// ── Export ───────────────────────────────────────────────────────────────────────────────────────

describe('exportBundle', () => {
  it('should refuse a machine that is not set up: there is nothing to copy', async () => {
    const { service } = world();
    const refusal = await setupRefusal(service.exportBundle(), 'fleet_setup_refused');
    should(refusal.message).equal("studio isn't set up yet, so there is nothing to copy from it.");
  });

  it('should carry the documents, folders and login descriptors, and say what it could not carry', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading(SET_UP_MODEL(), 'r');
    state.assets['/state/fleet/assets/components/instructions/main.md'] = 'Main.\n';
    state.folders['/state/fleet/assets/skills/review'] = {
      files: [{ path: 'SKILL.md', content: 'skill\n' }],
      skipped: [{ path: 'logo.png', reason: 'it is not text' }],
    };

    // Act
    const bundle = FleetCloneBundleSchema.parse(await service.exportBundle());

    // Assert
    should(bundle.machine).equal('studio');
    should(bundle.exportedAt).equal('2026-10-13T08:00:00.000Z');
    should(bundle.credentials).deepEqual([
      { id: 'claude-you', harness: 'claude', label: 'work', email: 'you@example.com' },
    ]);
    should(bundle.files).deepEqual([
      { path: 'components/instructions/main.md', content: 'Main.\n' },
      { path: 'skills/review/SKILL.md', content: 'skill\n' },
    ]);
    should(bundle.notCopied).deepEqual([
      { path: '/person/elsewhere.md', reason: "it is outside Ferretry's own files" },
      { path: 'components/instructions/lost.md', reason: 'it could not be read' },
      { path: 'skills/review/logo.png', reason: 'it is not text' },
    ]);
  });

  it('should leave out documents past the size a bundle may carry, and the emails when the list fails', async () => {
    const { service, state } = world();
    state.reading = configReading(SET_UP_MODEL(), 'r');
    state.assets['/state/fleet/assets/components/instructions/main.md'] = 'x'.repeat(CLONE_BUNDLE_MAX_BYTES + 1);
    state.emails = async () => {
      throw new Error('down');
    };
    const bundle = await service.exportBundle();
    should(bundle.files).deepEqual([]);
    should(bundle.notCopied).containEql({
      path: 'components/instructions/main.md',
      reason: 'the setup is too large to copy in one go',
    });
    should(bundle.credentials).deepEqual([{ id: 'claude-you', harness: 'claude', label: 'work' }]);
  });
});

/** SET_UP_MODEL with its `main` instructions renamed, its document moved with it and its profile following. */
const renamedMain = (to: string): AccountModel => {
  const base = SET_UP_MODEL();
  const { main: _main, ...others } = base.components.instructions;
  return parseAccountModel({
    ...base,
    components: {
      ...base.components,
      instructions: { ...others, [to]: { file: `components/instructions/${to}.md` } },
    },
    profiles: { default: { layers: [`instructions/${to}`, 'skills/mine', 'modelSets/claude'] } },
  });
};

const MAIN_DOCUMENT = '/state/fleet/assets/components/instructions/main.md';

describe('exportBundle origin keys', () => {
  const exported = async (
    w: World,
  ): Promise<Extract<Awaited<ReturnType<FleetSetupService['exportBundle']>>, { version: 2 }>> => {
    const bundle = FleetCloneBundleSchema.parse(await w.service.exportBundle());
    if (bundle.version !== 2) throw new Error('expected a version 2 bundle');
    return bundle;
  };

  it('should answer version 2 with the daemon id and a key for every exported item, and remember them', async () => {
    // Arrange
    const w = world({
      catalog: {
        ids: async () => ({
          version: 1,
          runtimes: { 'claude-default': { id: '12345678-1234-4234-8234-123456789abc', formerNames: [] } },
        }),
      },
    });
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.assets[MAIN_DOCUMENT] = 'Main.\n';

    // Act
    const bundle = await exported(w);

    // Assert
    should(bundle.daemon).equal('daemon-source');
    should(Object.keys(bundle.keys).toSorted()).deepEqual([
      'instructions/far',
      'instructions/lost',
      'instructions/main',
      'login/claude-you',
      'modelSets/claude',
      'profile/default',
      'runtime/claude-default',
      'skills/mine',
    ]);
    for (const key of Object.values(bundle.keys)) should(key).match(ORIGIN_KEY_PATTERN);
    should(new Set(Object.values(bundle.keys)).size).equal(8);
    should(bundle.keys['runtime/claude-default']).equal(originKeyOfId('12345678-1234-4234-8234-123456789abc'));
    const stored = parseExportKeys(w.state.keysText);
    should(Object.keys(stored.items).toSorted()).deepEqual(
      Object.keys(bundle.keys)
        .filter(reference => !reference.startsWith('runtime/'))
        .toSorted(),
    );
    should(stored.items['instructions/main']?.key).equal(bundle.keys['instructions/main']);
  });

  it('should give the same keys on the next export', async () => {
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.assets[MAIN_DOCUMENT] = 'Main.\n';
    const first = await exported(w);
    const second = await exported(w);
    const { 'runtime/claude-default': _runtime, ...firstKeys } = first.keys;
    const { 'runtime/claude-default': _again, ...secondKeys } = second.keys;
    should(secondKeys).deepEqual(firstKeys);
    should(w.state.keysWrites).equal(2);
  });

  it('should keep a key through a pure rename and give an edited rename a new one', async () => {
    // Arrange
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.assets[MAIN_DOCUMENT] = 'Main.\n';
    const before = await exported(w);

    // Act: renamed, document unchanged
    w.state.reading = configReading(renamedMain('primary'), 'r');
    w.state.assets['/state/fleet/assets/components/instructions/primary.md'] = 'Main.\n';
    const renamed = await exported(w);

    // Assert
    should(renamed.keys['instructions/primary']).equal(before.keys['instructions/main']);
    should(renamed.keys['profile/default']).equal(before.keys['profile/default']);
    should(Object.keys(parseExportKeys(w.state.keysText).items)).not.containEql('instructions/main');

    // Act: renamed again AND edited
    w.state.reading = configReading(renamedMain('final'), 'r');
    w.state.assets['/state/fleet/assets/components/instructions/final.md'] = 'Main, edited.\n';
    const edited = await exported(w);

    // Assert
    should(edited.keys['instructions/final']).not.equal(before.keys['instructions/main']);
    should(edited.keys['profile/default']).equal(before.keys['profile/default']);
  });

  it('should mint again when export-keys.json cannot be read, and write a file that can', async () => {
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.assets[MAIN_DOCUMENT] = 'Main.\n';
    for (const broken of [
      'not json',
      '{"version":2,"items":{}}',
      '{"version":1,"items":{"instructions/main":{"key":"short","digest":"x"}}}',
    ]) {
      w.state.keysText = broken;
      const bundle = await exported(w);
      should(bundle.keys['instructions/main']).match(ORIGIN_KEY_PATTERN);
      should(parseExportKeys(w.state.keysText).items['instructions/main']?.key).equal(bundle.keys['instructions/main']);
    }
  });

  it('should still answer with the keys it minted when the file cannot be written', async () => {
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.keysWriteError = new Error('read-only file system');
    const bundle = await exported(w);
    should(bundle.keys['instructions/main']).match(ORIGIN_KEY_PATTERN);
    should(w.state.keysText).be.undefined();
  });

  it('should answer with minted keys but leave export-keys.json alone when it cannot be read', async () => {
    // Arrange: a file that holds keys every target may already carry, and a read that fails (not "absent")
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.assets[MAIN_DOCUMENT] = 'Main.\n';
    const first = await exported(w);
    const kept = w.state.keysText;
    const writes = w.state.keysWrites;
    w.state.keysReadError = new Error('input/output error');

    // Act
    const bundle = await exported(w);

    // Assert
    should(bundle.keys['instructions/main']).match(ORIGIN_KEY_PATTERN);
    should(bundle.keys['instructions/main']).not.equal(first.keys['instructions/main']);
    should(w.state.keysText).equal(kept);
    should(w.state.keysWrites).equal(writes);
    w.state.keysReadError = undefined;
    should((await exported(w)).keys['instructions/main']).equal(first.keys['instructions/main']);
  });

  it('should refuse in words, and write nothing, when the setup holds more items than a bundle has keys for', async () => {
    // Arrange
    const w = world();
    const base = SET_UP_MODEL();
    const servers = Object.fromEntries(
      Array.from({ length: CLONE_BUNDLE_KEYS_LIMIT + 1 }, (_, index) => [
        `server-${String(index)}`,
        { command: 'mcp' },
      ]),
    );
    w.state.reading = configReading(
      parseAccountModel({ ...base, components: { ...base.components, mcp: servers } }),
      'r',
    );

    // Act
    const refusal = await setupRefusal(w.service.exportBundle(), 'fleet_setup_refused');

    // Assert
    should(refusal.message).containEql(String(CLONE_BUNDLE_KEYS_LIMIT));
    should(w.state.keysWrites).equal(0);
  });

  it('should refuse an export while the daemon has no id to report', async () => {
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    w.state.daemon = undefined;
    await setupRefusal(w.service.exportBundle(), 'fleet_setup_refused');
  });

  it('should carry no secret value and no token field in the bundle, the keys or the file (§14.4)', async () => {
    // Arrange: a login that names a secret, and a secret the store holds.
    const w = world();
    const base = SET_UP_MODEL();
    w.state.reading = configReading(
      parseAccountModel({
        ...base,
        components: {
          ...base.components,
          mcp: { github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' } } },
        },
      }),
      'r',
    );
    w.secrets.set('GITHUB_TOKEN', SECRET_VALUE);

    // Act
    const bundle = await exported(w);
    const wire = JSON.stringify(bundle);

    // Assert
    should(wire).not.containEql(SECRET_VALUE);
    should(w.state.keysText ?? '').not.containEql(SECRET_VALUE);
    should(wire).containEql('${secret:GITHUB_TOKEN}');
    should(Object.keys(bundle).toSorted()).deepEqual([
      'components',
      'credentials',
      'daemon',
      'exportedAt',
      'files',
      'format',
      'keys',
      'machine',
      'notCopied',
      'profiles',
      'runtimes',
      'version',
    ]);
    for (const credential of bundle.credentials) should(Object.keys(credential)).not.containEql('token');
  });
});

describe('the setup.import executor', () => {
  it('should describe the import, then write config, components, skills, the record and the secret', async () => {
    // Arrange
    const { service, applied, secrets } = world();

    // Act
    const { description, summary } = await importOnce(service);

    // Assert
    should(description).containEql('Login claude-you: shared with claude in your terminal');
    should(description).containEql('Runtimes: claude-default.');
    should(description).not.containEql(SECRET_VALUE);
    should(summary).equal('studio is ready · 1 runtime created: claude-default.');
    const paths = (applied[0]?.documents ?? []).map(document => document.path);
    should(paths).containEql('/state/config/runtimes/claude-default.yaml');
    should(paths).containEql('/state/fleet/assets/skills/review/SKILL.md');
    should(paths).containEql(RECORD_PATH);
    should(paths.some(path => path.startsWith('/state/fleet/assets/components/instructions/'))).be.true();
    should(secrets.get('GITHUB_TOKEN')).equal(SECRET_VALUE);
    for (const document of applied[0]?.documents ?? []) should(document.content).not.containEql(SECRET_VALUE);
    should(configTextOf(applied[0]?.documents ?? [])).containEql('agent: true');
  });

  it('should publish a runtime on a login its budget holds unavailable, like every other publish', async () => {
    // Arrange: the imported login is over its daily trigger on this machine.
    const { service, applied } = world({
      catalog: {
        budgetHolds: () => ({
          'claude-you': {
            period: 'daily',
            level: 'over_trigger',
            limitUsd: 40,
            resetsAtMs: Date.parse('2026-10-14T00:00:00.000Z'),
            timeZone: 'UTC',
          },
        }),
      },
    });

    // Act
    await importOnce(service);

    // Assert
    const plan = applied[0]?.plan as
      | { manifest: { accounts: { available: boolean; unavailableReason: string | null }[] } }
      | undefined;
    should(plan?.manifest.accounts[0]?.available).be.false();
    should(plan?.manifest.accounts[0]?.unavailableReason).match(/over its daily budget on this machine/u);
  });

  it("should publish each imported runtime with its login's model catalog (docs/model-catalog.md)", async () => {
    // Arrange
    const { service, applied } = world({
      catalog: { modelCatalogs: async () => ({ catalogs: builtInModelCatalogs(), presets: builtInPresets() }) },
    });

    // Act
    await importOnce(service);

    // Assert — a Claude sign-in reads Anthropic's catalog
    const plan = applied[0]?.plan as { manifest: { accounts: { modelCatalog?: { id: string } }[] } } | undefined;
    should(plan?.manifest.accounts[0]?.modelCatalog?.id).equal('anthropic');
  });

  it('should have an imported wrapper exec the harness path this daemon located', async () => {
    // Arrange
    const { service, applied } = world();

    // Act
    await importOnce(service);

    // Assert — the located Claude, not whichever `claude` a session's PATH puts first
    const plan = applied[0]?.plan as { operations: { kind: string; content?: string }[] } | undefined;
    const scripts = (plan?.operations ?? []).flatMap(operation =>
      operation.content?.includes('\nexec ') ? [operation.content] : [],
    );
    should(scripts.length).be.above(0);
    should(scripts.every(script => script.includes("\nexec '/usr/bin/claude' "))).be.true();
  });

  it('should refuse to apply anything that was not described first, or changed since', async () => {
    const { service, state } = world();
    await catalogRefusal(service.executors.setup.execute(IMPORT()), 'fleet_change_stale');
    const change = IMPORT();
    await service.executors.setup.describe(change);
    state.scans = [claudeScan({ instructions: { kind: 'text', source: '/x/CLAUDE.md', text: 'Other.\n', bytes: 7 } })];
    await catalogRefusal(service.executors.setup.execute(change), 'fleet_change_stale');
  });

  it('should use the names the person gave, and refuse an invalid or taken one with a suggestion', async () => {
    const named = world();
    await importOnce(named.service, IMPORT({ names: { claude: 'my-claude', codex: 'unused' } }));
    should(configTextOf(named.applied[0]?.documents ?? [])).containEql('my-claude');

    const same = world();
    await importOnce(same.service, IMPORT({ names: { claude: 'claude-default' } }));
    should(configTextOf(same.applied[0]?.documents ?? [])).containEql('claude-default');

    const invalid = await catalogRefusal(
      world().service.executors.setup.describe(IMPORT({ names: { claude: 'no spaces' } })),
      'fleet_change_refused',
    );
    should(invalid.message).equal('Use only letters, digits and dashes. Use claude-default?');

    const taken = world();
    taken.state.reading = configReading(
      parseAccountModel({
        version: 2,
        credentials: { other: { harness: 'claude', store: 'ferretry' } },
        components: { modelSets: { m: { models: ['a'], default: 'a' } } },
        profiles: { p: { layers: ['modelSets/m'] } },
        runtimes: { mine: { credential: 'other', profile: 'p' } },
      }),
      'r',
    );
    const clash = await catalogRefusal(
      taken.service.executors.setup.describe(IMPORT({ names: { claude: 'mine' } })),
      'fleet_change_refused',
    );
    should(clash.message).equal('mine is already a runtime on studio. Use mine-2?');
  });

  it('should import only the harnesses chosen, and say when nothing was found', async () => {
    const { service } = world();
    const refusal = await catalogRefusal(
      service.executors.setup.describe(IMPORT({ include: [] })),
      'fleet_change_refused',
    );
    should(refusal.message).equal('Nothing was found to import.');
  });

  it('should add only what is new on Import again, apply an accepted update, and refuse an unknown one', async () => {
    // Arrange: one import is on disk.
    const { service, state, applied } = world();
    await importOnce(service);
    const written = applied[0]?.documents ?? [];
    for (const document of written) state.assets[document.path] = document.content;
    state.reading = configReading(modelOfWrites(written), 'rev-2');

    // Act / Assert: the same host has nothing new.
    should(
      ((await catalogRefusal(service.executors.setup.describe(IMPORT()), 'fleet_change_refused')) as Error).message,
    ).equal('Nothing new to import.');

    // An update nobody offered.
    await catalogRefusal(
      service.executors.setup.describe(IMPORT({ acceptedUpdates: ['instructions/nope'] })),
      'fleet_change_refused',
    );

    // The host's CLAUDE.md changed and the person accepted the update; a twin runtime is added anyway.
    state.scans = [
      claudeScan({
        instructions: { kind: 'text', source: '/person/.claude/CLAUDE.md', text: 'Be kinder.\n', bytes: 11 },
      }),
      codexScan(),
    ];
    const { description } = await importOnce(
      service,
      IMPORT({ acceptedUpdates: ['instructions/main'], addDuplicates: true }),
    );
    should(description).containEql('Updates instructions/main from its changed source.');
    const second = applied[1]?.documents ?? [];
    should(second.some(document => document.content === 'Be kinder.\n')).be.true();
    should(configTextOf(second)).containEql('claude-default-2');
  });

  it('should describe a login that needs sign-in when the host one cannot be shared', async () => {
    const change = IMPORT();
    const keyring = world();
    keyring.state.scans = [
      codexScan({
        command: '/usr/bin/codex',
        login: { state: 'not-shareable', reason: 'keyring' },
        instructions: { kind: 'text', source: '/person/.codex/AGENTS.md', text: 'Codex.\n', bytes: 7 },
      }),
    ];
    const description = await keyring.service.executors.setup.describe(change);
    should(description).containEql('a new Codex login that needs sign-in');
  });

  it('should say it only imported, naming no runtime, when an accepted update adds none', async () => {
    // Arrange: one import is on disk, and the host's CLAUDE.md has since changed.
    const { service, state, applied } = world();
    await importOnce(service);
    const written = applied[0]?.documents ?? [];
    for (const document of written) state.assets[document.path] = document.content;
    state.reading = configReading(modelOfWrites(written), 'rev-2');
    state.scans = [
      claudeScan({
        instructions: { kind: 'text', source: '/person/.claude/CLAUDE.md', text: 'Be kinder.\n', bytes: 11 },
      }),
      codexScan(),
    ];

    // Act — the twin runtime is not added again, so only the update lands.
    const { summary } = await importOnce(service, IMPORT({ acceptedUpdates: ['instructions/main'] }));

    // Assert
    should(summary).equal('Imported into studio.');
  });

  it('should refuse when the secret store cannot be read, and fail when it cannot take a value', async () => {
    const unreadable = world();
    unreadable.state.secretNames = async () => {
      throw new Error('vault damaged');
    };
    should(
      (await catalogRefusal(unreadable.service.executors.setup.describe(IMPORT()), 'fleet_change_refused')).message,
    ).containEql('vault damaged');

    const full = world();
    full.state.putSecret = async () => {
      throw new Error('full');
    };
    const change = IMPORT();
    await full.service.executors.setup.describe(change);
    const failure = await catalogRefusal(full.service.executors.setup.execute(change), 'fleet_change_failed');
    should(failure.message).equal('the secret store could not take GITHUB_TOKEN, so nothing was changed: full');
    should(full.applied).have.length(0);
  });

  it('should report an apply that failed for any other reason in its own words', async () => {
    const { service, state } = world();
    state.apply = async () => {
      throw new Error('the manifest could not be written');
    };
    const change = IMPORT();
    await service.executors.setup.describe(change);
    const failure = await catalogRefusal(service.executors.setup.execute(change), 'fleet_change_failed');
    should(failure.message).equal('the manifest could not be written');
  });

  it('should refuse an import that would leave a configuration this machine cannot read', async () => {
    const { service, state } = world();
    state.reading = configReading(
      parseAccountModel({
        version: 2,
        credentials: { other: { harness: 'codex', store: 'ferretry' } },
        components: { modelSets: { m: { models: ['a'], default: 'a' } } },
        profiles: { p: { layers: ['modelSets/m'] } },
        runtimes: { x: { credential: 'other', profile: 'p' } },
        advanced: { commands: [{ wrapper: 'claude-default', runtime: 'x' }] },
      }),
      'r',
    );
    const refusal = await catalogRefusal(service.executors.setup.describe(IMPORT()), 'fleet_change_refused');
    should(refusal.message).startWith('importing would leave studio with a setup it cannot read');
  });

  it('should turn a failed apply into a failure that says nothing was left half-changed', async () => {
    const { service, state } = world();
    state.apply = async () => {
      throw new FleetApplyFailureError({ kind: 'rolled-back', stage: 'x', reason: 'disk full' } as never, undefined);
    };
    const change = IMPORT();
    await service.executors.setup.describe(change);
    const failure = await catalogRefusal(service.executors.setup.execute(change), 'fleet_change_failed');
    should(failure.message).endWith('; nothing was left half-changed');
  });

  it('should read settings, hooks and skill bodies the model names, ignoring one that does not parse', async () => {
    const { service, applied, state } = world();
    state.assets['/state/fleet/assets/components/settings/good.json'] = '{"theme":"dark"}';
    state.assets['/state/fleet/assets/components/settings/bad.json'] = '{nope';
    state.assets['/state/fleet/assets/components/hooks/h.json'] = '{"hooks":{}}';
    state.assets['/state/fleet/assets/components/instructions/main.md'] = 'Main.\n';
    state.assets['/state/fleet/assets/skills/review/SKILL.md'] = '---\nname: review\nallowed-tools: x\n---\n';
    const model = parseAccountModel({
      version: 2,
      credentials: { c: { harness: 'claude', store: 'host' } },
      components: {
        instructions: {
          main: { file: 'components/instructions/main.md' },
          gone: { file: 'components/instructions/gone.md' },
        },
        skills: { s: { items: ['review'] } },
        settings: {
          good: { harness: 'claude', file: 'components/settings/good.json' },
          bad: { harness: 'claude', file: 'components/settings/bad.json' },
          flags: { harness: 'claude', flags: ['--verbose'] },
        },
        hooks: {
          h: { harness: 'claude', file: 'components/hooks/h.json' },
          d: { harness: 'claude', directory: 'hooks/d' },
        },
      },
      profiles: { p: { layers: ['instructions/main', 'skills/s', 'settings/good', 'hooks/h'] } },
      runtimes: { 'claude-p': { credential: 'c', profile: 'p' } },
    });
    state.reading = configReading(model, 'rev');
    await importOnce(service);
    should(applied).have.length(1);
  });

  it('should refuse a model the fleet library cannot materialise', async () => {
    const { service, state } = world();
    state.assets['/state/fleet/assets/components/settings/bad.json'] = '{nope';
    const broken = parseAccountModel({
      version: 2,
      credentials: { c: { harness: 'claude', store: 'host' } },
      components: { settings: { bad: { harness: 'claude', file: 'components/settings/bad.json' } } },
      profiles: { p: { layers: ['settings/bad'] } },
      runtimes: { 'claude-p': { credential: 'c', profile: 'p' } },
    });
    state.reading = configReading(broken, 'rev');
    const change = IMPORT();
    await service.executors.setup.describe(change);
    const refusal = await catalogRefusal(service.executors.setup.execute(change), 'fleet_change_refused');
    should(refusal.message).containEql('settings "bad" could not be read');
  });
});

// ── The clone executor ───────────────────────────────────────────────────────────────────────────

const BUNDLE = () =>
  buildCloneBundle({
    model: SET_UP_MODEL(),
    machine: 'work-mac',
    exportedAt: '2026-10-13T07:00:00.000Z',
    emails: { 'claude-you': 'you@example.com' },
    files: [{ path: 'components/instructions/main.md', content: 'Main from work.\n' }],
    notCopied: [],
  });

describe('the clone.import executor', () => {
  it('should copy the bundle with each login as an empty slot, and offer one sign-in for its runtimes', async () => {
    // Arrange
    const { service, applied } = world();
    const change = { kind: 'clone.import', mode: 'alongside', bundle: BUNDLE() } as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;

    // Act
    const description = await service.executors.clone.describe(change);
    const summary = await service.executors.clone.execute(change);

    // Assert
    should(description).containEql('from work-mac');
    should(summary).equal('Copied 1 runtime from work-mac. Sign in once for 1 runtime: you@example.com.');
    const config = configTextOf(applied[0]?.documents ?? []);
    should(config).containEql('clonedFrom: work-mac');
    should(config).containEql('store: ferretry');
    should((applied[0]?.documents ?? []).map(document => document.path)).containEql(
      '/state/fleet/assets/components/instructions/main.md',
    );
  });

  it('should reuse a login this machine already has, by email, and say there is no new sign-in', async () => {
    // Arrange
    const { service, applied, state } = world();
    state.reading = configReading(
      parseAccountModel({ version: 2, credentials: { 'claude-mine': { harness: 'claude', store: 'ferretry' } } }),
      'r',
    );
    state.emails = async () => [credentialRow('claude-mine', 'YOU@example.com')];
    const change = { kind: 'clone.import', mode: 'alongside', bundle: BUNDLE() } as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;

    // Act
    const description = await service.executors.clone.describe(change);
    const summary = await service.executors.clone.execute(change);

    // Assert
    should(description).containEql('Login YOU@example.com — already here, no new sign-in (used by 1 runtime).');
    should(description).not.containEql('needs sign-in');
    should(summary).equal('Copied 1 runtime from work-mac. Already signed in here, no new sign-in: YOU@example.com.');
    const config = configTextOf(applied[0]?.documents ?? []);
    should(config).containEql('credential: claude-mine');
    should(config).not.containEql('claude-you');
  });

  it('should add an empty slot, as before, when this machine cannot tell which account its logins are', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading(
      parseAccountModel({ version: 2, credentials: { 'claude-mine': { harness: 'claude', store: 'ferretry' } } }),
      'r',
    );
    state.emails = async () => {
      throw new Error('down');
    };
    const change = { kind: 'clone.import', mode: 'alongside', bundle: BUNDLE() } as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;

    // Act
    await service.executors.clone.describe(change);
    const summary = await service.executors.clone.execute(change);

    // Assert
    should(summary).equal('Copied 1 runtime from work-mac. Sign in once for 1 runtime: you@example.com.');
  });

  it('should leave out what the person skipped and record the source daemon the browser verified', async () => {
    // Arrange
    const { service, applied } = world();
    const bundle = {
      ...BUNDLE(),
      components: { ...BUNDLE().components, mcp: { notes: { command: 'npx', args: ['-y', 'notes'] } } },
    };
    const change = {
      kind: 'clone.import',
      mode: 'alongside',
      bundle,
      skip: ['mcp/notes'],
      source: { daemonId: 'sha256:work-mac' },
    } as Extract<FleetAccountChange, { kind: 'clone.import' }>;

    // Act
    const description = await service.executors.clone.describe(change);
    await service.executors.clone.execute(change);

    // Assert
    should(description).containEql('Leaves out mcp/notes: you chose not to copy it.');
    const config = configTextOf(applied[0]?.documents ?? []);
    should(config).not.containEql('notes');
    should(config).containEql('clonedFromDaemon: sha256:work-mac');
  });

  it('should list each command a copy runs in the description', async () => {
    const { service } = world();
    const bundle = { ...BUNDLE(), components: { ...BUNDLE().components, mcp: { notes: { command: 'npx' } } } };
    should(
      await service.executors.clone.describe({ kind: 'clone.import', mode: 'alongside', bundle } as never),
    ).containEql('Runs: mcp/notes — Starts: npx');
  });

  it('should say nothing about signing in when the copy has no runtimes', async () => {
    const { service } = world();
    const bundle = { ...BUNDLE(), runtimes: {}, credentials: [] };
    const change = { kind: 'clone.import', mode: 'replace', bundle } as never;
    await service.executors.clone.describe(change);
    should(await service.executors.clone.execute(change)).equal('Copied 0 runtimes from work-mac.');
  });

  it('should refuse a damaged bundle and one exported by this machine itself', async () => {
    const { service } = world();
    await catalogRefusal(
      service.executors.clone.describe({ kind: 'clone.import', mode: 'alongside', bundle: { format: 'nope' } }),
      'fleet_change_refused',
    );
    const own = await catalogRefusal(
      service.executors.clone.describe({
        kind: 'clone.import',
        mode: 'alongside',
        bundle: { ...BUNDLE(), machine: 'studio' },
      }),
      'fleet_change_refused',
    );
    should(own.message).equal('That setup was exported from studio itself; pick another machine to copy from.');
  });

  it('should rethrow a failure that is not a refusal, and copy anyway when the secret names cannot be read', async () => {
    const failing = world();
    failing.state.skillItems = async () => {
      throw new Error('assets unreadable');
    };
    should(
      (
        (await thrown(
          failing.service.executors.clone.describe({ kind: 'clone.import', mode: 'alongside', bundle: BUNDLE() }),
        )) as Error
      ).message,
    ).equal('assets unreadable');

    const noNames = world();
    noNames.state.secretNames = async () => {
      throw new Error('vault damaged');
    };
    should(
      await noNames.service.executors.clone.describe({ kind: 'clone.import', mode: 'alongside', bundle: BUNDLE() }),
    ).containEql('work-mac');
  });
});

// ── The update copy ──────────────────────────────────────────────────────────────────────────────

describe('the clone.import executor in update mode', () => {
  const MAIN_COPY = '/state/fleet/assets/components/instructions/main.md';

  const sourceAt = async (content: string): Promise<Record<string, unknown>> => {
    const source = world({
      catalog: { machineName: () => 'work-mac' },
      overrides: { daemonId: () => 'daemon-source' },
    });
    source.state.reading = configReading(SET_UP_MODEL(), 'r');
    source.state.assets[MAIN_DOCUMENT] = content;
    return (await source.service.exportBundle()) as unknown as Record<string, unknown>;
  };
  const request = (bundle: unknown, extra: Record<string, unknown> = {}) =>
    ({ kind: 'clone.import', mode: 'update', bundle, ...extra }) as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;

  /** A target that already took its first copy from the source, as it stands afterwards. */
  const copied = async (): Promise<World> => {
    const first = world({ overrides: { daemonId: () => 'daemon-target' } });
    const alongside = {
      kind: 'clone.import',
      mode: 'alongside',
      bundle: await sourceAt('Main.\n'),
    } as Extract<FleetAccountChange, { kind: 'clone.import' }>;
    await first.service.executors.clone.describe(alongside);
    await first.service.executors.clone.execute(alongside);
    const documents = first.applied[0]?.documents ?? [];
    const target = world({ overrides: { daemonId: () => 'daemon-target' } });
    target.state.reading = configReading(modelOfWrites(documents), 'r');
    for (const document of documents) target.state.assets[document.path] = document.content;
    target.state.emails = async () => [];
    return target;
  };

  const batchRecord = (w: World) => (w.applied[0]?.documents ?? []).find(document => document.path === BASE_PATH);

  it('should list nothing and write nothing for a copy that has not changed', async () => {
    const w = await copied();
    const review = await w.service.reviewClone({ bundle: await sourceAt('Main.\n') });
    should(review.mode).equal('update');
    should(review.items).deepEqual([]);
    should(review.same.count).be.above(0);
  });

  it('should take a change made on the source, and record it as the new last-copied in the same batch', async () => {
    // Arrange
    const w = await copied();
    const bundle = await sourceAt('Main, changed on the source.\n');
    const review = await w.service.reviewClone({ bundle });
    const item = review.items.find(row => row.ref === 'instructions/main');
    should(item?.outcome).equal('theirs');
    should(item?.choice).equal('take');
    const change = request(bundle, { reviewed: review.fingerprint, decisions: {} });

    // Act
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);

    // Assert
    const written = (w.applied[0]?.documents ?? []).find(document => document.path === MAIN_COPY);
    should(written?.content).equal('Main, changed on the source.\n');
    should(batchRecord(w)?.path).equal(BASE_PATH);
    for (const document of w.applied[0]?.documents ?? []) w.state.assets[document.path] = document.content;
    const after = await w.service.reviewClone({ bundle });
    should(after.items.map(row => row.ref)).not.containEql('instructions/main');
  });

  it('should refuse an apply whose review has moved since the person saw it', async () => {
    const w = await copied();
    const bundle = await sourceAt('Main, changed on the source.\n');
    const refusal = await catalogRefusal(
      w.service.executors.clone.describe(request(bundle, { reviewed: 'stale', decisions: {} })),
      'fleet_change_refused',
    );
    should(refusal.message).equal('Something changed since you reviewed. Review again.');
    should(w.applied).deepEqual([]);
  });

  it('should leave an item changed here alone when the source did not change it', async () => {
    const w = await copied();
    w.state.assets[MAIN_COPY] = 'Main, edited here.\n';
    const bundle = await sourceAt('Main.\n');
    const review = await w.service.reviewClone({ bundle });
    should(review.items.find(row => row.ref === 'instructions/main')?.outcome).equal('mine');
    const change = request(bundle, { reviewed: review.fingerprint, decisions: {} });
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    should((w.applied[0]?.documents ?? []).find(document => document.path === MAIN_COPY)).be.undefined();
  });

  it('should refuse an item changed on both sides until the person chooses, then honour either choice', async () => {
    const w = await copied();
    w.state.assets[MAIN_COPY] = 'Main, edited here.\n';
    const bundle = await sourceAt('Main, edited there.\n');
    const review = await w.service.reviewClone({ bundle });
    const item = review.items.find(row => row.ref === 'instructions/main');
    should(item?.outcome).equal('both');
    should(item?.choice).be.undefined();

    const unchosen = request(bundle, { reviewed: review.fingerprint, decisions: {} });
    const refusal = await catalogRefusal(w.service.executors.clone.describe(unchosen), 'fleet_change_refused');
    should(refusal.message).containEql('instructions/main');

    const take = request(bundle, { reviewed: review.fingerprint, decisions: { 'instructions/main': 'take' } });
    await w.service.executors.clone.describe(take);
    await w.service.executors.clone.execute(take);
    should((w.applied[0]?.documents ?? []).find(document => document.path === MAIN_COPY)?.content).equal(
      'Main, edited there.\n',
    );

    const keep = await copied();
    keep.state.assets[MAIN_COPY] = 'Main, edited here.\n';
    const keeping = request(bundle, { reviewed: review.fingerprint, decisions: { 'instructions/main': 'keep' } });
    await keep.service.executors.clone.describe(keeping);
    await keep.service.executors.clone.execute(keeping);
    should((keep.applied[0]?.documents ?? []).find(document => document.path === MAIN_COPY)).be.undefined();
  });

  it('should never write a login or a secret, whatever the person chose (account-model §14.4)', async () => {
    // Arrange: a target holding a signed-in login and a stored secret.
    const w = await copied();
    w.secrets.set('NOTES_TOKEN', 'ghp_do_not_touch');
    w.state.assets[MAIN_COPY] = 'Main, edited here.\n';
    const bundle = await sourceAt('Main, edited there.\n');
    const review = await w.service.reviewClone({ bundle });
    const change = request(bundle, { reviewed: review.fingerprint, decisions: { 'instructions/main': 'take' } });

    // Act
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);

    // Assert
    should(configTextOf(w.applied[0]?.documents ?? [])).not.containEql('claude-you');
    should([...w.secrets]).deepEqual([['NOTES_TOKEN', 'ghp_do_not_touch']]);
  });

  it('should refuse a review of a setup exported from this very machine', async () => {
    const w = await copied();
    const bundle = { ...(await sourceAt('Main.\n')), machine: 'studio' };
    const refusal = await setupRefusal(w.service.reviewClone({ bundle }), 'fleet_setup_refused');
    should(refusal.message).containEql('itself');
  });

  it('should let an unexpected failure through, in a review and in an apply, rather than call it a refusal', async () => {
    const broken = world({
      overrides: {
        cloneBase: {
          read: async () => {
            throw new Error('disk gone');
          },
          write: async () => undefined,
        },
      },
    });
    broken.state.reading = configReading(SET_UP_MODEL(), 'r');
    const bundle = await sourceAt('Main.\n');
    await broken.service.reviewClone({ bundle }).then(
      () => should.fail('resolved', 'rejected'),
      (error: unknown) => should((error as Error).message).equal('disk gone'),
    );
    await broken.service.executors.clone.describe(request(bundle, { reviewed: 'x', decisions: {} })).then(
      () => should.fail('resolved', 'rejected'),
      (error: unknown) => should((error as Error).message).equal('disk gone'),
    );
  });

  it('should record nothing for a source that carries no identity, but still write what was chosen', async () => {
    const w = await copied();
    const { daemon: _daemon, keys: _keys, ...rest } = await sourceAt('Main, changed on the source.\n');
    const bundle = { ...rest, version: 1 };
    const review = await w.service.reviewClone({ bundle });
    const change = request(bundle, { reviewed: review.fingerprint, decisions: { 'instructions/main': 'take' } });
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    should(batchRecord(w)).be.undefined();
  });
});

// ── The update copy: security review regressions (#F544) ─────────────────────────────────────────

describe('the clone.import executor in update mode refuses what the review did not say', () => {
  const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
  const KEY_API = 'cccccccccccccccccccccccccc';
  // A copy made from a file: no id a browser verified is stamped on it.
  const FROM_SOURCE = { clonedFrom: 'source' };
  const bundleOf = (patch: Record<string, unknown> = {}) =>
    FleetCloneBundleSchema.parse({
      format: 'ferretry-clone',
      version: 2,
      daemon: 'daemon-source',
      keys: {},
      machine: 'source',
      exportedAt: '2026-10-13T07:00:00.000Z',
      credentials: [],
      components: {},
      profiles: {},
      runtimes: {},
      files: [],
      notCopied: [],
      ...patch,
    }) as unknown as Record<string, unknown>;
  const update = (bundle: unknown, extra: Record<string, unknown> = {}) =>
    ({ kind: 'clone.import', mode: 'update', bundle, ...extra }) as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;
  const run = async (w: World, change: Extract<FleetAccountChange, { kind: 'clone.import' }>) => {
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    return w.applied[0]?.documents ?? [];
  };

  it('should honour skip: a left-out new component is not written, and a contradicting decision is refused', async () => {
    // Arrange
    const w = world();
    const bundle = bundleOf({
      keys: { 'mcp/skip-me': KEY_A },
      components: { mcp: { 'skip-me': { command: 'not-supposed-to-copy' } } },
    });
    const review = await w.service.reviewClone({ bundle });

    // Act
    const documents = await run(w, update(bundle, { skip: ['mcp/skip-me'], reviewed: review.fingerprint }));

    // Assert
    should(documents.map(document => document.path).filter(path => path.includes('skip-me'))).eql([]);
    const refusal = await catalogRefusal(
      w.service.executors.clone.describe(
        update(bundle, {
          skip: ['mcp/skip-me'],
          decisions: { 'mcp/skip-me': 'add' },
          reviewed: review.fingerprint,
        }),
      ),
      'fleet_change_refused',
    );
    should(refusal.message).containEql('mcp/skip-me is left out');
  });

  it('should refuse an environment login changed after the review, writing nothing', async () => {
    // Arrange
    const environment = (value: string) =>
      bundleOf({
        keys: { 'login/api': KEY_API },
        credentials: [{ id: 'api', harness: 'claude', store: 'environment', env: { NODE_OPTIONS: value } }],
        profiles: { default: { layers: [] } },
        runtimes: { agent: { credential: 'api', profile: 'default', agent: false } },
      });
    const w = world();
    const review = await w.service.reviewClone({ bundle: environment('--trace-warnings') });
    should(review.logins[0]?.runnable?.entries).containEql({
      label: 'Environment NODE_OPTIONS',
      text: '--trace-warnings',
      document: false,
    });

    // Act
    const refusal = await catalogRefusal(
      w.service.executors.clone.describe(
        update(environment('--require /tmp/other-module.cjs'), { reviewed: review.fingerprint }),
      ),
      'fleet_change_refused',
    );

    // Assert
    should(refusal.message).equal('Something changed since you reviewed. Review again.');
    should(w.applied).eql([]);
  });

  it('should refuse a bundle that carries a script and also says it could not, on review and on apply', async () => {
    const masked = bundleOf({
      keys: { 'hooks/a': KEY_A },
      components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
      files: [{ path: 'components/hooks/a/run.sh', content: 'different script' }],
      notCopied: [{ path: 'components/hooks/a/run.sh', reason: 'too large' }],
    });
    const w = world();
    const reviewing = await setupRefusal(w.service.reviewClone({ bundle: masked }), 'fleet_setup_refused');
    should(reviewing.message).containEql('also says it could not carry it');
    const applying = await catalogRefusal(
      w.service.executors.clone.describe(update(masked, { reviewed: 'any' })),
      'fleet_change_refused',
    );
    should(applying.message).containEql('also says it could not carry it');
    should(w.applied).eql([]);
  });

  /** A target whose hooks/a, copied before from the source, owns a folder holding `files`. */
  const withHooks = (directory: string, files: string[], layout = LAYOUT): World => {
    const w = world({ catalog: { layout } });
    w.state.reading = configReading(
      parseAccountModel({
        version: 2,
        components: { hooks: { a: { harness: 'claude', directory, ...FROM_SOURCE, clonedFromKey: KEY_A } } },
      }),
      'r',
    );
    const folder = `${layout.assetsDirectory}/${directory}`;
    w.state.folders[folder] = { files: files.map(path => ({ path, content: `${path} here` })), skipped: [] };
    for (const path of files) w.state.assets[`${folder}/${path}`] = `${path} here`;
    return w;
  };
  const keepOnly = bundleOf({
    keys: { 'hooks/a': KEY_A },
    components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
    files: [{ path: 'components/hooks/a/keep.sh', content: 'keep, from the source' }],
  });

  it('should remove a file the review listed as removed, in the same batch and only if unchanged', async () => {
    // Arrange
    const w = withHooks('components/hooks/a', ['keep.sh', 'gone.sh']);
    const review = await w.service.reviewClone({ bundle: keepOnly });
    should(review.items[0]?.files).containEql({
      path: 'components/hooks/a/gone.sh',
      change: 'removed',
      lines: { added: 0, removed: 1 },
    });

    // Act
    const documents = await run(
      w,
      update(keepOnly, { reviewed: review.fingerprint, decisions: { 'hooks/a': 'take' } }),
    );

    // Assert
    should(documents.find(document => document.path.endsWith('/gone.sh'))).eql({
      path: '/state/fleet/assets/components/hooks/a/gone.sh',
      content: '',
      mode: 0o600,
      expect: 'digest:/state/fleet/assets/components/hooks/a/gone.sh',
      remove: true,
    });
    should(documents.find(document => document.path.endsWith('/keep.sh'))?.content).equal('keep, from the source');
  });

  it('should refuse to remove anything inside a credential store, even if the planner named it (§14.4)', async () => {
    // Arrange: a layout whose asset tree holds the credential store, and a folder pointed into it.
    const w = withHooks('credentials/claude-you', ['keep.sh', '.credentials.json'], {
      ...LAYOUT,
      assetsDirectory: '/state/fleet',
    });
    const review = await w.service.reviewClone({ bundle: keepOnly });

    // Act
    const refusal = await catalogRefusal(
      w.service.executors.clone.describe(
        update(keepOnly, { reviewed: review.fingerprint, decisions: { 'hooks/a': 'take' } }),
      ),
      'fleet_change_refused',
    );

    // Assert
    should(refusal.message).equal(
      "credentials/claude-you/.credentials.json is not one of this machine's own setup documents, so an update never removes it. Nothing was changed.",
    );
    should(w.applied).eql([]);
  });
});

// ── The "last copied" record ─────────────────────────────────────────────────────────────────────

describe('the clone-base record', () => {
  /** A v2 bundle from a source machine that has this setup, as its own export answers it. */
  const sourceBundle = async (daemon = 'daemon-source'): Promise<unknown> => {
    const source = world({ catalog: { machineName: () => 'work-mac' }, overrides: { daemonId: () => daemon } });
    source.state.reading = configReading(SET_UP_MODEL(), 'r');
    source.state.assets[MAIN_DOCUMENT] = 'Main.\n';
    return await source.service.exportBundle();
  };
  const target = (extra: Parameters<typeof world>[0] = {}) =>
    world({ ...extra, overrides: { daemonId: () => 'daemon-target', ...extra.overrides } });
  const clone = (bundle: unknown, extra: Record<string, unknown> = {}) =>
    ({ kind: 'clone.import', mode: 'alongside', bundle, ...extra }) as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;
  const batchRecord = (w: World) => (w.applied[0]?.documents ?? []).find(document => document.path === BASE_PATH);

  it("should ride the copy's own batch, with its own revision, and file the source under what it said of itself", async () => {
    // Arrange
    const w = target();
    const change = clone(await sourceBundle());

    // Act
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);

    // Assert
    const record = batchRecord(w);
    should(record?.mode).equal(0o600);
    should(record?.expect).equal('absent');
    const parsed = parseCloneBase(record?.content);
    const source = parsed.sources['self:daemon-source'];
    should(source?.verified).equal('self');
    should(source?.name).equal('work-mac');
    should(source?.lastCopiedAt).equal('2026-10-13T08:00:00.000Z');
    should(Object.values(source?.items ?? {}).map(item => item.kind)).containEql('login');
    should(w.state.baseWrites).deepEqual([]);
  });

  it('should hold no content, no email and no secret value', async () => {
    const w = target();
    const change = clone(await sourceBundle());
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    const text = batchRecord(w)?.content ?? '';
    should(text).not.containEql('Main.');
    should(text).not.containEql('you@example.com');
  });

  it('should not be written when the batch fails, so it never claims a copy that did not land', async () => {
    const w = target();
    w.state.apply = async () => {
      throw new Error('disk full');
    };
    const change = clone(await sourceBundle());
    await w.service.executors.clone.describe(change);
    await thrown(w.service.executors.clone.execute(change));
    should(w.state.baseWrites).deepEqual([]);
    should(w.state.assets[BASE_PATH]).be.undefined();
  });

  it('should trust the id the browser verified, and refuse an export that names another machine', async () => {
    const ok = target();
    const same = clone(await sourceBundle(), { source: { daemonId: 'daemon-source' } });
    await ok.service.executors.clone.describe(same);
    await ok.service.executors.clone.execute(same);
    should(parseCloneBase(batchRecord(ok)?.content).sources['daemon-source']?.verified).equal('browser');

    const refused = target();
    const refusal = await catalogRefusal(
      refused.service.executors.clone.describe(clone(await sourceBundle(), { source: { daemonId: 'daemon-other' } })),
      'fleet_change_refused',
    );
    should(refusal.message).equal('That export says it is from another machine than the one you picked.');
    should(refused.applied).deepEqual([]);
  });

  it('should write no record for a version 1 bundle, and stamp no key on what it copies', async () => {
    const w = target();
    const change = clone(BUNDLE());
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    should(batchRecord(w)).be.undefined();
    should(configTextOf(w.applied[0]?.documents ?? [])).not.containEql('clonedFromKey');
  });

  it('should stamp every item a version 2 copy writes with the key its source gave it', async () => {
    const w = target();
    const bundle = FleetCloneBundleSchema.parse(await sourceBundle());
    if (bundle.version !== 2) throw new Error('expected a version 2 bundle');
    const change = clone(bundle);
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    const model = modelOfWrites(w.applied[0]?.documents ?? []);
    // Names may move (a copy never overwrites); the key is what says which item is which.
    const stamped = (items: Readonly<Record<string, { clonedFromKey?: string }>>): (string | undefined)[] =>
      Object.values(items).map(item => item.clonedFromKey);
    should(stamped(model.components.instructions)).containEql(bundle.keys['instructions/main']);
    should(stamped(model.profiles)).containEql(bundle.keys['profile/default']);
    should(stamped(model.runtimes)).containEql(bundle.keys['runtime/claude-default']);
    should(stamped(model.credentials)).containEql(bundle.keys['login/claude-you']);
  });

  it('should add to what an earlier copy recorded, and rewrite the source on a Replace', async () => {
    // Arrange: an earlier record for another machine that still has a copy linked here.
    const w = target();
    const bundle = FleetCloneBundleSchema.parse(await sourceBundle());
    if (bundle.version !== 2) throw new Error('expected a version 2 bundle');
    const first = clone(bundle);
    await w.service.executors.clone.describe(first);
    await w.service.executors.clone.execute(first);
    const recorded = batchRecord(w)?.content ?? '';
    const again = target();
    again.state.assets[BASE_PATH] = recorded;
    again.state.reading = configReading(modelOfWrites(w.applied[0]?.documents ?? []), 'r');

    // Act: a Replace of the same source
    const replace = clone(bundle, { mode: 'replace' });
    await again.service.executors.clone.describe(replace);
    await again.service.executors.clone.execute(replace);

    // Assert
    const source = parseCloneBase(batchRecord(again)?.content).sources['daemon-source'];
    should(Object.keys(source?.items ?? {}).toSorted()).deepEqual(
      Object.keys(parseCloneBase(recorded).sources['daemon-source']?.items ?? {}).toSorted(),
    );
  });

  it('should still describe and execute when the copy happens at a later instant than the review', async () => {
    let tick = 0;
    const w = target({ catalog: { now: () => Date.parse('2026-10-13T08:00:00.000Z') + ++tick * 1000 } });
    const change = clone(await sourceBundle());
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    should(w.applied).have.length(1);
  });

  it('should treat an unreadable record as absent and write a fresh one', async () => {
    const w = target();
    w.state.assets[BASE_PATH] = '{not json';
    const change = clone(await sourceBundle());
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    should(Object.keys(parseCloneBase(batchRecord(w)?.content).sources)).deepEqual(['self:daemon-source']);
  });

  it('should copy without a record, and say so, when the record file exists but cannot be read', async () => {
    // Arrange
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const w = target({
      overrides: {
        cloneBase: {
          read: async () => {
            throw denied;
          },
          write: async () => {
            throw new Error('must not write over a record that could not be read');
          },
        },
      },
    });
    const change = clone(await sourceBundle());

    // Act
    const review = await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);

    // Assert
    should(JSON.stringify(review)).containEql('cannot be read');
    should(w.applied).have.length(1);
    should(batchRecord(w)).be.undefined();
  });

  it('should forget one source, writing only the record, and say whether it knew it', async () => {
    const w = target();
    const change = clone(await sourceBundle());
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    w.state.assets[BASE_PATH] = batchRecord(w)?.content ?? '';

    should(await w.service.forgetCloneSource('daemon-nobody')).equal(false);
    should(w.state.baseWrites).deepEqual([]);
    should(await w.service.forgetCloneSource('self:daemon-source')).equal(true);
    should(parseCloneBase(w.state.baseWrites[0]).sources).deepEqual({});
    should(w.applied).have.length(1);
  });

  it('should forget a source named by its bare id or its machine name, and refuse a name that fits two', async () => {
    const w = target();
    const change = clone(await sourceBundle());
    await w.service.executors.clone.describe(change);
    await w.service.executors.clone.execute(change);
    const recorded = parseCloneBase(batchRecord(w)?.content);
    const filed = recorded.sources['self:daemon-source'];
    should(filed).not.be.undefined();

    // By the bare id the export carries, and by the machine name the source gave itself.
    w.state.assets[BASE_PATH] = batchRecord(w)?.content ?? '';
    should(await w.service.forgetCloneSource('daemon-source')).equal(true);
    should(Object.keys(parseCloneBase(w.state.baseWrites[0]).sources)).deepEqual([]);

    // Two sources under one name: nothing is forgotten, and the answer names both ids.
    const twice = serializeCloneBase({
      version: 1,
      sources: { 'self:one': filed as never, 'self:two': filed as never },
    });
    w.state.assets[BASE_PATH] = twice;
    w.state.baseWrites.length = 0;
    const name = (filed as { name: string }).name;
    await should(w.service.forgetCloneSource(name)).be.rejectedWith(
      `More than one source is called ${name}: self:one, self:two. Name one by its id.`,
    );
    should(w.state.baseWrites).deepEqual([]);
  });
});

// ── The import record ────────────────────────────────────────────────────────────────────────────

describe('parseImportRecord', () => {
  it('should read a record, keep only usable entries, and treat anything else as no record', () => {
    should(parseImportRecord(undefined)).be.undefined();
    should(parseImportRecord('{not json')).be.undefined();
    should(parseImportRecord(JSON.stringify({ version: 2, components: {} }))).be.undefined();
    should(parseImportRecord(JSON.stringify({ version: 1, components: [] }))).be.undefined();
    should(
      parseImportRecord(
        JSON.stringify({
          version: 1,
          profile: 'default',
          components: {
            'instructions/main': { sources: ['/a', 3], digest: 'd' },
            'mcp/bad': { sources: 'x', digest: 'd' },
            'mcp/worse': 'x',
          },
        }),
      ),
    ).deepEqual({
      version: 1,
      components: { 'instructions/main': { sources: ['/a'], digest: 'd' } },
      profile: 'default',
    });
    should(parseImportRecord(JSON.stringify({ version: 1, components: {} }))).deepEqual({ version: 1, components: {} });
  });

  it('should read the profile each harness got, keeping only a name per known harness (P7)', () => {
    should(
      parseImportRecord(
        JSON.stringify({ version: 1, components: {}, profiles: { claude: 'claude-default', codex: 3, other: 'x' } }),
      ),
    ).deepEqual({ version: 1, components: {}, profiles: { claude: 'claude-default' } });
    should(parseImportRecord(JSON.stringify({ version: 1, components: {}, profiles: { codex: 1 } }))).deepEqual({
      version: 1,
      components: {},
    });
  });
});

describe('the clone.import executor merging settings key by key', () => {
  const MAIN_COPY = '/state/fleet/assets/components/instructions/main.md';
  const WARDEN = `# yaml-language-server: $schema=../schema/warden.json
# Mine: Jev stays off until I have read the bill.
enabled: true # keep on
layers:
  jev: false # off on purpose
  llm: false
intervalMinutes: 5
`;
  const withInterval = (text: string, minutes: number): string =>
    text.replace('intervalMinutes: 5', `intervalMinutes: ${String(minutes)}`);

  const asking = (
    verdicts: Partial<Record<'fleet' | 'warden', GrantRefusal>> = {},
    governed = true,
  ): CallerGovernance =>
    ({
      governed,
      decide: demand => {
        const refusal = verdicts[demand.capability as 'fleet' | 'warden'] ?? 'granted';
        return { allowed: refusal === 'granted', refusal };
      },
    }) as CallerGovernance;
  const AT_THE_MACHINE = asking({}, false);
  const REMOTE = asking({}, true);
  const WITHOUT_WARDEN = asking({ warden: 'not-granted' }, true);

  interface Spent {
    count: number;
  }
  const callerFor = (
    governance: CallerGovernance | undefined,
    extra: { freshStepUp?: boolean; agent?: boolean } = {},
    spent: Spent = { count: 0 },
  ): ExecutorCaller => ({
    governance,
    freshStepUp: extra.freshStepUp === true,
    agent: extra.agent === true,
    spend: () => {
      spent.count += 1;
    },
  });

  /** This machine's configuration files, in memory: what `PUT /v1/config/file` would read and write. */
  function files(initial: Record<string, string>) {
    const held = new Map(Object.entries(initial));
    const writes: { path: string; text: string; ifMatch: string; mayLoosen: boolean }[] = [];
    const etag = (path: string): string => (held.has(path) ? `etag:${Bun.hash(held.get(path) as string)}` : 'absent');
    const state = { pending: false, invalid: false };
    const port: CloneConfigFiles = {
      file: async path => ({ exists: held.has(path), text: held.get(path) ?? '', etag: etag(path) }),
      effective: async () => ({
        warden: DEFAULT_WARDEN_CONFIG,
        learning: DEFAULT_LEARNING_CONFIG,
        voice: DEFAULT_VOICE_CONFIG,
      }),
      validate: async () =>
        state.invalid ? [{ severity: 'error' as const, message: 'caps.jevUsdPerDay: must be a number', line: 3 }] : [],
      write: async (path, text, ifMatch, mayLoosen) => {
        writes.push({ path, text, ifMatch, mayLoosen });
        if (ifMatch !== etag(path)) throw new ConfigFileConflictError(path);
        held.set(path, text);
        return { outcome: state.pending && !mayLoosen ? 'pending' : 'applied' };
      },
    };
    return { held, writes, port, state };
  }
  type Files = ReturnType<typeof files>;

  const sourceAt = async (content = 'Main.\n'): Promise<Record<string, unknown>> => {
    const source = world({
      catalog: { machineName: () => 'work-mac' },
      overrides: { daemonId: () => 'daemon-source' },
    });
    source.state.reading = configReading(SET_UP_MODEL(), 'r');
    source.state.assets[MAIN_DOCUMENT] = content;
    return (await source.service.exportBundle()) as unknown as Record<string, unknown>;
  };

  /** A target that already took its first copy from the source, with these configuration files. */
  const copied = async (own: Files): Promise<World> => {
    const first = world({ overrides: { daemonId: () => 'daemon-target' } });
    const alongside = { kind: 'clone.import', mode: 'alongside', bundle: await sourceAt() } as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;
    await first.service.executors.clone.describe(alongside);
    await first.service.executors.clone.execute(alongside);
    const documents = first.applied[0]?.documents ?? [];
    const target = world({ overrides: { daemonId: () => 'daemon-target', configFiles: own.port } });
    target.state.reading = configReading(modelOfWrites(documents), 'r');
    for (const document of documents) target.state.assets[document.path] = document.content;
    target.state.emails = async () => [];
    return target;
  };

  const request = (bundle: unknown, extra: Record<string, unknown> = {}) =>
    ({ kind: 'clone.import', mode: 'update', bundle, ...extra }) as Extract<
      FleetAccountChange,
      { kind: 'clone.import' }
    >;

  /** Review with the given settings, then apply with these decisions, as the catalogue's flow does. */
  async function apply(
    w: World,
    bundle: unknown,
    settings: { path: 'warden.yaml' | 'learning.yaml' | 'voice.yaml' | 'controls'; text: string }[],
    settingsDecisions: Record<string, Record<string, 'take' | 'keep'>> | undefined,
    caller: ExecutorCaller | undefined,
  ): Promise<string> {
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, caller?.governance);
    const change = request(bundle, {
      reviewed: review.fingerprint,
      decisions: {},
      settings,
      ...(settingsDecisions === undefined ? {} : { settingsDecisions }),
    });
    await w.service.executors.clone.describe(change, caller);
    return await w.service.executors.clone.execute(change, caller);
  }

  /** The machine settings as the batch's `machine.yaml` says them. */
  const machineOf = (documents: readonly FleetDocumentWrite[]) => {
    const document = documents.find(candidate => candidate.path.endsWith('/machine.yaml'));
    const checked = checkConfigFile('machine.yaml', document?.content ?? '');
    if (!checked.ok) throw new Error('machine.yaml does not check');
    return (checked.value as { machine: AccountModel['machine'] }).machine;
  };

  const recordOf = (w: World) =>
    parseCloneBase((w.applied.at(-1)?.documents ?? []).find(document => document.path === BASE_PATH)?.content);
  const settingsOf = (w: World, doc: string): Record<string, string> =>
    Object.values(recordOf(w).sources)[0]?.settings?.[doc as 'warden.yaml'] ?? {};

  it('should list the keys that differ, per file, and bind the review to them', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const items = await w.service.reviewClone({ bundle: bundle as never });
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, REMOTE);
    should(review.settings).deepEqual([
      {
        path: 'warden.yaml',
        keys: [{ key: 'intervalMinutes', outcome: 'both', mine: '5', theirs: '10' }],
      },
    ]);
    // Bound: the same items with other settings is another review.
    should(review.fingerprint).not.equal(items.fingerprint);
    const other = await w.service.reviewClone(
      { bundle: bundle as never, settings: [{ path: 'warden.yaml', text: withInterval(WARDEN, 12) }] },
      REMOTE,
    );
    should(other.fingerprint).not.equal(review.fingerprint);
  });

  it('should refuse a both-changed key until it has a choice, writing nothing', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const refusal = await catalogRefusal(
      apply(w, bundle, settings, undefined, callerFor(REMOTE)),
      'fleet_change_refused',
    );
    should(refusal.message).containEql('warden.yaml: intervalMinutes');
    should(own.writes).deepEqual([]);
    should(w.applied).deepEqual([]);
  });

  it('should write the merged file against the version it compared with, held for a remote caller and live at the machine', async () => {
    for (const [governance, mayLoosen] of [
      [REMOTE, false],
      [AT_THE_MACHINE, true],
    ] as const) {
      const own = files({ 'warden.yaml': WARDEN });
      const w = await copied(own);
      const bundle = await sourceAt();
      const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
      await apply(w, bundle, settings, { 'warden.yaml': { intervalMinutes: 'take' } }, callerFor(governance));
      should(own.writes).have.length(1);
      const [write] = own.writes;
      should(write?.mayLoosen).equal(mayLoosen);
      should(write?.ifMatch).equal(`etag:${String(Bun.hash(WARDEN))}`);
      // Exactly this machine's file with the one value changed: its comments and key order survive.
      should(write?.text).equal(withInterval(WARDEN, 10));
      // The record moves on in the copy's own batch: digests only, B := theirs.
      const digests = settingsOf(w, 'warden.yaml');
      should(Object.keys(digests).toSorted()).deepEqual(['enabled', 'intervalMinutes', 'layers.jev', 'layers.llm']);
      should(JSON.stringify(recordOf(w))).not.containEql('Jev stays off');
    }
  });

  it('should keep a key the person keeps, write nothing for it, and still file the source’s value as the base', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    await apply(w, bundle, settings, { 'warden.yaml': { intervalMinutes: 'keep' } }, callerFor(REMOTE));
    should(own.writes).deepEqual([]);
    should(own.held.get('warden.yaml')).equal(WARDEN);
    should(settingsOf(w, 'warden.yaml').intervalMinutes).equal(sha256Hex('10'));
    // Next time it is "changed here (kept)", not a conflict again.
    for (const document of w.applied[0]?.documents ?? []) w.state.assets[document.path] = document.content;
    const again = await w.service.reviewClone({ bundle: bundle as never, settings }, REMOTE);
    should(again.settings[0]?.keys.map(key => [key.key, key.outcome])).deepEqual([['intervalMinutes', 'mine']]);
  });

  it('should take a key changed only on the source by default, with nothing for the person to decide', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    // First copy: the person keeps theirs, which files the source's 5 as the base.
    await apply(w, bundle, [{ path: 'warden.yaml', text: WARDEN }], undefined, callerFor(REMOTE));
    for (const document of w.applied[0]?.documents ?? []) w.state.assets[document.path] = document.content;
    w.applied.length = 0;
    // The source then changes the value.
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 20) }];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, REMOTE);
    should(review.settings[0]?.keys).deepEqual([
      { key: 'intervalMinutes', outcome: 'theirs', choice: 'take', mine: '5', theirs: '20' },
    ]);
    await apply(w, bundle, settings, undefined, callerFor(REMOTE));
    should(own.writes.at(-1)?.text).equal(withInterval(WARDEN, 20));
  });

  it('should refuse a settings file the caller may not write, at review, at staging and at apply', async () => {
    const own = files({ 'warden.yaml': WARDEN, 'learning.yaml': 'enabled: true\n' });
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [
      { path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) },
      { path: 'learning.yaml' as const, text: 'enabled: false\n' },
    ];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, WITHOUT_WARDEN);
    should(review.settings.map(entry => [entry.path, entry.refused !== undefined, entry.keys.length])).deepEqual([
      ['warden.yaml', true, 0],
      ['learning.yaml', false, 1],
    ]);
    should(review.settings[0]?.refused).containEql('may not change warden.yaml');
    const change = request(bundle, {
      reviewed: review.fingerprint,
      decisions: {},
      settings,
      settingsDecisions: { 'warden.yaml': { intervalMinutes: 'take' }, 'learning.yaml': { enabled: 'take' } },
    });
    const staged = await catalogRefusal(
      w.service.executors.clone.describe(change, callerFor(WITHOUT_WARDEN)),
      'fleet_change_refused',
    );
    should(staged.message).containEql('may not change warden.yaml');
    await catalogRefusal(w.service.executors.clone.execute(change, callerFor(WITHOUT_WARDEN)), 'fleet_change_refused');
    // Not one file was written, not even the one this caller may write.
    should(own.writes).deepEqual([]);
    should(w.applied).deepEqual([]);
  });

  it('should refuse settings carried on a copy that is not a repeat copy, rather than ignore them', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const change = {
      kind: 'clone.import',
      mode: 'alongside',
      bundle,
      settings: [{ path: 'warden.yaml', text: withInterval(WARDEN, 10) }],
    } as unknown as Extract<FleetAccountChange, { kind: 'clone.import' }>;
    const refusal = await catalogRefusal(
      w.service.executors.clone.describe(change, callerFor(REMOTE)),
      'fleet_change_refused',
    );
    should(refusal.message).containEql('only when a copy is repeated');
    should(own.writes).deepEqual([]);
  });

  it('should refuse every settings file when the daemon cannot say what the caller may do', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, undefined);
    should(review.settings[0]?.refused).containEql('daemon bug');
    const change = request(bundle, { reviewed: review.fingerprint, decisions: {}, settings });
    await catalogRefusal(w.service.executors.clone.describe(change), 'fleet_change_refused');
    should(own.writes).deepEqual([]);
  });

  it('should let a device that needs a passkey stage the copy, and refuse the apply until it has one', async () => {
    const needsPasskey = asking({ warden: 'step-up-required' }, true);
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, needsPasskey);
    should(review.settings[0]?.refused).be.undefined();
    const change = request(bundle, {
      reviewed: review.fingerprint,
      decisions: {},
      settings,
      settingsDecisions: { 'warden.yaml': { intervalMinutes: 'take' } },
    });
    await w.service.executors.clone.describe(change, callerFor(needsPasskey));
    const refusal = await catalogRefusal(
      w.service.executors.clone.execute(change, callerFor(needsPasskey)),
      'fleet_change_refused',
    );
    should(refusal.message).containEql('needs a passkey');
    should(own.writes).deepEqual([]);
  });

  it('should refuse an apply whose file moved after the review', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, REMOTE);
    own.held.set('warden.yaml', withInterval(WARDEN, 7));
    const change = request(bundle, {
      reviewed: review.fingerprint,
      decisions: {},
      settings,
      settingsDecisions: { 'warden.yaml': { intervalMinutes: 'take' } },
    });
    const refusal = await catalogRefusal(
      w.service.executors.clone.describe(change, callerFor(REMOTE)),
      'fleet_change_refused',
    );
    should(refusal.message).equal('Something changed since you reviewed. Review again.');
    should(own.writes).deepEqual([]);
  });

  it('should refuse a merged file that would not check, before anything is written', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    own.state.invalid = true;
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const refusal = await catalogRefusal(
      apply(w, bundle, settings, { 'warden.yaml': { intervalMinutes: 'take' } }, callerFor(REMOTE)),
      'fleet_change_refused',
    );
    should(refusal.message).containEql('line 3: caps.jevUsdPerDay: must be a number');
    should(own.writes).deepEqual([]);
    should(w.applied).deepEqual([]);
  });

  it('should say a held write was held, and still record it', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    own.state.pending = true;
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'warden.yaml' as const, text: withInterval(WARDEN, 10) }];
    const summary = await apply(w, bundle, settings, { 'warden.yaml': { intervalMinutes: 'take' } }, callerFor(REMOTE));
    should(summary).containEql('1 settings file held until you confirm it');
    should(settingsOf(w, 'warden.yaml').intervalMinutes).equal(sha256Hex('10'));
  });

  it('should add a file this machine does not have as the source wrote it', async () => {
    const own = files({});
    const w = await copied(own);
    const bundle = await sourceAt();
    const settings = [{ path: 'voice.yaml' as const, text: 'postProcessing:\n  provider: off\n' }];
    const review = await w.service.reviewClone({ bundle: bundle as never, settings }, REMOTE);
    should(review.settings[0]).containEql({ path: 'voice.yaml', isNew: true });
    await apply(w, bundle, settings, undefined, callerFor(REMOTE));
    should(own.writes).have.length(1);
    should(own.writes[0]).containEql({ path: 'voice.yaml', ifMatch: 'absent', text: settings[0]?.text });
  });

  it('should refuse a settings file when this machine cannot merge settings, naming the file', async () => {
    const w = world();
    w.state.reading = configReading(SET_UP_MODEL(), 'r');
    const bundle = await sourceAt();
    const refusal = await setupRefusal(
      w.service.reviewClone({ bundle: bundle as never, settings: [{ path: 'warden.yaml', text: WARDEN }] }),
      'fleet_setup_refused',
    );
    should(refusal.message).containEql('warden.yaml');
  });

  describe('the controls', () => {
    const controls = (patch: object) => [
      {
        path: 'controls' as const,
        text: JSON.stringify({ agentPermissions: 'auto', agentControl: { files: true }, ...patch }),
      },
    ];

    it('should apply only the fields taken, in the copy’s own batch', async () => {
      const own = files({});
      const w = await copied(own);
      const bundle = await sourceAt();
      const settings = controls({ agentPermissions: 'skip', agentControl: { files: false, browsers: false } });
      const review = await w.service.reviewClone({ bundle: bundle as never, settings }, REMOTE);
      const keys = Object.fromEntries(review.settings[0]?.keys.map(key => [key.key, key.outcome]) ?? []);
      should(keys).deepEqual({
        agentPermissions: 'both',
        'agentControl.browsers': 'both',
        'agentControl.files': 'both',
      });
      await apply(
        w,
        bundle,
        settings,
        { controls: { 'agentControl.files': 'take', 'agentControl.browsers': 'keep', agentPermissions: 'keep' } },
        callerFor(REMOTE),
      );
      const machine = machineOf(w.applied[0]?.documents ?? []);
      should(machine.agentControl.files).equal(false);
      should(machine.agentControl.browsers).equal(true);
      should(machine.agentPermissions).equal('auto');
      should(own.writes).deepEqual([]);
      should(Object.keys(settingsOf(w, 'controls')).toSorted()).containEql('agentControl.files');
    });

    it('should need a passkey to turn what agents may control back on from a remote device, and keep the change to retry', async () => {
      const own = files({});
      const w = await copied(own);
      const bundle = await sourceAt();
      const settings = controls({ agentControl: { pageScripts: true } });
      const decisions = { controls: { 'agentControl.pageScripts': 'take' as const } };
      const spent: Spent = { count: 0 };
      const thrownError = await thrown(apply(w, bundle, settings, decisions, callerFor(REMOTE, {}, spent)));
      should(thrownError).be.instanceOf(FleetCatalogFreshStepUpRequired);
      should(w.applied).deepEqual([]);
      // With a passkey proved for the act it goes through, and the proof is spent once.
      await apply(w, bundle, settings, decisions, callerFor(REMOTE, { freshStepUp: true }, spent));
      should(spent.count).equal(1);
      should(machineOf(w.applied[0]?.documents ?? []).agentControl.pageScripts).equal(true);
    });

    it('should not ask at the machine, and never let a ferret widen', async () => {
      const own = files({});
      const w = await copied(own);
      const bundle = await sourceAt();
      const settings = controls({ agentControl: { pageScripts: true } });
      const decisions = { controls: { 'agentControl.pageScripts': 'take' as const } };
      await apply(w, bundle, settings, decisions, callerFor(AT_THE_MACHINE));
      should(w.applied).have.length(1);
      const ferret = await copied(files({}));
      const refused = await thrown(
        apply(ferret, bundle, settings, decisions, callerFor(AT_THE_MACHINE, { agent: true })),
      );
      should((refused as { status?: number }).status).equal(403);
      should(ferret.applied).deepEqual([]);
    });
  });

  it('should leave every login, sign-in and secret byte-identical, taking a setting or keeping it (account-model §14.4)', async () => {
    for (const choice of ['take', 'keep'] as const) {
      // Arrange: a signed-in login and a stored secret, and a warden file that names that secret.
      const text = `${WARDEN}investigation:\n  note: \${secret:JEV_API_KEY}\n`;
      const own = files({ 'warden.yaml': text });
      const w = await copied(own);
      w.secrets.set('JEV_API_KEY', 'sk-do-not-touch');
      const loginsBefore = JSON.stringify(w.state.reading.model.credentials);
      const bundle = await sourceAt();
      const settings = [
        { path: 'warden.yaml' as const, text: withInterval(text, 10) },
        { path: 'controls' as const, text: JSON.stringify({ agentControl: { files: false } }) },
      ];

      // Act
      await apply(
        w,
        bundle,
        settings,
        { 'warden.yaml': { intervalMinutes: choice }, controls: { 'agentControl.files': choice } },
        callerFor(AT_THE_MACHINE),
      );

      // Assert: the secret store, the logins and every credential document are exactly as they were.
      should([...w.secrets]).deepEqual([['JEV_API_KEY', 'sk-do-not-touch']]);
      const written = w.applied[0]?.documents ?? [];
      should(JSON.stringify(w.state.reading.model.credentials)).equal(loginsBefore);
      should(written.map(document => document.path).filter(path => /credential|\/logins\//u.test(path))).deepEqual([]);
      for (const write of own.writes) should(write.text).containEql('${secret:JEV_API_KEY}');
      should(configTextOf(written)).not.containEql('sk-do-not-touch');
    }
  });

  it('should not touch the clone’s own items when only settings are decided', async () => {
    const own = files({ 'warden.yaml': WARDEN });
    const w = await copied(own);
    const bundle = await sourceAt();
    await apply(
      w,
      bundle,
      [{ path: 'warden.yaml', text: withInterval(WARDEN, 10) }],
      { 'warden.yaml': { intervalMinutes: 'take' } },
      callerFor(REMOTE),
    );
    should((w.applied[0]?.documents ?? []).find(document => document.path === MAIN_COPY)).be.undefined();
  });
});

describe('createFleetSetupSubsystem', () => {
  it('should build the service the composition root mounts', () => {
    should(world().service).be.instanceOf(FleetSetupService);
  });
});
