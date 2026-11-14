import { describe, expect, test } from 'bun:test';
import { implementApp, type Manifest, skeletonApp } from '@ferretry/kernel/manifest';
import { chooseDial, connector, type DirectDial } from '../../../src/connect/connector.ts';
import {
  type ConnectPorts,
  provideToShell,
  registeredConnect,
  type ShellProvides,
} from '../../../src/connect/provides.ts';
import { fakeCarrier, fakeDeviceClaims } from '../../../src/connect/testing.ts';
import { DaemonList, type PairedDaemon } from '../../../src/daemons/daemon-list.ts';
import type { CarrierDial } from '../../../src/session/session-transport.ts';
import { SessionTransport } from '../../../src/session/session-transport.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';

const manifest = (id: string) =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'] }) as unknown as Manifest;

function entry(id: string, provides?: ShellProvides, skeleton = false): SurfaceEntry {
  const m = manifest(id);
  const half = skeleton ? skeletonApp(m) : implementApp(m, { build: () => ({}) });
  return {
    id,
    title: id,
    core: false,
    contract: 'h',
    consumes: [],
    manifest: m,
    app: provides === undefined ? half : provideToShell(half, provides),
  };
}

const daemon: PairedDaemon = {
  daemon: 'fy_daemon_one',
  machine: 'laptop',
  deviceId: 'dev_1',
  address: 'https://laptop.example.test',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
};

/** A dial that is never called in these suites: nothing here opens a session. */
const dialOf = (name: string): CarrierDial =>
  Object.assign(() => ({ send() {}, sendText() {}, close() {} }), { label: name });

const ports = (): ConnectPorts => ({
  crypto: {} as ConnectPorts['crypto'],
  subtle: {} as SubtleCrypto,
  indexedDB: null,
  openSocket: () => {
    throw new Error('no sockets in this suite');
  },
  after: () => {},
  now: () => 1,
  daemons: new DaemonList({ storage: memoryStore(), now: () => 1 }),
  pairDirect: async () => {
    throw new Error('no pairing in this suite');
  },
});

const claim = { deviceId: 'dev_1', key: { algorithm: 'Ed25519' as const }, appSession: 'app-1' };

describe('the providers the shell takes', () => {
  test('claims only from Access, carriers only from Connections (the session.modes and carriers takers)', () => {
    const access = fakeDeviceClaims({ claims: { [daemon.daemon]: claim } });
    const impostor = fakeDeviceClaims();
    const relay = fakeCarrier({ id: 'relay', order: 20, dial: dialOf('relay') });
    const direct = fakeCarrier({ id: 'direct', order: 10, dial: dialOf('direct') });
    const sneaky = fakeCarrier({ id: 'sneaky', order: 0, dial: dialOf('sneaky') });
    const got = registeredConnect(
      [
        entry('board', { claims: () => impostor, carriers: () => [sneaky] }),
        entry('access', { claims: () => access }),
        entry('connections', { carriers: () => [relay, direct] }),
      ],
      ports(),
    );
    expect(got.claims).toBe(access);
    expect(got.carriers.map(carrier => carrier.id)).toEqual(['direct', 'relay']);
    expect(got.failures).toEqual([]);
  });

  test('member carriers only from Connections, and none offered is none (a publisher is then unreachable)', () => {
    const carriers = {
      rendezvous: () => Promise.resolve(undefined),
      dial: () => ({}) as never,
      drive: () => Promise.reject(new Error('not driven')),
    };
    const impostor = { ...carriers };
    const got = registeredConnect(
      [entry('catalogs', { member: () => impostor }), entry('connections', { member: () => carriers })],
      ports(),
    );
    expect(got.member).toBe(carriers);
    expect(registeredConnect([entry('catalogs', { member: () => impostor })], ports()).member).toBeUndefined();
    expect(registeredConnect([], ports()).member).toBeUndefined();
  });

  test('a skeleton half provides nothing, and a provider that throws is left out and said', () => {
    const got = registeredConnect(
      [
        entry('access', { claims: () => fakeDeviceClaims() }, true),
        entry('connections', {
          carriers: () => {
            throw new Error('no relay advertisement');
          },
        }),
      ],
      ports(),
    );
    expect(got.claims).toBeUndefined();
    expect(got.carriers).toEqual([]);
    expect(got.failures).toEqual([{ plugin: 'connections', reason: 'no relay advertisement' }]);
  });

  test('provideToShell keeps the half and freezes the section', () => {
    const half = implementApp(manifest('access'), { build: () => ({}) });
    const provided = provideToShell(half, { claims: () => fakeDeviceClaims() });
    expect(provided.half).toBe('app');
    expect(provided.build).toBe(half.build);
    expect(Object.isFrozen(provided)).toBe(true);
    expect(Object.isFrozen(provided.shell)).toBe(true);
  });
});

describe('connecting', () => {
  const direct: DirectDial = () => dialOf('shell-direct');

  test('no claims provider, or no key for this daemon: the daemon cannot be reached yet and nothing is dialled', async () => {
    const carrier = fakeCarrier({ id: 'direct', order: 0, dial: dialOf('direct') });
    expect(await connector({ crypto: {} as never, claims: undefined, carriers: [carrier], direct })(daemon)).toBe(
      undefined,
    );
    const claims = fakeDeviceClaims();
    expect(await connector({ crypto: {} as never, claims, carriers: [carrier], direct })(daemon)).toBeUndefined();
    expect(claims.asked).toEqual([daemon.daemon]);
    expect(carrier.dialed).toEqual([]);
  });

  test('a claim and a carrier make a sealed session transport', async () => {
    const claims = fakeDeviceClaims({ claims: { [daemon.daemon]: claim } });
    const carrier = fakeCarrier({ id: 'direct', order: 0, dial: dialOf('direct') });
    const transport = await connector({ crypto: {} as never, claims, carriers: [carrier], direct })(daemon);
    expect(transport).toBeInstanceOf(SessionTransport);
    expect(carrier.dialed).toEqual([daemon.daemon]);
  });

  test('the first registered carrier that reaches the daemon is used; none reaching means no session', () => {
    const webrtc = fakeCarrier({ id: 'webrtc', order: 0, dial: dialOf('webrtc'), reaches: () => false });
    const relay = fakeCarrier({ id: 'relay', order: 1, dial: dialOf('relay') });
    expect((chooseDial(daemon, [webrtc, relay], direct) as unknown as { label: string }).label).toBe('relay');
    expect(chooseDial(daemon, [webrtc], direct)).toBeUndefined();
  });

  test('with no carrier registered (Connections off) the shell dials the pairing address directly', () => {
    expect((chooseDial(daemon, [], direct) as unknown as { label: string }).label).toBe('shell-direct');
  });
});
