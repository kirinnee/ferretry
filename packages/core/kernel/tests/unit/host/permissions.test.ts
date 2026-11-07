import { describe, expect, test } from 'bun:test';
import type { FetchPort, SpawnPort, WebSocketClient, WebSocketPort } from '../../../contract/ports.ts';
import { daemonNameFrom } from '../../../host/identity.ts';
import { installedItemReach } from '../../../host/items.ts';
import {
  type ItemReach,
  PermissionError,
  restrictFetch,
  restrictSpawn,
  restrictWebSocket,
} from '../../../host/permissions.ts';
import type { HostFs } from '../../../host/adapters/node-fs.ts';

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
  test('reads command and url from each installed item file; a missing or escaping file names nothing', async () => {
    const files = new Map([
      ['/home/fy/state/kernel/plugins/acme/items/files.yaml', 'command: npx\nargs: [-y, files]\n'],
      ['/home/fy/state/kernel/plugins/acme/items/remote.yaml', 'url: https://mcp.acme.test/sse\n'],
      ['/home/fy/state/kernel/plugins/acme/items/sh.yaml', 'command: zsh\n'],
      ['/home/fy/state/kernel/plugins/other/items/x.yaml', 'command: rm\n'],
    ]);
    const fs = {
      lstat: async (file: string) => {
        const text = files.get(file);
        return text === undefined ? undefined : { kind: 'file' as const, size: text.length, mtimeMs: 0 };
      },
      readText: async (file: string) => files.get(file) ?? '',
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
