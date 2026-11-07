import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import {
  type ChildEnvironment,
  type ChildEnvironmentOpener,
  type ChildHandle,
  type ConfigFileDef,
  defineConfig,
  type SpawnPort,
} from '@ferretry/kernel/contract';
import { effectivePermissions, restrictSpawn } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { z } from 'zod';
import {
  ChildEnvironmentPort,
  type OutboundHttpRequest,
  type SecretName,
  SecretUseRequestSchema,
  VaultPort,
} from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';
import { allowedSecretNames } from '../../../daemon/lib/secrets/reach.ts';

/**
 * §3.7 through the Vault: the Vault declares `'*'` for spawn and network, and the kernel hands each plugin that needs it
 * its OWN port, narrowed to what that plugin already declares. A core caller (here the kernel itself, which is how a
 * test host reads a port with no plugin named) keeps today's reach.
 */
const GROQ: SecretName = 'GROQ_API_KEY';
const OWNED: SecretName = 'OWNED_LOGIN_KEY';
const OTHER: SecretName = 'UNRELATED_KEY';
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

/** A plugin's own records: the file a plugin OWNS and an owner writes `${secret:NAME}` into (Logins' login records). */
const recordsDefs = new Map<string, ConfigFileDef<{ key?: string | undefined }>>();
const recordsOf = (id: string) => {
  const held = recordsDefs.get(id);
  if (held !== undefined) return held;
  const made = defineConfig({
    file: `${id}/records.yaml`,
    schema: z.strictObject({ key: z.string().optional() }),
    axis: 'configure',
    loosens: () => [],
  });
  recordsDefs.set(id, made);
  return made;
};

const request = (url: string): OutboundHttpRequest => ({
  method: 'GET',
  url,
  headers: {},
  timeoutMs: 1_000,
  maxResponseBytes: 4_096,
});

const tenantManifest = (id: string, permissions: Permissions) =>
  definePlugin({
    id,
    title: id,
    version: '1.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { vault: VaultPort },
    permissions,
    data: { config: [recordsOf(id)] },
  });

async function world(
  tenants: Readonly<Record<string, Permissions>>,
  options: { readonly config?: Readonly<Record<string, unknown>> } = {},
) {
  let opener: ChildEnvironmentOpener | undefined;
  const programs: string[] = [];
  const reached: string[] = [];
  const refused = (): never => {
    throw new Error('not used by a secret run');
  };
  const base: SpawnPort = {
    run: refused,
    runBytes: refused,
    start: (program, _args, spawnOptions): ChildHandle => {
      programs.push(program);
      const env = opener?.open(spawnOptions?.env as ChildEnvironment) ?? {};
      return {
        pid: 1,
        stdout: stream(JSON.stringify(env)),
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
  const seen: Record<string, { vault: unknown; config: unknown }> = {};
  const plugins = Object.entries(tenants).map(([id, permissions]) =>
    implementDaemon(tenantManifest(id, permissions), {
      build: ({ needs, kernel }) => {
        seen[id] = { vault: needs.vault, config: kernel.config };
        return {};
      },
    }),
  );
  const host = await testHost({
    plugins: [instrumented, ...plugins],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    fetch: url => {
      reached.push(url.host);
      return Response.json({ ok: true });
    },
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  hosts.push(host);
  opener = host.provided(ChildEnvironmentPort);
  await host.runJob('inputs-restore');
  const core = host.provided(VaultPort);
  for (const name of [GROQ, OWNED, OTHER]) await core.put(name, VALUE);
  const of = (id: string) => host.provided(VaultPort, id);
  return { host, core, of, programs, reached, seen };
}

const TENANT: Permissions = { network: ['api.groq.test'], spawn: ['echo'], secrets: [GROQ] };

describe('a plugin that is not core is held to its own manifest through the Vault', () => {
  test('S162 a plugin cannot fetch through the Vault to a host its manifest does not declare', async () => {
    const { of, reached } = await world({ tenant: TENANT });
    const api = of('tenant');
    // Its own declared host works, with a secret it declares.
    expect(await api.authorizeFetch(GROQ, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'completion',
      payload: { ok: true },
    });
    // A host it did not declare is refused the way the Vault refuses a host a secret does not allow, and is never dialled.
    expect(await api.authorizeFetch(GROQ, ['api.elsewhere.test'], request('https://api.elsewhere.test/v1'))).toEqual({
      kind: 'refused',
    });
    // Naming a declared host in the allowlist does not let the URL go somewhere else.
    expect(
      await api.authorizeFetch(GROQ, ['api.groq.test', 'api.elsewhere.test'], request('https://api.elsewhere.test/v1')),
    ).toEqual({ kind: 'refused' });
    expect(reached).toEqual(['api.groq.test']);
  });

  test('S162 a wildcard in a non-core manifest grants nothing through the Vault either', async () => {
    const { of, reached } = await world({ tenant: { network: ['*'], spawn: ['*'], secrets: [GROQ] } });
    const api = of('tenant');
    expect(await api.authorizeFetch(GROQ, ['api.anywhere.test'], request('https://api.anywhere.test/'))).toEqual({
      kind: 'refused',
    });
    expect(reached).toEqual([]);
    await expect(
      api.run(SecretUseRequestSchema.parse({ command: ['echo'], cwd: '/tmp', secrets: [GROQ] })),
    ).rejects.toThrow(/may not run echo/u);
  });

  test('S12 S62 a plugin cannot spend a secret that neither its manifest nor a record it owns names', async () => {
    const { of, reached } = await world({ tenant: TENANT });
    const api = of('tenant');
    expect(await api.authorizeFetch(OTHER, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'refused',
    });
    expect(reached).toEqual([]);
    // The same holds for a run, however the secret is named: in the list or inside an environment reference.
    const named = SecretUseRequestSchema.parse({ command: ['echo'], cwd: '/tmp', secrets: [OTHER] });
    expect(await api.run(named)).toEqual({ ok: false, error: 'unknown_secret' });
    const inEnv = SecretUseRequestSchema.parse({
      command: ['echo'],
      cwd: '/tmp',
      env: { AUTH: `Bearer \${secret:${OTHER}}` },
    });
    expect(await api.run(inEnv)).toEqual({ ok: false, error: 'unknown_secret' });
    const optional = SecretUseRequestSchema.parse({
      command: ['echo'],
      cwd: '/tmp',
      env: { AUTH: `\${secret?:${OTHER}}` },
    });
    expect(await api.run(optional)).toEqual({ ok: false, error: 'unknown_secret' });
  });

  test('S3 S5 a plugin cannot spawn a program its manifest does not declare through the Vault’s run', async () => {
    const { of, programs } = await world({ tenant: TENANT });
    const api = of('tenant');
    await expect(
      api.run(
        SecretUseRequestSchema.parse({ command: ['/opt/anything/never-listed-tool'], cwd: '/tmp', secrets: [GROQ] }),
      ),
    ).rejects.toThrow(/tenant may not run never-listed-tool: its manifest does not declare it/u);
    expect(programs).toEqual([]);
    // A declared program with a declared secret runs, and the value is masked in what came back.
    const ran = await api.run(SecretUseRequestSchema.parse({ command: ['echo'], cwd: '/tmp', secrets: [GROQ] }));
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error('expected a run');
    expect(programs).toEqual(['echo']);
    expect(ran.value.stdout).not.toContain(VALUE);
    expect(ran.value.stdout).toContain(`[redacted:${GROQ}]`);
  });

  test('S3 S162 a core caller keeps the Vault’s reach: any program, any host, any secret', async () => {
    const { core, programs, reached } = await world({ tenant: TENANT });
    const ran = await core.run(
      SecretUseRequestSchema.parse({ command: ['/opt/anything/never-listed-tool'], cwd: '/tmp', secrets: [OTHER] }),
    );
    expect(ran.ok).toBe(true);
    expect(programs).toEqual(['/opt/anything/never-listed-tool']);
    expect(await core.authorizeFetch(OTHER, ['api.anywhere.test'], request('https://api.anywhere.test/'))).toEqual({
      kind: 'completion',
      payload: { ok: true },
    });
    expect(reached).toEqual(['api.anywhere.test']);
  });

  test('S7 the Vault’s port is built once per needing plugin, and each plugin is handed its own', async () => {
    const { of, seen } = await world({ first: TENANT, second: TENANT });
    expect(of('first')).toBe(of('first'));
    expect(seen.first?.vault).toBe(of('first'));
    expect(seen.second?.vault).toBe(of('second'));
    expect(of('first')).not.toBe(of('second'));
  });
});

describe('the secrets a plugin may name are its manifest’s and the owner-written references in records it owns', () => {
  test('S12 S62 an owner-written reference in a record the plugin owns lets it spend that secret', async () => {
    const { of, reached } = await world(
      { tenant: { network: ['api.groq.test'], spawn: [], secrets: [] } },
      { config: { 'tenant/records.yaml': { key: `\${secret:${OWNED}}` } } },
    );
    const api = of('tenant');
    expect(await api.authorizeFetch(OWNED, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'completion',
      payload: { ok: true },
    });
    expect(reached).toEqual(['api.groq.test']);
    // Only that one: a name no record of its own writes is still refused.
    expect(await api.authorizeFetch(OTHER, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'refused',
    });
  });

  test('S12 S62 a reference written by the plugin itself is held, and names nothing until the owner confirms it', async () => {
    const { host, of, seen, reached } = await world({ tenant: { network: ['api.groq.test'], spawn: [], secrets: [] } });
    const api = of('tenant');
    const records = seen.tenant?.config as {
      write(def: unknown, name: string | undefined, edit: string): Promise<{ kind: string }>;
    };
    // A ferret (or the plugin on its behalf) adds a reference to a record: held for the owner, not in effect.
    expect((await records.write(recordsOf('tenant'), undefined, `key: \${secret:${OWNED}}\n`)).kind).toBe('held');
    expect(await api.authorizeFetch(OWNED, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'refused',
    });
    expect(reached).toEqual([]);
    // The owner writes it (confirms it): now it is in effect and the secret may be spent.
    host.setConfig('tenant/records.yaml', { key: `\${secret:${OWNED}}` });
    expect(await api.authorizeFetch(OWNED, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'completion',
      payload: { ok: true },
    });
  });

  test('S12 S62 the allowed names are decided in one place: the manifest’s secrets and the owned references', () => {
    const needer = {
      id: 'tenant',
      permissions: { secrets: [GROQ] },
      ownedSecretReferences: () => new Set<string>([OWNED]),
    };
    expect([...allowedSecretNames(needer)].sort()).toEqual([GROQ, OWNED].sort());
  });
});

/**
 * Two plugins asked the Vault for a thing by a name they chose, with manifests that declare no secrets: Usage's quota
 * read and Logins' keyed Test. Both are modelled here by the permissions their manifests declare TODAY (`secrets: []`,
 * the provider hosts), because a name is a per-login value no manifest can list. Each is refused until the key is named
 * from a record that plugin owns, which is how Logins now asks and how Usage asks Logins.
 */
describe('the two callers that named a login’s secret themselves are refused when they still do', () => {
  const PROVIDERS = ['api.z.ai', 'api.deepseek.com', 'openrouter.ai'];

  test('S162 Usage’s quota read by a secret NAME is refused: Usage declares no secrets and owns no login record', async () => {
    const { of, reached } = await world({ usage: { network: PROVIDERS, spawn: [], secrets: [] } });
    expect(
      await of('usage').authorizeFetch(
        'ZAI_API_KEY' as SecretName,
        ['api.z.ai'],
        request('https://api.z.ai/api/monitor/usage/quota/limit'),
      ),
    ).toEqual({ kind: 'refused' });
    expect(reached).toEqual([]);
  });

  test('S162 Logins’ keyed Test is refused unless the login record that names the key is in effect', async () => {
    const permissions: Permissions = { network: PROVIDERS, spawn: [], secrets: [] };
    const absent = await world({ tenant: permissions });
    expect(
      await absent.of('tenant').authorizeFetch(OWNED, ['api.z.ai'], request('https://api.z.ai/v1/models')),
    ).toEqual({ kind: 'refused' });
    expect(absent.reached).toEqual([]);

    const written = await world(
      { tenant: permissions },
      { config: { 'tenant/records.yaml': { key: `\${secret:${OWNED}}` } } },
    );
    expect(
      await written.of('tenant').authorizeFetch(OWNED, ['api.z.ai'], request('https://api.z.ai/v1/models')),
    ).toEqual({ kind: 'completion', payload: { ok: true } });
  });
});
