import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, FerretId } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { RootMcpProjectFiles } from '../../daemon/adapters/project-files.ts';
import { projectRootMcpFile } from '../../daemon/adapters/project-root-files.ts';
import { McpDocumentUnreadable } from '../../daemon/lib/inventory/service.ts';
import { SessionMcpRefusal, SessionMcpService } from '../../daemon/lib/session/service.ts';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';

/**
 * Ruling (b), on a REAL temp disk through the kernel's own `work` and `imports` roots (never a real home): a project
 * whose `.mcp.json` is a link is refused. Out of the project the kernel refuses it; to another file INSIDE the project
 * the kernel follows it, so MCP's own `lstat` must refuse it, as v4 did for any link. Nothing is read, nothing is
 * written, and no content of the target is echoed.
 */

// Valid project files, so that a link which WAS followed would read as real servers (a parse error would hide it).
const OUTSIDE = '{"mcpServers":{"outside-server-never-echoed":{"url":"https://outside.example/mcp"}}}';
const INSIDE = '{"mcpServers":{"inside-server-never-echoed":{"url":"https://inside.example/mcp"}}}';
const OUTSIDE_MARK = 'outside-server-never-echoed';
const INSIDE_MARK = 'inside-server-never-echoed';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mcp-project-files-disk-')));
  parents.push(parent);
  const project = join(parent, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(parent, 'home'), { recursive: true, mode: 0o700 });
  await mkdir(join(parent, 'outside'), { recursive: true });
  await writeFile(join(parent, 'outside', 'x.json'), OUTSIDE);
  await writeFile(join(project, 'other.json'), INSIDE);
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(parent, 'home'), plugin: 'mcp', worktrees: join(parent, 'worktrees') },
    ['work', 'imports'],
    () => ({
      folderOf: () => project as FencedPath,
      check: (_ferret, path) => (path.startsWith(project) ? ok(path as FencedPath) : err('outside')),
    }),
  );
  const files = new RootMcpProjectFiles(async () => ({
    root: roots.root('work', { ferret: 'F1' as FerretId }),
    base: project,
  }));
  const service = new SessionMcpService({
    ferrets: {
      get: async id => ({ id, harness: 'claude-code', folder: project, runtime: 'r1' }),
      list: async () => [],
    },
    projectRoots: async () => [project],
    files,
    login: {
      runtime: async () => undefined,
      profile: async () => undefined,
      hasItem: async () => false,
      putItem: async () => 'etag',
      removeItem: async () => true,
      layerProfile: async () => undefined,
    },
  });
  // As the daemon opens it: anchored at the project itself (`within`), which lets the kernel treat the anchor as a link.
  const imports = projectRootMcpFile(folder => roots.root('imports', { subfolder: folder, within: folder }));
  return { parent, project, mcpJson: join(project, '.mcp.json'), files, service, imports };
}

const ADD = {
  name: 'acme',
  server: { transport: 'url' as const, url: 'https://acme.example/mcp', oauth: false },
};

describe('R-0161 a project whose .mcp.json is a link is refused, on a real disk', () => {
  test.each([
    ['out of the project', (w: Awaited<ReturnType<typeof world>>) => join(w.parent, 'outside', 'x.json'), OUTSIDE],
    [
      'to another file inside the project',
      (w: Awaited<ReturnType<typeof world>>) => join(w.project, 'other.json'),
      INSIDE,
    ],
  ])(
    'a link %s: list, preview and add read nothing, write nothing and echo no content',
    async (_where, target, body) => {
      // Arrange
      const w = await world();
      const pointsTo = target(w);
      await symlink(pointsTo, w.mcpJson);

      // Act
      const listing = await w.service.list('F1');
      const preview = w.service.previewProject('F1', ADD).catch((error: unknown) => error);
      const add = w.service.addProject('F1', { ...ADD, etag: null }).catch((error: unknown) => error);
      const refusals = [await preview, await add];

      // Assert — the project scope is unavailable, both writes are refused, and the target is untouched.
      expect(listing.project).toBeNull();
      const mark = body === OUTSIDE ? OUTSIDE_MARK : INSIDE_MARK;
      expect(JSON.stringify(listing)).not.toContain(mark);
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(SessionMcpRefusal);
        expect((refusal as SessionMcpRefusal).code).toBe('mcp_file_unreadable');
        expect((refusal as SessionMcpRefusal).message).not.toContain(mark);
      }
      expect(await readFile(pointsTo, 'utf8')).toBe(body);
      expect(await readlink(w.mcpJson)).toBe(pointsTo);
    },
  );

  test('a plain .mcp.json is read and replaced as before', async () => {
    // Arrange
    const w = await world();
    await writeFile(w.mcpJson, '{"mcpServers":{}}\n');

    // Act
    const reading = await w.files.read('F1', w.mcpJson);
    await w.files.replace('F1', w.mcpJson, '{"mcpServers":{"a":{"url":"https://a.example"}}}\n', reading.etag);

    // Assert
    expect(reading.text).toBe('{"mcpServers":{}}\n');
    expect(await readFile(w.mcpJson, 'utf8')).toContain('"a"');
  });

  test('the inventory reader still reads a project at its real folder, anchored at itself', async () => {
    // Arrange
    const w = await world();
    await writeFile(w.mcpJson, INSIDE);
    const held = w.imports(w.mcpJson, [w.project]);

    // Act
    const resolved = held?.root.resolve('.mcp.json');
    const text = resolved?.ok === true ? await held?.root.readText(resolved.value) : undefined;

    // Assert
    expect(text).toBe(INSIDE);
  });

  test('a project registered THROUGH a link is read (v4 parity): only what lies BELOW the root is fenced', async () => {
    // Arrange
    const w = await world();
    await writeFile(w.mcpJson, INSIDE);
    const linked = join(w.parent, 'linked-workspace');
    await symlink(w.project, linked);
    const held = w.imports(join(linked, '.mcp.json'), [linked]);

    // Act
    const resolved = held?.root.resolve('.mcp.json');
    const read = resolved?.ok === true ? held?.root.readText(resolved.value) : undefined;

    // Assert
    expect(read).toBeDefined();
    expect(await read).toBe(INSIDE);
  });

  test('the inventory reader (imports root) reads nothing through a link out of the project or inside it', async () => {
    for (const [target, body] of [
      ['outside/x.json', OUTSIDE],
      ['project/other.json', INSIDE],
    ] as const) {
      // Arrange
      const w = await world();
      await symlink(join(w.parent, target), w.mcpJson);
      const held = w.imports(w.mcpJson, [w.project]);

      // Act
      const resolved = held?.root.resolve('.mcp.json');
      const read = resolved?.ok === true ? held?.root.readText(resolved.value) : undefined;

      // Assert
      expect(read).toBeDefined();
      const refusal = await read?.catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(McpDocumentUnreadable);
      expect((refusal as Error).message).not.toContain(body === OUTSIDE ? OUTSIDE_MARK : INSIDE_MARK);
    }
  });
});
