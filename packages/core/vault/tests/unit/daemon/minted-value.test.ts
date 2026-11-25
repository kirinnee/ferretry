import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { definePlugin, implementDaemon, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { type SecretName, VaultPort } from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';

/**
 * THE ONE GETTER (docs/secrets.md › The one exception): `VaultApi.mintedValue` exists only for a plugin whose manifest
 * declares `permissions.revealMinted`, and answers only a secret THAT plugin wrote the current value of (the Vault's
 * mint ledger). Every other plugin, and the core, has no such method at all: the type-level "no getter" stays true.
 */
const FAKE_TOKEN = 'FAKE-MCP-TOKEN-0123456789';
const ACCESS = 'MCP_WORK_0123456789ABCDEF_ACCESS' as SecretName;
const MINTS: Pick<Permissions, 'network' | 'spawn' | 'secrets' | 'mintedSecrets'> = {
  network: [],
  spawn: [],
  secrets: [],
  mintedSecrets: ['MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS'],
};
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

async function world() {
  const host = await testHost({
    plugins: [
      vault,
      tenant('reveals', { ...MINTS, revealMinted: true }),
      tenant('rival', { ...MINTS, revealMinted: true }),
      tenant('mints', MINTS),
    ],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
  });
  hosts.push(host);
  await host.runJob('inputs-restore');
  return { core: host.provided(VaultPort), of: (id: string) => host.provided(VaultPort, id) };
}

describe('mintedValue: the one getter, for what the plugin itself wrote', () => {
  test('a plugin that declares revealMinted reads back the value it put', async () => {
    const { of } = await world();
    const api = of('reveals');
    await api.put(ACCESS, FAKE_TOKEN);

    expect(await api.mintedValue?.(ACCESS)).toBe(FAKE_TOKEN);
  });

  test('a plugin WITHOUT revealMinted has no such method, even though it mints the same names', async () => {
    const { of } = await world();
    const api = of('mints');
    await api.put(ACCESS, FAKE_TOKEN);

    expect(api.mintedValue).toBeUndefined();
  });

  test('the core caller has no such method either', async () => {
    const { core } = await world();

    expect(core.mintedValue).toBeUndefined();
  });

  test('a value the OWNER put under a name the plugin could mint is not the plugin’s: nothing is returned', async () => {
    const { core, of } = await world();
    await core.put(ACCESS, FAKE_TOKEN);

    expect(await of('reveals').mintedValue?.(ACCESS)).toBeUndefined();
  });

  test('a value ANOTHER plugin minted is not returned, though both declare revealMinted', async () => {
    const { of } = await world();
    await of('rival').put(ACCESS, FAKE_TOKEN);

    expect(await of('reveals').mintedValue?.(ACCESS)).toBeUndefined();
    expect(await of('rival').mintedValue?.(ACCESS)).toBe(FAKE_TOKEN);
  });

  test('once the owner overwrites a minted name, the plugin no longer reads it (the ledger follows the write)', async () => {
    const { core, of } = await world();
    await of('reveals').put(ACCESS, FAKE_TOKEN);
    await core.put(ACCESS, 'FAKE-OWNER-VALUE-9876543210');

    expect(await of('reveals').mintedValue?.(ACCESS)).toBeUndefined();
  });

  test('a name that is not held answers nothing', async () => {
    const { of } = await world();

    expect(await of('reveals').mintedValue?.(ACCESS)).toBeUndefined();
  });
});
