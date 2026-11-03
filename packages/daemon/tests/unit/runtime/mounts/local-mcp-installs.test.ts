import { describe, it } from 'bun:test';
import {
  LOCAL_MCP_REFUSALS,
  type CatalogInstallScope,
  type LocalMcpRefusal,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance, CapabilityDemand } from '../../../../src/lib/api/capability.ts';
import { DEFAULT_CAPABILITY_GRANTS, decideCapability } from '../../../../src/lib/grants/policy.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetCatalogRefusal } from '../../../../src/lib/fleet/catalog-service.ts';
import { LocalMcpRefusalError } from '../../../../src/lib/local-mcp-installs/ports.ts';
import type { LocalMcpCaller } from '../../../../src/lib/local-mcp-installs/service.ts';
import { LocalMcpInstallStateError } from '../../../../src/lib/local-mcp-installs/store.ts';
import {
  type LocalMcpInstallSubsystem,
  localMcpInstallRoutes,
} from '../../../../src/lib/runtime/mounts/local-mcp-installs.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';

/**
 * `/v1/mcp-installs/local`: the seven routes, driven as the dispatcher would drive them. What is asserted
 * is the route's own contract — a ferret is refused on every one, what a governed device must prove, and how
 * each refusal is worded in HTTP. The copy itself is the service's, proven in its own unit tests.
 */

const INSTALL = `lmi_${'i'.repeat(22)}`;
const PREVIEW = `lmp_${'p'.repeat(22)}`;

interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  readonly governed: boolean;
  readonly proofs?: number;
  /** Capabilities whose `use` this caller's operator has switched off. */
  readonly off?: readonly string[];
}

const HOST: Caller = {
  actor: 'admin-cli',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
const DEVICE: Caller = {
  actor: 'device:d1',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  governed: true,
};
const FRESH_DEVICE: Caller = { ...DEVICE, proofs: 1 };
const FERRET: Caller = {
  actor: 'peer:s1',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};

interface Call {
  readonly act: string;
  readonly caller?: LocalMcpCaller;
  readonly scope?: CatalogInstallScope;
  readonly argument?: unknown;
  readonly governance?: CallerGovernance;
}

class FakeInstalls implements LocalMcpInstallSubsystem {
  readonly calls: Call[] = [];
  failure: unknown;
  installs: readonly unknown[] = [];

  async list() {
    this.#record({ act: 'list' });
    return { installs: this.installs } as never;
  }
  async preview(scope: CatalogInstallScope, req: unknown, caller: LocalMcpCaller) {
    this.#record({ act: 'preview', scope, argument: req, caller });
    return { previewId: PREVIEW } as never;
  }
  async apply(
    scope: CatalogInstallScope,
    previewId: string,
    bindings: unknown,
    caller: LocalMcpCaller,
    governance: CallerGovernance | undefined,
  ) {
    this.#record({
      act: 'apply',
      scope,
      argument: { previewId, bindings },
      caller,
      ...(governance === undefined ? {} : { governance }),
    });
    return { install: { installId: INSTALL }, notes: [] } as never;
  }
  async remove(scope: CatalogInstallScope, installId: string, governance: CallerGovernance | undefined) {
    this.#record({ act: 'remove', scope, argument: installId, ...(governance === undefined ? {} : { governance }) });
    return { installId: INSTALL } as never;
  }
  #record(call: Call): void {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
  }
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly code?: string;
  readonly claimed: number;
  readonly spent: number;
}

async function drive(
  subsystem: LocalMcpInstallSubsystem,
  method: string,
  path: string,
  body: unknown,
  caller: Caller = HOST,
  reads = bodyReads(),
  proofs: { left: number } = { left: caller.proofs ?? 0 },
): Promise<Answer> {
  const found = new ApiRouter(localMcpInstallRoutes(subsystem)).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  let claimed = 0;
  let spent = 0;
  const context: RouteContext = {
    request: request({
      method,
      path,
      headers: { 'content-type': 'application/json' },
      reads,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: found.params,
    actor: caller.actor,
    credential: caller.credential,
    governance: {
      governed: caller.governed,
      decide: (demand: CapabilityDemand) =>
        caller.off?.includes(demand.capability) === true
          ? { allowed: false, refusal: 'not-granted' }
          : { allowed: true, refusal: 'granted' },
    } as CallerGovernance,
    presentation: {
      loopback: !caller.governed,
      adminToken: caller.credential.tokenClass === 'admin',
      actor: caller.actor,
      stepUp: false,
      freshStepUp: false,
    },
    claimFreshStepUp: act => {
      if (act !== 'catalog-install' || proofs.left <= 0) return false;
      proofs.left -= 1;
      claimed += 1;
      return true;
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, claimed, spent };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message }, code: error.code, claimed, spent };
  }
}

const PREVIEW_BODY = {
  source: { id: 'a'.repeat(24) },
  target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
};
const APPLY = { previewId: PREVIEW, secretBindings: { API_TOKEN: 'MY_TOKEN', REGION: null } };

describe('the route table', () => {
  const routes = localMcpInstallRoutes(new FakeInstalls());

  const table = [
    ['POST', '/v1/mcp-installs/local/project/preview', 'filesystem', 'use'],
    ['POST', '/v1/mcp-installs/local/runtime/preview', 'filesystem', 'use'],
    ['POST', '/v1/mcp-installs/local/project', 'filesystem', 'configure'],
    ['POST', '/v1/mcp-installs/local/runtime', 'fleet', 'configure'],
    ['GET', '/v1/mcp-installs/local', 'fleet', 'use'],
    ['DELETE', '/v1/mcp-installs/local/project/:installId', 'filesystem', 'configure'],
    ['DELETE', '/v1/mcp-installs/local/runtime/:installId', 'fleet', 'configure'],
  ] as const;

  it('has exactly seven routes', () => {
    should(routes.length).equal(7);
  });

  for (const [method, path, capability, axis] of table) {
    it(`${method} ${path} is the operator’s, a person’s, uncached, behind ${capability}.${axis}`, () => {
      const found = routes.find(route => route.method === method && route.path === path);

      should(found?.minimum).equal('operator');
      should(found?.caller).equal('person');
      should(found?.noStore).equal(true);
      should(found?.capability).deepEqual({ capability, axis });
    });
  }
});

describe('what a governed caller may do with the filesystem or the fleet switched off', () => {
  const routes = localMcpInstallRoutes(new FakeInstalls());
  const demandOf = (method: string, path: string): CapabilityDemand => {
    const found = routes.find(route => route.method === method && route.path === path);
    if (found?.capability === undefined) throw new Error(`no governed route ${method} ${path}`);
    return found.capability;
  };
  const decide = (demand: CapabilityDemand, grants: Partial<Record<string, { use: boolean; configure: boolean }>>) =>
    decideCapability(demand, {
      grants: { ...DEFAULT_CAPABILITY_GRANTS, ...grants },
      governed: true,
      hostLocal: false,
      stepUp: true,
    });

  for (const scope of ['project', 'runtime'] as const)
    it(`refuses the ${scope} preview when filesystem is off and fleet is on, because it reads files off this machine`, () => {
      const demand = demandOf('POST', `/v1/mcp-installs/local/${scope}/preview`);

      const answer = decide(demand, {
        filesystem: { use: false, configure: false },
        fleet: { use: true, configure: true },
      });

      should(answer).deepEqual({ allowed: false, refusal: 'not-granted' });
    });

  it('serves the runtime preview with filesystem.use alone, since reading is what it does', () => {
    const demand = demandOf('POST', '/v1/mcp-installs/local/runtime/preview');

    should(decide(demand, { fleet: { use: false, configure: false } }).allowed).equal(true);
  });

  it('asks a runtime apply for fleet.configure, which carries fleet.use with it, and refuses fleet.use alone', () => {
    const demand = demandOf('POST', '/v1/mcp-installs/local/runtime');

    should(demand).deepEqual({ capability: 'fleet', axis: 'configure' });
    should(decide(demand, { fleet: { use: true, configure: false } }).allowed).equal(false);
    should(decide(demand, { fleet: { use: false, configure: true } }).allowed).equal(false);
    should(decide(demand, { fleet: { use: true, configure: true } }).allowed).equal(true);
  });

  it('lists only the runtime copies for a caller whose filesystem is off, since a project row names files and their hashes', async () => {
    const installs = new FakeInstalls();
    installs.installs = [
      { installId: INSTALL, target: { scope: 'project' } },
      { installId: 'runtime-one', target: { scope: 'runtime' } },
    ];

    const narrowed = await drive(installs, 'GET', '/v1/mcp-installs/local', undefined, {
      ...DEVICE,
      off: ['filesystem'],
    });
    const whole = await drive(installs, 'GET', '/v1/mcp-installs/local', undefined, DEVICE);
    const host = await drive(installs, 'GET', '/v1/mcp-installs/local', undefined, HOST);

    should((narrowed.body.installs as { installId: string }[]).map(install => install.installId)).deepEqual([
      'runtime-one',
    ]);
    should((whole.body.installs as unknown[]).length).equal(2);
    should((host.body.installs as unknown[]).length).equal(2);
  });
});

describe('previewing and listing', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews on the ${scope} route and hands the service the parsed request`, async () => {
      const installs = new FakeInstalls();
      const target =
        scope === 'project' ? PREVIEW_BODY.target : { scope: 'runtime', runtime: 'claude-work', profile: 'work' };

      const answer = await drive(installs, 'POST', `/v1/mcp-installs/local/${scope}/preview`, {
        ...PREVIEW_BODY,
        target,
      });

      should(answer.status).equal(200);
      should(answer.body.previewId).equal(PREVIEW);
      should(installs.calls.map(call => [call.act, call.scope])).deepEqual([['preview', scope]]);
    });
  }

  it('lists, and never asks a governed device for a passkey just to preview', async () => {
    const installs = new FakeInstalls();

    const listed = await drive(installs, 'GET', '/v1/mcp-installs/local', undefined, DEVICE);
    const previewed = await drive(installs, 'POST', '/v1/mcp-installs/local/project/preview', PREVIEW_BODY, DEVICE);

    should(listed.body).deepEqual({ installs: [] });
    should(previewed.status).equal(200);
  });

  it('refuses a body that is not a preview request, naming nothing to the service', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/mcp-installs/local/project/preview', { source: 1 });

    should(answer.status).equal(400);
    should(installs.calls).deepEqual([]);
  });
});

describe('a ferret on any of them', () => {
  const attempts = [
    ['POST', '/v1/mcp-installs/local/project/preview', PREVIEW_BODY],
    ['POST', '/v1/mcp-installs/local/runtime/preview', PREVIEW_BODY],
    ['POST', '/v1/mcp-installs/local/project', APPLY],
    ['POST', '/v1/mcp-installs/local/runtime', APPLY],
    ['GET', '/v1/mcp-installs/local', undefined],
    ['DELETE', `/v1/mcp-installs/local/project/${INSTALL}`, undefined],
    ['DELETE', `/v1/mcp-installs/local/runtime/${INSTALL}`, undefined],
  ] as const;

  for (const [method, path, body] of attempts)
    it(`is refused with 403 forbidden on ${method} ${path}, before the body is read`, async () => {
      const installs = new FakeInstalls();
      const reads = bodyReads();

      const answer = await drive(installs, method, path, body, FERRET, reads);

      should(answer.status).equal(403);
      should(answer.code).equal('forbidden');
      should(reads.limits).deepEqual([]);
      should(installs.calls).deepEqual([]);
    });
});

describe('the passkey for this act', () => {
  const demand = {
    project: { capability: 'filesystem', axis: 'configure', act: STEP_UP_ACTS.catalogInstall },
    runtime: { capability: 'fleet', axis: 'configure', act: STEP_UP_ACTS.catalogInstall },
  } as const;

  for (const scope of ['project', 'runtime'] as const) {
    it(`asks a governed ${scope} apply for it, and the service is not reached`, async () => {
      const installs = new FakeInstalls();

      const answer = await drive(installs, 'POST', `/v1/mcp-installs/local/${scope}`, APPLY, DEVICE);

      should(answer.status).equal(403);
      should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
      should(answer.body.demand).deepEqual(demand[scope]);
      should(installs.calls).deepEqual([]);
    });
  }

  it('applies for a device that proved it, claiming the proof once, with the preview id', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/mcp-installs/local/project', APPLY, FRESH_DEVICE);

    should(answer.status).equal(200);
    should(answer.claimed).equal(1);
    should(installs.calls[0]?.argument).deepEqual({ previewId: PREVIEW, bindings: APPLY.secretBindings });
    should(installs.calls[0]?.governance?.governed).equal(true);
  });

  it('applies at once for the machine itself, which is ungoverned', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/mcp-installs/local/runtime', APPLY, { ...HOST, proofs: 1 });

    should(answer.status).equal(200);
    should(answer.claimed).equal(0);
  });

  it('refuses an apply that carries a secret value in place of a name, or an unknown field', async () => {
    const withValue = await drive(new FakeInstalls(), 'POST', '/v1/mcp-installs/local/runtime', {
      previewId: PREVIEW,
      secretBindings: { API_TOKEN: 'not a secret name!' },
    });
    const extra = await drive(new FakeInstalls(), 'POST', '/v1/mcp-installs/local/runtime', { ...APPLY, extra: 1 });

    should([withValue.status, extra.status]).deepEqual([400, 400]);
  });

  it('refuses a body that is not an apply request', async () => {
    const answer = await drive(new FakeInstalls(), 'POST', '/v1/mcp-installs/local/runtime', { previewId: 'nope' });

    should(answer.status).equal(400);
  });

  it('never asks for one to remove, which is the safe direction', async () => {
    const installs = new FakeInstalls();

    const project = await drive(installs, 'DELETE', `/v1/mcp-installs/local/project/${INSTALL}`, undefined, DEVICE);
    const runtime = await drive(installs, 'DELETE', `/v1/mcp-installs/local/runtime/${INSTALL}`, undefined, DEVICE);

    should([project.status, runtime.status]).deepEqual([200, 200]);
    should(installs.calls.map(call => [call.act, call.scope, call.argument])).deepEqual([
      ['remove', 'project', INSTALL],
      ['remove', 'runtime', INSTALL],
    ]);
  });

  it('refuses an install id that is not one, before the service is asked', async () => {
    const installs = new FakeInstalls();

    for (const id of ['nope', '%E0%A4%A', `lmi_${'i'.repeat(21)}`]) {
      const answer = await drive(installs, 'DELETE', `/v1/mcp-installs/local/project/${id}`, undefined);

      should(answer.status).equal(400);
      should(answer.code).equal('invalid_install_id');
    }
    should(installs.calls).deepEqual([]);
  });
});

describe('whether the caller may be told which secrets are held', () => {
  it('says so for a device whose secrets are on and not for one whose secrets are switched off', async () => {
    const installs = new FakeInstalls();

    await drive(installs, 'POST', '/v1/mcp-installs/local/project/preview', PREVIEW_BODY, DEVICE);
    await drive(installs, 'POST', '/v1/mcp-installs/local/project/preview', PREVIEW_BODY, {
      ...DEVICE,
      off: ['secrets'],
    });

    should(installs.calls.map(call => call.caller?.mayListSecrets)).deepEqual([true, false]);
  });
});

describe('who is asking, as a preview and its apply must agree', () => {
  it('names a paired device by its id and the machine’s own shell as the host', async () => {
    const installs = new FakeInstalls();

    await drive(installs, 'POST', '/v1/mcp-installs/local/project', APPLY, { ...DEVICE, proofs: 1 });
    await drive(installs, 'POST', '/v1/mcp-installs/local/project', APPLY, HOST);

    should(installs.calls.map(call => call.caller)).deepEqual([
      { id: 'device:d1', mayListSecrets: true },
      { id: 'host', mayListSecrets: true },
    ]);
  });
});

describe('how a refusal is worded in HTTP', () => {
  const STATUS: Readonly<Record<LocalMcpRefusal, number>> = {
    local_mcp_source_unknown: 404,
    local_mcp_source_invalid: 422,
    local_mcp_target_unknown: 404,
    local_mcp_bindings_invalid: 422,
    local_mcp_preview_unknown: 404,
    local_mcp_preview_expired: 410,
    local_mcp_conflict: 409,
    local_mcp_install_unknown: 404,
  };

  for (const code of LOCAL_MCP_REFUSALS) {
    it(`answers ${code} with ${STATUS[code]}, the code and the service's own sentence`, async () => {
      const installs = new FakeInstalls();
      installs.failure = new LocalMcpRefusalError(code, `because ${code}`);

      const answer = await drive(installs, 'POST', '/v1/mcp-installs/local/project/preview', PREVIEW_BODY);

      should(answer.status).equal(STATUS[code]);
      should(answer.code).equal(code);
      should(answer.body.error).equal(`because ${code}`);
    });
  }

  it('answers a fleet change that is gone with 404 and any other fleet refusal with 409', async () => {
    const installs = new FakeInstalls();

    installs.failure = new FleetCatalogRefusal('fleet_change_unknown', 'gone');
    const gone = await drive(installs, 'POST', '/v1/mcp-installs/local/runtime', APPLY);
    installs.failure = new FleetCatalogRefusal('fleet_change_stale', 'stale');
    const stale = await drive(installs, 'POST', '/v1/mcp-installs/local/runtime', APPLY);

    should([gone.status, gone.code]).deepEqual([404, 'fleet_change_unknown']);
    should([stale.status, stale.code]).deepEqual([409, 'fleet_change_stale']);
  });

  it('answers a state file it cannot read with 500 and says so, never as "no copies"', async () => {
    const installs = new FakeInstalls();
    installs.failure = new LocalMcpInstallStateError('local-mcp-installs.json is damaged');

    const answer = await drive(installs, 'GET', '/v1/mcp-installs/local', undefined);

    should(answer.status).equal(500);
    should(answer.code).equal('local_mcp_installs_unreadable');
  });

  it('lets an error it does not know travel on, to be a 500 the dispatcher logs', async () => {
    const installs = new FakeInstalls();
    installs.failure = new TypeError('a bug');

    let thrown: unknown;
    try {
      await drive(installs, 'GET', '/v1/mcp-installs/local', undefined);
    } catch (error) {
      thrown = error;
    }

    should(thrown).be.instanceOf(TypeError);
  });
});
