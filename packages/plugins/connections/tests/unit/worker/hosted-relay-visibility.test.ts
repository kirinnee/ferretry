import { describe } from 'bun:test';
import should from 'should';
import {
  admitHostedRelayConnection,
  configureHostedRelay,
  DEFAULT_HOSTED_RELAY_LIMITS,
  FRAME_KINDS,
  HOSTED_RELAY_CONFIG_VERSION,
  type HostedRelayDaemonMetrics,
  type HostedRelayGlobalMetrics,
  hostedBandwidthReason,
  initialHostedRelayGlobalMetrics,
  initialRendezvousState,
  MAX_SESSIONS_PER_RENDEZVOUS,
  meterHostedRelayRequest,
  readHostedBandwidthRefusal,
  type RendezvousEffect,
  type RendezvousState,
  reduceRendezvous,
  SESSION_CLOSE_CODES,
  type SessionFrame,
  type SessionId,
  sessionIdFromBytes,
} from '../../../worker/src/lib/index.ts';
import { guarantee } from '../../support/guarantee.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const otherDaemonId = `fy_daemon_${'b'.repeat(43)}`;
const host = 'relay.example';
const goodVerdict = { ok: true, publicKeySpki: new Uint8Array(44) } as const;
const at = 1_000_000_000;

function sessionId(fill: number): SessionId {
  const built = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (built === null) throw new Error('fixture session id is malformed');
  return built;
}

function data(target: SessionId, sequence: number, payload: Uint8Array): SessionFrame {
  return { kind: FRAME_KINDS.data, sessionId: target, sequence, payload };
}

function claimedDaemon(): RendezvousState {
  const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
    kind: 'daemon-arrived',
    socketId: 'daemon',
    challenge: new Uint8Array(32).fill(7),
    host,
    at: 1_000,
  });
  return reduceRendezvous(arrived.state, { kind: 'claim-verdict', socketId: 'daemon', verdict: goodVerdict, at: 1_000 })
    .state;
}

function closures(effects: readonly RendezvousEffect[]) {
  return effects.flatMap(effect =>
    effect.kind === 'close' ? [{ socketId: effect.socketId, code: effect.code, reason: effect.reason }] : [],
  );
}

/** Every frame the step would put on a socket, other than the relay's own control messages. */
function forwarded(effects: readonly RendezvousEffect[]) {
  return effects.flatMap(effect =>
    effect.kind === 'send' && effect.frame.kind !== FRAME_KINDS.control
      ? [{ socketId: effect.socketId, frame: effect.frame }]
      : [],
  );
}

/** A value as text with every byte string spelled out, so a payload cannot hide inside a typed array. */
function asText(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof Uint8Array ? new TextDecoder().decode(inner) : inner,
  );
}

function hostedConfig() {
  return configureHostedRelay(
    { version: HOSTED_RELAY_CONFIG_VERSION, relayUrl: 'https://relay.example/', limits: DEFAULT_HOSTED_RELAY_LIMITS },
    at,
  );
}

describe('hosted relay visibility and squatting', () => {
  guarantee(
    ['R165'],
    "should keep a fingerprint squatter out of the slot, the sessions and the frames, and inside that fingerprint's own ceiling",
    () => {
      // A squatter knows the public fingerprint but not the key: its claim does not verify.
      const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
        kind: 'daemon-arrived',
        socketId: 'squatter',
        challenge: new Uint8Array(32),
        host,
        at: 1_000,
      });
      const refused = reduceRendezvous(arrived.state, {
        kind: 'claim-verdict',
        socketId: 'squatter',
        verdict: { ok: false, reason: 'claim signature failed' },
        at: 1_100,
      });
      // CAN'T CLAIM: the socket is closed and the slot stays empty.
      should(closures(refused.effects)).match([{ socketId: 'squatter', code: SESSION_CLOSE_CODES.claimRejected }]);
      should(refused.state.daemon).be.null();

      // CAN'T OPEN: with no daemon holding the rendezvous a client is refused, never parked for the squatter.
      const client = reduceRendezvous(refused.state, {
        kind: 'client-arrived',
        socketId: 'phone',
        sessionId: sessionId(1),
        at: 1_200,
      });
      should(closures(client.effects)[0]?.code).equal(SESSION_CLOSE_CODES.daemonAbsent);
      should(client.state.sessions).deepEqual([]);

      // CAN'T READ: beside a real daemon and a real session, a squatter's second socket is turned away, and a
      // data frame it sends for that session reaches nobody.
      const real = reduceRendezvous(claimedDaemon(), {
        kind: 'client-arrived',
        socketId: 'phone',
        sessionId: sessionId(1),
        at: 2_000,
      });
      const squatting = reduceRendezvous(real.state, {
        kind: 'daemon-arrived',
        socketId: 'squatter',
        challenge: new Uint8Array(32),
        host,
        at: 2_100,
      });
      should(closures(squatting.effects)[0]).match({
        socketId: 'squatter',
        code: SESSION_CLOSE_CODES.rendezvousClaimed,
      });
      should(squatting.state.daemon?.socketId).equal('daemon');
      const snooped = reduceRendezvous(squatting.state, {
        kind: 'frame',
        socketId: 'squatter',
        frame: data(sessionId(1), 1, new Uint8Array([9])),
        at: 2_200,
      });
      should(forwarded(snooped.effects)).deepEqual([]);
      should(snooped.state.sessions[0]?.fromClient.sent).equal(0);
      should(snooped.state.sessions[0]?.fromDaemon.sent).equal(0);

      // PER-DAEMON CEILING: whatever the squatter opens is charged to the squatted fingerprint alone.
      const config = hostedConfig();
      let global: HostedRelayGlobalMetrics = initialHostedRelayGlobalMetrics(at);
      let daemon: HostedRelayDaemonMetrics | null = null;
      for (let index = 0; index < DEFAULT_HOSTED_RELAY_LIMITS.maxConcurrentConnectionsPerDaemon; index += 1) {
        const step = admitHostedRelayConnection(config, global, daemon, daemonId, at + index);
        should(step.decision).deepEqual({ ok: true });
        global = step.global;
        daemon = step.daemon;
      }
      const overflow = admitHostedRelayConnection(config, global, daemon, daemonId, at + 100);
      should(overflow.decision).match({ ok: false, code: SESSION_CLOSE_CODES.hostedCapacity });
      // Another fingerprint is untouched by it.
      const other = admitHostedRelayConnection(config, overflow.global, null, otherDaemonId, at + 101);
      should(other.decision).deepEqual({ ok: true });
      should(other.daemon?.concurrentConnections).equal(1);
    },
  );

  guarantee(
    ['R168'],
    'should treat the same-sized bytes alike whatever they are: the relay holds no content to tell abuse from use',
    () => {
      const benign = new TextEncoder().encode('hello, here is my lunch order please '.padEnd(256, '.'));
      const abusive = new TextEncoder().encode('curl http://127.0.0.1/ && rm -rf  ~ #'.padEnd(256, '#'));
      should(benign.length).equal(abusive.length);
      should(benign).not.deepEqual(abusive);

      const through = (payload: Uint8Array) => {
        const opened = reduceRendezvous(claimedDaemon(), {
          kind: 'client-arrived',
          socketId: 'phone',
          sessionId: sessionId(1),
          at: 2_000,
        });
        return reduceRendezvous(opened.state, {
          kind: 'frame',
          socketId: 'phone',
          frame: data(sessionId(1), 1, payload),
          at: 3_000,
        });
      };
      const fromBenign = through(benign);
      const fromAbusive = through(abusive);
      // The state the relay keeps is identical, byte for byte, so nothing in it can separate the two.
      should(fromAbusive.state).deepEqual(fromBenign.state);
      should(fromAbusive.effects.map(effect => effect.kind)).deepEqual(fromBenign.effects.map(effect => effect.kind));
      should(closures(fromAbusive.effects)).deepEqual([]);

      // The meter takes a count of bytes and nothing else, so equal counts are billed and refused identically.
      const config = hostedConfig();
      const admitted = admitHostedRelayConnection(config, initialHostedRelayGlobalMetrics(at), null, daemonId, at);
      if (admitted.daemon === null) throw new Error('admission was refused');
      const meterA = meterHostedRelayRequest(config, admitted.global, admitted.daemon, benign.length, at + 1);
      const meterB = meterHostedRelayRequest(config, admitted.global, admitted.daemon, abusive.length, at + 1);
      should(meterB).deepEqual(meterA);
    },
  );

  guarantee(
    ['R169'],
    'should show nobody a payload, token or code, and no more at a cap than when the relay is idle',
    () => {
      const secret = 'pairing-code-482913-bearer-token-ghp_exampleexampleexample';
      const payload = new TextEncoder().encode(secret);
      const opened = reduceRendezvous(claimedDaemon(), {
        kind: 'client-arrived',
        socketId: 'phone-0',
        sessionId: sessionId(1),
        at: 2_000,
      });
      const carried = reduceRendezvous(opened.state, {
        kind: 'frame',
        socketId: 'phone-0',
        frame: data(sessionId(1), 1, payload),
        at: 3_000,
      });
      // The frame crosses as bytes the relay never decodes; what it keeps is counters.
      should(forwarded(carried.effects)).have.length(1);
      should(asText(carried.state)).not.containEql(secret);
      should(asText(carried.state)).not.containEql('482913');
      // NOT EVEN A FRAGMENT: the same step with different bytes of the same length leaves identical state, so no prefix,
      // window or hash of the payload is kept (a stored prefix would differ between the two).
      const other = new TextEncoder().encode(secret.replace(/[a-z0-9]/gu, 'x'));
      should(other.length).equal(payload.length);
      should(other).not.deepEqual(payload);
      const carriedOther = reduceRendezvous(opened.state, {
        kind: 'frame',
        socketId: 'phone-0',
        frame: data(sessionId(1), 1, other),
        at: 3_000,
      });
      should(carriedOther.state).deepEqual(carried.state);

      // SESSION CAP (the 4433 family): fill the daemon's session slots, then ask for one more.
      let state = carried.state;
      for (let index = 1; index < MAX_SESSIONS_PER_RENDEZVOUS; index += 1) {
        state = reduceRendezvous(state, {
          kind: 'client-arrived',
          socketId: `phone-${index}`,
          sessionId: sessionId(index + 1),
          at: 4_000 + index,
        }).state;
      }
      const capped = reduceRendezvous(state, {
        kind: 'client-arrived',
        socketId: 'one-too-many',
        sessionId: sessionId(200),
        at: 5_000,
      });
      should(closures(capped.effects)).have.length(1);
      should(closures(capped.effects)[0]?.reason).match(/session limit/u);
      for (const text of [asText(capped.effects), asText(capped.state)]) {
        should(text).not.containEql(secret);
        should(text).not.containEql('482913');
      }

      // BYTE CAP (4433): the refusal names a scope, a window and a reset; it carries no byte of anyone's traffic.
      const config = configureHostedRelay(
        {
          version: HOSTED_RELAY_CONFIG_VERSION,
          relayUrl: 'https://relay.example/',
          limits: { ...DEFAULT_HOSTED_RELAY_LIMITS, maxBytesPerMinutePerDaemon: payload.length - 1 },
        },
        at,
      );
      const admitted = admitHostedRelayConnection(config, initialHostedRelayGlobalMetrics(at), null, daemonId, at);
      if (admitted.daemon === null) throw new Error('admission was refused');
      const metered = meterHostedRelayRequest(config, admitted.global, admitted.daemon, payload.length, at + 1);
      should(metered.decision).match({ ok: false, code: SESSION_CLOSE_CODES.hostedBandwidth });
      if (metered.decision.ok) throw new Error('expected a byte-ceiling refusal');
      should(readHostedBandwidthRefusal(metered.decision.reason)).match({ scope: 'daemon', window: 'minute' });
      should(JSON.stringify(metered)).not.containEql(secret);
      should(hostedBandwidthReason('daemon minute allowance', at)).not.containEql(secret);
    },
  );
});
