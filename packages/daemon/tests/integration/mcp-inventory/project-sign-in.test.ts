/**
 * The owner's failure, end to end: a project's `.mcp.json` server that asks for OAuth. Before this,
 * Ferretry listed it, offered no Sign in (the PWA marked every project server "signs in: no") and the
 * daemon refused one anyway ("There is no MCP server named …": sign-in knew only fleet components).
 *
 * Here, over real files in a temporary directory and a fake OAuth provider: the server signs in under
 * its project subject, a Claude launch in that project gets a local-scope entry naming a variable (never
 * the token) plus the variable's value, a worktree of the project shares the sign-in, a runtime that
 * disabled the server gets nothing, and signing out takes the entry away again.
 *
 * And the second failure (`phoebe..048c658abfb9`): a ferret working in a repository nobody registered.
 * The inventory listed its server under the ferret's own folder while the sign-in list and the launch
 * knew only registered folders, so the subject a row offered was one the sign-in refused. All three now
 * read one folder source (`KnownAndFerretFolders`).
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpOAuthSecretNames, mcpProjectSubject } from '@ferretry/protocol';
import should from 'should';
import { FileClaudeLocalScope, FileMcpHarnessDocuments } from '../../../src/adapters/mcp-inventory/index.ts';
import {
  combinedMcpOAuthServers,
  KnownAndFerretFolders,
  type McpInventoryAccount,
  type McpInventoryFolder,
  McpInventoryService,
  mcpProjectKey,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
} from '../../../src/lib/mcp-inventory/index.ts';
import { McpOAuthService } from '../../../src/lib/mcp-oauth/index.ts';
import { leaks, PWA_REDIRECT, testCrypto, world } from '../../unit/mcp-oauth/support.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

async function machine(options: { disabled?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-mcp-signin-'));
  roots.push(root);
  const home = path.join(root, 'fleet/homes/claude-work-id');
  const project = path.join(root, 'work/app');
  const worktree = path.join(root, 'wt/app-feature');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(worktree, { recursive: true }),
  ]);

  // The provider and the sign-in service, unchanged — only the list of servers that may sign in grows.
  const w = world({ expiresIn: 3600 });
  const projectFile = JSON.stringify({ mcpServers: { docs: { type: 'http', url: w.provider.serverUrl } } });
  await writeFile(path.join(project, '.mcp.json'), projectFile);
  await writeFile(path.join(worktree, '.mcp.json'), projectFile);
  // Claude's own state in the runtime's home, which must survive every write.
  await writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 7,
      mcpServers: {},
      projects: {
        [project]: {
          hasTrustDialogAccepted: true,
          ...(options.disabled === true ? { disabledMcpjsonServers: ['docs'] } : {}),
          mcpServers: { mine: { command: 'node', args: ['mine.js'] } },
        },
      },
    }),
  );

  // A repository no project is registered for, with a ferret working in it.
  const lone = path.join(root, 'work/vungle/PE');
  await mkdir(lone, { recursive: true });
  await writeFile(
    path.join(lone, '.mcp.json'),
    JSON.stringify({ mcpServers: { phoebe: { type: 'http', url: w.provider.serverUrl } } }),
  );
  const known: readonly McpInventoryFolder[] = [
    { root: project, project, name: 'app' },
    { root: worktree, project, name: 'app' },
  ];
  const folders = new KnownAndFerretFolders(
    async () => known,
    async () => [lone, project],
  );
  const accounts: readonly McpInventoryAccount[] = [
    { runtime: 'claude-work', harness: 'claude', home, wrapper: '/fy/bin/claude-work' },
  ];
  const documents = new FileMcpHarnessDocuments();
  const service = new McpOAuthService({
    servers: combinedMcpOAuthServers({ list: async () => [] }, new ProjectMcpOAuthServers(folders, documents)),
    http: w.http,
    crypto: testCrypto,
    clock: w.clock,
    state: w.state,
    secrets: w.secrets,
    values: w.secrets,
    internal: w.internal,
  });
  const launch = new ProjectMcpLaunch({
    accounts: async () => accounts,
    folders,
    documents,
    secrets: w.secrets,
    renewal: service,
    localScope: new FileClaudeLocalScope(),
  });
  const subject = mcpProjectSubject('docs', mcpProjectKey(project));
  const names = mcpOAuthSecretNames(subject, w.provider.serverUrl);
  const claudeJson = async () =>
    JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as {
      numStartups: number;
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
  return {
    w,
    service,
    launch,
    subject,
    names,
    home,
    project,
    worktree,
    lone,
    folders,
    accounts,
    documents,
    claudeJson,
  };
}

describe('signing in to a project’s .mcp.json server', () => {
  it('should sign in under the project subject, and not list the server before it has a sign-in', async () => {
    // Arrange
    const m = await machine();
    should(await m.service.connections()).deepEqual([]);

    // Act
    const flow = await m.service.start(m.subject, { redirectUri: PWA_REDIRECT });
    const callback = await m.w.provider.approve(flow.authorizeUrl);
    const completion = await m.service.complete(flow.flowId, { callback });

    // Assert
    should(completion.connection).containEql({ component: m.subject, state: 'signed-in' });
    should((await m.service.connections()).map(connection => connection.component)).deepEqual([m.subject]);
    should(m.w.secrets.entries.get(m.names.access)).equal(m.w.provider.issued[0]);
    should(leaks(m.w.provider, completion, m.w.state.document)).deepEqual([]);
  });

  it('should hand a Claude launch in the project a local-scope entry naming a variable, and the variable', async () => {
    // Arrange
    const m = await machine();
    const flow = await m.service.start(m.subject, { redirectUri: PWA_REDIRECT });
    await m.service.complete(flow.flowId, { callback: await m.w.provider.approve(flow.authorizeUrl) });

    // Act
    const env = await m.launch.forLaunch('/fy/bin/claude-work', path.join(m.project, 'src'));

    // Assert — the value is in the launch environment, and only its NAME is in the file.
    should(env).deepEqual({ [m.names.variable]: m.w.provider.issued[0] });
    const after = await m.claudeJson();
    should(after.numStartups).equal(7);
    should(after.projects[m.project]?.mcpServers).deepEqual({
      mine: { command: 'node', args: ['mine.js'] },
      docs: {
        type: 'http',
        url: m.w.provider.serverUrl,
        headers: { Authorization: `Bearer \${${m.names.variable}}` },
      },
    });
    should(leaks(m.w.provider, await readFile(path.join(m.home, '.claude.json'), 'utf8'))).deepEqual([]);
  });

  it('should reach a worktree of the project with the same sign-in', async () => {
    // Arrange
    const m = await machine();
    const flow = await m.service.start(m.subject, { redirectUri: PWA_REDIRECT });
    await m.service.complete(flow.flowId, { callback: await m.w.provider.approve(flow.authorizeUrl) });

    // Act
    const env = await m.launch.forLaunch('/fy/bin/claude-work', m.worktree);

    // Assert — the entry is keyed by the worktree's own root, which is the folder Claude keys it by.
    should(Object.keys(env)).deepEqual([m.names.variable]);
    should(Object.keys((await m.claudeJson()).projects[m.worktree]?.mcpServers ?? {})).deepEqual(['docs']);
  });

  it('should give nothing to a runtime that disabled the server in this project', async () => {
    // Arrange
    const m = await machine({ disabled: true });
    const flow = await m.service.start(m.subject, { redirectUri: PWA_REDIRECT });
    await m.service.complete(flow.flowId, { callback: await m.w.provider.approve(flow.authorizeUrl) });

    // Act
    const env = await m.launch.forLaunch('/fy/bin/claude-work', m.project);

    // Assert
    should(env).deepEqual({});
    should(Object.keys((await m.claudeJson()).projects[m.project]?.mcpServers ?? {})).deepEqual(['mine']);
  });

  it('should take the entry away again after a sign-out, leaving every other entry', async () => {
    // Arrange
    const m = await machine();
    const flow = await m.service.start(m.subject, { redirectUri: PWA_REDIRECT });
    await m.service.complete(flow.flowId, { callback: await m.w.provider.approve(flow.authorizeUrl) });
    await m.launch.forLaunch('/fy/bin/claude-work', m.project);

    // Act
    await m.service.signOut(m.subject);
    const env = await m.launch.forLaunch('/fy/bin/claude-work', m.project);

    // Assert
    should(env).deepEqual({});
    should((await m.claudeJson()).projects[m.project]?.mcpServers).deepEqual({
      mine: { command: 'node', args: ['mine.js'] },
    });
  });

  it('should write nothing for a folder with no project server, or a Codex runtime', async () => {
    // Arrange
    const m = await machine();
    const before = await readFile(path.join(m.home, '.claude.json'), 'utf8');

    // Act
    const elsewhere = await m.launch.forLaunch('/fy/bin/claude-work', '/somewhere/else');
    const codex = await m.launch.forLaunch('/fy/bin/codex-work', m.project);

    // Assert
    should(elsewhere).deepEqual({});
    should(codex).deepEqual({});
    should(await readFile(path.join(m.home, '.claude.json'), 'utf8')).equal(before);
  });

  it('should show the inventory the signed-in project server, once, with its connection', async () => {
    // Arrange
    const m = await machine();
    const flow = await m.service.start(m.subject, { redirectUri: PWA_REDIRECT });
    await m.service.complete(flow.flowId, { callback: await m.w.provider.approve(flow.authorizeUrl) });
    await m.launch.forLaunch('/fy/bin/claude-work', m.project);
    const inventory = new McpInventoryService({
      accounts: async () => m.accounts,
      components: async () => [],
      folders: m.folders,
      connections: async () => await m.service.connections(),
      documents: m.documents,
      sessions: { get: async () => sessionView('s1', { cwd: m.project, agent: '/fy/bin/claude-work' }) },
    });

    // Act
    const { servers } = await inventory.session('s1');

    // Assert — the local entry Ferretry wrote is the project server's delivery, not a second server.
    const docs = servers.filter(server => server.name === 'docs');
    should(docs.map(server => server.scope)).deepEqual(['project']);
    should(docs[0]?.connection?.state).equal('signed-in');
    should(docs[0]?.runtimes).deepEqual([{ runtime: 'claude-work', approval: 'pending' }]);
  });

  it('should sign in to, list and deliver a server of a folder no project is registered for', async () => {
    // Arrange — the inventory hands out the subject, exactly as the PWA reads it off the row.
    const m = await machine();
    const inventory = new McpInventoryService({
      accounts: async () => m.accounts,
      components: async () => [],
      folders: m.folders,
      connections: async () => await m.service.connections(),
      documents: m.documents,
      sessions: { get: async () => sessionView('s1', { cwd: m.lone, agent: '/fy/bin/claude-work' }) },
    });
    const row = (await inventory.session('s1')).servers.find(server => server.name === 'phoebe');
    const subject = row?.signIn?.subject ?? '';
    should(subject).equal(mcpProjectSubject('phoebe', mcpProjectKey(m.lone)));

    // Act
    const flow = await m.service.start(subject, { redirectUri: PWA_REDIRECT });
    await m.service.complete(flow.flowId, { callback: await m.w.provider.approve(flow.authorizeUrl) });
    const env = await m.launch.forLaunch('/fy/bin/claude-work', m.lone);

    // Assert — signed in, listed as signed in, and handed to Claude as the local-scope entry.
    const variable = mcpOAuthSecretNames(subject, m.w.provider.serverUrl).variable;
    should(env).deepEqual({ [variable]: m.w.provider.issued[0] });
    should((await m.claudeJson()).projects[m.lone]?.mcpServers).deepEqual({
      phoebe: {
        type: 'http',
        url: m.w.provider.serverUrl,
        headers: { Authorization: `Bearer \${${variable}}` },
      },
    });
    const after = (await inventory.session('s1')).servers.find(server => server.name === 'phoebe');
    should(after?.connection?.state).equal('signed-in');
  });
});
