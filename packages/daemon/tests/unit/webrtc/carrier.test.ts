/**
 * The WebRTC carrier's own decisions, against fakes of the engine, the channels and the sessions.
 *
 * What a data channel CARRIES is the direct session, proved elsewhere against real crypto; what is
 * proved here is what this carrier adds — the bounds on peers and channels, a peer replacing the one
 * its own app left stranded, a close code crossing a transport that has none, and an arrival that is
 * never local.
 */

import { describe, it } from 'bun:test';
import { WEBRTC_SESSION_CHANNEL_LABEL } from '@ferretry/protocol';
import {
  decodeControlMessage,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  type SessionId,
  sessionIdFromBytes,
} from '@ferretry/relay';
import should from 'should';
import type { SessionDevice } from '../../../src/lib/api/http.ts';
import type { SocketDownstream, SocketFrame } from '../../../src/lib/api/socket.ts';
import type { SessionArrival } from '../../../src/lib/relay/tunnel.ts';
import {
  MAX_WEBRTC_CHANNELS_PER_PEER,
  MAX_WEBRTC_PEERS,
  MAX_WEBRTC_PEERS_PER_DEVICE,
  WEBRTC_ENGINE_LINGER_MS,
  WEBRTC_PEER_IDLE_MS,
  type WebRtcAnswer,
  type WebRtcAvailability,
  WebRtcCarrier,
  type WebRtcChannelPort,
  WebRtcEngineUnavailable,
  WebRtcOfferRefused,
  type WebRtcPeerEngine,
  type WebRtcPeerPort,
  type WebRtcSession,
  webrtcArrival,
  webrtcRateLimitIdentity,
} from '../../../src/lib/webrtc/index.ts';

const SESSION_ID = sessionIdFromBytes(new Uint8Array(16).fill(7)) as SessionId;

class FakeChannel implements WebRtcChannelPort {
  readonly sent: Array<Uint8Array | string> = [];
  accepts = true;
  buffered = 0;
  closed = false;
  #message: ((frame: string | Uint8Array) => void) | undefined;
  #closed: (() => void) | undefined;

  constructor(readonly label: string = WEBRTC_SESSION_CHANNEL_LABEL) {}

  send(frame: Uint8Array): boolean {
    if (!this.accepts) return false;
    this.sent.push(frame);
    return true;
  }

  sendText(text: string): boolean {
    if (!this.accepts) return false;
    this.sent.push(text);
    return true;
  }

  bufferedBytes(): number {
    return this.buffered;
  }

  close(): void {
    this.closed = true;
  }

  onMessage(listener: (frame: string | Uint8Array) => void): void {
    this.#message = listener;
  }

  onClosed(listener: () => void): void {
    this.#closed = listener;
  }

  deliver(frame: string | Uint8Array): void {
    this.#message?.(frame);
  }

  end(): void {
    this.#closed?.();
  }
}

class FakePeer implements WebRtcPeerPort {
  closed = false;
  #channel: ((channel: WebRtcChannelPort) => void) | undefined;
  #ended: (() => void) | undefined;

  onChannel(listener: (channel: WebRtcChannelPort) => void): void {
    this.#channel = listener;
  }

  onClosed(listener: () => void): void {
    this.#ended = listener;
  }

  close(): void {
    this.closed = true;
  }

  open(channel: FakeChannel): FakeChannel {
    this.#channel?.(channel);
    return channel;
  }

  fail(): void {
    this.#ended?.();
  }
}

class FakeEngine implements WebRtcPeerEngine {
  readonly peers: FakePeer[] = [];
  released = 0;
  readonly asked: Array<{ readonly sdp: string; readonly iceServers: readonly string[] }> = [];
  next: ((offer: string) => Promise<WebRtcAnswer>) | undefined;

  async answer(offerSdp: string, iceServers: readonly string[]): Promise<WebRtcAnswer> {
    this.asked.push({ sdp: offerSdp, iceServers });
    if (this.next !== undefined) return await this.next(offerSdp);
    const peer = new FakePeer();
    this.peers.push(peer);
    return { sdp: `answer to ${offerSdp}`, peer };
  }

  release(): void {
    this.released += 1;
  }
}

class ManualScheduler {
  readonly timers: Array<{ readonly ms: number; readonly action: () => void; cancelled: boolean }> = [];

  after(ms: number, action: () => void): { cancel(): void } {
    const timer = { ms, action, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  fireLive(): void {
    for (const timer of this.timers.filter(each => !each.cancelled)) {
      timer.cancelled = true;
      timer.action();
    }
  }

  live(): number {
    return this.timers.filter(each => !each.cancelled).length;
  }
}

class FakeSession implements WebRtcSession {
  readonly sessionId = SESSION_ID;
  readonly received: SocketFrame[] = [];
  opened = false;
  closed = false;
  failOpen = false;
  #resolveOpen: (() => void) | undefined;

  constructor(
    readonly arrival: SessionArrival,
    readonly downstream: SocketDownstream,
    readonly release: () => void,
    readonly holdOpen: boolean,
  ) {}

  async open(): Promise<void> {
    if (this.failOpen) throw new Error('no link');
    if (this.holdOpen) await new Promise<void>(resolve => (this.#resolveOpen = resolve));
    this.opened = true;
  }

  finishOpen(): void {
    this.#resolveOpen?.();
  }

  fromClient(frame: SocketFrame): void {
    this.received.push(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }
}

interface Harness {
  readonly subject: WebRtcCarrier;
  readonly engine: FakeEngine;
  readonly scheduler: ManualScheduler;
  readonly sessions: FakeSession[];
}

function harness(
  options: {
    readonly availability?: WebRtcAvailability;
    readonly noSessions?: boolean;
    readonly holdOpen?: boolean;
    readonly failOpen?: boolean;
  } = {},
): Harness {
  const engine = new FakeEngine();
  const scheduler = new ManualScheduler();
  const sessions: FakeSession[] = [];
  let minted = 0;
  const subject = new WebRtcCarrier({
    availability: options.availability ?? { kind: 'ready' },
    engine,
    iceServers: ['stun:stun.example.test:3478'],
    sessions: (arrival, downstream, release) => {
      if (options.noSessions === true) return undefined;
      const session = new FakeSession(arrival, downstream, release, options.holdOpen === true);
      session.failOpen = options.failOpen === true;
      sessions.push(session);
      return session;
    },
    scheduler,
    peerId: () => {
      minted += 1;
      return `peer-${minted}`;
    },
  });
  return { subject, engine, scheduler, sessions };
}

const device = (deviceId: string, appSession = 'app-1'): SessionDevice => ({ deviceId, appSession });

/** Let every settled promise's continuation run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

function controlOf(frame: Uint8Array | string | undefined): ReturnType<typeof decodeControlMessage> {
  if (!(frame instanceof Uint8Array)) return null;
  const decoded = decodeFrame(frame);
  return decoded.ok ? decodeControlMessage(decoded.frame.payload) : null;
}

describe('the WebRTC carrier', () => {
  describe('answering an offer', () => {
    it.each<[WebRtcAvailability & { readonly kind: 'refused' }]>([
      [{ kind: 'refused', code: 'webrtc_disabled', reason: 'switched off in daemon.json' }],
      [{ kind: 'refused', code: 'webrtc_unavailable', reason: 'the engine could not be loaded' }],
    ])('should refuse every offer while the carrier is %j, saying why', async availability => {
      // Arrange
      const { subject, engine } = harness({ availability });

      // Act
      const actual = await subject.offer('offer', device('a'));

      // Assert
      should(actual).deepEqual({ kind: 'refused', status: 503, code: availability.code, reason: availability.reason });
      should(engine.asked).be.empty();
    });

    it('should answer through the engine with the configured STUN servers and hold the peer', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();

      // Act
      const actual = await subject.offer('the offer', device('a'));

      // Assert
      should(actual).deepEqual({ kind: 'answered', sdp: 'answer to the offer' });
      should(engine.asked).deepEqual([{ sdp: 'the offer', iceServers: ['stun:stun.example.test:3478'] }]);
      should(subject.peers).equal(1);
      should(scheduler.timers.map(timer => timer.ms)).deepEqual([WEBRTC_PEER_IDLE_MS]);
    });

    it('should replace the peer the same running copy of the app left behind, rather than add one', async () => {
      // Arrange — a phone that changed networks offers again from the same page.
      const { subject, engine } = harness();
      await subject.offer('first', device('a', 'tab-1'));
      await subject.offer('elsewhere', device('a', 'tab-2'));

      // Act
      await subject.offer('again', device('a', 'tab-1'));

      // Assert
      should(engine.peers.map(peer => peer.closed)).deepEqual([true, false, false]);
      should(subject.peers).equal(2);
    });

    it('should replace a device’s oldest peer once it holds as many as one device may', async () => {
      // Arrange
      const { subject, engine } = harness();
      for (let tab = 0; tab < MAX_WEBRTC_PEERS_PER_DEVICE; tab += 1)
        await subject.offer('o', device('a', `tab-${tab}`));
      await subject.offer('o', device('b'));

      // Act
      await subject.offer('o', device('a', 'one more'));

      // Assert
      should(engine.peers.map(peer => peer.closed)).deepEqual([true, false, false, false, false, false]);
      should(subject.peers).equal(MAX_WEBRTC_PEERS_PER_DEVICE + 1);
    });

    it('should refuse past the daemon’s peer bound, counting offers still being answered', async () => {
      // Arrange — one offer short of the bound is held inside the engine, then every slot fills.
      const { subject, engine } = harness();
      for (let each = 0; each < MAX_WEBRTC_PEERS - 1; each += 1) await subject.offer('o', device(`d${each}`));
      let release: (() => void) | undefined;
      engine.next = async () => {
        await new Promise<void>(resolve => (release = resolve));
        const peer = new FakePeer();
        return { sdp: 'late', peer };
      };
      const held = subject.offer('o', device('held'));
      await settle();
      engine.next = undefined;

      // Act
      const actual = await subject.offer('o', device('newcomer'));
      release?.();
      const late = await held;

      // Assert
      should(actual).deepEqual({
        kind: 'refused',
        status: 429,
        code: 'webrtc_busy',
        reason: 'this daemon is holding as many peer-to-peer connections as it carries',
      });
      should(late).deepEqual({ kind: 'answered', sdp: 'late' });
      should(subject.peers).equal(MAX_WEBRTC_PEERS);
    });

    it('should answer an offer the engine refused with a 400, and free the slot it reserved', async () => {
      // Arrange
      const { subject, engine } = harness();
      engine.next = async () => {
        throw new WebRtcOfferRefused('bad m-line');
      };

      // Act
      const actual = await subject.offer('nonsense', device('a'));

      // Assert
      should(actual).deepEqual({
        kind: 'refused',
        status: 400,
        code: 'webrtc_offer_invalid',
        reason: 'this daemon could not use that offer',
      });
      should(subject.peers).equal(0);
    });

    it('should let an engine fault escape as one, and still free the slot it reserved', async () => {
      // Arrange
      const { subject, engine } = harness();
      engine.next = async () => {
        throw new Error('native crash');
      };

      // Act + Assert
      await should(subject.offer('o', device('a'))).be.rejectedWith('native crash');
      engine.next = undefined;
      should((await subject.offer('o', device('a'))).kind).equal('answered');
    });
  });

  describe('holding peers', () => {
    it('should close a peer that has held no session for the idle period', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      await subject.offer('o', device('a'));

      // Act
      scheduler.fireLive();

      // Assert
      should(engine.peers[0]?.closed).be.true();
      should(subject.peers).equal(0);
    });

    it('should forget a peer whose connection failed, and end the sessions it carried', async () => {
      // Arrange
      const { subject, engine, sessions } = harness();
      await subject.offer('o', device('a'));
      const peer = engine.peers[0] as FakePeer;
      peer.open(new FakeChannel());
      await settle();

      // Act
      peer.fail();
      peer.fail();

      // Assert
      should(subject.peers).equal(0);
      should(sessions[0]?.closed).be.true();
      should(peer.closed).be.true();
    });

    it('should close every peer when the daemon stops', async () => {
      // Arrange
      const { subject, engine } = harness();
      await subject.offer('o', device('a'));
      await subject.offer('o', device('b'));

      // Act
      subject.close();

      // Assert
      should(engine.peers.every(peer => peer.closed)).be.true();
      should(subject.peers).equal(0);
    });
  });

  describe('the engine’s lifetime', () => {
    /** The engine hand-backs still waiting to fire. */
    const lingers = (scheduler: ManualScheduler) =>
      scheduler.timers.filter(timer => !timer.cancelled && timer.ms === WEBRTC_ENGINE_LINGER_MS);

    it('should ask the engine nothing before the first offer', () => {
      // Arrange + Act
      const { engine, scheduler } = harness();

      // Assert
      should(engine.asked).be.empty();
      should(engine.released).equal(0);
      should(scheduler.timers).be.empty();
    });

    it('should hand the engine back once its last peer has ended for the linger, and not before', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      await subject.offer('o', device('a'));
      await subject.offer('o', device('b'));
      const [first, second] = engine.peers as [FakePeer, FakePeer];

      // Act
      first.fail();
      const whileOneIsOpen = lingers(scheduler).length;
      second.fail();
      const armed = lingers(scheduler);
      armed[0]?.action();

      // Assert
      should(whileOneIsOpen).equal(0);
      should(armed).have.length(1);
      should(engine.released).equal(1);
    });

    it('should keep the engine for an offer that arrives inside the linger', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      await subject.offer('o', device('a', 'app-1'));
      (engine.peers[0] as FakePeer).fail();
      const armed = lingers(scheduler)[0];

      // Act
      await subject.offer('o', device('a', 'app-2'));

      // Assert
      should(armed?.cancelled).be.true();
      should(lingers(scheduler)).be.empty();
      should(engine.released).equal(0);
    });

    it('should not hand the engine back while an offer is still being answered', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      await subject.offer('o', device('a', 'app-1'));
      let answer: (() => void) | undefined;
      engine.next = async () => {
        await new Promise<void>(resolve => (answer = resolve));
        throw new WebRtcOfferRefused('bad m-line');
      };
      const pending = subject.offer('o', device('a', 'app-2'));
      (engine.peers[0] as FakePeer).fail();

      // Act
      const whileAnswering = lingers(scheduler).length;
      answer?.();
      await pending;

      // Assert
      should(whileAnswering).equal(0);
      should(lingers(scheduler)).have.length(1);
    });

    it('should refuse an offer as `webrtc_unavailable` when the engine cannot start, saying why', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      engine.next = async () => {
        throw new WebRtcEngineUnavailable('the WebRTC engine could not be loaded on linux-riscv64 (no addon)');
      };

      // Act
      const actual = await subject.offer('o', device('a'));

      // Assert
      should(actual).deepEqual({
        kind: 'refused',
        status: 503,
        code: 'webrtc_unavailable',
        reason: 'the WebRTC engine could not be loaded on linux-riscv64 (no addon)',
      });
      should(subject.peers).equal(0);
      should(lingers(scheduler)).have.length(1);
    });

    it('should not hand the engine back when the daemon stops, nor arm anything after', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      await subject.offer('o', device('a'));
      (engine.peers[0] as FakePeer).fail();

      // Act
      subject.close();
      subject.close();

      // Assert
      should(scheduler.live()).equal(0);
      should(engine.released).equal(0);
    });
  });

  describe('a channel', () => {
    async function onePeer(
      options: Parameters<typeof harness>[0] = {},
    ): Promise<Harness & { readonly peer: FakePeer }> {
      const built = harness(options);
      await built.subject.offer('o', device('a'));
      return { ...built, peer: built.engine.peers[0] as FakePeer };
    }

    it('should run one session per channel, arriving remote and keyed by its peer connection', async () => {
      // Arrange
      const { peer, sessions, scheduler } = await onePeer();

      // Act
      peer.open(new FakeChannel());
      await settle();

      // Assert
      should(sessions).have.length(1);
      should(sessions[0]?.arrival).deepEqual({
        loopback: false,
        privilegedLoopback: false,
        clientAddress: 'webrtc-peer:peer-1',
      });
      should(sessions[0]?.opened).be.true();
      // The peer is busy now, so its idle close is no longer armed.
      should(scheduler.live()).equal(0);
    });

    it.each([
      ['a channel with another label', new FakeChannel('unexpected')],
      ['an unlabelled channel', new FakeChannel('')],
    ])('should close %s at once, opening no session', async (_name, channel) => {
      // Arrange
      const { peer, sessions } = await onePeer();

      // Act
      peer.open(channel);

      // Assert
      should(channel.closed).be.true();
      should(sessions).be.empty();
    });

    it('should close a channel that arrives after its peer was closed', async () => {
      // Arrange
      const { subject, peer, sessions } = await onePeer();
      subject.close();
      const channel = new FakeChannel();

      // Act
      peer.open(channel);

      // Assert
      should(channel.closed).be.true();
      should(sessions).be.empty();
    });

    it('should close a channel past the per-peer bound', async () => {
      // Arrange
      const { peer, sessions } = await onePeer();
      for (let each = 0; each < MAX_WEBRTC_CHANNELS_PER_PEER; each += 1) peer.open(new FakeChannel());
      const extra = new FakeChannel();

      // Act
      peer.open(extra);

      // Assert
      should(extra.closed).be.true();
      should(sessions).have.length(MAX_WEBRTC_CHANNELS_PER_PEER);
    });

    it('should close a channel when this daemon cannot run sessions at all', async () => {
      // Arrange
      const { peer } = await onePeer({ noSessions: true });
      const channel = new FakeChannel();

      // Act
      peer.open(channel);

      // Assert
      should(channel.closed).be.true();
    });

    it('should hold frames that arrive before the session opened, then deliver them in order', async () => {
      // Arrange
      const { peer, sessions } = await onePeer({ holdOpen: true });
      const channel = peer.open(new FakeChannel());
      const early = new Uint8Array([1, 2, 3]);

      // Act
      channel.deliver(early);
      channel.deliver('fy-ping');
      should(sessions[0]?.received).be.empty();
      sessions[0]?.finishOpen();
      await settle();
      channel.deliver('fy-pong');

      // Assert
      should(sessions[0]?.received).deepEqual([early, 'fy-ping', 'fy-pong']);
    });

    it('should carry the session’s frames: bytes as bytes, the heartbeat as text, and the backlog honestly', async () => {
      // Arrange
      const { peer, sessions } = await onePeer();
      const channel = peer.open(new FakeChannel());
      await settle();
      const downstream = sessions[0]?.downstream as SocketDownstream;
      channel.buffered = 4096;

      // Act
      const bytes = downstream.send(new Uint8Array(10));
      const text = downstream.send('fy-pong');
      channel.accepts = false;
      const refusedBytes = downstream.send(new Uint8Array(3));
      const refusedText = downstream.send('fy-ping');

      // Assert
      should([bytes, text, refusedBytes, refusedText]).deepEqual([10, 7, -1, -1]);
      should(downstream.bufferedBytes()).equal(4096);
      should(channel.sent).deepEqual([new Uint8Array(10), 'fy-pong']);
    });

    it('should send the close code as the session’s own `closed`, because a data channel has none', async () => {
      // Arrange
      const { peer, sessions } = await onePeer();
      const channel = peer.open(new FakeChannel());
      await settle();
      const downstream = sessions[0]?.downstream as SocketDownstream;

      // Act
      downstream.close(4403, 'the device was not accepted');
      downstream.close(4400, 'a second close changes nothing');

      // Assert
      should(channel.closed).be.true();
      should(channel.sent).have.length(1);
      should(controlOf(channel.sent[0])).deepEqual({ t: 'closed', code: 4403, reason: 'the device was not accepted' });
      should(decodeFrame(channel.sent[0] as Uint8Array)).match({ ok: true, frame: { sessionId: SESSION_ID } });
      should(downstream.send(new Uint8Array(1))).equal(-1);
    });

    it('should not send a second `closed` after the session already sent its own', async () => {
      // Arrange
      const { peer, sessions } = await onePeer();
      const channel = peer.open(new FakeChannel());
      await settle();
      const downstream = sessions[0]?.downstream as SocketDownstream;
      const ready = encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
      });
      const closed = encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({ t: 'closed', code: 4441, reason: 'the access lease ended' }),
      });
      const data = encodeFrame({
        kind: FRAME_KINDS.data,
        sessionId: SESSION_ID,
        sequence: 1,
        payload: new Uint8Array(20),
      });

      // Act
      downstream.send(ready);
      downstream.send(data);
      downstream.send(closed);
      downstream.close(4441, 'the access lease ended');

      // Assert
      should(channel.sent).deepEqual([ready, data, closed]);
      should(channel.closed).be.true();
    });

    it('should close without a `closed` for a code that is not a session code', async () => {
      // Arrange
      const { peer, sessions } = await onePeer();
      const channel = peer.open(new FakeChannel());
      await settle();

      // Act
      sessions[0]?.downstream.close(1000, 'done');

      // Assert
      should(channel.sent).be.empty();
      should(channel.closed).be.true();
    });

    it('should end the session when the channel closes, and re-arm the idle close once none is left', async () => {
      // Arrange
      const { peer, sessions, scheduler } = await onePeer();
      const channel = peer.open(new FakeChannel());
      await settle();

      // Act
      channel.end();
      sessions[0]?.release();

      // Assert
      should(sessions[0]?.closed).be.true();
      should(sessions[0]?.downstream.send('fy-ping')).equal(-1);
      should(scheduler.live()).equal(1);
    });

    it('should keep a peer whose idle close fires while it still carries a session', async () => {
      // Arrange
      const { subject, engine, scheduler } = harness();
      await subject.offer('o', device('a'));
      const peer = engine.peers[0] as FakePeer;
      const idle = scheduler.timers[0];
      peer.open(new FakeChannel());
      await settle();

      // Act — the timer was cancelled, but a timer that fires anyway must still check.
      idle?.action();

      // Assert
      should(peer.closed).be.false();
      should(subject.peers).equal(1);
    });

    it('should not re-arm the idle close for a session that ends after its peer did', async () => {
      // Arrange
      const { subject, peer, sessions, scheduler } = await onePeer();
      peer.open(new FakeChannel());
      await settle();

      // Act
      subject.close();

      // Assert
      should(sessions[0]?.closed).be.true();
      should(scheduler.live()).equal(0);
    });

    it('should end a channel whose session could not open, with the session’s `closed`', async () => {
      // Arrange
      const { peer } = await onePeer({ failOpen: true });

      // Act
      const channel = peer.open(new FakeChannel());
      await settle();

      // Assert
      should(controlOf(channel.sent[0])).deepEqual({
        t: 'closed',
        code: 4500,
        reason: 'the daemon could not open this session',
      });
      should(channel.closed).be.true();
    });
  });

  it.each([
    ['peer-1', 'webrtc-peer:peer-1'],
    ['Zm9vYmFy', 'webrtc-peer:Zm9vYmFy'],
  ])('should key the rate limit of every session on peer %s by that peer alone', (peerId, expected) => {
    // Act + Assert
    should(webrtcRateLimitIdentity(peerId)).equal(expected);
    should(webrtcArrival(peerId)).deepEqual({ loopback: false, privilegedLoopback: false, clientAddress: expected });
  });
});
