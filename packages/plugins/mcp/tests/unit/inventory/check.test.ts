import { describe, it } from 'bun:test';
import { type McpInventoryServer, mcpProjectSubject } from '../../../contract/index.ts';
import should from 'should';
import {
  type McpCheckDeps,
  McpCheckService,
  type McpProbe,
  type McpProbeAnswer,
  McpProbeFailure,
  type McpProbeSpec,
  mcpCheckBaseEnvironment,
} from '../../../daemon/lib/inventory/check.ts';
import { type McpInventoryRefusal, McpInventoryService } from '../../../daemon/lib/inventory/service.ts';
import { inventoryWorld, PROJECT, PROJECT_KEY, session } from './support.ts';

const TOKEN = 'project-access-token-value';
const ACCESS_SECRET = 'MCP_DOCS_0123456789ABCDEF_ACCESS';

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

function checker(
  probe: FakeProbe,
  launch: Record<string, string> = {},
  sealEnvironment?: McpCheckDeps['sealEnvironment'],
) {
  const inventory = new McpInventoryService(inventoryWorld().deps);
  const bearers: string[] = [];
  let at = 1_000;
  const service = new McpCheckService({
    inventory,
    probe,
    launchEnvironment: async runtime => (runtime === 'claude-work' ? launch : {}),
    baseEnvironment: () => ({ PATH: '/usr/bin', HOME: '/home/me' }),
    ...(sealEnvironment === undefined ? {} : { sealEnvironment }),
    credential: async subject => {
      bearers.push(subject);
      return subject === mcpProjectSubject('docs', PROJECT_KEY)
        ? { secret: ACCESS_SECRET, variable: 'FY_MCP_DOCS_0123456789ABCDEF_TOKEN' }
        : undefined;
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
  const found = (await inventory.ferret('s1')).servers.find(server => server.name === name && server.scope === scope);
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
    // The probe is told the NAME of the secret to present, and the Vault places it: no token is ever in the spec.
    should(probe.specs[0]).deepEqual({
      transport: 'http',
      url: 'https://docs.example.com/mcp?team=1',
      headers: {},
      credential: { secret: ACCESS_SECRET, header: 'Authorization', scheme: 'Bearer' },
    });
    should(JSON.stringify(probe.specs)).not.containEql(TOKEN);
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

  it('should hand a command its secrets as one sealed environment and never see a value, as the launch does', async () => {
    // Arrange — the launch names a secret; the Vault (faked) seals the whole environment for the one child.
    const sealedHandle = { names: ['PATH', 'HOME', 'API_KEY'] } as never;
    const sealed: Record<string, string>[] = [];
    const probe = new FakeProbe({ tools: [] });
    const { inventory, service } = checker(probe, { API_KEY: '\${secret:WORK_KEY}' }, async env => {
      sealed.push({ ...env });
      return { ok: true, env: sealedHandle };
    });

    // Act
    const result = await service.check(await idOf(inventory, 'scratch', 'user'), 's1');

    // Assert — the reference went to the Vault as text, and the probe got the handle, not a map.
    should(result.outcome).equal('connected');
    should(sealed[0]?.API_KEY).equal('\${secret:WORK_KEY}');
    const spec = probe.specs[0];
    should(spec?.transport === 'stdio' && spec.env === sealedHandle).be.true();
  });

  it('should not start a command whose secret is not stored, and name the secret', async () => {
    // Arrange
    const probe = new FakeProbe({ tools: [] });
    const { inventory, service } = checker(probe, { API_KEY: '\${secret:WORK_KEY}' }, async () => ({
      ok: false,
      unknown: ['WORK_KEY'],
    }));

    // Act
    const result = await service.check(await idOf(inventory, 'scratch', 'user'), 's1');

    // Assert
    should(result.outcome).equal('error');
    should(result.message).containEql('WORK_KEY');
    should(probe.specs).deepEqual([]);
  });

  it('should say so, and start nothing, when a secret is named and this machine cannot open secrets', async () => {
    // Arrange
    const probe = new FakeProbe({ tools: [] });
    const { inventory, service } = checker(probe, { API_KEY: '\${secret:WORK_KEY}' });

    // Act
    const result = await service.check(await idOf(inventory, 'scratch', 'user'), 's1');

    // Assert
    should(result.outcome).equal('error');
    should(result.message).containEql('WORK_KEY');
    should(probe.specs).deepEqual([]);
  });

  it('should allow a stdio command only while its own check runs, and a reference never fills an argument', async () => {
    // Arrange
    const seen: string[] = [];
    const probe = new FakeProbe({ tools: [] });
    const inventory = new McpInventoryService(inventoryWorld().deps);
    const service = new McpCheckService({
      inventory,
      probe: {
        probe: async spec => (seen.push(spec.transport === 'stdio' ? 'probing' : 'remote'), await probe.probe(spec)),
      },
      launchEnvironment: async (runtime): Promise<Record<string, string>> =>
        runtime === 'claude-work' ? { KEY: '${secret:WORK_KEY}' } : {},
      baseEnvironment: () => ({}),
      allowCommand: command => {
        seen.push(`allow ${command}`);
        return () => seen.push('release');
      },
      sealEnvironment: async () => ({ ok: true, env: { names: [] } as never }),
      credential: async () => undefined,
      redactor: { redact: async text => text },
      now: () => 0,
    });

    // Act
    const result = await service.check(await idOf(inventory, 'scratch', 'user'), 's1');

    // Assert — allowed before the probe, released after; the secret-bound variable filled nothing in the arguments.
    should(result.outcome).equal('connected');
    should(seen).deepEqual(['allow uvx', 'probing', 'release']);
    should(JSON.stringify(probe.specs[0])).not.containEql('secret:');
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

  describe('a Codex server whose token lives in an environment variable', () => {
    const BEARER_VARIABLE = 'FY_MCP_LINEAR_0123456789ABCDEF_TOKEN';

    function codexChecker(probe: FakeProbe, launch: Record<string, string>) {
      const world = inventoryWorld();
      const inventory = new McpInventoryService({
        ...world.deps,
        ferrets: { get: async id => (id === 'c1' ? session(PROJECT, '/fy/fleet/bin/codex-work') : undefined) },
      });
      const service = new McpCheckService({
        inventory,
        probe,
        launchEnvironment: async runtime => (runtime === 'codex-work' ? launch : {}),
        baseEnvironment: () => ({ PATH: '/usr/bin' }),
        credential: async () => undefined,
        redactor: { redact: async text => text },
        now: () => 0,
      });
      const idOfLinear = async () => {
        const found = (await inventory.ferret('c1')).servers.find(server => server.name === 'linear');
        if (found === undefined) throw new Error('no linear');
        return found.id;
      };
      return { service, idOfLinear };
    }

    it('should send the variable’s value as a bearer token', async () => {
      // Arrange
      const probe = new FakeProbe();
      const { service, idOfLinear } = codexChecker(probe, { [BEARER_VARIABLE]: 'codex-launch-token' });

      // Act
      const result = await service.check(await idOfLinear(), 'c1');

      // Assert
      should(result.outcome).equal('connected');
      should(probe.specs[0]).deepEqual({
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer codex-launch-token' },
      });
    });

    it('should name the variable it could not fill when the launch does not hold it', async () => {
      // Arrange
      const probe = new FakeProbe(new McpProbeFailure('unauthorized', 'It answered 401.'));
      const { service, idOfLinear } = codexChecker(probe, {});

      // Act
      const result = await service.check(await idOfLinear(), 'c1');

      // Assert
      should(probe.specs[0]).deepEqual({ transport: 'http', url: 'https://mcp.linear.app/mcp', headers: {} });
      should(result.message).containEql(`Not set for this check: ${BEARER_VARIABLE}.`);
    });
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
      credential: async () => undefined,
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

describe('what a server supplies is scrubbed before it is shown', () => {
  const SECRET = 'FAKE-MCP-TOKEN-0123456789';

  function scrubbing(probe: FakeProbe, redact: (text: string) => Promise<string>) {
    const inventory = new McpInventoryService(inventoryWorld().deps);
    const service = new McpCheckService({
      inventory,
      probe,
      launchEnvironment: async () => ({}),
      baseEnvironment: () => ({ HOME: '/home/me' }),
      credential: async () => undefined,
      redactor: { redact },
      now: () => 0,
    });
    return { inventory, service };
  }

  it('should scrub a server name and tool names BEFORE clipping them, so a cut cannot leave half a token', async () => {
    // Arrange — the token starts 250 characters in: a 256-character clip taken first would keep its first six.
    const probe = new FakeProbe({ serverName: `${'x'.repeat(250)}${SECRET}`, tools: [SECRET, `t ${SECRET}`, 'plain'] });
    const { inventory, service } = scrubbing(probe, async text => text.replaceAll(SECRET, '[redacted:K]'));

    // Act
    const result = await service.check(await idOf(inventory, 'docs', 'project'), 's1');

    // Assert
    should(result.outcome).equal('connected');
    should(JSON.stringify(result)).not.containEql('FAKE-M');
    should(result.tools).deepEqual(['[redacted:K]', 't [redacted:K]', 'plain']);
    should(result.toolCount).equal(3);
  });

  it('should show nothing of an answer it cannot scrub (fail closed)', async () => {
    // Arrange
    const probe = new FakeProbe({ serverName: 'Docs', tools: ['search'] });
    const { inventory, service } = scrubbing(probe, async () => {
      throw new Error('the secret store is damaged');
    });

    // Act
    const result = await service.check(await idOf(inventory, 'docs', 'project'), 's1');

    // Assert
    should(result.outcome).equal('error');
    should(result.message).match(/could not scrub/u);
    should(result).not.have.property('serverName');
    should(result).not.have.property('tools');
    should(JSON.stringify(result)).not.containEql('search');
  });

  it('should scrub a failure’s own words and show none of them when the scrub cannot run', async () => {
    // Arrange
    const probe = new FakeProbe(new McpProbeFailure('protocol', `It refused: ${SECRET}`));
    const { inventory, service } = scrubbing(probe, async () => {
      throw new Error('damaged');
    });

    // Act
    const result = await service.check(await idOf(inventory, 'docs', 'project'), 's1');

    // Assert
    should(result.outcome).equal('error');
    should(JSON.stringify(result)).not.containEql(SECRET);
  });
});
