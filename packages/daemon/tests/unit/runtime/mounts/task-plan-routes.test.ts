import { describe, it } from 'bun:test';
import {
  type AccountId,
  type AccountKey,
  type AccountSummary,
  type SignInSummary,
  STEP_UP_REQUIRED_CODE,
  type TaskPlanStageId,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiRoute } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { PasteRuleService, TaskPlanService } from '../../../../src/lib/index.ts';
import { secureCopyRoutes } from '../../../../src/lib/runtime/mounts/secure-copy.ts';
import { taskPlanRoutes } from '../../../../src/lib/runtime/mounts/task-plans.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, fromFerret, GRANTED, human, withoutGrant } from './support.ts';

/** The owner's task-plan routes through the real router and boundary, over the real plan and rule services. */

const SESSION = 'mvv6b4qw-49d0158d';
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const WORK = 'si_00000000000000a1';
const KEY = `L${'A'.repeat(24)}` as AccountKey;
const DEVICE = { kind: 'authenticated', tokenClass: 'device', deviceId: 'phone-1' } as AuthenticatedCredential;
const HOST = { kind: 'authenticated', tokenClass: 'admin' } as AuthenticatedCredential;

const LISTING = {
  accounts: [
    {
      id: 'GITHUB_WORK' as AccountId,
      label: 'GitHub work',
      username: 'kirin-work',
      fields: { password: true, totp: false },
      factors: [],
      signIns: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as unknown as AccountSummary,
  ],
  signIns: [
    {
      id: WORK,
      account: 'GITHUB_WORK',
      place: { kind: 'site', domains: ['github.com'], match: [] },
      method: { kind: 'password' },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as unknown as SignInSummary,
  ],
};

const PASTE = {
  kind: 'paste',
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  why: 'the deploy token',
} as const;
const SIGN_IN = { kind: 'sign-in', signIn: WORK, fields: ['username', 'password'], why: 'check Actions' } as const;

async function served(guard = GRANTED) {
  const ms = { now: NOW };
  const writes: unknown[] = [];
  const rules = new PasteRuleService({
    store: { read: async () => undefined, write: async next => void writes.push(next) },
    clock: { now: () => ms.now },
    ids: { ruleId: () => crypto.randomUUID().replaceAll('-', '') },
    warn: () => undefined,
  });
  await rules.load();
  let plans = 0;
  const service = new TaskPlanService({
    agenda: { raise: async () => ({ ok: true, id: `A${String(++plans)}` }), close: async () => undefined },
    rules,
    accounts: { listing: async () => LISTING, keyOf: async () => KEY },
    passkeys: { any: async () => true },
    redact: async text => text,
    tell: async () => undefined,
    audit: { record: async () => undefined },
    clock: { now: () => ms.now },
    ids: { planId: () => (plans + 1).toString(16).padStart(32, 'b') },
  });
  const routes = [...taskPlanRoutes(service), ...secureCopyRoutes({ list: () => [] }, rules, service)];
  const dispatch = new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, guard);
  return { service, rules, routes, dispatch, writes, ms };
}

const post = (path: string, body: unknown, headers: Readonly<Record<string, string>> = human, reads = bodyReads()) =>
  request({
    method: 'POST',
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    reads,
  });

const base = (planId: string) => `/v1/sessions/${SESSION}/task-plans/${planId}`;

/**
 * A route's handler called as the boundary would hand it over, with the caller's credential and its claim on a fresh
 * proof: `proofs` lists the (act, subject) pairs a passkey ceremony made, each taken once.
 */
async function handled(
  routes: readonly ApiRoute[],
  method: string,
  path: string,
  options: {
    readonly credential?: AuthenticatedCredential;
    readonly body?: unknown;
    readonly proofs?: { act: string; subject?: string }[];
  } = {},
) {
  const found = new ApiRouter(routes).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  const proofs = options.proofs ?? [];
  const credential = options.credential ?? HOST;
  try {
    const response = await found.route.handle({
      request: request({
        method,
        path,
        loopback: credential === HOST,
        privilegedLoopback: credential === HOST,
        headers: { 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      params: found.params,
      actor: credential === HOST ? 'admin-cli' : 'device:phone-1',
      credential,
      presentation: {
        loopback: credential === HOST,
        adminToken: credential === HOST,
        actor: 'x',
        stepUp: false,
        freshStepUp: false,
      },
      governance: { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) } as never,
      claimFreshStepUp: ((act: string, subject?: string) => {
        const index = proofs.findIndex(proof => proof.act === act && proof.subject === subject);
        if (index < 0) return false;
        proofs.splice(index, 1);
        return true;
      }) as never,
    });
    return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { code: error.code, error: error.message } as Record<string, unknown> };
  }
}

describe('the task-plan routes: a ferret never answers its own plan', () => {
  it('should refuse a ferret on every task-plan route and the kept paste-plan route, before reading a body', async () => {
    const { dispatch, service, writes } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN, PASTE] });
    const reads = bodyReads();
    const callers = [agentIn(SESSION), human] as const;

    const answers = [];
    for (const [index, headers] of callers.entries()) {
      const as = <T>(asked: T): T => (index === 1 ? fromFerret(asked as never) : asked);
      const stage = `tps_${'0'.repeat(24)}`;
      for (const asked of [
        request({ method: 'GET', path: '/v1/task-plans', headers }),
        request({ method: 'GET', path: base(plan.id), headers }),
        post(`${base(plan.id)}/approval`, { lines: [{ line: 1 }] }, headers, reads),
        request({ method: 'GET', path: `${base(plan.id)}/approval/${stage}`, headers }),
        post(`${base(plan.id)}/approval/${stage}/commit`, {}, headers, reads),
        post(`${base(plan.id)}/approval/${stage}/confirm-in-app`, {}, headers, reads),
        request({ method: 'DELETE', path: `${base(plan.id)}/approval/${stage}`, headers }),
        post(`${base(plan.id)}/revoke`, {}, headers, reads),
        post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }, headers, reads),
      ])
        answers.push(await dispatch.dispatch(as(asked)));
    }

    should(answers.map(answer => [answer.status, jsonBody(answer).code])).eql(answers.map(() => [403, 'owner_only']));
    should(reads.consumed).be.false();
    should(service.get({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id).state).equal('pending');
    should(writes).eql([]);
  });

  it('should have no route that edits a plan: no PUT or PATCH under task-plans', async () => {
    const { routes } = await served();

    const edits = routes.filter(route => route.path.includes('task-plans') && ['PUT', 'PATCH'].includes(route.method));

    should(edits).eql([]);
    should(
      routes
        .filter(route => route.path.includes('task-plans'))
        .map(route => `${route.method} ${route.path} ${route.caller} ${route.capability?.axis ?? 'none'}`),
    ).eql([
      'GET /v1/task-plans person use',
      'GET /v1/sessions/:sessionId/task-plans/:planId person use',
      'POST /v1/sessions/:sessionId/task-plans/:planId/approval person configure',
      'GET /v1/sessions/:sessionId/task-plans/:planId/approval/:stage person use',
      'POST /v1/sessions/:sessionId/task-plans/:planId/approval/:stage/commit person configure',
      'POST /v1/sessions/:sessionId/task-plans/:planId/approval/:stage/confirm-in-app person configure',
      'DELETE /v1/sessions/:sessionId/task-plans/:planId/approval/:stage person use',
      'POST /v1/sessions/:sessionId/task-plans/:planId/revoke person use',
    ]);
  });
});

describe('the task-plan routes: approving', () => {
  it('should approve paste lines from the machine at once, with no passkey, as a paste plan always was', async () => {
    const { dispatch, service, rules } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN, PASTE] });

    const answer = await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 1 }] }));

    should(answer.status).equal(200);
    should(jsonBody(answer)).match({ outcome: 'answered', plan: { state: 'approved', answered: { proof: 'none' } } });
    should(rules.list({ kind: 'owner', actor: { kind: 'host' } })).have.length(1);
  });

  it('should refuse the machine a ticked sign-in without a passkey proof, whatever its settings', async () => {
    const { dispatch, service } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN, PASTE] });

    const staged = await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 0 }, { line: 1 }] }));
    const stage = (jsonBody(staged).staged as { stage: string }).stage;
    const commit = await dispatch.dispatch(post(`${base(plan.id)}/approval/${stage}/commit`, {}));

    should(staged.status).equal(201);
    should(jsonBody(staged)).match({ outcome: 'staged', staged: { lines: [0, 1], plan: plan.id } });
    should(commit.status).equal(403);
    should(jsonBody(commit)).match({ code: STEP_UP_REQUIRED_CODE, demand: { act: 'approve-task-plan' } });
    should(service.get({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id).state).equal('pending');
  });

  it('should commit only with a fresh approve-task-plan proof bound to THIS stage, once', async () => {
    const { routes, service } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN] });
    const first = await handled(routes, 'POST', `${base(plan.id)}/approval`, {
      credential: DEVICE,
      body: { lines: [{ line: 0 }] },
    });
    const stageA = (first.body.staged as { stage: TaskPlanStageId }).stage;
    const subjectA = service.boundSubjectOf(stageA);
    const second = await handled(routes, 'POST', `${base(plan.id)}/approval`, {
      credential: DEVICE,
      body: { lines: [{ line: 0 }] },
    });
    const stageB = (second.body.staged as { stage: TaskPlanStageId }).stage;
    const subjectB = service.boundSubjectOf(stageB);
    const commit = async (proofs: { act: string; subject?: string }[]) =>
      await handled(routes, 'POST', `${base(plan.id)}/approval/${stageB}/commit`, { credential: DEVICE, proofs });

    const refusals = [
      await commit([]),
      await commit([{ act: 'approve-task-plan' }]),
      await commit([{ act: 'add-2fa-key', subject: subjectB }]),
      await commit([{ act: 'loosen-config' }]),
      await commit([{ act: 'approve-task-plan', subject: subjectA }]),
    ];
    const proved = await commit([{ act: 'approve-task-plan', subject: subjectB }]);
    const again = await commit([{ act: 'approve-task-plan', subject: subjectB }]);

    should(refusals.map(answer => [answer.status, answer.body.code])).eql(
      refusals.map(() => [403, STEP_UP_REQUIRED_CODE]),
    );
    should(proved).match({
      status: 200,
      body: { state: 'approved', answered: { proof: 'passkey', by: { kind: 'device' } } },
    });
    should(again).match({ status: 404, body: { code: 'stage_not_found' } });
  });

  it('should answer a stage that timed out, or one this daemon never made, as not waiting', async () => {
    const { routes, service, ms } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN] });
    const staged = await handled(routes, 'POST', `${base(plan.id)}/approval`, {
      credential: DEVICE,
      body: { lines: [{ line: 0 }] },
    });
    const stage = (staged.body.staged as { stage: TaskPlanStageId }).stage;
    const subject = service.boundSubjectOf(stage);
    ms.now += 121_000;

    const late = await handled(routes, 'POST', `${base(plan.id)}/approval/${stage}/commit`, {
      credential: DEVICE,
      proofs: [{ act: 'approve-task-plan', subject }],
    });
    const forged = await handled(routes, 'POST', `${base(plan.id)}/approval/not-a-stage/commit`, {
      credential: DEVICE,
    });

    should(late).match({ status: 404, body: { code: 'stage_not_found' } });
    should(forged).match({ status: 404, body: { code: 'stage_not_found' } });
  });

  it('should refuse a line outside the plan, and a body that names a place of its own', async () => {
    const { dispatch, service } = await served();
    const plan = await service.propose(SESSION, { lines: [PASTE] });

    const outside = await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 3 }] }));
    const place = await dispatch.dispatch(
      post(`${base(plan.id)}/approval`, { lines: [{ line: 0, origin: 'https://evil.example' }] }),
    );

    should([outside.status, place.status]).eql([400, 400]);
  });

  it('should need the browser grant to tick a page sign-in, as allowing one would', async () => {
    const { dispatch, service } = await served(withoutGrant({ capability: 'browser', axis: 'use' }));
    const plan = await service.propose(SESSION, { lines: [SIGN_IN, PASTE] });

    const page = await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 0 }] }));
    const paste = await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 1 }] }));

    should([page.status, paste.status]).eql([403, 200]);
  });

  it('should show a machine-staged selection on the plan card, and drop it with no change made', async () => {
    const { dispatch, service } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN] });
    const staged = await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 0 }] }));
    const stage = (jsonBody(staged).staged as { stage: string }).stage;

    const confirming = await dispatch.dispatch(post(`${base(plan.id)}/approval/${stage}/confirm-in-app`, {}));
    const card = await dispatch.dispatch(request({ method: 'GET', path: base(plan.id), headers: human }));
    const dropped = await dispatch.dispatch(
      request({ method: 'DELETE', path: `${base(plan.id)}/approval/${stage}`, headers: human }),
    );
    const view = await dispatch.dispatch(
      request({ method: 'GET', path: `${base(plan.id)}/approval/${stage}`, headers: human }),
    );

    should([confirming.status, card.status, dropped.status, view.status]).eql([201, 200, 200, 200]);
    should(jsonBody(confirming)).eql({ stage, plan: plan.id, agendaItemId: 'A1' });
    should(jsonBody(card)).match({ machineStage: { stage, lines: [0] } });
    should(jsonBody(view)).match({ state: 'denied' });
    should(service.get({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id).state).equal('pending');
  });
});

describe('the task-plan routes: revoke, and the kept paste-plan route', () => {
  it('should revoke with no passkey, at once', async () => {
    const { dispatch, service, rules } = await served();
    const plan = await service.propose(SESSION, { lines: [PASTE] });
    await dispatch.dispatch(post(`${base(plan.id)}/approval`, { lines: [{ line: 0 }] }));

    const revoked = await dispatch.dispatch(post(`${base(plan.id)}/revoke`, {}));

    should(revoked.status).equal(200);
    should(jsonBody(revoked)).match({ state: 'revoked' });
    should(rules.list({ kind: 'owner', actor: { kind: 'host' } })).eql([]);
  });

  it('should read an old item number as its paste line: item 0 never ticks sign-in line 0', async () => {
    const { dispatch, service } = await served();
    const plan = await service.propose(SESSION, { lines: [SIGN_IN, PASTE] });

    const listed = await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-plans', headers: human }));
    const beyond = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [1] }),
    );
    const approved = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }),
    );

    should(jsonBody(listed)).match({ plans: [{ id: plan.id, items: [{ to: { program: 'vercel' } }] }] });
    should((jsonBody(listed).plans as { items: unknown[] }[])[0]?.items).have.length(1);
    should(beyond.status).equal(400);
    should(approved.status).equal(200);
    should(jsonBody(approved)).match({ state: 'approved', approved: [0] });
    should(service.get({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id).lines.map(line => line.state)).eql(
      ['declined', 'approved'],
    );
  });
});
