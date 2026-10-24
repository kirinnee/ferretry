import { describe, it } from 'bun:test';
import type { McpCheckResult, McpInventory, McpInventoryServer } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerMcpCommands } from '../../../src/lib/mcp/commands';
import {
  type IMcpServersGateway,
  type IMcpServersOutput,
  McpServersController,
  ProtocolMcpServersGateway,
  renderMcpCheck,
  renderMcpInventory,
} from '../../../src/lib/mcp/servers';

const server = (overrides: Partial<McpInventoryServer>): McpInventoryServer => ({
  id: 'id-docs',
  name: 'docs',
  scope: 'project',
  harness: 'claude',
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
      connection: { component: 'linear..abc', state: 'signed-in', renewable: true, secrets: [] },
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

class FakeGateway implements IMcpServersGateway {
  readonly listed: (string | undefined)[] = [];
  readonly checked: [string, string | undefined][] = [];
  constructor(private readonly result: McpCheckResult = CONNECTED) {}

  async list(sessionId?: string): Promise<McpInventory> {
    this.listed.push(sessionId);
    return INVENTORY;
  }

  async check(id: string, sessionId?: string): Promise<McpCheckResult> {
    this.checked.push([id, sessionId]);
    return this.result;
  }
}

class RecordingOutput implements IMcpServersOutput {
  readonly messages: string[] = [];
  readonly errors: string[] = [];
  exitCode: number | undefined;
  success(message: string): void {
    this.messages.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

function cli(gateway = new FakeGateway(), own: string | null = 's-own') {
  const out = new RecordingOutput();
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMcpCommands(program, async () => {}, new McpServersController(gateway, out, own ?? undefined));
  const run = async (...argv: string[]) => await program.parseAsync(['node', 'fy', 'mcp', ...argv]);
  return { gateway, out, run };
}

describe('fy mcp ls', () => {
  it('should read this ferret by default, another with --session, and the machine with --machine', async () => {
    // Arrange
    const { gateway, run } = cli();

    // Act
    await run('ls');
    await run('ls', '--session', 's-other');
    await run('ls', '--machine');

    // Assert
    should(gateway.listed).deepEqual(['s-own', 's-other', undefined]);
  });

  it('should group by scope in the order the harness weighs them, saying approval, sign-in and shadows', () => {
    // Act
    const text = renderMcpInventory(INVENTORY);

    // Assert
    should(text).equal(
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
    should(renderMcpInventory({ servers: [], problems: INVENTORY.problems })).equal(
      'Could not read:\n  /work/app/.mcp.json is not valid JSON.',
    );
  });

  it('should print the protocol document with --json', async () => {
    // Arrange
    const { out, run } = cli();

    // Act
    await run('ls', '--json');

    // Assert
    should(JSON.parse(out.messages[0] ?? '')).deepEqual(INVENTORY);
  });
});

describe('fy mcp check', () => {
  it('should check a server by name, as this ferret, and say what it found', async () => {
    // Arrange
    const { gateway, out, run } = cli();

    // Act
    await run('check', 'docs');

    // Assert
    should(gateway.checked).deepEqual([['id-docs', 's-own']]);
    should(out.messages).deepEqual(['docs: connected (Docs) · 2 tools · 40 ms\n  search, read']);
    should(out.exitCode).be.undefined();
  });

  it('should ask which one when a name is declared twice, and take --scope or an id', async () => {
    // Arrange
    const { gateway, out, run } = cli();

    // Act
    await run('check', 'linear');
    await run('check', 'linear', '--scope', 'component');
    await run('check', 'id-linear-p', '--machine');

    // Assert
    should(out.errors[0]).match(/more than one scope \(component, project\)/u);
    should(gateway.checked).deepEqual([
      ['id-linear', 's-own'],
      ['id-linear-p', undefined],
    ]);
  });

  it('should fail with words for a name nobody declares, and exit 1 for a server that did not connect', async () => {
    // Arrange
    const failing = cli(
      new FakeGateway({ ...CONNECTED, outcome: 'needs-sign-in', message: 'It asks for a sign-in.', tools: [] }),
      null,
    );

    // Act
    await failing.run('check', 'nope');
    const missing = failing.out.exitCode;
    await failing.run('check', 'docs', '--json');

    // Assert
    should(missing).equal(2);
    should(failing.out.errors[0]).equal('No MCP server “nope” here. `fy mcp ls` lists them.');
    should(JSON.parse(failing.out.messages[0] ?? '')).containEql({ outcome: 'needs-sign-in' });
    should(failing.out.exitCode).equal(1);
    should(failing.gateway.checked).deepEqual([['id-docs', undefined]]);
  });

  it('should say an outcome that is not a connection in its own words', () => {
    should(renderMcpCheck({ ...CONNECTED, outcome: 'not-approved', message: 'Not approved.', tools: undefined })).equal(
      'docs: not approved · 40 ms\n  Not approved.',
    );
    should(renderMcpCheck({ ...CONNECTED, serverName: undefined, toolCount: undefined, tools: [] })).equal(
      'docs: connected · 0 tools · 40 ms',
    );
  });
});

describe('ProtocolMcpServersGateway', () => {
  it('should read the machine or one ferret, and post a check with its session', async () => {
    // Arrange
    const calls: { path: string; init?: RequestInit }[] = [];
    const gateway = new ProtocolMcpServersGateway({
      request: (async (path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
        calls.push({ path, ...(init === undefined ? {} : { init }) });
        return schema.parse(path === '/v1/mcp/check' ? CONNECTED : INVENTORY);
      }) as never,
    });

    // Act
    await gateway.list();
    await gateway.list('s 1');
    await gateway.check('id-docs', 's1');
    await gateway.check('id-docs');

    // Assert
    should(calls.map(call => call.path)).deepEqual([
      '/v1/mcp',
      '/v1/sessions/s%201/mcp/servers',
      '/v1/mcp/check',
      '/v1/mcp/check',
    ]);
    should(JSON.parse(String(calls[2]?.init?.body))).deepEqual({ id: 'id-docs', sessionId: 's1' });
    should(JSON.parse(String(calls[3]?.init?.body))).deepEqual({ id: 'id-docs' });
    should(calls[2]?.init?.method).equal('POST');
  });
});

describe('fy mcp without the servers controller', () => {
  it('should offer only serve', () => {
    // Arrange
    const program = new Command();

    // Act
    registerMcpCommands(program, async () => {});

    // Assert
    should(program.commands[0]?.commands.map(command => command.name())).deepEqual(['serve']);
  });
});
