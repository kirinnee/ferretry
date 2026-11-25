import { describe, expect, test } from 'bun:test';
import type { KnownHarnessKey, LaunchPart, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { optionalSecretReference, type SecretName } from '@ferretry/core-vault/contract';
import type { RuntimeId } from '@ferretry/plugin-runtimes/contract';
import { type McpItem, mcpOAuthSecretNames } from '../../contract/index.ts';
import { claudeServers, codexServers } from '../../daemon/lib/inventory/declarations.ts';
import { McpLaunchParts } from '../../daemon/lib/launch-parts.ts';

/**
 * A signed-in MACHINE server reaches each harness as the config that harness reads: Claude a `headers.Authorization`
 * that names the launch variable, Codex a `bearer_token_env_var`. Never `auth` / `oauth` / `bearer` (keys neither
 * harness reads), so the token the Vault binds into the child's environment is actually sent. Fake hosts and names only;
 * no token value exists anywhere in these parts (the part names a VARIABLE).
 */

const SERVER = 'https://mcp.example.test/mcp';
const SSE_SERVER = 'https://mcp.example.test/sse';
const NAMES = mcpOAuthSecretNames('linear', SERVER);
const SSE_NAMES = mcpOAuthSecretNames('legacy', SSE_SERVER);

const specFor = (harness: KnownHarnessKey): Omit<LaunchSpec, 'parts'> =>
  ({
    ferret: ferretId('f1'),
    runtime: 'rt' as RuntimeId,
    name: 'one',
    role: 'lead',
    harness,
    folder: '/work/app',
    home: '/homes/f1',
    instructions: [],
  }) as unknown as Omit<LaunchSpec, 'parts'>;

const ITEMS: ReadonlyMap<string, McpItem> = new Map<string, McpItem>([
  ['linear', { url: SERVER, auth: 'oauth' }],
  ['legacy', { url: SSE_SERVER, auth: 'oauth', oauth: { clientId: 'client-fake' } as never }],
  ['lint', { command: 'npx', args: ['lint-mcp'] }],
]);

/** Both servers signed in (their access tokens held), or only the ones named. */
async function partsFor(harness: KnownHarnessKey, held: readonly SecretName[]): Promise<readonly LaunchPart[]> {
  const launch = new McpLaunchParts({
    client: 'fy',
    items: () => ITEMS,
    held: async () => new Set(held),
    renewal: { refreshForLaunch: async () => {} },
    mcpFormat: harness => (harness === 'codex' ? 'toml' : harness === 'claude-code' ? 'json' : undefined),
    layered: async () => new Set(ITEMS.keys()),
    project: async () => ({ root: '', servers: {}, env: {} }),
  });
  return await launch.parts(specFor(harness));
}

const configOf = (parts: readonly LaunchPart[], name: string): unknown =>
  parts.find(part => part.kind === 'mcp' && part.name === name && 'config' in part)?.['config' as never];

describe('a signed-in machine MCP server, rendered for the harness that reads it', () => {
  test('Claude gets a typed http entry whose Authorization header names the launch variable', async () => {
    const parts = await partsFor('claude-code', [NAMES.access, SSE_NAMES.access]);

    expect(configOf(parts, 'linear')).toEqual({
      type: 'http',
      url: SERVER,
      headers: { Authorization: `Bearer \${${NAMES.variable}}` },
      headersHelper: `fy mcp token ${NAMES.variable}`,
    });
    // The address ends in /sse: the legacy transport, as both harnesses and the inventory read it.
    expect(configOf(parts, 'legacy')).toEqual({
      type: 'sse',
      url: SSE_SERVER,
      headers: { Authorization: `Bearer \${${SSE_NAMES.variable}}` },
      headersHelper: `fy mcp token ${SSE_NAMES.variable}`,
    });
  });

  test('Codex gets its url and the variable the token is read from', async () => {
    const parts = await partsFor('codex', [NAMES.access, SSE_NAMES.access]);

    expect(configOf(parts, 'linear')).toEqual({ url: SERVER, bearer_token_env_var: NAMES.variable });
    expect(configOf(parts, 'legacy')).toEqual({ url: SSE_SERVER, bearer_token_env_var: SSE_NAMES.variable });
  });

  test('neither harness is handed a key it does not read, and the variable is bound by reference only', async () => {
    for (const harness of ['claude-code', 'codex'] as const) {
      const parts = await partsFor(harness, [NAMES.access]);
      const config = configOf(parts, 'linear') as Record<string, unknown>;
      for (const key of ['auth', 'oauth', 'bearer']) expect(Object.keys(config)).not.toContain(key);
      expect(parts.find(part => part.kind === 'env')).toEqual({
        kind: 'env',
        env: { [NAMES.variable]: optionalSecretReference(NAMES.access) },
      });
    }
  });

  test('what each harness would read back is the sign-in the inventory recognises (round trip)', async () => {
    const claude = claudeServers({
      mcpServers: { linear: configOf(await partsFor('claude-code', [NAMES.access]), 'linear') },
    });
    const codex = codexServers({
      mcp_servers: { linear: configOf(await partsFor('codex', [NAMES.access]), 'linear') },
    });

    expect(claude.problems).toEqual([]);
    expect(claude.servers[0]).toMatchObject({
      transport: 'http',
      url: SERVER,
      headers: { Authorization: `Bearer \${${NAMES.variable}}` },
    });
    expect(codex.problems).toEqual([]);
    expect(codex.servers[0]).toMatchObject({ transport: 'http', url: SERVER, bearerVariable: NAMES.variable });
  });

  test('a harness with no MCP format on record keeps the entry as configured, and still binds the variable', async () => {
    const launch = new McpLaunchParts({
      client: 'fy',
      items: () => ITEMS,
      held: async () => new Set([NAMES.access]),
      renewal: { refreshForLaunch: async () => {} },
      mcpFormat: () => undefined,
      layered: async () => new Set(ITEMS.keys()),
      project: async () => ({ root: '', servers: {}, env: {} }),
    });

    const parts = await launch.parts(specFor('claude-code'));

    expect(configOf(parts, 'linear')).toEqual({ url: SERVER, auth: 'oauth' });
    expect(parts.find(part => part.kind === 'env')).toEqual({
      kind: 'env',
      env: { [NAMES.variable]: optionalSecretReference(NAMES.access) },
    });
  });

  test('a server nobody signed in to, and a server Ferretry starts, are unchanged', async () => {
    const parts = await partsFor('claude-code', []);

    // A server reached at a url is written as the harness reads it: Claude's typed entry, with no `auth` key it ignores.
    expect(configOf(parts, 'linear')).toEqual({ type: 'http', url: SERVER });
    expect(configOf(parts, 'lint')).toEqual({ command: 'npx', args: ['lint-mcp'] });
  });
});

describe('a server reached at a url that nobody signed in to', () => {
  const PLAIN = 'https://docs.example.test/mcp?next=/sse';
  const items: ReadonlyMap<string, McpItem> = new Map<string, McpItem>([
    ['docs', { url: PLAIN }],
    ['linear', { url: SERVER, auth: 'oauth', oauth: { clientId: 'client-fake' } as never }],
  ]);
  const launchFor = (harness: KnownHarnessKey) =>
    new McpLaunchParts({
      client: 'fy',
      items: () => items,
      held: async () => new Set<SecretName>(),
      renewal: { refreshForLaunch: async () => {} },
      mcpFormat: harness => (harness === 'codex' ? 'toml' : harness === 'claude-code' ? 'json' : undefined),
      layered: async () => new Set(items.keys()),
      project: async () => ({ root: '', servers: {}, env: {} }),
    }).parts(specFor(harness));

  test('Claude reads a typed entry: a plain url item and an unsigned oauth one carry no auth or oauth key', async () => {
    const parts = await launchFor('claude-code');

    // The /sse in a QUERY value does not make the address a legacy SSE one.
    expect(configOf(parts, 'docs')).toEqual({ type: 'http', url: PLAIN });
    expect(configOf(parts, 'linear')).toEqual({ type: 'http', url: SERVER });
  });

  test('Codex reads its url alone', async () => {
    const parts = await launchFor('codex');

    expect(configOf(parts, 'docs')).toEqual({ url: PLAIN });
    expect(configOf(parts, 'linear')).toEqual({ url: SERVER });
  });
});

describe('a project server entry and the headersHelper', () => {
  const share = (authorization: string) => ({
    root: '/work/app',
    servers: {
      docs: { type: 'http' as const, url: 'https://docs.example.test/mcp', headers: { Authorization: authorization } },
    },
    env: {},
  });
  const partsOf = async (format: 'json' | 'toml', authorization: string) =>
    await new McpLaunchParts({
      client: 'fy',
      items: () => new Map(),
      held: async () => new Set<SecretName>(),
      renewal: { refreshForLaunch: async () => {} },
      mcpFormat: () => format,
      layered: async () => new Set(),
      project: async () => share(authorization),
    }).parts(specFor('claude-code'));

  test('is written only when Claude reads it and the header names a sign-in variable', async () => {
    const named = `Bearer \${${NAMES.variable}}`;

    expect(configOf(await partsOf('json', named), 'docs')).toMatchObject({
      headersHelper: `fy mcp token ${NAMES.variable}`,
    });
    expect(configOf(await partsOf('toml', named), 'docs')).not.toHaveProperty('headersHelper');
    expect(configOf(await partsOf('json', 'Bearer \${HOME}'), 'docs')).not.toHaveProperty('headersHelper');
    expect(configOf(await partsOf('json', 'Bearer a-literal'), 'docs')).not.toHaveProperty('headersHelper');
  });
});

describe('bindings: the sign-in variables one ferret’s launch holds, by reference', () => {
  const launch = (held: readonly SecretName[], mcpFormat: 'json' | 'toml' | undefined = 'json') =>
    new McpLaunchParts({
      client: 'fy',
      items: () => ITEMS,
      held: async () => new Set(held),
      renewal: { refreshForLaunch: async () => {} },
      mcpFormat: () => mcpFormat,
      layered: async () => new Set(ITEMS.keys()),
      project: async () => ({ root: '', servers: {}, env: {} }),
    });
  const subject = {
    ferret: ferretId('f1'),
    runtime: 'rt' as RuntimeId,
    harness: 'claude-code',
    folder: '/work/app',
  } as never;

  test('names each held sign-in variable with the secret NAME behind it, and nothing else', async () => {
    const bound = await launch([NAMES.access]).bindings(subject);

    expect([...bound]).toEqual([[NAMES.variable, NAMES.access]]);
  });

  test('a server nobody signed in to, or one signed out, binds nothing', async () => {
    expect([...(await launch([]).bindings(subject))]).toEqual([]);
  });
});
