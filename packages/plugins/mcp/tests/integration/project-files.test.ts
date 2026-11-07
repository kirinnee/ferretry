/**
 * A project's `.mcp.json` over a real temporary directory: no file, a file whose other keys must
 * survive, a file that changed after the preview, a link planted where the file should be, and the
 * permission bits a replacement must keep.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileMcpProjectFiles } from '../../../src/adapters/session-mcp/project-files.ts';
import { McpProjectFileError } from '../../../src/lib/session-mcp/project-file.ts';
import { McpProjectFileChanged } from '../../../src/lib/session-mcp/service.ts';

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-mcp-project-'));
  roots.push(root);
  return root;
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

describe('a project .mcp.json on disk', () => {
  it('should read no file as no text and no etag, and create one readable by the checkout', async () => {
    // Arrange
    const root = await project();
    const file = path.join(root, '.mcp.json');
    const files = new FileMcpProjectFiles();

    // Act
    const before = await files.read(file);
    const etag = await files.replace(file, '{"mcpServers":{}}\n', null);

    // Assert
    should(before).deepEqual({ text: null, etag: null });
    should(etag).equal(sha256('{"mcpServers":{}}\n'));
    should(await files.read(file)).deepEqual({ text: '{"mcpServers":{}}\n', etag });
    should((await stat(file)).mode & 0o777).equal(0o644);
    should(await readdir(root)).deepEqual(['.mcp.json']);
  });

  it('should replace an existing file against its etag, keeping its mode exactly', async () => {
    // Arrange
    const root = await project();
    const file = path.join(root, '.mcp.json');
    const original = '{"keep":true,"mcpServers":{"old":{"command":"o"}}}';
    await writeFile(file, original);
    await chmod(file, 0o600);
    const files = new FileMcpProjectFiles();
    const reading = await files.read(file);

    // Act
    const next = '{"keep":true,"mcpServers":{"old":{"command":"o"},"new":{"command":"n"}}}\n';
    const etag = await files.replace(file, next, reading.etag);

    // Assert
    should(reading.etag).equal(sha256(original));
    should(await readFile(file, 'utf8')).equal(next);
    should(etag).equal(sha256(next));
    should((await stat(file)).mode & 0o777).equal(0o600);
    should(await readdir(root)).deepEqual(['.mcp.json']);
  });

  it('should refuse a write whose etag no longer matches, and leave the file alone', async () => {
    // Arrange
    const root = await project();
    const file = path.join(root, '.mcp.json');
    await writeFile(file, '{"a":1}');
    const files = new FileMcpProjectFiles();
    const stale = (await files.read(file)).etag;
    await writeFile(file, '{"a":2}');

    // Act
    const changed = await failure(files.replace(file, '{"b":1}', stale));
    const appeared = await failure(files.replace(file, '{"b":1}', null));

    // Assert
    should(changed).be.instanceOf(McpProjectFileChanged);
    should(appeared).be.instanceOf(McpProjectFileChanged);
    should(await readFile(file, 'utf8')).equal('{"a":2}');
    should(await readdir(root)).deepEqual(['.mcp.json']);
  });

  it('should refuse a first add when a file appears between the check and the swap', async () => {
    // Arrange — the temporary name is drawn after the check, so a file written then is the race.
    const root = await project();
    const file = path.join(root, '.mcp.json');
    let racer = 0;
    const files = new FileMcpProjectFiles(() => {
      racer += 1;
      Bun.spawnSync(['sh', '-c', `printf '{"theirs":1}' > "$1"`, 'sh', file]);
      return `race-${racer}`;
    });

    // Act
    const raced = await failure(files.replace(file, '{"mine":1}', null));

    // Assert
    should(raced).be.instanceOf(McpProjectFileChanged);
    should(await readFile(file, 'utf8')).equal('{"theirs":1}');
    should(await readdir(root)).deepEqual(['.mcp.json']);
  });

  it('should let a failure to write the new file through', async () => {
    // Arrange — a folder that does not exist: there is no file to compare, and nowhere to write one.
    const root = await project();
    const file = path.join(root, 'missing', '.mcp.json');

    // Act
    const thrown = await failure(new FileMcpProjectFiles().replace(file, '{}', null));

    // Assert
    should(thrown).not.be.instanceOf(McpProjectFileChanged);
    should((thrown as NodeJS.ErrnoException).code).equal('ENOENT');
  });

  it('should refuse a symbolic link rather than follow it out of the project', async () => {
    // Arrange
    const root = await project();
    const outside = await project();
    const target = path.join(outside, 'elsewhere.json');
    await writeFile(target, '{"outside":true}');
    const file = path.join(root, '.mcp.json');
    await symlink(target, file);
    const files = new FileMcpProjectFiles();

    // Act
    const read = await failure(files.read(file));
    const write = await failure(files.replace(file, '{}', sha256('{"outside":true}')));

    // Assert
    should(read).be.instanceOf(McpProjectFileError);
    should((read as Error).message).match(/is a symbolic link, and Ferretry will not follow it out of the project/u);
    should(write).be.instanceOf(McpProjectFileError);
    should(await readFile(target, 'utf8')).equal('{"outside":true}');
    should((await lstat(file)).isSymbolicLink()).be.true();
  });

  it('should refuse something that is not a regular file, and one too large to be a real project file', async () => {
    // Arrange
    const root = await project();
    const directory = path.join(root, 'dir', '.mcp.json');
    await mkdir(directory, { recursive: true });
    const large = path.join(root, '.mcp.json');
    await writeFile(large, 'x'.repeat(1024 * 1024 + 1));
    const files = new FileMcpProjectFiles();

    // Act
    const notFile = await failure(files.read(directory));
    const tooLarge = await failure(files.read(large));

    // Assert
    should(notFile).be.instanceOf(McpProjectFileError);
    should((notFile as Error).message).match(/is not a regular file/u);
    should(tooLarge).be.instanceOf(McpProjectFileError);
    should((tooLarge as Error).message).match(/larger than 1 MiB/u);
  });

  it('should let a failure that is not about the file through', async () => {
    // Arrange — a path through a regular file cannot be opened at all.
    const root = await project();
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, '');

    // Act
    const thrown = await failure(new FileMcpProjectFiles().read(path.join(blocker, '.mcp.json')));

    // Assert
    should((thrown as NodeJS.ErrnoException).code).equal('ENOTDIR');
  });
});
