/**
 * The harness documents over real files: JSON and TOML parse, a missing or empty file is "not there",
 * and a file that does not parse is said by path without quoting a byte of it — it may hold a key.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileClaudeLocalScope, FileMcpHarnessDocuments } from '../../../src/adapters/mcp-inventory/index.ts';
import { McpDocumentUnreadable } from '../../../src/lib/mcp-inventory/index.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-mcp-documents-'));
  roots.push(root);
  return root;
}

describe('FileMcpHarnessDocuments', () => {
  it('should parse JSON and TOML, and read a missing or empty file as not there', async () => {
    // Arrange
    const root = await directory();
    await writeFile(path.join(root, 'a.json'), '{"mcpServers":{"x":{"command":"y"}}}');
    await writeFile(path.join(root, 'b.toml'), '[mcp_servers.x]\nurl = "https://x.example/mcp"\n');
    await writeFile(path.join(root, 'empty.json'), '  \n');
    const documents = new FileMcpHarnessDocuments();

    // Act / Assert
    should(await documents.read(path.join(root, 'a.json'), 'json')).deepEqual({ mcpServers: { x: { command: 'y' } } });
    should(await documents.read(path.join(root, 'b.toml'), 'toml')).deepEqual({
      mcp_servers: { x: { url: 'https://x.example/mcp' } },
    });
    should(await documents.read(path.join(root, 'missing.json'), 'json')).be.null();
    should(await documents.read(path.join(root, 'no-dir/x.json'), 'json')).be.null();
    should(await documents.read(path.join(root, 'empty.json'), 'json')).be.null();
  });

  it('should say a document does not parse without quoting it, and refuse a directory', async () => {
    // Arrange
    const root = await directory();
    await writeFile(path.join(root, 'bad.json'), '{"key": "sk-live-SECRET-VALUE", oops}');
    await mkdir(path.join(root, 'dir.json'));
    const documents = new FileMcpHarnessDocuments();

    // Act
    const bad = await documents.read(path.join(root, 'bad.json'), 'json').catch((error: unknown) => error);
    const dir = await documents.read(path.join(root, 'dir.json'), 'json').catch((error: unknown) => error);

    // Assert
    should(bad).be.instanceOf(McpDocumentUnreadable);
    should((bad as Error).message).equal(
      `${path.join(root, 'bad.json')} is not valid JSON, so its MCP servers cannot be read.`,
    );
    should((bad as Error).message).not.containEql('sk-live');
    should(dir).be.instanceOf(McpDocumentUnreadable);
  });
});

describe('FileMcpHarnessDocuments, when the daemon may not read a file', () => {
  // Root reads anything, so this says nothing when the suite runs as root.
  it.skipIf(process.getuid?.() === 0)('should say the daemon cannot read it', async () => {
    // Arrange
    const root = await directory();
    const file = path.join(root, 'locked.json');
    await writeFile(file, '{}');
    await chmod(file, 0o000);

    // Act
    const error = await new FileMcpHarnessDocuments().read(file, 'json').catch((caught: unknown) => caught);

    // Assert
    should(error).be.instanceOf(McpDocumentUnreadable);
    should((error as Error).message).equal(`${file} cannot be read by the daemon.`);
  });
});

describe('FileClaudeLocalScope', () => {
  const header = (name: string) => ({ Authorization: `Bearer \${${name}}` });

  it('should replace only Ferretry’s own entries for one project, keeping every other key and the mode', async () => {
    // Arrange
    const root = await directory();
    const file = path.join(root, '.claude.json');
    await writeFile(
      file,
      JSON.stringify({
        numStartups: 3,
        projects: {
          '/work/app': {
            allowedTools: ['Bash'],
            mcpServers: {
              mine: { command: 'node' },
              old: { type: 'http', url: 'https://old.example/mcp', headers: header('FY_MCP_OLD_0A_TOKEN') },
            },
          },
          '/work/other': { mcpServers: { kept: { command: 'x' } } },
        },
      }),
      { mode: 0o600 },
    );

    // Act
    await new FileClaudeLocalScope().reconcile(file, '/work/app', {
      docs: { type: 'http', url: 'https://docs.example/mcp', headers: header('FY_MCP_DOCS_0A_TOKEN') },
    });

    // Assert
    should(JSON.parse(await readFile(file, 'utf8'))).deepEqual({
      numStartups: 3,
      projects: {
        '/work/app': {
          allowedTools: ['Bash'],
          mcpServers: {
            mine: { command: 'node' },
            docs: { type: 'http', url: 'https://docs.example/mcp', headers: header('FY_MCP_DOCS_0A_TOKEN') },
          },
        },
        '/work/other': { mcpServers: { kept: { command: 'x' } } },
      },
    });
    should((await stat(file)).mode & 0o777).equal(0o600);
    should(await readdir(root)).deepEqual(['.claude.json']);
  });

  it('should create the file for a home that has none, and leave alone one that is not Claude’s object', async () => {
    // Arrange
    const root = await directory();
    const fresh = path.join(root, 'fresh.json');
    const array = path.join(root, 'array.json');
    const broken = path.join(root, 'broken.json');
    await writeFile(array, '[]');
    await writeFile(broken, '{oops');
    const scope = new FileClaudeLocalScope();

    // Act
    await scope.reconcile(fresh, '/p', {});
    await scope.reconcile(array, '/p', {});
    await scope.reconcile(broken, '/p', {});

    // Assert
    should(JSON.parse(await readFile(fresh, 'utf8'))).deepEqual({ projects: { '/p': { mcpServers: {} } } });
    should((await stat(fresh)).mode & 0o777).equal(0o600);
    should(await readFile(array, 'utf8')).equal('[]');
    should(await readFile(broken, 'utf8')).equal('{oops');
  });

  it('should leave no temporary file behind when the rename fails', async () => {
    // Arrange — the target is a directory, which a file cannot be renamed over.
    const root = await directory();
    const target = path.join(root, 'nested');
    await mkdir(path.join(target, 'child'), { recursive: true });
    const scope = new FileClaudeLocalScope();

    // Act
    const error = await scope.reconcile(target, '/p', {}).catch((caught: unknown) => caught);

    // Assert
    should(error).be.instanceOf(Error);
    should(await readdir(root)).deepEqual(['nested']);
  });
});
