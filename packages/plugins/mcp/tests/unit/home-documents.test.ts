import { describe, expect, test } from 'bun:test';
import {
  type RuntimeHome,
  type RuntimeHomeDocument,
  type RuntimeHomeReader,
  RuntimeHomeUnreadable,
  type RuntimeId,
} from '@ferretry/plugin-runtimes/contract';
import { PublishedHomeDocuments, type PublishedHomes } from '../../daemon/lib/inventory/home-documents.ts';
import { McpDocumentUnreadable, type McpHarnessDocuments } from '../../daemon/lib/inventory/service.ts';

const HOME: RuntimeHome = {
  id: 'a',
  harness: 'claude-code',
  runtimes: ['one' as RuntimeId],
  home: '/fleet/homes/a/',
  wrapper: '/w/a',
};
const parse = (text: string, format: 'json' | 'toml'): unknown => {
  if (format === 'toml') throw new Error('toml has "sk-secret-value" in it');
  return JSON.parse(text) as unknown;
};

/** The reader answers `answer` for every document and records what it was asked. */
function setup(answer: () => Promise<string | null>, listed: readonly RuntimeHome[] = [HOME], withReader = true) {
  const asked: { file: RuntimeHomeDocument; limit: number }[] = [];
  const reader = {
    document: async (file: RuntimeHomeDocument, limit: number) => {
      asked.push({ file, limit });
      return await answer();
    },
  } as unknown as RuntimeHomeReader;
  const published: PublishedHomes = { homes: async () => listed, home: () => (withReader ? reader : undefined) };
  const fell: string[] = [];
  const fallback: McpHarnessDocuments = {
    read: async path => {
      fell.push(path);
      return 'fallback';
    },
  };
  return { documents: new PublishedHomeDocuments(() => published, parse, fallback), asked, fell, fallback };
}

describe('documents of a published runtime home', () => {
  test('a document named exactly under a published home is read through its reader, bounded, and parsed', async () => {
    const { documents, asked, fell } = setup(async () => '{"mcpServers":{}}');
    expect(await documents.read('/fleet/homes/a/.claude.json', 'json')).toEqual({ mcpServers: {} });
    expect(asked).toEqual([{ file: '.claude.json', limit: 16 * 1024 * 1024 }]);
    expect(fell).toEqual([]);
  });

  test('absent and blank documents are null', async () => {
    expect(await setup(async () => null).documents.read('/fleet/homes/a/settings.json', 'json')).toBeNull();
    expect(await setup(async () => '  \n').documents.read('/fleet/homes/a/settings.json', 'json')).toBeNull();
  });

  test('any other path, name or home is read as before, never through a home reader', async () => {
    const { documents, asked, fell } = setup(async () => '{}');
    for (const path of [
      '/fleet/homes/a/credentials.json',
      '/fleet/homes/a/skills/x/.claude.json',
      '/fleet/homes/other/.claude.json',
      '/work/app/.mcp.json',
      '.claude.json',
    ])
      expect(await documents.read(path, 'json')).toBe('fallback');
    expect(asked).toEqual([]);
    expect(fell).toHaveLength(5);
  });

  test('with Runtimes off every path is read as before', async () => {
    const fell: string[] = [];
    const documents = new PublishedHomeDocuments(() => undefined, parse, {
      read: async path => {
        fell.push(path);
        return null;
      },
    });
    await documents.read('/fleet/homes/a/.claude.json', 'json');
    expect(fell).toEqual(['/fleet/homes/a/.claude.json']);
  });

  test('a home that stopped being published is refused in words', async () => {
    const { documents } = setup(async () => '{}', [HOME], false);
    await expect(documents.read('/fleet/homes/a/.claude.json', 'json')).rejects.toThrow(
      '/fleet/homes/a/.claude.json is no longer a published runtime home.',
    );
  });

  test('a refused read keeps the reader’s sentence; any other failure names the path and no cause', async () => {
    const refused = setup(async () => Promise.reject(new RuntimeHomeUnreadable('the file is a link')));
    await expect(refused.documents.read('/fleet/homes/a/.claude.json', 'json')).rejects.toMatchObject({
      name: 'McpDocumentUnreadable',
      message: 'the file is a link',
    });
    const broken = setup(async () => Promise.reject(new Error('EIO at /secret/place')));
    const error = await broken.documents.read('/fleet/homes/a/.claude.json', 'json').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpDocumentUnreadable);
    expect((error as Error).message).toBe('/fleet/homes/a/.claude.json could not be read.');
  });

  test('a document that does not parse says what it is and quotes none of it', async () => {
    const { documents } = setup(async () => 'not json "sk-secret-value"');
    const error = await documents.read('/fleet/homes/a/config.toml', 'toml').catch((cause: unknown) => cause);
    expect((error as Error).message).toBe(
      '/fleet/homes/a/config.toml is not valid TOML, so its MCP servers cannot be read.',
    );
    const json = await documents.read('/fleet/homes/a/.claude.json', 'json').catch((cause: unknown) => cause);
    expect((json as Error).message).toBe(
      '/fleet/homes/a/.claude.json is not valid JSON, so its MCP servers cannot be read.',
    );
    expect(`${(error as Error).message}${(json as Error).message}`).not.toContain('sk-secret-value');
  });
});
