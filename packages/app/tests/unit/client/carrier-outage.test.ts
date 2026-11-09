import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import {
  CARRIER_OUTAGE_CODE,
  DaemonCallError,
  DEVICE_REFUSED_CLOSE_CODE,
  DEVICE_REVOKED_CODE,
  isCarrierOutage,
  isDeviceRefusal,
  type TransportRequest,
} from '../../../src/client/transport.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from './fixtures.ts';

const board = surface('board', { routes: ['GET /v1/board', 'POST /v1/board'] });
const compiled = [...CORE, board];

/** A transport that answers the bootstrap and throws `failure` for every board request. */
function dying(failure: () => unknown) {
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(compiled));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/board' && request.method === 'GET') throw failure();
    return json({ error: 'No such thing.', code: 'not_found' }, 404);
  });
  const client = new DaemonClient({ transport, surfaces: compiled });
  return { transport, client };
}

describe('S12 a carrier outage is not a refusal', () => {
  test('a call that died on the carrier is marked, and says nothing a daemon said', async () => {
    const { client } = dying(() => new RelaySessionError('the rendezvous ended this session', 1006));
    await client.start();
    const failure = (await client
      .forPackage('board')
      .call('GET /v1/board')
      .catch(e => e)) as DaemonCallError;
    expect(failure).toBeInstanceOf(DaemonCallError);
    expect(failure.carrier).toBe(true);
    expect([failure.status, failure.code]).toEqual([0, CARRIER_OUTAGE_CODE]);
    expect(isCarrierOutage(failure)).toBe(true);
  });

  test('a plain failure (not a session error) is also an outage: no answer came', async () => {
    const { client } = dying(() => new Error('socket closed'));
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('GET /v1/board')
      .catch(e => e);
    expect(isCarrierOutage(failure)).toBe(true);
  });

  test('a daemon refusal is not marked', async () => {
    const { client } = dying(() => new Error('unused'));
    await client.start();
    const failure = (await client
      .forPackage('board')
      .call('POST /v1/board')
      .catch(e => e)) as DaemonCallError;
    expect(failure.code).toBe('not_found');
    expect(failure.carrier).toBeUndefined();
    expect(isCarrierOutage(failure)).toBe(false);
  });

  test("the caller's own abort is its own, never an outage", async () => {
    const controller = new AbortController();
    const abort = new DOMException('aborted', 'AbortError');
    const { client } = dying(() => {
      controller.abort(abort);
      return abort;
    });
    await client.start();
    const failure = await client
      .forPackage('board')
      .call('GET /v1/board', { signal: controller.signal })
      .catch(e => e);
    expect(failure).toBe(abort);
    expect(isCarrierOutage(failure)).toBe(false);
  });

  test('isCarrierOutage reads one cause level and nothing that is not a call error', () => {
    const outage = new DaemonCallError(0, CARRIER_OUTAGE_CODE, 'lost', undefined, true);
    expect(isCarrierOutage(new Error('wrapped', { cause: outage }))).toBe(true);
    expect(isCarrierOutage(new Error('wrapped', { cause: new Error('x') }))).toBe(false);
    expect(isCarrierOutage(new DaemonCallError(502, 'bad', 'bad'))).toBe(false);
    expect(isCarrierOutage('lost')).toBe(false);
    expect(isCarrierOutage(undefined)).toBe(false);
  });
});

describe('S12 a daemon that refuses this device', () => {
  test('the code the client reads is the wire’s own', () => {
    expect(DEVICE_REFUSED_CLOSE_CODE).toBe(RELAY_CLOSE_CODES.authRejected);
    expect(isDeviceRefusal(new RelaySessionError('no', RELAY_CLOSE_CODES.authRejected))).toBe(true);
    expect(isDeviceRefusal(new RelaySessionError('no', RELAY_CLOSE_CODES.daemonAbsent))).toBe(false);
    expect(isDeviceRefusal(new Error('4403'))).toBe(false);
    expect(isDeviceRefusal(undefined)).toBe(false);
  });

  test('a refused call is device_revoked (not an outage) and tells the shell ONCE', async () => {
    const { client } = dying(() => new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected));
    await client.start();
    let told = 0;
    client.onRevoked(() => (told += 1));
    for (let i = 0; i < 2; i += 1) {
      const failure = (await client
        .forPackage('board')
        .call('GET /v1/board')
        .catch(e => e)) as DaemonCallError;
      expect(failure.code).toBe(DEVICE_REVOKED_CODE);
      expect(failure.carrier).toBeUndefined();
      expect(failure.message).toContain('no longer accepts this browser');
    }
    expect(told).toBe(1);
  });

  test('a refusal on the bootstrap read tells the shell too', async () => {
    const transport = new FakeTransport(() => {
      throw new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected);
    });
    const client = new DaemonClient({ transport, surfaces: compiled });
    let told = 0;
    const stop = client.onRevoked(() => (told += 1));
    await client.start();
    expect(told).toBe(1);
    stop();
  });

  test('a stopped client says nothing', async () => {
    const { client } = dying(() => new RelaySessionError('no', RELAY_CLOSE_CODES.authRejected));
    await client.start();
    let told = 0;
    client.onRevoked(() => (told += 1));
    client.stop();
    await client
      .forPackage('board')
      .call('GET /v1/board')
      .catch(() => undefined);
    expect(told).toBe(0);
  });
});
