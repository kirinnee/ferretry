/**
 * A held session that drops: the keepalive that does not mistake a frozen page for a dead carrier, and
 * the report every real drop leaves behind (`carrier-drops.ts`).
 *
 * Fake sockets and a hand-moved clock throughout: "the timer fired a minute late" is a number this suite
 * sets, never a wait.
 */

import { describe, expect, it } from 'bun:test';
import { RELAY_CLOSE_CODES } from '@ferretry/relay';
import type { CarrierDropPurpose, CarrierSessionEnd } from '../../src/lib/carrier-drops.ts';
import { type DaemonId, daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';
import {
  DaemonCarrierRouter,
  HEARTBEAT_LATE_TOLERANCE_MS,
  KEEPALIVE_DEADLINE_MS,
  KEEPALIVE_INTERVAL_MS,
  LIVENESS_CHECK_DEADLINE_MS,
  openRelaySession,
} from '../../src/lib/relay-carrier.ts';
import { autoDial, newDaemonIdentity, relayCrypto, testDevice } from '../support/relay.ts';

const DAEMON_URL = 'https://studio.example';
const RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' };
const DEVICE_ID = 'fy_device_id_dropsTestDevice00000001';
const device = await testDevice(DEVICE_ID);
const mode = { kind: 'auth' as const, device: device.claim };

/** A repeating schedule a test fires by hand, recording every arm and cancel. */
const manualSchedule = () => {
  const armed: { tick: () => void; interval: number; cancelled: boolean }[] = [];
  const schedule = (tick: () => void, interval: number): (() => void) => {
    const entry = { tick, interval, cancelled: false };
    armed.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const live = (interval: number) =>
    [...armed].reverse().find(entry => entry.interval === interval && !entry.cancelled);
  const fire = (interval: number): void => {
    const entry = live(interval);
    if (entry === undefined) throw new Error(`no armed ${String(interval)} ms timer`);
    entry.tick();
  };
  return { armed, schedule, live, fire };
};

const open = async () => {
  const identity = await newDaemonIdentity();
  const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
  const timers = manualSchedule();
  const clock = { at: 0 };
  const drops: CarrierSessionEnd[] = [];
  const auto = autoDial(identity, { devicePublicKey: device.publicKey });
  const session = await openRelaySession({
    crypto: relayCrypto,
    dial: auto.dial,
    daemon,
    method: RELAY,
    heartbeat: timers.schedule,
    mode,
    clock: () => clock.at,
    onDropped: end => drops.push(end),
  });
  const socket = auto.sockets[0];
  if (socket === undefined) throw new Error('no socket');
  return { session, socket, timers, clock, drops };
};

describe('a heartbeat deadline that fired late', () => {
  it('should not end a session whose deadline fired long after its time, and ask again on the running page', async () => {
    // Arrange — a ping is sent, then the page is frozen for a minute before the deadline runs.
    const { session, socket, timers, clock, drops } = await open();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;

    // Act
    timers.fire(KEEPALIVE_DEADLINE_MS);

    // Assert — still serving, a fresh ping is out, under the short liveness-check deadline.
    expect(session.live()).toBe(true);
    expect(socket.closed).toBeNull();
    expect(socket.texts).toEqual(['fy-ping', 'fy-ping']);
    expect(timers.live(LIVENESS_CHECK_DEADLINE_MS)).toBeDefined();
    expect(drops).toEqual([]);

    // And the queued pong, delivered now, keeps it.
    socket.onText?.('fy-pong');
    expect(timers.live(LIVENESS_CHECK_DEADLINE_MS)).toBeUndefined();
    expect(session.live()).toBe(true);
  });

  it('should end it when the second, forgiven check also hears nothing — however late that fires', async () => {
    // Arrange
    const { session, socket, timers, clock, drops } = await open();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    timers.fire(KEEPALIVE_DEADLINE_MS);

    // Act — still frozen, still silent.
    clock.at += LIVENESS_CHECK_DEADLINE_MS + 60_000;
    timers.fire(LIVENESS_CHECK_DEADLINE_MS);

    // Assert
    expect(session.live()).toBe(false);
    expect(socket.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
  });

  it('should forgive again after the carrier showed life in between', async () => {
    // Arrange — one late deadline forgiven and answered.
    const { session, socket, timers, clock } = await open();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    timers.fire(KEEPALIVE_DEADLINE_MS);
    socket.onText?.('fy-pong');

    // Act — the next ping's deadline is late too.
    timers.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    timers.fire(KEEPALIVE_DEADLINE_MS);

    // Assert
    expect(session.live()).toBe(true);
    expect(timers.live(LIVENESS_CHECK_DEADLINE_MS)).toBeDefined();
  });

  it('should still end a session at once when its deadline fired on time, within the tolerance', async () => {
    // Arrange
    const { session, socket, timers, clock } = await open();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + HEARTBEAT_LATE_TOLERANCE_MS;

    // Act
    timers.fire(KEEPALIVE_DEADLINE_MS);

    // Assert
    expect(session.live()).toBe(false);
    expect(socket.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
  });
});

describe('what a dropped session reports', () => {
  it('should report a carrier that closed under a serving session, with its age and when it last heard anything', async () => {
    // Arrange
    const { socket, timers, clock, drops } = await open();
    clock.at = 30_000;
    timers.fire(KEEPALIVE_INTERVAL_MS);
    socket.onText?.('fy-pong');

    // Act
    clock.at = 95_000;
    socket.onClose?.(1006, 'the connection was cut');

    // Assert
    expect(drops).toEqual([{ code: 1006, reason: 'the connection was cut', livedMs: 95_000, lastHeardMs: 65_000 }]);
  });

  it('should report a heartbeat timeout once, not again for the close that follows it', async () => {
    // Arrange
    const { socket, timers, clock, drops } = await open();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    clock.at = 10_000;

    // Act
    timers.fire(KEEPALIVE_DEADLINE_MS);
    socket.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'no heartbeat');

    // Assert
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ code: RELAY_CLOSE_CODES.heartbeatTimeout, livedMs: 10_000, lastHeardMs: 10_000 });
  });

  it('should report nothing when this browser closed the session itself', async () => {
    // Arrange
    const { session, socket, drops } = await open();

    // Act
    session.close('the page is done with it');
    socket.onClose?.(1000, 'session closed');

    // Assert
    expect(drops).toEqual([]);
  });

  it('should hand the router’s drop log the machine, the carrier and the purpose, and tell it when the next session opened', async () => {
    // Arrange
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [RELAY],
    });
    const auto = autoDial(identity, { devicePublicKey: device.publicKey });
    const log: (
      | { kind: 'dropped'; daemonId: DaemonId; carrier: string; purpose: CarrierDropPurpose; code: number }
      | { kind: 'reconnected'; daemonId: DaemonId }
    )[] = [];
    const router = new DaemonCarrierRouter({
      preference: () => 'relay',
      crypto: relayCrypto,
      deviceKey: async () => device.claim.key,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
      drops: {
        dropped: (daemonId, carrier, purpose, end) =>
          log.push({ kind: 'dropped', daemonId, carrier, purpose, code: end.code }),
        reconnected: daemonId => log.push({ kind: 'reconnected', daemonId }),
      },
    });
    router.resolvePaired(() => [daemon]);
    await router.fetch(`${DAEMON_URL}/v1/carriers`, { headers: { 'x-fy-daemon-id': daemon.daemonId } });

    // Act — the relay drops the request session, and the next request opens another.
    auto.sockets[0]?.onClose?.(1006, 'cut');
    await router.fetch(`${DAEMON_URL}/v1/carriers`, { headers: { 'x-fy-daemon-id': daemon.daemonId } });

    // Assert
    expect(log).toEqual([
      { kind: 'reconnected', daemonId: daemon.daemonId },
      { kind: 'dropped', daemonId: daemon.daemonId, carrier: 'relay', purpose: 'requests', code: 1006 },
      { kind: 'reconnected', daemonId: daemon.daemonId },
    ]);
  });
});
