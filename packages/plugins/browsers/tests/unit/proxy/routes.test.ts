import { describe, it } from 'bun:test';
import { BrowserProxyTestResultSchema, BrowserStateViewSchema, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { BrowserProxyTester } from '../../../../src/lib/browser/proxy/index.ts';
import { browserProxyRoutes } from '../../../../src/lib/runtime/mounts/browser-proxy.ts';
import { jsonBody, request } from '../../api/support.ts';

type Kind = 'host' | 'device' | 'agent';
const CREDENTIAL: Record<Kind, AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  agent: { kind: 'authenticated', tokenClass: 'admin' },
};
const ACTOR: Record<Kind, string> = { host: 'admin-cli', device: 'device:d1', agent: 'peer:s1' };

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
    state: () => ({ state: 'running' as const, startedAt: '2026-10-30T09:00:00.000Z' }),
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
  const found = new ApiRouter(browserProxyRoutes(subsystem(probed, firewall))).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  let spent = 0;
  const governance: CallerGovernance = {
    governed: kind === 'device',
    decide: () => ({ allowed: true, refusal: 'granted' }),
  };
  const context: RouteContext = {
    request: request({
      method,
      path,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: found.params,
    actor: ACTOR[kind],
    credential: CREDENTIAL[kind],
    governance,
    presentation: {
      loopback: kind !== 'device',
      adminToken: kind !== 'device',
      actor: ACTOR[kind],
      stepUp: fresh,
      freshStepUp: fresh,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, spent };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, spent };
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
