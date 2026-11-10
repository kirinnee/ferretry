/**
 * MCP's seams to what is configured, to the harness plugin and to a project's folder. The project folder is a REAL
 * root over a real temp folder; the others are the contract objects their neighbours hand over.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FerretId } from '@ferretry/kernel/contract';
import { diskRoot } from '@ferretry/kernel/testing';
import { McpItemSchema } from '../../contract/index.ts';
import { ConfigMcpServers } from '../../daemon/adapters/config-servers.ts';
import { harnessProjectApprovals } from '../../daemon/adapters/harness-approvals.ts';
import { RootMcpProjectFiles } from '../../daemon/adapters/project-files.ts';
import { McpProjectFileError } from '../../daemon/lib/session/project-file.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

describe('ConfigMcpServers', () => {
  test('lists every configured server with what its sign-in needs and nothing else', async () => {
    const items = new Map([
      ['plain', McpItemSchema.parse({ command: 'serve' })],
      ['remote', McpItemSchema.parse({ url: 'https://mcp.example.test/mcp', auth: 'oauth' })],
      [
        'registered',
        McpItemSchema.parse({
          url: 'https://mcp.example.test/other',
          auth: 'oauth',
          oauth: { clientId: 'client-1', clientSecret: '${secret:MCP_CLIENT_SECRET}', callbackPort: 4567 },
        }),
      ],
      [
        'public-client',
        McpItemSchema.parse({ url: 'http://127.0.0.1:9/mcp', auth: 'oauth', oauth: { clientId: 'client-2' } }),
      ],
    ]);

    const listed = await new ConfigMcpServers(() => items).list();

    expect(listed).toEqual([
      { component: 'plain' },
      { component: 'remote', url: 'https://mcp.example.test/mcp', auth: 'oauth' },
      {
        component: 'registered',
        url: 'https://mcp.example.test/other',
        auth: 'oauth',
        client: { clientId: 'client-1', clientSecret: 'MCP_CLIENT_SECRET', callbackPort: 4567 },
      },
      {
        component: 'public-client',
        url: 'http://127.0.0.1:9/mcp',
        auth: 'oauth',
        client: { clientId: 'client-2' },
      },
    ]);
  });
});

describe('harnessProjectApprovals', () => {
  const ferret = 'f1' as FerretId;
  const request = { account: {} as never, root: '/work/project', servers: ['github'] };

  test('a harness with no reader takes no project server at all', async () => {
    const answer = await harnessProjectApprovals({}, 'codex', ferret)(request);

    expect(answer?.state).toBe('not-taken');
  });

  test('a harness that is off, or offers no such read, gives no answer', async () => {
    expect(await harnessProjectApprovals({ claude: () => undefined }, 'claude', ferret)(request)).toBeUndefined();
    expect(await harnessProjectApprovals({ claude: () => ({}) }, 'claude', ferret)(request)).toBeUndefined();
  });

  test('a harness whose read throws gives no answer, never a guess', async () => {
    const throwing = {
      claude: () => ({
        approvedProjectServers: async () => {
          throw new Error('the harness home is unreadable');
        },
      }),
    };

    expect(await harnessProjectApprovals(throwing, 'claude', ferret)(request)).toBeUndefined();
  });

  test('a harness that answers is asked about this ferret, this folder and these servers, and its answer passes', async () => {
    const asked: unknown[] = [];
    const reader = {
      claude: () => ({
        approvedProjectServers: async (query: unknown) => {
          asked.push(query);
          return { state: 'read' as const, servers: {} };
        },
      }),
    };

    const answer = await harnessProjectApprovals(reader, 'claude', ferret)(request);

    expect(answer).toEqual({ state: 'read', servers: {} });
    expect(asked).toEqual([{ ferret: 'f1', root: '/work/project', servers: ['github'] }]);
  });
});

describe('RootMcpProjectFiles on a real folder', () => {
  async function folder() {
    const parent = await mkdtemp(join(tmpdir(), 'fy-mcp-project-'));
    parents.push(parent);
    const { root, folder: base } = await diskRoot(parent);
    return { parent, base, files: new RootMcpProjectFiles(async () => ({ root, base })) };
  }

  test('a new .mcp.json is written whole, read back with its etag, and replaced only against that etag', async () => {
    const { base, files } = await folder();
    const path = join(base, '.mcp.json');

    const etag = await files.replace('f1', path, '{"mcpServers":{}}\n', null);
    const read = await files.read('f1', path);
    const next = await files.replace('f1', path, '{"mcpServers":{"a":{}}}\n', etag);

    expect(read).toEqual({ text: '{"mcpServers":{}}\n', etag });
    expect(next).not.toBe(etag);
    await expect(files.replace('f1', path, 'again', etag)).rejects.toThrow();
  });

  test('a path outside the ferret’s folder is neither read nor written', async () => {
    const { base, files } = await folder();

    await expect(files.read('f1', join(base, '..', 'elsewhere', '.mcp.json'))).rejects.toBeInstanceOf(
      McpProjectFileError,
    );
    await expect(files.replace('f1', '/etc/.mcp.json', 'x', null)).rejects.toThrow('outside the ferret');
  });

  test('a name that is a link out of the folder is refused, not followed', async () => {
    const { parent, base, files } = await folder();
    await mkdir(join(parent, 'outside'));
    await writeFile(join(parent, 'outside', 'secret.json'), '{"leak":true}');
    await symlink(join(parent, 'outside', 'secret.json'), join(base, '.mcp.json'));

    await expect(files.read('f1', join(base, '.mcp.json'))).rejects.toThrow('not a regular file');
  });

  test('a project file larger than 1 MiB is neither read nor replaced', async () => {
    const { base, files } = await folder();
    await writeFile(join(base, '.mcp.json'), 'x'.repeat(1024 * 1024 + 1));

    await expect(files.read('f1', join(base, '.mcp.json'))).rejects.toThrow('larger than 1 MiB');
    await expect(files.replace('f1', join(base, '.mcp.json'), '{}', null)).rejects.toThrow('larger than 1 MiB');
  });

  test('a folder at the name is not a regular file', async () => {
    const { base, files } = await folder();
    await mkdir(join(base, '.mcp.json'));

    await expect(files.read('f1', join(base, '.mcp.json'))).rejects.toThrow('not a regular file');
  });
});
