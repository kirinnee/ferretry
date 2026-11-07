import { describe, expect, test } from 'bun:test';
import type { WebSocketClient, WebSocketPort } from '../../../contract/ports.ts';
import { daemonNameFrom } from '../../../host/identity.ts';
import { PermissionError, restrictWebSocket } from '../../../host/permissions.ts';

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
