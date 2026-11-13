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
  type CredentialPlacement,
  type OutboundHttpRequest,
  PHONE_APPROVAL_UNAVAILABLE,
  type SecretName,
  SecretUseRequestSchema,
  VaultPort,
} from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';
import { allowedSecretNames, isMintedSecret } from '../../../daemon/lib/secrets/reach.ts';

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
    credentialRecords: true,
  });
  recordsDefs.set(id, made);
  return made;
};

/** A file the plugin owns that is NOT a credential record (Logins' endpoints and models): a reference in it counts for nothing. */
const notesDefs = new Map<string, ConfigFileDef<{ key?: string | undefined }>>();
const notesOf = (id: string) => {
  const held = notesDefs.get(id);
  if (held !== undefined) return held;
  const made = defineConfig({
    file: `${id}/notes.yaml`,
    schema: z.strictObject({ key: z.string().optional() }),
    axis: 'configure',
    loosens: () => [],
  });
  notesDefs.set(id, made);
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
    data: { config: [recordsOf(id), notesOf(id)] },
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

  test('the Vault’s port is built once per needing plugin, and each plugin is handed its own', async () => {
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

/**
 * The write reach of a non-core plugin through the Vault (lead ruling, §3.7; no Appendix D row covers it): `put` and
 * `remove` cover only the names it MINTS (a pattern its manifest declares), never one it merely uses; `names()` and
 * `has()` list what it may use or mints, except for the one plugin whose manifest declares the secret-name picker. A
 * core caller keeps the whole store.
 */
const GITHUB: SecretName = 'GITHUB_TOKEN';
const MINTED = 'MCP_WORK_0123456789ABCDEF_ACCESS' as SecretName;
const MINTING: Permissions = {
  network: [],
  spawn: [],
  secrets: [],
  mintedSecrets: ['MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS'],
};
const reference = (name: string): string => '${secret:' + name + '}';

describe('the write reach of a non-core plugin is its allowed and minted secrets and nothing else', () => {
  test('§3.7 a plugin that mints sign-in tokens cannot overwrite or delete GITHUB_TOKEN, and can put and remove its own', async () => {
    const { core, of } = await world({ mcp: MINTING });
    await core.put(GITHUB, 'ghp-original');
    const api = of('mcp');
    await expect(api.put(GITHUB, 'ghp-attacker')).rejects.toThrow(/mcp may not write the secret GITHUB_TOKEN/u);
    await expect(api.remove(GITHUB)).rejects.toThrow(/mcp may not remove the secret GITHUB_TOKEN/u);
    expect(await core.has(GITHUB)).toBe(true);
    // Its own minted name goes through, and is gone again after a remove.
    await api.put(MINTED, 'access-token');
    expect(await core.has(MINTED)).toBe(true);
    expect(await api.remove(MINTED)).toBe(true);
    expect(await core.has(MINTED)).toBe(false);
    // The pattern is matched whole: a name that merely contains it, or the refresh half, is not minted.
    for (const other of ['X_MCP_WORK_0123456789ABCDEF_ACCESS', 'MCP_WORK_0123456789ABCDEF_REFRESH', 'MCP_WORK_ACCESS'])
      await expect(api.put(other as SecretName, 'v')).rejects.toThrow(/may not write/u);
  });

  test('§3.7 a name an owner’s MCP entry uses (GITHUB_TOKEN) is listed to MCP but is not its to put or remove', async () => {
    const { core, of } = await world({ mcp: MINTING }, { config: { 'mcp/records.yaml': { key: reference(GITHUB) } } });
    await core.put(GITHUB, 'ghp-original');
    const api = of('mcp');
    // The entry makes the name usable and listed (the read reach is unchanged)...
    expect((await api.names()).map(secret => secret.name)).toContain(GITHUB);
    expect(await api.has(GITHUB)).toBe(true);
    // ...but MCP mints no such name, so it can neither replace nor delete it.
    await expect(api.put(GITHUB, 'ghp-attacker')).rejects.toThrow(/mcp may not write the secret GITHUB_TOKEN/u);
    await expect(api.remove(GITHUB)).rejects.toThrow(/mcp may not remove the secret GITHUB_TOKEN/u);
    expect(await core.has(GITHUB)).toBe(true);
  });

  test('§3.7 the minted pattern is the sign-in names MCP files today, byte for byte', () => {
    const mcp = { id: 'mcp', permissions: MINTING, ownedSecretReferences: () => new Set<string>() };
    expect(isMintedSecret(mcp, MINTED)).toBe(true);
    expect(isMintedSecret(mcp, 'MCP_0123456789ABCDEF_ACCESS')).toBe(true);
    expect(isMintedSecret(mcp, GITHUB)).toBe(false);
    expect(isMintedSecret({ ...mcp, permissions: {} }, MINTED)).toBe(false);
  });

  test('§3.7 a plugin with a secret-name picker and no minted names (Catalogs) is listed every name and can put or remove nothing', async () => {
    const { core, of } = await world({ catalogs: { network: [], spawn: [], secrets: [], secretNamePicker: true } });
    const api = of('catalogs');
    const everything = (await core.names()).map(secret => secret.name).sort();
    expect(everything).toEqual([GROQ, OTHER, OWNED].sort());
    expect((await api.names()).map(secret => secret.name).sort()).toEqual(everything);
    await expect(api.put(GITHUB, 'ghp-attacker')).rejects.toThrow(/may not write/u);
    await expect(api.put('LNK_ABC' as SecretName, 'key')).rejects.toThrow(/may not write/u);
    await expect(api.remove(OTHER)).rejects.toThrow(/may not remove/u);
    // A name check outside its allowance still answers no, and nothing was removed.
    expect(await api.has(OTHER)).toBe(false);
    expect(await core.has(OTHER)).toBe(true);
  });

  test('§3.7 another non-core plugin is listed only the names it may use or mints, never the owner’s other secrets', async () => {
    const { core, of } = await world(
      { mcp: { ...MINTING, secrets: [GROQ] } },
      { config: { 'mcp/records.yaml': { key: reference(OWNED) } } },
    );
    await core.put(MINTED, 'access-token');
    const names = (await of('mcp').names()).map(secret => secret.name).sort();
    expect(names).toEqual([GROQ, MINTED, OWNED].sort());
    expect(names).not.toContain(OTHER);
    expect(await of('mcp').has(OTHER)).toBe(false);
    expect(await of('mcp').has(GROQ)).toBe(true);
  });

  test('§3.7 a core caller keeps the whole store: any name listed, written and removed', async () => {
    const { core } = await world({});
    await core.put(GITHUB, 'ghp');
    expect((await core.names()).map(secret => secret.name)).toContain(GITHUB);
    expect(await core.remove(GITHUB)).toBe(true);
  });
});

describe('only the references in a credential record count as a plugin’s own secrets', () => {
  test('S12 S62 a reference in a file the plugin owns that is not a credential record makes nothing spendable or listed', async () => {
    const { of, reached } = await world(
      { tenant: { network: ['api.groq.test'], spawn: [], secrets: [] } },
      { config: { 'tenant/notes.yaml': { key: reference(OWNED) } } },
    );
    const api = of('tenant');
    expect(await api.authorizeFetch(OWNED, ['api.groq.test'], request('https://api.groq.test/v1'))).toEqual({
      kind: 'refused',
    });
    expect(reached).toEqual([]);
    expect(await api.names()).toEqual([]);
    await expect(api.put(OWNED, 'x')).rejects.toThrow(/may not write/u);
    // The same reference in the record file counts.
    const marked = await world(
      { tenant: { network: ['api.groq.test'], spawn: [], secrets: [] } },
      { config: { 'tenant/records.yaml': { key: reference(OWNED) } } },
    );
    expect(
      await marked.of('tenant').authorizeFetch(OWNED, ['api.groq.test'], request('https://api.groq.test/v1')),
    ).toEqual({ kind: 'completion', payload: { ok: true } });
  });
});

/**
 * The boundary reads what a caller passes ONCE into plain data and uses only that copy. Each object below answers the
 * declared value on its first read and a different one on every read after it.
 */
const flip = <T>(first: T, later: T): (() => T) => {
  let reads = 0;
  return () => (reads++ === 0 ? first : later);
};
type UseCommand = ReturnType<typeof SecretUseRequestSchema.parse>;

describe('a caller cannot change what it passed after the check (check-then-use)', () => {
  test('S3 S162 a program that is declared on the first read and another after is never run', async () => {
    const { of, programs } = await world({ tenant: TENANT });
    const pick = flip(['echo'], ['/opt/evil/undeclared']);
    const swapped = {
      get command() {
        return pick();
      },
      cwd: '/tmp',
      secrets: [GROQ],
      env: {},
      timeoutMs: 1_000,
    } as unknown as UseCommand;
    const ran = await of('tenant').run(swapped);
    expect(ran.ok).toBe(true);
    expect(programs).toEqual(['echo']);
  });

  test('S3 an empty command is refused, not run', async () => {
    const { of, programs } = await world({ tenant: TENANT });
    const empty = { command: [], cwd: '/tmp', secrets: [GROQ], env: {}, timeoutMs: 1_000 } as unknown as UseCommand;
    await expect(of('tenant').run(empty)).rejects.toThrow();
    expect(programs).toEqual([]);
  });

  test('S12 S62 a secret listed on the first read and another after is never spent by a run', async () => {
    const { of, programs } = await world({ tenant: TENANT });
    const pick = flip([GROQ], [OTHER]);
    const swapped = {
      command: ['echo'],
      cwd: '/tmp',
      get secrets() {
        return pick();
      },
      env: {},
      timeoutMs: 1_000,
    } as unknown as UseCommand;
    const ran = await of('tenant').run(swapped);
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error('expected a run');
    expect(programs).toEqual(['echo']);
    expect(ran.value.used).toEqual([GROQ]);
  });

  test('S162 a url that is declared on the first read and another after is never dialled', async () => {
    const { of, reached } = await world({ tenant: TENANT });
    const pick = flip('https://api.groq.test/v1', 'https://evil.test/steal');
    const swapped = {
      method: 'GET',
      get url() {
        return pick();
      },
      headers: {},
      timeoutMs: 1_000,
      maxResponseBytes: 4_096,
    } as unknown as OutboundHttpRequest;
    await of('tenant').authorizeFetch(GROQ, ['api.groq.test'], swapped);
    expect(reached).not.toContain('evil.test');
    expect(reached).toEqual(['api.groq.test']);
  });

  test('S162 the Vault’s own authorizer sends the request it checked, whatever a getter shows after', async () => {
    const { core, reached } = await world({});
    const pick = flip('https://api.groq.test/v1', 'https://evil.test/steal');
    const swapped = {
      method: 'GET',
      get url() {
        return pick();
      },
      headers: {},
      timeoutMs: 1_000,
      maxResponseBytes: 4_096,
    } as unknown as OutboundHttpRequest;
    await core.authorizeFetch(GROQ, ['api.groq.test'], swapped);
    expect(reached).not.toContain('evil.test');
  });

  test('S162 a url that is an object whose toString changes after the check is refused, never dialled (non-core and core)', async () => {
    const { core, of, reached } = await world({ tenant: TENANT });
    const swapped = (): OutboundHttpRequest =>
      ({
        method: 'GET',
        url: { toString: flip('https://api.groq.test/v1', 'https://evil.test/steal') },
        headers: {},
        timeoutMs: 1_000,
        maxResponseBytes: 4_096,
      }) as unknown as OutboundHttpRequest;
    expect(await of('tenant').authorizeFetch(GROQ, ['api.groq.test'], swapped())).toEqual({ kind: 'refused' });
    expect(await core.authorizeFetch(GROQ, ['api.groq.test'], swapped())).toEqual({ kind: 'refused' });
    expect(reached).toEqual([]);
  });

  test('S162 a url, header, number or placement that is not plain data is refused before anything is dialled', async () => {
    const { core, of, reached } = await world({ tenant: TENANT });
    const good = request('https://api.groq.test/v1');
    const odd: readonly unknown[] = [
      { ...good, url: 42 },
      { ...good, url: new URL('https://api.groq.test/v1') },
      { ...good, headers: { accept: { toString: () => 'x' } } },
      { ...good, timeoutMs: '1000' },
      { ...good, extra: true },
    ];
    for (const asked of odd) {
      expect(await of('tenant').authorizeFetch(GROQ, ['api.groq.test'], asked as OutboundHttpRequest)).toEqual({
        kind: 'refused',
      });
      expect(await core.authorizeFetch(GROQ, ['api.groq.test'], asked as OutboundHttpRequest)).toEqual({
        kind: 'refused',
      });
    }
    const placement = { header: { toString: () => 'authorization' } } as unknown as CredentialPlacement;
    expect(await of('tenant').authorizeFetch(GROQ, ['api.groq.test'], good, placement)).toEqual({ kind: 'refused' });
    expect(await core.authorizeFetch(GROQ, ['api.groq.test'], good, placement)).toEqual({ kind: 'refused' });
    expect(reached).toEqual([]);
  });

  test('S62 an environment whose reference is declared on the first read and another after resolves only what was checked', async () => {
    const { core, host, of } = await world({ tenant: TENANT });
    await core.put(OTHER, 'the-undeclared-value');
    const pick = flip(reference(GROQ), reference(OTHER));
    const env = {
      get AUTH() {
        return pick();
      },
    } as unknown as Readonly<Record<string, string>>;
    const result = await of('tenant').childEnvironment('ferret_1' as never, env);
    if (!result.ok) throw new Error('expected an environment');
    const opened = host.provided(ChildEnvironmentPort).open(result.value);
    if (opened === undefined) throw new Error('expected an opened environment');
    expect(opened.AUTH).toBe(VALUE);
    expect(Object.values(opened)).not.toContain('the-undeclared-value');
  });
});

describe('the phone approval’s reach through the Vault is by name', () => {
  const NONE: Permissions = {};
  const FERRET = 'ferret_1' as never;

  test('only Accounts is handed the page look, the terminal look and the steered question', async () => {
    const { of } = await world({ accounts: NONE, browsers: NONE, tenant: NONE });

    for (const id of ['browsers', 'tenant']) {
      const api = of(id);
      expect(api.pushNumber).toBeUndefined();
      expect(api.observeTerminal).toBeUndefined();
      expect(api.tainted).toBeUndefined();
    }
    const accounts = of('accounts');
    expect(typeof accounts.pushNumber).toBe('function');
    expect(typeof accounts.observeTerminal).toBe('function');
    expect(typeof accounts.tainted).toBe('function');
    // With no Browsers or Terminals bound, a look finds nothing, and nothing is said to be unsteered.
    expect(await accounts.pushNumber?.(FERRET, 'login')).toBeUndefined();
    expect(await accounts.observeTerminal?.(FERRET, 'build')).toEqual({ ok: false, reason: 'unsupported' });
  });

  test('only Browsers is handed the raise, and it is refused while no service provides approvals', async () => {
    const { of, core } = await world({ accounts: NONE, browsers: NONE, tenant: NONE });

    expect(of('accounts').raisePhoneApproval).toBeUndefined();
    expect(of('tenant').raisePhoneApproval).toBeUndefined();
    const ask = { target: { kind: 'browser', key: 'login' } } as const;
    expect(await of('browsers').raisePhoneApproval?.(FERRET, ask)).toEqual({
      ok: false,
      error: PHONE_APPROVAL_UNAVAILABLE,
    });
    // A core caller keeps the whole reach.
    expect(await core.raisePhoneApproval?.(FERRET, ask)).toEqual({ ok: false, error: PHONE_APPROVAL_UNAVAILABLE });
  });
});
