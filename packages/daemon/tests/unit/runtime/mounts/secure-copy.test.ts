import { describe, it } from 'bun:test';
import type { PasteRule } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { CopyPlanService, EphemeralValues, PasteRuleService, SecureCopyService } from '../../../../src/lib/index.ts';
import { secureCopyRoutes } from '../../../../src/lib/runtime/mounts/secure-copy.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human } from './support.ts';

/** The owner's secure-copy routes through the real router and authorization boundary, with the real services. */

const SESSION = 'mvv6b4qw-49d0158d';
const TOKEN = 'vcp_ROUTE-NEVER-RETURNS-77';
const RULE = { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' } } as const;

async function served() {
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
  const stored: { rules: readonly PasteRule[] | undefined } = { rules: undefined };
  let id = 0;
  const rules = new PasteRuleService({
    store: {
      read: async () => stored.rules,
      write: async next => {
        stored.rules = next;
      },
    },
    clock,
    ids: { ruleId: () => (++id).toString(16).padStart(32, '0') },
    warn: () => undefined,
  });
  await rules.load();
  const plans = new CopyPlanService({
    agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
    rules,
    tell: async () => undefined,
    clock,
    ids: { planId: () => 'b'.repeat(32) },
  });
  const plan = await plans.propose(SESSION, [{ ...RULE, why: 'the deploy token' }]);
  const routes = secureCopyRoutes({ list: sessionId => copies.list(sessionId) }, rules, plans);
  const dispatch = new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, GRANTED);
  return { dispatch, routes, stored, plan };
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
  it('should refuse an agent on every route, before reading a body', async () => {
    const { dispatch, stored, plan } = await served();
    const reads = bodyReads();
    const agent = agentIn(SESSION);

    const answers = await Promise.all([
      dispatch.dispatch(post('/v1/copy-rules', RULE, agent, reads)),
      dispatch.dispatch(post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }, agent, reads)),
      dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-rules', headers: agent })),
      dispatch.dispatch(request({ method: 'GET', path: '/v1/copy-plans', headers: agent })),
      dispatch.dispatch(request({ method: 'GET', path: `/v1/sessions/${SESSION}/copies`, headers: agent })),
      dispatch.dispatch(request({ method: 'DELETE', path: `/v1/copy-rules/${'1'.padStart(32, '0')}`, headers: agent })),
    ]);

    should(answers.map(answer => answer.status)).eql([403, 403, 403, 403, 403, 403]);
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

  it('should approve a plan item into a one-use rule for that session', async () => {
    const { dispatch, stored, plan } = await served();

    const answer = await dispatch.dispatch(
      post(`/v1/sessions/${SESSION}/copy-plans/${plan.id}/approve`, { items: [0] }),
    );

    should(answer.status).equal(200);
    should(jsonBody(answer)).match({ state: 'approved', approved: [0] });
    should(stored.rules).match([{ sessionId: SESSION, remaining: 1, plan: plan.id }]);
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
        approve: async () => {
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
