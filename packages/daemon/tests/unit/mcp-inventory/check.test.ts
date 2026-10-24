import { describe, it } from 'bun:test';
import { type McpInventoryServer, mcpProjectSubject } from '@ferretry/protocol';
import should from 'should';
import {
  McpCheckService,
  type McpInventoryRefusal,
  McpInventoryService,
  type McpProbe,
  type McpProbeAnswer,
  McpProbeFailure,
  type McpProbeSpec,
  mcpCheckBaseEnvironment,
} from '../../../src/lib/mcp-inventory/index.ts';
import { inventoryWorld, PROJECT, PROJECT_KEY } from './support.ts';

const TOKEN = 'project-access-token-value';

class FakeProbe implements McpProbe {
  readonly specs: McpProbeSpec[] = [];
  constructor(
    private readonly answer: McpProbeAnswer | McpProbeFailure = { serverName: 'Docs', tools: ['search', 'read'] },
  ) {}

  async probe(spec: McpProbeSpec): Promise<McpProbeAnswer> {
    this.specs.push(spec);
    if (this.answer instanceof McpProbeFailure) throw this.answer;
    return this.answer;
  }
}

function checker(probe: FakeProbe, launch: Record<string, string> = {}) {
  const inventory = new McpInventoryService(inventoryWorld().deps);
  const bearers: string[] = [];
  let at = 1_000;
  const service = new McpCheckService({
    inventory,
    probe,
    launchEnvironment: async runtime => (runtime === 'claude-work' ? launch : {}),
    baseEnvironment: () => ({ PATH: '/usr/bin', HOME: '/home/me' }),
    bearer: async subject => {
      bearers.push(subject);
      return subject === mcpProjectSubject('docs', PROJECT_KEY) ? TOKEN : undefined;
    },
    redactor: { redact: async text => text.replaceAll(TOKEN, '••••') },
    now: () => {
      at += 25;
      return at;
    },
  });
  return { inventory, service, bearers };
}

const idOf = async (inventory: McpInventoryService, name: string, scope: McpInventoryServer['scope']) => {
  const found = (await inventory.session('s1')).servers.find(server => server.name === name && server.scope === scope);
  if (found === undefined) throw new Error(`no ${name}`);
  return found.id;
};

describe('McpCheckService', () => {
  it('should reach a signed-in project server with its token and answer its tools, never the token', async () => {
    // Arrange
    const probe = new FakeProbe();
    const { inventory, service } = checker(probe);

    // Act
    const result = await service.check(await idOf(inventory, 'docs', 'project'), 's1');

    // Assert
    should(result).containEql({
      name: 'docs',
      transport: 'http',
      outcome: 'connected',
      serverName: 'Docs',
      toolCount: 2,
    });
    should(result.tools).deepEqual(['search', 'read']);
    should(probe.specs[0]).deepEqual({
      transport: 'http',
      url: 'https://docs.example.com/mcp?team=1',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    should(JSON.stringify(result)).not.containEql(TOKEN);
    should(result.elapsedMs).be.above(0);
  });

  it('should not run a project command nobody approved, and say why', async () => {
    // Arrange
    const probe = new FakeProbe();
    const { inventory, service } = checker(probe);

    // Act
    const pending = await service.check(await idOf(inventory, 'lint', 'project'), 's1');
    const disabled = await service.check(await idOf(inventory, 'tracker', 'project'), 's1');

    // Assert
    should(pending).containEql({ outcome: 'not-approved' });
    should(pending.message).match(/Not approved in this project/u);
    should(disabled.message).match(/Disabled in this project/u);
    should(probe.specs).deepEqual([]);
  });

  it('should start a command with the runtime’s launch variables filled the way the harness fills them', async () => {
    // Arrange — the user-scope command; its arguments hold a key the probe must get and the wire must not.
    const probe = new FakeProbe({ tools: [] });
    const { inventory, service } = checker(probe, { HOME: '/fy/home', EXTRA: 'from-launch' });

    // Act
    const result = await service.check(await idOf(inventory, 'scratch', 'user'), 's1');

    // Assert
    should(result.outcome).equal('connected');
    should(probe.specs[0]).deepEqual({
      transport: 'stdio',
      command: 'uvx',
      args: ['scratch', '--key', 'sk-live-NEVER-ON-THE-WIRE'],
      env: { PATH: '/usr/bin', HOME: '/fy/home', EXTRA: 'from-launch' },
    });
    should(JSON.stringify(result)).not.containEql('sk-live');
  });

  it('should read a 401 as needing a sign-in', async () => {
    // Arrange
    const { inventory, service } = checker(new FakeProbe(new McpProbeFailure('unauthorized', 'It answered 401.')));

    // Act
    const result = await service.check(await idOf(inventory, 'linear', 'component'), 's1');

    // Assert
    should(result.outcome).equal('needs-sign-in');
    should(result.message).startWith('It asks for a sign-in. It answered 401.');
  });

  it('should say a failure plainly, redacted, with the variables it could not fill', async () => {
    // Arrange — the component's header names a variable the launch environment does not hold.
    const { inventory, service } = checker(
      new FakeProbe(new McpProbeFailure('unreachable', `Nothing answered (it echoed ${TOKEN}).`)),
    );

    // Act
    const result = await service.check(await idOf(inventory, 'linear', 'component'), 's1');

    // Assert
    should(result.outcome).equal('error');
    should(result.message).equal(
      'Could not reach it. Nothing answered (it echoed ••••). Not set for this check: FY_MCP_LINEAR_0123456789ABCDEF_TOKEN.',
    );
  });

  it('should reach an approved-elsewhere web server but say this ferret does not use it', async () => {
    // Arrange — `linear` in `.mcp.json` is pending; reaching an address runs nothing here.
    const probe = new FakeProbe();
    const { inventory, service } = checker(probe);

    // Act
    const result = await service.check(await idOf(inventory, 'linear', 'project'), 's1');

    // Assert
    should(result.outcome).equal('connected');
    should(result.message).match(/not approved in this project yet/u);
    should(probe.specs).have.length(1);
  });

  it('should refuse to check Ferretry’s own tools server', async () => {
    // Arrange
    const { inventory, service } = checker(new FakeProbe());

    // Act
    const refusal = await service
      .check(await idOf(inventory, 'ferretry', 'ferretry'), 's1')
      .catch((error: unknown) => error);

    // Assert
    should((refusal as McpInventoryRefusal).code).equal('mcp_check_builtin');
  });

  it('should hand a command only the small inherited environment', () => {
    should(
      mcpCheckBaseEnvironment({
        PATH: '/bin',
        HOME: '/h',
        FY_TOKEN: 'admin',
        AWS_SECRET_ACCESS_KEY: 'k',
        LANG: undefined,
      }),
    ).deepEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('should start a project command in the project folder', async () => {
    // Arrange — approve `lint` so it may run.
    const w = inventoryWorld();
    const home = w.documents.files.get('/fy/fleet/homes/claude-work-id/.claude.json') as {
      projects: Record<string, { enabledMcpjsonServers: string[] }>;
    };
    home.projects[PROJECT]?.enabledMcpjsonServers.push('lint');
    const inventory = new McpInventoryService(w.deps);
    const probe = new FakeProbe({ tools: ['fix'] });
    const service = new McpCheckService({
      inventory,
      probe,
      launchEnvironment: async () => ({}),
      baseEnvironment: () => ({ HOME: '/home/me' }),
      bearer: async () => undefined,
      redactor: { redact: async text => text },
      now: () => 0,
    });

    // Act
    const result = await service.check(await idOf(inventory, 'lint', 'project'), 's1');

    // Assert
    should(result.outcome).equal('connected');
    should(probe.specs[0]).containEql({ cwd: PROJECT, env: { HOME: '/home/me', LINT_HOME: '/home/me' } });
  });
});
