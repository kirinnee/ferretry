import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchPort, SpawnPort, WebSocketClient, WebSocketPort } from '../../../contract/ports.ts';
import { daemonNameFrom } from '../../../host/identity.ts';
import { installedItemReach } from '../../../host/items.ts';
import {
  effectivePermissions,
  hostPermitted,
  type ItemReach,
  PermissionError,
  restrictFetch,
  restrictSpawn,
  restrictWebSocket,
  spawnPermitted,
} from '../../../host/permissions.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';

/** `openRead` over in-memory files: `read(limit)` answers at most `limit` bytes, as a descriptor does. */
function opened(files: ReadonlyMap<string, string>, asked: number[] = []): HostFs['openRead'] {
  return async file => {
    const bytes = new TextEncoder().encode(files.get(file) ?? '');
    return {
      read: async (limit?: number) => {
        asked.push(limit ?? -1);
        return bytes.subarray(0, limit);
      },
      close: async () => undefined,
    } as unknown as Awaited<ReturnType<HostFs['openRead']>>;
  };
}

function recordingSockets(): WebSocketPort & { readonly dialled: string[] } {
  const dialled: string[] = [];
  return {
    dialled,
    connect: url => {
      dialled.push(String(url));
      return { binaryType: 'arraybuffer' } as unknown as WebSocketClient;
    },
  };
}

describe('kernel.websocket: restricted like kernel.fetch', () => {
  test('dials a declared host over wss or ws, with the URL alone', () => {
    const base = recordingSockets();
    const port = restrictWebSocket('connections', ['relay.example.test', '*.workers.dev'], base);
    port.connect('wss://relay.example.test/v1/rendezvous/x/daemon');
    port.connect(new URL('ws://a.workers.dev/socket'));
    expect(base.dialled).toEqual(['wss://relay.example.test/v1/rendezvous/x/daemon', 'ws://a.workers.dev/socket']);
  });

  test('refuses an undeclared host, another scheme or a malformed address before any socket opens', () => {
    const base = recordingSockets();
    const port = restrictWebSocket('connections', ['relay.example.test'], base);
    expect(() => port.connect('wss://evil.test/')).toThrow(PermissionError);
    expect(() => port.connect('wss://workers.dev/')).toThrow(PermissionError);
    expect(() => port.connect('https://relay.example.test/')).toThrow(PermissionError);
    expect(() => port.connect('not a url')).toThrow(PermissionError);
    expect(() => port.connect('wss://evil.test/')).toThrow(
      'connections may not reach evil.test: its manifest does not declare it.',
    );
    expect(base.dialled).toEqual([]);
  });
});

describe('kernel.identity: the daemon name', () => {
  test('is today’s normalised host name: control and format characters gone, trimmed, bounded', () => {
    expect(daemonNameFrom('  studio\u0007.local​ ')).toBe('studio.local');
    expect(daemonNameFrom('x'.repeat(140))).toHaveLength(100);
    expect(daemonNameFrom('\u0000\u0001')).toBe('Ferretry daemon');
    expect(daemonNameFrom('')).toBe('Ferretry daemon');
  });
});

describe('kernel.spawn / fetch: declared names, absolute paths and installed items', () => {
  const ran: string[] = [];
  const spawn: SpawnPort = {
    run: async program => {
      ran.push(program);
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
    runBytes: async () => {
      throw new Error('not run here');
    },
    start: () => {
      throw new Error('not started here');
    },
  };
  const fetched: string[] = [];
  const fetchPort: FetchPort = {
    request: async url => {
      fetched.push(String(url));
      return new Response('');
    },
  };

  test('an absolute path to a declared program runs; another program refused', async () => {
    const port = restrictSpawn('updates', ['git'], spawn);
    await port.run('/usr/bin/git', ['status']);
    await expect(port.run('/usr/bin/curl', [])).rejects.toThrow(
      'updates may not run curl: its manifest does not declare it.',
    );
    expect(ran.at(-1)).toBe('/usr/bin/git');
    // runBytes is refused alike, before anything starts
    await expect(port.runBytes('curl', [])).rejects.toThrow(PermissionError);
  });

  test('{ items: mcp } allows what an installed item names, read when the call is made', async () => {
    let installed: ItemReach = { programs: [], hosts: [] };
    const items = (kind: string): ItemReach => (kind === 'mcp' ? installed : { programs: [], hosts: [] });
    const runs = restrictSpawn('mcp', [{ items: 'mcp' }], spawn, items);
    const reaches = restrictFetch('mcp', [{ items: 'mcp' }], fetchPort, items);
    await expect(runs.run('npx', [])).rejects.toThrow(PermissionError);
    await expect(reaches.request('https://mcp.example.test/')).rejects.toThrow(PermissionError);
    installed = { programs: ['npx', '/opt/tools/server'], hosts: ['mcp.example.test'] };
    await runs.run('npx', ['-y', 'server']);
    await runs.run('/opt/tools/server', []);
    await reaches.request('https://mcp.example.test/sse');
    // an item naming an absolute path allows that file, never another file of the same name
    await expect(runs.run('/tmp/server', [])).rejects.toThrow(PermissionError);
    await expect(reaches.request('https://other.example.test/')).rejects.toThrow(PermissionError);
    // another kind's items name nothing for this declaration
    await expect(restrictSpawn('mcp', [{ items: 'shell' }], spawn, items).run('npx', [])).rejects.toThrow(
      PermissionError,
    );
  });
});

describe('installedItemReach: what installed data-plugin items name', () => {
  for (const linkKind of ['parent', 'leaf', 'plugin', 'plugin sibling', 'prefix sibling'] as const) {
    test(`an installed item's ${linkKind} symlink cannot grant outside spawn or network reach`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'kernel-item-reach-'));
      try {
        const plugins = join(home, 'state/kernel/plugins');
        const plugin = join(plugins, 'installed');
        const outside =
          linkKind === 'prefix sibling' || linkKind === 'plugin sibling' ? `${plugin}-outside` : join(home, 'outside');
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, 'item.yaml'), 'command: /tmp/outside-program\nurl: https://outside.test/\n');
        if (linkKind === 'plugin' || linkKind === 'plugin sibling') {
          await mkdir(plugins, { recursive: true });
          await symlink(outside, plugin);
        } else {
          await mkdir(plugin, { recursive: true });
          await symlink(
            linkKind === 'leaf' ? join(outside, 'item.yaml') : outside,
            join(plugin, linkKind === 'leaf' ? 'item.yaml' : 'nested'),
          );
        }
        const fs = nodeFs(() => 'test');
        const reads: string[] = [];
        const openRead = fs.openRead;
        fs.openRead = path => {
          reads.push(path);
          return openRead(path);
        };
        const reach = await installedItemReach(fs, home, [
          {
            id: 'installed',
            items: [
              {
                id: 'server',
                kind: 'mcp',
                file:
                  linkKind === 'leaf' || linkKind === 'plugin' || linkKind === 'plugin sibling'
                    ? 'item.yaml'
                    : 'nested/item.yaml',
              },
            ],
          },
        ]);
        expect(reach('mcp')).toEqual({ programs: [], hosts: [] });
        expect(reads).toEqual([]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  test('reads command and url from each installed item file; a missing or escaping file names nothing', async () => {
    const files = new Map([
      ['/home/fy/state/kernel/plugins/acme/items/files.yaml', 'command: npx\nargs: [-y, files]\n'],
      ['/home/fy/state/kernel/plugins/acme/items/remote.yaml', 'url: https://mcp.acme.test/sse\n'],
      ['/home/fy/state/kernel/plugins/acme/items/sh.yaml', 'command: zsh\n'],
      ['/home/fy/state/kernel/plugins/other/items/x.yaml', 'command: rm\n'],
    ]);
    const fs = {
      realpath: async (file: string) => file,
      lstat: async (file: string) => {
        const text = files.get(file);
        return text === undefined ? undefined : { kind: 'file' as const, size: text.length, mtimeMs: 0 };
      },
      openRead: opened(files),
    } as unknown as HostFs;
    const reach = await installedItemReach(fs, '/home/fy', [
      {
        id: 'acme',
        items: [
          { kind: 'mcp', id: 'files', file: 'items/files.yaml' },
          { kind: 'mcp', id: 'remote', file: 'items/remote.yaml' },
          { kind: 'mcp', id: 'gone', file: 'items/gone.yaml' },
          { kind: 'mcp', id: 'escape', file: '../other/items/x.yaml' },
          { kind: 'shell', id: 'sh', file: 'items/sh.yaml' },
        ],
      },
    ]);
    expect(reach('mcp')).toEqual({ programs: ['npx'], hosts: ['mcp.acme.test'] });
    expect(reach('shell')).toEqual({ programs: ['zsh'], hosts: [] });
    expect(reach('skill')).toEqual({ programs: [], hosts: [] });
  });
});

describe('installedItemReach: an item file is read with a hard bound', () => {
  test('a file that grew after its size was read is read one byte past the cap and names nothing', async () => {
    const path = '/home/fy/state/kernel/plugins/acme/items/grown.yaml';
    const big = `command: npx\n#${'x'.repeat(256 * 1024)}\n`;
    const files = new Map([[path, big]]);
    const asked: number[] = [];
    const fs = {
      realpath: async (file: string) => file,
      // The size said before the read is small: the file grew in between.
      lstat: async () => ({ kind: 'file' as const, size: 10, mtimeMs: 0 }),
      openRead: opened(files, asked),
    } as unknown as HostFs;
    const reach = await installedItemReach(fs, '/home/fy', [
      { id: 'acme', items: [{ kind: 'mcp', id: 'grown', file: 'items/grown.yaml' }] },
    ]);
    expect(reach('mcp')).toEqual({ programs: [], hosts: [] });
    expect(asked).toEqual([256 * 1024 + 1]);
  });

  test('a file exactly at the cap is still read', async () => {
    const path = '/home/fy/state/kernel/plugins/acme/items/full.yaml';
    const head = 'command: npx\n#';
    const files = new Map([[path, `${head}${'x'.repeat(256 * 1024 - head.length)}`]]);
    const fs = {
      realpath: async (file: string) => file,
      lstat: async () => ({ kind: 'file' as const, size: 256 * 1024, mtimeMs: 0 }),
      openRead: opened(files),
    } as unknown as HostFs;
    const reach = await installedItemReach(fs, '/home/fy', [
      { id: 'acme', items: [{ kind: 'mcp', id: 'full', file: 'items/full.yaml' }] },
    ]);
    expect(reach('mcp')).toEqual({ programs: ['npx'], hosts: [] });
  });
});

describe('BB wildcard reach: core only', () => {
  const spawn: SpawnPort = {
    run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    runBytes: async () => {
      throw new Error('not run here');
    },
    start: () => {
      throw new Error('not started here');
    },
  };
  const fetchPort: FetchPort = { request: async () => new Response('') };

  test("a core piece's '*' runs any program and reaches any host", async () => {
    await restrictSpawn('vault', effectivePermissions('vault', ['*']), spawn).run('/opt/owner/tool', []);
    await restrictFetch('vault', effectivePermissions('vault', ['*']), fetchPort).request('https://anything.example/');
  });

  test("a plugin's '*' grants nothing (and plugin-graph refuses it)", async () => {
    await expect(restrictSpawn('mcp', effectivePermissions('mcp', ['*']), spawn).run('ls', [])).rejects.toThrow(
      PermissionError,
    );
    await expect(
      restrictFetch('mcp', effectivePermissions('mcp', ['*']), fetchPort).request('https://anything.example/'),
    ).rejects.toThrow(PermissionError);
  });
});

describe('an installed item never grants a pattern', () => {
  test("S? items wildcard: an item naming '*' (or any pattern) reaches nothing for a non-core { items } plugin", async () => {
    // At use: what an item reach answers is filtered, whoever produced it.
    const wild = (): ItemReach => ({ programs: ['*', 'np*'], hosts: ['*', '*.example', 'ev*l.example'] });
    expect(spawnPermitted([{ items: 'mcp' }], wild, '/bin/sh')).toBe(false);
    expect(spawnPermitted([{ items: 'mcp' }], wild, 'npx')).toBe(false);
    expect(hostPermitted([{ items: 'mcp' }], wild, 'evil.example')).toBe(false);
    expect(hostPermitted([{ items: 'mcp' }], wild, 'sub.example')).toBe(false);
    const spawned: string[] = [];
    const base: SpawnPort = {
      run: async program => {
        spawned.push(program);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      runBytes: async () => {
        throw new Error('not run here');
      },
      start: () => {
        throw new Error('not started here');
      },
    };
    await expect(restrictSpawn('mcp', [{ items: 'mcp' }], base, wild).run('/bin/sh', [])).rejects.toThrow(
      PermissionError,
    );
    expect(spawned).toEqual([]);
    // A literal item name still passes beside the dropped patterns.
    const mixed = (): ItemReach => ({ programs: ['*', 'npx'], hosts: ['*', 'mcp.acme.test'] });
    expect(spawnPermitted([{ items: 'mcp' }], mixed, 'npx')).toBe(true);
    expect(hostPermitted([{ items: 'mcp' }], mixed, 'mcp.acme.test')).toBe(true);
    expect(hostPermitted([{ items: 'mcp' }], mixed, 'other.example')).toBe(false);
    // At read: an installed item file whose command or url is a pattern names nothing.
    const files = new Map([
      ['/home/fy/state/kernel/plugins/acme/items/any.yaml', "command: '*'\nurl: https://*/x\n"],
      ['/home/fy/state/kernel/plugins/acme/items/sub.yaml', 'command: np*\nurl: https://*.acme.test/x\n'],
    ]);
    const fs = {
      realpath: async (file: string) => file,
      lstat: async (file: string) => {
        const text = files.get(file);
        return text === undefined ? undefined : { kind: 'file' as const, size: text.length, mtimeMs: 0 };
      },
      openRead: opened(files),
    } as unknown as HostFs;
    const reach = await installedItemReach(fs, '/home/fy', [
      {
        id: 'acme',
        items: [
          { kind: 'mcp', id: 'any', file: 'items/any.yaml' },
          { kind: 'mcp', id: 'sub', file: 'items/sub.yaml' },
        ],
      },
    ]);
    expect(reach('mcp')).toEqual({ programs: [], hosts: [] });
  });
});

describe('CC a { resolver } network entry: the plugin half answers its own hosts, with no request data', () => {
  const reached: string[] = [];
  const fetchPort: FetchPort = {
    request: async url => {
      reached.push(String(url));
      return new Response('');
    },
  };

  test('an answered host (or host:port) passes; any other host, or a wildcard answer, is refused', async () => {
    const port = restrictFetch('connections', [{ resolver: 'relay' }], fetchPort, undefined, name =>
      name === 'relay' ? () => ['relay.example.test', 'self.example.test:8443', '*.workers.dev'] : undefined,
    );
    await port.request('https://relay.example.test/v1/rendezvous');
    await port.request('https://self.example.test:8443/x');
    await expect(port.request('https://self.example.test/x')).rejects.toThrow(PermissionError);
    await expect(port.request('https://evil.test/')).rejects.toThrow(PermissionError);
    await expect(port.request('https://a.workers.dev/')).rejects.toThrow(PermissionError);
    expect(reached).toEqual(['https://relay.example.test/v1/rendezvous', 'https://self.example.test:8443/x']);
  });

  test('a throwing or missing resolver refuses; the resolver is called with no arguments', async () => {
    const seen: unknown[][] = [];
    const throwing = restrictFetch('connections', [{ resolver: 'relay' }], fetchPort, undefined, () => () => {
      throw new Error('config unreadable');
    });
    await expect(throwing.request('https://relay.example.test/')).rejects.toThrow(PermissionError);
    const missing = restrictFetch('connections', [{ resolver: 'relay' }], fetchPort);
    await expect(missing.request('https://relay.example.test/')).rejects.toThrow(PermissionError);
    const spying = restrictWebSocket(
      'connections',
      [{ resolver: 'relay' }],
      { connect: () => ({ binaryType: 'arraybuffer' }) as unknown as WebSocketClient },
      undefined,
      () =>
        (...args: unknown[]) => {
          seen.push(args);
          return ['relay.example.test'];
        },
    );
    spying.connect('wss://relay.example.test/v1/rendezvous/abc/daemon?token=x');
    expect(seen).toEqual([[]]);
  });
});
