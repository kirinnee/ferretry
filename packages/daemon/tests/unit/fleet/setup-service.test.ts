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
  builtInPresets,
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
  type FleetAccountChange,
  FleetCloneBundleSchema,
  type FleetCredentialView,
  FleetSetupScanSchema,
  FleetToolInstallResultSchema,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { type AccountDocumentReading, FleetCatalogRefusal } from '../../../src/lib/fleet/catalog-service.ts';
import {
  CLONE_BUNDLE_MAX_BYTES,
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
  };
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

describe('createFleetSetupSubsystem', () => {
  it('should build the service the composition root mounts', () => {
    should(world().service).be.instanceOf(FleetSetupService);
  });
});
