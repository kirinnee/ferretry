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
  FleetApplyFailureError,
  type FleetApplyPlan,
  type FleetDocumentWrite,
  type FleetLayout,
  parseAccountModel,
  RETIRED_FLEET_CONFIG_SENTENCE,
  RetiredFleetConfigError,
} from '@ferretry/fleet';
import {
  FleetAccountChangeOutcomeSchema,
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
  FleetCatalogRefusal,
  FleetCatalogService,
  type FleetCatalogServiceDeps,
  machineAuthority,
} from '../../../src/lib/fleet/catalog-service.ts';
import { FleetCredentialRefusal } from '../../../src/lib/fleet/credentials-service.ts';

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
    reading: { format: 'version-2', model: MODEL(), revision: 'rev-1' },
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
      '/state/fleet/config.yaml',
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
    should(applied[0]?.documents.map(document => document.expect)).deepEqual(['rev-1', 'absent']);
    should(applied[0]?.documents[0]?.content).match(/extra: *\n\s+file: components\/instructions\/extra\.md/u);
    should(again.code).equal('fleet_change_consumed');
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
