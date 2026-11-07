import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthorizedOutcome, OutboundHttpRequest, VaultApi } from '@ferretry/core-vault/contract';
import { definePlugin, implementDaemon, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { type LoginId, LoginsPort } from '../../../contract/index.ts';
import { buildLoginsDaemon } from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

/**
 * Logins' `authorizeFetch` is held two ways (§3.7): to the hosts of THE LOGIN'S OWN record (today's keyed Test rule), and to
 * the CALLER's own manifest network. Booted for real over a fake Vault that records what Logins finally asks it.
 */
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const ZAI = { harness: 'claude-code', store: 'environment', env: {} as Record<string, string> };
const logins = {
  // A key-safe base URL of its own and a whole-secret key.
  glm: {
    ...ZAI,
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
  },
  // A proxy on this machine.
  proxy: {
    ...ZAI,
    env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_AUTH_TOKEN: '${secret:PROXY_KEY}' },
  },
  // A built-in preset, whose quota is read at a host beside the one it sends to.
  mm: {
    ...ZAI,
    preset: 'minimax',
    env: { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_API_KEY: '${secret:MINIMAX_API_KEY}' },
  },
};

const asking = (url: string): OutboundHttpRequest => ({
  method: 'GET',
  url,
  headers: {},
  timeoutMs: 1_000,
  maxResponseBytes: 4_096,
});

const needer = (id: string, permissions: Permissions) =>
  definePlugin({
    id,
    title: id,
    version: '1.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { logins: LoginsPort },
    permissions,
  });

/** Usage's declared hosts (its manifest, copied) and a Runtimes-shaped needer that declares none. */
const USAGE: Permissions = {
  network: [
    'api.anthropic.com',
    'chatgpt.com',
    'api.z.ai',
    'www.minimax.io',
    'api.deepseek.com',
    'api.moonshot.ai',
    'openrouter.ai',
    'ai-gateway.vercel.sh',
  ],
  spawn: [],
  secrets: [],
};
const RUNTIMES: Permissions = { network: [], spawn: [], secrets: [] };

async function world() {
  const asked: { name: string; hosts: readonly string[]; url: string }[] = [];
  const vault: VaultApi = {
    ...emptyVault(),
    authorizeFetch: async (name, allowed, request): Promise<AuthorizedOutcome> => {
      asked.push({ name: String(name), hosts: [...allowed], url: request.url });
      return { kind: 'completion', payload: { ok: true } };
    },
  };
  const host = await testHost({
    plugins: [
      buildLoginsDaemon(),
      implementDaemon(needer('usage', USAGE), { build: () => ({}) }),
      implementDaemon(needer('runtimes', RUNTIMES), { build: () => ({}) }),
    ],
    fakes: { vault },
    config: { logins },
    fetch: async () => {
      throw new Error('offline');
    },
  });
  hosts.push(host);
  return { asked, of: (id: string) => host.provided(LoginsPort, id) };
}

const GLM = 'glm' as LoginId;
const KEY = 'ANTHROPIC_AUTH_TOKEN';

describe('Logins puts a login’s key only where that login sends it and only where the caller may reach', () => {
  test('S162 a Runtimes-shaped needer (network: []) reaches nothing through Logins', async () => {
    const { asked, of } = await world();
    const out = await of('runtimes').authorizeFetch(
      GLM,
      KEY,
      ['api.z.ai'],
      asking('https://api.z.ai/api/monitor/usage/quota/limit'),
    );
    expect(out).toEqual({ kind: 'refused' });
    expect(asked).toEqual([]);
  });

  test('S162 Usage’s own quota read for an owner-written login still works, on the login’s own host', async () => {
    const { asked, of } = await world();
    const out = await of('usage').authorizeFetch(
      GLM,
      KEY,
      ['api.z.ai'],
      asking('https://api.z.ai/api/monitor/usage/quota/limit'),
    );
    expect(out).toEqual({ kind: 'completion', payload: { ok: true } });
    // The secret is the one in the login’s OWN record; only the intersected host went on to the Vault.
    expect(asked).toEqual([
      { name: 'ZAI_API_KEY', hosts: ['api.z.ai'], url: 'https://api.z.ai/api/monitor/usage/quota/limit' },
    ]);
  });

  test('S162 Usage is refused for localhost even for a login that sends to localhost: Usage declares no such host', async () => {
    const { asked, of } = await world();
    const out = await of('usage').authorizeFetch(
      'proxy' as LoginId,
      KEY,
      ['localhost:4000'],
      asking('http://localhost:4000/key/info'),
    );
    expect(out).toEqual({ kind: 'refused' });
    expect(asked).toEqual([]);
  });

  test('S162 a host the login does not send to is refused, however the caller names it', async () => {
    const { asked, of } = await world();
    // Usage declares api.deepseek.com, but the z.ai login’s key is not DeepSeek’s to receive; localhost is nobody’s here.
    for (const named of [['api.deepseek.com'], ['localhost:9999'], ['api.openai.com']]) {
      const out = await of('usage').authorizeFetch(GLM, KEY, named, asking('https://api.deepseek.com/user/balance'));
      expect([named, out]).toEqual([named, { kind: 'refused' }]);
    }
    expect(asked).toEqual([]);
  });

  test('S162 a list that mixes the login’s host with another reaches the Vault with the login’s host alone', async () => {
    const { asked, of } = await world();
    await of('usage').authorizeFetch(
      GLM,
      KEY,
      ['api.z.ai', 'api.deepseek.com'],
      asking('https://api.deepseek.com/user/balance'),
    );
    // The Vault then refuses the URL itself: its host is not on the list it was given.
    expect(asked.map(call => call.hosts)).toEqual([['api.z.ai']]);
  });

  test('S162 a built-in preset’s quota host (beside the one the login sends to) is allowed; a machine preset’s is not', async () => {
    const { asked, of } = await world();
    const out = await of('usage').authorizeFetch(
      'mm' as LoginId,
      'ANTHROPIC_API_KEY',
      ['www.minimax.io'],
      asking('https://www.minimax.io/v1/token_plan/remains'),
    );
    expect(out).toEqual({ kind: 'completion', payload: { ok: true } });
    expect(asked).toEqual([
      { name: 'MINIMAX_API_KEY', hosts: ['www.minimax.io'], url: 'https://www.minimax.io/v1/token_plan/remains' },
    ]);
  });

  test('S12 S62 a variable that is not the login’s whole-secret key, or a login that does not exist, is refused', async () => {
    const { asked, of } = await world();
    const out = await of('usage').authorizeFetch(GLM, 'ANTHROPIC_BASE_URL', ['api.z.ai'], asking('https://api.z.ai/x'));
    expect(out).toEqual({ kind: 'refused' });
    const missing = await of('usage').authorizeFetch(
      'nobody' as LoginId,
      KEY,
      ['api.z.ai'],
      asking('https://api.z.ai/x'),
    );
    expect(missing).toEqual({ kind: 'refused' });
    expect(asked).toEqual([]);
  });

  test('S3 S162 a host list that changes after the first read is never what the Vault is asked', async () => {
    const { asked, of } = await world();
    let reads = 0;
    const swapped = {
      method: 'GET',
      get url() {
        return reads++ === 0 ? 'https://api.z.ai/api/monitor/usage/quota/limit' : 'https://evil.test/steal';
      },
      headers: {},
      timeoutMs: 1_000,
      maxResponseBytes: 4_096,
    } as unknown as OutboundHttpRequest;
    await of('usage').authorizeFetch(GLM, KEY, ['api.z.ai'], swapped);
    expect(asked.map(call => call.url)).toEqual(['https://api.z.ai/api/monitor/usage/quota/limit']);
  });
});
