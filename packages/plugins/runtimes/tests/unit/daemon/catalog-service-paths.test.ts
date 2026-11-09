/**
 * `FleetCatalogService` paths the pipeline and login suites do not drive: the reads over real component files, the
 * republish, the catalog install, the executors, the runtime facts a removal reads and the ways an apply ends.
 *
 * The service is built over fakes of its ports (the document, the assets, the provisioner), so every assertion is on
 * what the service returns, throws or hands to a port.
 */
import { describe, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import type { AccountChange, CatalogInstallChange } from '../../../contract/index.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { RuntimeIds } from '../../../daemon/lib/account/ids.ts';
import { unavailableCatalogDeps } from '../../../daemon/lib/service/assembly.ts';
import {
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  FleetCatalogService,
  type FleetCatalogServiceDeps,
} from '../../../daemon/lib/service/catalog-service.ts';
import { FleetApplyFailureError, type FleetApplyCommittedState } from '../../../daemon/lib/provisioning.ts';
import type { RuntimeSessionRecord } from '../../../daemon/lib/service/runtime-sessions.ts';

const NOW = 1_794_052_800_000;

const DOCUMENT = {
  version: 1,
  credentials: {
    'claude-you': { harness: 'claude', store: 'host', disabled: { reason: 'away', until: '2030-01-01' } },
    'claude-two': { harness: 'claude', store: 'ferretry' },
  },
  components: {
    instructions: { notes: { file: 'components/instructions/notes.md' }, absent: { file: 'components/missing.md' } },
    mcp: { srv: { command: 'srv-bin', args: ['--x'] } },
    skills: { sk: { items: ['sk'] }, none: { items: ['ghost'] } },
    settings: {
      'cl-settings': { harness: 'claude', file: 'components/settings/cl-settings.json' },
      'bad-settings': { harness: 'claude', file: 'components/settings/bad-settings.json' },
      'cx-settings': { harness: 'codex', file: 'components/settings/cx-settings.toml' },
      'env-only': { harness: 'claude', env: { KEPT: 'yes' } },
    },
    hooks: {
      'cl-hooks': { harness: 'claude', file: 'components/hooks/cl-hooks.json' },
      'bad-hooks': { harness: 'claude', file: 'components/hooks/bad-hooks.json' },
      'dir-hooks': { harness: 'claude', directory: 'components/hooks/dir-hooks' },
    },
  },
  profiles: {
    default: {
      layers: [
        'instructions/notes',
        'mcp/srv',
        'skills/sk',
        'settings/cl-settings',
        'settings/env-only',
        'hooks/cl-hooks',
        'hooks/dir-hooks',
      ],
    },
  },
  runtimes: {
    'claude-default': { credential: 'claude-you', profile: 'default', agent: true },
    second: {
      credential: 'claude-two',
      profile: 'default',
      agent: true,
      disabled: { reason: 'later', until: '2029-01-01' },
    },
  },
} as const;

const MODEL = parseAccountModel(DOCUMENT);

const ASSETS: Readonly<Record<string, string>> = {
  'components/instructions/notes.md': '# notes',
  'components/settings/cl-settings.json': '{"theme":"dark"}',
  'components/settings/bad-settings.json': '{ not json',
  'components/settings/cx-settings.toml': 'model = "x"',
  'components/hooks/cl-hooks.json': '{"hooks":{}}',
  'components/hooks/bad-hooks.json': '{ not json',
};

const LAYOUT = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: { claude: '/home/person/.claude', codex: '/home/person/.codex' },
} as const;

const OWNER = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) };

const MANIFEST_SHAPE = { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [], runtimes: [] } as const;

const COMMITTED: FleetApplyCommittedState = {
  accountCount: 1,
  operationCount: 2,
  manifestPath: '/fy/fleet/manifest.json',
  manifest: MANIFEST_SHAPE,
  prunedWrappers: [],
  sharedHistory: [],
};

interface Options {
  readonly format?: 'none' | 'present';
  readonly apply?: NonNullable<FleetCatalogServiceDeps['provisioner']['apply']>;
  readonly preview?: FleetCatalogServiceDeps['provisioner']['preview'];
  readonly overrides?: Partial<FleetCatalogServiceDeps>;
}

function world(options: Options = {}) {
  const applied: { operations: number }[] = [];
  const logins = fakeLogins([sampleLogin('claude-you')]);
  const changes = fakeLoginChanges();
  const base = unavailableCatalogDeps(() => NOW, logins, changes);
  const deps: FleetCatalogServiceDeps = {
    ...base,
    document: async () => ({
      format: options.format ?? 'present',
      model: MODEL,
      revision: 'rev-1',
      documents: () => [
        { path: '/fy/config/runtimes/claude-default.yaml', content: '# moved\n', mode: 0o600, expect: 'absent' },
      ],
    }),
    readAsset: async path => ASSETS[path.replace('/fy/fleet/assets/', '')],
    documentRevision: async () => 'absent',
    ids: async () => undefined,
    locate: () => '/usr/bin/claude',
    credentials: logins,
    loginChanges: changes,
    configWriter: { write: async () => undefined },
    layout: LAYOUT,
    claudeStatusline: () => "'fy' statusline",
    fyCommand: '/opt/ferretry/bin/fy',
    provisioner: {
      preview: options.preview ?? (async plan => ({ ...plan, sharedHistory: [] })),
      apply:
        options.apply ??
        (async plan => {
          applied.push({ operations: plan.operations.length });
          return {
            accountCount: plan.manifest.accounts.length,
            operationCount: plan.operations.length,
            manifestPath: '/fy/fleet/manifest.json',
            prunedWrappers: [],
            sharedHistory: [],
          };
        }),
    },
    ...options.overrides,
  };
  return { service: new FleetCatalogService(deps), deps, applied, logins, changes };
}

const rejection = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (error: unknown) => error,
  );

const RENAME: AccountChange = { kind: 'runtime.rename', name: 'second', to: 'renamed' };
const REMOVE: AccountChange = { kind: 'runtime.remove', name: 'second' };

describe('the reads, over a machine whose components are real files', () => {
  it('should say what this caller may do to the machine, and refuse by default when it cannot tell who is asking', async () => {
    const { service } = world();
    const unknown = await service.machine(undefined);
    should(unknown.authority).eql({ mayApply: false, applyRefusal: 'undetermined' });
    const owner = await service.machine(OWNER);
    should(owner.authority).eql({ mayApply: true, applyRefusal: 'granted' });
    const stepUp = await service.machine({
      governed: true,
      decide: () => ({ allowed: false, refusal: 'step-up-required' as const }),
    });
    should(stepUp.authority).eql({ mayApply: false, applyRefusal: 'step-up-required' });
  });

  it('should list the components, the profiles and the runtimes from the files in effect', async () => {
    const { service } = world();
    const components = await service.components();
    should(components.kinds.map(group => group.kind))
      .containEql('instructions')
      .and.containEql('settings');
    const profiles = await service.profiles();
    should(profiles.profiles.map(profile => profile.name)).eql(['default']);
    const runtimes = await service.runtimes();
    should(runtimes.runtimes.map(runtime => runtime.name).toSorted()).eql(['claude-default', 'second']);
  });

  it('should read a component that is not a file at all as missing, and an unparseable one as nothing', async () => {
    const reads: string[] = [];
    const { service } = world({
      overrides: {
        readAsset: async path => {
          reads.push(path);
          return ASSETS[path.replace('/fy/fleet/assets/', '')];
        },
      },
    });
    await service.components();
    should(reads).containEql('/fy/fleet/assets/components/settings/bad-settings.json');
    should(reads).containEql('/fy/fleet/assets/components/hooks/bad-hooks.json');
    should(reads.some(path => path.endsWith('SKILL.md'))).be.true();
  });

  it('should report the earliest moment a switched-off login or runtime comes back on', async () => {
    const { service } = world();
    should(await service.nextDisableExpiry()).equal(Date.parse('2029-01-01'));
  });

  it('should show a status word for no login when the credentials list fails', async () => {
    const { service } = world({
      overrides: {
        credentials: {
          list: async () => {
            throw new Error('logins are away');
          },
        },
      },
    });
    const runtimes = await service.runtimes();
    should(runtimes.runtimes).have.length(2);
  });

  it('should refuse a read in a sentence when the configuration cannot be read', async () => {
    const { service } = world({
      overrides: {
        document: async () => {
          throw new Error('disk gone');
        },
      },
    });
    const failure = await rejection(service.components());
    should(failure).be.instanceOf(FleetCatalogRefusal);
    should((failure as FleetCatalogRefusal).code).equal('fleet_catalog_unreadable');
    should((failure as FleetCatalogRefusal).message).containEql('disk gone');
  });

  it('should show a profile draft resolved over the files in effect, writing nothing', async () => {
    const { service, applied } = world();
    const draft = await service.previewProfile({ layers: ['instructions/notes'], editing: 'default' });
    should(draft.harnesses.map(entry => entry.harness)).eql(['claude-code', 'codex']);
    should(draft.refusal).be.undefined();
    should(applied).have.length(0);
  });

  it('should read one component exactly as the daemon holds it', async () => {
    const { service } = world();
    should(await service.storedComponent('mcp', 'srv')).containEql({ command: 'srv-bin' });
    should(await service.storedComponent('mcp', 'nope')).be.undefined();
  });
});

describe('republishing the configuration as it already is', () => {
  const sources = async () => ({ catalogs: {}, presets: [] });
  const fixed = () => {
    let count = 0;
    return () => {
      count += 1;
      return `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
    };
  };

  it('should have nothing to do on a machine with no configuration, or one wired without catalogs', async () => {
    should(await world({ format: 'none', overrides: { modelCatalogs: sources } }).service.republish()).equal('skipped');
    should(await world().service.republish()).equal('skipped');
  });

  it('should publish when nothing is published yet, and leave a manifest that already says the same', async () => {
    const plans: { manifest: { generatedAt: string } }[] = [];
    const first = world({
      overrides: { modelCatalogs: sources, mint: fixed() },
      apply: async plan => {
        plans.push(plan);
        return { accountCount: 1, operationCount: 1, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] };
      },
    });
    should(await first.service.republish()).equal('applied');
    const published = { ...plans[0]?.manifest, generatedAt: 'an earlier time' };

    const same = world({
      overrides: { modelCatalogs: sources, mint: fixed(), publishedManifest: async () => published },
    });
    should(await same.service.republish()).equal('unchanged');
    should(same.applied).have.length(0);

    const moved = world({
      overrides: {
        modelCatalogs: sources,
        mint: fixed(),
        publishedManifest: async () => published,
        wrappersCurrent: async () => false,
      },
    });
    should(await moved.service.republish()).equal('applied');

    const different = world({
      overrides: {
        modelCatalogs: sources,
        mint: fixed(),
        publishedManifest: async () => ({ ...published, version: 99 }),
      },
    });
    should(await different.service.republish()).equal('applied');

    for (const unreadable of [null, 'text', undefined]) {
      const other = world({
        overrides: { modelCatalogs: sources, mint: fixed(), publishedManifest: async () => unreadable },
      });
      should(await other.service.republish()).equal('applied');
    }
  });

  it('should refuse in a sentence when the plan cannot be made, and when the publish fails', async () => {
    const unplannable = world({
      overrides: {
        modelCatalogs: sources,
        ids: async () => {
          throw new Error('ids are unreadable');
        },
      },
    });
    const planned = await rejection(unplannable.service.republish());
    should(planned).match({ code: 'fleet_change_refused', message: 'ids are unreadable' });

    const failing = world({
      overrides: { modelCatalogs: sources, mint: fixed() },
      apply: async () => {
        throw new Error('the disk is full');
      },
    });
    const published = await rejection(failing.service.republish());
    should(published).match({ code: 'fleet_change_failed', message: 'the disk is full' });
  });
});

describe('staging a change', () => {
  it('should read a staged change back, without the text a component carries', async () => {
    const { service } = world();
    const staged = await service.propose({
      kind: 'component.put',
      name: 'fresh',
      create: true,
      component: { kind: 'instructions' },
      content: '# secret-looking text',
    });
    should(staged.change).not.have.property('content');
    should(staged.preview).match({ kind: 'apply' });
    const again = await service.read(staged.id);
    should(again.id).equal(staged.id);
    should(again.change).not.have.property('content');
    // The text lives in Runtimes' own config item, written by the config writer: no document lands in the asset tree.
    should(
      (again.preview as unknown as { documents: { path: string }[] }).documents.map(file => file.path),
    ).not.containEql('/fy/fleet/assets/components/instructions/fresh.md');
  });

  it('should name the runtimes an edit to a used component lands on, even though no row reads differently', async () => {
    const { service } = world();
    const staged = await service.propose({
      kind: 'component.put',
      name: 'notes',
      create: false,
      component: { kind: 'instructions' },
      content: '# new notes',
    });
    const names = (staged.preview as unknown as { runtimes: { name: string }[] }).runtimes.map(runtime => runtime.name);
    should(names.toSorted()).eql(['claude-default', 'second']);
  });

  it('should answer a read of a change nobody staged', async () => {
    const { service } = world();
    const failure = await rejection(service.read('nothing'));
    should(failure).match({ code: 'fleet_change_unknown' });
  });

  it('should let an error that is not a proposal refusal through as it is', async () => {
    const { service } = world({
      overrides: {
        mintId: () => {
          throw new Error('no entropy');
        },
      },
    });
    const failure = await rejection(service.propose(REMOVE));
    should(failure).be.instanceOf(Error);
    should(failure).not.be.instanceOf(FleetCatalogRefusal);
    should((failure as Error).message).equal('no entropy');
  });

  it('should refuse in a sentence when the runtime ids cannot be read', async () => {
    const { service } = world({
      overrides: {
        ids: async () => {
          throw new Error('ids are unreadable');
        },
      },
    });
    const failure = await rejection(service.propose(REMOVE));
    should(failure).match({
      code: 'fleet_change_refused',
      message: 'the runtime ids could not be read: ids are unreadable',
    });
  });

  it('should let a failure that is not a refusal of the change through', async () => {
    const { service } = world({
      overrides: {
        readAsset: async () => {
          throw new Error('the asset tree fell over');
        },
      },
    });
    const failure = await rejection(
      service.propose({ kind: 'profile.put', name: 'other', layers: ['settings/cl-settings'], create: true }),
    );
    should(failure).not.be.instanceOf(FleetCatalogRefusal);
    should((failure as Error).message).equal('the asset tree fell over');
  });

  it('should refuse a change it cannot plan or preview, in a sentence', async () => {
    const { service } = world({
      preview: async () => {
        throw new Error('the preview fell over');
      },
    });
    const failure = await rejection(service.propose(REMOVE));
    should(failure).match({ code: 'fleet_change_refused', message: 'the preview fell over' });
  });

  it('should let a thing that is not an error through as it is', async () => {
    const { service } = world({
      preview: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'not an error';
      },
    });
    should(await rejection(service.propose(REMOVE))).equal('not an error');
  });
});

describe('the sessions a runtime change reaches', () => {
  const record = (
    id: string,
    agent: string,
    status: RuntimeSessionRecord['status'] = 'running',
  ): RuntimeSessionRecord => ({
    id,
    name: `ferret-${id}`,
    harness: 'claude',
    agent,
    status,
  });
  const ids: RuntimeIds = {
    runtimes: {
      second: { id: 'id-second', formerNames: ['former-second'] },
      other: { id: 'id-other', formerNames: [] },
    },
  } as unknown as RuntimeIds;

  it('should count the ferrets running on a runtime by any spelling, and leave out the ones that ended', async () => {
    const { service } = world({
      overrides: {
        ids: async () => ids,
        sessionRecords: async () => [
          record('1', 'second'),
          record('2', 'former-second'),
          record('3', 'id-second'),
          record('4', 'second', 'completed'),
          record('5', 'claude-default'),
        ],
      },
    });
    const staged = await service.propose(REMOVE);
    const running = (staged.preview as unknown as { runningSessions?: { id: string }[] }).runningSessions;
    should(running?.map(session => session.id)).eql(['1', '2', '3']);
    should(staged.consequences.join(' ')).match(/3 ferrets are running on it/u);
  });

  it('should say only what it knows when the session records cannot be read, or none run on it', async () => {
    const unreadable = world({
      overrides: {
        ids: async () => ids,
        sessionRecords: async () => {
          throw new Error('no records');
        },
      },
    });
    const staged = await unreadable.service.propose(REMOVE);
    should(staged.preview).not.have.property('runningSessions');

    const none = world({ overrides: { ids: async () => ids, sessionRecords: async () => [] } });
    should((await none.service.propose(REMOVE)).preview).not.have.property('runningSessions');

    const unnamed = world({ overrides: { sessionRecords: async () => [record('1', 'second')] } });
    const bare = await unnamed.service.propose(REMOVE);
    should((bare.preview as unknown as { runningSessions?: unknown[] }).runningSessions).have.length(1);
  });

  it('should re-point the session records once a rename has landed, and never fail the rename over it', async () => {
    const renamed: unknown[] = [];
    const ok = world({
      overrides: {
        renameSessions: async rename => {
          renamed.push(rename);
          return 1;
        },
      },
    });
    const staged = await ok.service.propose(RENAME);
    should(await ok.service.apply(staged.id, OWNER)).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(renamed).eql([
      { from: 'second', to: 'renamed', fromWrapper: '/fy/fleet/bin/second', toWrapper: '/fy/fleet/bin/renamed' },
    ]);

    const failing = world({
      overrides: {
        renameSessions: async () => {
          throw new Error('records are locked');
        },
      },
    });
    const again = await failing.service.propose(RENAME);
    should(await failing.service.apply(again.id, OWNER)).match({ outcome: 'applied', apply: { outcome: 'committed' } });
  });
});

describe('how an apply ends', () => {
  it('should report a rolled-back apply as an outcome rather than a throw', async () => {
    const { service } = world({
      apply: async () => {
        throw new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'file /x', reason: 'disk is full' });
      },
    });
    const staged = await service.propose(REMOVE);
    should(await service.apply(staged.id, OWNER)).match({
      outcome: 'applied',
      apply: { outcome: 'rolled-back', reason: 'disk is full' },
    });
  });

  it('should report a committed apply whose history failed afterwards, and remember what it skipped', async () => {
    const { service } = world({
      apply: async () => {
        throw new FleetApplyFailureError({
          kind: 'history-failed-after-commit',
          failedHarness: 'codex',
          reason: 'pool is locked',
          committed: { ...COMMITTED, skipped: [] },
        });
      },
    });
    const staged = await service.propose(REMOVE);
    should(await service.apply(staged.id, OWNER)).match({
      outcome: 'applied',
      apply: { outcome: 'committed-with-history-failure', failedHarness: 'codex' },
    });
  });

  it('should refuse in a sentence when the provisioner throws something that is not an apply failure', async () => {
    const { service } = world({
      apply: async () => {
        throw new Error('the kernel went away');
      },
    });
    const staged = await service.propose(REMOVE);
    const failure = await rejection(service.apply(staged.id, OWNER));
    should(failure).match({ code: 'fleet_change_failed', message: 'the kernel went away' });
  });

  it('should refuse a ferret that widens what ferrets may drive, and keep the change to try again', async () => {
    const { service } = world();
    const staged = await service.propose({
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true, pageScripts: true },
      browserMode: 'headless',
      browserProxy: null,
      browserPorts: 'random',
      browserFirewallFailure: 'warn',
      autoResume: true,
      agendaMode: false,
      publicUsageFeed: false,
    });
    const failure = await rejection(service.apply(staged.id, OWNER, { agent: true, claim: () => true }));
    should(failure).be.instanceOf(ApiError);
    should(failure).match({ status: 403, code: 'owner_only' });
    const retry = await rejection(
      service.apply(staged.id, { ...OWNER, governed: true }, { agent: false, claim: () => false }),
    );
    should(retry).be.instanceOf(FleetCatalogFreshStepUpRequired);
  });
});

describe('installing one catalog item', () => {
  const provenance = {
    publisher: 'pub-1',
    publisherName: 'Acme',
    catalogId: 'cat-1',
    catalogName: 'Acme catalog',
    itemId: 'item-1',
    kind: 'mcp' as const,
    name: 'tool',
    version: 1,
    digest: `sha256:${'0'.repeat(64)}`,
  };
  const install: CatalogInstallChange = {
    kind: 'catalog.install',
    name: 'tool',
    profile: 'default',
    replace: false,
    installedFrom: provenance,
    component: { kind: 'mcp', command: 'tool-bin' },
    files: [],
  };

  it('should stage, check and apply in one call, answering the component as the daemon now holds it', async () => {
    const { service, applied } = world();
    const done = await service.installCatalogItem(install);
    should(done.outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(done.component).containEql({ command: 'tool-bin' });
    should(applied).have.length(1);
  });

  it('should answer the skill an install adds as the daemon holds it', async () => {
    const { service } = world();
    const done = await service.installCatalogItem({
      ...install,
      name: 'sk2',
      component: { kind: 'skills', items: ['sk2'] },
      files: [{ path: 'SKILL.md', content: '# skill' }],
      installedFrom: { ...provenance, kind: 'skill', name: 'sk2' },
    });
    should(done.component).containEql({ items: ['sk2'] });
  });

  it('should refuse what the installer would never have produced, with the schema’s own sentence', async () => {
    const { service, applied } = world();
    const failure = await rejection(
      service.installCatalogItem({
        ...install,
        component: { kind: 'instructions' },
      } as unknown as CatalogInstallChange),
    );
    should(failure).match({ code: 'fleet_change_refused' });
    should(applied).have.length(0);
  });

  it('should refuse in a sentence when the change did not land', async () => {
    const { service } = world({
      apply: async () => {
        throw new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: 'file /x', reason: 'disk is full' });
      },
    });
    const failure = await rejection(service.installCatalogItem(install));
    should(failure).match({ code: 'fleet_change_failed', message: 'disk is full' });
  });
});

describe('the first-run executors', () => {
  const setup: AccountChange = { kind: 'setup.import' };
  const clone: AccountChange = { kind: 'clone.import', mode: 'alongside', bundle: {} };

  it('should say plainly that importing or cloning is not available without an executor', async () => {
    const { service } = world();
    should(await rejection(service.propose(setup))).match({
      code: 'fleet_change_refused',
      message: 'Importing a setup is not available on this machine yet.',
    });
    should(await rejection(service.propose(clone))).match({
      code: 'fleet_change_refused',
      message: 'Cloning another machine is not available on this machine yet.',
    });
  });

  it('should describe the setup import when staged and run it for the caller who applies it', async () => {
    const calls: string[] = [];
    const { service } = world({
      overrides: {
        executors: {
          setup: {
            describe: async () => {
              calls.push('describe');
              return 'Import Claude Code.';
            },
            execute: async (_change, caller) => {
              calls.push(`execute agent=${String(caller?.agent)}`);
              return 'Imported Claude Code.';
            },
          },
        },
      },
    });
    const staged = await service.propose(setup);
    should(staged.summary).equal('Import this machine’s setup');
    should(staged.preview).eql({ kind: 'executor', executor: 'setup', description: 'Import Claude Code.' });
    should(await service.apply(staged.id, OWNER)).eql({
      outcome: 'executed',
      executor: 'setup',
      summary: 'Imported Claude Code.',
    });
    should(calls).eql(['describe', 'execute agent=false']);
  });
});

describe('a change to one login', () => {
  const signOut: AccountChange = { kind: 'credential.signout', id: 'claude-you' };
  const relabel: AccountChange = { kind: 'credential.label', id: 'claude-you', label: 'Work' };

  it('should report a sign-out that failed with the reason and the login', async () => {
    const { service, changes } = world();
    changes.setOutcome({
      outcome: 'sign-out-failed',
      reason: 'the token store is locked',
      login: sampleLogin('claude-you'),
    });
    const staged = await service.propose(signOut);
    should(await service.apply(staged.id, OWNER)).match({
      outcome: 'sign-out-failed',
      reason: 'the token store is locked',
    });
  });

  it('should say the login changed but the runtimes could not be republished', async () => {
    let afterApply = false;
    const { service, changes } = world({
      overrides: {
        document: async () => {
          if (afterApply) throw new Error('the configuration vanished');
          return {
            format: 'present',
            model: MODEL,
            revision: 'rev-1',
            documents: () => [],
          };
        },
        modelCatalogs: async () => ({ catalogs: {}, presets: [] }),
      },
    });
    const staged = await service.propose(relabel);
    const apply = changes.apply;
    changes.apply = async id => {
      const result = await apply(id);
      afterApply = true;
      return result;
    };
    const failure = await rejection(service.apply(staged.id, OWNER));
    should(failure).match({ code: 'fleet_change_failed' });
    should((failure as Error).message).match(/^the login changed, but the runtimes could not be republished: /u);
  });
});
