import { describe, it } from 'bun:test';
import type { PasteRule } from '@ferretry/protocol';
import should from 'should';
import { ProtocolCopyGateway, ProtocolPlanGateway } from '../../../src/lib/plan/gateway';

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const RULE: PasteRule = {
  id: 'a'.repeat(32),
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  used: 0,
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: { kind: 'host' },
};

function gateway(answer: (path: string, method: string) => unknown) {
  const calls: Call[] = [];
  const api = {
    request: <T>(path: string, schema: { parse(value: unknown): T }, init?: RequestInit): Promise<T> => {
      const method = init?.method ?? 'GET';
      calls.push({
        path,
        method,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return Promise.resolve(schema.parse(answer(path, method)));
    },
  };
  return { calls, copy: new ProtocolCopyGateway(api) };
}

describe('ProtocolCopyGateway', () => {
  it('should dial each secure copy route as the person at this machine, never naming a ferret session', async () => {
    const { calls, copy } = gateway((path, method) => {
      if (path.endsWith('/copies')) return { copies: [] };
      if (path === '/v1/copy-rules' && method === 'GET') return { rules: [RULE] };
      if (path === '/v1/copy-rules') return RULE;
      if (method === 'DELETE') return { removed: true };
      return RULE;
    });

    await copy.copies('s 1');
    await copy.rules();
    await copy.addRule({ from: RULE.from, to: RULE.to, count: 1 });
    await copy.removeRule(RULE.id);

    should(calls.map(call => `${call.method} ${call.path}`)).eql([
      'GET /v1/sessions/s%201/copies',
      'GET /v1/copy-rules',
      'POST /v1/copy-rules',
      `DELETE /v1/copy-rules/${RULE.id}`,
    ]);
    should(calls[2]?.body).eql({ from: RULE.from, to: RULE.to, count: 1 });
    should(calls.every(call => !('x-ferretry-session-id' in call.headers))).be.true();
  });

  it('should read the secure copy settings from their own route, as the person at this machine', async () => {
    const view = { settings: { allowProfileTargets: true }, profileRules: [RULE.id] };
    const { calls, copy } = gateway(() => view);

    should(await copy.ruleSettings()).eql(view);
    should(calls.map(call => `${call.method} ${call.path}`)).eql(['GET /v1/copy-rules/settings']);
    should(calls.every(call => !('x-ferretry-session-id' in call.headers))).be.true();
    const { copy: wrong } = gateway(() => ({ settings: { allowProfileTargets: true }, profileRules: ['nope'] }));
    should(
      await wrong.ruleSettings().then(
        () => 'parsed',
        () => 'refused',
      ),
    ).equal('refused');
  });

  it('should refuse a reply that does not match the protocol', async () => {
    const { copy } = gateway(() => ({ rules: [{ ...RULE, value: 'ghp_x' }] }));

    should(
      await copy.rules().then(
        () => 'parsed',
        () => 'refused',
      ),
    ).equal('refused');
  });
});

const STAGE = `tps_${'a'.repeat(24)}`;
const PLAN_ID = 'b'.repeat(32);

describe('ProtocolPlanGateway', () => {
  const view = {
    stage: STAGE,
    plan: PLAN_ID,
    lines: [1],
    summary: ['Sign in'],
    expiresAt: '2026-11-01T12:02:00.000Z',
    state: 'waiting',
  };
  const plan = {
    v: 1,
    id: PLAN_ID,
    sessionId: 's 1',
    agendaItemId: 'A9',
    lines: [
      {
        kind: 'paste',
        line: 0,
        uses: 1,
        why: 'the deploy token',
        state: 'ended',
        from: { kind: 'command', program: 'gh' },
        to: { kind: 'terminal', program: 'vercel' },
      },
    ],
    state: 'revoked',
    raisedAt: '2026-11-01T12:00:00.000Z',
    expiresAt: '2026-11-01T14:00:00.000Z',
  };

  function planGateway(answer: (path: string, method: string) => unknown) {
    const calls: Call[] = [];
    const api = {
      request: <T>(path: string, schema: { parse(value: unknown): T }, init?: RequestInit): Promise<T> => {
        const method = init?.method ?? 'GET';
        calls.push({
          path,
          method,
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return Promise.resolve(schema.parse(answer(path, method)));
      },
    };
    return { calls, plans: new ProtocolPlanGateway(api) };
  }

  it('should dial each plan route as the person at this machine, never naming a ferret session', async () => {
    const { calls, plans } = planGateway(path => {
      if (path.startsWith('/v1/task-plans')) return { plans: [] };
      if (path.endsWith('/confirm-in-app')) return { stage: STAGE, plan: PLAN_ID, agendaItemId: 'A9' };
      if (path.endsWith('/revoke')) return plan;
      if (path.endsWith('/approval'))
        return {
          outcome: 'staged',
          staged: { stage: STAGE, plan: PLAN_ID, lines: [1], summary: ['Sign in'], expiresAt: view.expiresAt },
        };
      return view;
    });

    await plans.plans();
    await plans.plans('s 1');
    await plans.stage('s 1', PLAN_ID, { lines: [{ line: 1, signIn: `si_${'1'.repeat(16)}`, totp: true }] });
    await plans.confirmInApp('s 1', PLAN_ID, STAGE);
    await plans.view('s 1', PLAN_ID, STAGE);
    await plans.revoke('s 1', PLAN_ID, [0, 2]);
    await plans.revoke('s 1', PLAN_ID);

    const base = `/v1/sessions/s%201/task-plans/${PLAN_ID}`;
    should(calls.map(call => `${call.method} ${call.path}`)).eql([
      'GET /v1/task-plans',
      'GET /v1/task-plans?session=s%201',
      `POST ${base}/approval`,
      `POST ${base}/approval/${STAGE}/confirm-in-app`,
      `GET ${base}/approval/${STAGE}`,
      `POST ${base}/revoke`,
      `POST ${base}/revoke`,
    ]);
    should(calls[2]?.body).eql({ lines: [{ line: 1, signIn: `si_${'1'.repeat(16)}`, totp: true }] });
    should(calls[5]?.body).eql({ lines: [0, 2] });
    should(calls[6]?.body).eql({});
    should(calls.every(call => !('x-ferretry-session-id' in call.headers))).be.true();
  });

  it('should have no way to commit: no method for it, and no route it could reach', async () => {
    const { calls, plans } = planGateway(() => view);

    await plans.view('s1', PLAN_ID, STAGE);

    should(Object.getOwnPropertyNames(ProtocolPlanGateway.prototype).filter(name => /commit/iu.test(name))).eql([]);
    should(calls.filter(call => call.path.endsWith('/commit'))).eql([]);
  });

  it('should refuse an approval the protocol would not accept, before sending anything', async () => {
    const { calls, plans } = planGateway(() => view);

    const outcome = await plans.stage('s1', PLAN_ID, { lines: [{ line: -1 }] }).then(
      () => 'sent',
      () => 'refused',
    );

    should(outcome).equal('refused');
    should(calls).eql([]);
  });
});
