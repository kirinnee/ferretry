import { describe, it } from 'bun:test';
import { type BrowserProxySetting, BrowserProxyTestResultSchema } from '@ferretry/protocol';
import should from 'should';
import {
  BrowserProxyTester,
  classifyNetworkError,
  type ProbeOutcome,
  type ProxyEndpoint,
  parseProbeReply,
} from '../../../../src/lib/browser/proxy/index.ts';

const SAVED: BrowserProxySetting = { url: 'http://proxy.example:8080', bypass: [] };
const SIGNED_IN: BrowserProxySetting = {
  url: 'socks5://proxy.example:1080',
  bypass: [],
  username: '${secret:PROXY_USER}',
  password: '${secret:PROXY_PASSWORD}',
};

function tester(options: {
  readonly saved?: BrowserProxySetting | null;
  readonly secrets?: ReadonlyMap<string, string>;
  readonly outcome?: ProbeOutcome;
  readonly clock?: readonly number[];
}) {
  const asked: { endpoint: ProxyEndpoint; credentials?: { username: string; password: string } }[] = [];
  const ticks = [...(options.clock ?? [100, 340])];
  const service = new BrowserProxyTester({
    saved: async () => options.saved ?? null,
    secrets: async () => options.secrets ?? new Map(),
    probe: {
      run: async request => {
        asked.push(request);
        return options.outcome ?? { ok: true, egressIp: '203.0.113.7' };
      },
    },
    now: () => ticks.shift() ?? 0,
  });
  return { service, asked };
}

describe('testing the browser proxy', () => {
  it('reports the egress address and the round trip when the saved proxy answers', async () => {
    const { service, asked } = tester({ saved: SAVED });
    const result = await service.test({});
    should(BrowserProxyTestResultSchema.parse(result)).eql(result);
    should(result).containEql({ reachable: true, tested: 'saved', roundTripMs: 240, egressIp: '203.0.113.7' });
    should(asked[0]?.endpoint).eql({ scheme: 'http', host: 'proxy.example', port: 8080 });
    should(asked[0]?.credentials).be.undefined();
  });

  it('tests the unsaved setting it is given, not the saved one', async () => {
    const { service, asked } = tester({ saved: SAVED });
    const result = await service.test({ proxy: { url: 'http://other.example:3128', bypass: [] } });
    should(result).containEql({ reachable: true, tested: 'unsaved' });
    should(asked[0]?.endpoint.host).equal('other.example');
  });

  it('resolves the secrets a setting names inside the daemon and hands them only to the probe', async () => {
    const { service, asked } = tester({
      secrets: new Map([
        ['PROXY_USER', 'amy'],
        ['PROXY_PASSWORD', 'hunter2'],
      ]),
    });
    const result = await service.test({ proxy: SIGNED_IN });
    should(asked[0]?.credentials).eql({ username: 'amy', password: 'hunter2' });
    should(JSON.stringify(result)).not.match(/amy|hunter2|PROXY_USER|proxy\.example/u);
  });

  it('says there is nothing to test when no proxy is saved or given', async () => {
    const { service, asked } = tester({});
    should(await service.test({})).containEql({ reachable: false, errorClass: 'no-proxy' });
    should(asked).have.length(0);
  });

  it('names a missing secret and attempts nothing', async () => {
    const { service, asked } = tester({});
    const result = await service.test({ proxy: SIGNED_IN });
    should(result).containEql({ reachable: false, errorClass: 'secret' });
    should((result as { message: string }).message).match(/PROXY_USER/u);
    should(asked).have.length(0);
  });

  for (const errorClass of ['dns', 'connect', 'auth', 'tls', 'timeout', 'proxy', 'other'] as const) {
    it(`carries the ${errorClass} class through with a sentence and a time`, async () => {
      const { service } = tester({ saved: SAVED, outcome: { ok: false, errorClass } });
      const result = await service.test({});
      should(BrowserProxyTestResultSchema.parse(result)).eql(result);
      should(result).containEql({ reachable: false, tested: 'saved', errorClass, roundTripMs: 240 });
    });
  }

  it('words a 407 differently when no credentials were set', async () => {
    const { service } = tester({ saved: SAVED, outcome: { ok: false, errorClass: 'auth' } });
    should(((await service.test({})) as { message: string }).message).match(/none are set/u);
  });
});

describe('reading what the network said', () => {
  it('classifies socket errors by their code', () => {
    should(classifyNetworkError({ code: 'ENOTFOUND' })).equal('dns');
    should(classifyNetworkError({ code: 'EAI_AGAIN' })).equal('dns');
    should(classifyNetworkError({ code: 'ECONNREFUSED' })).equal('connect');
    should(classifyNetworkError({ code: 'ECONNRESET' })).equal('connect');
    should(classifyNetworkError({ code: 'ETIMEDOUT' })).equal('timeout');
    should(classifyNetworkError(new Error('timed out'))).equal('timeout');
    should(classifyNetworkError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).equal('tls');
    should(classifyNetworkError({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).equal('tls');
    should(classifyNetworkError(new Error('the connection closed'))).equal('other');
  });

  it('reads a plain reply and a chunked one', () => {
    should(parseProbeReply('HTTP/1.0 200 OK\r\nContent-Length: 11\r\n\r\n203.0.113.7\n')).eql({
      status: 200,
      body: '203.0.113.7',
    });
    should(parseProbeReply('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n203.0.113.7\r\n0\r\n\r\n')).eql({
      status: 200,
      body: '203.0.113.7',
    });
    should(parseProbeReply('HTTP/1.1 403 Forbidden\r\n\r\nno')).eql({ status: 403, body: 'no' });
    should(parseProbeReply('not http')).be.undefined();
  });
});
