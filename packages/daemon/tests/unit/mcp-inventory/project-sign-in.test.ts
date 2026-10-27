import { describe, it } from 'bun:test';
import { mcpOAuthSecretNames, mcpProjectSubject, type SecretName } from '@ferretry/protocol';
import should from 'should';
import {
  type ClaudeLocalScope,
  combinedMcpOAuthServers,
  type LocalScopeServer,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
} from '../../../src/lib/mcp-inventory/index.ts';
import {
  ACCOUNTS,
  BROKEN,
  CLAUDE_HOME,
  documents,
  FOLDERS,
  knownFolders,
  MemoryDocuments,
  PROJECT,
  PROJECT_KEY,
  variable,
  WORKTREE,
} from './support.ts';

const DOCS_URL = 'https://docs.example.com/mcp?team=1';
const DOCS = mcpOAuthSecretNames(mcpProjectSubject('docs', PROJECT_KEY), DOCS_URL);
const LINEAR = mcpOAuthSecretNames(mcpProjectSubject('linear', PROJECT_KEY), 'https://mcp.linear.app/mcp');

class RecordingLocalScope implements ClaudeLocalScope {
  readonly calls: { path: string; root: string; servers: Readonly<Record<string, LocalScopeServer>> }[] = [];
  async reconcile(path: string, root: string, servers: Readonly<Record<string, LocalScopeServer>>): Promise<void> {
    this.calls.push({ path, root, servers });
  }
}

function launcher(
  files: Map<string, unknown> = documents(),
  held: Record<string, string> = { [DOCS.access]: 'docs-token' },
) {
  const localScope = new RecordingLocalScope();
  const renewed: (readonly SecretName[])[] = [];
  const launch = new ProjectMcpLaunch({
    accounts: async () => ACCOUNTS,
    folders: knownFolders(FOLDERS),
    documents: new MemoryDocuments(files),
    secrets: { values: async () => new Map(Object.entries(held) as [SecretName, string][]) },
    renewal: { refreshForLaunch: async names => void renewed.push(names) },
    localScope,
  });
  return { launch, localScope, renewed };
}

describe('ProjectMcpOAuthServers', () => {
  it('should offer each project web server once, under its project subject, as one that MAY sign in', async () => {
    // Arrange — the worktree carries a copy with a different address; the project's own file wins.
    const files = documents();
    files.set(`${WORKTREE}/.mcp.json`, { mcpServers: { docs: { url: 'https://moved.example.com/mcp' } } });
    const servers = new ProjectMcpOAuthServers(knownFolders([...FOLDERS].reverse()), new MemoryDocuments(files));

    // Act
    const listed = await servers.list();

    // Assert
    should(listed).deepEqual([
      { component: mcpProjectSubject('docs', PROJECT_KEY), url: DOCS_URL, auth: 'oauth', optional: true },
      {
        component: mcpProjectSubject('linear', PROJECT_KEY),
        url: 'https://mcp.linear.app/mcp',
        auth: 'oauth',
        optional: true,
      },
    ]);
  });

  it('should list nothing for a project file it cannot read, and join both kinds of target', async () => {
    // Arrange
    const files = documents();
    files.set(`${PROJECT}/.mcp.json`, BROKEN);
    const combined = combinedMcpOAuthServers(
      { list: async () => [{ component: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }] },
      new ProjectMcpOAuthServers(knownFolders(FOLDERS), new MemoryDocuments(files)),
    );

    // Act / Assert
    should((await combined.list()).map(server => server.component)).deepEqual(['linear']);
  });
});

describe('ProjectMcpLaunch', () => {
  it('should renew, then write a local-scope entry naming the variable and answer the variable’s value', async () => {
    // Arrange
    const { launch, localScope, renewed } = launcher();

    // Act
    const env = await launch.forLaunch('/fy/fleet/bin/claude-work', `${PROJECT}/src`);

    // Assert
    should(renewed).deepEqual([[DOCS.access, LINEAR.access]]);
    should(env).deepEqual({ [DOCS.variable]: 'docs-token' });
    should(localScope.calls).deepEqual([
      {
        path: `${CLAUDE_HOME}/.claude.json`,
        root: PROJECT,
        servers: {
          docs: { type: 'http', url: DOCS_URL, headers: { Authorization: `Bearer ${variable(DOCS.variable)}` } },
        },
      },
    ]);
  });

  it('should skip a server this runtime disabled in the project', async () => {
    // Arrange
    const files = documents();
    const home = files.get(`${CLAUDE_HOME}/.claude.json`) as {
      projects: Record<string, { disabledMcpjsonServers: string[] }>;
    };
    home.projects[PROJECT]?.disabledMcpjsonServers.push('docs');
    const { launch, localScope } = launcher(files);

    // Act
    const env = await launch.forLaunch('/fy/fleet/bin/claude-work', PROJECT);

    // Assert — the earlier entry (the fixture holds one) is reconciled away.
    should(env).deepEqual({});
    should(localScope.calls.map(call => call.servers)).deepEqual([{}]);
  });

  it('should touch nothing when there is no earlier entry and nothing is signed in', async () => {
    // Arrange — no Ferretry entry in the home, and no token held.
    const files = documents();
    const home = files.get(`${CLAUDE_HOME}/.claude.json`) as { projects: Record<string, { mcpServers: unknown }> };
    const entry = home.projects[PROJECT];
    if (entry !== undefined) entry.mcpServers = { mine: { command: 'node' } };
    const { launch, localScope, renewed } = launcher(files, {});

    // Act
    const env = await launch.forLaunch('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(env).deepEqual({});
    should(localScope.calls).deepEqual([]);
    should(renewed).have.length(1);
  });

  it('should read an unreadable home or settings as nothing, and still deliver', async () => {
    // Arrange
    const files = documents();
    files.set(`${CLAUDE_HOME}/.claude.json`, BROKEN);
    files.set(`${CLAUDE_HOME}/settings.json`, BROKEN);
    const { launch, localScope } = launcher(files);

    // Act
    const env = await launch.forLaunch('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(Object.keys(env)).deepEqual([DOCS.variable]);
    should(localScope.calls).have.length(1);
  });

  it('should do nothing for a Codex runtime, an unknown executable, or a folder in no project', async () => {
    // Arrange
    const { launch, localScope, renewed } = launcher();

    // Act
    const answers = await Promise.all([
      launch.forLaunch('/fy/fleet/bin/codex-work', PROJECT),
      launch.forLaunch('/nowhere/bin/other', PROJECT),
      launch.forLaunch('claude-work', '/elsewhere'),
    ]);

    // Assert
    should(answers).deepEqual([{}, {}, {}]);
    should(localScope.calls).deepEqual([]);
    should(renewed).deepEqual([]);
  });

  it('should open no store for a project with no web server', async () => {
    // Arrange
    const files = documents();
    files.set(`${PROJECT}/.mcp.json`, { mcpServers: { lint: { command: 'npx' } } });
    files.set(`${CLAUDE_HOME}/.claude.json`, { projects: {} });
    let opened = 0;
    const launch = new ProjectMcpLaunch({
      accounts: async () => ACCOUNTS,
      folders: knownFolders(FOLDERS),
      documents: new MemoryDocuments(files),
      secrets: {
        values: async () => {
          opened += 1;
          return new Map();
        },
      },
      localScope: new RecordingLocalScope(),
    });

    // Act
    const env = await launch.forLaunch('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(env).deepEqual({});
    should(opened).equal(0);
  });
});
