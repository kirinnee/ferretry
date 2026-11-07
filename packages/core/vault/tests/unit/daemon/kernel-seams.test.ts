import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import {
  type ChildEnvironment,
  type ChildEnvironmentOpener,
  type ChildHandle,
  KERNEL_ONLY_PORTS,
  type SpawnPort,
} from '@ferretry/kernel/contract';
import { effectivePermissions, restrictSpawn } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  ChildEnvironmentPort,
  type OutboundHttpRequest,
  SecretResolverPort,
  type SecretName,
  SecretUseRequestSchema,
  VaultPort,
} from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';

const KEY: SecretName = 'GROQ_API_KEY';
const VALUE = 'gsk-test-0123456789abcdef';
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

/**
 * The real Vault composition on the test host. Its `kernel.spawn` is the kernel's own restrict wrapper, built from the
 * Vault's DECLARED permissions exactly as the host builds it, over a base that records what reached it: so a program
 * the manifest did not admit never gets there.
 */
async function setup(options: { readonly fetch?: (url: URL) => Response } = {}) {
  let opener: ChildEnvironmentOpener | undefined;
  const programs: string[] = [];
  const environments: Readonly<Record<string, string>>[] = [];
  const refused = (): never => {
    throw new Error('not used by a secret run');
  };
  const base: SpawnPort = {
    run: refused,
    runBytes: refused,
    start: (program, _args, spawnOptions): ChildHandle => {
      programs.push(program);
      environments.push(opener?.open(spawnOptions?.env as ChildEnvironment) ?? {});
      const text = JSON.stringify(environments.at(-1));
      return {
        pid: 1,
        stdout: stream(text),
        stderr: stream(''),
        write: () => {},
        kill: () => {},
        pipes: [],
        closePipes: () => {},
        exited: Promise.resolve(0),
      };
    },
  };
  const manifest = vault.manifest;
  const instrumented = implementDaemon(manifest, {
    build: ctx => {
      if (vault.build === undefined) throw new Error('Vault must have a daemon half');
      return vault.build({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          spawn: restrictSpawn(manifest.id, effectivePermissions(manifest.id, manifest.permissions?.spawn ?? []), base),
        },
      });
    },
  });
  const host = await testHost({
    plugins: [instrumented],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  hosts.push(host);
  opener = host.provided(ChildEnvironmentPort);
  await host.runJob('inputs-restore');
  const api = host.provided(VaultPort);
  await api.put(KEY, VALUE);
  return { host, api, programs, environments, manifest };
}

describe('the Vault resolves a secret NAME for the kernel alone', () => {
  test('S6 S7 the kernel-bound resolver answers the stored value for a name and nothing for an unknown one', async () => {
    const { host } = await setup();
    const resolver = host.provided(SecretResolverPort);
    expect(await resolver.resolve(KEY)).toBe(VALUE);
    expect(await resolver.resolve('NOT_STORED')).toBeUndefined();
  });

  test('S6 the resolver is the only thing named secret-resolver, bound by the Vault and held by the kernel alone', async () => {
    expect(SecretResolverPort.name).toBe('secret-resolver');
    expect(KERNEL_ONLY_PORTS).toContain(SecretResolverPort.name);
    expect(Object.values(vault.manifest.provides ?? {}).filter(token => token === SecretResolverPort)).toHaveLength(1);
    // A plugin that asks for it, by `needs` or `uses`, is refused before it is built.
    for (const wiring of ['needs', 'uses'] as const) {
      const asker = implementDaemon(
        definePlugin({
          id: 'asker',
          title: 'Asker',
          version: '1.0.0',
          api: 5,
          core: false,
          kinds: [],
          [wiring]: { resolver: SecretResolverPort },
        }),
        { build: () => ({}) },
      );
      await expect(testHost({ plugins: [vault, asker], fakes: { asks: new FakeAsks(), gate: new FakeGate() } })).rejects.toThrow(
        /only the kernel may hold/u,
      );
    }
  });
});

describe('the kernel admits the Vault’s wildcard reach, and only a core piece’s', () => {
  test('S3 S5 a run spawns an owner-chosen program through the kernel’s spawn, with the value in that child alone', async () => {
    const { api, programs, environments, manifest } = await setup();
    expect(manifest.core).toBe(true);
    expect(manifest.permissions?.spawn).toEqual(['*']);
    expect(manifest.permissions?.network).toEqual(['*']);
    const result = await api.run(
      SecretUseRequestSchema.parse({ command: ['/opt/anything/never-listed-tool'], cwd: '/tmp', secrets: [KEY] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a run');
    expect(programs).toEqual(['/opt/anything/never-listed-tool']);
    expect(environments).toEqual([{ [KEY]: VALUE }]);
    // What came back is masked: the child printed its environment.
    expect(result.value.stdout).not.toContain(VALUE);
    expect(result.value.stdout).toContain(`[redacted:${KEY}]`);
    expect(result.value.used).toEqual([KEY]);
  });

  test('S162 authorizeFetch reaches the host a secret’s own allowlist names, through the kernel’s fetch', async () => {
    const reached: { readonly host: string; readonly authorization: string | null }[] = [];
    const { api } = await setup({
      fetch: url => {
        reached.push({ host: url.host, authorization: null });
        return Response.json({ ok: true });
      },
    });
    const request: OutboundHttpRequest = {
      method: 'POST',
      url: 'https://api.never-declared-anywhere.test/v1/complete',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 4_096,
    };
    expect(await api.authorizeFetch(KEY, ['api.never-declared-anywhere.test'], request)).toEqual({
      kind: 'completion',
      payload: { ok: true },
    });
    expect(reached.map(each => each.host)).toEqual(['api.never-declared-anywhere.test']);
    // The per-secret allowlist is still the Vault's own check: a host it does not name is never dialled.
    expect(await api.authorizeFetch(KEY, ['api.other.test'], request)).toEqual({ kind: 'refused' });
    expect(reached).toHaveLength(1);
  });

  test('S3 the same declared wildcard from a piece that is not core grants nothing', async () => {
    const base: SpawnPort = {
      run: () => {
        throw new Error('reached the base');
      },
      runBytes: () => {
        throw new Error('reached the base');
      },
      start: () => {
        throw new Error('reached the base');
      },
    };
    const declared = vault.manifest.permissions?.spawn ?? [];
    expect(effectivePermissions('intruder', declared)).toEqual([]);
    const intruder = restrictSpawn('intruder', effectivePermissions('intruder', declared), base);
    expect(() => intruder.start('anything', [])).toThrow(/may not run/u);
    expect(effectivePermissions('vault', declared)).toEqual(['*']);
  });
});
