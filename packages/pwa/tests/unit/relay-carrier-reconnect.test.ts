/**
 * Surviving a dropped carrier: the keepalive that finds a dead socket, the read that walks again, the
 * write that never does, and the outcome every request reports to the connection model.
 *
 * The protocol has no session resume, so each case here is about what this side does when a socket it
 * held is gone — and, for a write, about never claiming more than it can prove.
 */

import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER } from '@ferretry/protocol';
import {
  HEARTBEAT_GRACE_SECONDS,
  HOSTED_RELAY_BANDWIDTH_REASONS,
  hostedBandwidthReason,
  RELAY_CLOSE_CODES,
} from '@ferretry/relay';
import type { CarrierOutage, ConnectionHealthReporter } from '../../src/lib/connection-health.ts';
import { type DaemonId, daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';
import {
  CarrierUnavailableError,
  carrierDelivery,
  checkSessionLiveness,
  DaemonCarrierRouter,
  type DaemonCarrierRouterOptions,
  DaemonOutdatedError,
  DeviceNotAcceptedError,
  DIAL_DEFERRED_REASON,
  isCarrierOutage,
  KEEPALIVE_DEADLINE_MS,
  KEEPALIVE_INTERVAL_MS,
  LIVENESS_CHECK_DEADLINE_MS,
  openRelaySession,
  provenUnsent,
  socketNeverOpened,
} from '../../src/lib/relay-carrier.ts';
import { RelaySessionError, RelayStreamRefusedError } from '../../src/lib/relay-session.ts';
import {
  autoDial,
  newDaemonIdentity,
  olderDaemonDial,
  relayCrypto,
  ScriptedSocket,
  settle,
  testDevice,
} from '../support/relay.ts';

const DAEMON_URL = 'https://studio.example';
const DIRECT_HOST = new URL(DAEMON_URL).hostname;
const RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' };
const DEVICE_ID = 'fy_device_id_reconnectTestDevice0001';
const device = await testDevice(DEVICE_ID);
const deviceKey: DaemonCarrierRouterOptions['deviceKey'] = async () => device.claim.key;
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
  /** The newest still-armed timer with this interval. */
  const live = (interval: number) =>
    [...armed].reverse().find(entry => entry.interval === interval && !entry.cancelled);
  const fire = (interval: number): void => {
    const entry = live(interval);
    if (entry === undefined) throw new Error(`no armed ${String(interval)} ms timer`);
    entry.tick();
  };
  return { armed, schedule, live, fire };
};

type Reach = (url: URL) => 'live' | 'refuse' | 'absent' | 'spent';

/** The refusal a 'spent' relay closes with: this machine's daily allowance, resetting at a fixed instant. */
const SPENT_REASON = hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, Date.UTC(2026, 9, 22));

/** Live on some addresses, refused (never opened) on others, or opened and closed `4404` by a relay. */
const carriersFor = (
  identity: Awaited<ReturnType<typeof newDaemonIdentity>>,
  reach: () => Reach,
  answer: Parameters<typeof autoDial>[1] = {},
) => {
  const live = autoDial(identity, { devicePublicKey: device.publicKey, ...answer });
  const dialled: string[] = [];
  const dial = (url: string): ScriptedSocket => {
    dialled.push(new URL(url).hostname);
    const verdict = reach()(new URL(url));
    if (verdict === 'live') return live.dial();
    const socket = new ScriptedSocket();
    queueMicrotask(() => {
      if (verdict === 'absent') {
        socket.onOpen?.();
        socket.onClose?.(RELAY_CLOSE_CODES.daemonAbsent, 'no daemon holds this rendezvous');
        return;
      }
      if (verdict === 'spent') {
        socket.onOpen?.();
        socket.onClose?.(RELAY_CLOSE_CODES.hostedBandwidth, SPENT_REASON);
        return;
      }
      socket.onClose?.(1006, 'the address did not answer');
    });
    return socket;
  };
  return { dial, dialled, live };
};

/** A connection-health reporter that writes down what it was told; `gate.open = false` is "reconnecting". */
const recordingHealth = () => {
  const gate = { open: true };
  const calls: (
    | { kind: 'answered'; daemonId: DaemonId }
    | { kind: 'outage'; daemonId: DaemonId; outage: CarrierOutage }
    | { kind: 'settled'; daemonId: DaemonId }
  )[] = [];
  const reporter: ConnectionHealthReporter = {
    answered: daemonId => calls.push({ kind: 'answered', daemonId }),
    outage: (daemonId, outage) => calls.push({ kind: 'outage', daemonId, outage }),
    settled: daemonId => calls.push({ kind: 'settled', daemonId }),
    dialAllowed: () => gate.open,
  };
  return { calls, gate, reporter, kinds: () => calls.map(call => call.kind) };
};

const routerFor = async (
  options: {
    reach?: Reach;
    relay?: boolean;
    relayCarrier?: RelayCarrier;
    answer?: Parameters<typeof autoDial>[1];
    deviceKey?: DaemonCarrierRouterOptions['deviceKey'];
    heartbeat?: DaemonCarrierRouterOptions['heartbeat'];
    unknownFatesRemembered?: number;
  } = {},
) => {
  const identity = await newDaemonIdentity();
  const daemon = daemonConnection({
    daemonId: identity.daemonId,
    baseUrl: DAEMON_URL,
    deviceId: DEVICE_ID,
    ...(options.relay === false
      ? {}
      : { carriers: [{ kind: 'direct' as const, daemonUrl: DAEMON_URL }, options.relayCarrier ?? RELAY] }),
  });
  let reach: Reach = options.reach ?? (() => 'live');
  const carriers = carriersFor(identity, () => reach, options.answer ?? {});
  const health = recordingHealth();
  const router = new DaemonCarrierRouter({
    preference: () => 'auto',
    crypto: relayCrypto,
    deviceKey: options.deviceKey ?? deviceKey,
    dial: carriers.dial,
    heartbeat: options.heartbeat ?? (() => () => undefined),
    network: async () => {
      throw new TypeError('Failed to fetch');
    },
    health: health.reporter,
    ...(options.unknownFatesRemembered === undefined ? {} : { unknownFatesRemembered: options.unknownFatesRemembered }),
  });
  router.resolvePaired(() => [daemon]);
  return {
    router,
    daemon,
    identity,
    carriers,
    health,
    setReach: (next: Reach) => {
      reach = next;
    },
  };
};

const rejection = async (pending: Promise<unknown>): Promise<unknown> =>
  await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );

const directDown: Reach = url => (url.hostname === DIRECT_HOST ? 'refuse' : 'live');

describe('the keepalive on a live session', () => {
  const open = async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const timers = manualSchedule();
    const auto = autoDial(identity, { devicePublicKey: device.publicKey });
    const session = await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: timers.schedule,
      mode,
    });
    const socket = auto.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    return { session, socket, timers };
  };

  it('should ping inside the heartbeat interval and close a session that stays silent past the deadline', async () => {
    const { session, socket, timers } = await open();
    expect(timers.armed.map(entry => entry.interval)).toEqual([HEARTBEAT_GRACE_SECONDS * 1_000, KEEPALIVE_INTERVAL_MS]);

    timers.fire(KEEPALIVE_INTERVAL_MS);
    expect(socket.texts).toEqual(['fy-ping']);
    expect(timers.live(KEEPALIVE_DEADLINE_MS)).toBeDefined();

    timers.fire(KEEPALIVE_DEADLINE_MS);
    expect(session.live()).toBe(false);
    expect(socket.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    // Every timer the session held is gone with it, the regular ping included.
    expect(timers.armed.every(entry => entry.cancelled)).toBe(true);
    const failure = await rejection(session.request({ method: 'GET', path: '/v1/health' }));
    expect(failure).toBeInstanceOf(RelaySessionError);
    expect((failure as RelaySessionError).code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    expect((failure as Error).message).toContain('no sign of life for 10 s');
  });

  it('should take any inbound message as life and disarm the deadline', async () => {
    const { session, socket, timers } = await open();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    const deadline = timers.live(KEEPALIVE_DEADLINE_MS);
    socket.onText?.('fy-pong');
    expect(deadline?.cancelled).toBe(true);
    expect(session.live()).toBe(true);
    socket.onClose?.(1000, 'done');
  });

  it('should run an immediate liveness check with a shorter deadline, and never relax it', async () => {
    const { session, socket, timers } = await open();
    // A regular ping is pending; the check replaces its 10 s wait with a 4 s one.
    timers.fire(KEEPALIVE_INTERVAL_MS);
    const regular = timers.live(KEEPALIVE_DEADLINE_MS);
    checkSessionLiveness(session);
    expect(regular?.cancelled).toBe(true);
    expect(timers.live(LIVENESS_CHECK_DEADLINE_MS)).toBeDefined();
    // The next regular ping does not push the short deadline back.
    timers.fire(KEEPALIVE_INTERVAL_MS);
    expect(timers.live(KEEPALIVE_DEADLINE_MS)).toBeUndefined();
    expect(socket.texts).toEqual(['fy-ping', 'fy-ping', 'fy-ping']);
    timers.fire(LIVENESS_CHECK_DEADLINE_MS);
    expect(session.live()).toBe(false);
    expect(socket.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    // A session that has ended is no longer checked: nothing is sent.
    checkSessionLiveness(session);
    expect(socket.texts).toHaveLength(3);
  });

  it('should mark a failure from a socket that never opened, and only that', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const dialAndClose = (opened: boolean) => (): ScriptedSocket => {
      const socket = new ScriptedSocket();
      queueMicrotask(() => {
        if (opened) socket.onOpen?.();
        socket.onClose?.(1006, 'gone');
      });
      return socket;
    };
    const attempt = async (opened: boolean) =>
      await rejection(
        openRelaySession({
          crypto: relayCrypto,
          dial: dialAndClose(opened),
          daemon,
          method: RELAY,
          heartbeat: () => () => undefined,
          mode,
        }),
      );
    expect(socketNeverOpened(await attempt(false))).toBe(true);
    expect(socketNeverOpened(await attempt(true))).toBe(false);
    expect(socketNeverOpened('a string')).toBe(false);
    expect(socketNeverOpened(null)).toBe(false);
  });
});

describe('a remembered winner that dies', () => {
  it('should walk a READ again inside the same call and answer it on the next carrier', async () => {
    const { router, daemon, carriers, health, setReach } = await routerFor();
    expect((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).toBe(200);
    setReach(directDown);
    carriers.live.sockets[0]?.onClose?.(1006, 'the relay was redeployed');
    expect((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).toBe(200);
    expect(carriers.dialled).toEqual([DIRECT_HOST, DIRECT_HOST, DIRECT_HOST, 'relay.example']);
    expect(health.kinds()).toEqual(['answered', 'answered']);
  });

  it('should never send a WRITE twice when its session died after it left', async () => {
    const { router, daemon, carriers, health } = await routerFor({
      answer: { closeOnRequest: index => (index === 1 ? { code: 1006, reason: 'dropped' } : undefined) },
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const failure = await rejection(
      router.send(daemon, `${DAEMON_URL}/v1/sessions`, { method: 'POST', body: '{"name":"x"}' }),
    );
    expect(failure).toBeInstanceOf(CarrierUnavailableError);
    expect((failure as CarrierUnavailableError).delivery).toBe('unknown');
    expect(provenUnsent(failure)).toBe(false);
    expect(carriers.live.requests.filter(request => (request as { method: string }).method === 'POST')).toHaveLength(1);
    expect(carriers.dialled).toEqual([DIRECT_HOST]);
    expect(router.choice(daemon.daemonId)).toBeUndefined();
    expect(health.kinds()).toEqual(['answered', 'outage']);
  });

  it('should say a write whose carrier could not even reopen was never sent, and still not walk it on', async () => {
    const { router, daemon, carriers, setReach } = await routerFor();
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    setReach(directDown);
    carriers.live.sockets[0]?.onClose?.(1006, 'the laptop left the network');
    const failure = await rejection(router.send(daemon, `${DAEMON_URL}/v1/sessions`, { method: 'POST', body: '{}' }));
    expect(failure).toBeInstanceOf(CarrierUnavailableError);
    expect(provenUnsent(failure)).toBe(true);
    expect((failure as CarrierUnavailableError).outage.failures.map(entry => entry.label)).toEqual(['Direct']);
    expect(carriers.dialled).toEqual([DIRECT_HOST, DIRECT_HOST]);
  });

  it('should hand back a failure that is not about the carrier exactly as it came', async () => {
    let keyed = true;
    const { router, daemon, carriers, health } = await routerFor({
      deviceKey: async () => (keyed ? device.claim.key : undefined),
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    keyed = false;
    carriers.live.sockets[0]?.onClose?.(1006, 'gone');
    const failure = await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`));
    expect(failure).not.toBeInstanceOf(CarrierUnavailableError);
    expect(isCarrierOutage(failure)).toBe(false);
    // Nothing to report: this is the pairing's problem, not the network's.
    expect(health.kinds()).toEqual(['answered']);
  });
});

describe('no carrier at all', () => {
  it('should throw a typed outage in the walk’s own words, naming each carrier once', async () => {
    const { router, daemon, health } = await routerFor({ reach: () => 'refuse' });
    const failure = await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`));
    expect(failure).toBeInstanceOf(CarrierUnavailableError);
    const outage = failure as CarrierUnavailableError;
    expect(outage.message).toStartWith('No configured connection worked:');
    expect(outage.outage.failures.map(entry => entry.label)).toEqual(['Direct', 'Hosted relay']);
    expect(outage.outage.relaysNeverOpened).toBe(true);
    expect(outage.outage.daemonAbsent).toBe(false);
    expect(outage.delivery).toBe('unsent');
    expect(health.calls).toEqual([{ kind: 'outage', daemonId: daemon.daemonId, outage: outage.outage }]);
  });

  it('should name a spent relay data allowance plainly, on the hosted relay it came from', async () => {
    // A device that has not discovered the hosted address files the relay as somebody's own; the
    // hosted-only refusal is what corrects the label.
    const { router, daemon } = await routerFor({
      reach: url => (url.hostname === DIRECT_HOST ? 'refuse' : 'spent'),
      relayCarrier: { ...RELAY, operator: 'self' },
    });
    const outage = (await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`))) as CarrierUnavailableError;
    expect(outage).toBeInstanceOf(CarrierUnavailableError);
    const [direct, relayed] = outage.outage.failures;
    expect(direct?.label).toBe('Direct');
    expect(relayed?.label).toBe('Hosted relay');
    expect(relayed?.detail).toStartWith("Today's relay data allowance for this machine is used up (resets at ");
    expect(relayed?.detail).toContain('Direct connections still work.');
  });

  it('should tell a relay with no daemon behind it from a relay nobody could reach', async () => {
    const { router, daemon } = await routerFor({
      reach: url => (url.hostname === DIRECT_HOST ? 'refuse' : 'absent'),
    });
    const failure = (await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`))) as CarrierUnavailableError;
    expect(failure.outage.daemonAbsent).toBe(true);
    expect(failure.outage.relaysNeverOpened).toBe(false);
  });

  it('should keep a write in doubt across retries under one request id', async () => {
    const { router, daemon, setReach } = await routerFor({
      relay: false,
      answer: { closeOnRequest: () => ({ code: 1006, reason: 'dropped' }) },
    });
    const post = (id: string) =>
      rejection(
        router.send(daemon, `${DAEMON_URL}/v1/sessions`, {
          method: 'POST',
          body: '{}',
          headers: { [FY_REQUEST_ID_HEADER]: id },
        }),
      );
    // The first attempt left and died; the retry under the SAME id never opened. Still unknown.
    expect(carrierDelivery(await post('send-1'))).toBe('unknown');
    setReach(() => 'refuse');
    expect(carrierDelivery(await post('send-1'))).toBe('unknown');
    // A different id with nothing in doubt is proven unsent.
    expect(carrierDelivery(await post('send-2'))).toBe('unsent');
  });

  it('should remember only a bounded number of ids in doubt, forgetting the oldest first', async () => {
    // A small bound: every id put in doubt costs a whole session handshake, and hundreds of them were
    // seconds of CPU on a busy runner for the same eviction a handful proves.
    const remembered = 4;
    const { router, daemon, setReach } = await routerFor({
      relay: false,
      answer: { closeOnRequest: () => ({ code: 1006, reason: 'dropped' }) },
      unknownFatesRemembered: remembered,
    });
    const post = (id: string) =>
      rejection(
        router.send(daemon, `${DAEMON_URL}/v1/sessions`, {
          method: 'POST',
          body: '{}',
          headers: { [FY_REQUEST_ID_HEADER]: id },
        }),
      );
    for (let index = 0; index <= remembered; index += 1) await post(`doubt-${String(index)}`);
    setReach(() => 'refuse');
    expect(carrierDelivery(await post('doubt-0'))).toBe('unsent');
    expect(carrierDelivery(await post('doubt-1'))).toBe('unknown');
    expect(carrierDelivery(await post(`doubt-${String(remembered)}`))).toBe('unknown');
  });
});

describe('what the connection model is told', () => {
  it('should settle, not report an outage, when the daemon refuses this device', async () => {
    const { router, daemon, health } = await routerFor({ relay: false, answer: { rejectDevice: true } });
    await expect(router.send(daemon, `${DAEMON_URL}/v1/projects`)).rejects.toBeInstanceOf(DeviceNotAcceptedError);
    expect(health.kinds()).toEqual(['settled']);
  });

  it('should settle when the daemon speaks another dialect', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [RELAY],
    });
    const older = olderDaemonDial();
    const health = recordingHealth();
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      heartbeat: () => () => undefined,
      dial: older.dial,
      health: health.reporter,
    });
    await expect(router.send(daemon, `${DAEMON_URL}/v1/projects`)).rejects.toBeInstanceOf(DaemonOutdatedError);
    expect(health.kinds()).toEqual(['settled']);
  });

  it('should report a stream that opened, and a stream the daemon refused, as answers', async () => {
    const opened = await routerFor();
    await opened.router.openStream(opened.daemon, { path: '/v1/events', onData: () => undefined });
    expect(opened.health.kinds()).toEqual(['answered']);

    const refused = await routerFor({ answer: { streamRefused: { status: 403, body: '{"error":"no"}' } } });
    await expect(
      refused.router.openStream(refused.daemon, { path: '/v1/events', onData: () => undefined }),
    ).rejects.toBeInstanceOf(RelayStreamRefusedError);
    expect(refused.health.kinds()).toEqual(['answered']);
  });

  it('should report a stream no carrier could open as an outage', async () => {
    const { router, daemon, health } = await routerFor({ reach: () => 'refuse' });
    await expect(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).rejects.toBeInstanceOf(
      CarrierUnavailableError,
    );
    expect(health.kinds()).toEqual(['outage']);
  });

  it('should report a stream whose remembered carrier stopped carrying as an outage, keeping the winner', async () => {
    const { router, daemon, health, setReach } = await routerFor({ relay: false });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    setReach(() => 'refuse');
    const failure = await rejection(router.openStream(daemon, { path: '/v1/events', onData: () => undefined }));
    expect(failure).toBeInstanceOf(CarrierUnavailableError);
    expect(provenUnsent(failure)).toBe(true);
    expect(router.choice(daemon.daemonId)?.ok).toBe(true);
    expect(health.kinds()).toEqual(['answered', 'outage']);
  });

  it('should hand back the daemon refusing a stream on the remembered carrier as the refusal', async () => {
    const { router, daemon, health } = await routerFor({
      relay: false,
      answer: { streamRefused: { status: 404, body: '{"error":"gone"}' } },
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    await expect(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).rejects.toBeInstanceOf(
      RelayStreamRefusedError,
    );
    expect(health.kinds()).toEqual(['answered', 'answered']);
  });
});

describe('a liveness check across every held session', () => {
  it('should ping every live session the router holds, and pass over one that never opened', async () => {
    const timers = manualSchedule();
    const { router, daemon, carriers, setReach } = await routerFor({ heartbeat: timers.schedule });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    await router.openStream(daemon, { path: '/v1/events', onData: () => undefined });
    // A stream whose dial failed is still in the map while it fails; it must be skipped, not thrown.
    setReach(() => 'refuse');
    const failing = rejection(router.openStream(daemon, { path: '/v1/events', onData: () => undefined }));
    router.checkLiveness();
    await settle(5);
    await failing;
    expect(carriers.live.sockets.map(socket => socket.texts)).toEqual([['fy-ping'], ['fy-ping']]);
    // Armed and still waiting: the direct opening deadlines share the number, but they were disarmed.
    expect(
      timers.armed.filter(entry => entry.interval === LIVENESS_CHECK_DEADLINE_MS && !entry.cancelled),
    ).toHaveLength(2);
  });
});

describe('reading an outage out of a wrapped error', () => {
  const outage = new CarrierUnavailableError(
    'no carrier',
    { failures: [], daemonAbsent: false, relaysNeverOpened: false },
    'unsent',
  );

  it('should find it through a cause chain, a few levels deep and no deeper', () => {
    const wrapped = new Error('could not reach fyd', { cause: new Error('transport', { cause: outage }) });
    expect(isCarrierOutage(wrapped)).toBe(true);
    expect(carrierDelivery(wrapped)).toBe('unsent');
    expect(provenUnsent(wrapped)).toBe(true);
    let deep: Error = outage;
    for (let level = 0; level < 4; level += 1) deep = new Error('wrap', { cause: deep });
    expect(isCarrierOutage(deep)).toBe(false);
    expect(carrierDelivery('not an error')).toBeUndefined();
    expect(provenUnsent(new Error('a daemon answer'))).toBe(false);
  });
});

describe('while the daemon is reconnecting', () => {
  it('should dial nothing for a caller and say so as a proven-unsent, unreported outage', async () => {
    const { router, daemon, carriers, health } = await routerFor({ reach: () => 'refuse' });
    health.gate.open = false;
    const read = await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`));
    const write = await rejection(router.send(daemon, `${DAEMON_URL}/v1/sessions`, { method: 'POST', body: '{}' }));
    const stream = await rejection(router.openStream(daemon, { path: '/v1/events', onData: () => undefined }));
    for (const failure of [read, write, stream]) {
      expect(failure).toBeInstanceOf(CarrierUnavailableError);
      expect((failure as CarrierUnavailableError).deferred).toBe(true);
      expect(provenUnsent(failure)).toBe(true);
    }
    expect((read as Error).message).toBe(DIAL_DEFERRED_REASON);
    // Not a socket opened, and nothing told to the model: it is the one doing the dialling.
    expect(carriers.dialled).toEqual([]);
    expect(health.calls).toEqual([]);
  });

  it('should let the model’s own attempt dial, and report what it found', async () => {
    const { router, daemon, carriers, health } = await routerFor();
    health.gate.open = false;
    expect((await router.probe(daemon, `${DAEMON_URL}/v1/carriers`)).status).toBe(200);
    expect(carriers.dialled).toEqual([DIRECT_HOST]);
    expect(health.kinds()).toEqual(['answered']);
  });

  it('should keep using a session that is already live', async () => {
    const { router, daemon, carriers, health } = await routerFor();
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    health.gate.open = false;
    expect((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).toBe(200);
    expect(carriers.dialled).toEqual([DIRECT_HOST]);
  });

  it('should forget a dead winner without replacing it, and keep a write in doubt in doubt', async () => {
    const { router, daemon, carriers, health } = await routerFor({
      answer: { closeOnRequest: index => (index === 1 ? { code: 1006, reason: 'dropped' } : undefined) },
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const post = () =>
      rejection(
        router.send(daemon, `${DAEMON_URL}/v1/sessions`, {
          method: 'POST',
          body: '{}',
          headers: { [FY_REQUEST_ID_HEADER]: 'send-9' },
        }),
      );
    expect(carrierDelivery(await post())).toBe('unknown');
    health.gate.open = false;
    // The winner was already forgotten by the failure above; a read now walks into the gate.
    const read = await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`));
    expect((read as CarrierUnavailableError).deferred).toBe(true);
    const again = await post();
    expect((again as CarrierUnavailableError).deferred).toBe(true);
    expect(carrierDelivery(again)).toBe('unknown');
    expect(carriers.dialled).toEqual([DIRECT_HOST]);
  });

  it('should forget a remembered winner whose session died rather than redial it', async () => {
    const { router, daemon, carriers, health } = await routerFor();
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    await router.openStream(daemon, { path: '/v1/events', onData: () => undefined });
    carriers.live.sockets[0]?.onClose?.(1006, 'the relay was redeployed');
    health.gate.open = false;
    const read = await rejection(router.send(daemon, `${DAEMON_URL}/v1/projects`));
    expect((read as CarrierUnavailableError).deferred).toBe(true);
    expect(router.choice(daemon.daemonId)).toBeUndefined();
    const stream = await rejection(router.openStream(daemon, { path: '/v1/events', onData: () => undefined }));
    expect((stream as CarrierUnavailableError).deferred).toBe(true);
    expect(carriers.dialled).toEqual([DIRECT_HOST, DIRECT_HOST]);
  });

  it('should gate a stream on a remembered winner too', async () => {
    const { router, daemon, carriers, health } = await routerFor();
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    health.gate.open = false;
    const stream = await rejection(router.openStream(daemon, { path: '/v1/events', onData: () => undefined }));
    expect((stream as CarrierUnavailableError).deferred).toBe(true);
    expect(carriers.dialled).toEqual([DIRECT_HOST]);
    expect(router.choice(daemon.daemonId)?.ok).toBe(true);
  });
});
