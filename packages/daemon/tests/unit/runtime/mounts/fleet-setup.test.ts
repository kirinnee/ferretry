/**
 * A machine's setup at the daemon's front door: the scan, the tool install, the clone export and the
 * migration's dry run and apply (docs/design/account-model.md §4.3, §4.7, §7, §10.3).
 *
 * The service behind it is a stub, because what the mount owns is the HTTP shape: that each route calls
 * its one subsystem method, that every answer is parsed through the shared schema, which status a
 * refusal becomes, and that a write is handed the caller's governance rather than deciding it.
 */
import { describe, it } from 'bun:test';
import type {
  FleetCloneBundle,
  FleetMigrationApplyRequest,
  FleetMigrationOutcome,
  FleetMigrationView,
  FleetSetupScan,
  FleetToolInstallRequest,
  FleetToolInstallResult,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetSetupRefusal } from '../../../../src/lib/fleet/setup-service.ts';
import { type FleetSetupSubsystem, fleetSetupRoutes } from '../../../../src/lib/runtime/mounts/fleet-setup.ts';
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

const MIGRATION: FleetMigrationView = { status: 'no-fleet', migrate: { available: false, reason: 'no fleet here' } };

const OUTCOME: FleetMigrationOutcome = { outcome: 'refused', reasons: ['a session is running'] };

interface Calls {
  scans: number;
  exports: number;
  views: number;
  installs: { request: FleetToolInstallRequest; governance: CallerGovernance | undefined }[];
  migrations: { request: FleetMigrationApplyRequest; governance: CallerGovernance | undefined }[];
}

function stub(overrides: Partial<FleetSetupSubsystem> = {}): { subsystem: FleetSetupSubsystem; calls: Calls } {
  const calls: Calls = { scans: 0, exports: 0, views: 0, installs: [], migrations: [] };
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
      migration: async () => {
        calls.views += 1;
        return MIGRATION;
      },
      migrate: async (body, governance) => {
        calls.migrations.push({ request: body, governance });
        return OUTCOME;
      },
      executors: {} as FleetSetupSubsystem['executors'],
      firstRunAtBoot: async () => ({ kind: 'skipped' }) as never,
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
  it('should answer the three reads through the shared schema and never let one be cached', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const paths = ['/v1/fleet/setup/scan', '/v1/fleet/export', '/v1/fleet/migration'];

    // Act
    const responses = await Promise.all(paths.map(async path => await dispatcher(subsystem).dispatch(get(path))));

    // Assert
    should(responses.map(response => response.status)).deepEqual([200, 200, 200]);
    should(responses.map(response => response.headers.get('cache-control'))).deepEqual([
      'no-store',
      'no-store',
      'no-store',
    ]);
    should(jsonBody(responses[0] as never)).deepEqual(SCAN);
    should(jsonBody(responses[1] as never)).deepEqual(BUNDLE);
    should(jsonBody(responses[2] as never)).deepEqual(MIGRATION);
    should([calls.scans, calls.exports, calls.views]).deepEqual([1, 1, 1]);
  });

  it('should hand a tool install its request and the caller governance, and never cache the answer', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const body = { harnesses: ['claude'], operatorPassword: 'correct horse battery' };

    // Act
    const response = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/machine/tools/install', JSON.stringify(body)),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual(INSTALL);
    should(calls.installs.map(call => call.request)).deepEqual([body as FleetToolInstallRequest]);
    should(calls.installs[0]?.governance).containDeep({ confirmChange: false });
  });

  it('should hand a migration its digest and the caller governance, and never cache the answer', async () => {
    // Arrange
    const { subsystem, calls } = stub();
    const body = { digest: 'abc123' };

    // Act
    const response = await dispatcher(subsystem).dispatch(post('/v1/fleet/migration/apply', JSON.stringify(body)));

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual(OUTCOME);
    should(calls.migrations.map(call => call.request)).deepEqual([body]);
    should(calls.migrations[0]?.governance).containDeep({ confirmChange: false });
  });

  it('should answer 403 for a caller who could not confirm and 409 with the code for every other refusal', async () => {
    // Arrange
    const { subsystem } = stub({
      scan: async () => {
        throw new FleetSetupRefusal('fleet_setup_unauthorized', 'the operator password is wrong');
      },
      migration: async () => {
        throw new FleetSetupRefusal('fleet_setup_unreadable', 'config.yaml could not be read');
      },
      exportBundle: async () => {
        throw new FleetSetupRefusal('fleet_setup_busy', 'another change is being applied');
      },
    });

    // Act
    const unauthorized = await dispatcher(subsystem).dispatch(get('/v1/fleet/setup/scan'));
    const unreadable = await dispatcher(subsystem).dispatch(get('/v1/fleet/migration'));
    const busy = await dispatcher(subsystem).dispatch(get('/v1/fleet/export'));

    // Assert
    should(unauthorized.status).equal(403);
    should(jsonBody(unauthorized)).deepEqual({
      error: 'the operator password is wrong',
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
    const badMigration = await dispatcher(subsystem).dispatch(
      post('/v1/fleet/migration/apply', JSON.stringify({ digest: '' })),
    );

    // Assert
    should(badInstall.status).equal(400);
    should(jsonBody(badInstall).code).equal('invalid_request');
    should(badMigration.status).equal(400);
    should(calls.installs).have.length(0);
    should(calls.migrations).have.length(0);
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
