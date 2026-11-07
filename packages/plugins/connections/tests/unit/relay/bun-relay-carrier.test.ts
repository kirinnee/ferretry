import { describe, it } from 'bun:test';
import should from 'should';
import { BunRelayCarrier, type RelayWebSocket } from '../../../daemon/adapters/relay/bun-relay-carrier.ts';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type SessionId,
  sessionIdFromBytes,
  toBase64Url,
} from '@ferretry/kernel/wire';
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from '../../../daemon/lib/relay/control.ts';
import { HOSTED_RELAY_BANDWIDTH_REASONS, hostedBandwidthReason } from '../../../daemon/lib/relay/bandwidth.ts';
import {
  ConfiguredRelayCarrierSchema,
  DaemonRelayConfigSchema,
  DISCOVERED_RELAY_CARRIER,
} from '../../../daemon/lib/runtime/relay-config.ts';
import { RELAY_CONNECT_DEADLINE_MS } from '../../../daemon/lib/relay/carrier.ts';
import { chooseRelayCarrierSources } from '../../../daemon/lib/relay/discovery.ts';
import { FakeSessions } from '../../support/sessions.ts';
const relayCrypto = { randomBytes: (n: number) => new Uint8Array(n).fill(7) };
const identity = {
  daemonId: 'fy_daemon_' + 'a'.repeat(43),
  sign: async () => ({ daemonId: 'fy_daemon_' + 'a'.repeat(43), publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) }),
};
const config = (patch: Record<string, unknown>) => DaemonRelayConfigSchema.parse(patch);
const controlFrame = (message: ControlMessage, sessionId: SessionId = RENDEZVOUS_SESSION_ID) =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });
const nextTurn = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const until = async <T>(read: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = read();
    if (v !== undefined) return v;
    await nextTurn();
  }
  throw new Error('did not observe ' + what);
};
interface FakeSocket extends RelayWebSocket {
  readonly url: string;
  readonly sent: Array<Uint8Array | string>;
  readonly closes: Array<{ code?: number; reason?: string }>;
}

function fakeSockets(): { readonly sockets: FakeSocket[]; readonly factory: (url: string) => RelayWebSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: url => {
      const socket: FakeSocket = {
        url,
        binaryType: '',
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent: [],
        closes: [],
        send: data => socket.sent.push(data),
        close: (code, reason) => socket.closes.push({ code, reason }),
      };
      sockets.push(socket);
      return socket;
    },
  };
}

/** A clock and a scheduler that only move when the test says so: no test here waits on a wall clock. */
function fakeClock() {
  let current = 1_000;
  let nextId = 0;
  const pending = new Map<number, { readonly at: number; readonly action: () => void }>();
  const delays: number[] = [];
  return {
    now: () => current,
    delays,
    pending: () => pending.size,
    scheduler: {
      after: (milliseconds: number, action: () => void) => {
        nextId += 1;
        const id = nextId;
        delays.push(milliseconds);
        pending.set(id, { at: current + milliseconds, action });
        return { cancel: () => void pending.delete(id) };
      },
    },
    /** Time passes AND every timer that falls due runs, earliest first. */
    advance: (milliseconds: number) => {
      const target = current + milliseconds;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        current = Math.max(current, due[1].at);
        pending.delete(due[0]);
        due[1].action();
      }
      current = target;
    },
    /** Time passes and NO timer runs — a laptop asleep through its own ping. */
    jump: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

const CLAIMED = {
  t: 'claimed',
  protocol: RELAY_PROTOCOL_ID,
  limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
} as const;

function redialingCarrier(patch: Record<string, unknown> = {}, random = 1) {
  const fake = fakeSockets();
  const clock = fakeClock();
  const lines: string[] = [];
  const carrier = new BunRelayCarrier({
    config: config({ url: 'https://relay.example', ...patch }),
    identity,
    layer: new FakeSessions(),
    socketFactory: fake.factory,
    scheduler: clock.scheduler,
    now: clock.now,
    random: () => random,
    log: line => lines.push(line),
  });
  const socketAt = (index: number): FakeSocket => {
    const socket = fake.sockets[index];
    if (socket === undefined) throw new Error(`no socket ${index}`);
    return socket;
  };
  /** The rendezvous half of a successful claim: challenge, the daemon's claim, then the acceptance. */
  const claimOn = async (socket: FakeSocket, claimed: ControlMessage = CLAIMED): Promise<void> => {
    socket.onmessage?.({
      data: controlFrame({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    });
    await until(() => socket.sent.at(-1), 'the claim');
    socket.onmessage?.({ data: controlFrame(claimed) });
    await until(() => (carrier.status().phase === 'carrying' ? true : undefined), 'the carrier to carry');
  };
  return { carrier, fake, clock, lines, socketAt, claimOn };
}

describe('a carrier that survives a dropped rendezvous', () => {
  it('R140 should redial at once after a drop and say what happened, naming the origin and never the path', () => {
    // Arrange — a configured address WITH a path, which is exactly what must not reach a log line.
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier({ url: 'wss://relay.example/hosted/path' });
    carrier.start();
    socketAt(0).onopen?.(undefined);

    // Act — the rendezvous goes away (a Worker redeploy).
    socketAt(0).onclose?.({ code: 1006, reason: 'gone' });

    // Assert — phase and detail stay honest while the redial is pending.
    should(carrier.status()).containDeep({ phase: 'dialling' });
    should(carrier.status().detail).match(/connection ended \(1006 gone\)/u);
    should(fake.sockets).have.length(1);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    should(lines).deepEqual(['relay wss://relay.example: disconnected (1006 gone) — redial attempt 1 in 0ms']);
    should(lines.join('\n')).not.match(/hosted|rendezvous|fy_daemon/u);
    carrier.stop();
  });

  it('R111 should back off with each failed redial, never above the ceiling, and keep trying, logging each', () => {
    // Arrange — the top of the jitter range, so the windows themselves are read off the delays.
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier({ reconnectSeconds: 5 });
    carrier.start();
    const delays: string[] = [];

    // Act — seven consecutive failed dials, each waited out exactly.
    const expected = [0, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
    for (const [index, delay] of expected.entries()) {
      socketAt(index).onclose?.({ code: 1006, reason: '' });
      const said = lines.at(-1) ?? '';
      delays.push(said.replace(/^.* in /u, ''));
      if (delay > 0) {
        clock.advance(delay - 1);
        should(fake.sockets).have.length(index + 1);
      }
      clock.advance(delay > 0 ? 1 : 0);
      should(fake.sockets).have.length(index + 2);
    }

    // Assert
    should(delays).deepEqual(['0ms', '500ms', '1.0s', '2.0s', '4.0s', '5.0s', '5.0s']);
    should(lines.at(-1)).match(/redial attempt 7 in 5\.0s/u);
    carrier.stop();
  });

  it('should treat a huge configured wait as the ten-second ceiling', () => {
    // Arrange
    const { carrier, clock, socketAt } = redialingCarrier({ reconnectSeconds: 3_600 });
    carrier.start();

    // Act — drop twelve dials in a row.
    for (let index = 0; index < 12; index += 1) {
      socketAt(index).onclose?.({ code: 1006, reason: '' });
      clock.advance(10_000);
    }

    // Assert — no wait was ever longer than ten seconds.
    should(Math.max(...clock.delays.filter(delay => delay < 15_000))).be.belowOrEqual(10_000);
    carrier.stop();
  });

  it('should reset the backoff once the rendezvous accepts the claim, and say how long it was away', async () => {
    // Arrange — two failed dials, then a good one.
    const { carrier, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    clock.advance(0);
    socketAt(1).onclose?.({ code: 1006, reason: '' });
    clock.advance(500);
    socketAt(2).onopen?.(undefined);

    // Act
    await claimOn(socketAt(2));

    // Assert — a recovery line, and a status with nothing left to explain.
    should(lines.at(-1)).equal('relay https://relay.example: reconnected after 2 attempts (0.5s offline)');
    should(carrier.status()).containDeep({ phase: 'carrying' });
    should(carrier.status().detail).be.undefined();

    // Act — the next drop starts from the top of the schedule again, not from where it left off.
    socketAt(2).onclose?.({ code: 1001, reason: 'going away' });

    // Assert
    should(lines.at(-1)).equal('relay https://relay.example: disconnected (1001 going away) — redial attempt 1 in 0ms');
    carrier.stop();
  });

  it('should say when the rendezvous accepts the claim, and how long after dialling, even on the first connect', async () => {
    // Arrange
    const { carrier, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    socketAt(0).onopen?.(undefined);
    clock.advance(1_200);

    // Act
    await claimOn(socketAt(0));

    // Assert — one line, no "reconnected" because nothing was lost.
    should(lines).deepEqual([
      'relay https://relay.example: connected — the rendezvous accepted the claim 1.2s after dialling',
    ]);
    carrier.stop();
  });

  it("should log the relay's own in-band words alongside the close that follows them", async () => {
    // Arrange — the Worker explains a refusal in-band and then closes the socket.
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onopen?.(undefined);
    socketAt(0).onmessage?.({
      data: controlFrame({ t: 'error', code: 4500, reason: 'hosted relay accounting is unavailable\nforged: line' }),
    });
    clock.advance(1_000);

    // Act
    socketAt(0).onclose?.({ code: 1006, reason: '' });

    // Assert — both the close and the relay's words, on ONE printable line.
    should(lines).deepEqual([
      'relay https://relay.example: disconnected (1006; the relay said: error 4500 hosted relay accounting is unavailable forged: line) — redial attempt 1 in 0ms',
    ]);
    should(carrier.status().detail).match(/hosted relay accounting is unavailable/u);
    carrier.stop();
  });

  it('should report an in-band session close, but not blame a close that happened long before the drop', () => {
    // Arrange
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onopen?.(undefined);
    socketAt(0).onmessage?.({ data: controlFrame({ t: 'closed', code: 4410, reason: 'client left' }, session()) });

    // Act — soon after: blamed. Then a second socket: the old message is long gone.
    clock.advance(2_000);
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    clock.advance(0);
    socketAt(1).onopen?.(undefined);
    clock.advance(6_000);
    socketAt(1).onclose?.({ code: 1006, reason: '' });

    // Assert
    should(lines[0]).match(/the relay said: closed 4410 client left/u);
    should(lines[1]).not.match(/the relay said/u);
    carrier.stop();
  });

  it('should not claim a recovery for a rendezvous that only opened the socket', async () => {
    // Arrange — a socket that opens and is then refused (a 4409 against a slot not yet swept).
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    clock.advance(0);
    socketAt(1).onopen?.(undefined);

    // Act
    socketAt(1).onclose?.({ code: 4409, reason: 'a daemon is already connected' });

    // Assert — attempt 2, and no "reconnected" line anywhere.
    should(lines.at(-1)).match(/disconnected \(4409 a daemon is already connected\) — redial attempt 2 in 500ms/u);
    should(lines.some(line => line.includes('reconnected'))).be.false();
    carrier.stop();
  });

  it('R152 should back off for minutes on a hosted connection ceiling, never redialling it within a minute', async () => {
    // Arrange — the bottom of the jitter range, so every capacity wait is half its window.
    const { carrier, clock, lines, socketAt, claimOn } = redialingCarrier({}, 0);
    carrier.start();
    socketAt(0).onopen?.(undefined);
    socketAt(0).onmessage?.({
      data: controlFrame({ t: 'error', code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' }),
    });

    // Act — the Worker explains and closes; the close itself carries no code, only the in-band words do.
    socketAt(0).onclose?.({ code: 1006, reason: '' });

    // Assert — minutes, not the immediate redial a dropped path gets, and a status that says what it is.
    should(clock.delays.at(-1)).equal(60_000);
    should(lines.at(-1)).match(
      /refused: the relay's per-daemon or account connection ceiling is full .* redial attempt 1 in 60\.0s/u,
    );
    should(carrier.status().detail).match(/refused this daemon a connection slot/u);

    // Act — a refusal by close code doubles the window; a path drop between refusals restarts the run.
    clock.advance(60_000);
    socketAt(1).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(120_000);
    clock.advance(120_000);
    socketAt(2).onclose?.({ code: 1006, reason: '' });
    clock.advance(clock.delays.at(-1) ?? 0);
    socketAt(3).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(60_000);
    // One line per refusal, each a minute or more after the last: never the per-attempt flood.
    should(lines.filter(line => line.includes('refused:'))).have.length(3);

    // Act — a second refusal in the run, then the ceiling clears; the next refusal starts over.
    clock.advance(60_000);
    socketAt(4).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(120_000);
    clock.advance(120_000);
    socketAt(5).onopen?.(undefined);
    await claimOn(socketAt(5));
    socketAt(5).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(60_000);
    carrier.stop();
  });

  it('R142 should wait sixty to a hundred and twenty seconds after a 4432 before its next try', () => {
    for (const [random, wait] of [
      [0, 60_000],
      [1, 120_000],
    ] as const) {
      const { carrier, clock, fake, socketAt } = redialingCarrier({}, random);
      carrier.start();
      socketAt(0).onopen?.(undefined);
      socketAt(0).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
      should(clock.delays.at(-1)).equal(wait);
      // Nothing dials inside the wait, however the jitter fell.
      clock.advance(wait - 1);
      should(fake.sockets).have.length(1);
      clock.advance(1);
      should(fake.sockets).have.length(2);
      carrier.stop();
    }
  });

  it('R157 should wait for a spent relay data allowance to reset instead of redialling it', () => {
    // Arrange — the bottom of the jitter range, so every wait is exactly the schedule's.
    const { carrier, clock, lines, socketAt } = redialingCarrier({}, 0);
    carrier.start();
    socketAt(0).onopen?.(undefined);
    const resetsAt = 1_000 + 600_000;
    socketAt(0).onmessage?.({
      data: controlFrame({
        t: 'error',
        code: 4433,
        reason: hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, resetsAt),
      }),
    });

    // Act — explained in-band, then a close that carries nothing.
    socketAt(0).onclose?.({ code: 1006, reason: '' });

    // Assert — until the reset the relay named, and a status that says what ran out and when.
    should(clock.delays.at(-1)).equal(600_000);
    should(lines.at(-1)).match(
      /refused: the hosted relay's data allowance for this machine is used up for today, resetting at 1970-01-01T00:10:01\.000Z — redial attempt 1 in 600\.0s/u,
    );
    should(carrier.status().detail).match(/data allowance for this machine is used up for today .* resets at/u);

    // Act — an older relay names no reset: the UTC day is hours away, so it rechecks in half an hour.
    clock.advance(600_000);
    socketAt(1).onclose?.({ code: 4433, reason: HOSTED_RELAY_BANDWIDTH_REASONS.global.day });
    should(clock.delays.at(-1)).equal(1_800_000);
    should(lines.at(-1)).match(/allowance for the whole relay is used up for today/u);

    // Act — a minute window is never redialled sooner than a minute.
    clock.advance(1_800_000);
    socketAt(2).onclose?.({ code: 4433, reason: HOSTED_RELAY_BANDWIDTH_REASONS.daemon.minute });
    should(clock.delays.at(-1)).equal(60_000);
    should(lines.at(-1)).match(/used up for this minute/u);

    // Act — a 4433 whose words this build does not know is an ordinary drop.
    clock.advance(60_000);
    socketAt(3).onclose?.({ code: 4433, reason: 'something else' });
    should(lines.at(-1)).match(/^relay https:\/\/relay\.example: disconnected \(4433 something else\)/u);
    carrier.stop();
  });

  it('R158 the supervisor redials at the reset with a one-minute floor, thirty-minute cap and thirty-second jitter', () => {
    for (const [untilReset, random, wait] of [
      [5_000, 0, 60_000],
      [300_000, 0, 300_000],
      [300_000, 1, 330_000],
      [72_000_000, 0, 1_800_000],
      [72_000_000, 1, 1_830_000],
    ] as const) {
      const { carrier, clock, fake, socketAt } = redialingCarrier({}, random);
      carrier.start();
      socketAt(0).onopen?.(undefined);
      socketAt(0).onclose?.({
        code: 4433,
        reason: hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, clock.now() + untilReset),
      });
      should(clock.delays.at(-1)).equal(wait);
      clock.advance(wait - 1);
      should(fake.sockets).have.length(1);
      clock.advance(1);
      should(fake.sockets).have.length(2);
      carrier.stop();
    }
  });

  it('should report a transport error as a disconnect too', () => {
    // Arrange
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();

    // Act
    socketAt(0).onerror?.(undefined);

    // Assert
    should(lines).deepEqual(['relay https://relay.example: disconnected (connection error) — redial attempt 1 in 0ms']);
    should(clock.pending()).equal(1);
    carrier.stop();
  });

  it('should cancel a pending redial when the daemon stops', () => {
    // Arrange — a drop leaves a redial pending.
    const { carrier, fake, clock, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    should(clock.pending()).equal(1);

    // Act
    carrier.stop();
    clock.advance(600_000);

    // Assert — nothing is armed and nothing dials again.
    should(clock.pending()).equal(0);
    should(fake.sockets).have.length(1);
    should(carrier.status().phase).equal('stopped');
  });

  it('should abandon a dial that never opens and redial', () => {
    // Arrange — a black-holed route: the socket neither opens nor fails.
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier();
    carrier.start();

    // Act
    clock.advance(14_999);
    should(socketAt(0).closes).be.empty();
    clock.advance(1);

    // Assert
    should(socketAt(0).closes[0]?.code).equal(4408);
    should(lines.at(-2)).equal(
      'relay https://relay.example: liveness: the socket did not open within 15.0s — dropping it',
    );
    should(lines.at(-1)).match(/disconnected \(4408 no answer to the connection/u);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });
});

describe('a carrier that notices a dead path in seconds', () => {
  it('should drop a socket that stays silent after a ping, and redial', () => {
    // Arrange
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);

    // Act + Assert — nothing is sent before the keepalive interval.
    clock.advance(19_999);
    should(socket.sent).be.empty();
    clock.advance(1);
    should(socket.sent).deepEqual(['fy-ping']);

    // Act + Assert — and nothing answers: the deadline is ten seconds after the ping.
    clock.advance(9_999);
    should(socket.closes).be.empty();
    clock.advance(1);

    // Assert — closed with the heartbeat code, abandoned without waiting for a close handshake,
    // and the redial is already pending.
    should(socket.closes).deepEqual([{ code: 4408, reason: 'no answer within the heartbeat deadline' }]);
    should(carrier.status().detail).match(/stopped answering/u);
    should(lines).deepEqual([
      'relay https://relay.example: liveness: no reply within 10.0s of the ping — dropping the socket',
      'relay https://relay.example: disconnected (4408 no answer within the heartbeat deadline) — redial attempt 1 in 0ms',
    ]);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });

  it('should keep a socket whose pong arrives in time, and keep pinging', () => {
    // Arrange
    const { carrier, clock, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);

    // Act — three keepalive rounds, each answered a second after its ping.
    for (let round = 0; round < 3; round += 1) {
      clock.advance(20_000 - (round === 0 ? 0 : 1_000));
      socket.onmessage?.({ data: 'fy-pong' });
      clock.advance(1_000);
    }
    clock.advance(10_000);

    // Assert — never closed, three pings sent.
    should(socket.closes).be.empty();
    should(socket.sent.filter(sent => sent === 'fy-ping')).have.length(3);
    should(carrier.status().phase).equal('dialling');
    carrier.stop();
  });

  it('should count any inbound message as the answer, not only a pong', () => {
    // Arrange
    const { carrier, clock, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    clock.advance(20_000);

    // Act — the peer's own ping arrives inside the window; that is evidence of life.
    socket.onmessage?.({ data: 'fy-ping' });
    clock.advance(10_000);

    // Assert
    should(socket.closes).be.empty();
    carrier.stop();
  });

  it('R87 should drop a socket at its first tick when the clock shows it was silent past the grace window', () => {
    // Arrange — the process was asleep: the clock moved, no timer ran.
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    clock.jump(60_000);

    // Act — the first tick after waking is already overdue, so it runs the moment time is next observed.
    clock.advance(0);

    // Assert — dropped immediately, with no ping sent into a corpse and no further ten-second wait.
    should(socket.sent).be.empty();
    should(socket.closes[0]?.code).equal(4408);
    should(carrier.status().detail).match(/stopped answering/u);
    should(lines).deepEqual([
      'relay https://relay.example: liveness: nothing received for 60.0s (limit 45.0s) — dropping the socket',
      'relay https://relay.example: disconnected (4408 no answer within the heartbeat deadline) — redial attempt 1 in 0ms',
    ]);
    carrier.stop();
  });
});

describe('a carrier that asks the rendezvous itself whether it still holds the claim', () => {
  const PROBING = { ...CLAIMED, features: ['claim-probe'] } as const;
  const probesIn = (socket: FakeSocket): number =>
    socket.sent.filter(data => {
      if (typeof data === 'string') return false;
      const decoded = decodeFrame(data);
      return decoded.ok && decodeControlMessage(decoded.frame.payload)?.t === 'probe';
    }).length;

  it('R51 should ask for the probe in the query, never the path, and keep the logged origin clean', () => {
    const { carrier, socketAt, lines } = redialingCarrier({ url: 'wss://relay.example/hosted/path' });
    carrier.start();
    const url = new URL(socketAt(0).url);
    should(url.searchParams.get('features')).equal('claim-probe,claim-handover');
    should(url.pathname).match(/^\/hosted\/path\/v1\/rendezvous\/fy_daemon_[A-Za-z0-9_-]{43}\/daemon$/u);
    should(carrier.status().relayUrl).not.match(/features/u);
    should(lines.join('\n')).not.match(/features/u);
    carrier.stop();
  });

  it('R53 should probe on every keepalive once the rendezvous agreed, and keep a socket whose claim is held', async () => {
    const { carrier, clock, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket, PROBING);

    for (let round = 0; round < 3; round += 1) {
      clock.advance(20_000 - (round === 0 ? 0 : 1_000));
      socket.onmessage?.({ data: 'fy-pong' });
      socket.onmessage?.({ data: controlFrame({ t: 'held' }) });
      // Binary frames are handled on the carrier's inbox chain; let it run before the deadline is read.
      await nextTurn();
      clock.advance(1_000);
    }
    clock.advance(10_000);

    should(probesIn(socket)).equal(3);
    should(socket.closes).be.empty();
    should(carrier.status().phase).equal('carrying');
    carrier.stop();
  });

  it('R52 should never probe a rendezvous that did not offer it', async () => {
    const { carrier, clock, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket);

    clock.advance(20_000);
    socket.onmessage?.({ data: 'fy-pong' });
    clock.advance(10_000);

    should(probesIn(socket)).equal(0);
    should(socket.closes).be.empty();
    carrier.stop();
  });

  it('R92 should drop and re-claim when the edge answers the ping but the rendezvous never confirms the claim', async () => {
    // The incident, from the daemon's side: fy-pong kept arriving, so nothing looked wrong for 16 minutes.
    const { carrier, fake, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket, PROBING);
    lines.length = 0;

    clock.advance(20_000);
    socket.onmessage?.({ data: 'fy-pong' });
    clock.advance(10_000);

    should(socket.closes).deepEqual([{ code: 4408, reason: 'the rendezvous did not confirm the claim' }]);
    should(carrier.status().detail).match(/stopped confirming the claim/u);
    should(lines[0]).equal(
      'relay https://relay.example: liveness: the edge answered but the rendezvous did not confirm the claim within 10.0s — dropping the socket to claim again',
    );
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });

  it('R54 should say so plainly, and redial at once, when the rendezvous reports the claim lost', async () => {
    const { carrier, fake, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket, PROBING);
    lines.length = 0;

    socket.onmessage?.({
      data: controlFrame({ t: 'error', code: 4410, reason: 'this rendezvous no longer holds the claim' }),
    });
    socket.onclose?.({ code: 4410, reason: 'this rendezvous no longer holds the claim' });

    should(lines).deepEqual([
      'relay https://relay.example: liveness: the rendezvous no longer held this daemon’s claim — claiming again',
      'relay https://relay.example: disconnected (4410 this rendezvous no longer holds the claim; the relay said: error 4410 this rendezvous no longer holds the claim) — redial attempt 1 in 0ms',
    ]);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });
});

describe('a carrier that offers its last handover token to reclaim its own rendezvous', () => {
  const TOKEN = 'A'.repeat(43);
  const NEXT_TOKEN = 'B'.repeat(43);
  const HANDING = { ...CLAIMED, features: ['claim-probe', 'claim-handover'], handover: TOKEN } as const;
  const replacesOf = (socket: FakeSocket): (string | undefined)[] =>
    socket.sent.flatMap(data => {
      if (typeof data === 'string') return [];
      const decoded = decodeFrame(data);
      const message = decoded.ok ? decodeControlMessage(decoded.frame.payload) : null;
      return message?.t === 'claim' ? [message.replaces] : [];
    });
  const redial = (harness: ReturnType<typeof redialingCarrier>): FakeSocket => {
    const before = harness.fake.sockets.length;
    harness.clock.advance(harness.clock.delays.at(-1) ?? 0);
    should(harness.fake.sockets).have.length(before + 1);
    return harness.socketAt(before);
  };
  const challenge = async (socket: FakeSocket): Promise<void> => {
    socket.onopen?.(undefined);
    socket.onmessage?.({
      data: controlFrame({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    });
    await until(() => (replacesOf(socket).length > 0 ? true : undefined), 'the claim');
  };

  it('R57 should claim without a token the first time, and offer the issued one only once its socket ended', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);

    // The holding socket is live: nothing has dialled, so nothing has offered the token.
    should(harness.fake.sockets).have.length(1);
    should(replacesOf(first)).deepEqual([undefined]);

    first.onclose?.({ code: 1006, reason: '' });
    const second = redial(harness);
    await challenge(second);

    should(replacesOf(second)).deepEqual([TOKEN]);
    harness.carrier.stop();
  });

  it('R56 should not remember a token the rendezvous did not echo the feature for', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, { ...CLAIMED, features: ['claim-probe'], handover: TOKEN });

    first.onclose?.({ code: 1006, reason: '' });
    const second = redial(harness);
    await challenge(second);

    should(replacesOf(second)).deepEqual([undefined]);
    harness.carrier.stop();
  });

  it('R101 should keep the token through a refusal of 4409 and through a transport failure', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });

    const second = redial(harness);
    await challenge(second);
    second.onclose?.({ code: 4409, reason: 'another daemon already holds this rendezvous' });
    const third = redial(harness);
    await challenge(third);
    third.onerror?.(undefined);
    const fourth = redial(harness);
    await challenge(fourth);

    should(replacesOf(second)).deepEqual([TOKEN]);
    should(replacesOf(third)).deepEqual([TOKEN]);
    should(replacesOf(fourth)).deepEqual([TOKEN]);
    harness.carrier.stop();
  });

  it('R57 should drop the token once the rendezvous refuses a claim for any reason but 4409', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });

    const second = redial(harness);
    await challenge(second);
    second.onclose?.({ code: 4401, reason: 'the claim was rejected' });
    const third = redial(harness);
    await challenge(third);

    should(replacesOf(second)).deepEqual([TOKEN]);
    should(replacesOf(third)).deepEqual([undefined]);
    harness.carrier.stop();
  });

  it('R60 should keep the token in memory only: never logged, never in status, sent only on its own socket', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });
    const second = redial(harness);
    await challenge(second);

    // The one place the token goes is the claim on this carrier's own next socket to the same rendezvous.
    should(second.url).equal(first.url);
    should(replacesOf(second)).deepEqual([TOKEN]);
    const textSent = (socket: FakeSocket) => socket.sent.filter(data => typeof data === 'string').join('\n');
    should(textSent(first) + textSent(second)).not.containEql(TOKEN);
    should(harness.lines.join('\n')).not.containEql(TOKEN);
    should(JSON.stringify(harness.carrier.status())).not.containEql(TOKEN);
    harness.carrier.stop();
  });

  it('R59 should replace the token with the one a successful reclaim issues, and use each only once', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });

    const second = redial(harness);
    second.onopen?.(undefined);
    await harness.claimOn(second, { ...HANDING, handover: NEXT_TOKEN });
    second.onclose?.({ code: 1006, reason: '' });
    const third = redial(harness);
    await challenge(third);

    should(replacesOf(second)).deepEqual([TOKEN]);
    should(replacesOf(third)).deepEqual([NEXT_TOKEN]);
    harness.carrier.stop();
  });
});

function session(): SessionId {
  return sessionIdFromBytes(new Uint8Array(16).fill(9))!;
}

describe('one redial cadence whatever the relay came from', () => {
  it('R214 should give a configured relay and a discovered one the same schema defaults and the same redial cadence', () => {
    const resolved = chooseRelayCarrierSources(
      [ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'https://mine.example' }), DISCOVERED_RELAY_CARRIER],
      { kind: 'available', relayUrl: 'https://hosted.example' },
    );
    if (resolved.kind !== 'resolved') throw new Error(resolved.reason);
    const [mine, hosted] = resolved.sources;
    if (mine?.kind !== 'configured' || hosted?.kind !== 'discovered') throw new Error('unexpected provenance');
    // Same defaults, field for field, apart from the address itself.
    should({ ...mine.config, url: '' }).deepEqual({ ...hosted.config, url: '' });

    // And the same supervisor, fed the same failures, waits the same way for both.
    const cadence = (relayConfig: typeof mine.config): number[] => {
      const fake = fakeSockets();
      const clock = fakeClock();
      const carrier = new BunRelayCarrier({
        config: relayConfig,
        identity,
        layer: new FakeSessions(),
        socketFactory: fake.factory,
        scheduler: clock.scheduler,
        now: clock.now,
        random: () => 1,
      });
      carrier.start();
      for (let attempt = 0; attempt < 7; attempt += 1) {
        fake.sockets[attempt]?.onclose?.({ code: 1006, reason: '' });
        clock.advance(clock.delays.at(-1) ?? 0);
      }
      carrier.stop();
      return clock.delays.filter(delay => delay !== RELAY_CONNECT_DEADLINE_MS);
    };
    should(cadence(mine.config)).deepEqual(cadence(hosted.config));
    should(cadence(hosted.config)).deepEqual([0, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
  });
});
