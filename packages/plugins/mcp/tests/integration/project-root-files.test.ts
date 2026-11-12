import { afterEach, describe, expect, test } from 'bun:test';
import { symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, RootHandle, SharedTree } from '@ferretry/kernel/contract';
import { type Instant, ok } from '@ferretry/std';
import { RootMcpHarnessDocuments } from '../../daemon/adapters/harness-documents.ts';
import { mcpFileOnly, projectRootMcpFile } from '../../daemon/adapters/project-root-files.ts';
import { McpDocumentUnreadable } from '../../daemon/lib/inventory/service.ts';
import { type HostFs, nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
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
    linkCredential: async () => {
      calls.push('linkCredential');
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
    linkTo: record('linkTo'),
    setMode: record('setMode'),
    rename: record('rename'),
    unlink: record('unlink'),
    checkPrivateChain: record('checkPrivateChain'),
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

    // Assert — the read checks the leaf first, then reads that one file; the kernel's own link rule runs inside each call.
    expect(allowed.ok && (await root.readText(allowed.value))).toBe(FILES['.mcp.json']);
    expect(others.every(result => !result.ok)).toBe(true);
    expect(calls).toEqual(['resolve:.mcp.json', `lstat:${REPO}/.mcp.json`, `read:${REPO}/.mcp.json`]);
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

  test('lists, writes, copies, makes, pins, removes and moves nothing, not even .mcp.json', async () => {
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
    await expect(root.rename(file.value, file.value)).rejects.toThrow(/does not move an entry/u);
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

  test('a project root that is a link to another folder is the anchor: its .mcp.json still reads', async () => {
    // Arrange
    const calls: string[] = [];
    const documents = documentsOver(kernelRoot(REPO, FILES, calls, { realRoot: '/elsewhere/repo' }));

    // Act / Assert
    expect(await documents.read(`${REPO}/.mcp.json`, 'json')).toEqual(JSON.parse(FILES['.mcp.json']));
    expect(calls.filter(call => call.startsWith('realPath:'))).toEqual([]);
  });

  test.each<[string, FakeDisk]>([
    ['a .mcp.json the kernel refuses (a link out of the root)', { refused: ['.mcp.json'] }],
    ['a .mcp.json that is a link to a file inside the root', { links: ['.mcp.json'] }],
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

  test('a link the kernel refuses is said as a link, naming the file and nothing it points at', async () => {
    // Arrange
    const documents = documentsOver(kernelRoot(REPO, FILES, [], { refused: ['.mcp.json'] }));

    // Act / Assert
    await expect(documents.read(`${REPO}/.mcp.json`, 'json')).rejects.toThrow(
      new RegExp(`^${REPO}/\\.mcp\\.json is a link, or sits under one, that leaves the project`, 'u'),
    );
  });

  test('the reader asks the kernel for the project folder as both the scoped folder and the anchor', () => {
    // Arrange
    const asked: [string, string][] = [];
    const pick = projectRootMcpFile((folder, within) => {
      asked.push([folder, within]);
      return kernelRoot(folder, FILES, []);
    });

    // Act
    pick(`${REPO}/.mcp.json`, [`${REPO}/`]);

    // Assert
    expect(asked).toEqual([[REPO, REPO]]);
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

describe('the narrowed root hands the one .mcp.json out as bytes and as a tail, and nothing else', () => {
  test('on a temp disk readBytes and readTail answer the file it resolved, and refuse a forged path', async () => {
    // Arrange — fake JSON on a temp disk; no real home.
    const disk = await mkdtemp(join(tmpdir(), 'mcp-bytes-tail-'));
    try {
      const project = join(disk, 'work/repo');
      await mkdir(project, { recursive: true });
      await mkdir(join(disk, 'fy-home'), { recursive: true });
      await writeFile(join(project, '.mcp.json'), FILES['.mcp.json'] ?? '{}');
      await writeFile(join(project, 'other.json'), '{"fake":"not-for-mcp"}');
      const roots = rootsPortFor(
        nodeFs(() => crypto.randomUUID()),
        { home: join(disk, 'fy-home'), plugin: 'mcp', worktrees: join(disk, 'worktrees') },
        ['imports'],
        () => undefined,
      );
      const narrowed = mcpFileOnly(roots.root('imports', { subfolder: project, within: project }));
      const raw = roots.root('imports', { subfolder: project, within: project });
      const allowed = narrowed.resolve('.mcp.json');
      const otherPath = raw.resolve('other.json');
      if (!allowed.ok || !otherPath.ok) throw new Error('setup');

      // Act
      const bytes = await narrowed.readBytes(allowed.value);
      const tail = await narrowed.readTail(allowed.value, 1024);

      // Assert
      expect(new TextDecoder().decode(bytes)).toBe(FILES['.mcp.json']);
      expect(new TextDecoder().decode(tail.bytes)).toBe(FILES['.mcp.json']);
      expect(tail.size).toBe(FILES['.mcp.json'].length);
      await expect(narrowed.readBytes(otherPath.value)).rejects.toThrow(/reads only \.mcp\.json/u);
      await expect(narrowed.readTail(otherPath.value, 1024)).rejects.toThrow(/reads only \.mcp\.json/u);
    } finally {
      await rm(disk, { recursive: true, force: true });
    }
  });

  test('a missing .mcp.json is not there for readBytes and readTail either', async () => {
    // Arrange
    const narrowed = mcpFileOnly(kernelRoot(REPO, {}, []));
    const allowed = narrowed.resolve('.mcp.json');
    if (!allowed.ok) throw new Error('setup');

    // Act / Assert
    await expect(narrowed.readBytes(allowed.value)).rejects.toBeInstanceOf(McpDocumentUnreadable);
    await expect(narrowed.readTail(allowed.value, 10)).rejects.toBeInstanceOf(McpDocumentUnreadable);
  });
});

describe('R-B1 the project .mcp.json over the kernel’s real imports root on a temp disk, anchored at the project folder', () => {
  const OUTSIDE_TEXT = JSON.stringify({
    mcpServers: { stolen: { type: 'http', url: 'https://stolen.example.invalid' } },
  });
  const disks: string[] = [];
  afterEach(async () => {
    for (const disk of disks.splice(0)) await rm(disk, { recursive: true, force: true });
  });

  async function world(fs: (inner: HostFs) => HostFs = inner => inner) {
    const disk = await realpath(await mkdtemp(join(tmpdir(), 'mcp-anchor-')));
    disks.push(disk);
    const project = join(disk, 'work', 'repo');
    await mkdir(project, { recursive: true });
    await mkdir(join(disk, 'fy-home'), { recursive: true });
    await mkdir(join(disk, 'outside'), { recursive: true });
    await writeFile(join(disk, 'outside', 'mcp.json'), OUTSIDE_TEXT);
    const roots = rootsPortFor(
      fs(nodeFs(() => crypto.randomUUID())),
      { home: join(disk, 'fy-home'), plugin: 'mcp', worktrees: join(disk, 'worktrees') },
      ['imports'],
      () => undefined,
    );
    const documents = new RootMcpHarnessDocuments(
      async path =>
        projectRootMcpFile((folder, within) => roots.root('imports', { subfolder: folder, within }))(path, [
          join(disk, 'work', 'repo'),
          join(disk, 'linked-repo'),
          join(disk, 'linked-work', 'repo'),
        ]) ?? Promise.reject(new McpDocumentUnreadable(`${path} is outside every ferret folder.`)),
      text => JSON.parse(text) as unknown,
    );
    return { disk, project, documents };
  }

  test('a project folder that is a link, or sits under a linked parent, still reads its .mcp.json', async () => {
    const w = await world();
    await writeFile(join(w.project, '.mcp.json'), FILES['.mcp.json']!);
    await symlink(w.project, join(w.disk, 'linked-repo'));
    await symlink(join(w.disk, 'work'), join(w.disk, 'linked-work'));
    for (const root of [w.project, join(w.disk, 'linked-repo'), join(w.disk, 'linked-work', 'repo')])
      expect(await w.documents.read(`${root}/.mcp.json`, 'json')).toEqual(JSON.parse(FILES['.mcp.json']!));
  });

  test('a .mcp.json that is a link to a file outside the project is unreadable, and its text is never returned', async () => {
    const w = await world();
    await symlink(join(w.disk, 'outside', 'mcp.json'), join(w.project, '.mcp.json'));
    const read = w.documents.read(`${w.project}/.mcp.json`, 'json');
    await expect(read).rejects.toBeInstanceOf(McpDocumentUnreadable);
    await expect(read).rejects.not.toThrow(/stolen/u);
  });

  test('a dangling .mcp.json link is unreadable', async () => {
    const w = await world();
    await symlink(join(w.disk, 'nowhere.json'), join(w.project, '.mcp.json'));
    await expect(w.documents.read(`${w.project}/.mcp.json`, 'json')).rejects.toBeInstanceOf(McpDocumentUnreadable);
  });

  test('a .mcp.json swapped for a link to an outside file right after the adapter looked at it reads no outside text', async () => {
    let project = '';
    let swapped = false;
    const w = await world(inner => ({
      ...inner,
      lstat: async (path: string) => {
        const found = await inner.lstat(path);
        if (!swapped && path === `${project}/.mcp.json`) {
          swapped = true;
          unlinkSync(path);
          symlinkSync(join(project, '..', '..', 'outside', 'mcp.json'), path);
        }
        return found;
      },
    }));
    project = w.project;
    await writeFile(join(w.project, '.mcp.json'), FILES['.mcp.json']!);
    const read = await w.documents.read(`${w.project}/.mcp.json`, 'json').catch((error: unknown) => error);
    expect(swapped).toBe(true);
    expect(read).not.toEqual(JSON.parse(OUTSIDE_TEXT));
  });

  // ilr F3 (row 105): THE WINDOW BETWEEN THE ADAPTER'S LOOK AND THE KERNEL'S RESOLUTION. The adapter looks at the leaf
  // (`lstat`, refuses a link) and then asks the kernel to read it: two steps. The kernel's read resolves the name afresh
  // (`realpath`, the first time the host is asked about the leaf in the read) and then, once it holds the file open,
  // resolves it again to prove nothing moved. So a leaf swapped for a link INTO the project after the adapter's look and
  // before the kernel's first resolution is followed (its project target is read); one swapped after that first
  // resolution is refused (`changed`); one pointing OUT is refused in every case. The swap lands on the Nth host
  // `realpath` of the leaf; `swapped` fails the test loudly if the kernel's steps ever change.
  const swapAtResolution = async (nth: number, target: (project: string) => string) => {
    let project = '';
    let swapped = false;
    let resolutions = 0;
    const w = await world(inner => ({
      ...inner,
      realpath: async (path: string) => {
        if (path === `${project}/.mcp.json`) resolutions += 1;
        if (!swapped && path === `${project}/.mcp.json` && resolutions === nth) {
          swapped = true;
          unlinkSync(path);
          symlinkSync(target(project), path);
        }
        return await inner.realpath(path);
      },
    }));
    project = w.project;
    await writeFile(join(w.project, '.mcp.json'), FILES['.mcp.json']!);
    await writeFile(join(w.project, 'other.json'), INSIDE_TEXT);
    const read = await w.documents.read(`${w.project}/.mcp.json`, 'json').catch((error: unknown) => error);
    expect(swapped).toBe(true);
    return read;
  };
  const INSIDE_TEXT = JSON.stringify({
    mcpServers: { inside: { type: 'http', url: 'https://inside.example.invalid' } },
  });

  test('ilr F3 the named window: a .mcp.json swapped for a link to another file INSIDE the project before the kernel resolves it is followed, and only that project file is read', async () => {
    const read = await swapAtResolution(1, project => join(project, 'other.json'));
    expect(read).toEqual(JSON.parse(INSIDE_TEXT));
  });

  test('ilr F3 a .mcp.json swapped for a link after the kernel resolved it is refused as unreadable (changed), whatever it points at', async () => {
    const inside = await swapAtResolution(2, project => join(project, 'other.json'));
    expect(inside).toBeInstanceOf(McpDocumentUnreadable);
    const outside = await swapAtResolution(2, project => join(project, '..', '..', 'outside', 'mcp.json'));
    expect(outside).toBeInstanceOf(McpDocumentUnreadable);
  });

  test('ilr F3 a .mcp.json swapped for a link OUT of the project before the kernel resolves it is refused too, and its text is never returned', async () => {
    const read = await swapAtResolution(1, project => join(project, '..', '..', 'outside', 'mcp.json'));
    expect(read).toBeInstanceOf(McpDocumentUnreadable);
    expect(read).not.toEqual(JSON.parse(OUTSIDE_TEXT));
  });
});
