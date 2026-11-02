import { describe, it } from 'bun:test';
import {
  LOCAL_SKILL_REFUSALS,
  type CatalogInstallScope,
  type LocalSkillRefusal,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance, CapabilityDemand } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { FleetCatalogRefusal } from '../../../../src/lib/fleet/catalog-service.ts';
import { LocalSkillRefusalError } from '../../../../src/lib/local-skill-installs/ports.ts';
import type { LocalSkillCaller } from '../../../../src/lib/local-skill-installs/service.ts';
import { LocalSkillInstallStateError } from '../../../../src/lib/local-skill-installs/store.ts';
import {
  type LocalSkillInstallSubsystem,
  localSkillInstallRoutes,
} from '../../../../src/lib/runtime/mounts/local-skill-installs.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';

/**
 * `/v1/skill-installs/local`: the seven routes, driven as the dispatcher would drive them. What is asserted
 * is the route's own contract — a ferret is refused on every one, what a governed device must prove, and how
 * each refusal is worded in HTTP. The copy itself is the service's, proven in its own unit tests.
 */

const INSTALL = `lsi_${'i'.repeat(22)}`;
const PREVIEW = `lsp_${'p'.repeat(22)}`;

interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  readonly governed: boolean;
  readonly proofs?: number;
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
  readonly caller?: LocalSkillCaller;
  readonly scope?: CatalogInstallScope;
  readonly argument?: unknown;
  readonly governance?: CallerGovernance;
}

class FakeInstalls implements LocalSkillInstallSubsystem {
  readonly calls: Call[] = [];
  failure: unknown;

  async list() {
    this.#record({ act: 'list' });
    return { installs: [] };
  }
  async preview(scope: CatalogInstallScope, req: unknown, caller: LocalSkillCaller) {
    this.#record({ act: 'preview', scope, argument: req, caller });
    return { previewId: PREVIEW } as never;
  }
  async apply(
    scope: CatalogInstallScope,
    previewId: string,
    caller: LocalSkillCaller,
    governance: CallerGovernance | undefined,
  ) {
    this.#record({
      act: 'apply',
      scope,
      argument: previewId,
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
  subsystem: LocalSkillInstallSubsystem,
  method: string,
  path: string,
  body: unknown,
  caller: Caller = HOST,
  reads = bodyReads(),
  proofs: { left: number } = { left: caller.proofs ?? 0 },
): Promise<Answer> {
  const found = new ApiRouter(localSkillInstallRoutes(subsystem)).lookup(method, path);
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
      decide: (_demand: CapabilityDemand) => ({ allowed: true, refusal: 'granted' }),
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
  source: { path: '/home/me/.claude/skills/demo/SKILL.md' },
  target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
};
const APPLY = { previewId: PREVIEW };

describe('the route table', () => {
  const routes = localSkillInstallRoutes(new FakeInstalls());

  const table = [
    ['POST', '/v1/skill-installs/local/project/preview', 'filesystem', 'use'],
    ['POST', '/v1/skill-installs/local/runtime/preview', 'fleet', 'use'],
    ['POST', '/v1/skill-installs/local/project', 'filesystem', 'configure'],
    ['POST', '/v1/skill-installs/local/runtime', 'fleet', 'configure'],
    ['GET', '/v1/skill-installs/local', 'fleet', 'use'],
    ['DELETE', '/v1/skill-installs/local/project/:installId', 'filesystem', 'configure'],
    ['DELETE', '/v1/skill-installs/local/runtime/:installId', 'fleet', 'configure'],
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

describe('previewing and listing', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews on the ${scope} route and hands the service the parsed request`, async () => {
      const installs = new FakeInstalls();
      const target =
        scope === 'project' ? PREVIEW_BODY.target : { scope: 'runtime', runtime: 'claude-work', profile: 'work' };

      const answer = await drive(installs, 'POST', `/v1/skill-installs/local/${scope}/preview`, {
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

    const listed = await drive(installs, 'GET', '/v1/skill-installs/local', undefined, DEVICE);
    const previewed = await drive(installs, 'POST', '/v1/skill-installs/local/project/preview', PREVIEW_BODY, DEVICE);

    should(listed.body).deepEqual({ installs: [] });
    should(previewed.status).equal(200);
  });

  it('refuses a body that is not a preview request, naming nothing to the service', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/skill-installs/local/project/preview', { source: 1 });

    should(answer.status).equal(400);
    should(installs.calls).deepEqual([]);
  });
});

describe('a ferret on any of them', () => {
  const attempts = [
    ['POST', '/v1/skill-installs/local/project/preview', PREVIEW_BODY],
    ['POST', '/v1/skill-installs/local/runtime/preview', PREVIEW_BODY],
    ['POST', '/v1/skill-installs/local/project', APPLY],
    ['POST', '/v1/skill-installs/local/runtime', APPLY],
    ['GET', '/v1/skill-installs/local', undefined],
    ['DELETE', `/v1/skill-installs/local/project/${INSTALL}`, undefined],
    ['DELETE', `/v1/skill-installs/local/runtime/${INSTALL}`, undefined],
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

      const answer = await drive(installs, 'POST', `/v1/skill-installs/local/${scope}`, APPLY, DEVICE);

      should(answer.status).equal(403);
      should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
      should(answer.body.demand).deepEqual(demand[scope]);
      should(installs.calls).deepEqual([]);
    });
  }

  it('applies for a device that proved it, claiming the proof once, with the preview id', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/skill-installs/local/project', APPLY, FRESH_DEVICE);

    should(answer.status).equal(200);
    should(answer.claimed).equal(1);
    should(installs.calls[0]?.argument).equal(PREVIEW);
    should(installs.calls[0]?.governance?.governed).equal(true);
  });

  it('applies at once for the machine itself, which is ungoverned', async () => {
    const installs = new FakeInstalls();

    const answer = await drive(installs, 'POST', '/v1/skill-installs/local/runtime', APPLY, { ...HOST, proofs: 1 });

    should(answer.status).equal(200);
    should(answer.claimed).equal(0);
  });

  it('refuses a body that is not an apply request', async () => {
    const answer = await drive(new FakeInstalls(), 'POST', '/v1/skill-installs/local/runtime', { previewId: 'nope' });

    should(answer.status).equal(400);
  });

  it('never asks for one to remove, which is the safe direction', async () => {
    const installs = new FakeInstalls();

    const project = await drive(installs, 'DELETE', `/v1/skill-installs/local/project/${INSTALL}`, undefined, DEVICE);
    const runtime = await drive(installs, 'DELETE', `/v1/skill-installs/local/runtime/${INSTALL}`, undefined, DEVICE);

    should([project.status, runtime.status]).deepEqual([200, 200]);
    should(installs.calls.map(call => [call.act, call.scope, call.argument])).deepEqual([
      ['remove', 'project', INSTALL],
      ['remove', 'runtime', INSTALL],
    ]);
  });

  it('refuses an install id that is not one, before the service is asked', async () => {
    const installs = new FakeInstalls();

    for (const id of ['nope', '%E0%A4%A', `lsi_${'i'.repeat(21)}`]) {
      const answer = await drive(installs, 'DELETE', `/v1/skill-installs/local/project/${id}`, undefined);

      should(answer.status).equal(400);
      should(answer.code).equal('invalid_install_id');
    }
    should(installs.calls).deepEqual([]);
  });
});

describe('who is asking, as a preview and its apply must agree', () => {
  it('names a paired device by its id and the machine’s own shell as the host', async () => {
    const installs = new FakeInstalls();

    await drive(installs, 'POST', '/v1/skill-installs/local/project', APPLY, { ...DEVICE, proofs: 1 });
    await drive(installs, 'POST', '/v1/skill-installs/local/project', APPLY, HOST);

    should(installs.calls.map(call => call.caller)).deepEqual([{ id: 'device:d1' }, { id: 'host' }]);
  });
});

describe('how a refusal is worded in HTTP', () => {
  const STATUS: Readonly<Record<LocalSkillRefusal, number>> = {
    local_skill_source_unknown: 404,
    local_skill_source_invalid: 422,
    local_skill_target_unknown: 404,
    local_skill_preview_unknown: 404,
    local_skill_preview_expired: 410,
    local_skill_conflict: 409,
    local_skill_install_unknown: 404,
  };

  for (const code of LOCAL_SKILL_REFUSALS) {
    it(`answers ${code} with ${STATUS[code]}, the code and the service's own sentence`, async () => {
      const installs = new FakeInstalls();
      installs.failure = new LocalSkillRefusalError(code, `because ${code}`);

      const answer = await drive(installs, 'POST', '/v1/skill-installs/local/project/preview', PREVIEW_BODY);

      should(answer.status).equal(STATUS[code]);
      should(answer.code).equal(code);
      should(answer.body.error).equal(`because ${code}`);
    });
  }

  it('answers a fleet change that is gone with 404 and any other fleet refusal with 409', async () => {
    const installs = new FakeInstalls();

    installs.failure = new FleetCatalogRefusal('fleet_change_unknown', 'gone');
    const gone = await drive(installs, 'POST', '/v1/skill-installs/local/runtime', APPLY);
    installs.failure = new FleetCatalogRefusal('fleet_change_stale', 'stale');
    const stale = await drive(installs, 'POST', '/v1/skill-installs/local/runtime', APPLY);

    should([gone.status, gone.code]).deepEqual([404, 'fleet_change_unknown']);
    should([stale.status, stale.code]).deepEqual([409, 'fleet_change_stale']);
  });

  it('answers a state file it cannot read with 500 and says so, never as "no copies"', async () => {
    const installs = new FakeInstalls();
    installs.failure = new LocalSkillInstallStateError('local-skill-installs.json is damaged');

    const answer = await drive(installs, 'GET', '/v1/skill-installs/local', undefined);

    should(answer.status).equal(500);
    should(answer.code).equal('local_skill_installs_unreadable');
  });

  it('lets an error it does not know travel on, to be a 500 the dispatcher logs', async () => {
    const installs = new FakeInstalls();
    installs.failure = new TypeError('a bug');

    let thrown: unknown;
    try {
      await drive(installs, 'GET', '/v1/skill-installs/local', undefined);
    } catch (error) {
      thrown = error;
    }

    should(thrown).be.instanceOf(TypeError);
  });
});
