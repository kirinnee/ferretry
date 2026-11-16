/** The direct carrier as the kernel starts it: off until it has a session layer, ready after, off again when stopped. */
import { describe, expect, test } from 'bun:test';
import type { ApiRequest, SessionLayer } from '@ferretry/kernel/contract';
import { DirectCarrier } from '../../../daemon/lib/relay/direct.ts';
import { FakeSessions } from '../../support/sessions.ts';

const DAEMON = `fy_daemon_${'a'.repeat(43)}`;

function carrier() {
  const layer = new FakeSessions();
  const instance = new DirectCarrier({
    identity: { daemonId: DAEMON },
    clock: { now: () => 1_000 },
    scheduler: { after: () => ({ cancel: () => undefined }) },
    randomBytes: n => new Uint8Array(n).fill(3),
    openSession: (sessions: SessionLayer, key, peer) => sessions.open(key, peer),
  });
  return { instance, layer };
}

const call = () => {
  const request: ApiRequest = {
    method: 'GET',
    path: `/v1/rendezvous/${DAEMON}/client`,
    query: new Map(),
    headers: new Map(),
    clientAddress: '198.51.100.2',
    arrival: { kind: 'carried', carrier: 'direct' as never },
    text: async () => '',
  };
  return { request, params: new Map([['daemonId', DAEMON]]) };
};

describe('DirectCarrier', () => {
  test('says it is stopped, and refuses a socket with 503, until the kernel has started it', async () => {
    const { instance } = carrier();
    expect(instance.status()).toEqual({ state: 'off', sentence: 'the direct carrier is stopped' });
    const attach = await instance.route.accept(call());
    const downstream = { send: () => 0, close: () => undefined, bufferedBytes: () => 0 };
    const session = await attach(downstream);
    await expect(session.open()).rejects.toMatchObject({ status: 503, code: 'plugin_unavailable' });
  });

  test('is ready once started, and stopped again when the kernel aborts it', async () => {
    const { instance, layer } = carrier();
    const stop = new AbortController();
    await instance.start(layer, stop.signal);
    expect(instance.status()).toEqual({ state: 'ready', sentence: 'the direct carrier is ready' });
    const downstream = { send: () => 0, close: () => undefined, bufferedBytes: () => 0 };
    const session = await (await instance.route.accept(call()))(downstream);
    await session.open();
    expect(layer.links).toHaveLength(1);
    session.close();
    stop.abort();
    expect(instance.status().state).toBe('off');
  });

  test('stays stopped when it is started with a signal that is already aborted', async () => {
    const { instance, layer } = carrier();
    const stop = new AbortController();
    stop.abort();
    await instance.start(layer, stop.signal);
    expect(instance.status().state).toBe('off');
  });
});
