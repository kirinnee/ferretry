import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, RootHandle, SharedTree } from '@ferretry/kernel/contract';
import { type Instant, ok } from '@ferretry/std';
import { RootMcpHarnessDocuments } from '../../daemon/adapters/harness-documents.ts';
import { mcpFileOnly, projectRootMcpFile } from '../../daemon/adapters/project-root-files.ts';
import { McpDocumentUnreadable } from '../../daemon/lib/inventory/service.ts';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';

/**
 * Lead ruling (B): at a registered project root (or a live managed worktree) MCP reads `.mcp.json` and nothing else —
 * read-only, no listing, never through a link — through the kernel's `imports` root scoped to that folder. Fake
 * handles in memory; no disk.
 */

const REPO = '/work/repo';
const MODIFIED = '2026-11-07T09:00:00.000Z' as Instant;

interface FakeDisk {
  /** Names at the root that are links (the kernel follows a link that stays inside; `lstat` says `symlink`). */
  readonly links?: readonly string[];
  /** The root folder's real path, when it is a link. */
  readonly realRoot?: string;
  /** Every operation on these names is what the kernel refuses (a link out of the root): as `RootError`. */
  readonly refused?: readonly string[];
}

/** A kernel root handle over `files`, recording every call made on it. */
function kernelRoot(
  base: string,
  files: Readonly<Record<string, string>>,
  calls: string[],
  disk: FakeDisk = {},
): RootHandle {
  const name = (path: FencedPath) => path.slice(base.length + 1);
  const at = (path: FencedPath) => {
    if ((disk.refused ?? []).includes(name(path)))
      throw Object.assign(new Error('root refused: link_escape'), { refusal: 'link_escape' });
    return files[name(path)];
  };
  const record =
    (call: string) =>
    async (path: FencedPath): Promise<never> => {
      calls.push(`${call}:${path}`);
      throw new Error(`the fixture has no ${call}`);
    };
  return {
    name: 'imports',
    internal: false,
    resolve: relative => {
      calls.push(`resolve:${relative}`);
      return ok((relative === '' ? base : `${base}/${relative}`) as FencedPath);
    },
    stat: async path => {
      calls.push(`stat:${path}`);
      const text = at(path);
      return text === undefined
        ? undefined
        : { kind: 'file', size: text.length, modified: MODIFIED, mode: 0o644, links: 1 };
    },
    lstat: async path => {
      calls.push(`lstat:${path}`);
      const text = at(path);
      if (text === undefined) return undefined;
      const kind = (disk.links ?? []).includes(name(path)) ? 'symlink' : 'file';
      return { kind, size: text.length, modified: MODIFIED, mode: 0o644, links: 1 };
    },
    realPath: async path => {
      calls.push(`realPath:${path}`);
      return (path === base && disk.realRoot !== undefined ? disk.realRoot : path) as FencedPath;
    },
    readText: async path => {
      calls.push(`read:${path}`);
      return at(path) ?? '';
    },
    readBytes: record('bytes'),
    readTail: record('tail'),
    writeText: record('write'),
    writeBytes: record('writeBytes'),
    copyTree: async () => {
      calls.push('copyTree');
    },
    copyShared: async () => {
      calls.push('copyShared');
      return 'copied';
    },
    ensurePrivateDirectory: record('ensurePrivateDirectory'),
    makeDirectory: record('makeDirectory'),
    list: record('list'),
    entries: record('entries'),
    pin: record('pin'),
    publish: record('publish'),
    readDurable: record('readDurable'),
    syncDirectory: record('syncDirectory'),
    fileIdentity: record('fileIdentity'),
    remove: record('remove'),
  };
}

const FILES = {
  '.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.invalid/mcp' } } }),
  'secret.json': JSON.stringify({ token: 'fake-not-a-real-value' }),
};

/** The documents reader as the daemon half wires it for a known root: anything else is refused. */
const documentsOver = (root: RootHandle) =>
  new RootMcpHarnessDocuments(
    async path =>
      projectRootMcpFile(() => root)(path, [REPO]) ??
      Promise.reject(
        new McpDocumentUnreadable(`${path} is outside every ferret folder, so Ferretry will not read it.`),
      ),
    text => JSON.parse(text) as unknown,
  );

describe('mcpFileOnly: a kernel root narrowed to the one .mcp.json', () => {
  test('answers .mcp.json, and refuses every other name before the kernel is asked', async () => {
    // Arrange
    const calls: string[] = [];
    const root = mcpFileOnly(kernelRoot(REPO, FILES, calls));

    // Act
    const allowed = root.resolve('.mcp.json');
    const others = ['secret.json', 'sub/.mcp.json', '../.mcp.json', '', '.', '.mcp.json/x'].map(name =>
      root.resolve(name),
    );

    // Assert — the read checks the leaf and the root's real path first, then reads that one file.
    expect(allowed.ok && (await root.readText(allowed.value))).toBe(FILES['.mcp.json']);
    expect(others.every(result => !result.ok)).toBe(true);
    expect(calls).toEqual([
      'resolve:.mcp.json',
      `lstat:${REPO}/.mcp.json`,
      'resolve:',
      `realPath:${REPO}`,
      `read:${REPO}/.mcp.json`,
    ]);
  });

  test('a path it did not answer (a forged FencedPath) is refused for read, bytes, tail, stat and lstat', async () => {
    // Arrange
    const calls: string[] = [];
    const root = mcpFileOnly(kernelRoot(REPO, FILES, calls));
    root.resolve('.mcp.json');
    const forged = `${REPO}/secret.json` as FencedPath;

    // Act / Assert
    await expect(root.readText(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    await expect(root.readBytes(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    await expect(root.readTail(forged, 10)).rejects.toThrow(/reads only \.mcp\.json/u);
    await expect(root.stat(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    await expect(root.lstat(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    expect(calls).toEqual(['resolve:.mcp.json']);
  });

  test('lists, writes, copies, makes, pins and removes nothing, not even .mcp.json', async () => {
    // Arrange
    const calls: string[] = [];
    const source = kernelRoot(REPO, FILES, calls);
    const root = mcpFileOnly(source);
    const file = root.resolve('.mcp.json');
    if (!file.ok) throw new Error('setup');

    // Act / Assert
    await expect(root.list(file.value)).rejects.toThrow(/does not list/u);
    await expect(root.entries(file.value)).rejects.toThrow(/does not list/u);
    await expect(root.writeText(file.value, '{}')).rejects.toThrow(/does not write/u);
    await expect(root.writeBytes(file.value, new Uint8Array())).rejects.toThrow(/does not write/u);
    await expect(root.copyTree(source, file.value, file.value)).rejects.toThrow(/does not copy/u);
    await expect(root.copyShared({} as SharedTree, file.value)).rejects.toThrow(/does not copy/u);
    await expect(root.makeDirectory(file.value)).rejects.toThrow(/does not make a folder/u);
    await expect(root.ensurePrivateDirectory(file.value)).rejects.toThrow(/does not make a folder/u);
    await expect(root.pin(file.value)).rejects.toThrow(/does not hold a folder open/u);
    await expect(root.realPath(file.value)).rejects.toThrow(/does not resolve a path/u);
    await expect(root.remove(file.value)).rejects.toThrow(/does not remove/u);
    expect(calls).toEqual(['resolve:.mcp.json']);
  });
});

describe('projectRootMcpFile: which reads go to a known root', () => {
  test('only <known root>/.mcp.json is handed a root, scoped to exactly that root', () => {
    // Arrange
    const opened: string[] = [];
    const pick = projectRootMcpFile(folder => {
      opened.push(folder);
      return kernelRoot(folder, FILES, []);
    });
    const known = [REPO, '/fy-home-worktrees/repo-feature/'];

    // Act
    const hits = [`${REPO}/.mcp.json`, '/fy-home-worktrees/repo-feature/.mcp.json'].map(path => pick(path, known));
    const misses = [
      `${REPO}/secret.json`,
      `${REPO}/sub/.mcp.json`,
      '/work/repo2/.mcp.json',
      '/work/.mcp.json',
      '/.mcp.json',
    ].map(path => pick(path, [...known, '/', 'relative']));

    // Assert
    expect(hits.map(hit => hit?.base)).toEqual([REPO, '/fy-home-worktrees/repo-feature']);
    expect(misses).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(opened).toEqual([REPO, '/fy-home-worktrees/repo-feature']);
  });

  test('through the documents reader: the root’s .mcp.json reads; any other file under the root is refused', async () => {
    // Arrange — no ferret folder holds REPO, so anything not handed a project root is refused.
    const calls: string[] = [];
    const documents = documentsOver(kernelRoot(REPO, FILES, calls));

    // Act
    const declared = await documents.read(`${REPO}/.mcp.json`, 'json');
    const other = documents.read(`${REPO}/secret.json`, 'json');

    // Assert
    expect(declared).toEqual(JSON.parse(FILES['.mcp.json']));
    await expect(other).rejects.toBeInstanceOf(McpDocumentUnreadable);
    expect(calls.filter(call => call.includes('secret'))).toEqual([]);
  });

  test('a missing .mcp.json is no document, read from nowhere', async () => {
    // Arrange
    const calls: string[] = [];
    const documents = documentsOver(kernelRoot(REPO, {}, calls));

    // Act / Assert
    expect(await documents.read(`${REPO}/.mcp.json`, 'json')).toBeNull();
    expect(calls.filter(call => call.startsWith('read:'))).toEqual([]);
  });

  test.each<[string, FakeDisk]>([
    ['a .mcp.json the kernel refuses (a link out of the root)', { refused: ['.mcp.json'] }],
    ['a .mcp.json that is a link to a file inside the root', { links: ['.mcp.json'] }],
    ['a project root that is a link to another folder', { realRoot: '/elsewhere/repo' }],
  ])('%s is unreadable: never read, and nothing quoted', async (_what, disk) => {
    // Arrange
    const calls: string[] = [];
    const documents = documentsOver(kernelRoot(REPO, FILES, calls, disk));

    // Act
    const read = documents.read(`${REPO}/.mcp.json`, 'json');

    // Assert
    await expect(read).rejects.toBeInstanceOf(McpDocumentUnreadable);
    await expect(read).rejects.not.toThrow(/docs\.example/u);
    expect(calls.filter(call => call.startsWith('read:'))).toEqual([]);
  });
});

describe('GAP (declared): the imports narrowing is MCP-adapter-enforced, not kernel-enforced', () => {
  test('on the real kernel a raw imports root reads any name, and MCP’s adapter refuses every name but .mcp.json', async () => {
    // Arrange — a temp disk: a project with a fake .claude.json beside its .mcp.json (fake JSON, no real home).
    const disk = await mkdtemp(join(tmpdir(), 'mcp-imports-gap-'));
    try {
      const project = join(disk, 'work/repo');
      await mkdir(project, { recursive: true });
      await mkdir(join(disk, 'fy-home'), { recursive: true });
      await writeFile(join(project, '.mcp.json'), FILES['.mcp.json'] ?? '{}');
      await writeFile(join(project, '.claude.json'), '{"fake":"not-for-mcp"}');
      const roots = rootsPortFor(
        nodeFs(() => crypto.randomUUID()),
        { home: join(disk, 'fy-home'), plugin: 'mcp', worktrees: join(disk, 'worktrees') },
        ['work', 'imports'],
        () => undefined,
      );
      const raw = roots.root('imports', { subfolder: project });
      const narrowed = mcpFileOnly(roots.root('imports', { subfolder: project }));

      // Act
      const rawPath = raw.resolve('.claude.json');
      const narrowedPath = narrowed.resolve('.claude.json');
      const allowed = narrowed.resolve('.mcp.json');

      // Assert — the kernel alone hands the other file over (the gap) …
      expect(rawPath.ok && (await raw.readText(rawPath.value))).toBe('{"fake":"not-for-mcp"}');
      // … MCP's adapter refuses the name, and a forged path to it, before the kernel is asked …
      expect(narrowedPath.ok).toBe(false);
      if (rawPath.ok) await expect(narrowed.readText(rawPath.value)).rejects.toThrow(/reads only \.mcp\.json/u);
      // … and still reads the one file it is for.
      expect(allowed.ok && (await narrowed.readText(allowed.value))).toBe(FILES['.mcp.json']);
    } finally {
      await rm(disk, { recursive: true, force: true });
    }
  });
});
