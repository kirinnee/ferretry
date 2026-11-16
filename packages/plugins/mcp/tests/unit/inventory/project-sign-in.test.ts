import { describe, it } from 'bun:test';
import { optionalSecretReference, type SecretName } from '@ferretry/core-vault/contract';
import { mcpOAuthSecretNames, mcpProjectSubject } from '../../../contract/index.ts';
import should from 'should';
import {
  combinedMcpOAuthServers,
  type McpProjectApprovalsRequest,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
} from '../../../daemon/lib/inventory/project-sign-in.ts';
import {
  ACCOUNTS,
  BROKEN,
  CLAUDE_HOME,
  documentApprovals,
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

/** A launch whose harness answers from `files` the way the Claude Code plugin reads its own home. */
function launcher(files: Map<string, unknown> = documents(), held: readonly string[] = [DOCS.access]) {
  const renewed: (readonly SecretName[])[] = [];
  const asked: { harness: string; root: string; servers: readonly string[] }[] = [];
  const answer = documentApprovals(files);
  const launch = new ProjectMcpLaunch({
    accounts: async () => ACCOUNTS,
    folders: knownFolders(FOLDERS),
    documents: new MemoryDocuments(files),
    approvals: async (request: McpProjectApprovalsRequest) => {
      asked.push({ harness: request.account.harness, root: request.root, servers: request.servers });
      return await answer(request);
    },
    secrets: { held: async () => new Set(held as SecretName[]) },
    renewal: { refreshForLaunch: async names => void renewed.push(names) },
  });
  return { launch, renewed, asked };
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

  it('should carry a server’s hand-registered client from .mcp.json into the sign-in', async () => {
    // Arrange
    const files = documents();
    files.set(`${PROJECT}/.mcp.json`, {
      mcpServers: {
        phoebe: { type: 'http', url: 'https://phoebe.example/mcp', oauth: { clientId: 'hand-1', callbackPort: 8123 } },
      },
    });
    const servers = new ProjectMcpOAuthServers(knownFolders(FOLDERS), new MemoryDocuments(files));

    // Act
    const listed = await servers.list();

    // Assert
    should(listed.find(server => server.component === mcpProjectSubject('phoebe', PROJECT_KEY))).containEql({
      client: { clientId: 'hand-1', callbackPort: 8123 },
    });
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
  it('should renew, then answer a local-scope entry naming the variable and the variable’s optional secret reference', async () => {
    // Arrange
    const { launch, renewed, asked } = launcher();

    // Act
    const share = await launch.share('/fy/fleet/bin/claude-work', `${PROJECT}/src`);

    // Assert
    should(renewed).deepEqual([[DOCS.access, LINEAR.access]]);
    // The harness was asked about this project's own web servers, for the project root.
    should(asked).deepEqual([{ harness: 'claude-code', root: PROJECT, servers: ['docs', 'linear'] }]);
    // A reference the Vault opens into the child, never the token: MCP holds no value (use, never read).
    should(share.env).deepEqual({ [DOCS.variable]: optionalSecretReference(DOCS.access) });
    should(share.servers).deepEqual({
      docs: { type: 'http', url: DOCS_URL, headers: { Authorization: `Bearer ${variable(DOCS.variable)}` } },
    });
  });

  it('should give a server this runtime disabled no variable and no local entry, though its token is held', async () => {
    // Arrange — the harness reads its home; `docs` is signed in (held) and declined in the project.
    const files = documents();
    const home = files.get(`${CLAUDE_HOME}/.claude.json`) as {
      projects: Record<string, { disabledMcpjsonServers: string[] }>;
    };
    home.projects[PROJECT]?.disabledMcpjsonServers.push('docs');
    const { launch } = launcher(files);

    // Act
    const share = await launch.share('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(share.env).deepEqual({});
    should(share.servers).deepEqual({});
  });

  it.each([
    ['the runtime’s .claude.json', `${CLAUDE_HOME}/.claude.json`],
    ['the runtime’s settings', `${CLAUDE_HOME}/settings.json`],
    ['both', 'both'],
  ] as const)(
    'should fail closed when the harness cannot read %s: renewed, but no variable and no local entry',
    async (_what, path) => {
      // Arrange — the approvals are unknown, so whether the runtime declined `docs` cannot be told.
      const files = documents();
      for (const target of [`${CLAUDE_HOME}/.claude.json`, `${CLAUDE_HOME}/settings.json`])
        if (path === 'both' || path === target) files.set(target, BROKEN);
      const { launch, renewed } = launcher(files);

      // Act
      const share = await launch.share('/fy/fleet/bin/claude-work', PROJECT);

      // Assert
      should(renewed).deepEqual([[DOCS.access, LINEAR.access]]);
      should(share.env).deepEqual({});
      should(share.servers).deepEqual({});
    },
  );

  it('should fail closed when the harness is off or does not answer: renewed, nothing bound', async () => {
    // Arrange — `approvals` answers nothing: the harness plugin is off, a skeleton, or threw.
    const renewed: (readonly SecretName[])[] = [];
    const launch = new ProjectMcpLaunch({
      accounts: async () => ACCOUNTS,
      folders: knownFolders(FOLDERS),
      documents: new MemoryDocuments(documents()),
      approvals: async () => undefined,
      secrets: { held: async () => new Set([DOCS.access]) },
      renewal: { refreshForLaunch: async names => void renewed.push(names) },
    });

    // Act
    const share = await launch.share('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(renewed).deepEqual([[DOCS.access, LINEAR.access]]);
    should(share.env).deepEqual({});
    should(share.servers).deepEqual({});
  });

  it('should not assume a server the harness gave no decision for is approved', async () => {
    // Arrange — an answer that leaves `docs` out.
    const launch = new ProjectMcpLaunch({
      accounts: async () => ACCOUNTS,
      folders: knownFolders(FOLDERS),
      documents: new MemoryDocuments(documents()),
      approvals: async () => ({ state: 'read', servers: { linear: 'approved' } }),
      secrets: { held: async () => new Set([DOCS.access]) },
    });

    // Act / Assert
    should((await launch.share('/fy/fleet/bin/claude-work', PROJECT)).env).deepEqual({});
  });

  it('should bind a server the harness approved, and one a runtime has no documents for yet (pending)', async () => {
    // Arrange — the fixture's home approves `docs` in the project; a fresh home's documents are not there at all.
    const files = documents();
    const fresh = documents();
    fresh.delete(`${CLAUDE_HOME}/.claude.json`);
    fresh.delete(`${CLAUDE_HOME}/settings.json`);

    // Act
    const approving = await launcher(files).launch.share('/fy/fleet/bin/claude-work', PROJECT);
    const absent = await launcher(fresh).launch.share('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    for (const share of [approving, absent]) {
      should(share.env).deepEqual({ [DOCS.variable]: optionalSecretReference(DOCS.access) });
      should(Object.keys(share.servers)).deepEqual(['docs']);
    }
  });

  it('should not swallow a failure to read the project’s .mcp.json that is not an unreadable document', async () => {
    // Arrange — a disk that fails, as opposed to a file that does not parse.
    const defect = new Error('EIO: the disk is gone');
    const files = new MemoryDocuments(documents());
    const launch = new ProjectMcpLaunch({
      accounts: async () => ACCOUNTS,
      folders: knownFolders(FOLDERS),
      documents: {
        read: async target => {
          if (target === `${PROJECT}/.mcp.json`) throw defect;
          return files.read(target);
        },
      },
      approvals: documentApprovals(documents()),
      secrets: { held: async () => new Set([DOCS.access]) },
    });

    // Act
    const failure = await launch.forLaunch('/fy/fleet/bin/claude-work', PROJECT).catch((error: unknown) => error);

    // Assert
    should(failure).equal(defect);
  });

  it('should never read the runtime’s home: only the project’s own .mcp.json', async () => {
    // Arrange
    const files = new MemoryDocuments(documents());
    const launch = new ProjectMcpLaunch({
      accounts: async () => ACCOUNTS,
      folders: knownFolders(FOLDERS),
      documents: files,
      approvals: documentApprovals(documents()),
      secrets: { held: async () => new Set([DOCS.access]) },
    });

    // Act
    await launch.share('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(files.reads).deepEqual([`${PROJECT}/.mcp.json`]);
  });

  it('should do nothing for a Codex runtime (not-taken, no renewal), an unknown executable, or a folder in no project', async () => {
    // Arrange
    const { launch, renewed } = launcher();

    // Act
    const answers = await Promise.all([
      launch.forLaunch('/fy/fleet/bin/codex-work', PROJECT),
      launch.forLaunch('/nowhere/bin/other', PROJECT),
      launch.forLaunch('claude-work', '/elsewhere'),
    ]);

    // Assert
    should(answers).deepEqual([{}, {}, {}]);
    should(renewed).deepEqual([]);
  });

  it('should open no store for a project with no web server', async () => {
    // Arrange
    const files = documents();
    files.set(`${PROJECT}/.mcp.json`, { mcpServers: { lint: { command: 'npx' } } });
    let opened = 0;
    const launch = new ProjectMcpLaunch({
      accounts: async () => ACCOUNTS,
      folders: knownFolders(FOLDERS),
      documents: new MemoryDocuments(files),
      approvals: documentApprovals(files),
      secrets: {
        held: async () => {
          opened += 1;
          return new Set();
        },
      },
    });

    // Act
    const env = await launch.forLaunch('/fy/fleet/bin/claude-work', PROJECT);

    // Assert
    should(env).deepEqual({});
    should(opened).equal(0);
  });
});
