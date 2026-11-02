import { describe, it } from 'bun:test';
import {
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleSettings,
  type PasteRuleStageId,
  RUNS_WHAT_IT_READS_WARNING,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance, CapabilityGuard } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiRoute, RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  EphemeralValues,
  type PasteRuleCaller,
  PasteRuleService,
  PasteRuleStages,
  SecureCopyService,
  TaskPlanService,
} from '../../../../src/lib/index.ts';
import { secureCopyRoutes } from '../../../../src/lib/runtime/mounts/secure-copy.ts';
import type { ApiRequest } from '../../../../src/lib/api/http.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { handleDirectly } from './second-line.ts';
import { agentIn, CREDENTIALS, fromFerret, GRANTED, human, withoutGrant, withoutSecretsConfigure } from './support.ts';

/** The owner's secure-copy routes through the real router and authorization boundary, with the real services. */

const SESSION = 'mvv6b4qw-49d0158d';
const TOKEN = 'vcp_ROUTE-NEVER-RETURNS-77';
const RULE = { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' } } as const;
const INTO_STORE = { kind: 'secret', name: 'VERCEL_TOKEN' } as const;
const INTO_PAGE = { kind: 'browser', origin: 'https://vercel.com' } as const;
const OWNER: PasteRuleCaller = { kind: 'owner', actor: { kind: 'host' } };
const PHONE: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'd1' } };
/** Where a plan's pastes went: the rules held in MEMORY, by destination kind (the store never holds them). */
const planned = (rules: PasteRuleService) =>
  rules
    .list(OWNER)
    .filter(rule => rule.plan !== undefined)
    .map(rule => rule.to.kind);

async function served(guard: CapabilityGuard = GRANTED) {
  const clock = { now: () => Date.parse('2026-10-31T12:00:00.000Z') };
  const copies = new SecureCopyService({
    clock,
    runner: { run: async () => ({ outcome: 'exited', exitCode: 0, stdout: TOKEN, stderr: '', truncated: false }) },
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => 'clean' },
    masking: new EphemeralValues(clock),
    redact: async text => text,
  });
  await copies.capture(SESSION, { name: 'gh', source: { kind: 'command', argv: ['gh', 'auth', 'token'] } });
  const stored: { rules: readonly PasteRule[] | undefined; settings: PasteRuleSettings } = {
    rules: undefined,
    settings: { allowProfileTargets: false },
  };
  let id = 0;
  const rules = new PasteRuleService({
    store: {
      read: async () => (stored.rules === undefined ? undefined : { rules: stored.rules, settings: stored.settings }),
      write: async next => {
        stored.rules = next.rules;
        stored.settings = next.settings;
      },
    },
    clock,
    ids: { ruleId: () => (++id).toString(16).padStart(32, '0') },
    warn: () => undefined,
  });
  await rules.load();
  const plans = new TaskPlanService({
    agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
    rules,
    accounts: { listing: async () => ({ accounts: [], signIns: [] }), keyOf: async () => undefined },
    passkeys: { any: async () => true },
    redact: async text => text,
    tell: async () => undefined,
    audit: { record: async () => undefined },
    clock,
    ids: { planId: () => 'b'.repeat(32) },
  });
  const plan = await plans.proposePastes(SESSION, [
    { ...RULE, why: 'the deploy token' },
    { from: RULE.from, to: INTO_STORE, why: 'kept for the deploy script' },
    { from: RULE.from, to: INTO_PAGE, why: 'the env page' },
  ]);
  let stageCount = 0;
  const stages = new PasteRuleStages({
    rules,
    clock,
    stageId: () => `prs_${(++stageCount).toString(16).padStart(24, '0')}` as PasteRuleStageId,
  });
  const routes = secureCopyRoutes({ list: sessionId => copies.list(sessionId) }, rules, plans, stages, {
    profileCouldStandFor: async program => {
      if (program === 'broken') throw new Error('cannot look');
      return program === 'vercel';
    },
  });
  const dispatch = new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, guard);
  return { dispatch, routes, stored, plan, rules, stages };
}

type Served = Awaited<ReturnType<typeof served>>;

/**
 * Who commits a staged paste rule, through the route alone, as the boundary would hand it over. `bound` holds a fresh
 * `approve-paste-rule` proof bound to the stage's subject (`step-up/registry.ts` claims it once); `window` holds only
 * a held step-up window and a proof for no act; `other-act` a proof for `allow-profile-targets`; `host` is the
 * machine's own token, which never holds a proof.
 */
type Committer = 'bound' | 'window' | 'other-act' | 'other-stage' | 'host';

async function commitAs(
  world: Served,
  stage: string,
  committer: Committer,
  proof = { held: true },
): Promise<{ status: number; body: Record<string, unknown>; claims: [string | undefined, string | undefined][] }> {
  const path = `/v1/copy-rules/stages/${stage}/commit`;
  const found = new ApiRouter(world.routes).lookup('POST', path);
  if (found.kind !== 'matched') throw new Error('no commit route');
  const device = committer !== 'host';
  const claims: [string | undefined, string | undefined][] = [];
  // A machine stage is taken by the device first (`…/bind`), as the app does before it asks the passkey.
  if (device) {
    try {
      world.stages.bind(PHONE, stage as PasteRuleStageId);
    } catch {
      // already gone: the commit says so
    }
  }
  const subject = world.stages.boundSubjectOf(stage as PasteRuleStageId, 'rule', 'd1');
  const context: RouteContext = {
    request: request({ method: 'POST', path }),
    params: found.params,
    actor: device ? 'device:d1' : 'admin-cli',
    credential: device
      ? { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' }
      : { kind: 'authenticated', tokenClass: 'admin' },
    governance: { governed: device, decide: () => ({ allowed: true, refusal: 'granted' }) },
    presentation: {
      loopback: !device,
      adminToken: !device,
      actor: device ? 'device:d1' : 'admin-cli',
      // Every device here holds a live window and a fresh proof: only the claim says what the proof is for.
      stepUp: device,
      freshStepUp: device,
    },
    ...(device
      ? {
          claimFreshStepUp: ((act?: string, claimed?: string) => {
            claims.push([act, claimed]);
            const stamped =
              committer === 'bound' || committer === 'other-stage'
                ? STEP_UP_ACTS.approvePasteRule
                : committer === 'other-act'
                  ? STEP_UP_ACTS.allowProfileTargets
                  : undefined;
            const boundTo = committer === 'other-stage' ? 'f'.repeat(64) : subject;
            if (stamped === undefined || act !== stamped || claimed !== boundTo || !proof.held) return false;
            proof.held = false;
            return true;
          }) as RouteContext['claimFreshStepUp'],
          spendFreshStepUp: () => undefined,
        }
      : {}),
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, claims };
  } catch (error) {
    // The dispatcher turns a thrown refusal into its answer; the route alone throws it.
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { code: error.code, error: error.message }, claims };
  }
}

/** Stages a rule through the boundary, then commits it with its own bound passkey: how the app makes one. */
async function addRule(world: Served, rule: PasteRuleCreate): Promise<{ id: string }> {
  const staged = await world.dispatch.dispatch(post('/v1/copy-rules/stages', rule));
  if (staged.status !== 201) throw new Error(`not staged: ${JSON.stringify(jsonBody(staged))}`);
  const made = await commitAs(world, String(jsonBody(staged).stage), 'bound');
  if (made.status !== 201) throw new Error(`not made: ${JSON.stringify(made.body)}`);
  return made.body as { id: string };
}

const post = (path: string, body: unknown, headers: Readonly<Record<string, string>> = human, reads = bodyReads()) =>
  request({
    method: 'POST',
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    reads,
  });

describe('the secure copy routes', () => {
  // On the admin token naming its session (an older fy), and on its OWN session credential.
  for (const [who, own] of [
    ['an agent', false],
    ['a ferret on its own session credential', true],
  ] as const)
    it(`should refuse ${who} on every route, before reading a body`, async () => {
      const { dispatch, stored, plan } = await served();
      const reads = bodyReads();
      const agent = own ? human : agentIn(SESSION);
      const as = <T extends ApiRequest>(asked: T): T => (own ? fromFerret(asked) : asked);

      const answers = await Promise.all([
        dispatch.dispatch(as(post('/v1/copy-rules', RULE, agent, reads))),
        dispatch.dispatch(as(post('/v1/copy-rules/stages', RULE, agent, reads))),
        dispatch.dispatch(as(post(`/v1/copy-rules/stages/prs_${'1'.repeat(24)}/commit`, {}, agent, reads))),
        dispatch.dispatch(as(request({ method: 'GET', path: '/v1/copy-rules/stages', headers: agent }))),
        dispatch.dispatch(
          as(post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }, agent, reads)),
        ),
        dispatch.dispatch(as(request({ method: 'GET', path: '/v1/copy-rules', headers: agent }))),
        dispatch.dispatch(as(request({ method: 'GET', path: '/v1/copy-plans', headers: agent }))),
        dispatch.dispatch(as(request({ method: 'GET', path: `/v1/sessions/${SESSION}/copies`, headers: agent }))),
        dispatch.dispatch(
          as(request({ method: 'DELETE', path: `/v1/copy-rules/${'1'.padStart(32, '0')}`, headers: agent })),
        ),
        dispatch.dispatch(
          as(
            request({
              method: 'PUT',
              path: '/v1/copy-rules/settings',
              headers: { ...agent, 'content-type': 'application/json' },
              body: JSON.stringify({ allowProfileTargets: true }),
              reads,
            }),
          ),
        ),
      ]);

      should(answers.map(answer => [answer.status, jsonBody(answer).code])).eql(answers.map(() => [403, 'owner_only']));
      should(reads.consumed).be.false();
      should(stored.rules).be.undefined();
    });

  it('should let the owner add, list and remove a rule', async () => {
    const world = await served();
    const { dispatch, stored } = world;

    const { id } = await addRule(world, { ...RULE, count: 2 });
    const listed = await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-rules', headers: human }));
    const removed = await dispatch.dispatch(
      request({ method: 'DELETE', path: `/v1/copy-rules/${id}`, headers: human }),
    );

    should([listed.status, removed.status]).eql([200, 200]);
    should((jsonBody(listed).rules as unknown[]).length).equal(1);
    should(stored.rules).eql([]);
  });

  it('should allow no plan item on the old one-step route, which only declines now (!A244)', async () => {
    const { dispatch, stored, plan, rules } = await served();

    const ticked = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }),
    );
    const declined = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [] }),
    );

    should(ticked.status).equal(409);
    should(jsonBody(ticked).code).equal('needs_passkey');
    should(declined.status).equal(200);
    should(jsonBody(declined)).match({ state: 'declined' });
    should(rules.list(OWNER)).eql([]);
    should(stored.rules).be.undefined();
  });

  it("should list a session's copies by description, never by value", async () => {
    const { dispatch } = await served();

    const answer = await dispatch.dispatch(
      request({ method: 'GET', path: `/v1/sessions/${SESSION}/copies`, headers: human }),
    );

    should(answer.status).equal(200);
    should(jsonBody(answer)).match({ copies: [{ handle: 'sealed:gh', length: TOKEN.length }] });
    should(JSON.stringify(jsonBody(answer))).not.containEql(TOKEN);
  });

  it('should answer a bad id in the path, an unknown rule and an unknown plan in words', async () => {
    const { dispatch } = await served();

    const bad = await dispatch.dispatch(
      request({ method: 'DELETE', path: '/v1/copy-rules/not-an-id', headers: human }),
    );
    const unknown = await dispatch.dispatch(
      request({ method: 'DELETE', path: `/v1/copy-rules/${'9'.repeat(32)}`, headers: human }),
    );
    const plan = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${'c'.repeat(32)}/approve`, { items: [] }),
    );

    should([bad.status, unknown.status, plan.status]).eql([400, 404, 404]);
  });

  it('should demand terminal.configure where a change loosens what agents may do, and terminal.use elsewhere', async () => {
    const { routes } = await served();

    should(routes.map(route => `${route.method} ${route.path} ${route.capability?.axis ?? 'none'}`)).eql([
      'GET /v1/sessions/:sessionId/copies use',
      'GET /v1/copy-rules use',
      'GET /v1/copy-rules/settings use',
      // Turning profile targets ON is staged with its own passkey; this write only narrows or keeps.
      'PUT /v1/copy-rules/settings use',
      'POST /v1/copy-rules/settings/stages configure',
      'POST /v1/copy-rules/settings/stages/:stage/commit configure',
      'POST /v1/copy-rules configure',
      'POST /v1/copy-rules/stages configure',
      'GET /v1/copy-rules/stages use',
      'GET /v1/copy-rules/stages/:stage use',
      'POST /v1/copy-rules/stages/:stage/commit configure',
      'POST /v1/copy-rules/stages/:stage/bind configure',
      'DELETE /v1/copy-rules/stages/:stage use',
      'DELETE /v1/copy-rules/:ruleId use',
      'GET /v1/copy-plans use',
      'POST /v1/sessions/:sessionId/copy-plans/:planId/approve configure',
    ]);
    should(routes.every(route => route.capability?.capability === 'terminal')).be.true();
  });
});

describe('the secure copy routes, when a service fails unexpectedly', () => {
  it('should let an error that is not a refusal surface as the failure it is', async () => {
    const { routes } = await served();
    const approve = routes.find(route => route.path.endsWith('/approve'));
    const failing = secureCopyRoutes(
      { list: () => [] },
      {} as never,
      {
        copyPlans: () => [],
        approveCopyItems: async () => {
          throw new Error('the board fell over');
        },
      } as never,
      {} as never,
    ).find(route => route.path === approve?.path);
    const dispatch = new ApiDispatcher(new ApiRouter(failing === undefined ? [] : [failing]), CREDENTIALS, GRANTED);

    const answer = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${'b'.repeat(32)}/approve`, { items: [] }),
    );

    should(answer.status).equal(500);
  });
});

describe('approving pastes into the secret store', () => {
  it('should need the secrets grant to add a rule into the store, but not a rule into a terminal', async () => {
    const { dispatch, stored } = await served(withoutSecretsConfigure('not-granted'));

    const store = await dispatch.dispatch(post('/v1/copy-rules/stages', { from: RULE.from, to: INTO_STORE }));
    const terminal = await dispatch.dispatch(post('/v1/copy-rules/stages', RULE));

    should([store.status, terminal.status]).eql([403, 201]);
    should(jsonBody(store).code).equal('grant_not_granted');
    should(stored.rules).be.undefined();
  });

  it('should need the secrets grant to approve a plan item into the store, and not for the terminal item alone', async () => {
    const refusing = await served(withoutSecretsConfigure('step-up-required'));
    const terminalOnly = await served(withoutSecretsConfigure('not-granted'));

    const both = await refusing.dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${refusing.plan.id}/approve`, { items: [0, 1] }),
    );
    const first = await terminalOnly.dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${terminalOnly.plan.id}/approve`, { items: [0] }),
    );

    should(both.status).equal(403);
    should(jsonBody(both)).match({ code: 'grant_step_up_required', demand: { capability: 'secrets' } });
    should(planned(refusing.rules)).eql([]);
    // Past the grant, a tick still needs the plan's passkey, which this route can't carry.
    should(first.status).equal(409);
    should(planned(terminalOnly.rules)).eql([]);
  });

  it('should add a rule into the store for a caller holding the grant', async () => {
    const world = await served();

    await addRule(world, { from: RULE.from, to: INTO_STORE });

    should(world.stored.rules?.map(rule => rule.to)).eql([INTO_STORE]);
  });
});

describe('approving pastes into a page', () => {
  const NO_BROWSER = withoutGrant({ capability: 'browser', axis: 'use' });

  it('should need the browser grant to add a rule into a page, as allowing one would', async () => {
    const { dispatch, stored } = await served(NO_BROWSER);

    const page = await dispatch.dispatch(post('/v1/copy-rules/stages', { from: RULE.from, to: INTO_PAGE }));
    const terminal = await dispatch.dispatch(post('/v1/copy-rules/stages', RULE));

    should([page.status, terminal.status]).eql([403, 201]);
    should(String(jsonBody(page).error)).containEql('needs the browser permission');
    should(stored.rules).be.undefined();
  });

  it('should need the browser grant to approve a plan item into a page, and not for the others', async () => {
    const refused = await served(NO_BROWSER);
    const others = await served(NO_BROWSER);

    const page = await refused.dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${refused.plan.id}/approve`, { items: [0, 2] }),
    );
    const rest = await others.dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${others.plan.id}/approve`, { items: [0, 1] }),
    );

    should([page.status, rest.status]).eql([403, 409]);
    should(planned(refused.rules)).eql([]);
    should(planned(others.rules)).eql([]);
  });
});

type SettingsCaller = 'host' | 'device' | 'fresh-device' | 'device-proved-other' | 'device-without-configure';

/**
 * `PUT /v1/copy-rules/settings`, driven as one caller through the route alone, as the boundary would hand it over. A
 * device's fresh proof is stamped for one act and claimed once (`step-up/registry.ts`): `fresh-device` proved
 * `allow-profile-targets`, `device-proved-other` proved another act (`loosen-config`).
 */
async function putSettings(routes: readonly ApiRoute[], body: unknown, caller: SettingsCaller, proof = { held: true }) {
  const found = new ApiRouter(routes).lookup('PUT', '/v1/copy-rules/settings');
  if (found.kind !== 'matched') throw new Error('no settings route');
  const device = caller !== 'host';
  const stamped =
    caller === 'fresh-device'
      ? STEP_UP_ACTS.allowProfileTargets
      : caller === 'device-proved-other'
        ? STEP_UP_ACTS.loosenConfig
        : undefined;
  let claimed = 0;
  const governance: CallerGovernance = {
    governed: device,
    decide: () =>
      caller === 'device-without-configure'
        ? { allowed: false, refusal: 'not-granted' }
        : { allowed: true, refusal: 'granted' },
  };
  const context: RouteContext = {
    request: request({
      method: 'PUT',
      path: '/v1/copy-rules/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: found.params,
    actor: device ? 'device:d1' : 'admin-cli',
    credential: device
      ? { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' }
      : { kind: 'authenticated', tokenClass: 'admin' },
    governance,
    presentation: {
      loopback: !device,
      adminToken: !device,
      actor: device ? 'device:d1' : 'admin-cli',
      stepUp: stamped !== undefined,
      // Any fresh proof reads as fresh here: only the claim says which act it was for.
      freshStepUp: stamped !== undefined,
    },
    claimFreshStepUp: ((act?: string) => {
      if (stamped === undefined || act !== stamped || !proof.held) return false;
      proof.held = false;
      claimed += 1;
      return true;
    }) as RouteContext['claimFreshStepUp'],
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, claimed };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { code: error.code } as Record<string, unknown>, claimed };
  }
}

describe('the secure copy settings: profile targets', () => {
  it('should leave the rules list as an older app parses it, and say the settings on their own route', async () => {
    const world = await served();
    const { dispatch } = world;
    await addRule(world, RULE);
    await addRule(world, { ...RULE, to: { kind: 'terminal', program: 'psql' } });
    await addRule(world, { ...RULE, to: { kind: 'terminal', program: 'broken' } });
    await addRule(world, { ...RULE, to: INTO_PAGE });

    const listed = jsonBody(
      await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-rules', headers: human })),
    );
    const view = jsonBody(
      await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-rules/settings', headers: human })),
    );
    const rules = listed.rules as { id: string; to: { program?: string } }[];

    should(Object.keys(listed)).eql(['rules']);
    should(view.settings).eql({ allowProfileTargets: false });
    // A rule a profile program could satisfy is marked, and so is one the look failed for: it cannot be ruled out.
    should(view.profileRules).eql(
      rules.filter(rule => rule.to.program === 'vercel' || rule.to.program === 'broken').map(rule => rule.id),
    );
  });

  it('should refuse an agent the settings read', async () => {
    const { dispatch } = await served();
    const answer = await dispatch.dispatch(
      request({ method: 'GET', path: '/v1/copy-rules/settings', headers: agentIn(SESSION) }),
    );
    should(answer.status).equal(403);
  });

  it('should make nothing when the one-step write turns it on, from the machine or a device (secrev-1334 M2)', async () => {
    const { routes, stored } = await served();

    for (const caller of ['host', 'fresh-device'] as const) {
      const on = await putSettings(routes, { allowProfileTargets: true }, caller);
      should([on.status, on.body.code, on.claimed]).eql([409, 'profile_targets_passkey_needed', 0]);
    }
    should(stored.settings).eql({ allowProfileTargets: false });
  });

  it('should stage turning it on with the rules it widens, and turn it on only with a proof bound to that stage', async () => {
    const world = await served();
    await addRule(world, RULE);
    await addRule(world, { ...RULE, to: { kind: 'terminal', program: 'psql' } });

    const staged = await world.dispatch.dispatch(post('/v1/copy-rules/settings/stages', {}));
    const stage = String(jsonBody(staged).stage);
    world.stages.bind(PHONE, stage as PasteRuleStageId);
    const subject = world.stages.boundSubjectOf(stage as PasteRuleStageId, 'profile-targets', 'd1');
    const commit = async (proofs: [string, string | undefined][]) =>
      await handleAsDevice(world.routes, 'POST', `/v1/copy-rules/settings/stages/${stage}/commit`, proofs);

    should(staged.status).equal(201);
    // Only the vercel rule could be satisfied from the profile (`profileCouldStandFor`), so only it is widened.
    should(jsonBody(staged)).match({
      kind: 'profile-targets',
      rows: [{ label: 'Widens', value: 'what gh prints → vercel in a terminal' }, { label: 'Staged' }],
    });
    const refusals = [
      await commit([]),
      await commit([[STEP_UP_ACTS.approvePasteRule, subject]]),
      await commit([[STEP_UP_ACTS.allowProfileTargets, 'f'.repeat(64)]]),
    ];
    should(refusals.map(answer => [answer.status, answer.body.code])).eql(
      refusals.map(() => [403, STEP_UP_REQUIRED_CODE]),
    );
    should(world.stored.settings).eql({ allowProfileTargets: false });

    const done = await commit([[STEP_UP_ACTS.allowProfileTargets, subject]]);

    should([done.status, done.body]).eql([200, { allowProfileTargets: true }]);
    should(world.stored.settings).eql({ allowProfileTargets: true });
    const again = await world.dispatch.dispatch(post('/v1/copy-rules/settings/stages', {}));
    should(again.status).equal(409);
  });

  it('should refuse the commit when the rules it widens changed since it was staged', async () => {
    const world = await served();
    const staged = await world.dispatch.dispatch(post('/v1/copy-rules/settings/stages', {}));
    const stage = String(jsonBody(staged).stage);
    world.stages.bind(PHONE, stage as PasteRuleStageId);
    const subject = world.stages.boundSubjectOf(stage as PasteRuleStageId, 'profile-targets', 'd1');
    await addRule(world, RULE);

    const late = await handleAsDevice(world.routes, 'POST', `/v1/copy-rules/settings/stages/${stage}/commit`, [
      [STEP_UP_ACTS.allowProfileTargets, subject],
    ]);

    should([late.status, late.body.code]).eql([404, 'profile_targets_changed']);
    should(world.stored.settings).eql({ allowProfileTargets: false });
  });

  it('should let a device turn it off, or leave it on, with no passkey at all', async () => {
    const world = await served();
    world.stored.rules = [];
    world.stored.settings = { allowProfileTargets: true };
    await world.rules.load();

    const again = await putSettings(world.routes, { allowProfileTargets: true }, 'device');
    const off = await putSettings(world.routes, { allowProfileTargets: false }, 'device-without-configure');

    should([again.status, again.claimed, off.status, off.claimed]).eql([200, 0, 200, 0]);
    should(world.stored.settings).eql({ allowProfileTargets: false });
  });
});

/** A route driven as paired device d1, holding exactly these fresh proofs (act, subject), each claimed once. */
async function handleAsDevice(
  routes: readonly ApiRoute[],
  method: string,
  path: string,
  proofs: [string, string | undefined][],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = new ApiRouter(routes).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  const held = [...proofs];
  try {
    const response = await found.route.handle({
      request: request({ method, path }),
      params: found.params,
      actor: 'device:d1',
      credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
      governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
      presentation: { loopback: false, adminToken: false, actor: 'device:d1', stepUp: true, freshStepUp: true },
      claimFreshStepUp: ((act?: string, subject?: string) => {
        const at = held.findIndex(([a, s]) => a === act && s === subject);
        if (at < 0) return false;
        held.splice(at, 1);
        return true;
      }) as RouteContext['claimFreshStepUp'],
    });
    return { status: response.status, body: jsonBody(response) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { code: error.code } };
  }
}

describe('the paste plans, read by the owner', () => {
  it('should list the plans for the owner, and still refuse a ferret’s own credential in the handler', async () => {
    // Arrange
    const { dispatch, routes, plan } = await served();

    // Act
    const listed = await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-plans', headers: human }));
    const direct = await handleDirectly(routes, 'GET', '/v1/copy-plans');

    // Assert
    should(listed.status).equal(200);
    should((jsonBody(listed).plans as readonly { id: string }[]).map(entry => entry.id)).containEql(plan.id);
    should([direct.status, direct.code]).deepEqual([403, 'owner_only']);
  });
});

describe('making a paste rule: a passkey bound to that one rule (!A244)', () => {
  it('should make nothing on the old one-step create, and say how to make one', async () => {
    const { dispatch, stored } = await served();

    const answer = await dispatch.dispatch(post('/v1/copy-rules', RULE));

    should(answer.status).equal(409);
    should(jsonBody(answer).code).equal('paste_rule_passkey_needed');
    should(stored.rules).be.undefined();
  });

  it("should stage a rule with the daemon's own line and rows, and allow nothing yet", async () => {
    const { dispatch, rules } = await served();

    const staged = await dispatch.dispatch(
      post('/v1/copy-rules/stages', {
        ...RULE,
        to: { kind: 'terminal', program: 'bash' },
        count: 3,
        sessionId: SESSION,
      }),
    );
    const waiting = await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-rules/stages', headers: human }));

    should(staged.status).equal(201);
    should(jsonBody(staged)).match({
      does: `Ferretry pastes what gh prints into bash in a terminal, for session ${SESSION}, without asking.`,
      rows: [
        { label: 'From', value: 'what gh prints' },
        { label: 'To', value: 'bash in a terminal' },
        { label: 'Who', value: `Session ${SESSION}` },
        { label: 'Pastes', value: 'At most 3' },
        { label: 'Until', value: 'No end: until you remove it' },
      ],
      runsAnything: true,
    });
    should(RUNS_WHAT_IT_READS_WARNING).be.a.String();
    should((jsonBody(waiting).stages as unknown[]).length).equal(1);
    should(rules.list(OWNER)).eql([]);
  });

  it('should refuse the commit with no proof, a held window, a proof for another act or stage, or at the machine', async () => {
    const world = await served();
    const stage = String(jsonBody(await world.dispatch.dispatch(post('/v1/copy-rules/stages', RULE))).stage);

    // The machine's token never holds the stage: it is answered as not its own, and nothing is made.
    const machine = await commitAs(world, stage, 'host');
    should(machine.status).equal(404);
    should(machine.body.code).equal('paste_rule_stage_not_found');
    for (const committer of ['window', 'other-act', 'other-stage'] as const) {
      const refused = await commitAs(world, stage, committer);
      should(refused.status).equal(403);
      should(refused.body).match({
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'terminal', axis: 'configure', act: STEP_UP_ACTS.approvePasteRule },
      });
    }
    // The device asked only for the bound act, and only with this stage's subject.
    const asked = await commitAs(world, stage, 'window');
    should(asked.claims).eql([
      [STEP_UP_ACTS.approvePasteRule, world.stages.boundSubjectOf(stage as PasteRuleStageId, 'rule', 'd1')],
    ]);
    should(world.stored.rules).be.undefined();
    should(world.stages.boundSubjectOf(stage as PasteRuleStageId, 'rule', 'd1')).be.a.String();
  });

  it('should make exactly the staged rule with a bound proof, once', async () => {
    const world = await served();
    const stage = String(
      jsonBody(await world.dispatch.dispatch(post('/v1/copy-rules/stages', { ...RULE, count: 2 }))).stage,
    );
    const proof = { held: true };

    const made = await commitAs(world, stage, 'bound', proof);
    const again = await commitAs(world, stage, 'bound', { held: true });
    const view = await world.dispatch.dispatch(
      request({ method: 'GET', path: `/v1/copy-rules/stages/${stage}`, headers: human }),
    );

    should(made.status).equal(201);
    should(made.body).match({ ...RULE, remaining: 2, used: 0 });
    should(proof.held).be.false();
    should(again.status).equal(404);
    should(again.body.code).equal('paste_rule_stage_not_found');
    should(jsonBody(view)).match({ state: 'approved', rule: made.body.id });
    should(world.stored.rules?.length).equal(1);
  });

  it('should drop a staged rule with no passkey, and then commit nothing', async () => {
    const world = await served();
    const stage = String(jsonBody(await world.dispatch.dispatch(post('/v1/copy-rules/stages', RULE))).stage);

    const dropped = await world.dispatch.dispatch(
      request({ method: 'DELETE', path: `/v1/copy-rules/stages/${stage}`, headers: human }),
    );
    const late = await commitAs(world, stage, 'bound');

    should(dropped.status).equal(200);
    should(jsonBody(dropped)).eql({ stage, dropped: true });
    should(late.status).equal(404);
    should(world.stored.rules).be.undefined();
  });

  it('should keep removing a rule, and dropping a stage, tap-free: narrowing routes ask no passkey', async () => {
    const { routes } = await served();

    const narrowing = routes
      .filter(route => route.capability?.narrowing === true)
      .map(route => `${route.method} ${route.path}`);

    should(narrowing).eql(['DELETE /v1/copy-rules/stages/:stage', 'DELETE /v1/copy-rules/:ruleId']);
  });
});

describe('the paste stage routes, at their edges (secrev-1334)', () => {
  const GONE = `prs_${'9'.repeat(24)}`;

  it('should answer a stage that is not there as not waiting, on every stage route', async () => {
    const world = await served();

    const view = await world.dispatch.dispatch(
      request({ method: 'GET', path: `/v1/copy-rules/stages/${GONE}`, headers: human }),
    );
    const drop = await world.dispatch.dispatch(
      request({ method: 'DELETE', path: `/v1/copy-rules/stages/${GONE}`, headers: human }),
    );
    const bind = await handleAsDevice(world.routes, 'POST', `/v1/copy-rules/stages/${GONE}/bind`, []);

    should([view.status, drop.status, bind.status]).eql([404, 404, 404]);
    should([jsonBody(view).code, jsonBody(drop).code, bind.body.code]).eql(
      Array.from({ length: 3 }, () => 'paste_rule_stage_not_found'),
    );
  });

  it('should let a paired device take a machine stage once, and no other device after', async () => {
    const world = await served();
    const stage = String(jsonBody(await world.dispatch.dispatch(post('/v1/copy-rules/stages', RULE))).stage);

    const taken = await handleAsDevice(world.routes, 'POST', `/v1/copy-rules/stages/${stage}/bind`, []);

    should(taken.status).equal(200);
    should(taken.body).match({ stage, kind: 'rule', rows: [{ label: 'From' }] });
    should(world.stages.boundSubjectOf(stage as PasteRuleStageId, 'rule', 'd1')).be.a.String();
    should(() =>
      world.stages.bind({ kind: 'owner', actor: { kind: 'device', deviceId: 'd2' } }, stage as PasteRuleStageId),
    ).throw();
  });

  it("should answer a commit the rules' cap refuses in the service's own words, making nothing", async () => {
    const world = await served();
    for (let index = 0; index < 50; index += 1)
      await world.rules.create(OWNER, { ...RULE, to: { kind: 'terminal', program: `p${String(index)}` } });
    const stage = String(jsonBody(await world.dispatch.dispatch(post('/v1/copy-rules/stages', RULE))).stage);

    const full = await commitAs(world, stage, 'bound');

    should(full.status).not.equal(201);
    should(full.body.code).equal('capacity');
    should(world.rules.list(OWNER)).have.length(50);
  });
});
