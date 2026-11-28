import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { defineConfig } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { z } from 'zod';
import {
  ChildEnvironmentPort,
  type ProfileSecretReferences,
  ProfileSecrets,
  type SecretName,
  VaultPort,
} from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';

/**
 * The reach MCP's check is given through the REAL Vault (not the fake): the secrets the checked runtime's profile
 * references may go into that one command's environment, nothing else, nothing kept, and no value ever comes back.
 */
const OWN: SecretName = 'MCP_SERVER_KEY';
const PROFILE: SecretName = 'PROFILE_KEY';
const OTHER: SecretName = 'UNRELATED_KEY';
const OWN_VALUE = 'own-value-1f2e';
const PROFILE_VALUE = 'profile-value-77ab';
const VALUES: Record<string, string> = {
  MCP_SERVER_KEY: OWN_VALUE,
  PROFILE_KEY: PROFILE_VALUE,
  UNRELATED_KEY: 'other-value-90cd',
};
const ref = (name: string): string => '${secret:' + name + '}';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const records = defineConfig({
  file: 'mcp/records.yaml',
  schema: z.strictObject({ key: z.string().optional() }),
  axis: 'configure',
  loosens: () => [],
  credentialRecords: true,
});

/** MCP's check, as the Vault sees it: its own server entry names one secret, and it declares the profile reach. */
const mcp = (permissions: Permissions) =>
  implementDaemon(
    definePlugin({
      id: 'mcp',
      title: 'mcp',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { vault: VaultPort },
      permissions,
      data: { config: [records] },
    }),
    { build: () => ({}) },
  );

/** Runtimes, as the Vault sees it: it answers which secret names a runtime's profile references. */
const runtimes = (answer: ProfileSecretReferences) =>
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'runtimes',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: ProfileSecrets, key: 'profiles' }] },
    }),
    { build: () => ({ hooks: { 'secrets.profile-references:profiles': answer } }) },
  );

async function world(options: { permissions: Permissions; answer?: ProfileSecretReferences }) {
  const plugins = [
    vault,
    mcp(options.permissions),
    implementDaemon(
      definePlugin({
        id: 'relocate',
        title: 'relocate',
        version: '1.0.0',
        api: 5,
        core: false,
        kinds: [],
        needs: { vault: VaultPort },
      }),
      { build: () => ({}) },
    ),
    ...(options.answer === undefined ? [] : [runtimes(options.answer)]),
  ];
  const host = await testHost({
    plugins,
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    config: { 'mcp/records.yaml': { key: ref(OWN) } },
  });
  hosts.push(host);
  await host.runJob('inputs-restore');
  const core = host.provided(VaultPort);
  for (const [name, value] of Object.entries(VALUES)) await core.put(name as SecretName, value);
  const api = host.provided(VaultPort, 'mcp');
  const opened = (env: unknown): Readonly<Record<string, string>> | undefined =>
    host.provided(ChildEnvironmentPort).open(env as never);
  return { api, opened, relocate: host.provided(VaultPort, 'relocate'), core };
}

const PROFILE_ONLY: ProfileSecretReferences = {
  references: async runtime => (runtime === 'claude-work' ? [PROFILE] : []),
};

describe('Relocate asks presence for one runtime, inside the Vault', () => {
  test('a held runtime secret is present even though Relocate cannot list or use it', async () => {
    const { relocate } = await world({ permissions: {}, answer: PROFILE_ONLY });
    expect(await relocate.has(PROFILE)).toBe(false);
    expect(await relocate.names()).toEqual([]);
    expect(await relocate.hasForRuntime?.('claude-work', PROFILE)).toBe(true);
    expect(await relocate.childEnvironment('f1' as never, { A: ref(PROFILE) })).toEqual({
      ok: false,
      error: { unknown: [PROFILE] },
    });
  });

  test('a genuinely missing reference is absent; unrelated held names and another runtime reveal nothing', async () => {
    const { relocate, core, api } = await world({ permissions: { profileSecrets: true }, answer: PROFILE_ONLY });
    expect(await relocate.hasForRuntime?.('claude-work', OTHER)).toBe(false);
    expect(await relocate.hasForRuntime?.('claude-other', PROFILE)).toBe(false);
    expect(api.hasForRuntime).toBeUndefined();
    await core.remove(PROFILE);
    expect(await relocate.hasForRuntime?.('claude-work', PROFILE)).toBe(false);
  });

  test('presence is read afresh and fails closed when Runtimes is absent or unreadable', async () => {
    let names: readonly string[] = [PROFILE];
    const live = await world({ permissions: {}, answer: { references: async () => names } });
    expect(await live.relocate.hasForRuntime?.('claude-work', PROFILE)).toBe(true);
    names = [];
    expect(await live.relocate.hasForRuntime?.('claude-work', PROFILE)).toBe(false);
    const absent = await world({ permissions: {} });
    const failing = await world({
      permissions: {},
      answer: {
        references: async () => {
          throw new Error('unreadable');
        },
      },
    });
    expect(await absent.relocate.hasForRuntime?.('claude-work', PROFILE)).toBe(false);
    expect(await failing.relocate.hasForRuntime?.('claude-work', PROFILE)).toBe(false);
  });
});

describe('a check may use the secrets the checked runtime’s profile references', () => {
  test('a profile-referenced secret reaches the one child, beside the server’s own, and no value comes back', async () => {
    const { api, opened } = await world({ permissions: { profileSecrets: true }, answer: PROFILE_ONLY });

    const result = await api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE), B: ref(OWN) });

    expect(result?.ok).toBe(true);
    if (result === undefined || !result.ok) throw new Error('expected an environment');
    expect(JSON.stringify(result.value)).not.toContain(PROFILE_VALUE);
    expect(opened(result.value)).toEqual({ A: PROFILE_VALUE, B: OWN_VALUE });
  });

  test('a name the profile does not reference is still refused, by name', async () => {
    const { api } = await world({ permissions: { profileSecrets: true }, answer: PROFILE_ONLY });

    const result = await api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE), X: ref(OTHER) });

    expect(result).toEqual({ ok: false, error: { unknown: [OTHER] } });
  });

  test('another runtime’s profile grants nothing for this one', async () => {
    const { api } = await world({ permissions: { profileSecrets: true }, answer: PROFILE_ONLY });

    const result = await api.childEnvironmentForRuntime?.('claude-other', { A: ref(PROFILE) });

    expect(result).toEqual({ ok: false, error: { unknown: [PROFILE] } });
  });

  test('nothing stays reachable after the check: the plain call still refuses the profile’s secret', async () => {
    const { api } = await world({ permissions: { profileSecrets: true }, answer: PROFILE_ONLY });
    const during = await api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE) });

    const after = await api.childEnvironment('f1' as never, { A: ref(PROFILE) });

    expect(during?.ok).toBe(true);
    expect(after).toEqual({ ok: false, error: { unknown: [PROFILE] } });
  });

  test('the answer is asked afresh each time: a binding removed from the profile stops working at once', async () => {
    let bound: readonly string[] = [PROFILE];
    const { api } = await world({ permissions: { profileSecrets: true }, answer: { references: async () => bound } });
    const first = await api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE) });
    bound = [];

    const second = await api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE) });

    expect(first?.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: { unknown: [PROFILE] } });
  });

  test('a failing or absent Runtimes grants nothing (fail closed)', async () => {
    const failing = await world({
      permissions: { profileSecrets: true },
      answer: {
        references: async () => {
          throw new Error('fleet unreadable');
        },
      },
    });
    const absent = await world({ permissions: { profileSecrets: true } });

    expect(await failing.api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE) })).toEqual({
      ok: false,
      error: { unknown: [PROFILE] },
    });
    expect(await absent.api.childEnvironmentForRuntime?.('claude-work', { A: ref(PROFILE) })).toEqual({
      ok: false,
      error: { unknown: [PROFILE] },
    });
  });

  test('only a plugin that declares the use is handed the method', async () => {
    const { api } = await world({ permissions: {}, answer: PROFILE_ONLY });

    expect(api.childEnvironmentForRuntime).toBeUndefined();
    expect(await api.childEnvironment('f1' as never, { A: ref(PROFILE) })).toEqual({
      ok: false,
      error: { unknown: [PROFILE] },
    });
  });
});
