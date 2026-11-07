/**
 * The connect additions Connections' app half rides: the carrier-control lane (R634), the pairing walk port (R582),
 * the leg deadline, the directory read (R580) and which daemon a half's client talks to (lead decision 22).
 */
import { describe, expect, test } from 'bun:test';
import type { TransportRequest } from '../../../src/client/transport.ts';
import {
  CONTROL_UNREACHABLE,
  ControlLaneTransport,
  connector,
  pairOnLeg,
  pairOverCarriers,
} from '../../../src/connect/connector.ts';
import { daemonOfClient, noteClientDaemon } from '../../../src/connect/daemon-of.ts';
import { directoryFetch } from '../../../src/connect/directory.ts';
import type { PairDirectInput, PairingCarriers } from '../../../src/connect/provides.ts';
import { fakeCarrier, fakeDeviceClaims } from '../../../src/connect/testing.ts';
import type { PairedDaemon } from '../../../src/daemons/daemon-list.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import type { CarrierDial, SessionTransport } from '../../../src/session/session-transport.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';

const daemon: PairedDaemon = {
  daemon: 'fy_daemon_one',
  machine: 'laptop',
  deviceId: 'dev_1',
  address: 'https://laptop.example.test',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
};
const claim = { deviceId: 'dev_1', key: { algorithm: 'Ed25519' as const }, appSession: 'app-1' };
const idle: CarrierDial = () => ({ send() {}, sendText() {}, close() {} });

/** A transport that records the paths it carried. */
const recording = (name: string, carried: string[]) =>
  ({
    request: async (request: TransportRequest) => {
      carried.push(`${name} ${request.method} ${request.path}`);
      return { status: 200, headers: {}, body: undefined };
    },
    events: () => () => {},
    socket: () => ({ send() {}, close() {} }),
    onReconnect: () => () => {},
    close: () => carried.push(`${name} closed`),
  }) as unknown as SessionTransport;

describe('the carrier-control lane', () => {
  test('R634 GET/PUT /v1/tunnel ride the control lane; every other request rides the carrier the walk chose', async () => {
    const carried: string[] = [];
    let opened = 0;
    const lanes = new ControlLaneTransport(recording('main', carried), new Set(['/v1/tunnel']), () => {
      opened += 1;
      return recording('control', carried);
    });
    await lanes.request({ method: 'GET', path: '/v1/tunnel' });
    await lanes.request({ method: 'PUT', path: '/v1/tunnel', body: { enabled: true } });
    await lanes.request({ method: 'GET', path: '/v1/carriers' });
    await lanes.request({ method: 'GET', path: '/v1/tunnel/extra' });
    expect(carried).toEqual([
      'control GET /v1/tunnel',
      'control PUT /v1/tunnel',
      'main GET /v1/carriers',
      'main GET /v1/tunnel/extra',
    ]);
    expect(opened).toBe(1);
    lanes.close();
    expect(carried.slice(-2)).toEqual(['main closed', 'control closed']);
  });

  test('R634 a control request with no introducer to ride is refused with today’s sentence, never sent elsewhere', async () => {
    const carried: string[] = [];
    const lanes = new ControlLaneTransport(recording('main', carried), new Set(['/v1/tunnel']), () => undefined);
    await expect(lanes.request({ method: 'GET', path: '/v1/tunnel' })).rejects.toThrow(CONTROL_UNREACHABLE);
    expect(carried).toEqual([]);
  });

  test('a carrier with a control lane gets the lane; one without gets the plain session transport', async () => {
    const claims = fakeDeviceClaims({ claims: { [daemon.daemon]: claim } });
    const asked: string[] = [];
    const lane = {
      ...fakeCarrier({ id: 'connections', order: 0, dial: idle }),
      control: { paths: ['/v1/tunnel'], dial: (d: PairedDaemon) => (asked.push(d.daemon), idle) },
    };
    const direct = () => idle;
    const withLane = await connector({ crypto: {} as never, claims, carriers: [lane], direct })(daemon);
    expect(withLane).toBeInstanceOf(ControlLaneTransport);
    expect(asked).toEqual([]);
    const plain = fakeCarrier({ id: 'connections', order: 0, dial: idle });
    const without = await connector({ crypto: {} as never, claims, carriers: [plain], direct })(daemon);
    expect(without).not.toBeInstanceOf(ControlLaneTransport);
  });
});

const input: PairDirectInput = {
  address: 'https://laptop.example.test',
  daemonId: 'fy_daemon_one',
  code: 'ABCD-EFGH',
  key: { deviceName: 'phone', publicKey: 'spki', key: { algorithm: 'Ed25519' } as never },
};

describe('the pairing port', () => {
  test('R582 with Connections’ walk registered, the pair port walks it and answers the carrier that carried it', async () => {
    const legs: string[] = [];
    const walk: PairingCarriers = {
      pair: async (_input, attempt) => {
        legs.push('walked');
        expect(typeof attempt).toBe('function');
        return { kind: 'paired', response: {}, via: { kind: 'relay', address: 'https://relay.example' } };
      },
    };
    const pair = pairOverCarriers(
      {} as never,
      () => idle,
      () => {},
      () => walk,
    );
    expect(await pair(input)).toMatchObject({ kind: 'paired', via: { kind: 'relay' } });
    expect(legs).toEqual(['walked']);
  });

  test('a leg that answers nothing within its deadline ends as a heartbeat timeout and its socket is closed', async () => {
    const closed: number[] = [];
    const dial: CarrierDial = () => ({ send() {}, sendText() {}, close: code => closed.push(code ?? 0) });
    const timers: (() => void)[] = [];
    const attempt = pairOnLeg({} as never, (_ms, run) => timers.push(run));
    const pending = attempt(input, { kind: 'direct', address: input.address, dial, deadlineMs: 4_000 });
    for (const run of timers) run();
    const reason = await pending.catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(RelaySessionError);
    expect((reason as RelaySessionError).code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    expect(closed).toContain(RELAY_CLOSE_CODES.heartbeatTimeout);
  });
});

describe('the relay directory read', () => {
  test('R580 a build with no directory gets no port; one with a directory reaches only its origin, by GET', async () => {
    expect(directoryFetch(undefined)).toBeUndefined();
    expect(directoryFetch('')).toBeUndefined();
    expect(directoryFetch('off')).toBeUndefined();
    const read = directoryFetch('https://directory.example')!;
    await expect(read('https://elsewhere.example/v1/default-relay')).rejects.toThrow('directory origin');
    await expect(read('https://directory.example/v1/default-relay', { method: 'POST' })).rejects.toThrow('GET');
    await expect(read('not a url')).rejects.toThrow('not a URL');
  });
});

describe('which daemon a half’s client talks to', () => {
  test('the shell records the daemon of each client it hands out; any other object names none', () => {
    const client = {};
    noteClientDaemon(client, 'fy_daemon_one');
    expect(daemonOfClient(client)).toBe('fy_daemon_one');
    expect(daemonOfClient({})).toBeUndefined();
  });
});
