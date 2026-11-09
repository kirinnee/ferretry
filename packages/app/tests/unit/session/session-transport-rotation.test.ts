import { describe, expect, test } from 'bun:test';
import type { SessionDeviceClaim } from '../../../src/session/session-client.ts';
import {
  NO_DEVICE_KEY,
  type RotatingSession,
  type RotationRequest,
  type SessionKeyRotation,
  SessionTransport,
} from '../../../src/session/session-transport.ts';
import type { PrivateKeyHandle } from '../../../src/session/wire/index.ts';
import { newDaemonIdentity, relayCrypto, settle, testDevice } from '../../../src/testing/relay.ts';
import { rotatingDial, type RotatingRequest } from '../../../src/testing/rotating-daemon.ts';

/**
 * THE SESSION LAYER'S HALF OF DEVICE-KEY ROTATION (R248, R252): what the transport does with the port Access provides.
 * The rotation here is a recording fake (Access's `KeyRotation` is proved through this same transport in Access's
 * suite); the session is real, so "the proof rides the session that carries the request" is checked on a real one.
 */

const PAST = '2026-10-01T00:00:00.000Z';
const ASSERTION = { credentialId: 'c', clientDataJSON: 'd', authenticatorData: 'a', signature: 's' };
const UNLOCK = { method: 'POST', path: '/v1/unlock', body: ASSERTION } as const;

interface Recorded {
  readonly calls: string[];
  readonly sessions: RotatingSession[];
  pendingKey: PrivateKeyHandle | undefined;
}

/** A rotation that amends every unlock/step-up it is shown on a due session, and records every call. */
const recordingRotation = (recorded: Recorded): SessionKeyRotation => ({
  amend: async <Request extends RotationRequest>(
    session: RotatingSession,
    daemon: { readonly daemonId: string; readonly deviceId: string },
    request: Request,
  ) => {
    recorded.calls.push(`amend ${request.method} ${request.path} ${daemon.deviceId}`);
    recorded.sessions.push(session);
    const due = session.rotateBy() !== undefined && request.method === 'POST' && request.path === '/v1/unlock';
    if (!due) return { request, rotated: false };
    return { request: { ...request, body: { ...(request.body as object), rotation: 'R' } }, rotated: true };
  },
  settle: async (_daemonId, answer) => {
    recorded.calls.push(`settle ${answer.status} ${JSON.stringify(answer.body)}`);
  },
  pending: async () => {
    recorded.calls.push('pending');
    return recorded.pendingKey;
  },
  promote: async () => {
    recorded.calls.push('promote');
  },
  discard: async () => {
    recorded.calls.push('discard');
  },
});

const rig = async (
  options: {
    readonly drop?: boolean;
    readonly accepts?: () => readonly string[];
    /** Dials from this count on fail as an unreachable carrier does. */
    readonly failFrom?: number;
  } = {},
) => {
  const identity = await newDaemonIdentity();
  const device = await testDevice('fy_dev_rotation');
  const seen: RotatingRequest[] = [];
  const route = rotatingDial(identity, {
    accepts: options.accepts ?? (() => [device.publicKey]),
    failFrom: () => options.failFrom,
    rotateBy: () => PAST,
    respond: async request => {
      seen.push(request);
      if (options.drop === true && request.path === '/v1/unlock') return 'drop';
      return { status: 200, body: request.path === '/v1/unlock' ? { unlockedUntil: PAST, keyRotated: true } : {} };
    },
  });
  const recorded: Recorded = { calls: [], sessions: [], pendingKey: undefined };
  const claims: SessionDeviceClaim[] = [];
  const transport = new SessionTransport({
    crypto: relayCrypto,
    daemonId: identity.daemonId,
    device: device.claim,
    claim: async () => {
      claims.push(device.claim);
      return device.claim;
    },
    rotation: recordingRotation(recorded),
    dial: route.dial,
  });
  return { transport, route, seen, recorded, claims, device };
};

describe('R248 the session transport carrying a rotation', () => {
  test('R248 amends an unlock on the session that carries it and settles the rotation on the answer', async () => {
    const test = await rig();

    const answer = await test.transport.request(UNLOCK);

    expect(answer.status).toBe(200);
    // The amended body is what crossed; the rotation was asked on the live session, which knew its `rotateBy`.
    expect(JSON.parse(String(test.seen[0]?.body))).toEqual({ ...ASSERTION, rotation: 'R' });
    expect(test.recorded.sessions[0]?.rotateBy()).toBe(PAST);
    expect(test.recorded.calls).toEqual([
      'amend POST /v1/unlock fy_dev_rotation',
      `settle 200 ${JSON.stringify({ unlockedUntil: PAST, keyRotated: true })}`,
    ]);
  });

  test('R248 settles nothing for a request the rotation left alone', async () => {
    const test = await rig();
    await test.transport.request({ method: 'GET', path: '/v1/plugins' });
    expect(test.recorded.calls).toEqual(['amend GET /v1/plugins fy_dev_rotation']);
    expect(test.seen[0]?.body).toBeUndefined();
  });

  test('R252 leaves the rotation pending when the request died without an answer', async () => {
    const test = await rig({ drop: true });
    await expect(test.transport.request(UNLOCK)).rejects.toThrow();
    // No settle: the daemon may have swapped and the answer is what was lost.
    expect(test.recorded.calls).toEqual(['amend POST /v1/unlock fy_dev_rotation']);
    // And an unlock is never sent again on another session.
    expect(test.seen).toHaveLength(1);
  });

  test('R252 a request the old key is refused on is answered over the pending key, which is promoted', async () => {
    const pending = await testDevice('fy_dev_rotation');
    const test = await rig({ accepts: () => [pending.publicKey] });
    test.recorded.pendingKey = pending.claim.key;

    const answer = await test.transport.request({ method: 'GET', path: '/v1/plugins' });

    expect(answer.status).toBe(200);
    expect(test.recorded.calls).toEqual(['pending', 'promote', 'amend GET /v1/plugins fy_dev_rotation']);
    expect(test.route.credentials.map(credential => credential.accepted)).toEqual([false, true]);
  });

  test('R252 a request refused on the pending key too discards it and reports the first refusal', async () => {
    const pending = await testDevice('fy_dev_rotation');
    const test = await rig({ accepts: () => [] });
    test.recorded.pendingKey = pending.claim.key;

    const failure = await test.transport.request({ method: 'GET', path: '/v1/plugins' }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(failure).toMatchObject({ name: 'RelaySessionError', code: 4403 });
    expect(test.recorded.calls).toEqual(['pending', 'discard']);
  });

  test('C1 a pending-key attempt that dies on the carrier surfaces as the carrier failure, never the first 4403', async () => {
    const pending = await testDevice('fy_dev_rotation');
    // The old key is refused (the daemon already swapped), then the pending key's session dies on the carrier.
    const test = await rig({ accepts: () => [], failFrom: 1 });
    test.recorded.pendingKey = pending.claim.key;

    const failure = await test.transport.request({ method: 'GET', path: '/v1/plugins' }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(failure).toMatchObject({ name: 'RelaySessionError', code: 1006 });
    // The pending key is kept for the next session: nothing was discarded, nothing promoted.
    expect(test.recorded.calls).toEqual(['pending']);
  });

  test('R252 reads the claim again for every session it opens', async () => {
    const test = await rig();
    await test.transport.request({ method: 'GET', path: '/v1/plugins' });
    test.transport.close();
    await test.transport.request({ method: 'GET', path: '/v1/plugins' });
    expect(test.claims).toHaveLength(2);
  });

  test('R252 a claim reader that finds no key opens nothing', async () => {
    const identity = await newDaemonIdentity();
    const device = await testDevice();
    const route = rotatingDial(identity, {
      accepts: () => [device.publicKey],
      respond: async () => ({ status: 200, body: {} }),
    });
    const gone = new SessionTransport({
      crypto: relayCrypto,
      daemonId: identity.daemonId,
      device: device.claim,
      claim: async () => undefined,
      dial: route.dial,
    });
    await expect(gone.request({ method: 'GET', path: '/v1/plugins' })).rejects.toThrow(NO_DEVICE_KEY);
    expect(route.dialled()).toBe(0);
  });
});

describe('R252 a stream session the old key is refused on', () => {
  test('R252 tries the pending key once and promotes it when the daemon accepts it', async () => {
    const pending = await testDevice('fy_dev_rotation');
    const test = await rig({ accepts: () => [pending.publicKey] });
    test.recorded.pendingKey = pending.claim.key;
    const events: string[] = [];

    test.transport.socket('/v1/events', {
      onOpen: () => events.push('open'),
      onFrame: () => undefined,
      onClose: reason => events.push(`closed ${reason}`),
    });
    await settle();

    expect(events).toEqual(['open']);
    expect(test.recorded.calls).toEqual(['pending', 'promote']);
    expect(test.route.credentials.map(credential => credential.accepted)).toEqual([false, true]);
  });

  test('C1 a pending-key stream that dies on the carrier closes with the carrier failure and keeps the key', async () => {
    const pending = await testDevice('fy_dev_rotation');
    const test = await rig({ accepts: () => [], failFrom: 1 });
    test.recorded.pendingKey = pending.claim.key;
    const closes: (number | undefined)[] = [];

    test.transport.socket('/v1/events', {
      onFrame: () => undefined,
      onClose: (_reason, code) => closes.push(code),
    });
    await settle();

    expect(closes).toEqual([1006]);
    expect(test.recorded.calls).toEqual(['pending']);
  });

  test('R252 discards the pending key when it is refused too, and closes with the first refusal', async () => {
    const pending = await testDevice('fy_dev_rotation');
    const test = await rig({ accepts: () => [] });
    test.recorded.pendingKey = pending.claim.key;
    const events: string[] = [];

    test.transport.socket('/v1/events', {
      onFrame: () => undefined,
      onClose: reason => events.push(`closed ${reason}`),
    });
    await settle();

    expect(events).toEqual(['closed the rendezvous ended this session: 4403 unknown device credential']);
    expect(test.recorded.calls).toEqual(['pending', 'discard']);
    expect(test.route.credentials).toHaveLength(2);
  });
});
