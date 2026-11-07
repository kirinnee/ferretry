import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LaunchPart, LaunchPartSource, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { optionalSecretReference, type SecretName } from '@ferretry/core-vault/contract';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { ok } from '@ferretry/std';
import { MCP_OAUTH_SECRETS, MCP_OAUTH_STATE, type McpItem, mcpOAuthSecretNames } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import type { ProjectMcpLaunchShare } from '../../daemon/lib/inventory/index.ts';
import { McpLaunchParts } from '../../daemon/lib/launch-parts.ts';
import manifest from '../../manifest.ts';
import { leaks, PWA_REDIRECT, world, type World } from './oauth/support.ts';

/**
 * MCP's launch renewal (today's `launch-environment.ts` + `modules/mcp.ts` `ProjectMcpLaunch`): a launch makes every
 * sign-in it uses current FIRST, then names each server's token by `${secret:NAME}` reference only. Fake issuer,
 * fake tokens; nothing here touches a real home.
 */

const SERVER = 'http://127.0.0.1:4100/mcp';
const NAMES = mcpOAuthSecretNames('linear', SERVER);
const ITEMS: ReadonlyMap<string, McpItem> = new Map<string, McpItem>([
  ['linear', { url: SERVER, auth: 'oauth' }],
  ['lint', { command: 'npx', args: ['lint-mcp'] }],
]);
const SPEC = {
  ferret: ferretId('f1'),
  name: 'one',
  role: 'lead',
  harness: 'claude-code',
  folder: '/work/app',
  home: '/homes/claude-code/f1',
  instructions: [],
} as unknown as Omit<LaunchSpec, 'parts'>;
const NO_PROJECT: ProjectMcpLaunchShare = { root: '', servers: {}, env: {} };

async function signIn(w: World): Promise<void> {
  const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
  const callback = await w.provider.approve(flow.authorizeUrl);
  await w.service.complete(flow.flowId, { callback });
}

/** The launch source over the real sign-in service, recording what the Vault held when the env was decided. */
function source(w: World, project: ProjectMcpLaunchShare = NO_PROJECT) {
  const seen: { tokenRequests: number; access: string | undefined }[] = [];
  const launch = new McpLaunchParts({
    items: () => ITEMS,
    held: async () => {
      seen.push({ tokenRequests: w.provider.tokenRequests.length, access: w.secrets.entries.get(NAMES.access) });
      return new Set(w.secrets.entries.keys());
    },
    renewal: w.service,
    project: async () => project,
  });
  return { launch, seen };
}

const envOf = (parts: readonly LaunchPart[]): Readonly<Record<string, string>> =>
  Object.assign({}, ...parts.flatMap(part => (part.kind === 'env' ? [part.env] : [])));

/** Console output while a launch's parts are made: the launch path itself writes no log line. */
const logged: string[] = [];
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
beforeEach(() => {
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    console[level] = (...args: unknown[]) => void logged.push(args.map(arg => String(arg)).join(' '));
});
afterEach(() => Object.assign(console, originals));

describe('MCP launch renewal', () => {
  test('a carried sign-in whose access token is due is renewed before the launch, then the launch env names the server', async () => {
    // Arrange — a sign-in made earlier (carried over), its access token 10 s from expiry, a minute later.
    const w = world({ expiresIn: 10 });
    await signIn(w);
    const before = w.secrets.entries.get(NAMES.access);
    w.clock.at += 60_000;
    const { launch, seen } = source(w);

    // Act
    const parts = await launch.parts(SPEC);

    // Assert — the fake issuer was asked to refresh BEFORE the launch decided what to bind…
    expect(w.provider.tokenRequests).toHaveLength(2);
    expect(w.provider.tokenRequests[1]?.get('grant_type')).toBe('refresh_token');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tokenRequests).toBe(2);
    expect(seen[0]?.access).not.toBe(before);
    expect(w.secrets.entries.get(NAMES.access)).toBe(w.provider.issued.at(-2));
    // …and the env names the server's variable by REFERENCE: the Vault opens it into the child.
    expect(envOf(parts)).toEqual({ [NAMES.variable]: optionalSecretReference(NAMES.access) });
    expect(NAMES.variable).toContain('LINEAR');
    expect(parts.find(part => part.kind === 'mcp' && part.name === 'linear')).toEqual({
      kind: 'mcp',
      name: 'linear',
      config: { url: SERVER, auth: 'oauth', bearer: NAMES.variable },
    });
    expect(parts.find(part => part.kind === 'mcp' && part.name === 'lint')).toEqual({
      kind: 'mcp',
      name: 'lint',
      config: { command: 'npx', args: ['lint-mcp'] },
    });
  });

  test('a sign-in carried without its access token (runbook step 2c) is renewed at its first launch, then bound', async () => {
    // Arrange — record and refresh token carried, access token not (it lived in the old secrets.json); not yet expired.
    const w = world({ expiresIn: 3600 });
    await signIn(w);
    await w.secrets.remove(NAMES.access);
    const { launch, seen } = source(w);

    // Act
    const parts = await launch.parts(SPEC);

    // Assert
    expect(w.provider.tokenRequests).toHaveLength(2);
    expect(w.provider.tokenRequests[1]?.get('grant_type')).toBe('refresh_token');
    expect(seen[0]?.access).toBe(w.provider.issued.at(-2));
    expect(envOf(parts)).toEqual({ [NAMES.variable]: optionalSecretReference(NAMES.access) });
    expect(leaks(w.provider, parts, logged)).toEqual([]);
  });

  test('a fresh token is not refreshed, and a server nobody signed in to is listed but binds nothing', async () => {
    // Arrange
    const signedIn = world({ expiresIn: 3600 });
    await signIn(signedIn);
    const never = world();

    // Act
    const fresh = await source(signedIn).launch.parts(SPEC);
    const unsigned = await source(never).launch.parts(SPEC);

    // Assert
    expect(signedIn.provider.tokenRequests).toHaveLength(1);
    expect(envOf(fresh)).toEqual({ [NAMES.variable]: optionalSecretReference(NAMES.access) });
    expect(never.provider.tokenRequests).toHaveLength(0);
    expect(envOf(unsigned)).toEqual({});
    expect(unsigned.find(part => part.kind === 'mcp' && part.name === 'linear')).toEqual({
      kind: 'mcp',
      name: 'linear',
      config: { url: SERVER, auth: 'oauth' },
    });
  });

  test('a refresh the issuer rejects leaves the server needing a new sign-in, and the launch still starts', async () => {
    // Arrange
    const w = world({ expiresIn: 10 });
    await signIn(w);
    w.provider.refreshError = 'invalid_grant';
    w.clock.at += 60_000;

    // Act
    const parts = await source(w).launch.parts(SPEC);

    // Assert — today's behaviour: the old token stays bound, the harness reports the one server as unauthorised.
    expect(w.provider.tokenRequests).toHaveLength(2);
    expect((await w.service.connections())[0]?.state).toBe('needs-sign-in');
    expect(parts.map(part => (part.kind === 'mcp' ? part.name : part.kind))).toEqual(['linear', 'lint', 'env']);
    expect(envOf(parts)).toEqual({ [NAMES.variable]: optionalSecretReference(NAMES.access) });
  });

  test('a refresh that cannot reach the issuer, or a damaged sign-in record, never refuses the launch', async () => {
    // Arrange
    const unreachable = world({ expiresIn: 10 });
    await signIn(unreachable);
    unreachable.clock.at += 60_000;
    unreachable.http.failing.add(`${unreachable.provider.origin}/auth/token`);
    const damaged = world();
    damaged.state.failure = new Error('damaged');

    // Act
    const first = await source(unreachable).launch.parts(SPEC);
    const second = await source(damaged).launch.parts(SPEC);

    // Assert
    expect(first.filter(part => part.kind === 'mcp')).toHaveLength(2);
    expect(second.filter(part => part.kind === 'mcp')).toHaveLength(2);
  });

  test('a project server signed in to for this folder is renewed by its own share and handed on as a local entry', async () => {
    // Arrange
    const w = world({ expiresIn: 3600 });
    await signIn(w);
    const docs = mcpOAuthSecretNames('project:docs', 'https://docs.example.com/mcp');
    const project: ProjectMcpLaunchShare = {
      root: '/work/app',
      servers: {
        docs: {
          type: 'http',
          url: 'https://docs.example.com/mcp',
          headers: { Authorization: `Bearer \${${docs.variable}}` },
        },
      },
      env: { [docs.variable]: optionalSecretReference(docs.access) },
    };

    // Act
    const parts = await source(w, project).launch.parts(SPEC);

    // Assert
    expect(parts.find(part => part.kind === 'mcp' && part.name === 'docs')).toEqual({
      kind: 'mcp',
      name: 'docs',
      config: {
        type: 'http',
        url: 'https://docs.example.com/mcp',
        headers: { Authorization: `Bearer \${${docs.variable}}` },
        scope: 'local',
        project: '/work/app',
      },
    });
    expect(envOf(parts)).toEqual({
      [docs.variable]: optionalSecretReference(docs.access),
      [NAMES.variable]: optionalSecretReference(NAMES.access),
    });
  });

  test('no access token, refresh token or client secret appears in any launch part, log line or error', async () => {
    // Arrange — a confidential client, so a client secret was issued too; a renewal that succeeds and one that fails.
    const renewed = world({ expiresIn: 10, confidential: true });
    await signIn(renewed);
    renewed.clock.at += 60_000;
    const rejected = world({ expiresIn: 10, confidential: true });
    await signIn(rejected);
    rejected.provider.refreshError = 'invalid_grant';
    rejected.clock.at += 60_000;
    const failures: unknown[] = [];

    // Act
    const parts = [
      await source(renewed)
        .launch.parts(SPEC)
        .catch((error: unknown): readonly LaunchPart[] => {
          failures.push(error);
          return [];
        }),
      await source(rejected)
        .launch.parts(SPEC)
        .catch((error: unknown): readonly LaunchPart[] => {
          failures.push(error);
          return [];
        }),
    ];

    // Assert
    expect(renewed.provider.issued.length).toBeGreaterThanOrEqual(4);
    expect(failures).toEqual([]);
    expect(leaks(renewed.provider, parts[0], logged, failures)).toEqual([]);
    expect(leaks(rejected.provider, parts[1], logged, failures)).toEqual([]);
  });
});

describe('MCP launch renewal through the daemon half', () => {
  test('the launch.parts hook refreshes a due carried sign-in through kernel.fetch, then binds the held token by reference only', async () => {
    // Arrange — a real sign-in made against the fake issuer gives a genuine record and refresh token (fake values),
    // carried into the daemon half's own state and sealed document; its access token is 10 s from expiry, a minute on.
    const w = world({ expiresIn: 10 });
    await signIn(w);
    const carried = w.state.document;
    const record = carried.connections.linear;
    if (record === undefined) throw new Error('the sign-in filed no record');
    const refreshToken = w.internal.entries.get(NAMES.refresh);
    if (refreshToken === undefined) throw new Error('the sign-in filed no refresh token');
    const vault = new FakeVault();
    await vault.put(NAMES.access as SecretName, 'fake-access-value');
    const written: unknown[] = [];
    const state = {
      read: async (file: { readonly path: string }) => ok(file.path === MCP_OAUTH_STATE.path ? carried : undefined),
      write: async (_file: unknown, value: unknown) => void written.push(value),
    };
    const sealed = new FakeSealedDocuments();
    await sealed.open(state as never, MCP_OAUTH_SECRETS).put(NAMES.refresh as never, refreshToken);
    const fetched: string[] = [];
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
    const half = daemon.build?.({
      manifest,
      needs: { ferrets, vault, sealed },
      uses: {
        claudeCode: { current: () => undefined },
        codex: { current: () => undefined },
        projects: { current: () => undefined },
      },
      hooks: {} as never,
      kernel: {
        config: { collection: () => ITEMS },
        clock: { nowMs: () => w.clock.at + 60_000 },
        state,
        fetch: {
          request: async (url: string | URL, init?: RequestInit) => {
            fetched.push(String(url));
            return await w.provider.handle(new Request(url, init));
          },
        },
        roots: { root: () => ({ resolve: () => ({ ok: false }) }) },
      } as unknown as DaemonContext<typeof manifest>['kernel'],
    } as DaemonContext<typeof manifest>);
    if (half?.hooks === undefined) throw new Error('the MCP daemon half offers no hooks');
    const hooks = half.hooks as Record<string, () => readonly { id: string; item: LaunchPartSource }[]>;
    const contributions = hooks['launch.parts']?.() ?? [];
    const launch = contributions[0]?.item;
    if (launch === undefined) throw new Error('MCP contributes no launch.parts source');

    // Act
    const parts = await launch.parts(SPEC);

    // Assert — the refresh reached the issuer through the kernel's fetch, with the carried refresh token…
    expect(contributions.map(contribution => contribution.id)).toEqual(['mcp']);
    expect(fetched).toEqual([record.tokenEndpoint]);
    expect(w.provider.tokenRequests).toHaveLength(2);
    expect(w.provider.tokenRequests[1]?.get('grant_type')).toBe('refresh_token');
    expect(w.provider.tokenRequests[1]?.get('refresh_token')).toBe(refreshToken);
    // …the renewed sign-in was filed with a later expiry…
    const filed = written.at(-1) as typeof carried | undefined;
    expect(Date.parse(filed?.connections.linear?.expiresAt ?? '')).toBeGreaterThan(Date.parse(record.expiresAt ?? ''));
    // …and the launch names the token by reference only.
    expect(envOf(parts)).toEqual({ [NAMES.variable]: optionalSecretReference(NAMES.access) });
    expect(leaks(w.provider, parts, logged)).toEqual([]);
    expect(JSON.stringify(parts)).not.toContain('fake-access-value');
    expect(logged.join('\n')).not.toContain('fake-access-value');
  });
});
