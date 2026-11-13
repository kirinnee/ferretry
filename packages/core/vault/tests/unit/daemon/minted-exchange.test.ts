import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { definePlugin, implementDaemon, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { type MintedExchangeOutcome, type SecretName, VaultPort } from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';

/**
 * A plugin may have the Vault place a secret on a request only when THAT plugin wrote the secret's current value (the
 * Vault's own mint ledger), and it never receives the value: what comes back is the server's reply with the credential
 * masked out of it. A name that merely matches the manifest's minted pattern is not enough.
 */
const FAKE_TOKEN = 'FAKE-MCP-TOKEN-0123456789';
const ACCESS = 'MCP_WORK_0123456789ABCDEF_ACCESS' as SecretName;
const MINTING: Permissions = {
  network: ['mcp.example.test'],
  spawn: [],
  secrets: [],
  mintedSecrets: ['MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS'],
};
const URL_OK = 'https://mcp.example.test/rpc';
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const tenant = (id: string, permissions: Permissions) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { vault: VaultPort },
      permissions,
    }),
    { build: () => ({}) },
  );

async function world(echo = false) {
  const seen: { host: string; headers: Record<string, string>; redirect: string | undefined }[] = [];
  const host = await testHost({
    plugins: [vault, tenant('mcp', MINTING), tenant('other', MINTING)],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    fetch: (url, init) => {
      seen.push({
        host: url.host,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        redirect: init?.redirect,
      });
      const header = new Headers(init?.headers).get('authorization') ?? '';
      return echo
        ? new Response(`{"echo":"${header}"}`, { headers: { 'x-echo': header, 'content-type': 'application/json' } })
        : new Response('{"ok":true}');
    },
  });
  hosts.push(host);
  await host.runJob('inputs-restore');
  return { core: host.provided(VaultPort), of: (id: string) => host.provided(VaultPort, id), seen };
}

const exchange = (url = URL_OK) => ({
  method: 'POST' as const,
  url,
  headers: { accept: 'application/json' },
  body: '{}',
});
const text = async (outcome: MintedExchangeOutcome): Promise<string> => {
  if (outcome.kind !== 'response') throw new Error(`no response: ${outcome.kind}`);
  return await outcome.response.text();
};

describe('a plugin places only a secret it minted, and never holds it', () => {
  test('a secret the plugin put itself is placed on the request as a bearer, and the reply carries no value', async () => {
    const { of, seen } = await world(true);
    const api = of('mcp');
    await api.put(ACCESS, FAKE_TOKEN);

    const outcome = await api.fetchMinted?.(ACCESS, exchange());
    if (outcome === undefined) throw new Error('the Vault offers no minted exchange');

    expect(seen[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(seen[0]?.redirect).toBe('manual');
    const body = await text(outcome);
    expect(body).not.toContain(FAKE_TOKEN);
    expect(body).toContain('[redacted]');
    if (outcome.kind === 'response') expect(outcome.response.headers.get('x-echo')).not.toContain(FAKE_TOKEN);
  });

  test('a value the OWNER put under a name the minted pattern matches is refused, and nothing is sent', async () => {
    const { core, of, seen } = await world();
    await core.put(ACCESS, FAKE_TOKEN);

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('a value the owner REPLACES after the plugin minted it is no longer the plugin’s', async () => {
    const { core, of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);
    await core.put(ACCESS, 'FAKE-OWNER-VALUE');

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('another plugin that mints the same pattern cannot place what MCP minted', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    expect(await of('other').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('a destination the plugin’s own manifest does not allow is refused, with the minted secret', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange('https://elsewhere.example.test/rpc'))).toEqual({
      kind: 'refused',
    });
    expect(seen).toEqual([]);
  });

  test('a request that already carries the credential header is refused', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    const asked = { ...exchange(), headers: { Authorization: 'Bearer mine' } };
    expect(await of('mcp').fetchMinted?.(ACCESS, asked)).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('the plugin’s port still has no way to read a value: only names go in, only a masked reply comes out', async () => {
    const { of } = await world(true);
    const api = of('mcp');
    await api.put(ACCESS, FAKE_TOKEN);
    const outcome = await api.fetchMinted?.(ACCESS, exchange());
    expect(JSON.stringify({ ...outcome, response: undefined })).not.toContain(FAKE_TOKEN);
    expect(Object.keys(api).filter(key => /^(get|read|reveal|values)/iu.test(key))).toEqual([]);
  });
});
