import { describe, it } from 'bun:test';
import type { CliContext, PluginClient, VerbHandler } from '@ferretry/kernel/manifest';
import should from 'should';
import cli from '../../../cli/index.ts';
import {
  type McpServersGateway,
  McpServersController,
  clientServersGateway,
  renderMcpCheck,
  renderMcpInventory,
} from '../../../cli/lib/servers.ts';
import type { McpCheckResult, McpInventory, McpInventoryServer } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

const server = (overrides: Partial<McpInventoryServer>): McpInventoryServer => ({
  id: 'id-docs',
  name: 'docs',
  scope: 'project',
  harness: 'claude-code',
  transport: 'http',
  target: 'https://docs.example.com/mcp',
  runtimes: [{ runtime: 'claude-work', approval: 'pending' }],
  ...overrides,
});

const INVENTORY: McpInventory = {
  servers: [
    server({
      id: 'id-ferretry',
      name: 'ferretry',
      scope: 'ferretry',
      transport: 'stdio',
      target: 'fy mcp serve',
      runtimes: [{ runtime: 'claude-work' }],
    }),
    server({}),
    server({
      id: 'id-linear',
      name: 'linear',
      scope: 'component',
      runtimes: [{ runtime: 'claude-work' }],
      signIn: { subject: 'linear', required: true },
      shadowedBy: 'project',
    }),
    server({
      id: 'id-linear-p',
      name: 'linear',
      runtimes: [{ runtime: 'claude-work', approval: 'approved' }],
      connection: { component: 'linear..abc', state: 'signed-in', renewable: true, secrets: [] } as never,
    }),
    server({
      id: 'id-search',
      name: 'search',
      harness: 'codex',
      transport: 'sse',
      runtimes: [{ runtime: 'codex-work', approval: 'disabled' }],
    }),
  ],
  problems: [{ source: '/work/app/.mcp.json', message: '/work/app/.mcp.json is not valid JSON.' }],
};

const CONNECTED: McpCheckResult = {
  id: 'id-docs',
  name: 'docs',
  transport: 'http',
  outcome: 'connected',
  serverName: 'Docs',
  toolCount: 2,
  tools: ['search', 'read'],
  elapsedMs: 40,
  checkedAt: '2026-10-24T00:00:00.000Z',
};

class FakeGateway implements McpServersGateway {
  readonly listed: (string | undefined)[] = [];
  readonly checked: [string, string | undefined][] = [];
  constructor(private readonly result: McpCheckResult = CONNECTED) {}
  async list(ferretId?: string): Promise<McpInventory> {
    this.listed.push(ferretId);
    return INVENTORY;
  }
  async check(id: string, ferretId?: string): Promise<McpCheckResult> {
    this.checked.push([id, ferretId]);
    return this.result;
  }
}

function controller(gateway = new FakeGateway(), own: string | null = 's-own') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    gateway,
    out,
    err,
    controller: new McpServersController(gateway, { out: t => out.push(t), err: t => err.push(t) }, own ?? undefined),
  };
}

describe('fy mcp ls', () => {
  it('should read this ferret by default, another with --session, and the machine with --machine', async () => {
    const { gateway, controller: c } = controller();
    await c.list({});
    await c.list({ session: 's-other' });
    await c.list({ machine: true });
    should(gateway.listed).deepEqual(['s-own', 's-other', undefined]);
  });

  it('should group by scope in the order the harness weighs them, saying approval, sign-in and shadows', () => {
    should(renderMcpInventory(INVENTORY)).equal(
      [
        'Ferretry:',
        '  ferretry  stdio · fy mcp serve',
        '',
        'Project:',
        '  docs  http · https://docs.example.com/mcp · claude-work: not approved yet',
        '  linear  http · https://docs.example.com/mcp · claude-work: approved · signed in',
        '  search (codex)  sse · https://docs.example.com/mcp · codex-work: disabled here',
        '',
        'Component:',
        '  linear  http · https://docs.example.com/mcp · needs sign-in · hidden by the Project one',
        '',
        'Could not read:',
        '  /work/app/.mcp.json is not valid JSON.',
      ].join('\n'),
    );
    should(renderMcpInventory({ servers: [], problems: [] })).equal('No MCP servers.');
  });

  it('should print the protocol document with --json', async () => {
    const { out, controller: c } = controller();
    should(await c.list({ json: true })).equal(0);
    should(JSON.parse(out[0] ?? '')).deepEqual(INVENTORY);
  });
});

describe('fy mcp check', () => {
  it('should check a server by name, as this ferret, and say what it found', async () => {
    const { gateway, out, controller: c } = controller();
    should(await c.check('docs', {})).equal(0);
    should(gateway.checked).deepEqual([['id-docs', 's-own']]);
    should(out).deepEqual(['docs: connected (Docs) · 2 tools · 40 ms\n  search, read\n']);
  });

  it('should ask which one when a name is declared twice, and take --scope or an id', async () => {
    const { gateway, err, controller: c } = controller();
    should(await c.check('linear', {})).equal(2);
    await c.check('linear', { scope: 'component' });
    await c.check('id-linear-p', { machine: true });
    should(err[0]).match(/more than one scope \(component, project\)/u);
    should(gateway.checked).deepEqual([
      ['id-linear', 's-own'],
      ['id-linear-p', undefined],
    ]);
  });

  it('should fail with words for a name nobody declares, and exit 1 for a server that did not connect', async () => {
    const {
      err,
      out,
      gateway,
      controller: c,
    } = controller(
      new FakeGateway({ ...CONNECTED, outcome: 'needs-sign-in', message: 'It asks for a sign-in.', tools: [] }),
      null,
    );
    should(await c.check('nope', {})).equal(2);
    should(err[0]).equal('No MCP server “nope” here. `fy mcp ls` lists them.\n');
    should(await c.check('docs', { json: true })).equal(1);
    should(JSON.parse(out[0] ?? '')).containEql({ outcome: 'needs-sign-in' });
    should(gateway.checked).deepEqual([['id-docs', undefined]]);
  });

  it('should say an outcome that is not a connection in its own words', () => {
    should(renderMcpCheck({ ...CONNECTED, outcome: 'not-approved', message: 'Not approved.' })).equal(
      'docs: not approved · 40 ms\n  search, read\n  Not approved.',
    );
    should(renderMcpCheck({ ...CONNECTED, serverName: undefined, toolCount: undefined, tools: [] })).equal(
      'docs: connected · 0 tools · 40 ms',
    );
  });
});

describe('clientServersGateway', () => {
  it('should read the machine or one ferret, and post a check with its session', async () => {
    const calls: { route: string; init?: unknown }[] = [];
    const client = {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return route === 'POST /v1/mcp/check' ? CONNECTED : INVENTORY;
      },
    } as unknown as PluginClient;
    const gateway = clientServersGateway(client);
    await gateway.list();
    await gateway.list('f1');
    await gateway.check('id-docs', 'f1');
    await gateway.check('id-docs');
    should(calls.map(call => call.route)).deepEqual([
      'GET /v1/mcp',
      'GET /v1/ferrets/:ferretId/mcp/servers',
      'POST /v1/mcp/check',
      'POST /v1/mcp/check',
    ]);
    should(calls[1]?.init).eql({ params: { ferretId: 'f1' } });
    should(calls[2]?.init).eql({ body: { id: 'id-docs', sessionId: 'f1' } });
    should(calls[3]?.init).eql({ body: { id: 'id-docs' } });
  });
});

describe('the mcp cli half', () => {
  const built = (env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const context = {
      manifest,
      client: { call: async () => INVENTORY } as unknown as PluginClient,
      io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), isTty: false },
      env,
    } as unknown as CliContext<typeof manifest>;
    const verbs = (cli.build as (c: typeof context) => { verbs: Record<string, VerbHandler> })(context).verbs;
    return { verbs, out, err };
  };

  it('should implement every verb the manifest declares', () => {
    should(Object.keys(built().verbs).sort()).eql((manifest.actions?.cli ?? []).map(verb => verb.verb).sort());
  });

  it('should serve the item verbs over the config routes, not the exit-69 stub', async () => {
    const calls: string[] = [];
    const out: string[] = [];
    const context = {
      manifest,
      client: {
        call: async (route: string, init?: { query?: { path?: string } }) => {
          calls.push(`${route} ${init?.query?.path ?? ''}`.trim());
          return { path: init?.query?.path, exists: true, text: 'command: docs\n', etag: 'e1', state: 'ok' };
        },
      },
      io: { out: (t: string) => out.push(t), err: () => {}, isTty: false },
    } as unknown as CliContext<typeof manifest>;
    const { verbs } = (cli.build as (c: typeof context) => { verbs: Record<string, VerbHandler> })(context);
    should(await verbs['mcp show']?.({ args: ['docs'], options: {} })).equal(0);
    should(calls).eql(['GET /v1/config/file mcp/docs.yaml']);
    should(out.join('')).containEql('command: docs');
  });

  it('should refuse `mcp serve` plainly when the shell gave it no standard input', async () => {
    const { verbs, err } = built();
    should(await verbs['mcp serve']?.({ args: [], options: {} })).equal(70);
    should(err.join('')).containEql('no standard input');
  });

  it('should ask `mcp check` for a server name', async () => {
    const { verbs, err } = built();
    should(await verbs['mcp check']?.({ args: [], options: {} })).equal(2);
    should(err.join('')).containEql('name the server to check');
  });
});
