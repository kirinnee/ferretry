import { describe, expect, it } from 'bun:test';
import type { ConnectionChoice } from '@ferretry/relay';
import {
  findLocalComputer,
  isLocalDirect,
  type LocalComputerCandidate,
} from '../../../src/features/browser/local-computer.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';

const carrying = (method: Extract<ConnectionChoice, { ok: true }>['method']): ConnectionChoice => ({
  ok: true,
  method,
  reason: 'carried',
  passedOver: [],
});

const direct = (daemonUrl: string) => carrying({ kind: 'direct', daemonUrl });

const candidate = (id: string, choice: ConnectionChoice | undefined): LocalComputerCandidate => ({
  daemonId: daemonId(id),
  choice,
});

describe('isLocalDirect', () => {
  it.each(['http://127.0.0.1:40245', 'http://localhost:40245', 'http://[::1]:40245', 'http://127.4.5.6:40245'])(
    'is true for a measured direct connection to %s',
    url => {
      expect(isLocalDirect(direct(url))).toBe(true);
    },
  );

  it.each(['http://192.168.1.20:40245', 'https://daemon.example.test', 'http://10.0.0.5:40245'])(
    'is false for a direct connection to another machine, %s',
    url => {
      expect(isLocalDirect(direct(url))).toBe(false);
    },
  );

  it('is false for every carrier that is remote by construction, even when it names loopback', () => {
    expect(isLocalDirect(carrying({ kind: 'webrtc' }))).toBe(false);
    expect(isLocalDirect(carrying({ kind: 'tunnel', tunnelUrl: 'https://abc.trycloudflare.com' }))).toBe(false);
    expect(isLocalDirect(carrying({ kind: 'relay', relayUrl: 'wss://relay.example.test/v1' }))).toBe(false);
  });

  it('is false for a direct carrier whose address cannot be read', () => {
    expect(isLocalDirect(direct('not a url'))).toBe(false);
  });

  it('is false before anything has been carried and when nothing is reachable', () => {
    expect(isLocalDirect(undefined)).toBe(false);
    expect(isLocalDirect({ ok: false, reason: 'nothing answered', passedOver: [] })).toBe(false);
  });
});

describe('findLocalComputer', () => {
  it('finds the first paired daemon that is local, in pairing order', () => {
    expect(
      findLocalComputer([
        candidate('remote', direct('https://daemon.example.test')),
        candidate('local-a', direct('http://127.0.0.1:1')),
        candidate('local-b', direct('http://localhost:2')),
      ]),
    ).toBe(daemonId('local-a'));
  });

  it('finds none when every daemon is remote, unmeasured or relayed', () => {
    expect(
      findLocalComputer([
        candidate('remote', direct('https://daemon.example.test')),
        candidate('fresh', undefined),
        candidate('relayed', carrying({ kind: 'relay', relayUrl: 'wss://relay.example.test/v1' })),
      ]),
    ).toBeUndefined();
    expect(findLocalComputer([])).toBeUndefined();
  });
});
