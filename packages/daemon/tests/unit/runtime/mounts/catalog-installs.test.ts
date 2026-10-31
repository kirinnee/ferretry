import { describe, it } from 'bun:test';
import {
  CATALOG_INSTALL_PREVIEW_MAX_BODY_BYTES,
  CATALOG_INSTALL_REFUSALS,
  type CatalogInstallRefusal,
  type CatalogInstallScope,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance, CapabilityDemand } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { CatalogInstallRefusalError } from '../../../../src/lib/catalog-installs/ports.ts';
import type { CatalogCaller } from '../../../../src/lib/catalog-installs/service.ts';
import { CatalogInstallStateError } from '../../../../src/lib/catalog-installs/store.ts';
import { FleetCatalogRefusal } from '../../../../src/lib/fleet/catalog-service.ts';
import {
  type CatalogInstallSubsystem,
  catalogInstallRoutes,
} from '../../../../src/lib/runtime/mounts/catalog-installs.ts';
import { newIdentity, publish, skillItem } from '../../../support/catalog-fixtures.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';

/**
 * `/v1/catalog-installs`: the seven routes, driven as the dispatcher would drive them. What is asserted is
 * the route's own contract — who may reach it, what it demands of a governed device, how each refusal is
 * worded in HTTP, and that a passkey is spent only by an install that landed. The install itself is the
 * service's, proven in its own unit tests.
 */

const INSTALL = `cin_${'i'.repeat(22)}`;
const PREVIEW = `cip_${'p'.repeat(22)}`;

interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  readonly governed: boolean;
  /** How many passkey proofs for the act this device holds (default none). */
  readonly proofs?: number;
  /** What the governance says to a `secrets.use` demand (default: allowed). */
  readonly mayListSecrets?: boolean;
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
  readonly caller?: CatalogCaller;
  readonly scope?: CatalogInstallScope;
  readonly argument?: unknown;
  readonly governance?: CallerGovernance;
}

class FakeInstalls implements CatalogInstallSubsystem {
  readonly calls: Call[] = [];
  failure: unknown;

  async list() {
    this.#record({ act: 'list' });
    return { installs: [] };
  }
  async preview(scope: CatalogInstallScope, req: unknown, caller: CatalogCaller) {
    this.#record({ act: 'preview', scope, argument: req, caller });
    return PREVIEW_ANSWER;
  }
  async apply(
    scope: CatalogInstallScope,
    req: unknown,
    caller: CatalogCaller,
    governance: CallerGovernance | undefined,
  ) {
    this.#record({ act: 'apply', scope, argument: req, caller, ...(governance === undefined ? {} : { governance }) });
    await Promise.resolve();
    return INSTALLED_ANSWER;
  }
  async remove(scope: CatalogInstallScope, installId: string, governance: CallerGovernance | undefined) {
    this.#record({ act: 'remove', scope, argument: installId, ...(governance === undefined ? {} : { governance }) });
    return REMOVED_ANSWER;
  }
  #record(call: Call): void {
    this.calls.push(call);
    if (this.failure !== undefined) throw this.failure;
  }
}

const PREVIEW_ANSWER = { previewId: PREVIEW } as never;
const INSTALLED_ANSWER = { install: { installId: INSTALL }, notes: [] } as never;
const REMOVED_ANSWER = { installId: INSTALL } as never;

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly code?: string;
  readonly spent: number;
  readonly claimed: number;
}

async function drive(
  subsystem: CatalogInstallSubsystem,
  method: string,
  path: string,
  body: unknown,
  caller: Caller = HOST,
  headers: Record<string, string> = {},
  reads = bodyReads(),
  proofs: { left: number } = { left: caller.proofs ?? 0 },
): Promise<Answer> {
  const found = new ApiRouter(catalogInstallRoutes(subsystem)).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  let spent = 0;
  let claimed = 0;
  const context: RouteContext = {
    request: request({
      method,
      path,
      headers: { 'content-type': 'application/json', ...headers },
      reads,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    params: found.params,
    actor: caller.actor,
    credential: caller.credential,
    governance: {
      governed: caller.governed,
      decide: (demand: CapabilityDemand) =>
        demand.capability === 'secrets' && caller.mayListSecrets === false
          ? { allowed: false, refusal: 'denied' }
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
      // Only a proof stamped for THIS act counts, as the registry decides.
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
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, spent, claimed };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message }, code: error.code, spent, claimed };
  }
}

async function previewBody(): Promise<unknown> {
  const identity = await newIdentity();
  const item = skillItem(identity.daemonId);
  const published = await publish(identity, [item]);
  return {
    signedManifest: published.signedManifest,
    item,
    target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
  };
}

const APPLY = { previewId: PREVIEW, secretBindings: {} };

describe('the route table', () => {
  const routes = catalogInstallRoutes(new FakeInstalls());
  const route = (method: string, path: string) => routes.find(r => r.method === method && r.path === path);

  const table = [
    ['POST', '/v1/catalog-installs/project/preview', 'filesystem', 'use'],
    ['POST', '/v1/catalog-installs/runtime/preview', 'fleet', 'use'],
    ['POST', '/v1/catalog-installs/project', 'filesystem', 'configure'],
    ['POST', '/v1/catalog-installs/runtime', 'fleet', 'configure'],
    ['GET', '/v1/catalog-installs', 'fleet', 'use'],
    ['DELETE', '/v1/catalog-installs/project/:installId', 'filesystem', 'configure'],
    ['DELETE', '/v1/catalog-installs/runtime/:installId', 'fleet', 'configure'],
  ] as const;

  it('has exactly seven routes', () => {
    should(routes.length).equal(7);
  });

  for (const [method, path, capability, axis] of table) {
    it(`${method} ${path} is the operator's, uncached, behind ${capability}.${axis}`, () => {
      const found = route(method, path);

      should(found?.minimum).equal('operator');
      should(found?.noStore).equal(true);
      should(found?.capability).deepEqual({ capability, axis });
    });
  }
});

describe('previewing and listing, which write nothing', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews on the ${scope} route and hands the service the parsed request`, async () => {
      const installs = new FakeInstalls();
      const body = await previewBody();

      const answer = await drive(installs, 'POST', `/v1/catalog-installs/${scope}/preview`, body);

      should(answer.status).equal(200);
      should(answer.body.previewId).equal(PREVIEW);
      should(installs.calls.map(call => [call.act, call.scope])).deepEqual([['preview', scope]]);
    });
  }

  it('lets a ferret preview and list', async () => {
    const installs = new FakeInstalls();

    const previewed = await drive(
      installs,
      'POST',
      '/v1/catalog-installs/project/preview',
      await previewBody(),
      FERRET,
    );
    const listed = await drive(installs, 'GET', '/v1/catalog-installs', undefined, FERRET);

    should(previewed.status).equal(200);
    should(listed.status).equal(200);
    should(listed.body).deepEqual({ installs: [] });
  });

  it('never asks a governed device for a passkey just to preview', async () => {
    const answer = await drive(
      new FakeInstalls(),
      'POST',
      '/v1/catalog-installs/runtime/preview',
      await previewBody(),
      DEVICE,
    );

    should(answer.status).equal(200);
  });

  it('refuses a body that is not a preview request, naming nothing to the service', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/catalog-installs/project/preview', { item: 1 });

    should(answer.status).equal(400);
    should(installs.calls).deepEqual([]);
  });

  it('bounds the read at 16 MiB and refuses a declared body past it before reading a byte', async () => {
    const reads = bodyReads();
    const installs = new FakeInstalls();

    const answer = await drive(
      installs,
      'POST',
      '/v1/catalog-installs/project/preview',
      '{}',
      HOST,
      { 'content-length': String(CATALOG_INSTALL_PREVIEW_MAX_BODY_BYTES + 1) },
      reads,
    );

    should(answer.status).equal(413);
    should(reads.limits).deepEqual([CATALOG_INSTALL_PREVIEW_MAX_BODY_BYTES]);
    should(reads.consumed).be.false();
    should(installs.calls).deepEqual([]);
  });
});

describe('who may install and remove', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`refuses a ferret on ${scope} apply with 403 forbidden, before the body is read`, async () => {
      const installs = new FakeInstalls();
      const reads = bodyReads();

      const answer = await drive(installs, 'POST', `/v1/catalog-installs/${scope}`, APPLY, FERRET, {}, reads);

      should(answer.status).equal(403);
      should(answer.code).equal('forbidden');
      should(reads.limits).deepEqual([]);
      should(installs.calls).deepEqual([]);
    });

    it(`refuses a ferret on ${scope} remove with 403 forbidden`, async () => {
      const installs = new FakeInstalls();

      const answer = await drive(installs, 'DELETE', `/v1/catalog-installs/${scope}/${INSTALL}`, undefined, FERRET);

      should(answer.status).equal(403);
      should(answer.code).equal('forbidden');
      should(installs.calls).deepEqual([]);
    });
  }

  it('applies at once for the machine itself, which is ungoverned, and spends no step-up of its own', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/catalog-installs/project', APPLY);

    should(answer.status).equal(200);
    should(installs.calls[0]?.act).equal('apply');
    should(installs.calls[0]?.argument).deepEqual(APPLY);
    should(installs.calls[0]?.governance?.governed).equal(false);
  });

  it('refuses a body that is not an apply request', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/catalog-installs/runtime', { previewId: 'nope' });

    should(answer.status).equal(400);
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

      const answer = await drive(installs, 'POST', `/v1/catalog-installs/${scope}`, APPLY, DEVICE);

      should(answer.status).equal(403);
      should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
      should(answer.body.demand).deepEqual(demand[scope]);
      should(answer.spent).equal(0);
      should(installs.calls).deepEqual([]);
    });
  }

  it('applies for a device that proved it, claiming the proof once, at admission', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/catalog-installs/project', APPLY, FRESH_DEVICE);

    should(answer.status).equal(200);
    should(answer.claimed).equal(1);
    should(installs.calls[0]?.governance?.governed).equal(true);
  });

  it('lets one proof buy one install even when two applies race for it', async () => {
    const installs = new FakeInstalls();
    const proofs = { left: 1 };

    const [first, second] = await Promise.all([
      drive(installs, 'POST', '/v1/catalog-installs/project', APPLY, DEVICE, {}, bodyReads(), proofs),
      drive(installs, 'POST', '/v1/catalog-installs/runtime', APPLY, DEVICE, {}, bodyReads(), proofs),
    ]);

    should([first.status, second.status].sort()).deepEqual([200, 403]);
    should(first.claimed + second.claimed).equal(1);
    should(installs.calls.filter(call => call.act === 'apply')).have.length(1);
  });

  it('asks again for the proof once it is spent: it is not refunded when the install is refused', async () => {
    const installs = new FakeInstalls();
    installs.failure = new CatalogInstallRefusalError('catalog_install_conflict', 'in the way');
    const proofs = { left: 1 };

    const refused = await drive(
      installs,
      'POST',
      '/v1/catalog-installs/project',
      APPLY,
      DEVICE,
      {},
      bodyReads(),
      proofs,
    );
    const again = await drive(installs, 'POST', '/v1/catalog-installs/project', APPLY, DEVICE, {}, bodyReads(), proofs);

    should(refused.status).equal(409);
    should(again.status).equal(403);
    should(again.body.code).equal(STEP_UP_REQUIRED_CODE);
  });

  it('does not count the unlock (no proof for the act) as one, and names the act it wants', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/catalog-installs/runtime', APPLY, { ...DEVICE, proofs: 0 });

    should(answer.status).equal(403);
    should(answer.body.demand).deepEqual(demand.runtime);
    should(answer.claimed).equal(0);
    should(installs.calls).deepEqual([]);
  });

  it('claims no proof from the machine itself, which is ungoverned', async () => {
    const answer = await drive(new FakeInstalls(), 'POST', '/v1/catalog-installs/project', APPLY, {
      ...HOST,
      proofs: 1,
    });

    should(answer.status).equal(200);
    should(answer.claimed).equal(0);
  });

  it('never asks for one to remove, which is the safe direction', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'DELETE', `/v1/catalog-installs/runtime/${INSTALL}`, undefined, DEVICE);

    should(answer.status).equal(200);
    should(answer.body.installId).equal(INSTALL);
    should(answer.spent).equal(0);
    should(installs.calls[0]).match({ act: 'remove', scope: 'runtime', argument: INSTALL });
  });

  it('removes on the project route too', async () => {
    const installs = new FakeInstalls();

    await drive(installs, 'DELETE', `/v1/catalog-installs/project/${INSTALL}`, undefined);

    should(installs.calls[0]).match({ act: 'remove', scope: 'project', argument: INSTALL });
  });

  it('refuses an install id that is not one, before the service is asked', async () => {
    const installs = new FakeInstalls();

    for (const id of ['nope', '%E0%A4%A', `cin_${'i'.repeat(21)}`]) {
      const answer = await drive(installs, 'DELETE', `/v1/catalog-installs/project/${id}`, undefined);

      should(answer.status).equal(400);
      should(answer.code).equal('invalid_install_id');
    }
    should(installs.calls).deepEqual([]);
  });
});

describe('who is asking, as a preview and its apply must agree', () => {
  const callerOfApply = async (caller: Caller) => {
    const installs = new FakeInstalls();
    await drive(installs, 'POST', '/v1/catalog-installs/project', APPLY, { ...caller, proofs: 1 });
    return installs.calls[0]?.caller;
  };

  it('names a paired device by its id', async () => {
    should(await callerOfApply(DEVICE)).deepEqual({ id: 'device:d1', mayListSecrets: true });
  });

  it('names the machine’s own shell as the host', async () => {
    should(await callerOfApply(HOST)).deepEqual({ id: 'host', mayListSecrets: true });
  });

  it('names every ferret as one caller on a preview', async () => {
    const installs = new FakeInstalls();

    await drive(installs, 'POST', '/v1/catalog-installs/project/preview', await previewBody(), FERRET);

    should(installs.calls[0]?.caller).deepEqual({ id: 'agents', mayListSecrets: true });
  });

  it('says a caller may not list secret names when the grants do not let it', async () => {
    const installs = new FakeInstalls();

    await drive(installs, 'POST', '/v1/catalog-installs/project/preview', await previewBody(), {
      ...DEVICE,
      mayListSecrets: false,
    });

    should(installs.calls[0]?.caller).deepEqual({ id: 'device:d1', mayListSecrets: false });
  });
});

describe('how a refusal is worded in HTTP', () => {
  const STATUS: Readonly<Record<CatalogInstallRefusal, number>> = {
    catalog_signature_invalid: 422,
    catalog_item_mismatch: 422,
    catalog_publisher_changed: 409,
    catalog_revision_older: 409,
    catalog_downgrade: 409,
    catalog_item_invalid: 422,
    catalog_not_installable: 422,
    catalog_target_unknown: 404,
    catalog_preview_unknown: 404,
    catalog_preview_expired: 410,
    catalog_bindings_invalid: 422,
    catalog_install_conflict: 409,
    catalog_install_unknown: 404,
  };

  for (const code of CATALOG_INSTALL_REFUSALS) {
    it(`answers ${code} with ${STATUS[code]}, the code and the service's own sentence`, async () => {
      const installs = new FakeInstalls();
      installs.failure = new CatalogInstallRefusalError(code, `because ${code}`);

      const answer = await drive(installs, 'POST', '/v1/catalog-installs/project/preview', await previewBody());

      should(answer.status).equal(STATUS[code]);
      should(answer.code).equal(code);
      should(answer.body.error).equal(`because ${code}`);
    });
  }

  it('answers a fleet change that is gone with 404 and any other fleet refusal with 409', async () => {
    const installs = new FakeInstalls();

    installs.failure = new FleetCatalogRefusal('fleet_change_unknown', 'gone');
    const gone = await drive(installs, 'POST', '/v1/catalog-installs/runtime', APPLY);
    installs.failure = new FleetCatalogRefusal('fleet_change_stale', 'stale');
    const stale = await drive(installs, 'POST', '/v1/catalog-installs/runtime', APPLY);

    should([gone.status, gone.code]).deepEqual([404, 'fleet_change_unknown']);
    should([stale.status, stale.code]).deepEqual([409, 'fleet_change_stale']);
  });

  it('answers a state file it cannot read with 500 and says so, never as "no installs"', async () => {
    const installs = new FakeInstalls();
    installs.failure = new CatalogInstallStateError('catalog-installs.json is damaged');

    const answer = await drive(installs, 'GET', '/v1/catalog-installs', undefined);

    should(answer.status).equal(500);
    should(answer.code).equal('catalog_installs_unreadable');
    should(answer.body.error).equal('catalog-installs.json is damaged');
  });

  it('lets an error it does not know travel on, to be a 500 the dispatcher logs', async () => {
    const installs = new FakeInstalls();
    installs.failure = new TypeError('a bug');

    let thrown: unknown;
    try {
      await drive(installs, 'GET', '/v1/catalog-installs', undefined);
    } catch (error) {
      thrown = error;
    }

    should(thrown).be.instanceOf(TypeError);
  });
});
