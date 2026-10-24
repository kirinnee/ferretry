import { describe, it } from 'bun:test';
import { type McpInventoryServer, mcpProjectSubject } from '@ferretry/protocol';
import should from 'should';
import { McpInventoryRefusal, McpInventoryService, mcpInventoryFolders } from '../../../src/lib/mcp-inventory/index.ts';
import {
  BROKEN,
  CLAUDE_HOME,
  CODEX_HOME,
  documents,
  inventoryWorld,
  PROJECT,
  PROJECT_KEY,
  WORKTREE,
} from './support.ts';

const byName = (servers: readonly McpInventoryServer[], name: string, scope?: string): McpInventoryServer => {
  const found = servers.find(server => server.name === name && (scope === undefined || server.scope === scope));
  if (found === undefined) throw new Error(`no ${scope ?? ''} server ${name}`);
  return found;
};

describe('McpInventoryService', () => {
  describe('one ferret', () => {
    it('should list what a Claude ferret sees from every scope, with each project server’s approval', async () => {
      // Arrange
      const w = inventoryWorld();
      const service = new McpInventoryService(w.deps);

      // Act
      const { servers, problems } = await service.session('s1');

      // Assert
      should(problems).deepEqual([]);
      should(servers.map(server => `${server.scope}:${server.name}`)).deepEqual([
        'ferretry:ferretry',
        'component:linear',
        'user:scratch',
        'project:docs',
        'project:tracker',
        'project:lint',
        'project:linear',
        'local:mine',
      ]);
      should(byName(servers, 'docs').runtimes).deepEqual([{ runtime: 'claude-work', approval: 'approved' }]);
      should(byName(servers, 'tracker').runtimes).deepEqual([{ runtime: 'claude-work', approval: 'disabled' }]);
      should(byName(servers, 'lint').runtimes).deepEqual([{ runtime: 'claude-work', approval: 'pending' }]);
      should(byName(servers, 'docs').source).equal(`${PROJECT}/.mcp.json`);
      should(byName(servers, 'mine').project).deepEqual({ root: PROJECT, name: 'app' });
    });

    it('should mark the same-named server a higher scope hides, rather than dropping it', async () => {
      // Arrange — `linear` is both a fleet component (user scope) and an APPROVED server in `.mcp.json`.
      const files = documents();
      const home = files.get(`${CLAUDE_HOME}/.claude.json`) as {
        projects: Record<string, { enabledMcpjsonServers: string[] }>;
      };
      home.projects[PROJECT]?.enabledMcpjsonServers.push('linear');
      const service = new McpInventoryService(inventoryWorld(files).deps);

      // Act
      const { servers } = await service.session('s1');

      // Assert — Claude prefers the project's declaration over the user scope's.
      should(byName(servers, 'linear', 'component').shadowedBy).equal('project');
      should(byName(servers, 'linear', 'project').shadowedBy).be.undefined();
    });

    it('should not let a project server nobody approved hide anything: Claude never loads it', async () => {
      // Arrange — the fixture's `linear` in `.mcp.json` is pending.
      const service = new McpInventoryService(inventoryWorld().deps);

      // Act
      const { servers } = await service.session('s1');

      // Assert
      should(byName(servers, 'linear', 'project').runtimes).deepEqual([
        { runtime: 'claude-work', approval: 'pending' },
      ]);
      should(byName(servers, 'linear', 'component').shadowedBy).be.undefined();
    });

    it('should read Ferretry’s own local-scope delivery of a project sign-in as that project server, not a second one', async () => {
      // Arrange
      const service = new McpInventoryService(inventoryWorld().deps);

      // Act
      const { servers } = await service.session('s1');

      // Assert
      should(servers.filter(server => server.name === 'docs').map(server => server.scope)).deepEqual(['project']);
      should(byName(servers, 'docs').shadowedBy).be.undefined();
    });

    it('should let a project’s web server sign in under its project subject, and a component under its name', async () => {
      // Arrange
      const w = inventoryWorld();
      w.connections = [
        {
          component: mcpProjectSubject('docs', PROJECT_KEY),
          state: 'signed-in',
          renewable: true,
          secrets: [],
        },
      ];
      const service = new McpInventoryService(w.deps);

      // Act
      const { servers } = await service.session('s1');

      // Assert
      should(byName(servers, 'docs').signIn).deepEqual({
        subject: mcpProjectSubject('docs', PROJECT_KEY),
        required: false,
      });
      should(byName(servers, 'docs').connection?.state).equal('signed-in');
      should(byName(servers, 'linear', 'component').signIn).deepEqual({ subject: 'linear', required: true });
      // A command signs in to nothing.
      should(byName(servers, 'lint').signIn).be.undefined();
    });

    it('should share one sign-in subject between a project and its worktree', async () => {
      // Arrange — the worktree carries its own copy of `.mcp.json`.
      const files = documents();
      files.set(`${WORKTREE}/.mcp.json`, files.get(`${PROJECT}/.mcp.json`));
      const service = new McpInventoryService(inventoryWorld(files).deps);

      // Act
      const [project, worktree] = await Promise.all([service.session('s1'), service.session('s2')]);

      // Assert
      should(byName(worktree.servers, 'docs').signIn?.subject).equal(byName(project.servers, 'docs').signIn?.subject);
      should(byName(worktree.servers, 'docs').source).equal(`${WORKTREE}/.mcp.json`);
    });

    it('should never put a command’s arguments, an address’s query or a header on the wire', async () => {
      // Arrange
      const service = new McpInventoryService(inventoryWorld().deps);

      // Act
      const text = JSON.stringify(await service.session('s1'));

      // Assert
      should(text).not.containEql('sk-live');
      should(text).not.containEql('team=1');
      should(text).not.containEql('FY_MCP_');
      should(byName((await service.session('s1')).servers, 'scratch').target).equal('uvx');
    });

    it('should say which file it could not read, and list the rest', async () => {
      // Arrange
      const files = documents();
      files.set(`${PROJECT}/.mcp.json`, BROKEN);
      const service = new McpInventoryService(inventoryWorld(files).deps);

      // Act
      const { servers, problems } = await service.session('s1');

      // Assert
      should(problems).deepEqual([
        {
          source: `${PROJECT}/.mcp.json`,
          message: `${PROJECT}/.mcp.json is not valid JSON, so its MCP servers cannot be read.`,
        },
      ]);
      should(servers.some(server => server.scope === 'project')).be.false();
      should(servers.some(server => server.name === 'scratch')).be.true();
    });

    it('should refuse a session it does not know', async () => {
      // Arrange
      const service = new McpInventoryService(inventoryWorld().deps);

      // Act
      const refusal = await service.session('nope').catch((error: unknown) => error);

      // Assert
      should(refusal).be.instanceOf(McpInventoryRefusal);
      should((refusal as McpInventoryRefusal).status).equal(404);
    });
  });

  describe('a Codex ferret', () => {
    it('should read the trusted project’s .codex/config.toml, and say a project sign-in cannot reach Codex', async () => {
      // Arrange
      const w = inventoryWorld();
      const service = new McpInventoryService({
        ...w.deps,
        sessions: {
          get: async () => (await import('./support.ts')).session(`${PROJECT}`, '/fy/fleet/bin/codex-work'),
        },
      });

      // Act
      const { servers } = await service.session('s1');

      // Assert
      should(servers.map(server => `${server.scope}:${server.name}:${server.transport}`)).deepEqual([
        'ferretry:ferretry:stdio',
        'component:linear:http',
        'project:search:sse',
        'project:off:stdio',
      ]);
      should(byName(servers, 'search').runtimes).deepEqual([{ runtime: 'codex-work', approval: 'approved' }]);
      should(byName(servers, 'off').runtimes).deepEqual([{ runtime: 'codex-work', approval: 'disabled' }]);
      should(byName(servers, 'search').signIn?.unsupported).match(/Codex/u);
    });

    it('should read an untrusted project’s servers as pending', async () => {
      // Arrange
      const files = documents();
      files.set(`${CODEX_HOME}/config.toml`, { mcp_servers: {} });
      const w = inventoryWorld(files);
      const service = new McpInventoryService({
        ...w.deps,
        sessions: {
          get: async () => (await import('./support.ts')).session(`${PROJECT}`, '/fy/fleet/bin/codex-work'),
        },
      });

      // Act
      const { servers } = await service.session('s1');

      // Assert
      should(byName(servers, 'search').runtimes).deepEqual([{ runtime: 'codex-work', approval: 'pending' }]);
    });
  });

  describe('the machine', () => {
    it('should list each declaration once, with every runtime that sees it', async () => {
      // Arrange
      const service = new McpInventoryService(inventoryWorld().deps);

      // Act
      const { servers } = await service.machine();

      // Assert — the component is one row however many homes it was written into.
      const linear = servers.filter(server => server.name === 'linear' && server.scope === 'component');
      should(linear.map(server => server.harness)).deepEqual(['claude', 'codex']);
      should(servers.filter(server => server.scope === 'ferretry').map(server => server.runtimes)).deepEqual([
        [{ runtime: 'claude-work' }],
        [{ runtime: 'codex-work' }],
      ]);
      // A project server is listed for each folder that declares it; the worktree has no file here.
      should(byName(servers, 'docs').project).deepEqual({ root: PROJECT, name: 'app' });
      should(byName(servers, 'scratch').source).equal(`${CLAUDE_HOME}/.claude.json`);
      // No shadows on the machine view: which one wins is a question about one home and one folder.
      should(servers.some(server => server.shadowedBy !== undefined)).be.false();
    });

    it('should resolve an id from either view, and refuse one that is gone', async () => {
      // Arrange
      const service = new McpInventoryService(inventoryWorld().deps);
      const docs = byName((await service.machine()).servers, 'docs');

      // Act
      const resolved = await service.resolve(docs.id);
      const gone = await service.resolve('0'.repeat(24)).catch((error: unknown) => error);

      // Assert
      should(resolved.declaration).containEql({ name: 'docs', transport: 'http' });
      should((gone as McpInventoryRefusal).code).equal('mcp_server_unknown');
    });
  });

  describe('mcpInventoryFolders', () => {
    it('should join a live worktree to its registered project, and fall back to its repository', async () => {
      // Arrange
      const read = mcpInventoryFolders(
        { projects: async () => [{ id: 'p1', name: 'app', path: PROJECT }] },
        {
          list: async () => ({
            worktrees: [
              { path: WORKTREE, repositoryRoot: PROJECT, projectId: 'p1' },
              { path: '/wt/other', repositoryRoot: '/src/other' },
              { path: '/wt/gone', repositoryRoot: PROJECT, projectId: 'p1', removedAt: '2026-01-01T00:00:00.000Z' },
            ],
          }),
        },
      );

      // Act
      const folders = await read();

      // Assert
      should(folders).deepEqual([
        { root: PROJECT, project: PROJECT, name: 'app' },
        { root: WORKTREE, project: PROJECT, name: 'app' },
        { root: '/wt/other', project: '/src/other' },
      ]);
    });
  });
});
