import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import type { ChildEnvironment, ChildEnvironmentOpener } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { config } from '@ferretry/kernel/host';
import { owner, type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  ChildEnvironmentPort,
  SecretUseRequestSchema,
  VaultConfigFile,
  VaultConfigSchema,
  VaultPort,
} from '../../../../contract/index.ts';
import vault from '../../../../daemon/index.ts';

/**
 * `config/vault.yaml` is the home of today's operator `secretEnvironment` recipes (`config/daemon.json` → `secretEnvironment`):
 * strict, declared in Vault's manifest, read by Vault as its recipe source, and a raw secret value in it is refused
 * exactly as the kernel's config service refuses one in any declared file.
 */

const TOKEN = 'sk-live-0123456789';
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

/** The real Vault composition over a host whose `vault.yaml` holds `file`, substituting only the process boundary. */
async function setup(file: unknown) {
  let opener: ChildEnvironmentOpener;
  const environments: Readonly<Record<string, string>>[] = [];
  const empty = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const instrumented = implementDaemon(vault.manifest, {
    build: ctx => {
      if (vault.build === undefined) throw new Error('Vault must have a daemon half');
      return vault.build({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          spawn: {
            ...ctx.kernel.spawn,
            start: (_program, _args, options) => {
              environments.push(opener.open(options?.env as ChildEnvironment) ?? {});
              return {
                pid: 1,
                stdout: empty(),
                stderr: empty(),
                write: () => {},
                kill: () => {},
                pipes: [],
                closePipes: () => {},
                exited: Promise.resolve(0),
              };
            },
          },
        },
      });
    },
  });
  const host = await testHost({
    plugins: [instrumented],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    ...(file === undefined ? {} : { config: { [VaultConfigFile.file]: file } }),
  });
  hosts.push(host);
  opener = host.provided(ChildEnvironmentPort);
  await host.runJob('inputs-restore');
  const put = await host.request('POST', '/v1/secrets', { body: { name: 'TOKEN', value: TOKEN }, as: owner() });
  expect(put.status).toBe(200);
  const run = async (secrets: readonly string[]) =>
    await host.provided(VaultPort).run(SecretUseRequestSchema.parse({ command: ['fixture'], cwd: '/tmp', secrets }));
  return { host, environments, run };
}

describe('vault.yaml: the operator’s secretEnvironment recipes', () => {
  test('S63 Vault gives a child the recipe from the file once the caller asked for every secret it names', async () => {
    const { environments, run } = await setup({ secretEnvironment: { AUTH: 'Bearer ${secret:TOKEN}' } });
    expect(await run(['TOKEN'])).toMatchObject({ ok: true });
    expect(environments).toEqual([{ TOKEN, AUTH: `Bearer ${TOKEN}` }]);
  });

  test('S63 a recipe in the file is withheld from a caller that did not ask for the secret it names', async () => {
    const { environments, run } = await setup({ secretEnvironment: { AUTH: 'Bearer ${secret:TOKEN}' } });
    expect(await run([])).toMatchObject({ ok: true });
    expect(environments).toEqual([{}]);
  });

  test('with no vault.yaml a child gets exactly the secrets it named', async () => {
    const { environments, run } = await setup(undefined);
    expect(await run(['TOKEN'])).toMatchObject({ ok: true });
    expect(environments).toEqual([{ TOKEN }]);
  });

  test('the listing shows the file’s references, by name, with the file as their origin and never a value', async () => {
    const { host } = await setup({ secretEnvironment: { AUTH: 'Bearer ${secret:TOKEN}' } });
    const listing = await host.request('GET', '/v1/secrets', { as: owner() });
    expect(listing.status).toBe(200);
    expect(listing.body).toContain('config/vault.yaml → secretEnvironment.AUTH');
    expect(listing.body).not.toContain(TOKEN);
  });
});

describe('the VaultConfigFile definition', () => {
  test('is the file vault.yaml, declared in Vault’s manifest', () => {
    expect(VaultConfigFile.file).toBe('vault.yaml');
    expect(vault.manifest.data?.config).toContain(VaultConfigFile);
  });

  test('is strict: an unknown key and a recipe that is not an environment variable name are refused', () => {
    expect(VaultConfigSchema.safeParse({ secretEnvironment: {} }).success).toBe(true);
    expect(VaultConfigSchema.safeParse({}).data).toEqual({ secretEnvironment: {} });
    expect(VaultConfigSchema.safeParse({ secretEnvironment: {}, surprise: 1 }).success).toBe(false);
    expect(VaultConfigSchema.safeParse({ secretEnvironment: { 'NOT A NAME': 'x' } }).success).toBe(false);
    expect(VaultConfigSchema.safeParse({ secretEnvironment: { AUTH: 1 } }).success).toBe(false);
  });

  test('refuses a raw secret value in the file, never repeats it, and accepts a ${secret:NAME} reference', () => {
    const raw = config.checkConfigText(
      VaultConfigFile,
      'vault.yaml',
      `secretEnvironment:\n  API_KEY: sk-ant-${'a1B2c3D4'.repeat(4)}\n`,
      'fy',
    );
    expect(raw.ok).toBe(false);
    if (!raw.ok) {
      expect(raw.reason).toBe('raw_secret');
      expect(JSON.stringify(raw)).not.toContain('a1B2c3D4');
    }
    const named = config.checkConfigText(
      VaultConfigFile,
      'vault.yaml',
      'secretEnvironment:\n  API_KEY: ${secret:ANTHROPIC_KEY}\n  AUTH: "Bearer ${secret:TOKEN}"\n',
      'fy',
    );
    expect(named.ok).toBe(true);
  });

  test('S29 a file holds a reference, never a value: a raw secret is refused without being repeated, a ${secret:NAME} reference is kept', () => {
    const raw = config.checkConfigText(
      VaultConfigFile,
      'vault.yaml',
      `secretEnvironment:\n  API_KEY: sk-ant-${'z9Y8x7W6'.repeat(4)}\n`,
      'fy',
    );
    const reference = config.checkConfigText(
      VaultConfigFile,
      'vault.yaml',
      'secretEnvironment:\n  API_KEY: ${secret:ANTHROPIC_KEY}\n',
      'fy',
    );
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(JSON.stringify(raw)).not.toContain('z9Y8x7W6');
    expect(reference.ok).toBe(true);
  });

  test('no edit of it loosens: a recipe is only ever earned, never widened', () => {
    expect(VaultConfigFile.loosens(undefined, { secretEnvironment: { AUTH: 'Bearer ${secret:TOKEN}' } })).toEqual([]);
  });
});
