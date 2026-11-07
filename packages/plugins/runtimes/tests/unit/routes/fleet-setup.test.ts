/**
 * A machine's setup at the daemon's front door: the scan, the tool install and the clone export
 * (docs/design/account-model.md §4.3, §4.7, §7).
 *
 * The service behind it is a stub, because what the routes own is the HTTP shape: that each route calls
 * its one subsystem method, that every answer is parsed through the contract's schema, which status a
 * refusal becomes, and that a write is handed the caller's governance rather than deciding it.
 */
import { describe, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import type {
  CloneBundle,
  CloneKeysRecordRequest,
  CloneReview,
  CloneReviewRequest,
  SetupScan,
  ToolInstallRequest,
  ToolInstallResult,
} from '../../../contract/index.ts';
import type { RuntimesAssembly } from '../../../daemon/index.ts';
import { mcpOAuthSecretNames } from '../../../daemon/lib/foreign.ts';
import { FleetSetupRefusal } from '../../../daemon/lib/service/setup-service.ts';
import { type Hosted, hostRuntimes } from './support.ts';

const SCAN: SetupScan = {
  machine: 'studio',
  format: 'present',
  tools: [{ harness: 'claude-code', label: 'Claude Code', installed: true }],
  harnesses: [],
  runtimes: [],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
};

const INSTALL: ToolInstallResult = { outcomes: [{ harness: 'claude-code', outcome: 'already-installed' }] };

const BUNDLE: CloneBundle = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'studio',
  daemon: `fy_daemon_${'d'.repeat(43)}`,
  exportedAt: instantFromEpochMs(1_794_052_800_000),
  credentials: [],
  components: {},
  profiles: {},
  runtimes: {},
  files: [],
  notCopied: [],
  keys: {},
};

const REVIEW: CloneReview = {
  mode: 'update',
  source: { name: 'studio', verified: 'browser' },
  items: [],
  settings: [],
  logins: [],
  keys: [],
  same: { count: 2, probable: 0 },
  fingerprint: 'f'.repeat(64),
};

type SetupStub = RuntimesAssembly['setup'];

interface Calls {
  scans: number;
  exports: number;
  reviews: number;
  forgets: string[];
  reviewed: { request: CloneReviewRequest; governance: unknown }[];
  installs: { request: ToolInstallRequest; governance: unknown }[];
}

function stub(overrides: Partial<SetupStub> = {}): { assembly: RuntimesAssembly; calls: Calls } {
  const calls: Calls = { scans: 0, exports: 0, reviews: 0, forgets: [], reviewed: [], installs: [] };
  const setup: SetupStub = {
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
    executors: {} as SetupStub['executors'],
    ...overrides,
  };
  return {
    calls,
    assembly: {
      catalog: {} as RuntimesAssembly['catalog'],
      setup,
      recommend: { recommend: async () => await Promise.reject(new Error('not used here')) },
      logins: {
        list: async () => ({ logins: [] }),
        signOut: async () => await Promise.reject(new Error('not used here')),
      },
    },
  };
}

const json = <T = Record<string, unknown>>(response: { json<U>(): U }): T => response.json<T>();
const post = async (hosted: Hosted, path: string, body?: unknown) =>
  await hosted.host.request('POST', path, body === undefined ? {} : { body });

describe('the fleet setup mount', () => {
  it('should answer the two reads through the shared schema and never let one be cached', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const { host } = await hostRuntimes(assembly);
    const paths = ['/v1/runtimes/setup/scan', '/v1/runtimes/export'];

    // Act
    const responses = await Promise.all(paths.map(async path => await host.request('GET', path)));

    // Assert
    should(responses.map(response => response.status)).deepEqual([200, 200]);
    should(responses.map(response => response.headers.get('cache-control'))).deepEqual(['no-store', 'no-store']);
    should(json(responses[0] as never)).deepEqual(SCAN);
    should(json(responses[1] as never)).deepEqual(JSON.parse(JSON.stringify(BUNDLE)));
    should([calls.scans, calls.exports]).deepEqual([1, 1]);
  });

  it('should answer a clone review through the shared schema, uncached, and refuse a body that is not one', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    // Act
    const answered = await post(hosted, '/v1/runtimes/clone/review', { bundle: BUNDLE });
    const bad = await post(hosted, '/v1/runtimes/clone/review', { nope: 1 });

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(json(answered)).deepEqual(REVIEW);
    should(bad.status).equal(400);
    should(calls.reviews).equal(1);
  });

  it('should forget a source through the shared schema, uncached, and say whether there was one', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    // Act
    const known = await post(hosted, '/v1/runtimes/clone/forget', { source: 'studio' });
    const unknown = await post(hosted, '/v1/runtimes/clone/forget', { source: 'nobody' });
    const bad = await post(hosted, '/v1/runtimes/clone/forget', { source: '' });

    // Assert
    should(known.headers.get('cache-control')).equal('no-store');
    should(json(known)).deepEqual({ forgotten: true });
    should(json(unknown)).deepEqual({ forgotten: false });
    should(bad.status).equal(400);
    should(calls.forgets).deepEqual(['studio', 'nobody']);
  });

  it('should answer 409 when more than one source goes by the name given', async () => {
    // Arrange
    const { assembly } = stub({
      forgetCloneSource: async () => {
        throw new FleetSetupRefusal('fleet_setup_refused', 'More than one source is called studio: a, b.');
      },
    });
    const hosted = await hostRuntimes(assembly);

    // Act
    const answer = await post(hosted, '/v1/runtimes/clone/forget', { source: 'studio' });

    // Assert
    should(answer.status).equal(409);
    should(json(answer).code).equal('fleet_setup_refused');
  });

  it('should hand a clone review the caller governance and the settings documents, so each file can be checked for THEM', async () => {
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    const settings = [
      { path: 'warden.yaml', text: 'enabled: true\n' },
      { path: 'controls', text: '{"agentPermissions":"auto"}' },
    ];

    const answered = await post(hosted, '/v1/runtimes/clone/review', { bundle: BUNDLE, settings });

    should(answered.status).equal(200);
    should(calls.reviewed[0]?.request.settings).deepEqual(settings as never);
    should(calls.reviewed[0]?.governance).containDeep({ governed: false });
  });

  it('should refuse a review whose settings name a document a copy does not merge', async () => {
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    for (const settings of [
      [{ path: 'machine.yaml', text: 'agentPermissions: skip\n' }],
      [{ path: '../../etc/passwd', text: '' }],
      [{ path: 'warden.yaml', text: 'x', extra: 1 }],
    ]) {
      const bad = await post(hosted, '/v1/runtimes/clone/review', { bundle: BUNDLE, settings });
      should(bad.status).equal(400);
    }
    should(calls.reviews).equal(0);
  });

  it('should record the keys a sealed copy filed through the shared schema, and refuse a sign-in token by name', async () => {
    // Arrange
    const seen: CloneKeysRecordRequest[] = [];
    const { assembly } = stub({
      recordCloneKeys: async request => {
        seen.push(request);
        return { recorded: request.keys.length };
      },
    });
    const hosted = await hostRuntimes(assembly);
    const body = {
      source: { daemonId: 'daemon-source' },
      filedAt: '2026-10-12T08:00:00.000Z',
      keys: [{ name: 'GLM_API_KEY', sourceUpdatedAt: '2026-10-10T08:00:00.000Z' }],
    };
    const signIn = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;

    // Act
    const answered = await post(hosted, '/v1/runtimes/clone/keys', body);
    const refused = await post(hosted, '/v1/runtimes/clone/keys', {
      ...body,
      keys: [{ name: signIn, sourceUpdatedAt: body.keys[0]?.sourceUpdatedAt }],
    });
    const extra = await post(hosted, '/v1/runtimes/clone/keys', {
      ...body,
      keys: [{ ...body.keys[0], value: 'sk-live-0123456789' }],
    });

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(json(answered)).deepEqual({ recorded: 1 });
    should(seen).have.length(1);
    should(refused.status).equal(400);
    should(extra.status).equal(400);
    // The instant the copy filed them is what the record is anchored on: a report without it is refused.
    const { filedAt: _omitted, ...withoutInstant } = body;
    const unanchored = await post(hosted, '/v1/runtimes/clone/keys', withoutInstant);
    should(unanchored.status).equal(400);
  });

  it('should hand a tool install its request and the caller governance, and never cache the answer', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);
    const body = { harnesses: ['claude-code'] };

    // Act
    const response = await post(hosted, '/v1/runtimes/machine/tools/install', body);

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(json(response)).deepEqual(INSTALL);
    should(calls.installs.map(call => call.request)).deepEqual([body as ToolInstallRequest]);
    should(calls.installs[0]?.governance).containDeep({ governed: false });
  });

  it('should answer 403 for a caller who could not confirm and 409 with the code for every other refusal', async () => {
    // Arrange
    const { assembly } = stub({
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
    const hosted = await hostRuntimes(assembly);

    // Act
    const unauthorized = await hosted.host.request('GET', '/v1/runtimes/setup/scan');
    const unreadable = await post(hosted, '/v1/runtimes/machine/tools/install', { harnesses: ['codex'] });
    const busy = await hosted.host.request('GET', '/v1/runtimes/export');

    // Assert
    should(unauthorized.status).equal(403);
    should(json(unauthorized)).deepEqual({
      error: 'confirm with your passkey first',
      code: 'fleet_setup_unauthorized',
    });
    should(unreadable.status).equal(409);
    should(json(unreadable)).deepEqual({ error: 'config.yaml could not be read', code: 'fleet_setup_unreadable' });
    should(busy.status).equal(409);
    should(json(busy).code).equal('fleet_setup_busy');
  });

  it('should refuse a body that does not match the schema before the service is asked', async () => {
    // Arrange
    const { assembly, calls } = stub();
    const hosted = await hostRuntimes(assembly);

    // Act
    const badInstall = await post(hosted, '/v1/runtimes/machine/tools/install', { harnesses: [] });

    // Assert
    should(badInstall.status).equal(400);
    should(json(badInstall).code).equal('invalid_request');
    should(calls.installs).have.length(0);
  });

  it('should leave an unexpected failure to the dispatcher rather than dress it as a refusal', async () => {
    // Arrange
    const { assembly } = stub({
      scan: async () => {
        throw new Error('the disk went away');
      },
    });
    const { host } = await hostRuntimes(assembly);

    // Act
    const response = await host.request('GET', '/v1/runtimes/setup/scan');

    // Assert
    should(response.status).equal(500);
  });
});
