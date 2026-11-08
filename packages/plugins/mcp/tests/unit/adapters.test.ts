import { describe, expect, test } from 'bun:test';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { RootMcpHarnessDocuments, unreadableDocument } from '../../daemon/adapters/harness-documents.ts';
import { RootMcpProjectFiles } from '../../daemon/adapters/project-files.ts';
import { McpDocumentUnreadable } from '../../daemon/lib/inventory/service.ts';
import { McpProjectFileError } from '../../daemon/lib/session/project-file.ts';
import { McpProjectFileChanged } from '../../daemon/lib/session/service.ts';

/** A root handle over a map of absolute path -> text. `outside` prefixes refuse; `dirs` are directories. */
function memoryRoot(
  files: Record<string, string>,
  options: { readonly outside?: readonly string[]; readonly dirs?: readonly string[] } = {},
): RootHandle & { readonly files: Record<string, string> } {
  const outside = options.outside ?? [];
  const handle: RootHandle = {
    name: 'work',
    internal: false,
    resolve: given => {
      const absolute = given === '' ? '/w' : `/w/${given}`;
      return outside.some(prefix => absolute === prefix || absolute.startsWith(`${prefix}/`))
        ? err('link_escape')
        : ok(absolute as FencedPath);
    },
    readText: async path => files[path] ?? '',
    readBytes: async path => new TextEncoder().encode(files[path] ?? ''),
    writeText: async (path, text) => {
      files[path] = text;
    },
    list: async () => [],
    stat: async path =>
      path in files
        ? {
            kind: 'file' as const,
            size: files[path]!.length,
            modified: '2026-01-01T00:00:00Z' as never,
            mode: 0o600,
            links: 1,
          }
        : (options.dirs ?? []).includes(path)
          ? { kind: 'directory' as const, size: 0, modified: '2026-01-01T00:00:00Z' as never, mode: 0o600, links: 1 }
          : undefined,
    remove: async () => undefined,
    readTail: () => Promise.reject(new Error('the fixture has no readTail')),
    writeBytes: () => Promise.reject(new Error('the fixture has no writeBytes')),
    copyTree: () => Promise.reject(new Error('the fixture has no copyTree')),
    ensurePrivateDirectory: () => Promise.reject(new Error('the fixture has no ensurePrivateDirectory')),
    entries: () => Promise.reject(new Error('the fixture has no entries')),
    lstat: () => Promise.reject(new Error('the fixture has no lstat')),
    makeDirectory: () => Promise.reject(new Error('the fixture has no makeDirectory')),
    realPath: () => Promise.reject(new Error('the fixture has no realPath')),
    pin: () => Promise.reject(new Error('the fixture has no pin')),
    publish: () => Promise.reject(new Error('the fixture has no publish')),
    readDurable: () => Promise.reject(new Error('the fixture has no readDurable')),
    syncDirectory: () => Promise.reject(new Error('the fixture has no syncDirectory')),
    fileIdentity: () => Promise.reject(new Error('the fixture has no fileIdentity')),
  };
  return Object.assign(handle, { files });
}

describe('RootMcpProjectFiles', () => {
  test('reads no file as no text and no etag, then creates it and answers the new etag', async () => {
    const root = memoryRoot({});
    const files = new RootMcpProjectFiles(async () => ({ root, base: '/w' }));

    expect(await files.read('f1', '/w/.mcp.json')).toEqual({ text: null, etag: null });
    const etag = await files.replace('f1', '/w/.mcp.json', '{}\n', null);

    expect(root.files['/w/.mcp.json']).toBe('{}\n');
    expect((await files.read('f1', '/w/.mcp.json')).etag).toBe(etag);
    expect(etag).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('refuses a write whose etag no longer matches, and leaves the file alone', async () => {
    const root = memoryRoot({ '/w/.mcp.json': 'one' });
    const files = new RootMcpProjectFiles(async () => ({ root, base: '/w' }));

    await expect(files.replace('f1', '/w/.mcp.json', 'two', 'e'.repeat(64))).rejects.toBeInstanceOf(
      McpProjectFileChanged,
    );
    await expect(files.replace('f1', '/w/.mcp.json', 'two', null)).rejects.toBeInstanceOf(McpProjectFileChanged);
    expect(root.files['/w/.mcp.json']).toBe('one');
  });

  test('refuses a path that leaves the ferret folder, something that is not a file, and one too large', async () => {
    const root = memoryRoot(
      { '/w/big/.mcp.json': 'x'.repeat(1024 * 1024 + 1) },
      { outside: ['/w/out'], dirs: ['/w/dir'] },
    );
    const files = new RootMcpProjectFiles(async () => ({ root, base: '/w' }));

    await expect(files.read('f1', '/w/out/.mcp.json')).rejects.toBeInstanceOf(McpProjectFileError);
    await expect(files.read('f1', '/w/dir')).rejects.toBeInstanceOf(McpProjectFileError);
    await expect(files.read('f1', '/w/big/.mcp.json')).rejects.toMatchObject({
      message: expect.stringContaining('1 MiB'),
    });
    await expect(files.replace('f1', '/w/out/.mcp.json', 'x', null)).rejects.toBeInstanceOf(McpProjectFileError);
  });
});

describe('RootMcpHarnessDocuments', () => {
  const parse = (text: string, format: 'json' | 'toml'): unknown => {
    if (format === 'toml') throw new Error('no toml here');
    return JSON.parse(text);
  };

  test('parses a document, and reads a missing or empty file as not there', async () => {
    const root = memoryRoot({ '/w/.mcp.json': '{"mcpServers":{}}', '/w/empty.json': '  \n' });
    const documents = new RootMcpHarnessDocuments(() => ({ root, base: '/w' }), parse);

    expect(await documents.read('/w/.mcp.json', 'json')).toEqual({ mcpServers: {} });
    expect(await documents.read('/w/empty.json', 'json')).toBeNull();
    expect(await documents.read('/w/missing.json', 'json')).toBeNull();
  });

  test('says a document does not parse without quoting it, and refuses a directory or a path outside the root', async () => {
    const root = memoryRoot(
      { '/w/bad.json': '{"env":{"KEY":"sk-live-SECRET"}, oops' },
      { outside: ['/w/out'], dirs: ['/w/dir'] },
    );
    const documents = new RootMcpHarnessDocuments(() => ({ root, base: '/w' }), parse);

    const broken = await documents.read('/w/bad.json', 'json').catch((error: unknown) => error);
    expect(broken).toBeInstanceOf(McpDocumentUnreadable);
    expect((broken as Error).message).toBe('/w/bad.json is not valid JSON, so its MCP servers cannot be read.');
    expect((broken as Error).message).not.toContain('sk-live');
    await expect(documents.read('/w/dir', 'json')).rejects.toBeInstanceOf(McpDocumentUnreadable);
    await expect(documents.read('/w/out/.mcp.json', 'json')).rejects.toBeInstanceOf(McpDocumentUnreadable);
  });
});

describe('unreadableDocument', () => {
  const failure = (code: string): Error => Object.assign(new Error(`${code}: raw text with /secret/path`), { code });

  test('says a permission refusal by path, and that macOS may need to allow the folder on EPERM', () => {
    const denied = unreadableDocument('/work/pe/.mcp.json', failure('EACCES'));
    const refused = unreadableDocument('/work/pe/.mcp.json', failure('EPERM'));

    expect(denied.message).toBe('/work/pe/.mcp.json cannot be read by the daemon.');
    expect(refused.message).toContain('Full Disk Access');
    expect(refused.message).not.toContain('/secret/path');
  });

  test('names any other cause by its code, never by the operating system text, and keeps a finished refusal', () => {
    const already = new McpDocumentUnreadable('/a is not a regular file.');

    expect(unreadableDocument('/a', failure('EIO')).message).toBe('/a could not be read (EIO).');
    expect(unreadableDocument('/a', new Error('odd')).message).toBe('/a could not be read.');
    expect(unreadableDocument('/a', already)).toBe(already);
  });
});
