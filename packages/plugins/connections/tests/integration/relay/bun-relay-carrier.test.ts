/**
 * The relay carrier over REAL WebSockets, against a rendezvous that is a real loopback server.
 *
 * What is real: the socket (Bun's WebSocket, redialled by the carrier's own factory), the server on `127.0.0.1:0`,
 * the relay link and every wire frame in both directions. What is a stand-in: the rendezvous's decisions (a scripted
 * server says what each connection is told), the signer, and the CLOCK — the carrier's keepalive is twenty seconds and
 * its connect deadline fifteen, so time is a fake the test advances while the sockets run on the real event loop.
 * Nothing here waits for time to pass: a test waits for an observable event, bounded by `waitFor`'s safety net.
 */

import { afterEach, describe, it } from 'bun:test';
import type { Server, ServerWebSocket, TCPSocketListener } from 'bun';
import should from 'should';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  SESSION_CLOSE_CODES,
  sessionIdFromBytes,
  toBase64Url,
} from '@ferretry/kernel/wire';
import {
  BunRelayCarrier,
  RelayCarrier,
  type RelayWebSocket,
} from '../../../daemon/adapters/relay/bun-relay-carrier.ts';
import { HOSTED_RELAY_BANDWIDTH_REASONS, hostedBandwidthReason } from '../../../daemon/lib/relay/bandwidth.ts';
import { RELAY_CONNECT_DEADLINE_MS } from '../../../daemon/lib/relay/carrier.ts';
import { type ControlMessage, decodeControlMessage, encodeControlMessage } from '../../../daemon/lib/relay/control.ts';
import { DaemonRelayConfigSchema } from '../../../daemon/lib/runtime/relay-config.ts';
import { FakeSessions } from '../../support/sessions.ts';
import { waitFor } from '../support/wait-for.ts';

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const signer = {
  daemonId: DAEMON_ID,
  sign: async () => ({ daemonId: DAEMON_ID, publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) }),
};
const HANDOVER = 'A'.repeat(43);
const CLAIMED: ControlMessage = {
  t: 'claimed',
  protocol: RELAY_PROTOCOL_ID,
  limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
};
const PROBING: ControlMessage = {
  ...CLAIMED,
  features: ['claim-probe', 'claim-handover'],
  handover: HANDOVER,
} as never;
const CAPACITY = 'hosted relay per-daemon connection ceiling is reached';

const controlFrame = (message: ControlMessage, sessionId = RENDEZVOUS_SESSION_ID) =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });

// ── The rendezvous: a real loopback server that speaks the daemon side of the protocol ─────────────────────────

interface Behaviour {
  /** Answers `fy-ping` with `fy-pong`. */
  pong: boolean;
  /** Answers a claim probe with `held`. */
  held: boolean;
  /** What a claim is answered with; `undefined` never accepts it. */
  claimed: ControlMessage | undefined;
}

class Peer {
  readonly received: Array<string | Uint8Array> = [];
  readonly claims: Array<Extract<ControlMessage, { t: 'claim' }>> = [];
  probes = 0;
  closed: { readonly code: number; readonly reason: string } | undefined;
  constructor(
    readonly ws: ServerWebSocket<{ peer?: Peer; url: string }>,
    readonly url: URL,
    readonly behaviour: Behaviour,
  ) {}
  get pings(): number {
    return this.received.filter(message => message === 'fy-ping').length;
  }
}

interface Rendezvous {
  readonly port: number;
  readonly peers: Peer[];
  readonly defaults: Behaviour;
}

const servers: Array<Server<{ peer?: Peer; url: string }>> = [];
const listeners: Array<TCPSocketListener<undefined>> = [];
const carriers: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const carrier of carriers.splice(0)) carrier.stop();
  for (const server of servers.splice(0)) void server.stop(true);
  for (const listener of listeners.splice(0)) listener.stop(true);
});

function rendezvous(claimed: ControlMessage | undefined): Rendezvous {
  const peers: Peer[] = [];
  const defaults: Behaviour = { pong: true, held: true, claimed };
  const server = Bun.serve<{ peer?: Peer; url: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bound) =>
      bound.upgrade(request, { data: { url: request.url } })
        ? undefined
        : new Response('upgrade required', { status: 426 }),
    websocket: {
      open: ws => {
        const peer = new Peer(ws, new URL(ws.data.url), { ...defaults });
        ws.data.peer = peer;
        peers.push(peer);
        ws.send(
          controlFrame({
            t: 'challenge',
            protocol: RELAY_PROTOCOL_ID,
            nonce: toBase64Url(new Uint8Array(NONCE_BYTES).fill(7)),
            host: 'relay.example',
            deadlineSeconds: 10,
          }),
        );
      },
      message: (ws, message) => {
        const peer = ws.data.peer;
        if (peer === undefined) return;
        if (typeof message === 'string') {
          peer.received.push(message);
          if (message === 'fy-ping' && peer.behaviour.pong) ws.send('fy-pong');
          return;
        }
        const bytes = new Uint8Array(message);
        peer.received.push(bytes);
        const decoded = decodeFrame(bytes);
        const control =
          decoded.ok && decoded.frame.kind === FRAME_KINDS.control ? decodeControlMessage(decoded.frame.payload) : null;
        if (control?.t === 'claim') {
          peer.claims.push(control);
          if (peer.behaviour.claimed !== undefined) ws.send(controlFrame(peer.behaviour.claimed));
        }
        if (control?.t === 'probe') {
          peer.probes += 1;
          if (peer.behaviour.held) ws.send(controlFrame({ t: 'held' }));
        }
      },
      close: (ws, code, reason) => {
        if (ws.data.peer !== undefined) ws.data.peer.closed = { code, reason };
      },
    },
  });
  servers.push(server);
  return { port: server.port ?? 0, peers, defaults };
}

// ── The daemon's side: a real WebSocket, with a tap so a test can tell when a message was delivered ─────────────

class TapSocket implements RelayWebSocket {
  readonly real: WebSocket;
  messages = 0;
  opened = false;
  #open: ((event: unknown) => void) | null = null;
  #message: ((event: { readonly data: unknown }) => void) | null = null;
  #close: ((event: unknown) => void) | null = null;
  #error: ((event: unknown) => void) | null = null;

  /** `keepBlobs`: the carrier asks for `arraybuffer`; a socket that keeps `blob` delivers what no peer should send. */
  constructor(
    url: string,
    private readonly keepBlobs: boolean,
  ) {
    this.real = new WebSocket(url);
    if (keepBlobs) this.real.binaryType = 'blob';
  }
  get binaryType(): string {
    return this.real.binaryType;
  }
  set binaryType(value: string) {
    if (!this.keepBlobs) this.real.binaryType = value as BinaryType;
  }
  get onopen() {
    return this.#open;
  }
  set onopen(handler) {
    this.#open = handler;
    this.real.onopen =
      handler === null
        ? null
        : event => {
            this.opened = true;
            handler(event);
          };
  }
  get onmessage() {
    return this.#message;
  }
  set onmessage(handler) {
    this.#message = handler;
    this.real.onmessage =
      handler === null
        ? null
        : event => {
            this.messages += 1;
            handler({ data: event.data });
          };
  }
  get onclose() {
    return this.#close;
  }
  set onclose(handler) {
    this.#close = handler;
    this.real.onclose = handler === null ? null : event => handler({ code: event.code, reason: event.reason });
  }
  get onerror() {
    return this.#error;
  }
  set onerror(handler) {
    this.#error = handler;
    this.real.onerror = handler === null ? null : event => handler(event);
  }
  send(data: Uint8Array | string): void {
    this.real.send(data as string);
  }
  close(code?: number, reason?: string): void {
    this.real.close(code, reason);
  }
  /** Hands the carrier a message exactly as the socket would, for the one shape a real socket never makes. */
  deliver(data: unknown): void {
    this.#message?.({ data });
  }
}

/** A clock and a scheduler that move only when the test says so. */
function fakeClock() {
  let current = 1_000;
  let nextId = 0;
  const pending = new Map<number, { readonly at: number; readonly action: () => void }>();
  const delays: number[] = [];
  return {
    now: () => current,
    delays,
    scheduler: {
      after: (milliseconds: number, action: () => void) => {
        nextId += 1;
        const id = nextId;
        delays.push(milliseconds);
        pending.set(id, { at: current + milliseconds, action });
        return { cancel: () => void pending.delete(id) };
      },
    },
    /** Time passes and every timer that falls due runs, earliest first. */
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
    /** Time passes and NO timer runs: a laptop asleep through its own ping. */
    jump: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

interface HarnessOptions {
  readonly claimed?: ControlMessage | undefined;
  readonly random?: number;
  readonly keepBlobs?: boolean;
  readonly signer?: typeof signer;
  /** Where the carrier's dial really goes; defaults to the harness's own rendezvous. */
  readonly port?: number;
  readonly relay?: Rendezvous;
}

function harness(options: HarnessOptions = {}) {
  const server = options.relay ?? rendezvous('claimed' in options ? options.claimed : CLAIMED);
  const clock = fakeClock();
  const lines: string[] = [];
  const taps: TapSocket[] = [];
  const config = DaemonRelayConfigSchema.parse({ url: 'https://relay.example' });
  const socketFactory = (url: string): RelayWebSocket => {
    const dialled = new URL(url);
    dialled.protocol = 'ws:';
    dialled.host = `127.0.0.1:${options.port ?? server.port}`;
    const tap = new TapSocket(dialled.toString(), options.keepBlobs === true);
    taps.push(tap);
    return tap;
  };
  const dependencies = {
    config,
    identity: options.signer ?? signer,
    socketFactory,
    scheduler: clock.scheduler,
    now: clock.now,
    random: () => options.random ?? 0,
    log: (line: string) => void lines.push(line),
  };
  const carrier = new BunRelayCarrier({ ...dependencies, layer: new FakeSessions() });
  carriers.push(carrier);
  const peerAt = async (index: number): Promise<Peer> => {
    await waitFor(() => server.peers[index] !== undefined, `the rendezvous to see dial ${index + 1}`);
    return server.peers[index] as Peer;
  };
  const tapAt = (index: number): TapSocket => {
    const tap = taps[index];
    if (tap === undefined) throw new Error(`the carrier has not dialled ${index + 1} times`);
    return tap;
  };
  return {
    server,
    clock,
    lines,
    taps,
    carrier,
    dependencies,
    peerAt,
    tapAt,
    carrying: () => waitFor(() => carrier.status().phase === 'carrying', 'the rendezvous to accept the claim'),
    /** Waits until dial `index` is open and its first message (the challenge) has been delivered. */
    opened: async (index: number) => {
      await peerAt(index);
      await waitFor(() => tapAt(index).opened && tapAt(index).messages >= 1, `dial ${index + 1} to open`);
    },
    /** Waits until dial `index` has delivered `count` messages to the carrier. */
    delivered: (index: number, count: number) =>
      waitFor(() => tapAt(index).messages >= count, `${count} messages to reach dial ${index + 1}`),
    /** Time passes until the redial scheduled last runs, and the carrier dials again. */
    redial: (dials: number) => {
      clock.advance(clock.delays.at(-1) ?? 0);
      should(taps).have.length(dials);
    },
  };
}

describe('the relay carrier over real sockets', () => {
  it('should claim the rendezvous, carry, answer a keepalive with a probe, and close its socket on stop', async () => {
    // Arrange
    const h = harness({ claimed: PROBING });

    // Act
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.carrying();

    // Assert — the dial asks for the features in the query, never the path, and the claim was accepted once.
    should(peer.url.searchParams.get('features')).equal('claim-probe,claim-handover');
    should(peer.url.pathname).match(/^\/v1\/rendezvous\/fy_daemon_[A-Za-z0-9_-]{43}\/daemon$/u);
    should(peer.claims).have.length(1);
    should(peer.claims[0]?.replaces).equal(undefined);
    should(h.lines).deepEqual([
      'relay https://relay.example: connected — the rendezvous accepted the claim 0.0s after dialling',
    ]);
    should(h.carrier.status().phase).equal('carrying');
    should(h.carrier.status().relayUrl).match(
      /^wss:\/\/relay\.example\/v1\/rendezvous\/fy_daemon_[A-Za-z0-9_-]{43}\/daemon$/u,
    );
    should(h.carrier.status().detail).equal(undefined);

    // Act — one keepalive round: the ping and the probe go out, the answers come back, the deadline passes.
    const before = h.tapAt(0).messages;
    h.clock.advance(20_000);
    await waitFor(() => peer.pings === 1 && peer.probes === 1, 'the keepalive ping and the claim probe');
    await h.delivered(0, before + 2);
    h.clock.advance(10_000);

    // Assert — the socket that was answered is kept.
    should(peer.closed).equal(undefined);
    should(h.carrier.status().phase).equal('carrying');

    // Act
    h.carrier.stop();
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon close');
    h.carrier.start();

    // Assert — stopped for good: told the rendezvous why, and never dials again.
    should(peer.closed).deepEqual({ code: 1000, reason: 'the daemon is shutting down' });
    should(h.carrier.status().phase).equal('stopped');
    should(h.taps).have.length(1);
  });

  it('should report a relay it was never given, and dial nothing', () => {
    // Arrange
    const h = harness();
    const none = new BunRelayCarrier({ ...h.dependencies, config: undefined, layer: new FakeSessions() });

    // Act
    none.start();

    // Assert
    should(none.status()).containDeep({ phase: 'none' });
    should(none.status().detail).match(/no relay is configured/u);
    should(h.taps).have.length(0);
  });

  it('should drop a socket that stays silent after a ping, tell the rendezvous why, and redial', async () => {
    // Arrange — a rendezvous that answers nothing after the claim.
    const h = harness();
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.carrying();
    peer.behaviour.pong = false;

    // Act — the ping goes out and nothing comes back before the deadline.
    h.clock.advance(20_000);
    await waitFor(() => peer.pings === 1, 'the keepalive ping');
    h.clock.advance(10_000);

    // Assert
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon drop the socket');
    should(peer.closed).deepEqual({
      code: SESSION_CLOSE_CODES.heartbeatTimeout,
      reason: 'no answer within the heartbeat deadline',
    });
    should(h.carrier.status().detail).match(/stopped answering/u);
    should(h.lines).containEql(
      'relay https://relay.example: liveness: no reply within 10.0s of the ping — dropping the socket',
    );
    h.redial(2);
    await h.peerAt(1);
  });

  it('should drop a socket at its first tick when the clock shows it was silent past the grace window', async () => {
    // Arrange — the process was asleep: the clock moved and no timer ran.
    const h = harness({ claimed: undefined });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.opened(0);

    // Act — the first tick after waking is already overdue.
    h.clock.jump(60_000);
    h.clock.advance(0);

    // Assert — dropped at once, with no ping sent into a corpse.
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon drop the socket');
    should(peer.closed?.code).equal(SESSION_CLOSE_CODES.heartbeatTimeout);
    should(peer.pings).equal(0);
    should(h.lines).containEql(
      'relay https://relay.example: liveness: nothing received for 60.0s (limit 45.0s) — dropping the socket',
    );
  });

  it('should drop and claim again when the edge answers the ping but the rendezvous never confirms the claim', async () => {
    // Arrange — `fy-pong` keeps arriving; `held` never does.
    const h = harness({ claimed: PROBING });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.carrying();
    peer.behaviour.held = false;

    // Act
    const before = h.tapAt(0).messages;
    h.clock.advance(20_000);
    await waitFor(() => peer.pings === 1 && peer.probes === 1, 'the keepalive ping and the claim probe');
    await h.delivered(0, before + 1);
    h.clock.advance(10_000);

    // Assert
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon drop the socket');
    should(peer.closed).deepEqual({
      code: SESSION_CLOSE_CODES.heartbeatTimeout,
      reason: 'the rendezvous did not confirm the claim',
    });
    should(h.carrier.status().detail).match(/stopped confirming the claim/u);
    should(h.lines).containEql(
      'relay https://relay.example: liveness: the edge answered but the rendezvous did not confirm the claim within 10.0s — dropping the socket to claim again',
    );
    h.redial(2);
  });

  it('should abandon a dial whose route accepts the connection and never answers, and dial again', async () => {
    // Arrange — a black hole: the TCP connection opens and the WebSocket handshake is never answered.
    let accepted = 0;
    const hole = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: () => {
          accepted += 1;
        },
        data: () => undefined,
      },
    });
    listeners.push(hole);
    const h = harness({ port: hole.port });
    h.carrier.start();
    await waitFor(() => accepted === 1, 'the black hole to accept the connection');

    // Act
    h.clock.advance(RELAY_CONNECT_DEADLINE_MS - 1);
    should(h.lines).deepEqual([]);
    h.clock.advance(1);

    // Assert
    should(h.lines[0]).equal(
      'relay https://relay.example: liveness: the socket did not open within 15.0s — dropping it',
    );
    should(h.lines[1]).match(/disconnected \(4408 no answer to the connection within the connect deadline\)/u);
    should(h.carrier.status().detail).match(/did not answer the connection/u);
    h.redial(2);
    await waitFor(() => accepted === 2, 'the carrier to dial the black hole again');
  });

  it('should call a connection that is refused a disconnect, and keep redialling', async () => {
    // Arrange — a port nothing listens on.
    const closed = Bun.listen<undefined>({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
    const port = closed.port;
    closed.stop(true);
    const h = harness({ port });

    // Act
    h.carrier.start();
    await waitFor(() => h.lines.length > 0, 'the refused connection to be reported');

    // Assert
    should(h.lines).have.length(1);
    should(h.lines[0]).match(/^relay https:\/\/relay\.example: disconnected \(.+\) — redial attempt 1 in 0ms$/u);
    should(h.carrier.status().detail).match(/the rendezvous connection ended \(.+\)/u);
    h.redial(2);
  });
});

describe('the relay carrier told to go away', () => {
  it('should back off for minutes on a hosted connection ceiling the relay explained in-band, then closed without a code', async () => {
    // Arrange — the Worker explains the refusal in-band and the transport then drops.
    const h = harness({ claimed: undefined });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.opened(0);

    // Act
    peer.ws.send(controlFrame({ t: 'error', code: 4432, reason: CAPACITY }));
    await h.delivered(0, 2);
    should(h.carrier.status().detail).match(/the rendezvous refused this daemon: 4432/u);
    peer.ws.terminate();
    await waitFor(() => h.lines.length > 0, 'the drop to be reported');

    // Assert — minutes, not the immediate redial a dropped path gets, and a status that says what it is.
    should(h.lines[0]).match(
      /refused: the relay's per-daemon or account connection ceiling is full .* redial attempt 1 in 60\.0s/u,
    );
    should(h.lines[0]).match(/the relay said: error 4432 hosted relay per-daemon connection ceiling is reached/u);
    should(h.clock.delays.at(-1)).equal(60_000);
    should(h.carrier.status().detail).match(/refused this daemon a connection slot/u);
    h.clock.advance(59_999);
    should(h.taps).have.length(1);
    h.clock.advance(1);
    should(h.taps).have.length(2);
  });

  it('should back off for minutes on a ceiling the rendezvous closed the socket with', async () => {
    // Arrange
    const h = harness({ claimed: undefined, random: 1 });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.opened(0);

    // Act
    peer.ws.close(4432, CAPACITY);
    await waitFor(() => h.lines.length > 0, 'the close to be reported');

    // Assert
    should(h.lines[0]).match(
      /refused: the relay's per-daemon or account connection ceiling is full \(4432 hosted relay/u,
    );
    should(h.clock.delays.at(-1)).equal(120_000);
  });

  it('should wait for a spent relay data allowance to reset, naming whose it is and which window', async () => {
    // Arrange — the bottom of the jitter range, so each wait is exactly the schedule's.
    const h = harness({ claimed: undefined });
    h.carrier.start();
    const first = await h.peerAt(0);
    await h.opened(0);
    const resetsAt = h.clock.now() + 600_000;

    // Act — this machine's daily allowance, with the reset the relay named.
    first.ws.close(4433, hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, resetsAt));
    await waitFor(() => h.lines.length === 1, 'the refusal to be reported');

    // Assert
    should(h.clock.delays.at(-1)).equal(600_000);
    should(h.lines[0]).match(
      /refused: the hosted relay's data allowance for this machine is used up for today, resetting at 1970-01-01T00:10:01\.000Z — redial attempt 1 in 600\.0s/u,
    );
    should(h.carrier.status().detail).match(/data allowance for this machine is used up for today .* resets at/u);

    // Act — the whole relay's minute allowance, with no reset named: a minute away.
    h.redial(2);
    const second = await h.peerAt(1);
    await h.opened(1);
    second.ws.close(4433, HOSTED_RELAY_BANDWIDTH_REASONS.global.minute);
    await waitFor(() => h.lines.length === 2, 'the second refusal to be reported');

    // Assert
    should(h.clock.delays.at(-1)).equal(60_000);
    should(h.lines[1]).match(/allowance for the whole relay is used up for this minute/u);
  });

  it('should say plainly, and redial at once, when the rendezvous reports the claim lost', async () => {
    // Arrange
    const h = harness({ claimed: PROBING });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.carrying();
    h.lines.length = 0;

    // Act — explained in-band, then closed with the claim-lost code.
    const before = h.tapAt(0).messages;
    peer.ws.send(
      controlFrame({
        t: 'error',
        code: SESSION_CLOSE_CODES.claimLost,
        reason: 'this rendezvous no longer holds the claim',
      }),
    );
    await h.delivered(0, before + 1);
    peer.ws.close(SESSION_CLOSE_CODES.claimLost, 'this rendezvous no longer holds the claim');
    await waitFor(() => h.lines.length === 2, 'the claim loss to be reported');

    // Assert
    should(h.lines[0]).equal(
      'relay https://relay.example: liveness: the rendezvous no longer held this daemon’s claim — claiming again',
    );
    should(h.lines[1]).equal(
      'relay https://relay.example: disconnected (4410 this rendezvous no longer holds the claim; the relay said: error 4410 this rendezvous no longer holds the claim) — redial attempt 1 in 0ms',
    );
    h.redial(2);
  });

  it('should redial at once after a drop, and say how long it was away once the claim is accepted again', async () => {
    // Arrange
    const h = harness();
    h.carrier.start();
    const first = await h.peerAt(0);
    await h.carrying();
    h.lines.length = 0;

    // Act — the path drops with no close at all.
    first.ws.terminate();
    await waitFor(() => h.lines.length === 1, 'the drop to be reported');

    // Assert
    should(h.lines[0]).match(/^relay https:\/\/relay\.example: disconnected \(.*\) — redial attempt 1 in 0ms$/u);
    should(h.carrier.status().phase).equal('dialling');
    h.clock.jump(1_500);
    h.redial(2);
    await h.peerAt(1);
    await waitFor(() => h.lines.length === 3, 'the reconnection to be reported');
    should(h.lines[1]).equal(
      'relay https://relay.example: connected — the rendezvous accepted the claim 0.0s after dialling',
    );
    should(h.lines[2]).equal('relay https://relay.example: reconnected after 1 attempt (1.5s offline)');
    should(h.carrier.status().detail).equal(undefined);
  });

  it('should say a close the rendezvous sent with an ordinary code and its own reason', async () => {
    // Arrange
    const h = harness({ claimed: undefined });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.opened(0);

    // Act
    peer.ws.close(1001, 'going away');
    await waitFor(() => h.lines.length === 1, 'the close to be reported');

    // Assert
    should(h.lines[0]).equal('relay https://relay.example: disconnected (1001 going away) — redial attempt 1 in 0ms');
  });

  it('should blame a close on an in-band session close handed to it as bytes, with the status keeping the relay’s words', async () => {
    // Arrange — a real socket never hands a carrier a Uint8Array when it asked for an ArrayBuffer, so this one message
    // is handed to the carrier's own handler exactly as a runtime that does would.
    const h = harness({ claimed: undefined });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.opened(0);
    const session = sessionIdFromBytes(new Uint8Array(16).fill(9));
    if (session === null) throw new Error('a session identifier');

    // Act
    h.tapAt(0).deliver(controlFrame({ t: 'closed', code: 4410, reason: 'client left' }, session));
    await waitFor(
      () => h.carrier.status().detail?.includes('the rendezvous ended a session') === true,
      'the link to record the close',
    );
    peer.ws.terminate();
    await waitFor(() => h.lines.length === 1, 'the drop to be reported');

    // Assert
    should(h.lines[0]).match(/the relay said: closed 4410 client left/u);
  });
});

describe('the relay carrier and the handover token', () => {
  /** The rendezvous reads this dial's claim and refuses it with `code`; resolves once the carrier has reported the end. */
  async function refuseClaimOf(h: ReturnType<typeof harness>, index: number, code: number): Promise<Peer> {
    const reported = h.lines.length;
    const peer = await h.peerAt(index);
    await waitFor(() => peer.claims.length === 1, `dial ${index + 1} to claim`);
    peer.ws.close(code, 'the claim was not taken');
    await waitFor(() => h.lines.length > reported, `the end of dial ${index + 1} to be reported`);
    return peer;
  }

  it('should offer the token only once its socket ended, keep it through 4409, and drop it on any other refusal', async () => {
    // Arrange — the first claim is accepted and issues a token; every later claim is read and refused.
    const h = harness({ claimed: PROBING });
    h.carrier.start();
    const first = await h.peerAt(0);
    await h.carrying();
    should(first.claims[0]?.replaces).equal(undefined);
    h.server.defaults.claimed = undefined;

    // Act — the holding socket ends; the next claim offers the token and is refused with 4409, then with 4401.
    first.ws.terminate();
    await waitFor(() => h.lines.some(line => line.includes('disconnected')), 'the drop to be reported');
    h.redial(2);
    const second = await refuseClaimOf(h, 1, SESSION_CLOSE_CODES.rendezvousClaimed);
    h.redial(3);
    const third = await refuseClaimOf(h, 2, SESSION_CLOSE_CODES.claimRejected);
    h.redial(4);
    const fourth = await h.peerAt(3);
    await waitFor(() => fourth.claims.length === 1, 'dial 4 to claim');

    // Assert — 4409 is a slot not yet swept, so the token stays; anything else says it is no use.
    should(second.claims[0]?.replaces).equal(HANDOVER);
    should(third.claims[0]?.replaces).equal(HANDOVER);
    should(fourth.claims[0]?.replaces).equal(undefined);
    should(JSON.stringify(h.carrier.status())).not.containEql(HANDOVER);
    should(h.lines.join('\n')).not.containEql(HANDOVER);
  });
});

describe('the relay carrier when a frame cannot be handled', () => {
  it('should close the socket with an internal error, and keep why, when answering the challenge fails', async () => {
    // Arrange — a signer that cannot sign.
    const h = harness({
      signer: {
        daemonId: DAEMON_ID,
        sign: async () => {
          throw new Error('the signing key is unavailable');
        },
      },
    });

    // Act
    h.carrier.start();
    const peer = await h.peerAt(0);
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon refuse the frame');

    // Assert
    should(peer.closed).deepEqual({
      code: SESSION_CLOSE_CODES.relayInternal,
      reason: 'the daemon could not carry this frame',
    });
    await waitFor(() => h.lines.length > 0, 'the drop to be reported');
    should(h.carrier.status().detail).equal('the relay link failed: the signing key is unavailable');
  });

  it('should close the socket as a protocol error when a message is neither text nor bytes', async () => {
    // Arrange — a socket that keeps `blob`, which is what a runtime hands a carrier that never asked for bytes.
    const h = harness({ keepBlobs: true });

    // Act
    h.carrier.start();
    const peer = await h.peerAt(0);
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon refuse the message');

    // Assert
    should(peer.closed).deepEqual({ code: SESSION_CLOSE_CODES.protocolError, reason: 'unsupported message type' });
    await waitFor(() => h.lines.length > 0, 'the drop to be reported');
    should(h.carrier.status().detail).equal('the carrier sent a message that is neither text nor bytes');
  });

  it('should refuse a text message that is not a heartbeat', async () => {
    // Arrange
    const h = harness({ claimed: undefined });
    h.carrier.start();
    const peer = await h.peerAt(0);
    await h.opened(0);

    // Act
    peer.ws.send('hello');
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon refuse the message');

    // Assert
    should(peer.closed?.code).equal(SESSION_CLOSE_CODES.protocolError);
    should(peer.closed?.reason).equal('the carrier sent an unknown text message');
  });
});

describe('the relay carrier as the kernel hosts it', () => {
  it('should report off before it runs and while it is switched off, then starting, ready and off again', async () => {
    // Arrange
    const h = harness();
    const wrapper = new RelayCarrier(h.dependencies);
    should(wrapper.status()).deepEqual({ state: 'off', sentence: 'the relay carrier is stopped' });

    // Act — an aborted signal never starts it.
    const refused = new AbortController();
    refused.abort();
    await wrapper.start(new FakeSessions(), refused.signal);

    // Assert
    should(h.taps).have.length(0);

    // Act — a live signal dials.
    const live = new AbortController();
    await wrapper.start(new FakeSessions(), live.signal);

    // Assert
    should(wrapper.status()).deepEqual({ state: 'starting', sentence: 'dialling the rendezvous' });
    await waitFor(() => wrapper.status().state === 'ready', 'the rendezvous to hold the claim');
    should(wrapper.status()).deepEqual({ state: 'ready', sentence: 'the rendezvous holds this daemon’s claim' });

    // Act — aborting stops it for good.
    live.abort();
    const peer = await h.peerAt(0);
    await waitFor(() => peer.closed !== undefined, 'the rendezvous to see the daemon close');

    // Assert
    should(peer.closed).deepEqual({ code: 1000, reason: 'the daemon is shutting down' });
    should(wrapper.status()).deepEqual({ state: 'off', sentence: 'the relay carrier is stopped' });
  });

  it('should say why it is off when no relay is configured', async () => {
    // Arrange
    const h = harness();
    const wrapper = new RelayCarrier({ ...h.dependencies, config: undefined });

    // Act
    await wrapper.start(new FakeSessions(), new AbortController().signal);

    // Assert
    should(wrapper.status().state).equal('off');
    should(wrapper.status().sentence).match(/no relay is configured/u);
  });
});
