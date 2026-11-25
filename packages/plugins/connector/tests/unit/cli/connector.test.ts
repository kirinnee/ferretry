import { describe, expect, test } from 'bun:test';
import type { PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import { buildConnectorVerbs } from '../../../cli/lib/commands.ts';
import { expiresIn } from '../../../cli/lib/render.ts';

const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const grant = {
  id: 'cg_abcdefghij',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: '2026-11-25T09:00:00.000Z',
  approvedBy: 'admin-cli',
};
const pending = {
  id: 'cr_abcdefghij',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude\u001b[31m',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read'],
  createdAt: '2026-11-25T09:55:00.000Z',
  expiresAt: '2026-11-25T10:05:00.000Z',
};

function harness(answers: Record<string, unknown>) {
  const calls: { route: string; init: unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client = {
    call: async (route: string, init?: unknown) => {
      calls.push({ route, init });
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as PluginClient;
  const io = {
    out: (text: string) => void out.push(text),
    err: (text: string) => void err.push(text),
    isTty: false,
  } as TerminalIo;
  return { verbs: buildConnectorVerbs(client, io, () => NOW), calls, out, err };
}
const invocation = (args: string[] = [], options: Record<string, string | boolean> = {}) => ({ args, options });

describe('fy connector', () => {
  test('the bare command and `status` print the report: off says why', async () => {
    const h = harness({
      'GET /v1/connector': {
        enabled: false,
        switchedOn: false,
        disabledReason: 'The connector is off. Switch it on in the app.',
        pending: [],
        grants: [],
      },
    });
    expect(await h.verbs.connector(invocation())).toBe(0);
    expect(await h.verbs['connector status'](invocation())).toBe(0);
    expect(h.out[0]).toBe('The Claude connector is off.\nThe connector is off. Switch it on in the app.');
    expect(h.out[1]).toBe(h.out[0]);
  });

  test('on: the MCP URL, what waits (client text made safe) and the approved clients', async () => {
    const h = harness({
      'GET /v1/connector': {
        enabled: true,
        switchedOn: true,
        publicUrlSource: 'configured',
        publicUrl: 'https://mcp.example.com',
        mcpUrl: 'https://mcp.example.com/mcp',
        pending: [pending],
        grants: [grant],
      },
    });
    await h.verbs.connector(invocation());
    const text = h.out[0] ?? '';
    expect(text).toContain('MCP URL: https://mcp.example.com/mcp');
    expect(text).toContain('K7Q-2MF');
    expect(text).toContain('expires in 5 min');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('fy connector approve <code>');
    expect(text).toContain('cg_abcdefghij');
    expect(text).toContain('fy connector revoke <id>');
  });

  test('--json prints the protocol document and nothing else', async () => {
    const status = { enabled: false, switchedOn: false, pending: [], grants: [] };
    const h = harness({ 'GET /v1/connector': status });
    await h.verbs.connector(invocation([], { json: true }));
    expect(JSON.parse(h.out[0] ?? '')).toEqual(status);
  });

  test("approve names the request by what the person typed and sends an EMPTY body (who acts is the daemon's)", async () => {
    const h = harness({ 'POST /v1/connector/requests/:id/approve': grant });
    expect(await h.verbs['connector approve'](invocation(['k7q2mf']))).toBe(0);
    expect(h.calls[0]).toEqual({
      route: 'POST /v1/connector/requests/:id/approve',
      init: { params: { id: 'k7q2mf' }, body: {} },
    });
    expect(h.out[0]).toContain('Approved "Claude" (cg_abcdefghij)');
    await h.verbs['connector approve'](invocation(['K7Q-2MF'], { json: true }));
    expect(JSON.parse(h.out[1] ?? '').id).toBe('cg_abcdefghij');
  });

  test('deny and revoke say what happened in one plain sentence', async () => {
    const h = harness({
      'POST /v1/connector/requests/:id/deny': pending,
      'POST /v1/connector/grants/:id/revoke': grant,
    });
    await h.verbs['connector deny'](invocation(['cr_abcdefghij']));
    await h.verbs['connector revoke'](invocation(['cg_abcdefghij']));
    expect(h.out[0]).toContain('Nothing was signed in.');
    expect(h.out[1]).toContain('It is refused on its very next call.');
  });

  test('a missing target is usage (exit 2) and calls nothing', async () => {
    const h = harness({});
    expect(await h.verbs['connector approve'](invocation())).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err[0]).toContain('name the sign-in');
  });

  test('a daemon answer in the wrong shape is refused, not rendered', async () => {
    const h = harness({ 'GET /v1/connector': { enabled: true, token: 'fyc_at_leak' } });
    await expect(h.verbs.connector(invocation())).rejects.toBeDefined();
  });

  test('a refusal from the daemon propagates for the shell to print with exit 1', async () => {
    const h = harness({
      'POST /v1/connector/requests/:id/approve': new Error('The sign-in expired. Start it again in Claude.'),
    });
    await expect(h.verbs['connector approve'](invocation(['K7Q-2MF']))).rejects.toThrow('expired');
  });

  test('expiresIn: seconds under 90, minutes after, expired at or past the end', () => {
    expect(expiresIn('2026-11-25T10:00:40.000Z', NOW)).toBe('in 40 s');
    expect(expiresIn('2026-11-25T10:09:00.000Z', NOW)).toBe('in 9 min');
    expect(expiresIn('2026-11-25T10:00:00.000Z', NOW)).toBe('expired');
  });
});
