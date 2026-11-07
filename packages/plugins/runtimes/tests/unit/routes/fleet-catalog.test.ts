/**
 * The account model's catalogue at the daemon's front door: four reads, the draft-profile preview,
 * and the stage, read and apply of a change (docs/design/account-model.md §7).
 *
 * The service behind it is a stub, because what the routes own is the HTTP shape: which status a
 * refusal becomes, that every answer is parsed through the contract's schema and never cached, and that an
 * apply is handed the caller's governance rather than deciding it.
 */
import { describe, it } from 'bun:test';
import { deviceStanding, ferretStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import type {
  AccountChange,
  AccountChangeView,
  MachineView,
  ProfileDraftRequest,
  ProfileDraftView,
} from '../../../contract/index.ts';
import type { RuntimesAssembly } from '../../../daemon/index.ts';
import {
  type ExecutorCaller,
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
} from '../../../daemon/lib/service/catalog-service.ts';
import { type Hosted, hostRuntimes, PROPOSAL_ID } from './support.ts';

const ID = PROPOSAL_ID;

const MACHINE: MachineView = {
  name: 'studio',
  format: 'present',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
  lastAutoResume: null,
  tools: [],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

const VIEW: AccountChangeView = {
  id: ID,
  revision: 'absent',
  change: {
    kind: 'machine.settings',
    agentPermissions: 'skip',
    defaultRuntime: null,
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    browserMode: 'headless',
    browserProxy: null,
    browserPorts: 'random',
    browserFirewallFailure: 'warn',
    autoResume: true,
    agendaMode: false,
    publicUsageFeed: false,
  },
  summary: 'Set agent permissions to Skip all permission checks',
  consequences: ['Applies to new sessions.'],
  expiresAt: instantFromEpochMs(1_794_053_700_000),
  state: 'pending',
  preview: { kind: 'apply', operations: [], documents: [], runtimes: [] },
};

const DRAFT: ProfileDraftView = {
  harnesses: [
    {
      harness: 'claude-code',
      available: { available: false, reason: 'This profile has no layers yet.' },
      applied: [],
      skipped: [],
      conflicts: [],
      partial: [],
    },
  ],
  scope: { kind: 'scoped', scope: 'generic' },
  refusal: 'no profile ghost exists on this machine',
};

type CatalogStub = RuntimesAssembly['catalog'];

interface Calls {
  proposed: AccountChange[];
  previewed: ProfileDraftRequest[];
  read: string[];
  machines: unknown[];
  applied: { id: string; governance: unknown }[];
  callers: (ExecutorCaller | undefined)[];
}

function stub(overrides: Partial<CatalogStub> = {}): { assembly: RuntimesAssembly; calls: Calls } {
  const calls: Calls = { proposed: [], previewed: [], read: [], machines: [], applied: [], callers: [] };
  const catalog: CatalogStub = {
    machine: async governance => {
      calls.machines.push(governance);
      return MACHINE;
    },
    components: async () => ({ format: 'present', kinds: [] }),
    profiles: async () => ({ format: 'present', profiles: [] }),
    previewProfile: async request => {
      calls.previewed.push(request);
      return DRAFT;
    },
    runtimes: async () => ({ format: 'present', runtimes: [] }),
    propose: async (change, caller) => {
      calls.proposed.push(change);
      calls.callers.push(caller);
      return VIEW;
    },
    read: async id => {
      calls.read.push(id);
      return VIEW;
    },
    apply: async (id, governance) => {
      calls.applied.push({ id, governance });
      return { outcome: 'executed', executor: 'setup', summary: 'Imported 1 runtime' };
    },
    installCatalogItem: async () => await Promise.reject(new Error('not used here')),
    ...overrides,
  };
  return {
    calls,
    assembly: {
      catalog,
      setup: {} as RuntimesAssembly['setup'],
    },
  };
}

const json = <T = Record<string, unknown>>(response: { json<U>(): U }): T => response.json<T>();
const post = async (hosted: Hosted, path: string, body?: unknown) =>
  await hosted.host.request('POST', path, body === undefined ? {} : { body });

describe('the fleet catalogue mount', () => {
  it('should answer all four reads through the shared schema and never let one be cached', async () => {
    // Arrange
    const { assembly } = stub();
    const { host } = await hostRuntimes(assembly);
    const paths = ['/v1/runtimes/machine', '/v1/runtimes/components', '/v1/runtimes/profiles', '/v1/runtimes'];

    // Act
    const responses = await Promise.all(paths.map(async path => await host.request('GET', path)));

    // Assert
    should(responses.map(response => response.status)).deepEqual([200, 200, 200, 200]);
    should(responses.map(response => response.headers.get('cache-control'))).deepEqual([
      'no-store',
      'no-store',
      'no-store',
      'no-store',
    ]);
    should(json(responses[0] as never)).deepEqual(MACHINE);
  });

  it('should let nothing write machine settings — agent permissions, the default runtime, or what agents may control — below operator (T, S)', async () => {
    // Assert — proposing and applying are the ONLY routes that change `machine.*`. Both demand the operator class,
    // which holds the warden out; the apply is also person-only, so a ferret can stage a change (and is told apart
    // from a person while it does) but can never confirm one: no route lets an agent flip its own control switches.
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    hosted.as(wardenStanding('w1' as never));
    const wardenStaged = await post(hosted, '/v1/runtimes/proposals', { change: VIEW.change });
    const wardenApplied = await post(hosted, `/v1/runtimes/proposals/${ID}/apply`);
    hosted.as(ferretStanding('f1' as never));
    const ferretApplied = await post(hosted, `/v1/runtimes/proposals/${ID}/apply`);
    await post(hosted, '/v1/runtimes/proposals', { change: VIEW.change });

    should([wardenStaged.status, wardenApplied.status, ferretApplied.status]).deepEqual([403, 403, 403]);
    should(json(ferretApplied).code).equal('owner_only');
    should(calls.applied).be.empty();
    should(calls.callers.map(caller => caller?.agent)).deepEqual([true]);
  });

  it('should hand the machine read the caller governance, so its authority is this caller', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const { host } = await hostRuntimes(assembly);

    // Act
    const response = await host.request('GET', '/v1/runtimes/machine');

    // Assert
    should(response.status).equal(200);
    should(calls.machines).have.length(1);
    should(calls.machines[0]).not.be.undefined();
    should(calls.machines[0]).containDeep({ governed: false });
  });

  it('should no longer serve the paths the old account surface staged changes at', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    // Act
    const responses = await Promise.all([
      hosted.host.request('GET', '/v1/fleet/machine'),
      hosted.host.request('GET', '/v1/fleet/profile-stacks'),
      post(hosted, '/v1/fleet/profile-stacks/preview', { layers: [] }),
      post(hosted, '/v1/fleet/changes', { change: {} }),
      hosted.host.request('GET', `/v1/fleet/changes/${ID}`),
      post(hosted, `/v1/fleet/changes/${ID}/apply`),
    ]);

    // Assert
    should(responses.map(response => response.status)).deepEqual([404, 404, 404, 404, 404, 404]);
    should(calls).deepEqual({ proposed: [], previewed: [], read: [], machines: [], applied: [], callers: [] });
  });

  it('should resolve a draft profile as a read: the body to the service, never cached, a bad body refused first', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    const body = { layers: ['instructions/main', 'profile/ghost'], editing: 'work' };

    // Act
    const previewed = await post(hosted, '/v1/runtimes/profiles/preview', body);
    const bad = await post(hosted, '/v1/runtimes/profiles/preview', { layers: 'instructions/main' });

    // Assert
    should(previewed.status).equal(200);
    should(previewed.headers.get('cache-control')).equal('no-store');
    should(json(previewed)).deepEqual(DRAFT);
    should(bad.status).equal(400);
    should(calls.previewed).deepEqual([body]);
  });

  it('should stage the one change the body names and read it back by id', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    const change = VIEW.change;

    // Act
    const staged = await post(hosted, '/v1/runtimes/proposals', { change });
    const read = await hosted.host.request('GET', `/v1/runtimes/proposals/${ID}`);

    // Assert
    should(staged.status).equal(200);
    should(json(staged)).deepEqual(JSON.parse(JSON.stringify(VIEW)));
    should(calls.proposed).deepEqual([change]);
    should(read.status).equal(200);
    should(calls.read).deepEqual([ID]);
  });

  it('should describe a staged change for THIS caller: its governance, no proof, and not a ferret', async () => {
    // A clone writes settings files the grants govern one by one, so staging is told who is asking.
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    await post(hosted, '/v1/runtimes/proposals', { change: { kind: 'setup.import' } });

    should(calls.callers).have.length(1);
    should(calls.callers[0]).containDeep({ agent: false });
    should(calls.callers[0]?.governance).containDeep({ governed: false });
  });

  it('should hand an apply the caller governance, and take an empty body', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const { host } = await hostRuntimes(assembly);

    // Act
    const applied = await host.request('POST', `/v1/runtimes/proposals/${ID}/apply`, { body: {} });
    const bare = await host.request('POST', `/v1/runtimes/proposals/${ID}/apply`);

    // Assert
    should(applied.status).equal(200);
    should(bare.status).equal(200);
    should(json(applied)).deepEqual({ outcome: 'executed', executor: 'setup', summary: 'Imported 1 runtime' });
    should(calls.applied.map(call => call.id)).deepEqual([ID, ID]);
    should(calls.applied[0]?.governance).containDeep({ governed: false });
  });

  it('should answer turning an agent control back on with the pairing-style step-up demand (owner decision, T)', async () => {
    // Arrange
    const { assembly } = stub({
      apply: async () => {
        throw new FleetCatalogFreshStepUpRequired();
      },
    });
    const hosted = await hostRuntimes(assembly);

    // Act
    const response = await post(hosted, `/v1/runtimes/proposals/${ID}/apply`);

    // Assert — the SAME wire shape minting a pairing code and widening a device refuse with, so the app's existing
    // transparent step-up retry handles this with no code of its own.
    should(response.status).equal(403);
    should(json(response)).deepEqual({
      error: 'turning an agent control back on from a remote device needs a passkey confirmation for it',
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure', act: 'enable-agent-control' },
    });
  });

  it('should pass this request’s fresh-proof claim into apply, which answers false for a caller with no proof to take', async () => {
    // Arrange
    let seen: { claim: () => boolean; agent: boolean } | undefined;
    const { assembly } = stub({
      apply: async (_id, _governance, freshStepUp) => {
        seen = freshStepUp as never;
        return { outcome: 'executed', executor: 'setup', summary: 'Imported 1 runtime' };
      },
    });
    const { host } = await hostRuntimes(assembly);

    // Act
    await host.request('POST', `/v1/runtimes/proposals/${ID}/apply`);

    // Assert — a handler with no proven device still gets a callable claim, and it takes nothing.
    should(seen).not.be.undefined();
    should(seen?.claim()).be.false();
    should(seen?.agent).be.false();
  });

  it('should refuse an apply body that names a field, before the service runs', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    // Act
    const response = await post(hosted, `/v1/runtimes/proposals/${ID}/apply`, { operatorPassword: 'correct horse' });

    // Assert
    should(response.status).equal(400);
    should(calls.applied).be.empty();
  });

  it('should answer 404 for a change it never staged and 409 for every other refusal', async () => {
    // Arrange
    const { assembly } = stub({
      read: async () => {
        throw new FleetCatalogRefusal('fleet_change_unknown', 'no change by that id');
      },
      apply: async () => {
        throw new FleetCatalogRefusal(
          'fleet_change_stale',
          'the configuration changed after this change was previewed',
        );
      },
    });
    const hosted = await hostRuntimes(assembly);

    // Act
    const unknown = await hosted.host.request('GET', `/v1/runtimes/proposals/${ID}`);
    const stale = await post(hosted, `/v1/runtimes/proposals/${ID}/apply`);

    // Assert
    should(unknown.status).equal(404);
    should(json(unknown)).deepEqual({ error: 'no change by that id', code: 'fleet_change_unknown' });
    should(stale.status).equal(409);
    should(json(stale).code).equal('fleet_change_stale');
  });

  it('should refuse a catalog.install on the public route however it is spelled: only the installer produces one', async () => {
    // Arrange — a forged install: a path out of the skill's folder, and a made-up provenance.
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    const forged = {
      kind: 'catalog.install',
      name: 'x',
      component: { kind: 'skills', items: ['x'] },
      files: [{ path: '../../../../config/x.yaml', content: 'owned' }],
      profile: 'work',
      installedFrom: {
        publisher: `fy_daemon_${'p'.repeat(43)}`,
        publisherName: 'trusted',
        catalogId: `cat_${'c'.repeat(22)}`,
        catalogName: 'Catalog',
        itemId: `itm_${'i'.repeat(22)}`,
        kind: 'skill',
        name: 'x',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      replace: false,
    };

    // Act
    const forgedAnswer = await post(hosted, '/v1/runtimes/proposals', { change: forged });
    const cleanAnswer = await post(hosted, '/v1/runtimes/proposals', {
      change: { ...forged, files: [{ path: 'SKILL.md', content: 'x' }] },
    });

    // Assert
    should([forgedAnswer.status, cleanAnswer.status]).deepEqual([400, 400]);
    should(calls.proposed).have.length(0);
  });

  it('should refuse a change id that cannot be decoded, and a body naming no known change, before the service', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    // Act
    const badId = await hosted.host.request('GET', '/v1/runtimes/proposals/%E0');
    const badBody = await post(hosted, '/v1/runtimes/proposals', {
      change: { kind: 'config.replace', document: {} },
    });

    // Assert
    should(badId.status).equal(400);
    should(json(badId).code).equal('bad_request');
    should(badBody.status).equal(400);
    should(calls.read).have.length(0);
    should(calls.proposed).have.length(0);
  });

  it('should leave an unexpected failure to the dispatcher rather than dress it as a refusal', async () => {
    // Arrange
    const { assembly } = stub({
      runtimes: async () => {
        throw new Error('the disk went away');
      },
    });
    const { host } = await hostRuntimes(assembly);

    // Act
    const response = await host.request('GET', '/v1/runtimes');

    // Assert
    should(response.status).equal(500);
  });

  it('should hold a governed device to the grants before the service runs (the manifest declares fleet.configure)', async () => {
    // Arrange — a device whose own half grants `fleet.use` only.
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    hosted.as(deviceStanding('phone', { fleet: { use: true, configure: false } } as never, true));

    // Act
    const staged = await post(hosted, '/v1/runtimes/proposals', { change: VIEW.change });

    // Assert
    should(staged.status).equal(403);
    should(calls.proposed).be.empty();
  });
});
