/**
 * (Lives in the kernel's integration tests, where the generated registry loads the real halves: a plugin's own tests meet
 * another package only through its contract.)
 *
 * A check through the REAL composition: the real Vault and the real MCP daemon half, the production spawn guard
 * (`restrictSpawn`) around MCP's own spawn port, and fake servers only (in memory, no network, no process). A signed-in
 * server is reached with the access token this plugin MINTED, placed on the request by the Vault (MCP never holds it); a
 * server's own words are scrubbed before they are shown; a stdio command is started under the guard the host really
 * applies, and a command's `${HOME}` and `${secret:NAME}` fill as the harness fills them. Fake credentials only.
 */
import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FakeFerrets, ferretId } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate } from '../../../../gate/contract/testing/index.ts';
import { ChildEnvironmentPort, RedactionPort, type SecretName, VaultPort } from '../../../../vault/contract/index.ts';
import { RuntimeIdSchema, type RuntimeSummary } from '../../../../../plugins/runtimes/contract/index.ts';
import { fakeRuntimes } from '../../../../../plugins/runtimes/contract/testing/index.ts';
import type { RuntimeHomeReader } from '../../../../../plugins/runtimes/contract/index.ts';
import { mcpOAuthSecretNames } from '../../../../../plugins/mcp/contract/index.ts';
import type { ChildEnvironment, ChildHandle, Redaction, SpawnPort } from '../../../contract/index.ts';
import { effectivePermissions, restrictSpawn } from '../../../host/index.ts';
import { implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};
const vault = real('vault');
const mcp = real('mcp');

const URL_OF_SERVER = 'https://mcp.example.com/mcp';
const PLAIN_URL = 'https://plain.example.org/mcp';
const FAKE_TOKEN = 'FAKE-MCP-TOKEN-0123456789';
const RUNTIME: RuntimeSummary = {
  id: RuntimeIdSchema.parse('claude-work'),
  harness: 'claude-code',
  login: 'work',
  profile: 'work',
  agent: false,
  launch: { available: true },
};

const rpc = (id: number | undefined, result: unknown): Response =>
  new Response(id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: id === undefined ? 202 : 200,
    headers: { 'content-type': 'application/json' },
  });

/** A home whose `.claude.json` is `document`: the one file the inventory reads of it. */
const reader = (document: unknown): RuntimeHomeReader => ({
  document: async file => (file === '.claude.json' ? JSON.stringify(document) : null),
  skills: async () => [],
  skillManifest: async () => undefined,
  skillTree: async () => undefined,
  skillFile: async () => ({ ok: false, reason: 'unreadable' }),
});

/** What a fake remote server answers: its own name and tools, given by the test. */
interface FakeServer {
  readonly name: string;
  readonly tools: readonly string[];
  /**
   * Reflect the bearer token it was given into its own name (after `prefix`) and as a tool, spelled with JSON \u escapes:
   * the Vault's plain-text mask of a reply cannot see through those, but the parsed strings carry the token.
   */
  readonly reflect?: { readonly prefix: string };
}

const escapedJson = (text: string): string =>
  [...text].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

/** Everything a started fake stdio command did: what it was started with, and the environment it was handed. */
interface Started {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

async function world(options: {
  readonly config: Record<string, unknown>;
  readonly mcpNames: readonly string[];
  readonly servers: Record<string, unknown>;
  readonly answer?: FakeServer;
}) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app', runtime: RUNTIME.id });
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([RUNTIME]);
  runtimes.setProfiles(
    [{ name: 'work', layers: [], etag: 'e1' }],
    [{ runtime: RUNTIME.id, profile: 'work', mcp: options.mcpNames, skills: [] }],
  );
  runtimes.setHomes(
    [
      {
        id: 'h1',
        harness: 'claude-code',
        runtimes: [RUNTIME.id],
        home: '/fleet/homes/h1',
        wrapper: '/fleet/bin/claude-work',
      },
    ],
    { h1: reader({ mcpServers: options.servers }) },
  );
  const answer = options.answer ?? { name: 'Linear', tools: ['search', 'create'] };
  const seen: { url: string; method: string; authorization: string | null }[] = [];
  const started: Started[] = [];
  let opener: { open(env: ChildEnvironment): Readonly<Record<string, string>> | undefined } | undefined;
  const answerTo = (body: { id?: number; method?: string }, bearer = ''): Response => {
    if (answer.reflect !== undefined && bearer !== '') {
      const echo = escapedJson(bearer);
      const raw =
        body.method === 'initialize'
          ? `{"jsonrpc":"2.0","id":${body.id},"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"${answer.reflect.prefix}${echo}"}}}`
          : body.method === 'tools/list'
            ? `{"jsonrpc":"2.0","id":${body.id},"result":{"tools":[{"name":"${echo}"},{"name":"Tool ${echo}"},{"name":"plain"}]}}`
            : undefined;
      if (raw !== undefined) return new Response(raw, { headers: { 'content-type': 'application/json' } });
    }
    if (body.method === 'initialize')
      return rpc(body.id, { protocolVersion: '2025-03-26', serverInfo: { name: answer.name } });
    if (body.method === 'tools/list') return rpc(body.id, { tools: answer.tools.map(name => ({ name })) });
    return rpc(undefined, {});
  };
  /** A command that speaks MCP over stdio: one line in, one line out. */
  const base: SpawnPort = {
    run: async () => {
      throw new Error('not used by a check');
    },
    runBytes: async () => {
      throw new Error('not used by a check');
    },
    start: (program, args, spawnOptions): ChildHandle => {
      const env = opener?.open(spawnOptions?.env as ChildEnvironment) ?? (spawnOptions?.env as never) ?? {};
      started.push({ program, args, env });
      let out!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start: controller => {
          out = controller;
        },
      });
      return {
        pid: 1,
        stdout,
        stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
        write: chunk => {
          const line = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          const request = JSON.parse(line.trim()) as { id?: number; method?: string };
          if (request.id === undefined) return;
          void answerTo(request)
            .text()
            .then(text => out.enqueue(new TextEncoder().encode(`${text}\n`)));
        },
        kill: () => undefined,
        pipes: [],
        closePipes: () => undefined,
        exited: new Promise<number | null>(() => undefined),
      };
    },
  };
  // MCP's own half, with its spawn port wrapped in the guard the real host applies (`restrictSpawn`), over its own resolvers.
  let resolvers: Record<string, () => readonly string[]> = {};
  const guarded = implementDaemon(mcp.manifest, {
    build: ctx => {
      if (mcp.build === undefined) throw new Error('MCP has a daemon half');
      const built = mcp.build({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          spawn: restrictSpawn(
            mcp.manifest.id,
            effectivePermissions(mcp.manifest.id, mcp.manifest.permissions?.spawn ?? []),
            base,
            undefined,
            undefined,
            name => resolvers[name],
          ),
        },
      });
      const result = built as { resolvers?: Record<string, () => readonly string[]> };
      resolvers = result.resolvers ?? {};
      return built;
    },
  });
  // The real Vault's redaction, which knows every value it holds: the host is built before it can be asked for.
  const redactionOf: { current?: Redaction } = {};
  const host = await testHost({
    redaction: { read: async fn => await (redactionOf.current as Redaction).read(fn) },
    plugins: [vault, guarded],
    fakes: { ferrets, asks: new FakeAsks(), gate: new FakeGate() },
    uses: { runtimes },
    config: options.config,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: url.toString(), method: init?.method ?? 'GET', authorization: headers.get('authorization') });
      if (init?.method === 'DELETE') return new Response('', { status: 200 });
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: number; method?: string }) : {};
      return answerTo(body, headers.get('authorization')?.replace(/^Bearer /u, '') ?? '');
    },
  });
  opener = host.provided(ChildEnvironmentPort);
  redactionOf.current = host.provided(RedactionPort);
  await host.runJob('inputs-restore');
  /** The sign-in's access token, written the way MCP's own sign-in writes it: through MCP's own Vault port. */
  const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
  const mint = async (): Promise<void> => await host.provided(VaultPort, 'mcp').put(names.access, FAKE_TOKEN);
  const ownerPuts = async (): Promise<void> => await host.provided(VaultPort).put(names.access, FAKE_TOKEN);
  const check = async (name: string) => {
    const listed = await host.request('GET', '/v1/mcp');
    const id = listed.json<{ servers: { id: string; name: string }[] }>().servers.find(row => row.name === name)?.id;
    expect(id).toBeDefined();
    return await host.request('POST', '/v1/mcp/check', { body: { id } });
  };
  return { host, seen, started, mint, ownerPuts, check, names, runtimes, resolvers: () => resolvers };
}

const linear = (names: ReturnType<typeof mcpOAuthSecretNames>) => ({
  config: { mcp: { linear: { url: URL_OF_SERVER, auth: 'oauth' } } },
  mcpNames: ['linear'],
  servers: {
    linear: { type: 'http', url: URL_OF_SERVER, headers: { Authorization: `Bearer \${${names.variable}}` } },
  },
});

describe('a check presents what this plugin minted, through the Vault', () => {
  test('a signed-in server is reached with its minted access token, and neither the answer nor the log carries it', async () => {
    const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
    const w = await world(linear(names));
    try {
      await w.mint();

      const checked = await w.check('linear');

      expect(checked.status).toBe(200);
      expect(checked.json<{ outcome: string; toolCount?: number }>()).toMatchObject({
        outcome: 'connected',
        toolCount: 2,
      });
      const sent = w.seen.filter(entry => entry.url === URL_OF_SERVER);
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent.filter(entry => entry.method !== 'DELETE'))
        expect(request.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(checked.body).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(w.host.logs)).not.toContain(FAKE_TOKEN);
    } finally {
      await w.host.stop();
    }
  });

  test('a value the OWNER put under the sign-in’s name is not MCP’s to present: nothing is sent with it', async () => {
    const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
    const w = await world(linear(names));
    try {
      await w.ownerPuts();

      const checked = await w.check('linear');

      expect(w.seen.some(entry => entry.authorization?.includes(FAKE_TOKEN) === true)).toBe(false);
      expect(checked.json<{ outcome: string }>().outcome).not.toBe('connected');
      expect(checked.body).not.toContain(FAKE_TOKEN);
    } finally {
      await w.host.stop();
    }
  });

  test('a server that is not signed in is checked without any credential, and answers for itself', async () => {
    const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
    const w = await world(linear(names));
    try {
      const checked = await w.check('linear');

      expect(w.seen.some(entry => entry.authorization?.includes(FAKE_TOKEN) === true)).toBe(false);
      expect(checked.status).toBe(200);
    } finally {
      await w.host.stop();
    }
  });

  test('a web server nobody signs in to is reached too (its host is a server’s host, not only a sign-in’s)', async () => {
    const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
    const w = await world({
      config: { mcp: { plain: { url: PLAIN_URL } } },
      mcpNames: ['plain'],
      servers: { plain: { type: 'http', url: PLAIN_URL } },
    });
    try {
      const checked = await w.check('plain');

      expect(checked.json<{ outcome: string; toolCount?: number }>()).toMatchObject({
        outcome: 'connected',
        toolCount: 2,
      });
      expect(w.names.access).toBe(names.access);
    } finally {
      await w.host.stop();
    }
  });
});

describe('what a server says is scrubbed before it is shown, clipped or not', () => {
  test('a server name and tool names that carry the held token are masked, even where a clip would have cut it in half', async () => {
    const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
    const w = await world({
      ...linear(names),
      // The name is 250 characters, then the token: the 256-character clip would have left its first six characters.
      answer: { name: '', tools: [], reflect: { prefix: 'x'.repeat(250) } },
    });
    try {
      await w.mint();

      const checked = await w.check('linear');

      expect(checked.status).toBe(200);
      expect(checked.json<{ outcome: string; toolCount?: number }>()).toMatchObject({
        outcome: 'connected',
        toolCount: 3,
      });
      expect(checked.body).not.toContain(FAKE_TOKEN);
      expect(checked.body).not.toContain('FAKE-M');
      expect(checked.json<{ tools?: string[] }>().tools).toContain('plain');
    } finally {
      await w.host.stop();
    }
  });
});

describe('a stdio check starts its command under the guard the host applies', () => {
  test('a command’s own ${HOME} fills from this machine’s home, and the command is started and answers', async () => {
    const w = await world({
      config: { mcp: { tool: { command: '${HOME}/bin/tool' } } },
      mcpNames: ['tool'],
      servers: { tool: { command: '${HOME}/bin/tool' } },
    });
    try {
      const checked = await w.check('tool');

      expect(checked.status).toBe(200);
      expect(checked.json<{ outcome: string; toolCount?: number }>()).toMatchObject({
        outcome: 'connected',
        toolCount: 2,
      });
      expect(w.started.map(entry => entry.program)).toEqual(['/home/owner/bin/tool']);
      expect(checked.body).not.toContain('Not set for this check');
      // Allowed for the length of its own check and no longer.
      expect(w.resolvers()['mcp-check']?.()).toEqual([]);
    } finally {
      await w.host.stop();
    }
  });

  test('a command’s ${secret:NAME} reaches ITS environment through the Vault, and never the answer', async () => {
    const w = await world({
      config: { mcp: { tool: { command: 'acme-mcp', env: { ACME_TOKEN: '${secret:ACME_TOKEN}' } } } },
      mcpNames: ['tool'],
      servers: { tool: { command: 'acme-mcp', env: { ACME_TOKEN: '${secret:ACME_TOKEN}' } } },
    });
    try {
      await w.host.provided(VaultPort).put('ACME_TOKEN' as SecretName, FAKE_TOKEN);

      const checked = await w.check('tool');

      expect(checked.json<{ outcome: string }>().outcome).toBe('connected');
      expect(w.started[0]?.env.ACME_TOKEN).toBe(FAKE_TOKEN);
      expect(checked.body).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(w.host.logs)).not.toContain(FAKE_TOKEN);
    } finally {
      await w.host.stop();
    }
  });
});
