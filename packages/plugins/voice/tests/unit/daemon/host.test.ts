import { describe, expect, test } from 'bun:test';
import {
  type AuthorizedOutcome,
  type OutboundHttpRequest,
  type SecretName,
  allowedDestination,
} from '@ferretry/core-vault/contract';
import { FakeVault, type FakeTransport } from '@ferretry/core-vault/contract/testing';
import { device, ferret, owner, testHost, warden } from '@ferretry/kernel/testing';
import {
  CLEANUP_PROVIDERS,
  SttEnhancementRequestSchema,
  SttEnhancementResultSchema,
  SpeedupsViewSchema,
  SpeedupTestResultSchema,
} from '../../../contract/index.ts';
import voice from '../../../daemon/index.ts';
import { OutboundProviderAuthorizer } from '../../../daemon/adapters/outbound-provider-authorizer.ts';
import { SPEEDUP_CATALOG } from '../../../daemon/lib/speedups/catalog.ts';
import manifest from '../../../manifest.ts';

const GROQ_KEY = 'gsk_test_0123456789abcdef';
const CEREBRAS_KEY = 'csk_test_0123456789abcdef';
const JEV_KEY = 'jev_test_0123456789abcdef';

const chat = (content: string): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { choices: [{ message: { content }, finish_reason: 'stop' }] },
});

/** A Vault fake holding the keys it is given, answering requests through `transport` and recording each. */
async function vaultWith(
  keys: Readonly<Record<string, string>>,
  transport: (request: OutboundHttpRequest) => AuthorizedOutcome = () => chat('Hello, world.'),
) {
  const sent: OutboundHttpRequest[] = [];
  const recording: FakeTransport = request => {
    sent.push(request);
    return transport(request);
  };
  const vault = new FakeVault(undefined, recording);
  for (const [name, value] of Object.entries(keys)) await vault.put(name as SecretName, value);
  return { vault, sent };
}

async function hostOf(vault: FakeVault, config: Record<string, unknown> = {}) {
  return await testHost({
    plugins: [voice],
    fakes: { vault },
    config: { 'voice.yaml': { postProcessing: { provider: 'groq' }, ...config } },
  });
}

const enhance = { text: 'helo wold', provider: 'groq' };

describe('the dictation route (POST /v1/stt/enhance)', () => {
  test('serves one route over the path the shipped clients already speak, as the operator', () => {
    const route = manifest.actions.routes.filter(candidate => candidate.path.startsWith('/v1/stt'));
    expect(route.map(candidate => `${candidate.method} ${candidate.path}`)).toEqual(['POST /v1/stt/enhance']);
    expect(route[0]?.minimum).toBe('operator');
  });

  test('returns the repaired transcript and never the key', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    expect(response.status).toBe(200);
    expect(SttEnhancementResultSchema.parse(response.json())).toMatchObject({ text: 'Hello, world.', provider: 'groq' });
    expect(response.body).not.toContain(GROQ_KEY);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(CLEANUP_PROVIDERS.groq.endpoint);
  });

  test('answers a failure with the status and code the domain decided', async () => {
    const { vault } = await vaultWith({ GROQ_API_KEY: GROQ_KEY }, () => ({ kind: 'status', status: 429 }));
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    expect(response.status).toBe(429);
    expect(response.json()).toMatchObject({ code: 'rate_limited' });
  });

  test('refuses a body that is not JSON, before anything is sent', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/stt/enhance', { body: 'not json', as: owner() });
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({ code: 'bad_request' });
    expect(sent).toHaveLength(0);
  });

  test('a defect is a 500 that never echoes the thrown message', async () => {
    const { vault } = await vaultWith({ GROQ_API_KEY: GROQ_KEY }, () => {
      throw new Error('the transport exploded at /home/operator/.fy/secrets');
    });
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('secrets');
  });

  test('refuses a ferret and a warden: enhancement spends the operator’s provider account', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    expect((await host.request('POST', '/v1/stt/enhance', { body: enhance, as: ferret('f1') })).status).toBe(403);
    expect((await host.request('POST', '/v1/stt/enhance', { body: enhance, as: warden() })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test('cleanup switched off in voice.yaml refuses the call without sending it', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault, { postProcessing: { provider: 'groq', style: 'off' } });
    const response = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe('the speed-ups routes', () => {
  test('both are operator-only, uncacheable and governed as secrets.use; the Test records secrets.used', () => {
    const routes = manifest.actions.routes.filter(candidate => candidate.path.startsWith('/v1/speedups'));
    expect(routes.map(candidate => `${candidate.method} ${candidate.path}`)).toEqual([
      'GET /v1/speedups',
      'POST /v1/speedups/:provider/test',
    ]);
    expect(routes.every(candidate => candidate.minimum === 'operator' && candidate.noStore === true)).toBe(true);
    expect(routes.every(candidate => candidate.capability?.axis === 'use')).toBe(true);
    expect(JSON.stringify(routes[1]?.audit)).toContain('secrets.used');
  });

  test('the status read lists the three providers by name', async () => {
    const { vault } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const response = await host.request('GET', '/v1/speedups', { as: owner() });
    const view = SpeedupsViewSchema.parse(response.json());
    expect(view.providers.map(provider => [provider.provider, provider.set])).toEqual([
      ['jev', false],
      ['groq', true],
      ['cerebras', false],
    ]);
    expect(view.vault).toBe('ok');
  });

  test('a Test of a model-list provider lists models once and remembers the answer', async () => {
    const { vault, sent } = await vaultWith({ CEREBRAS_API_KEY: CEREBRAS_KEY }, () => ({
      kind: 'completion',
      payload: { data: [] },
    }));
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/speedups/cerebras/test', { as: owner() });
    expect(SpeedupTestResultSchema.parse(response.json())).toMatchObject({ provider: 'cerebras', ok: true });
    expect(sent.map(request => [request.method, request.url])).toEqual([['GET', CLEANUP_PROVIDERS.cerebras.modelsUrl]]);
    const view = SpeedupsViewSchema.parse((await host.request('GET', '/v1/speedups', { as: owner() })).json());
    expect(view.providers.find(provider => provider.provider === 'cerebras')?.lastTest?.ok).toBe(true);
  });

  test('refuses a provider it does not know without testing anything', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/speedups/openai/test', { as: owner() });
    expect([response.status, (response.json() as { code: string }).code]).toEqual([404, 'unknown_provider']);
    expect(sent).toHaveLength(0);
  });

  test('refuses a warden: a Test bills the operator', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    expect((await host.request('POST', '/v1/speedups/groq/test', { as: warden() })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test('a device without secrets.use is refused both routes', async () => {
    const { vault } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const as = device('d1', ['terminal.use']);
    expect((await host.request('GET', '/v1/speedups', { as })).status).toBe(403);
    expect((await host.request('POST', '/v1/speedups/groq/test', { as })).status).toBe(403);
  });
});

describe('Appendix D rows', () => {
  test('S162 a speed-up key is spent only through one holder that puts one named secret on one request as a header', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    // The key rides on exactly one request, as the bearer header the holder placed; the caller's request carried none.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${GROQ_KEY}`);
    // What comes back is the status, a parsed reply or a refusal — never the request.
    expect(response.body).not.toContain(GROQ_KEY);
    expect(response.body).not.toContain('authorization');
    // Voice's holder is the Vault's: it forwards the name, the allowed hosts and the request, and nothing else.
    const forwarded: unknown[][] = [];
    const holder = new OutboundProviderAuthorizer({
      authorizeFetch: async (...args) => {
        forwarded.push(args);
        return { kind: 'refused' };
      },
    });
    await holder.send('GROQ_API_KEY' as SecretName, ['api.groq.com'], sent[0] as OutboundHttpRequest);
    expect(forwarded[0]?.slice(0, 2)).toEqual(['GROQ_API_KEY', ['api.groq.com']]);
  });

  test('S163 the URL must be https (or http to this machine) with a host exactly on that secret’s list, or nothing is sent', async () => {
    for (const entry of Object.values(SPEEDUP_CATALOG)) {
      const endpoint = entry.probe.kind === 'model-list' ? entry.probe.url : `https://${entry.hosts[0]}/v1/x`;
      expect(allowedDestination(endpoint, entry.hosts)).toBe(true);
      expect(allowedDestination(endpoint.replace('https:', 'http:'), entry.hosts)).toBe(false);
      expect(allowedDestination(`https://${entry.hosts[0]}.evil.test/v1/x`, entry.hosts)).toBe(false);
      expect(allowedDestination(`https://user:pw@${entry.hosts[0]}/v1/x`, entry.hosts)).toBe(false);
    }
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const holder = new OutboundProviderAuthorizer(vault);
    const request: OutboundHttpRequest = {
      method: 'GET',
      url: 'https://api.cerebras.ai/v1/models',
      headers: {},
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    };
    // A Groq key never reaches another provider's host, even a real provider's.
    expect(await holder.send('GROQ_API_KEY' as SecretName, SPEEDUP_CATALOG.groq.hosts, request)).toEqual({
      kind: 'refused',
    });
    expect(sent).toHaveLength(0);
  });

  test('S164 a request that already carries the credential header is refused', async () => {
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const holder = new OutboundProviderAuthorizer(vault);
    const request: OutboundHttpRequest = {
      method: 'GET',
      url: CLEANUP_PROVIDERS.groq.modelsUrl,
      headers: { Authorization: 'Bearer something-else' },
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    };
    expect(await holder.send('GROQ_API_KEY' as SecretName, SPEEDUP_CATALOG.groq.hosts, request)).toEqual({
      kind: 'refused',
    });
    expect(sent).toHaveLength(0);
  });

  test('S165 a reply that contains the key is reported as unreadable', async () => {
    const { vault } = await vaultWith({ GROQ_API_KEY: GROQ_KEY }, () => chat(`here is your key ${GROQ_KEY}`));
    const host = await hostOf(vault);
    const response = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    expect(response.status).toBe(502);
    expect(response.json()).toMatchObject({ code: 'malformed_response' });
    expect(response.body).not.toContain(GROQ_KEY);
  });

  test('S166 a damaged vault is reported as damaged, never as "no key"', async () => {
    class DamagedVault extends FakeVault {
      override async names(): Promise<never> {
        throw Object.assign(new Error('the sealed store cannot be read'), { name: 'SecretStoreError' });
      }
      override async authorizeFetch(): Promise<AuthorizedOutcome> {
        return { kind: 'vault_damaged' };
      }
    }
    const host = await hostOf(new DamagedVault());
    const view = SpeedupsViewSchema.parse((await host.request('GET', '/v1/speedups', { as: owner() })).json());
    expect(view.vault).toBe('damaged');
    const test = SpeedupTestResultSchema.parse((await host.request('POST', '/v1/speedups/groq/test', { as: owner() })).json());
    expect(test.code).toBe('vault_damaged');
    expect(test.code).not.toBe('not_set');
    const dictation = await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() });
    expect((dictation.json() as { error: string }).error).toContain('cannot be read');
  });

  test('S167 callers are handed no value; a Test goes only to the provider’s fixed endpoint', async () => {
    const keys = { GROQ_API_KEY: GROQ_KEY, CEREBRAS_API_KEY: CEREBRAS_KEY, JEV_API_KEY: JEV_KEY };
    const { vault, sent } = await vaultWith(keys, request =>
      request.url.includes('systemone')
        ? { kind: 'completion', payload: { answers: { triage: { choice: 'leave', confidence: 0.9 } } } }
        : { kind: 'completion', payload: { data: [] } },
    );
    const host = await hostOf(vault);
    const bodies: string[] = [];
    for (const provider of ['jev', 'groq', 'cerebras'])
      bodies.push((await host.request('POST', `/v1/speedups/${provider}/test`, { as: owner() })).body);
    bodies.push((await host.request('GET', '/v1/speedups', { as: owner() })).body);
    bodies.push((await host.request('POST', '/v1/stt/enhance', { body: enhance, as: owner() })).body);
    for (const body of bodies) for (const key of Object.values(keys)) expect(body).not.toContain(key);
    const reached = [...new Set(sent.map(request => new URL(request.url).host))].sort();
    expect(reached).toEqual(['api.cerebras.ai', 'api.groq.com', 'api.typesafe.ai']);
    expect(sent.every(request => request.url.startsWith('https://'))).toBe(true);
  });

  test('S168 GET /v1/speedups reports "set" from the name listing and never opens the vault', async () => {
    let opened = 0;
    class SpiedVault extends FakeVault {
      override async authorizeFetch(): Promise<AuthorizedOutcome> {
        opened += 1;
        return { kind: 'refused' };
      }
      override async run(): ReturnType<FakeVault['run']> {
        opened += 1;
        return { ok: false, error: 'unknown_secret' };
      }
    }
    const spied = new SpiedVault();
    await spied.put('GROQ_API_KEY' as SecretName, GROQ_KEY);
    const host = await hostOf(spied);
    const view = SpeedupsViewSchema.parse((await host.request('GET', '/v1/speedups', { as: owner() })).json());
    expect(view.providers.find(provider => provider.provider === 'groq')?.set).toBe(true);
    expect(opened).toBe(0);
    const routes = manifest.actions.routes.filter(candidate => candidate.path.startsWith('/v1/speedups'));
    expect(routes.map(candidate => candidate.capability?.capability)).toHaveLength(2);
    expect(routes.every(candidate => String(candidate.capability?.capability).includes('secrets'))).toBe(true);
    expect(JSON.stringify(routes.find(candidate => candidate.method === 'POST')?.audit)).toContain('secrets.used');
  });

  test('S169 no key travels to the daemon: the wire has no field to carry one', () => {
    for (const field of ['key', 'apiKey', 'authorization', 'secret', 'token'])
      expect(SttEnhancementRequestSchema.safeParse({ ...enhance, [field]: 'sk-device-held' }).success).toBe(false);
    // And the manifest names secrets only by NAME for the Vault to spend.
    expect(manifest.permissions?.secrets).toEqual(['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'JEV_API_KEY']);
  });

  test('R626 no microphone audio crosses the daemon: the only STT route is JSON text', async () => {
    const stt = manifest.actions.routes.filter(candidate => /stt|audio|dictat|transcri/u.test(candidate.path));
    expect(stt.map(candidate => `${candidate.method} ${candidate.path}`)).toEqual(['POST /v1/stt/enhance']);
    expect(Object.keys(manifest.actions)).not.toContain('sockets');
    expect(SttEnhancementRequestSchema.safeParse({ ...enhance, audio: 'AAAA' }).success).toBe(false);
    const { vault, sent } = await vaultWith({ GROQ_API_KEY: GROQ_KEY });
    const host = await hostOf(vault);
    const bytes = String.fromCharCode(...new Uint8Array(64).map((_, index) => index * 4));
    const response = await host.request('POST', '/v1/stt/enhance', { body: bytes, as: owner() });
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
