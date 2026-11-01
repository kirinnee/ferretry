import { describe, it } from 'bun:test';
import { type PasteRule, type PasteRuleSettings, STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance, CapabilityGuard } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { ApiRoute, RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  EphemeralValues,
  type PasteRuleCaller,
  PasteRuleService,
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
  const routes = secureCopyRoutes({ list: sessionId => copies.list(sessionId) }, rules, plans, {
    profileCouldStandFor: async program => {
      if (program === 'broken') throw new Error('cannot look');
      return program === 'vercel';
    },
  });
  const dispatch = new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, guard);
  return { dispatch, routes, stored, plan, rules };
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
    const { dispatch, stored } = await served();

    const added = await dispatch.dispatch(post('/v1/copy-rules', { ...RULE, count: 2 }));
    const listed = await dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-rules', headers: human }));
    const id = (jsonBody(added) as { id: string }).id;
    const removed = await dispatch.dispatch(
      request({ method: 'DELETE', path: `/v1/copy-rules/${id}`, headers: human }),
    );

    should([added.status, listed.status, removed.status]).eql([201, 200, 200]);
    should((jsonBody(listed).rules as unknown[]).length).equal(1);
    should(stored.rules).eql([]);
  });

  it('should approve a plan item into a one-use rule for that session, kept in memory only', async () => {
    const { dispatch, stored, plan, rules } = await served();

    const answer = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }),
    );

    should(answer.status).equal(200);
    should(jsonBody(answer)).match({ state: 'approved', approved: [0] });
    should(rules.list(OWNER)).match([{ sessionId: SESSION, remaining: 1, plan: plan.id }]);
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
      // Turning profile targets ON demands terminal.configure and a passkey inside the route; OFF only narrows.
      'PUT /v1/copy-rules/settings use',
      'POST /v1/copy-rules configure',
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

    const store = await dispatch.dispatch(post('/v1/copy-rules', { from: RULE.from, to: INTO_STORE }));
    const terminal = await dispatch.dispatch(post('/v1/copy-rules', RULE));

    should([store.status, terminal.status]).eql([403, 201]);
    should(jsonBody(store).code).equal('grant_not_granted');
    should(stored.rules?.map(rule => rule.to.kind)).eql(['terminal']);
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
    should(first.status).equal(200);
    should(planned(terminalOnly.rules)).eql(['terminal']);
  });

  it('should add a rule into the store for a caller holding the grant', async () => {
    const { dispatch, stored } = await served();

    const response = await dispatch.dispatch(post('/v1/copy-rules', { from: RULE.from, to: INTO_STORE }));

    should(response.status).equal(201);
    should(stored.rules?.map(rule => rule.to)).eql([INTO_STORE]);
  });
});

describe('approving pastes into a page', () => {
  const NO_BROWSER = withoutGrant({ capability: 'browser', axis: 'use' });

  it('should need the browser grant to add a rule into a page, as allowing one would', async () => {
    const { dispatch, stored } = await served(NO_BROWSER);

    const page = await dispatch.dispatch(post('/v1/copy-rules', { from: RULE.from, to: INTO_PAGE }));
    const terminal = await dispatch.dispatch(post('/v1/copy-rules', RULE));

    should([page.status, terminal.status]).eql([403, 201]);
    should(String(jsonBody(page).error)).containEql('needs the browser permission');
    should(stored.rules?.map(rule => rule.to.kind)).eql(['terminal']);
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

    should([page.status, rest.status]).eql([403, 200]);
    should(planned(refused.rules)).eql([]);
    should(planned(others.rules)).eql(['terminal', 'secret']);
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
  const response = await found.route.handle(context);
  return { status: response.status, body: jsonBody(response) as Record<string, unknown>, claimed };
}

describe('the secure copy settings: profile targets', () => {
  it('should leave the rules list as an older app parses it, and say the settings on their own route', async () => {
    const { dispatch } = await served();
    await dispatch.dispatch(post('/v1/copy-rules', RULE));
    await dispatch.dispatch(post('/v1/copy-rules', { ...RULE, to: { kind: 'terminal', program: 'psql' } }));
    await dispatch.dispatch(post('/v1/copy-rules', { ...RULE, to: { kind: 'terminal', program: 'broken' } }));
    await dispatch.dispatch(post('/v1/copy-rules', { ...RULE, to: INTO_PAGE }));

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

  it('should let the owner at the machine turn it on and off, with no passkey', async () => {
    const { routes, stored } = await served();

    const on = await putSettings(routes, { allowProfileTargets: true }, 'host');
    should([on.status, on.body, on.claimed]).eql([200, { allowProfileTargets: true }, 0]);
    should(stored.settings).eql({ allowProfileTargets: true });
    const off = await putSettings(routes, { allowProfileTargets: false }, 'host');
    should([off.status, off.claimed]).eql([200, 0]);
    should(stored.settings).eql({ allowProfileTargets: false });
  });

  it('should hold turning it on from a device for a passkey proved for that act, and claim it', async () => {
    const { routes, stored } = await served();

    const held = await putSettings(routes, { allowProfileTargets: true }, 'device');
    should(held.status).equal(403);
    should(held.body).match({
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'terminal', axis: 'configure', act: STEP_UP_ACTS.allowProfileTargets },
    });
    should(stored.settings).eql({ allowProfileTargets: false });

    const refused = await putSettings(routes, { allowProfileTargets: true }, 'device-without-configure');
    should(refused.status).equal(403);
    should(refused.body.code).not.equal(STEP_UP_REQUIRED_CODE);
    should(stored.settings).eql({ allowProfileTargets: false });

    const confirmed = await putSettings(routes, { allowProfileTargets: true }, 'fresh-device');
    should([confirmed.status, confirmed.claimed]).eql([200, 1]);
    should(stored.settings).eql({ allowProfileTargets: true });
  });

  it('should refuse a fresh proof minted for another act, and let one proof turn it on only once (L1)', async () => {
    const { routes, stored } = await served();

    const other = await putSettings(routes, { allowProfileTargets: true }, 'device-proved-other');
    should(other.status).equal(403);
    should(other.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(stored.settings).eql({ allowProfileTargets: false });

    // One proof, two requests racing: the second finds it claimed.
    const proof = { held: true };
    const [first, second] = await Promise.all([
      putSettings(routes, { allowProfileTargets: true }, 'fresh-device', proof),
      putSettings(routes, { allowProfileTargets: true }, 'fresh-device', proof),
    ]);
    should([first.status, second.status].sort()).eql([200, 403]);
  });

  it('should let a device turn it off, or leave it on, with no passkey at all', async () => {
    const { routes, stored } = await served();
    await putSettings(routes, { allowProfileTargets: true }, 'host');

    const again = await putSettings(routes, { allowProfileTargets: true }, 'device');
    const off = await putSettings(routes, { allowProfileTargets: false }, 'device-without-configure');

    should([again.status, again.claimed, off.status, off.claimed]).eql([200, 0, 200, 0]);
    should(stored.settings).eql({ allowProfileTargets: false });
  });
});

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
    should([direct.status, direct.code]).deepEqual([403, 'forbidden']);
  });
});
