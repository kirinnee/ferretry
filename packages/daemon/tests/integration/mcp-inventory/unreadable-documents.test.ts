/**
 * One document the daemon cannot read costs the owner that one document, not the whole inventory: the
 * real files are read, the unreadable one is named by path and cause, and every server the daemon COULD
 * read is still listed. (A document that threw anything but "unreadable" used to fail the route with
 * the daemon's blanket "failed to handle this request", and Context › MCP said so in one line.)
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import { FileMcpHarnessDocuments, unreadableDocument } from '../../../src/adapters/mcp-inventory/index.ts';
import { McpDocumentUnreadable, McpInventoryService } from '../../../src/lib/mcp-inventory/index.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

/** A runtime home holding one user-scope server, beside a project folder the test then spoils. */
async function machine(): Promise<{ readonly home: string; readonly project: string; readonly session: SessionView }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-mcp-unreadable-'));
  roots.push(root);
  const home = path.join(root, 'fleet', 'homes', 'claude-work-id');
  const project = path.join(root, 'pe');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { scratch: { command: 'uvx', args: ['scratch'] } } }),
  );
  const session = sessionView('s1', {
    cwd: project,
    agent: path.join(root, 'bin', 'claude-work'),
    harness: 'claude',
  });
  return { home, project, session };
}

const inventoryOver = (home: string, project: string, session: SessionView) =>
  new McpInventoryService({
    accounts: async () => [{ runtime: 'claude-work', harness: 'claude', home, wrapper: session.config.agent }],
    components: async () => [],
    folders: async () => [{ root: project, project }],
    connections: async () => [],
    documents: new FileMcpHarnessDocuments(),
    sessions: { get: async () => session },
  });

describe('the MCP inventory over documents the daemon cannot read', () => {
  it('should name a malformed project .mcp.json and still list the home’s servers', async () => {
    // Arrange
    const { home, project, session } = await machine();
    await writeFile(path.join(project, '.mcp.json'), '{"mcpServers": {"x": {"env": {"KEY": "sk-live-SECRET"}, oops}');

    // Act
    const { servers, problems } = await inventoryOver(home, project, session).session('s1');

    // Assert
    should(problems).deepEqual([
      {
        source: path.join(project, '.mcp.json'),
        message: `${path.join(project, '.mcp.json')} is not valid JSON, so its MCP servers cannot be read.`,
      },
    ]);
    should(JSON.stringify(problems)).not.containEql('sk-live');
    should(servers.map(server => `${server.scope}:${server.name}`)).deepEqual(['ferretry:ferretry', 'user:scratch']);
  });

  it('should name a .mcp.json the file system will not open, rather than failing the whole read', async () => {
    // Arrange
    const { home, project, session } = await machine();
    const loop = path.join(project, '.mcp.json');
    await symlink(loop, loop);

    // Act
    const { servers, problems } = await inventoryOver(home, project, session).session('s1');

    // Assert
    should(problems).deepEqual([{ source: loop, message: `${loop} could not be read (ELOOP).` }]);
    should(servers.map(server => server.name)).deepEqual(['ferretry', 'scratch']);
  });
});

describe('unreadableDocument', () => {
  const failure = (code: string): Error => Object.assign(new Error(`${code}: raw text with /secret/path`), { code });

  it('should say a permission refusal by path, and that macOS may need to allow the folder on EPERM', () => {
    // Act
    const denied = unreadableDocument('/work/pe/.mcp.json', failure('EACCES'));
    const refused = unreadableDocument('/work/pe/.mcp.json', failure('EPERM'));

    // Assert
    should(denied).be.instanceOf(McpDocumentUnreadable);
    should(denied.message).equal('/work/pe/.mcp.json cannot be read by the daemon.');
    should(refused).be.instanceOf(McpDocumentUnreadable);
    should(refused.message).containEql('/work/pe/.mcp.json cannot be read by the daemon');
    should(refused.message).containEql('Full Disk Access');
    should(refused.message).not.containEql('/secret/path');
  });

  it('should name any other cause by its code, never by the operating system’s text, and keep a finished refusal', () => {
    // Arrange
    const already = new McpDocumentUnreadable('/a is not a regular file.');

    // Act / Assert
    should(unreadableDocument('/a', failure('EIO')).message).equal('/a could not be read (EIO).');
    should(unreadableDocument('/a', new Error('odd')).message).equal('/a could not be read.');
    should(unreadableDocument('/a', already)).equal(already);
  });
});
