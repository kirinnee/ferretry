import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import { BrowserProxyTestResultSchema, BrowserStateViewSchema } from '../../../contract/index.ts';
import { BrowserProxyTester } from '../../../daemon/proxy/index.ts';
import { proxyRoutes } from '../../../daemon/proxy/routes.ts';
import { type CallerKind as Kind, callOf, type OneProof, oneProof } from '../../support/call.ts';

type FirewallReading = () => Promise<{ state: 'stale'; detail: string } | undefined>;

function subsystem(probed: string[], firewall?: FirewallReading, failing = false) {
  return {
    tester: new BrowserProxyTester({
      saved: async () => ({ url: 'http://proxy.example:8080', bypass: [] }),
      secrets: async () => new Map([['PROXY_PASSWORD', 'hunter2']]),
      probe: {
        run: async () => {
          probed.push('run');
          if (failing) throw new Error('the proxy did not answer');
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
  proof?: OneProof,
  failing = false,
) {
  const routes = proxyRoutes(subsystem(probed, firewall, failing)) as Record<
    string,
    (call: never) => Promise<{ status: number; body: string }>
  >;
  const handle = routes[`${method} ${path}`];
  if (handle === undefined) throw new Error(`no route ${method} ${path}`);
  const { call, spent } = callOf({ method, path, body, kind, fresh, ...(proof === undefined ? {} : { proof }) });
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

  it('G22 asks a paired device for a passkey first, then claims it before the test runs', async () => {
    const probed: string[] = [];
    const asked = await drive(probed, 'POST', '/v1/browser/proxy/test', {}, 'device');
    should(asked.status).equal(403);
    should(asked.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(probed).have.length(0);
    const confirmed = await drive(probed, 'POST', '/v1/browser/proxy/test', {}, 'device', true);
    should(confirmed.status).equal(200);
    should(confirmed.spent).equal(1);
  });

  it('G22 G25 a ferret is refused 403 forbidden before any claim, whatever the proof says', async () => {
    const proof = oneProof();
    const answer = await drive([], 'POST', '/v1/browser/proxy/test', {}, 'agent', true, undefined, proof);
    should([answer.status, answer.body.code, proof.claimed]).eql([403, 'forbidden', 0]);
  });

  it('G22 the owner at the machine tests with no passkey and claims nothing', async () => {
    const proof = oneProof();
    const answer = await drive([], 'POST', '/v1/browser/proxy/test', {}, 'host', false, undefined, proof);
    should([answer.status, proof.claimed]).eql([200, 0]);
  });

  it('G22 the demand a device is asked for is fleet.configure, as today’s shared ownerOnly asks', async () => {
    const asked = await drive([], 'POST', '/v1/browser/proxy/test', {}, 'device');
    should(asked.body.demand).eql({ capability: 'fleet', axis: 'configure' });
  });

  it('G22 one proof cannot carry a second act: two tests admitted on one proof answer 200 then 403', async () => {
    // Both calls are built (so both snapshot the proof as fresh) before either test runs.
    const proof = oneProof();
    const probed: string[] = [];
    const routes = proxyRoutes(subsystem(probed)) as unknown as Record<
      string,
      (call: never) => Promise<{ status: number; body: string }>
    >;
    const calls = [0, 1].map(
      () =>
        callOf({ method: 'POST', path: '/v1/browser/proxy/test', body: {}, kind: 'device', fresh: true, proof }).call,
    );
    should(calls.map(call => (call as { presentation?: { freshStepUp: boolean } }).presentation?.freshStepUp)).eql([
      true,
      true,
    ]);
    const answers = await Promise.all(calls.map(call => routes['POST /v1/browser/proxy/test']!(call as never)));
    should(answers.map(answer => answer.status).sort()).eql([200, 403]);
    should(JSON.parse(answers.find(answer => answer.status === 403)!.body).code).equal(STEP_UP_REQUIRED_CODE);
    should([probed.length, proof.claimed]).eql([1, 1]);
  });

  it('G22 a test that throws has used the proof up: the retry on the same proof is asked again (claim-first, no restore)', async () => {
    const proof = oneProof();
    const failure = await drive([], 'POST', '/v1/browser/proxy/test', {}, 'device', true, undefined, proof, true).then(
      () => undefined,
      (error: unknown) => error,
    );
    should(failure).be.an.Error();
    should(proof.claimed).equal(1);
    const retry = await drive([], 'POST', '/v1/browser/proxy/test', {}, 'device', true, undefined, proof);
    should([retry.status, retry.body.code]).eql([403, STEP_UP_REQUIRED_CODE]);
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
