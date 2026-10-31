/**
 * The account model's catalogue at the daemon's front door: four reads, the draft-profile preview,
 * and the stage, read and apply of a change (docs/design/account-model.md §7).
 *
 * The service behind it is a stub, because what the mount owns is the HTTP shape: which status a
 * refusal becomes, that every answer is parsed through the shared schema and never cached, and that an
 * apply is handed the caller's governance rather than deciding it.
 */
import { describe, it } from 'bun:test';
import type {
  FleetAccountChange,
  FleetAccountChangeView,
  FleetMachineView,
  FleetProfileDraftRequest,
  FleetProfileDraftView,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  FleetCatalogService,
  type FleetCatalogServiceDeps,
} from '../../../../src/lib/fleet/catalog-service.ts';
import {
  createFleetCatalogSubsystem,
  type FleetCatalogSubsystem,
  fleetCatalogRoutes,
} from '../../../../src/lib/runtime/mounts/fleet-catalog.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const ID = 'fy_fprop_abcdefghijklmnopqrstuv';

const MACHINE: FleetMachineView = {
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

const VIEW: FleetAccountChangeView = {
  id: ID,
  revision: 'absent',
  change: {
    kind: 'machine.settings',
    agentPermissions: 'skip',
    defaultRuntime: null,
    agentControl: { terminals: true, browsers: true, files: true },
  },
  summary: 'Set agent permissions to Skip all permission checks',
  consequences: ['Applies to new sessions.'],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'apply', operations: [], documents: [], runtimes: [] },
};

const DRAFT: FleetProfileDraftView = {
  harnesses: [
    {
      harness: 'claude',
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

interface Calls {
  proposed: FleetAccountChange[];
  previewed: FleetProfileDraftRequest[];
  read: string[];
  machines: (CallerGovernance | undefined)[];
  applied: { id: string; governance: CallerGovernance | undefined }[];
}

function stub(overrides: Partial<FleetCatalogSubsystem> = {}): { subsystem: FleetCatalogSubsystem; calls: Calls } {
  const calls: Calls = { proposed: [], previewed: [], read: [], machines: [], applied: [] };
  return {
    calls,
    subsystem: {
      machine: async governance => {
        calls.machines.push(governance);
        return MACHINE;
      },
      components: async () => ({ format: 'version-2', kinds: [] }),
      profiles: async () => ({ format: 'version-2', profiles: [] }),
      previewProfile: async request => {
        calls.previewed.push(request);
        return DRAFT;
      },
      runtimes: async () => ({ format: 'version-2', runtimes: [] }),
      propose: async change => {
        calls.proposed.push(change);
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
      ...overrides,
    },
  };
}

const dispatcher = (subsystem: FleetCatalogSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(fleetCatalogRoutes(subsystem)), CREDENTIALS, GRANTED);

const get = (path: string) => request({ path, headers: human });
const post = (path: string, body?: string) =>
  request({
    method: 'POST',
    path,
    headers: { ...human, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });

describe('the fleet catalogue mount', () => {
  it('should answer all four reads through the shared schema and never let one be cached', async () => {
    // Arrange
    const { subsystem } = stub();
    const paths = ['/v1/fleet/machine', '/v1/fleet/components', '/v1/fleet/profiles', '/v1/fleet/runtimes'];

    // Act
    const responses = await Promise.all(paths.map(async path => await dispatcher(subsystem).dispatch(get(path))));

    // Assert
    should(responses.map(response => response.status)).deepEqual([200, 200, 200, 200]);
    should(responses.map(response => response.headers.get('cache-control'))).deepEqual([
      'no-store',
      'no-store',
      'no-store',
      'no-store',
    ]);
    should(jsonBody(responses[0] as never)).deepEqual(MACHINE);
  });

  it('should let nothing write machine settings — agent permissions, the default runtime, or what agents may control — below operator (T, S)', () => {
    // Assert — proposing and applying are the ONLY routes that change `machine.*`, and both demand
    // the operator class: an admin token or a paired device, never the warden and never a lesser
    // class an agent's own session credential could ever hold. An agent therefore has no route that
    // could flip its own control switches, whatever credential a future agent tool-call path mints.
    const writes = fleetCatalogRoutes(stub().subsystem).filter(
      route => route.path === '/v1/fleet/proposals' || route.path === '/v1/fleet/proposals/:proposalId/apply',
    );
    should(writes).have.length(2);
    should(writes.map(route => route.minimum)).deepEqual(['operator', 'operator']);
  });

  it('should hand the machine read the caller governance, so its authority is this caller', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(get('/v1/fleet/machine'));

    // Assert
    should(response.status).equal(200);
    should(calls.machines).have.length(1);
    should(calls.machines[0]).not.be.undefined();
    should(calls.machines[0]).containDeep({ governed: false });
  });

  it('should no longer serve the paths the old account surface staged changes at', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const responses = await Promise.all([
      dispatcher(subsystem).dispatch(get('/v1/fleet/profile-stacks')),
      dispatcher(subsystem).dispatch(post('/v1/fleet/profile-stacks/preview', JSON.stringify({ layers: [] }))),
      dispatcher(subsystem).dispatch(post('/v1/fleet/changes', JSON.stringify({ change: {} }))),
      dispatcher(subsystem).dispatch(get(`/v1/fleet/changes/${ID}`)),
      dispatcher(subsystem).dispatch(post(`/v1/fleet/changes/${ID}/apply`)),
    ]);

    // Assert
    should(responses.map(response => response.status)).deepEqual([404, 404, 404, 404, 404]);
    should(calls).deepEqual({ proposed: [], previewed: [], read: [], machines: [], applied: [] });
  });

  it('should resolve a draft profile as a read: the body to the service, never cached, a bad body refused first', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const body = { layers: ['instructions/main', 'profile/ghost'], editing: 'work' };

    // Act
    const previewed = await dispatcher(subsystem).dispatch(post('/v1/fleet/profiles/preview', JSON.stringify(body)));
    const bad = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/profiles/preview', JSON.stringify({ layers: 'instructions/main' })),
    );

    // Assert
    should(previewed.status).equal(200);
    should(previewed.headers.get('cache-control')).equal('no-store');
    should(jsonBody(previewed)).deepEqual(DRAFT);
    should(bad.status).equal(400);
    should(calls.previewed).deepEqual([body]);
  });

  it('should stage the one change the body names and read it back by id', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const change = {
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
    };

    // Act
    const staged = await dispatcher(subsystem).dispatch(post('/v1/fleet/proposals', JSON.stringify({ change })));
    const read = await dispatcher(subsystem).dispatch(get(`/v1/fleet/proposals/${ID}`));

    // Assert
    should(staged.status).equal(200);
    should(jsonBody(staged)).deepEqual(VIEW);
    should(calls.proposed).deepEqual([change]);
    should(read.status).equal(200);
    should(calls.read).deepEqual([ID]);
  });

  it('should hand an apply the caller governance, and take an empty body', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const applied = await dispatcher(subsystem).dispatch(post(`/v1/fleet/proposals/${ID}/apply`));
    const bare = await dispatcher(subsystem).dispatch(
      request({ method: 'POST', path: `/v1/fleet/proposals/${ID}/apply`, headers: human }),
    );

    // Assert
    should(applied.status).equal(200);
    should(bare.status).equal(200);
    should(jsonBody(applied)).deepEqual({ outcome: 'executed', executor: 'setup', summary: 'Imported 1 runtime' });
    should(calls.applied.map(call => call.id)).deepEqual([ID, ID]);
    should(calls.applied[0]?.governance).containDeep({ governed: false });
  });

  it('should answer turning an agent control back on with the pairing-style step-up demand (owner decision, T)', async () => {
    // Arrange
    const { subsystem } = stub({
      apply: async () => {
        throw new FleetCatalogFreshStepUpRequired();
      },
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(post(`/v1/fleet/proposals/${ID}/apply`));

    // Assert — the SAME wire shape minting a pairing code and widening a device refuse with, so the
    // PWA's existing transparent step-up retry handles this with no code of its own.
    should(response.status).equal(403);
    should(jsonBody(response)).deepEqual({
      error: 'turning an agent control back on from a remote device needs a passkey confirmation for it',
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure', act: 'enable-agent-control' },
    });
  });

  it('should pass this request’s presentation and a spend callback into apply', async () => {
    // Arrange
    let seen: { presentation: unknown; spend: () => void } | undefined;
    const { subsystem } = stub({
      apply: async (_id, _governance, freshStepUp) => {
        seen = freshStepUp as never;
        return { outcome: 'executed', executor: 'setup', summary: 'Imported 1 runtime' };
      },
    });

    // Act
    await dispatcher(subsystem).dispatch(post(`/v1/fleet/proposals/${ID}/apply`));

    // Assert — a handler with no proven device still gets a callable, harmless spend.
    should(seen).not.be.undefined();
    should(() => seen?.spend()).not.throw();
  });

  it('should refuse an apply body that names a field, before the service runs', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      post(`/v1/fleet/proposals/${ID}/apply`, JSON.stringify({ operatorPassword: 'correct horse' })),
    );

    // Assert
    should(response.status).equal(400);
    should(calls.applied).be.empty();
  });

  it('should answer 404 for a change it never staged and 409 for every other refusal', async () => {
    // Arrange
    const { subsystem } = stub({
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

    // Act
    const unknown = await dispatcher(subsystem).dispatch(get(`/v1/fleet/proposals/${ID}`));
    const stale = await dispatcher(subsystem).dispatch(post(`/v1/fleet/proposals/${ID}/apply`));

    // Assert
    should(unknown.status).equal(404);
    should(jsonBody(unknown)).deepEqual({ error: 'no change by that id', code: 'fleet_change_unknown' });
    should(stale.status).equal(409);
    should(jsonBody(stale).code).equal('fleet_change_stale');
  });

  it('should refuse a catalog.install on the public route however it is spelled: only the installer produces one', async () => {
    // Arrange — a forged install: a path out of the skill's folder, and a made-up provenance.
    const { subsystem, calls } = stub();
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
    const forgedAnswer = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/proposals', JSON.stringify({ change: forged })),
    );
    const cleanAnswer = await dispatcher(subsystem).dispatch(
      post(
        '/v1/fleet/proposals',
        JSON.stringify({ change: { ...forged, files: [{ path: 'SKILL.md', content: 'x' }] } }),
      ),
    );

    // Assert
    should([forgedAnswer.status, cleanAnswer.status]).deepEqual([400, 400]);
    should(calls.proposed).have.length(0);
  });

  it('should refuse a change id that cannot be decoded, and a body naming no known change, before the service', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const badId = await dispatcher(subsystem).dispatch(get('/v1/fleet/proposals/%E0'));
    const badBody = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/proposals', JSON.stringify({ change: { kind: 'config.replace', document: {} } })),
    );

    // Assert
    should(badId.status).equal(400);
    should(jsonBody(badId).code).equal('bad_request');
    should(badBody.status).equal(400);
    should(calls.read).have.length(0);
    should(calls.proposed).have.length(0);
  });

  it('should leave an unexpected failure to the dispatcher rather than dress it as a refusal', async () => {
    // Arrange
    const { subsystem } = stub({
      runtimes: async () => {
        throw new Error('the disk went away');
      },
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(get('/v1/fleet/runtimes'));

    // Assert
    should(response.status).equal(500);
  });

  it('should build the service the composition root mounts', () => {
    // Act
    const subsystem = createFleetCatalogSubsystem({
      now: () => 0,
      mintId: () => 'x',
    } as unknown as FleetCatalogServiceDeps);

    // Assert
    should(subsystem).be.instanceOf(FleetCatalogService);
  });
});
