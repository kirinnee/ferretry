/**
 * A machine's setup at the daemon's front door: the scan, the tool install and the clone export
 * (docs/design/account-model.md §4.3, §4.7, §7).
 *
 * The service behind it is a stub, because what the mount owns is the HTTP shape: that each route calls
 * its one subsystem method, that every answer is parsed through the shared schema, which status a
 * refusal becomes, and that a write is handed the caller's governance rather than deciding it.
 */
import { describe, it } from 'bun:test';
import {
  type FleetCloneBundle,
  type FleetCloneKeysRecordRequest,
  type FleetCloneReview,
  type FleetCloneReviewRequest,
  type FleetSetupScan,
  type FleetToolInstallRequest,
  type FleetToolInstallResult,
  mcpOAuthSecretNames,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetSetupRefusal } from '../../../daemon/lib/service/setup-service.ts';
import { type FleetSetupSubsystem, fleetSetupRoutes } from '../../../daemon/routes/fleet-setup.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const SCAN: FleetSetupScan = {
  machine: 'studio',
  format: 'version-2',
  tools: [{ harness: 'claude', label: 'Claude Code', installed: true }],
  harnesses: [],
  runtimes: [],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
};

const INSTALL: FleetToolInstallResult = { outcomes: [{ harness: 'claude', outcome: 'already-installed' }] };

const BUNDLE: FleetCloneBundle = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'studio',
  exportedAt: '2026-10-13T08:00:00.000Z',
  credentials: [],
  components: {},
  profiles: {},
  runtimes: {},
  files: [],
  notCopied: [],
};

const REVIEW: FleetCloneReview = {
  mode: 'update',
  source: { name: 'studio', verified: 'browser' },
  items: [],
  settings: [],
  logins: [],
  keys: [],
  same: { count: 2, probable: 0 },
  fingerprint: 'f'.repeat(64),
};

interface Calls {
  scans: number;
  exports: number;
  reviews: number;
  forgets: string[];
  reviewed: { request: FleetCloneReviewRequest; governance: CallerGovernance | undefined }[];
  installs: { request: FleetToolInstallRequest; governance: CallerGovernance | undefined }[];
}

function stub(overrides: Partial<FleetSetupSubsystem> = {}): { subsystem: FleetSetupSubsystem; calls: Calls } {
  const calls: Calls = { scans: 0, exports: 0, reviews: 0, forgets: [], reviewed: [], installs: [] };
  return {
    calls,
    subsystem: {
      scan: async () => {
        calls.scans += 1;
        return SCAN;
      },
      installTools: async (body, governance) => {
        calls.installs.push({ request: body, governance });
        return INSTALL;
      },
      exportBundle: async () => {
        calls.exports += 1;
        return BUNDLE;
      },
      reviewClone: async (body, governance) => {
        calls.reviews += 1;
        calls.reviewed.push({ request: body, governance });
        return REVIEW;
      },
      forgetCloneSource: async source => {
        calls.forgets.push(source);
        return source === 'studio';
      },
      recordCloneKeys: async () => ({ recorded: 0 }),
      executors: {} as FleetSetupSubsystem['executors'],
      ...overrides,
    },
  };
}

const dispatcher = (subsystem: FleetSetupSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(fleetSetupRoutes(subsystem)), CREDENTIALS, GRANTED);

const get = (path: string) => request({ path, headers: human });
const post = (path: string, body?: string) =>
  request({
    method: 'POST',
    path,
    headers: { ...human, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });

describe('the fleet setup mount', () => {
  it('should answer the two reads through the shared schema and never let one be cached', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const paths = ['/v1/fleet/setup/scan', '/v1/fleet/export'];

    // Act
    const responses = await Promise.all(paths.map(async path => await dispatcher(subsystem).dispatch(get(path))));

    // Assert
    should(responses.map(response => response.status)).deepEqual([200, 200]);
    should(responses.map(response => response.headers.get('cache-control'))).deepEqual(['no-store', 'no-store']);
    should(jsonBody(responses[0] as never)).deepEqual(SCAN);
    should(jsonBody(responses[1] as never)).deepEqual(BUNDLE);
    should([calls.scans, calls.exports]).deepEqual([1, 1]);
  });

  it('should answer a clone review through the shared schema, uncached, and refuse a body that is not one', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const answered = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/clone/review', JSON.stringify({ bundle: BUNDLE })),
    );
    const bad = await dispatcher(subsystem).dispatch(post('/v1/fleet/clone/review', JSON.stringify({ nope: 1 })));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(jsonBody(answered)).deepEqual(REVIEW);
    should(bad.status).equal(400);
    should(calls.reviews).equal(1);
  });

  it('should forget a source through the shared schema, uncached, and say whether there was one', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const known = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/clone/forget', JSON.stringify({ source: 'studio' })),
    );
    const unknown = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/clone/forget', JSON.stringify({ source: 'nobody' })),
    );
    const bad = await dispatcher(subsystem).dispatch(post('/v1/fleet/clone/forget', JSON.stringify({ source: '' })));

    // Assert
    should(known.headers.get('cache-control')).equal('no-store');
    should(jsonBody(known)).deepEqual({ forgotten: true });
    should(jsonBody(unknown)).deepEqual({ forgotten: false });
    should(bad.status).equal(400);
    should(calls.forgets).deepEqual(['studio', 'nobody']);
  });

  it('should answer 409 when more than one source goes by the name given', async () => {
    // Arrange
    const { subsystem } = stub({
      forgetCloneSource: async () => {
        throw new FleetSetupRefusal('fleet_setup_refused', 'More than one source is called studio: a, b.');
      },
    });

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/clone/forget', JSON.stringify({ source: 'studio' })),
    );

    // Assert
    should(answer.status).equal(409);
    should(jsonBody(answer).code).equal('fleet_setup_refused');
  });

  it('should hand a clone review the caller governance and the settings documents, so each file can be checked for THEM', async () => {
    const { subsystem, calls } = stub();
    const settings = [
      { path: 'warden.yaml', text: 'enabled: true\n' },
      { path: 'controls', text: '{"agentPermissions":"auto"}' },
    ];

    const answered = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/clone/review', JSON.stringify({ bundle: BUNDLE, settings })),
    );

    should(answered.status).equal(200);
    should(calls.reviewed[0]?.request.settings).deepEqual(settings as never);
    should(calls.reviewed[0]?.governance).containDeep({ governed: false });
  });

  it('should refuse a review whose settings name a document a copy does not merge', async () => {
    const { subsystem, calls } = stub();
    for (const settings of [
      [{ path: 'machine.yaml', text: 'agentPermissions: skip\n' }],
      [{ path: '../../etc/passwd', text: '' }],
      [{ path: 'warden.yaml', text: 'x', extra: 1 }],
    ]) {
      const bad = await dispatcher(subsystem).dispatch(
        post('/v1/fleet/clone/review', JSON.stringify({ bundle: BUNDLE, settings })),
      );
      should(bad.status).equal(400);
    }
    should(calls.reviews).equal(0);
  });

  it('should record the keys a sealed copy filed through the shared schema, and refuse a sign-in token by name', async () => {
    // Arrange
    const seen: FleetCloneKeysRecordRequest[] = [];
    const { subsystem } = stub({
      recordCloneKeys: async request => {
        seen.push(request);
        return { recorded: request.keys.length };
      },
    });
    const body = {
      source: { daemonId: 'daemon-source' },
      filedAt: '2026-10-12T08:00:00.000Z',
      keys: [{ name: 'GLM_API_KEY', sourceUpdatedAt: '2026-10-10T08:00:00.000Z' }],
    };
    const signIn = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;

    // Act
    const answered = await dispatcher(subsystem).dispatch(post('/v1/fleet/clone/keys', JSON.stringify(body)));
    const refused = await dispatcher(subsystem).dispatch(
      post(
        '/v1/fleet/clone/keys',
        JSON.stringify({ ...body, keys: [{ name: signIn, sourceUpdatedAt: body.keys[0]?.sourceUpdatedAt }] }),
      ),
    );
    const extra = await dispatcher(subsystem).dispatch(
      post(
        '/v1/fleet/clone/keys',
        JSON.stringify({ ...body, keys: [{ ...body.keys[0], value: 'sk-live-0123456789' }] }),
      ),
    );

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(jsonBody(answered)).deepEqual({ recorded: 1 });
    should(seen).have.length(1);
    should(refused.status).equal(400);
    should(extra.status).equal(400);
    // The instant the copy filed them is what the record is anchored on: a report without it is refused.
    const { filedAt: _omitted, ...withoutInstant } = body;
    const unanchored = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/clone/keys', JSON.stringify(withoutInstant)),
    );
    should(unanchored.status).equal(400);
  });

  it('should hand a tool install its request and the caller governance, and never cache the answer', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const body = { harnesses: ['claude'] };

    // Act
    const response = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/machine/tools/install', JSON.stringify(body)),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual(INSTALL);
    should(calls.installs.map(call => call.request)).deepEqual([body as FleetToolInstallRequest]);
    should(calls.installs[0]?.governance).containDeep({ governed: false });
  });

  it('should answer 403 for a caller who could not confirm and 409 with the code for every other refusal', async () => {
    // Arrange
    const { subsystem } = stub({
      scan: async () => {
        throw new FleetSetupRefusal('fleet_setup_unauthorized', 'confirm with your passkey first');
      },
      installTools: async () => {
        throw new FleetSetupRefusal('fleet_setup_unreadable', 'config.yaml could not be read');
      },
      exportBundle: async () => {
        throw new FleetSetupRefusal('fleet_setup_busy', 'another change is being applied');
      },
    });

    // Act
    const unauthorized = await dispatcher(subsystem).dispatch(get('/v1/fleet/setup/scan'));
    const unreadable = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/machine/tools/install', JSON.stringify({ harnesses: ['codex'] })),
    );
    const busy = await dispatcher(subsystem).dispatch(get('/v1/fleet/export'));

    // Assert
    should(unauthorized.status).equal(403);
    should(jsonBody(unauthorized)).deepEqual({
      error: 'confirm with your passkey first',
      code: 'fleet_setup_unauthorized',
    });
    should(unreadable.status).equal(409);
    should(jsonBody(unreadable)).deepEqual({ error: 'config.yaml could not be read', code: 'fleet_setup_unreadable' });
    should(busy.status).equal(409);
    should(jsonBody(busy).code).equal('fleet_setup_busy');
  });

  it('should refuse a body that does not match the schema before the service is asked', async () => {
    // Arrange
    const { subsystem, calls } = stub();

    // Act
    const badInstall = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/machine/tools/install', JSON.stringify({ harnesses: [] })),
    );

    // Assert
    should(badInstall.status).equal(400);
    should(jsonBody(badInstall).code).equal('invalid_request');
    should(calls.installs).have.length(0);
  });

  it('should leave an unexpected failure to the dispatcher rather than dress it as a refusal', async () => {
    // Arrange
    const { subsystem } = stub({
      scan: async () => {
        throw new Error('the disk went away');
      },
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(get('/v1/fleet/setup/scan'));

    // Assert
    should(response.status).equal(500);
  });
});
