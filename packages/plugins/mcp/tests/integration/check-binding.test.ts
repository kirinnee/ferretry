import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault, fakeChildEnvironmentValues } from '@ferretry/core-vault/contract/testing';
import type { ChildEnvironment, ChildHandle } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import type { RuntimeHome, RuntimeId, RuntimeSummary } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import type { McpCheckResult, McpInventory } from '../../contract/index.ts';
import mcp from '../../daemon/index.ts';

/**
 * `fy mcp check` through the PRODUCTION binding (the plugin's own `build`, on the kernel test host that judges
 * `permissions.spawn` exactly as the real host does): a stdio check of a fixture server really starts it, a variable
 * the runtime's profile binds to a secret reaches that child, and a secret that is not stored refuses by name.
 */
const RUNTIME = 'claude-work' as RuntimeId;
const PROFILE_SECRET = 'profile-secret-value-91ac';
const SERVER_SECRET = 'server-secret-value-17de';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A one-file MCP server: it names itself `ok` only when both secrets reached its environment, else `wrong`. */
async function fixtureServer(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-mcp-check-'));
  cleanups.push(async () => await rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'server.ts');
  await writeFile(
    file,
    `
    const good = process.env.PROFILE_TOKEN === ${JSON.stringify(PROFILE_SECRET)} && process.env.SERVER_TOKEN === ${JSON.stringify(SERVER_SECRET)};
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line);
        if (message.method === 'initialize')
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: good ? 'ok' : 'wrong' }, capabilities: {} } }) + '\\n');
        if (message.method === 'tools/list')
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping' }] } }) + '\\n');
      }
    });
  `,
  );
  return file;
}

/** What the real host does at exec time: open a sealed handle (the Vault's job), start the child, pipe its stdio. */
const realStart = (
  program: string,
  args: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>> | ChildEnvironment },
): ChildHandle => {
  const env = options?.env;
  const opened =
    env === undefined
      ? {}
      : (fakeChildEnvironmentValues(env as ChildEnvironment) ?? (env as Readonly<Record<string, string>>));
  const child = Bun.spawn([program, ...args], {
    env: { ...opened },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  cleanups.push(async () => {
    child.kill();
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    write: (chunk: string | Uint8Array) => {
      child.stdin.write(chunk);
      void child.stdin.flush();
    },
    kill: () => child.kill(),
    exited: child.exited,
  } as unknown as ChildHandle;
};

const summary = {
  id: RUNTIME,
  harness: 'claude-code',
  login: 'work',
  profile: 'full',
  agent: false,
  launch: { available: true },
} as RuntimeSummary;

const home = (secretEnv?: Record<string, string>): RuntimeHome => ({
  id: 'work',
  harness: 'claude-code',
  runtimes: [RUNTIME],
  home: '/fleet/homes/work',
  wrapper: '/fleet/homes/work/bin/claude',
  ...(secretEnv === undefined ? {} : { secretEnv }),
});

async function world(options: { held: Record<string, string>; secretEnv?: Record<string, string> }) {
  const file = await fixtureServer();
  const vault = new FakeVault();
  for (const [name, value] of Object.entries(options.held)) await vault.put(name as never, value);
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app', runtime: RUNTIME } as never);
  // The harness's own document, as the wrapper wrote it: the same server the owner configured.
  const server = { command: process.execPath, args: [file], env: { SERVER_TOKEN: '${secret:SERVER_KEY}' } };
  const document = JSON.stringify({ mcpServers: { lint: server } });
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([summary]);
  runtimes.setHomes([home(options.secretEnv)], {
    work: {
      document: async file => (file === '.claude.json' ? document : null),
      skills: async () => [],
      skillManifest: async () => undefined,
      skillTree: async () => undefined,
      skillFile: async () => ({ ok: false, reason: 'unreadable' }),
    },
  });
  runtimes.setProfiles([], [{ runtime: RUNTIME, profile: 'full', mcp: ['lint'], skills: [] }]);
  const h = await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault, sealed: new FakeSealedDocuments() },
    uses: { runtimes },
    config: {
      mcp: {
        // The owner's own server: its command is a program the manifest cannot name, and it names one secret itself.
        lint: server,
      },
    },
    start: realStart,
  });
  const as = { kind: 'device', holder: 'dev_a', capabilities: ['fleet.use', 'terminal.use'] } as const;
  const inventory = (await h.request('GET', '/v1/mcp', { as })).json<McpInventory>();
  const id = inventory.servers.find(server => server.name === 'lint')?.id;
  if (id === undefined) throw new Error(`the fixture server is not in the inventory: ${JSON.stringify(inventory)}`);
  const check = async () => {
    const response = await h.request('POST', '/v1/mcp/check', { body: { id }, as });
    return { response, result: response.json<McpCheckResult>() };
  };
  return { h, check };
}

describe('fy mcp check, through the production binding', () => {
  test('a stdio check really starts the configured command, with the profile’s and the server’s secrets in the child', async () => {
    // Arrange
    const { check } = await world({
      held: { PROFILE_KEY: PROFILE_SECRET, SERVER_KEY: SERVER_SECRET },
      secretEnv: { PROFILE_TOKEN: '${secret:PROFILE_KEY}' },
    });

    // Act
    const { response, result } = await check();

    // Assert — the child said `ok` only because both values reached its environment; no value came back.
    expect(result).toMatchObject({ outcome: 'connected', serverName: 'ok', tools: ['ping'] });
    expect(response.body).not.toContain(PROFILE_SECRET);
    expect(response.body).not.toContain(SERVER_SECRET);
  });

  test('a profile secret that is not stored refuses the check by NAME and starts nothing', async () => {
    // Arrange — the server's own secret is held; the profile's is not.
    const { check } = await world({
      held: { SERVER_KEY: SERVER_SECRET },
      secretEnv: { PROFILE_TOKEN: '${secret:PROFILE_KEY}' },
    });

    // Act
    const { response, result } = await check();

    // Assert
    expect(result.outcome).toBe('error');
    expect(result.message).toContain('PROFILE_KEY');
    expect(response.body).not.toContain(SERVER_SECRET);
  });

  test('without the profile binding the child lacks the profile variable (the fixture proves the binding, not luck)', async () => {
    // Arrange — both secrets are held, but the runtime binds none.
    const { check } = await world({ held: { PROFILE_KEY: PROFILE_SECRET, SERVER_KEY: SERVER_SECRET } });

    // Act
    const { result } = await check();

    // Assert
    expect(result).toMatchObject({ outcome: 'connected', serverName: 'wrong' });
  });
});
