/** NN: `kernel.secrets.resolve` — declared, named by the plugin's OWN config, known to the Vault; masked everywhere else. */
import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { z } from 'zod';
import { KERNEL_ONLY_PORTS, SecretResolverPort } from '../../../contract/bound.ts';
import { defineConfig } from '../../../contract/define.ts';
import { jsonResponse } from '../../../contract/http.ts';
import type { SecretsPort } from '../../../contract/secrets.ts';
import { OwnSecret } from '../../../contract/secrets.ts';
import { ownSecretsPort, secretReferencesIn } from '../../../host/secrets.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const scoped = { minimum: 'authenticated', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const Proxy = z.strictObject({ url: z.string(), password: z.string().optional() });
const BrowsersProxy = defineConfig({
  file: 'browsers/proxy.yaml',
  schema: Proxy,
  axis: 'configure',
  loosens: () => [],
});
const OtherProxy = defineConfig({ file: 'other/proxy.yaml', schema: Proxy, axis: 'configure', loosens: () => [] });

const browsersManifest = definePlugin({
  id: 'browsers',
  title: 'Browsers',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { secrets: ['PROXY_PASS', 'NOT_IN_CONFIG', 'OTHER_KEY'] },
  actions: { routes: [route('GET /v1/browsers/leak', scoped)] },
  data: { config: [BrowsersProxy] },
});
const otherManifest = definePlugin({
  id: 'other',
  title: 'Other',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { secrets: ['OTHER_KEY'] },
  data: { config: [OtherProxy] },
});

async function browsersSecrets(vault: Record<string, string> | undefined) {
  let port: SecretsPort | undefined;
  const browsers = implementDaemon(browsersManifest, {
    build: ({ kernel }) => {
      port = kernel.secrets;
      return {
        routes: {
          'GET /v1/browsers/leak': async () => {
            const secret = await kernel.secrets.resolve('PROXY_PASS');
            return jsonResponse({ secret });
          },
        },
      };
    },
  });
  const other = implementDaemon(otherManifest, { build: () => ({}) });
  const host = await testHost({
    plugins: [browsers, other],
    config: {
      'browsers/proxy.yaml': { url: 'http://proxy:3128', password: '${secret:PROXY_PASS}' },
      'other/proxy.yaml': { url: 'http://proxy:3128', password: 'Bearer ${secret:OTHER_KEY}' },
    },
    ...(vault === undefined ? {} : { vault }),
  });
  if (port === undefined) throw new Error('not built');
  return { host, secrets: port };
}

describe('NN kernel.secrets.resolve: a plugin’s own secret for its own daemon-side use', () => {
  test('declared, named by its own config, and known to the Vault: the value reaches the caller only through reveal()', async () => {
    const { host, secrets } = await browsersSecrets({ PROXY_PASS: 'hunter2-value', OTHER_KEY: 'other-value' });
    const resolved = await secrets.resolve('PROXY_PASS');
    if (!(resolved instanceof OwnSecret)) throw new Error('refused');
    expect(resolved.reveal()).toBe('hunter2-value');
    await host.stop();
  });

  test('an undeclared name, a declared name its config does not name, and another plugin’s reference are refused', async () => {
    const { host, secrets } = await browsersSecrets({ PROXY_PASS: 'v', OTHER_KEY: 'v', UNDECLARED: 'v' });
    expect(await secrets.resolve('UNDECLARED')).toEqual({ refused: 'not_declared' });
    expect(await secrets.resolve('proxy_pass')).toEqual({ refused: 'not_declared' });
    expect(await secrets.resolve('NOT_IN_CONFIG')).toEqual({ refused: 'not_configured' });
    // OTHER_KEY is declared by Browsers too, but only Other's config names it
    expect(await secrets.resolve('OTHER_KEY')).toEqual({ refused: 'not_configured' });
    await host.stop();
  });

  test('a name the Vault does not know, or no Vault at all, is unknown', async () => {
    const known = await browsersSecrets({});
    expect(await known.secrets.resolve('PROXY_PASS')).toEqual({ refused: 'unknown' });
    await known.host.stop();
    const none = await browsersSecrets(undefined);
    expect(await none.secrets.resolve('PROXY_PASS')).toEqual({ refused: 'unknown' });
    await none.host.stop();
  });

  test('logging, JSON, string conversion and inspection show only the mask', () => {
    const secret = new OwnSecret('PROXY_PASS', 'hunter2-value');
    const shown = [
      String(secret),
      `${secret}`,
      JSON.stringify({ secret }),
      inspect(secret),
      inspect({ nested: [secret] }),
      Bun.inspect(secret),
      Object.keys(secret).join(','),
      JSON.stringify(Object.entries(secret)),
    ];
    for (const text of shown) expect(text.includes('hunter2')).toBe(false);
    expect(String(secret)).toBe('[secret:PROXY_PASS]');
    expect(JSON.stringify(secret)).toBe('"[secret:PROXY_PASS]"');
  });

  test('a route answering an OwnSecret serialises the mask, never the value', async () => {
    const { host } = await browsersSecrets({ PROXY_PASS: 'hunter2-value' });
    const response = await host.request('GET', '/v1/browsers/leak');
    expect(response.status).toBe(200);
    expect(response.body.includes('hunter2')).toBe(false);
    expect(response.json()).toEqual({ secret: '[secret:PROXY_PASS]' });
    await host.stop();
  });

  test('the order is the contract: the Vault is never asked before the name is declared and configured', async () => {
    const asked: string[] = [];
    const port = ownSecretsPort(
      ['A_KEY'],
      () => new Set(['B_KEY']),
      () => ({
        resolve: async name => {
          asked.push(name);
          return 'v';
        },
      }),
    );
    await port.resolve('B_KEY');
    await port.resolve('A_KEY');
    expect(asked).toEqual([]);
    const throwing = ownSecretsPort(
      ['A_KEY'],
      () => new Set(['A_KEY']),
      () => ({
        resolve: async () => {
          throw new Error('vault sealed');
        },
      }),
    );
    expect(await throwing.resolve('A_KEY')).toEqual({ refused: 'unknown' });
  });

  test('the resolver is kernel-only, and references are read from every string in a config value', () => {
    expect(KERNEL_ONLY_PORTS).toContain(SecretResolverPort.name);
    expect([...secretReferencesIn({ a: ['x ${secret:ONE} y', { b: '${secret:TWO}' }], c: '${secret:lower}' })]).toEqual(
      ['ONE', 'TWO'],
    );
  });
});
