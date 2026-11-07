import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import { BrowserProxyTestResultSchema, BrowserStateViewSchema } from '../../../contract/index.ts';
import { BrowserProxyTester } from '../../../daemon/proxy/index.ts';
import { proxyRoutes } from '../../../daemon/proxy/routes.ts';
import { type CallerKind as Kind, callOf } from '../../support/call.ts';

type FirewallReading = () => Promise<{ state: 'stale'; detail: string } | undefined>;

function subsystem(probed: string[], firewall?: FirewallReading) {
  return {
    tester: new BrowserProxyTester({
      saved: async () => ({ url: 'http://proxy.example:8080', bypass: [] }),
      secrets: async () => new Map([['PROXY_PASSWORD', 'hunter2']]),
      probe: {
        run: async () => {
          probed.push('run');
          return { ok: true, egressIp: '203.0.113.7' };
        },
      },
      now: () => 0,
    }),
    state: () => ({ state: 'running' as const, startedAt: '2026-10-30T09:00:00.000Z' }) as never,
    ...(firewall === undefined ? {} : { firewall }),
  };
}

async function drive(
  probed: string[],
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  kind: Kind = 'host',
  fresh = false,
  firewall?: FirewallReading,
) {
  const routes = proxyRoutes(subsystem(probed, firewall)) as Record<
    string,
    (call: never) => Promise<{ status: number; body: string }>
  >;
  const handle = routes[`${method} ${path}`];
  if (handle === undefined) throw new Error(`no route ${method} ${path}`);
  const { call, spent } = callOf({ method, path, body, kind, fresh });
  try {
    const response = await handle(call as never);
    return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown>, spent: spent() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, spent: spent() };
  }
}

describe('the browser proxy test route', () => {
  it('lets the owner at the machine test the saved proxy and answers a shape the client parses', async () => {
    const probed: string[] = [];
    const answer = await drive(probed, 'POST', '/v1/browser/proxy/test', {});
    should(answer.status).equal(200);
    should(BrowserProxyTestResultSchema.parse(answer.body)).containEql({ reachable: true, egressIp: '203.0.113.7' });
    should(JSON.stringify(answer.body)).not.match(/hunter2|PROXY_PASSWORD|proxy\.example/u);
  });

  it('tests an unsaved setting without saving it', async () => {
    const answer = await drive([], 'POST', '/v1/browser/proxy/test', {
      proxy: { url: 'http://draft.example:3128', bypass: [] },
    });
    should(answer.body).containEql({ reachable: true, tested: 'unsaved' });
  });

  it('refuses a ferret outright and never reaches the network', async () => {
    const probed: string[] = [];
    const answer = await drive(probed, 'POST', '/v1/browser/proxy/test', {}, 'agent');
    should(answer.status).equal(403);
    should(probed).have.length(0);
  });

  it('asks a paired device for a passkey first, then spends it', async () => {
    const probed: string[] = [];
    const asked = await drive(probed, 'POST', '/v1/browser/proxy/test', {}, 'device');
    should(asked.status).equal(403);
    should(asked.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(probed).have.length(0);
    const confirmed = await drive(probed, 'POST', '/v1/browser/proxy/test', {}, 'device', true);
    should(confirmed.status).equal(200);
    should(confirmed.spent).equal(1);
  });

  it('refuses a body that tries to carry a credential', async () => {
    const answer = await drive([], 'POST', '/v1/browser/proxy/test', {
      proxy: { url: 'http://a:1', bypass: [], password: 'x' },
    });
    should(answer.status).equal(400);
  });

  it('answers the machine browser state', async () => {
    const answer = await drive([], 'GET', '/v1/browser/state', undefined);
    should(BrowserStateViewSchema.parse(answer.body)).containEql({ state: 'running' });
    should(answer.body).not.have.property('firewall');
  });

  it('adds the loopback firewall reading to the browser state when the daemon has one', async () => {
    const firewall = { state: 'stale' as const, detail: 'the loopback firewall is stale: ask the host admin' };
    const answer = await drive([], 'GET', '/v1/browser/state', undefined, 'host', false, async () => firewall);
    should(BrowserStateViewSchema.parse(answer.body).firewall).eql(firewall);
  });

  it('still answers the browser state when the firewall reading is absent or fails', async () => {
    const absent = await drive([], 'GET', '/v1/browser/state', undefined, 'host', false, async () => undefined);
    should(absent.body).not.have.property('firewall');
    const failed = await drive([], 'GET', '/v1/browser/state', undefined, 'host', false, async () => {
      throw new Error('unreadable');
    });
    should(failed.status).equal(200);
    should(failed.body).not.have.property('firewall');
  });
});
