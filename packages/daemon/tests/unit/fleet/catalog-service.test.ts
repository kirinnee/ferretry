/**
 * The account model's catalogue service with every port faked: what the reads answer, and every
 * gate a change passes through between being staged and being applied.
 *
 * The plan is the fleet library's real `materialiseFleet`; only the provisioner, the files and the
 * credentials surface are stand-ins, so what a preview lists is what a real apply would be handed.
 */
import { describe, it } from 'bun:test';
import {
  type AccountModel,
  builtInModelCatalogs,
  builtInPresets,
  FleetApplyFailureError,
  type FleetApplyPlan,
  type FleetDocumentWrite,
  type FleetLayout,
  type FleetModelApplyPlan,
  parseAccountModel,
  RETIRED_FLEET_CONFIG_SENTENCE,
  RetiredFleetConfigError,
  type RuntimeIds,
} from '@ferretry/fleet';
import {
  FleetAccountChangeOutcomeSchema,
  type FleetCatalogInstallChange,
  FleetAccountChangeViewSchema,
  FleetComponentCatalogSchema,
  type FleetCredentialView,
  FleetLayeredProfileCatalogSchema,
  FleetMachineViewSchema,
  FleetRuntimeCatalogSchema,
  type SessionStatus,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { ApiError } from '../../../src/lib/api/error.ts';
import {
  type AccountDocumentReading,
  countRunningSessions,
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  FleetCatalogService,
  type FleetCatalogServiceDeps,
  harnessCommandsOf,
  machineAuthority,
  sameManifest,
} from '../../../src/lib/fleet/catalog-service.ts';
import { FleetCredentialRefusal } from '../../../src/lib/fleet/credentials-service.ts';
import { deriveAccountChange, FleetMutationRefusal } from '../../../src/lib/fleet/mutations.ts';
import { configReading } from '../../support/config-reading.ts';

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

const MODEL = (): AccountModel =>
  parseAccountModel({
    version: 2,
    machine: { agentPermissions: 'auto' },
    credentials: {
      'claude-you': { harness: 'claude', store: 'host' },
      'codex-slot': { harness: 'codex', store: 'ferretry' },
    },
    components: {
      instructions: { main: { file: 'components/instructions/main.md' } },
      mcp: { notes: { command: 'notes-server' } },
      skills: { mine: { items: ['review'] } },
      settings: {
        claude: { harness: 'claude', file: 'components/settings/claude.json' },
        broken: { harness: 'claude', file: 'components/settings/broken.json' },
        flagged: { harness: 'claude', flags: ['--verbose'] },
      },
      hooks: {
        watch: { harness: 'claude', file: 'components/hooks/watch.json' },
        tree: { harness: 'claude', directory: 'hooks/tree' },
      },
    },
    profiles: { default: { layers: ['instructions/main', 'mcp/notes', 'skills/mine', 'settings/claude'] } },
    runtimes: {
      'claude-default': { credential: 'claude-you', profile: 'default', agent: true },
      'codex-default': { credential: 'codex-slot', profile: 'default' },
    },
  });

const ASSETS: Readonly<Record<string, string>> = {
  '/state/fleet/assets/components/instructions/main.md': 'Main guidance.\n',
  '/state/fleet/assets/components/settings/claude.json': '{"theme":"dark"}',
  '/state/fleet/assets/components/settings/broken.json': '{not json',
  '/state/fleet/assets/components/hooks/watch.json': '{"hooks":{}}',
  '/state/fleet/assets/skills/review/SKILL.md': '---\nname: review\n---\n',
};

const credentialRow = (id: string, overrides: Partial<FleetCredentialView['signOut']> = {}): FleetCredentialView => ({
  id,
  harness: 'codex',
  store: 'ferretry',
  needsLabel: false,
  sharedWithTerminal: false,
  status: {
    word: 'needs_sign_in',
    label: 'Needs sign-in',
    reason: 'not_signed_in',
    explanation: 'Nobody has signed in to this login yet.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: {} },
  usedBy: ['codex-default'],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: {
    available: true,
    sentence: `Sign out of ${id}? 1 runtime will need sign-in.`,
    runtimesAffected: 1,
    signsOutTerminal: false,
    ...overrides,
  },
});

interface World {
  readonly service: FleetCatalogService;
  readonly applied: { plan: FleetApplyPlan; documents: readonly FleetDocumentWrite[] }[];
  readonly state: {
    reading: AccountDocumentReading;
    statuses: SessionStatus[];
    credentials: () => Promise<FleetCredentialView[]>;
    signOut: (id: string) => Promise<Awaited<ReturnType<FleetCatalogServiceDeps['credentials']['signOut']>>>;
    preview: (plan: FleetApplyPlan) => Promise<unknown>;
    apply: () => Promise<unknown>;
    documentError: unknown;
  };
}

function world(overrides: Partial<FleetCatalogServiceDeps> = {}): World {
  const applied: World['applied'] = [];
  let ids = 0;
  const state: World['state'] = {
    reading: configReading(MODEL(), 'rev-1'),
    statuses: ['running', 'completed', 'thinking'],
    credentials: async () => [credentialRow('codex-slot')],
    signOut: async id => ({ outcome: 'signed-out', credential: credentialRow(id) }),
    preview: async plan => ({ ...plan, sharedHistory: [] }),
    apply: async () => ({
      accountCount: 2,
      operationCount: 9,
      manifestPath: LAYOUT.manifestPath,
      prunedWrappers: [],
      sharedHistory: [],
    }),
    documentError: undefined,
  };
  const deps: FleetCatalogServiceDeps = {
    document: async () => {
      if (state.documentError !== undefined) throw state.documentError;
      return state.reading;
    },
    readAsset: async path => ASSETS[path],
    documentRevision: async path => (ASSETS[path] === undefined ? 'absent' : `digest:${path}`),
    ids: async () => undefined,
    locate: harness => (harness === 'claude' ? '/usr/bin/claude' : undefined),
    commandExists: () => false,
    sessionStatuses: async () => state.statuses,
    machineName: () => 'studio',
    credentials: {
      list: async () => ({ format: 2, machine: 'studio', credentials: await state.credentials() }),
      signOut: async id => await state.signOut(id),
    },
    provisioner: {
      preview: async plan =>
        (await state.preview(plan)) as Awaited<ReturnType<FleetCatalogServiceDeps['provisioner']['preview']>>,
      apply: async (plan, documents = []) => {
        applied.push({ plan, documents });
        return (await state.apply()) as Awaited<ReturnType<FleetCatalogServiceDeps['provisioner']['apply']>>;
      },
    },
    layout: LAYOUT,
    mint: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    mintId: () => `abcdefghijklmnopqrstu${ids++ % 10}`,
    now: () => Date.parse('2026-10-13T08:00:00.000Z'),
    claudeStatusline: () => "'fy' statusline",
    fyCommand: 'fy',
    acceptsAutoPermissionMode: true,
    ...overrides,
  };
  return { service: new FleetCatalogService(deps), applied, state };
}

const governance: CallerGovernance = {
  governed: true,
  decide: () => ({ allowed: true, refusal: 'granted' }),
} as never;

const refusal = async (work: Promise<unknown>, code: string): Promise<FleetCatalogRefusal> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(FleetCatalogRefusal);
  should((error as FleetCatalogRefusal).code).equal(code);
  return error as FleetCatalogRefusal;
};

const ADD_INSTRUCTIONS = {
  kind: 'component.put',
  name: 'extra',
  component: { kind: 'instructions' },
  content: 'Extra guidance.\n',
  create: true,
} as const;

describe('countRunningSessions', () => {
  it('should count every status a session can still be running in, and none it has ended in', () => {
    // Act
    const count = countRunningSessions(['created', 'awaiting_user', 'kill_failed', 'stopped', 'failed', 'stalled']);

    // Assert
    should(count).equal(2);
  });
});

describe('the catalogue reads', () => {
  it('should answer the machine with its tools, running sessions and what this caller may do', async () => {
    // Arrange
    const { service } = world();

    // Act
    const machine = FleetMachineViewSchema.parse(await service.machine(governance));

    // Assert
    should(machine.name).equal('studio');
    should(machine.format).equal('version-2');
    should(machine.runningSessions).equal(2);
    should(machine.authority).deepEqual({ mayApply: true, applyRefusal: 'granted' });
    should(machine.tools.map(tool => tool.installed)).deepEqual([true, false]);
  });

  it('should say a caller who has not stepped up may not apply, and carry the refusal', async () => {
    // Arrange
    const { service } = world();
    const unproved = {
      governed: true,
      decide: () => ({ allowed: false, refusal: 'step-up-required' }),
    } as never as CallerGovernance;

    // Act
    const view = await service.machine(unproved);

    // Assert
    should(view.authority).deepEqual({ mayApply: false, applyRefusal: 'step-up-required' });
  });

  it('should read the configure axis of fleet when it decides authority', () => {
    // Arrange
    const demands: unknown[] = [];
    const recording = {
      governed: true,
      decide: (demand: unknown) => {
        demands.push(demand);
        return { allowed: true, refusal: 'granted' };
      },
    } as never as CallerGovernance;

    // Act
    machineAuthority(recording);

    // Assert
    should(demands).deepEqual([{ capability: 'fleet', axis: 'configure' }]);
  });

  it('should never read an absent governance as an open Apply', async () => {
    // Arrange
    const { service } = world();

    // Act
    const [direct, viaMachine] = [machineAuthority(undefined), (await service.machine(undefined)).authority];

    // Assert
    should(direct).deepEqual({ mayApply: false, applyRefusal: 'undetermined' });
    should(viaMachine).deepEqual(direct);
  });

  it('should name each runtime by its ids.json id, and by its name before any apply published one', async () => {
    // Arrange
    const published = world({
      ids: async () => ({ version: 1, runtimes: { 'claude-default': { id: 'rt-claude-0001' } } }) as never,
    });
    const fresh = world();

    // Act
    const [withIds, withoutIds] = [await published.service.runtimes(), await fresh.service.runtimes()];

    // Assert
    should(withIds.runtimes.map(runtime => [runtime.id, runtime.wrapper])).deepEqual([
      ['rt-claude-0001', 'claude-default'],
      ['codex-default', 'codex-default'],
    ]);
    should(withoutIds.runtimes.map(runtime => runtime.id)).deepEqual(['claude-default', 'codex-default']);
  });

  it('should read component bodies so a missing MCP command is a warning, and skip a body that does not parse', async () => {
    // Arrange
    const { service } = world();

    // Act
    const catalog = FleetComponentCatalogSchema.parse(await service.components());
    const profiles = FleetLayeredProfileCatalogSchema.parse(await service.profiles());

    // Assert
    const mcp = catalog.kinds.find(group => group.kind === 'mcp');
    should(mcp?.components[0]?.warnings).deepEqual(['Command not found: notes-server']);
    should(profiles.profiles.map(profile => profile.name)).deepEqual(['default']);
  });

  it('should give each runtime its login status from the credentials surface, and none when that list fails', async () => {
    // Arrange
    const listed = world();
    const failing = world();
    failing.state.credentials = async () => {
      throw new Error('the store is damaged');
    };

    // Act
    const [withStatus, withoutStatus] = [
      FleetRuntimeCatalogSchema.parse(await listed.service.runtimes()),
      FleetRuntimeCatalogSchema.parse(await failing.service.runtimes()),
    ];

    // Assert
    const codex = withStatus.runtimes.find(runtime => runtime.name === 'codex-default');
    should(codex?.credential.status).equal('needs_sign_in');
    should(withoutStatus.runtimes.map(runtime => runtime.credential.status)).deepEqual([undefined, undefined]);
  });

  it('should refuse every read in words when the configuration cannot be read', async () => {
    // Arrange
    const { service, state } = world();
    state.documentError = new Error('bad indentation');

    // Act
    const error = await refusal(service.runtimes(), 'fleet_catalog_unreadable');

    // Assert
    should(error.message).equal("this machine's fleet configuration could not be read: bad indentation");
  });
  it('should surface a config.yaml in the retired format as unreadable, naming the sentence that says what to do', async () => {
    // Arrange
    const { service, state } = world();
    state.documentError = new RetiredFleetConfigError('/state/fleet/config.yaml');

    // Act
    const [machine, staged] = [
      await refusal(service.machine(governance), 'fleet_catalog_unreadable'),
      await refusal(service.propose(ADD_INSTRUCTIONS), 'fleet_catalog_unreadable'),
    ];

    // Assert — refused rather than converted, and nothing was staged against it.
    should(machine.message).equal(
      `this machine's fleet configuration could not be read: ${RETIRED_FLEET_CONFIG_SENTENCE('/state/fleet/config.yaml')}`,
    );
    should(staged.message).equal(machine.message);
  });
});

describe('staging a change', () => {
  it('should stage a new component with its file and the configuration, each expecting what it was composed against', async () => {
    // Arrange
    const { service } = world();

    // Act
    const view = FleetAccountChangeViewSchema.parse(await service.propose(ADD_INSTRUCTIONS));

    // Assert — the text is reported by size, never echoed back.
    should(view.change).deepEqual({
      kind: 'component.put',
      name: 'extra',
      component: { kind: 'instructions' },
      create: true,
    });
    should(view.summary).equal('Add instructions extra');
    should(view.state).equal('pending');
    should(view.revision).equal('rev-1');
    should(view.preview.kind).equal('apply');
    if (view.preview.kind !== 'apply') return;
    should(view.preview.documents.map(document => document.path)).deepEqual([
      '/state/config/components/instructions/extra.yaml',
      '/state/fleet/assets/components/instructions/extra.md',
    ]);
    should(view.preview.documents[1]?.bytes).equal(16);
    // Nothing uses the new component yet, so no runtime changes.
    should(view.preview.runtimes).deepEqual([]);
    should(view.preview.operations.length).be.above(0);
  });

  it('should list exactly the runtimes an edit lands on, with the E20 consequence', async () => {
    // Arrange
    const { service } = world();

    // Act
    const view = await service.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'New guidance.\n',
      create: false,
    });

    // Assert
    should(view.consequences).deepEqual([
      'Used by 1 profile and 2 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    ]);
    if (view.preview.kind !== 'apply') throw new Error('expected an apply preview');
    should(view.preview.runtimes.map(runtime => runtime.name)).deepEqual(['claude-default', 'codex-default']);
  });

  it('should carry a change that sends no text unchanged in its view', async () => {
    // Arrange
    const { service } = world();
    const change = {
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
    } as const;

    // Act
    const view = await service.propose(change);

    // Assert
    should(view.change).deepEqual(change);
    should(view.consequences).deepEqual([
      'Applies to new sessions. 2 running sessions keep the old mode (Auto mode) until restarted.',
    ]);
  });

  it("should refuse a change the derivation refuses, in the derivation's words", async () => {
    // Arrange
    const { service } = world();

    // Act
    const error = await refusal(service.propose({ kind: 'runtime.remove', name: 'nobody' }), 'fleet_change_refused');

    // Assert
    should(error.message).equal('no runtime nobody exists on this machine');
  });

  it('should refuse a change the provisioner will not preview, and let a non-error escape as itself', async () => {
    // Arrange
    const refused = world();
    refused.state.preview = async () => {
      throw new Error('refusing to write outside configured fleet roots: /elsewhere');
    };
    const odd = world();
    odd.state.preview = async () => {
      throw 'not an error';
    };

    // Act
    const error = await refusal(refused.service.propose(ADD_INSTRUCTIONS), 'fleet_change_refused');
    const thrown = await odd.service.propose(ADD_INSTRUCTIONS).then(
      () => undefined,
      (value: unknown) => value,
    );

    // Assert
    should(error.message).equal('refusing to write outside configured fleet roots: /elsewhere');
    should(thrown).equal('not an error');
  });

  it('should derive a login from a preset the machine offers, and refuse that preset on a machine offering none', async () => {
    // Arrange
    const change = {
      kind: 'credential.add',
      id: 'glm',
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
      },
    } as never;
    const offering = world({ presets: async () => builtInPresets() });
    const bare = world();

    // Act
    const staged = await offering.service.propose(change);
    const error = await refusal(bare.service.propose(change), 'fleet_change_refused');

    // Assert
    should(staged.summary).equal('Add a Claude Code login glm from GLM / Z.ai');
    should(error.message).equal('there is no preset zai-glm on studio');
  });

  it('should let a failure that is not a refusal escape the derivation as itself', async () => {
    // Arrange
    const failure = new Error('the machine name could not be read');
    const { service } = world({
      machineName: () => {
        throw failure;
      },
    });

    // Act
    const staged = await service.propose(ADD_INSTRUCTIONS).then(
      () => undefined,
      (value: unknown) => value,
    );

    // Assert — the error arrives as itself, never rewritten as a refusal.
    should(staged).equal(failure);
  });

  it('should let a failure that is not a proposal refusal escape staging as itself', async () => {
    // Arrange
    const failure = new Error('no id could be minted');
    const { service } = world({
      mintId: () => {
        throw failure;
      },
    });

    // Act
    const thrown = await service.propose(ADD_INSTRUCTIONS).then(
      () => undefined,
      (value: unknown) => value,
    );

    // Assert
    should(thrown).equal(failure);
  });

  it('should read a staged change back, and refuse an id it never staged', async () => {
    // Arrange
    const { service } = world();
    const staged = await service.propose(ADD_INSTRUCTIONS);

    // Act
    const read = await service.read(staged.id);
    const unknown = await refusal(service.read('fy_fprop_zzzzzzzzzzzzzzzzzzzzzz'), 'fleet_change_unknown');

    // Assert
    should(read).deepEqual(staged);
    should(unknown.message).match(/zzzz/u);
  });
});

describe('applying a change', () => {
  it('should refuse a caller nobody can place', async () => {
    // Arrange
    const { service } = world();
    const staged = await service.propose(ADD_INSTRUCTIONS);

    // Act
    const error = await service.apply(staged.id, undefined).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(ApiError);
    should((error as ApiError).status).equal(403);
  });

  it('should apply exactly the previewed plan and documents, once', async () => {
    // Arrange
    const { service, applied } = world();
    const staged = await service.propose(ADD_INSTRUCTIONS);

    // Act
    const outcome = FleetAccountChangeOutcomeSchema.parse(await service.apply(staged.id, governance));
    const again = await refusal(service.apply(staged.id, governance), 'fleet_change_consumed');

    // Assert
    should(outcome.outcome).equal('applied');
    should(applied).have.length(1);
    should(applied[0]?.documents.map(document => document.expect)).deepEqual(['absent', 'absent']);
    should(applied[0]?.documents[0]?.content).match(/^file: components\/instructions\/extra\.md$/mu);
    should(again.code).equal('fleet_change_consumed');
  });

  it('should write only the configuration files a change moves, removing the one it drops, each expecting the etag it read', async () => {
    // Arrange
    const { service, applied } = world();
    const staged = await service.propose({ kind: 'runtime.remove', name: 'codex-default' });

    // Act
    await service.apply(staged.id, governance);

    // Assert — the runtime's own file is removed; no other configuration file is touched.
    should(applied[0]?.documents.map(({ path, expect, remove }) => ({ path, expect, remove }))).deepEqual([
      { path: '/state/config/runtimes/codex-default.yaml', expect: 'etag:runtimes/codex-default.yaml', remove: true },
    ]);
  });

  it('should put a change back when the configuration moved after it was staged', async () => {
    // Arrange
    const { service, state, applied } = world();
    const staged = await service.propose(ADD_INSTRUCTIONS);

    // Act & Assert
    state.reading = { ...state.reading, revision: 'rev-2' };
    const stale = await refusal(service.apply(staged.id, governance), 'fleet_change_stale');
    should(stale.message).match(/changed on this machine after this change was previewed/u);
    should((await service.read(staged.id)).state).equal('pending');
    should(applied).have.length(0);
  });

  it('should report a failed apply as the outcome it was, and refuse one the provisioner refused outright', async () => {
    // Arrange
    const failed = world();
    failed.state.apply = async () => {
      throw new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'write /a', reason: 'disk full' });
    };
    const refused = world();
    refused.state.apply = async () => {
      throw new Error('refusing to write /state/fleet/config.yaml: it is not what this change was composed against');
    };
    const [one, two] = [
      await failed.service.propose(ADD_INSTRUCTIONS),
      await refused.service.propose(ADD_INSTRUCTIONS),
    ];

    // Act
    const outcome = await failed.service.apply(one.id, governance);
    const error = await refusal(refused.service.apply(two.id, governance), 'fleet_change_failed');

    // Assert
    should(outcome).deepEqual({
      outcome: 'applied',
      apply: { outcome: 'rolled-back', failedOperation: 'write /a', reason: 'disk full' },
    });
    should(error.message).match(/not what this change was composed against/u);
  });
});

describe('installing from a catalog', () => {
  const ORIGIN = {
    publisher: `fy_daemon_${'A'.repeat(43)}`,
    publisherName: 'kirin-box',
    catalogId: `cat_${'c'.repeat(22)}`,
    catalogName: "Kirin's catalog",
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'skill',
    name: 'pdf-tools',
    version: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  } as const;
  const SKILL_INSTALL: FleetCatalogInstallChange = {
    kind: 'catalog.install',
    name: 'pdf-tools',
    component: { kind: 'skills', items: ['pdf-tools'] },
    files: [
      { path: 'SKILL.md', content: '---\nname: pdf-tools\n---\n' },
      { path: 'scripts/split.sh', content: 'echo split\n' },
    ],
    profile: 'default',
    installedFrom: ORIGIN,
    replace: false,
  };

  it('should write the skill files in the documents the provisioner applies, in one call', async () => {
    // Arrange
    const { service, applied } = world();

    // Act
    const installed = await service.installCatalogItem(SKILL_INSTALL, governance);
    const outcome = FleetAccountChangeOutcomeSchema.parse(installed.outcome);

    // Assert
    should(outcome.outcome).equal('applied');
    should(installed.component).containEql({ installedFrom: ORIGIN });
    should(await service.storedComponent('skills', 'nothing-here')).be.undefined();
    should(applied).have.length(1);
    const written = new Map(applied[0]?.documents.map(document => [document.path, document.content]));
    should(written.get('/state/fleet/assets/skills/pdf-tools/SKILL.md')).equal('---\nname: pdf-tools\n---\n');
    should(written.get('/state/fleet/assets/skills/pdf-tools/scripts/split.sh')).equal('echo split\n');
  });

  it('should never put the install in the proposal store the public routes read', async () => {
    // Arrange
    const { service } = world();

    // Act
    await service.installCatalogItem(SKILL_INSTALL, governance);

    // Assert — nothing was staged, so there is nothing to read back or to apply by id.
    await refusal(service.read('fy_fprop_anything'), 'fleet_change_unknown');
  });

  it('should refuse a path that climbs out of the skill folder, even when called internally', async () => {
    // Arrange
    const { service, applied } = world();
    const escaping = { ...SKILL_INSTALL, files: [{ path: '../../../../config/x.yaml', content: 'x: 1\n' }] };

    // Act & Assert
    await refusal(service.installCatalogItem(escaping, governance), 'fleet_change_refused');
    should(applied).have.length(0);
  });

  it('should refuse a file whose resolved path leaves the skill folder, whatever spelling checks passed before', () => {
    // Arrange
    const model = MODEL();
    const facts = { machineName: 'box', runningSessions: 0, settingsBodies: {} };
    const attempt = (path: string) => () =>
      deriveAccountChange(model, { ...SKILL_INSTALL, files: [{ path, content: 'x' }] }, facts);

    // Act & Assert
    for (const path of ['../other/SKILL.md', 'a/../../b', '..', '']) should(attempt(path)).throw(FleetMutationRefusal);
    should(attempt('scripts/ok.sh')).not.throw();
  });

  it('should refuse an installedFrom that is not a verified provenance', async () => {
    // Arrange
    const { service } = world();
    const forged = {
      ...SKILL_INSTALL,
      installedFrom: { ...ORIGIN, digest: 'sha256:nope' },
    } as unknown as FleetCatalogInstallChange;

    // Act & Assert
    await refusal(service.installCatalogItem(forged, governance), 'fleet_change_refused');
  });

  it('should refuse an install nobody has said whether a caller may make', async () => {
    // Arrange
    const { service } = world();

    // Act & Assert
    const error = await service.installCatalogItem(SKILL_INSTALL, undefined).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    should(error).have.property('status', 403);
  });

  it('should refuse an install the configuration moved under', async () => {
    // Arrange
    const { service, state } = world();
    state.preview = async plan => {
      state.reading = { ...state.reading, revision: 'rev-2' };
      return { ...plan, sharedHistory: [] };
    };

    // Act & Assert
    await refusal(service.installCatalogItem(SKILL_INSTALL, governance), 'fleet_change_stale');
  });

  it('should report a skill install the provisioner rolled back as a failure, not a success', async () => {
    // Arrange
    const { service, state } = world();
    state.apply = async () => {
      throw new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'write /a', reason: 'disk full' });
    };

    // Act & Assert
    await refusal(service.installCatalogItem(SKILL_INSTALL, governance), 'fleet_change_failed');
  });

  it('should refuse an install of a name the setup already holds from elsewhere', async () => {
    // Arrange
    const { service } = world();

    // Act & Assert — `mine` is a skills component this machine wrote itself.
    await refusal(
      service.installCatalogItem(
        { ...SKILL_INSTALL, name: 'mine', component: { kind: 'skills', items: ['mine'] } },
        governance,
      ),
      'fleet_change_refused',
    );
  });
});

describe('signing a login out', () => {
  it("should stage it with the credentials surface's own sentence and run U13's executor on apply", async () => {
    // Arrange
    const { service } = world();

    // Act
    const view = FleetAccountChangeViewSchema.parse(
      await service.propose({ kind: 'credential.signout', id: 'codex-slot' }),
    );
    const outcome = await service.apply(view.id, governance);

    // Assert
    should(view.summary).equal('Sign out of login codex-slot');
    should(view.consequences).deepEqual(['Sign out of codex-slot? 1 runtime will need sign-in.']);
    should(view.preview).deepEqual({
      kind: 'sign-out',
      credential: 'codex-slot',
      runtimesAffected: 1,
      signsOutTerminal: false,
    });
    should(outcome.outcome).equal('signed-out');
  });

  it('should refuse a login it cannot list, cannot find, or may not sign out from here', async () => {
    // Arrange
    const failing = world();
    failing.state.credentials = async () => {
      throw new FleetCredentialRefusal('fleet_credentials_unreadable', 'the logins could not be listed');
    };
    const blocked = world();
    blocked.state.credentials = async () => [credentialRow('codex-slot', { available: false })];

    // Act
    const listing = await refusal(
      failing.service.propose({ kind: 'credential.signout', id: 'codex-slot' }),
      'fleet_change_refused',
    );
    const unknown = await refusal(
      blocked.service.propose({ kind: 'credential.signout', id: 'nobody' }),
      'fleet_change_refused',
    );
    const notHere = await refusal(
      blocked.service.propose({ kind: 'credential.signout', id: 'codex-slot' }),
      'fleet_change_refused',
    );

    // Assert
    should(listing.message).equal('the logins could not be listed');
    should(unknown.message).equal('no login nobody exists on this machine');
    should(notHere.message).equal('Login codex-slot cannot be signed out from here.');
  });

  it('should report a sign-out that failed, refuse one its executor refused, and let anything else escape', async () => {
    // Arrange
    const { service, state } = world();
    const stage = async () => (await service.propose({ kind: 'credential.signout', id: 'codex-slot' })).id;
    const failedId = await stage();
    const refusedId = await stage();
    const brokenId = await stage();

    // Act
    state.signOut = async id => ({
      outcome: 'failed',
      reason: 'the harness could not sign out',
      credential: credentialRow(id),
    });
    const failed = await service.apply(failedId, governance);
    state.signOut = async () => {
      throw new FleetCredentialRefusal('fleet_credential_unavailable', 'This login cannot be reached.');
    };
    const refused = await refusal(service.apply(refusedId, governance), 'fleet_change_failed');
    state.signOut = async () => {
      throw new TypeError('a bug');
    };
    const broken = await service.apply(brokenId, governance).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(failed).match({ outcome: 'sign-out-failed', reason: 'the harness could not sign out' });
    should(refused.message).equal('This login cannot be reached.');
    should(broken).be.instanceOf(TypeError);
  });
});

describe('first-run import and clone', () => {
  it('should refuse both while their executors are not available on this machine', async () => {
    // Arrange
    const { service } = world();

    // Act
    const setup = await refusal(service.propose({ kind: 'setup.import' }), 'fleet_change_refused');
    const clone = await refusal(
      service.propose({ kind: 'clone.import', mode: 'alongside', bundle: {} }),
      'fleet_change_refused',
    );

    // Assert
    should(setup.message).equal('Importing a setup is not available on this machine yet.');
    should(clone.message).equal('Cloning another machine is not available on this machine yet.');
  });

  it('should describe and then run the executor on exactly the change that was staged', async () => {
    // Arrange
    const ran: string[] = [];
    const { service } = world({
      executors: {
        setup: {
          describe: async () => 'Adds 2 runtimes.',
          execute: async change => {
            ran.push(change.kind);
            return 'Imported 2 runtimes';
          },
        },
        clone: {
          describe: async change => `Clones ${change.mode}.`,
          execute: async change => {
            ran.push(change.kind);
            return 'Cloned 1 runtime';
          },
        },
      },
    });

    // Act
    const setup = await service.propose({ kind: 'setup.import' });
    const clone = await service.propose({ kind: 'clone.import', mode: 'replace', bundle: {} });
    const outcomes = [await service.apply(setup.id, governance), await service.apply(clone.id, governance)];

    // Assert
    should(setup.preview).deepEqual({ kind: 'executor', executor: 'setup', description: 'Adds 2 runtimes.' });
    should(clone.summary).equal('Clone another machine’s setup');
    should(outcomes).deepEqual([
      { outcome: 'executed', executor: 'setup', summary: 'Imported 2 runtimes' },
      { outcome: 'executed', executor: 'clone', summary: 'Cloned 1 runtime' },
    ]);
    should(ran).deepEqual(['setup.import', 'clone.import']);
  });
});

describe('applying machine.settings that turns "what agents may control" back on (owner decision, T)', () => {
  const remote: CallerGovernance = { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) } as never;
  const loopback: CallerGovernance = {
    governed: false,
    decide: () => ({ allowed: true, refusal: 'granted' }),
  } as never;

  /** The model starts with `terminals` off, so a change can turn exactly that back on. */
  const offModel = (): AccountModel => ({
    ...MODEL(),
    machine: {
      ...MODEL().machine,
      agentControl: { terminals: false, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    },
  });

  const stageOff = async (service: FleetCatalogService, overrides: Partial<Record<string, boolean>> = {}) =>
    await service.propose({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: false, browsers: true, files: true, ...overrides },
    });

  const stageOn = async (service: FleetCatalogService, overrides: Partial<Record<string, boolean>> = {}) =>
    await service.propose({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true, ...overrides },
    });

  it('should apply turning a control OFF remotely with no step-up at all', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading({ ...MODEL(), machine: { ...MODEL().machine } }, 'rev-1');
    const staged = await stageOff(service);

    // Act
    const outcome = await service.apply(staged.id, remote);

    // Assert
    should(FleetAccountChangeOutcomeSchema.parse(outcome).outcome).equal('applied');
  });

  it('should refuse turning a control back ON remotely with no step-up, naming the act', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading(offModel(), 'rev-1');
    const staged = await stageOn(service);

    // Act
    const error = await service.apply(staged.id, remote).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(FleetCatalogFreshStepUpRequired);
    should((await service.read(staged.id)).state).equal('pending');
  });

  it('should refuse the same way with no freshStepUp context at all, never trusting an absent one', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading(offModel(), 'rev-1');
    const staged = await stageOn(service);

    // Act
    const error = await service.apply(staged.id, remote, undefined).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(FleetCatalogFreshStepUpRequired);
  });

  it('should allow turning a control back ON remotely with a fresh step-up, and spend it once', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading(offModel(), 'rev-1');
    const staged = await stageOn(service);
    let spent = 0;

    // Act
    const outcome = await service.apply(staged.id, remote, {
      presentation: { loopback: false, adminToken: false, actor: 'device:x', stepUp: true, freshStepUp: true },
      spend: () => {
        spent += 1;
      },
    });

    // Assert
    should(FleetAccountChangeOutcomeSchema.parse(outcome).outcome).equal('applied');
    should(spent).equal(1);
  });

  it('should refuse a reused or stale step-up on the next widening act', async () => {
    // Arrange — the first act spends the proof; a real StepUpRegistry would now answer `false`.
    const { service, state } = world();
    state.reading = configReading(offModel(), 'rev-1');
    const first = await stageOn(service);
    let fresh = true;
    const freshStepUp = {
      presentation: { loopback: false, adminToken: false, actor: 'device:x', stepUp: true, freshStepUp: fresh },
      spend: () => {
        fresh = false;
      },
    };
    await service.apply(first.id, remote, freshStepUp);

    // Act — the device's unlock is still live (`stepUp: true`), but its fresh proof was just spent.
    state.reading = configReading(offModel(), 'rev-1');
    const second = await stageOn(service);
    const error = await service
      .apply(second.id, remote, {
        presentation: { loopback: false, adminToken: false, actor: 'device:x', stepUp: true, freshStepUp: fresh },
        spend: () => {
          throw new Error('must not spend what was refused');
        },
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    // Assert
    should(error).be.instanceOf(FleetCatalogFreshStepUpRequired);
  });

  it('should let the machine itself turn a control back on with nothing extra', async () => {
    // Arrange
    const { service, state } = world();
    state.reading = configReading(offModel(), 'rev-1');
    const staged = await stageOn(service);

    // Act
    const outcome = await service.apply(staged.id, loopback);

    // Assert
    should(FleetAccountChangeOutcomeSchema.parse(outcome).outcome).equal('applied');
  });

  it('should need no step-up when a single write turns some controls on and the step-up covers it, but refuse without one', async () => {
    // Arrange — files on (narrowed to unchanged — already true) and terminals on (widened): the ON half rules.
    const { service, state } = world();
    state.reading = configReading(offModel(), 'rev-1');
    const staged = await service.propose({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: false, files: true },
    });

    // Act
    const error = await service.apply(staged.id, remote).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert — the ON half (terminals) demands the step-up even though browsers also moved OFF in the same write.
    should(error).be.instanceOf(FleetCatalogFreshStepUpRequired);
  });

  it('should count turning Ferretry settings on as a widening that needs a fresh step-up from a remote device', async () => {
    // Arrange — every other control already on; only the config tools move.
    const { service, state } = world();
    state.reading = configReading(MODEL(), 'rev-1');
    const staged = await stageOn(service, { ferretrySettings: true });

    // Act
    const error = await service.apply(staged.id, remote).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(FleetCatalogFreshStepUpRequired);
  });

  it('should not count a write that leaves Ferretry settings out as turning it on', async () => {
    // Arrange — a client that predates the switch sends only the three it knows.
    const { service, state } = world();
    state.reading = configReading(MODEL(), 'rev-1');
    const staged = await stageOff(service, { terminals: true });

    // Act
    const outcome = await service.apply(staged.id, remote);

    // Assert
    should(FleetAccountChangeOutcomeSchema.parse(outcome).outcome).equal('applied');
  });
});

describe('component content and the draft-profile preview', () => {
  it('should show each component file it read, and a check path against this machine’s home', async () => {
    // Arrange
    const { service } = world({
      readAsset: async path => (path.endsWith('watch.json') ? '{"hooks":{"run":"/home/other/bin/x"}}' : ASSETS[path]),
    });

    // Act
    const catalog = FleetComponentCatalogSchema.parse(await service.components());

    // Assert
    const named = (kind: string, name: string) =>
      catalog.kinds.find(group => group.kind === kind)?.components.find(component => component.name === name);
    should(named('hooks', 'watch')?.content).deepEqual({
      form: 'text',
      text: '{"hooks":{"run":"/home/other/bin/x"}}',
      redacted: false,
    });
    should(named('hooks', 'watch')?.checkPath).equal('/home/other/bin/x');
    should(named('settings', 'claude')?.content).deepEqual({
      form: 'entries',
      entries: [{ key: 'theme', value: 'dark' }],
    });
    should(named('instructions', 'main')?.content).deepEqual({
      form: 'text',
      text: 'Main guidance.\n',
      redacted: false,
    });
    should(named('settings', 'broken')).not.have.property('content');
  });

  it('should keep a hidden settings value from the file the component has when an edit sends entries', async () => {
    // Arrange
    const { service } = world({
      readAsset: async path =>
        path.endsWith('claude.json') ? '{"env":{"API_TOKEN":"sk-abcdefghijklmnop"}}' : ASSETS[path],
    });

    // Act
    const view = await service.propose({
      kind: 'component.put',
      name: 'claude',
      component: { kind: 'settings', harness: 'claude', entries: { 'env.API_TOKEN': { keep: true } } },
      create: false,
    });

    // Assert
    should(view.preview.kind).equal('apply');
    should(JSON.stringify(view)).not.containEql('sk-abcdefghijklmnop');
  });

  it('should resolve a draft profile without staging anything, and refuse when the configuration cannot be read', async () => {
    // Arrange
    const { service, state } = world();

    // Act
    const draft = await service.previewProfile({ layers: ['instructions/main', 'mcp/ghost'] });
    state.documentError = new Error('disk gone');
    const unreadable = refusal(service.previewProfile({ layers: [] }), 'fleet_catalog_unreadable');

    // Assert
    should(draft.refusal).equal('no MCP server ghost exists on this machine');
    should(draft.harnesses.map(stack => stack.harness)).deepEqual(['claude', 'codex']);
    await unreadable;
  });
});

describe('FleetCatalogService with model catalogs (docs/model-catalog.md)', () => {
  const sources = async () => ({ catalogs: builtInModelCatalogs(), presets: builtInPresets() });

  it("should list each runtime's catalog models, by tier, beside its model set", async () => {
    // Arrange
    const { service } = world({ modelCatalogs: sources });

    // Act
    const catalog = FleetRuntimeCatalogSchema.parse(await service.runtimes());

    // Assert — a Claude sign-in reads Anthropic's catalog, a Codex sign-in OpenAI's
    const claude = catalog.runtimes.find(runtime => runtime.name === 'claude-default');
    should(claude?.models?.catalog).containDeep({ id: 'anthropic', origin: 'built-in', customIds: false });
    should(claude?.models?.choices.map(choice => choice.tier)).deepEqual(['best', 'balanced', 'fast']);
    should(claude?.models?.default).equal('claude-opus-5-5');
    should(catalog.runtimes.find(runtime => runtime.name === 'codex-default')?.models?.default).equal('gpt-6.1-sol');
  });

  it('should show no catalog models on a machine wired without catalogs', async () => {
    const catalog = FleetRuntimeCatalogSchema.parse(await world().service.runtimes());
    should(catalog.runtimes.every(runtime => runtime.models === undefined)).be.true();
  });

  it('should republish when the manifest would read differently, and leave an identical one alone', async () => {
    // Arrange
    let published: unknown;
    let ids: RuntimeIds | undefined;
    const { service, applied } = world({
      modelCatalogs: sources,
      publishedManifest: async () => published,
      ids: async () => ids,
    });

    // Act — nothing is published yet, so the first republish applies
    const first = await service.republish();
    published = applied[0]?.plan.manifest;
    ids = (applied[0]?.plan as FleetModelApplyPlan | undefined)?.ids;
    const second = await service.republish();

    // Assert — no configuration file is written by either
    should(first).equal('applied');
    should(applied[0]?.documents).deepEqual([]);
    should(second).equal('unchanged');
    should(applied).have.length(1);
  });

  it('should name the earliest disabled-until still ahead, across logins and runtimes', async () => {
    // Arrange
    const withBlocks = parseAccountModel({
      ...MODEL(),
      credentials: {
        'claude-you': { harness: 'claude', store: 'host', disabled: { until: '2099-12-01' } },
        'codex-slot': { harness: 'codex', store: 'ferretry' },
      },
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default', agent: true },
        'codex-default': { credential: 'codex-slot', profile: 'default', disabled: { until: '2099-11-01' } },
      },
    });
    const { service, state } = world();
    state.reading = configReading(withBlocks, 'rev-1', 'version-2');

    // Act / Assert
    should(await service.nextDisableExpiry()).equal(Date.parse('2099-11-01T00:00:00Z'));
    state.reading = configReading(MODEL(), 'rev-1', 'version-2');
    should(await service.nextDisableExpiry()).be.undefined();
  });

  it('should skip a machine with no fleet, or one wired without catalogs', async () => {
    // Arrange
    const empty = world({ modelCatalogs: sources });
    empty.state.reading = configReading(MODEL(), 'rev-1', 'none');

    // Act / Assert
    should(await empty.service.republish()).equal('skipped');
    should(await world().service.republish()).equal('skipped');
  });

  it('should refuse a republish whose plan cannot be made, or whose apply fails', async () => {
    // Arrange — two runtimes cannot share one config directory, so that fleet cannot be planned
    const home = (id: string) => ({ id, formerNames: [], home: 'shared' });
    const broken = world({
      modelCatalogs: sources,
      ids: async () => ({
        version: 1,
        runtimes: {
          'claude-default': home('00000000-0000-4000-8000-0000000000a1'),
          'codex-default': home('00000000-0000-4000-8000-0000000000a2'),
        },
      }),
    });
    const failing = world({ modelCatalogs: sources });
    failing.state.apply = async () => {
      throw new Error('disk full');
    };

    // Act / Assert
    const refused = await broken.service.republish().catch((error: unknown) => error);
    const failed = await failing.service.republish().catch((error: unknown) => error);
    should(refused).be.instanceOf(FleetCatalogRefusal).and.have.property('code', 'fleet_change_refused');
    should(failed).be.instanceOf(FleetCatalogRefusal).and.have.property('code', 'fleet_change_failed');
  });

  it('should tell a planned manifest from the published one only by what it says', () => {
    should(sameManifest({ generatedAt: 'a', version: 1 } as never, { generatedAt: 'b', version: 1 })).be.true();
    should(sameManifest({ generatedAt: 'a', version: 1 } as never, { generatedAt: 'a', version: 2 })).be.false();
    should(sameManifest({ generatedAt: 'a' }, undefined)).be.false();
    should(sameManifest({ generatedAt: 'a' }, 'text')).be.false();
  });
});

describe('the harness path a wrapper execs', () => {
  const sources = async () => ({ catalogs: builtInModelCatalogs(), presets: builtInPresets() });

  it('should hand the located harnesses to the plan, and leave an unlocated one to its name', () => {
    // Act
    const both = harnessCommandsOf(harness => `/opt/h/${harness}`);
    const onlyCodex = harnessCommandsOf(harness => (harness === 'codex' ? '/opt/h/codex' : undefined));
    const none = harnessCommandsOf(() => undefined);

    // Assert
    should(both).deepEqual({ claude: '/opt/h/claude', codex: '/opt/h/codex' });
    should(onlyCodex).deepEqual({ codex: '/opt/h/codex' });
    should(none).deepEqual({});
  });

  it('should write wrappers that exec the located path, and rewrite them when only that path moved', async () => {
    // Arrange
    let published: unknown;
    let ids: RuntimeIds | undefined;
    let current = true;
    const { service, applied } = world({
      modelCatalogs: sources,
      publishedManifest: async () => published,
      ids: async () => ids,
      wrappersCurrent: async () => current,
    });

    // Act
    const first = await service.republish();
    published = applied[0]?.plan.manifest;
    ids = (applied[0]?.plan as FleetModelApplyPlan | undefined)?.ids;
    const unchanged = await service.republish();
    current = false;
    const moved = await service.republish();

    // Assert
    const wrapper = applied[0]?.plan.operations.find(
      operation => operation.kind === 'file' && operation.path.endsWith('claude-default'),
    );
    should(wrapper)
      .have.property('content')
      .match(/\nexec '\/usr\/bin\/claude' /u);
    should([first, unchanged, moved]).deepEqual(['applied', 'unchanged', 'applied']);
    should(applied).have.length(2);
  });
});

describe('renaming and removing a runtime', () => {
  const ID = '00000000-0000-4000-8000-0000000000aa';
  const IDS = async (): Promise<RuntimeIds> => ({
    version: 1,
    runtimes: {
      'claude-default': { id: ID, formerNames: ['claude-auto'] },
      'codex-default': { id: '00000000-0000-4000-8000-0000000000bb', formerNames: [] },
    },
  });
  const RECORDS: FleetCatalogServiceDeps['sessionRecords'] = async () => [
    { id: 's-2', name: 'Otter', harness: 'claude', agent: 'claude-default', status: 'running' },
    { id: 's-1', name: 'Fisher', harness: 'claude', agent: 'claude-auto', status: 'thinking' },
    {
      id: 's-3',
      name: 'Badger',
      harness: 'claude',
      agent: 'other',
      executable: '/state/fleet/bin/claude-default',
      status: 'awaiting_user',
    },
    { id: 's-4', name: 'Done', harness: 'claude', agent: 'claude-default', status: 'completed' },
    { id: 's-5', name: 'Elsewhere', harness: 'codex', agent: 'codex-default', status: 'running' },
  ];

  it('should move the runtime’s id, its file and its wrapper to the new name, and list who runs on it', async () => {
    // Arrange
    const { service } = world({ ids: IDS, sessionRecords: RECORDS });

    // Act
    const staged = FleetAccountChangeViewSchema.parse(
      await service.propose({ kind: 'runtime.rename', name: 'claude-default', to: 'claude-main' }),
    );

    // Assert
    should(staged.summary).equal('Rename runtime claude-default to claude-main');
    should(staged.consequences).containEql('Running ferrets keep working — nothing restarts.');
    const preview = staged.preview as Extract<typeof staged.preview, { kind: 'apply' }>;
    should(preview.documents.map(document => document.path)).deepEqual([
      '/state/config/runtimes/claude-main.yaml',
      '/state/config/runtimes/claude-default.yaml',
    ]);
    should(preview.runningSessions).deepEqual([
      { id: 's-3', name: 'Badger', harness: 'claude' },
      { id: 's-1', name: 'Fisher', harness: 'claude' },
      { id: 's-2', name: 'Otter', harness: 'claude' },
    ]);
  });

  it('should write ids.json with the same id under the new name and the old one kept as a former name', async () => {
    // Arrange
    const { service, applied } = world({ ids: IDS });
    const staged = await service.propose({ kind: 'runtime.rename', name: 'claude-default', to: 'claude-main' });

    // Act
    await service.apply(staged.id, governance);

    // Assert
    const plan = applied[0]?.plan as FleetModelApplyPlan;
    const idsFile = plan.operations.find(
      operation => operation.kind === 'file' && operation.path === '/state/fleet/ids.json',
    ) as { content: string };
    should(JSON.parse(idsFile.content).runtimes['claude-main']).deepEqual({
      id: ID,
      formerNames: ['claude-auto', 'claude-default'],
    });
    should(applied[0]?.plan.operations.some(operation => operation.path === '/state/fleet/bin/claude-main')).be.true();
  });

  it('should re-point the session records once the rename applied, and still report it applied if that fails', async () => {
    // Arrange
    const renames: unknown[] = [];
    const recording = world({
      ids: IDS,
      renameSessions: async rename => {
        renames.push(rename);
        return 2;
      },
    });
    const failing = world({
      ids: IDS,
      renameSessions: async () => {
        throw new Error('a record could not be read');
      },
    });
    const change = { kind: 'runtime.rename', name: 'claude-default', to: 'claude-main' } as const;

    // Act
    const outcome = await recording.service.apply((await recording.service.propose(change)).id, governance);
    const despite = await failing.service.apply((await failing.service.propose(change)).id, governance);

    // Assert
    should(outcome.outcome).equal('applied');
    should(despite.outcome).equal('applied');
    should(renames).deepEqual([
      {
        from: 'claude-default',
        to: 'claude-main',
        fromWrapper: '/state/fleet/bin/claude-default',
        toWrapper: '/state/fleet/bin/claude-main',
      },
    ]);
  });

  it('should not re-point any session when the apply rolled back', async () => {
    // Arrange
    const renames: unknown[] = [];
    const { service, state } = world({
      ids: IDS,
      renameSessions: async rename => {
        renames.push(rename);
        return 0;
      },
    });
    state.apply = async () => {
      throw new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'write /a', reason: 'disk full' });
    };
    const staged = await service.propose({ kind: 'runtime.rename', name: 'claude-default', to: 'claude-main' });

    // Act
    await service.apply(staged.id, governance);

    // Assert
    should(renames).deepEqual([]);
  });

  it('should refuse a new name that is another runtime’s former name', async () => {
    // Arrange
    const { service } = world({ ids: IDS });

    // Act & Assert
    const refused = await refusal(
      service.propose({ kind: 'runtime.rename', name: 'codex-default', to: 'claude-auto' }),
      'fleet_change_refused',
    );
    should(refused.message).equal('claude-auto is already a runtime on studio. Use claude-auto-2?');
  });

  it('should refuse a change when ids.json cannot be read', async () => {
    // Arrange
    const { service } = world({
      ids: async () => {
        throw new Error('ids.json is not JSON');
      },
    });

    // Act & Assert
    const refused = await refusal(
      service.propose({ kind: 'runtime.rename', name: 'claude-default', to: 'claude-main' }),
      'fleet_change_refused',
    );
    should(refused.message).equal('the runtime ids could not be read: ids.json is not JSON');
  });

  it('should list who runs on a runtime being removed, and fall back to the general sentence when it cannot tell', async () => {
    // Arrange
    const known = world({ ids: IDS, sessionRecords: RECORDS });
    const unknown = world({
      ids: IDS,
      sessionRecords: async () => {
        throw new Error('storage closed');
      },
    });
    const change = { kind: 'runtime.remove', name: 'codex-default' } as const;

    // Act
    const [listed, general] = [
      FleetAccountChangeViewSchema.parse(await known.service.propose(change)),
      FleetAccountChangeViewSchema.parse(await unknown.service.propose(change)),
    ];

    // Assert
    should(listed.consequences).deepEqual([
      '1 ferret is running on it. It keeps running, but restarting it later needs another runtime. Its past sessions stay in history.',
    ]);
    should((listed.preview as { runningSessions?: unknown }).runningSessions).deepEqual([
      { id: 's-5', name: 'Elsewhere', harness: 'codex' },
    ]);
    should(general.consequences).deepEqual([
      'Running sessions of it keep going until they end. Its past sessions stay in history.',
    ]);
    should((general.preview as { runningSessions?: unknown }).runningSessions).be.undefined();
  });
});

describe('removing a login that runtimes use', () => {
  const withSpare = (): AccountModel => {
    const model = MODEL();
    return parseAccountModel({
      ...model,
      credentials: { ...model.credentials, 'codex-spare': { harness: 'codex', store: 'ferretry' } },
    });
  };
  const records: FleetCatalogServiceDeps['sessionRecords'] = async () => [
    { id: 's-5', name: 'Elsewhere', harness: 'codex', agent: 'codex-default', status: 'running' },
    { id: 's-6', name: 'Quiet', harness: 'codex', agent: 'codex-default', status: 'completed' },
  ];
  const ids = async (): Promise<RuntimeIds> => ({
    version: 1,
    runtimes: { 'codex-default': { id: '00000000-0000-4000-8000-0000000000bb', formerNames: [] } },
  });

  it('should stage a switch in one plan and say which ferrets keep running', async () => {
    // Arrange
    const { service, state } = world({ ids, sessionRecords: records });
    state.reading = configReading(withSpare(), 'rev-1');

    // Act
    const staged = FleetAccountChangeViewSchema.parse(
      await service.propose({
        kind: 'credential.remove',
        id: 'codex-slot',
        switchRuntimes: { 'codex-default': 'codex-spare' },
      }),
    );

    // Assert
    should(staged.summary).equal('Remove login codex-slot, switching 1 runtime to codex-spare');
    const preview = staged.preview as Extract<typeof staged.preview, { kind: 'apply' }>;
    should(preview.runningSessions).deepEqual([
      { id: 's-5', name: 'Elsewhere', harness: 'codex', runtime: 'codex-default' },
    ]);
    should(preview.orphanedSecrets).be.undefined();
  });

  it('should refuse while a runtime is left on the login', async () => {
    // Arrange
    const { service, state } = world({ ids });
    state.reading = configReading(withSpare(), 'rev-1');

    // Act
    const refused = await refusal(
      service.propose({ kind: 'credential.remove', id: 'codex-slot', switchRuntimes: {} }),
      'fleet_change_refused',
    );

    // Assert
    should(refused.message).containEql('still uses this login (codex-default)');
  });
});
