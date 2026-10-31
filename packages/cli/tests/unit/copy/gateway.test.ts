import { describe, it } from 'bun:test';
import type { PasteRule } from '@ferretry/protocol';
import should from 'should';
import { ProtocolCopyGateway } from '../../../src/lib/copy/gateway';

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

const PLAN = {
  id: 'b'.repeat(32),
  sessionId: 's 1',
  agendaItemId: 'A9',
  items: [{ from: RULE.from, to: RULE.to, why: 'token' }],
  state: 'approved',
  raisedAt: '2026-10-31T12:00:00.000Z',
  expiresAt: '2026-10-31T14:00:00.000Z',
  approved: [0],
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
      if (path === '/v1/copy-plans') return { plans: [] };
      return PLAN;
    });

    await copy.copies('s 1');
    await copy.rules();
    await copy.addRule({ from: RULE.from, to: RULE.to, count: 1 });
    await copy.removeRule(RULE.id);
    await copy.plans();
    await copy.approve('s 1', PLAN.id, [0]);

    should(calls.map(call => `${call.method} ${call.path}`)).eql([
      'GET /v1/sessions/s%201/copies',
      'GET /v1/copy-rules',
      'POST /v1/copy-rules',
      `DELETE /v1/copy-rules/${RULE.id}`,
      'GET /v1/copy-plans',
      `POST /v1/sessions/s%201/copy-plans/${PLAN.id}/approve`,
    ]);
    should(calls[2]?.body).eql({ from: RULE.from, to: RULE.to, count: 1 });
    should(calls[5]?.body).eql({ items: [0] });
    should(calls.every(call => !('x-ferretry-session-id' in call.headers))).be.true();
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
