import { describe, expect, test } from 'bun:test';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { type Instant, ok } from '@ferretry/std';
import { RootMcpHarnessDocuments } from '../../daemon/adapters/harness-documents.ts';
import { mcpFileOnly, projectRootMcpFile } from '../../daemon/adapters/project-root-files.ts';
import { McpDocumentUnreadable } from '../../daemon/lib/inventory/service.ts';

/**
 * Lead ruling (B): at a registered project root (or a live managed worktree) MCP reads `.mcp.json` and nothing else —
 * read-only, no listing — through the kernel's `imports` root scoped to that folder. Fake handles in memory; no disk.
 */

const REPO = '/work/repo';

/** A kernel root handle over `files`, recording every call made on it. */
function kernelRoot(base: string, files: Readonly<Record<string, string>>, calls: string[]): RootHandle {
  const at = (path: FencedPath) => files[path.slice(base.length + 1)];
  return {
    name: 'imports',
    resolve: relative => {
      calls.push(`resolve:${relative}`);
      return ok(`${base}/${relative}` as FencedPath);
    },
    stat: async path => {
      calls.push(`stat:${path}`);
      const text = at(path);
      return text === undefined
        ? undefined
        : { kind: 'file', size: text.length, modified: '2026-11-07T09:00:00.000Z' as Instant };
    },
    readText: async path => {
      calls.push(`read:${path}`);
      return at(path) ?? '';
    },
    readBytes: async path => {
      calls.push(`bytes:${path}`);
      return new Uint8Array();
    },
    writeText: async path => {
      calls.push(`write:${path}`);
    },
    list: async path => {
      calls.push(`list:${path}`);
      return Object.keys(files);
    },
    remove: async path => {
      calls.push(`remove:${path}`);
    },
  };
}

const FILES = {
  '.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.invalid/mcp' } } }),
  'secret.json': JSON.stringify({ token: 'fake-not-a-real-value' }),
};

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

    // Assert
    expect(allowed.ok && (await root.readText(allowed.value))).toBe(FILES['.mcp.json']);
    expect(others.every(result => !result.ok)).toBe(true);
    expect(calls).toEqual(['resolve:.mcp.json', `read:${REPO}/.mcp.json`]);
  });

  test('a path it did not answer (a forged FencedPath) is refused for read, bytes and stat', async () => {
    // Arrange
    const calls: string[] = [];
    const root = mcpFileOnly(kernelRoot(REPO, FILES, calls));
    root.resolve('.mcp.json');
    const forged = `${REPO}/secret.json` as FencedPath;

    // Act / Assert
    await expect(root.readText(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    await expect(root.readBytes(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    await expect(root.stat(forged)).rejects.toThrow(/reads only \.mcp\.json/u);
    expect(calls).toEqual(['resolve:.mcp.json']);
  });

  test('lists, writes and removes nothing, not even .mcp.json', async () => {
    // Arrange
    const calls: string[] = [];
    const root = mcpFileOnly(kernelRoot(REPO, FILES, calls));
    const file = root.resolve('.mcp.json');
    if (!file.ok) throw new Error('setup');

    // Act / Assert
    await expect(root.list(file.value)).rejects.toThrow(/does not list/u);
    await expect(root.writeText(file.value, '{}')).rejects.toThrow(/does not write/u);
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
    const pick = projectRootMcpFile(folder => kernelRoot(folder, FILES, calls));
    const documents = new RootMcpHarnessDocuments(
      async path =>
        pick(path, [REPO]) ??
        Promise.reject(
          new McpDocumentUnreadable(`${path} is outside every ferret folder, so Ferretry will not read it.`),
        ),
      text => JSON.parse(text) as unknown,
    );

    // Act
    const declared = await documents.read(`${REPO}/.mcp.json`, 'json');
    const other = documents.read(`${REPO}/secret.json`, 'json');

    // Assert
    expect(declared).toEqual(JSON.parse(FILES['.mcp.json']));
    await expect(other).rejects.toBeInstanceOf(McpDocumentUnreadable);
    expect(calls.filter(call => call.includes('secret'))).toEqual([]);
  });

  test('a root the kernel refuses (a .mcp.json linked out of the root) is unreadable, quoting nothing', async () => {
    // Arrange
    const refusing: RootHandle = {
      ...kernelRoot(REPO, FILES, []),
      stat: async () => {
        throw Object.assign(new Error('root refused: link_escape'), { refusal: 'link_escape' });
      },
    };
    const documents = new RootMcpHarnessDocuments(
      async path => projectRootMcpFile(() => refusing)(path, [REPO]) ?? Promise.reject(new Error('unexpected')),
      text => JSON.parse(text) as unknown,
    );

    // Act
    const read = documents.read(`${REPO}/.mcp.json`, 'json');

    // Assert
    await expect(read).rejects.toBeInstanceOf(McpDocumentUnreadable);
    await expect(read).rejects.not.toThrow(/docs\.example/u);
  });
});
