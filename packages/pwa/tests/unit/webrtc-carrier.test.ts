/**
 * The browser half of the WebRTC carrier, against a scripted peer connection and a manual clock.
 *
 * What a real data channel carries is proved by the daemon's two-peer integration test and the
 * real-browser journey; what is proved here is this module's own decisions — when it signals, how long
 * it waits and what it says when it gives up, that one negotiation serves every later session, and that
 * nothing reaches the session before the router is listening.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  browserWebRtcDialer,
  WEBRTC_CHANNEL_OPEN_DEADLINE_MS,
  WEBRTC_NO_PATH_REASON,
  WebRtcCarrier,
  type WebRtcDataChannelLike,
  WebRtcDialer,
  type WebRtcPeerLike,
  type WebRtcSignalOutcome,
  type WebRtcTimers,
  webrtcSignaller,
} from '../../src/lib/webrtc-carrier.ts';

class ManualTimers implements WebRtcTimers {
  #now = 0;
  #next = 1;
  readonly #due = new Map<number, { readonly at: number; readonly action: () => void }>();

  setTimeout(action: () => void, milliseconds: number): unknown {
    const id = this.#next;
    this.#next += 1;
    this.#due.set(id, { at: this.#now + milliseconds, action });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  /** Advance the clock, running every timer that comes due in order. */
  advance(milliseconds: number): void {
    const until = this.#now + milliseconds;
    for (;;) {
      const next = [...this.#due.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.#due.delete(next[0]);
      this.#now = next[1].at;
      next[1].action();
    }
    this.#now = until;
  }
}

class FakeChannel implements WebRtcDataChannelLike {
  readyState = 'connecting';
  binaryType = 'blob';
  readonly sent: Array<ArrayBuffer | string> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;

  send(data: ArrayBuffer | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
}

class FakePeer implements WebRtcPeerLike {
  connectionState = 'new';
  iceGatheringState = 'new';
  localDescription: { readonly sdp: string } | null = null;
  readonly channels: FakeChannel[] = [];
  readonly remote: string[] = [];
  closed = false;
  opensAtOnce = false;
  stats: Array<[string, unknown]> = [];
  onicecandidate: ((event: { readonly candidate: { readonly type?: string | null } | null }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(readonly iceServers: readonly { readonly urls: string }[]) {}

  createDataChannel(): WebRtcDataChannelLike {
    const channel = new FakeChannel();
    if (this.opensAtOnce) channel.readyState = 'open';
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{ readonly type: string; readonly sdp?: string }> {
    return { type: 'offer', sdp: 'browser offer' };
  }

  async setLocalDescription(description: { readonly type: string; readonly sdp?: string }): Promise<void> {
    this.localDescription = { sdp: description.sdp ?? '' };
  }

  async setRemoteDescription(description: { readonly type: 'answer'; readonly sdp: string }): Promise<void> {
    this.remote.push(description.sdp);
  }

  async getStats(): Promise<Iterable<[string, unknown]>> {
    return this.stats;
  }

  close(): void {
    this.closed = true;
  }

  gatherComplete(): void {
    this.iceGatheringState = 'complete';
    this.onicegatheringstatechange?.();
  }

  connect(): void {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
    this.channels[0]?.open();
  }

  enter(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

interface Harness {
  readonly subject: WebRtcCarrier;
  readonly timers: ManualTimers;
  readonly peers: FakePeer[];
  readonly offers: string[];
  answer: (offer: string) => Promise<WebRtcSignalOutcome>;
}

function harness(): Harness {
  const timers = new ManualTimers();
  const peers: FakePeer[] = [];
  const offers: string[] = [];
  const built: Harness = {
    timers,
    peers,
    offers,
    answer: async () => ({ kind: 'answered', sdp: 'daemon answer' }),
    subject: new WebRtcCarrier({
      createPeer: configuration => {
        const peer = new FakePeer(configuration.iceServers);
        peers.push(peer);
        return peer;
      },
      signal: async offer => {
        offers.push(offer);
        return await built.answer(offer);
      },
      iceServers: ['stun:stun.cloudflare.com:3478'],
      timers,
    }),
  };
  return built;
}

/** Drive one negotiation to a connected peer, returning the dialled socket. */
async function connected(built: Harness, signal = new AbortController().signal) {
  const dial = built.subject.dial(signal);
  await settle();
  built.peers.at(-1)?.gatherComplete();
  await settle();
  built.peers.at(-1)?.connect();
  return await dial;
}

describe('the WebRTC carrier, browser side', () => {
  it('should negotiate once with the configured STUN servers, signalling the gathered offer', async () => {
    // Arrange
    const built = harness();

    // Act
    const socket = await connected(built);

    // Assert
    should(built.peers).have.length(1);
    should(built.peers[0]?.iceServers).deepEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    should(built.offers).deepEqual(['browser offer']);
    should(built.peers[0]?.remote).deepEqual(['daemon answer']);
    should(socket.onOpen).be.null();
  });

  it('should signal at the first gathering bound — a grace after the first public address, or the cap', async () => {
    // Arrange
    const viaGrace = harness();
    const viaCap = harness();

    // Act
    void viaGrace.subject.dial(new AbortController().signal);
    void viaCap.subject.dial(new AbortController().signal);
    await settle();
    viaGrace.peers[0]?.onicecandidate?.({ candidate: { type: 'host' } });
    viaGrace.peers[0]?.onicecandidate?.({ candidate: { type: 'srflx' } });
    viaGrace.peers[0]?.onicecandidate?.({ candidate: { type: 'srflx' } });
    viaGrace.timers.advance(249);
    await settle();
    const beforeGrace = viaGrace.offers.length;
    viaGrace.timers.advance(1);
    viaCap.timers.advance(2_999);
    await settle();
    const beforeCap = viaCap.offers.length;
    viaCap.timers.advance(1);
    await settle();

    // Assert
    should([beforeGrace, viaGrace.offers.length]).deepEqual([0, 1]);
    should([beforeCap, viaCap.offers.length]).deepEqual([0, 1]);
  });

  it('should hand back a channel that is already open on a connected peer without waiting for it to open', async () => {
    // Arrange
    const built = harness();
    await connected(built);
    const peer = built.peers[0];
    if (peer === undefined) throw new Error('no peer was negotiated');
    peer.opensAtOnce = true;

    // Act
    const second = await built.subject.dial(new AbortController().signal);

    // Assert
    should(built.peers).have.length(1);
    should(peer.channels).have.length(2);
    should(peer.channels[1]?.readyState).equal('open');
    should(peer.channels[1]?.onopen).be.null();
    should(peer.closed).be.false();
    should(second.onOpen).be.null();
  });

  it('should treat the end-of-candidates event as gathering complete', async () => {
    // Arrange
    const built = harness();

    // Act
    void built.subject.dial(new AbortController().signal);
    await settle();
    built.peers[0]?.onicecandidate?.({ candidate: null });
    await settle();

    // Assert
    should(built.offers).have.length(1);
  });

  it('should give up at the deadline with the sentence the walk shows, and close the peer', async () => {
    // Arrange
    const built = harness();
    const dial = built.subject.dial(new AbortController().signal);
    await settle();
    built.peers[0]?.gatherComplete();
    await settle();

    // Act
    built.timers.advance(8_000);

    // Assert
    await should(dial).be.rejectedWith(WEBRTC_NO_PATH_REASON);
    should(built.peers[0]?.closed).be.true();
  });

  it('should reject with the daemon’s own sentence when it refuses the offer', async () => {
    // Arrange
    const built = harness();
    built.answer = async () => ({ kind: 'refused', reason: 'peer-to-peer connections are switched off' });

    // Act
    const dial = built.subject.dial(new AbortController().signal);
    await settle();
    built.peers[0]?.gatherComplete();

    // Assert
    await should(dial).be.rejectedWith('peer-to-peer connections are switched off');
    should(built.peers[0]?.closed).be.true();
  });

  it('should reject when the browser produced no offer', async () => {
    // Arrange
    const built = harness();
    const dial = built.subject.dial(new AbortController().signal);
    await settle();
    (built.peers[0] as FakePeer).localDescription = null;

    // Act
    built.peers[0]?.gatherComplete();

    // Assert
    await should(dial).be.rejectedWith('this browser produced no WebRTC offer');
  });

  it('should stop waiting when the attempt is cancelled', async () => {
    // Arrange
    const built = harness();
    const abort = new AbortController();
    const dial = built.subject.dial(abort.signal);
    await settle();
    built.peers[0]?.gatherComplete();
    await settle();

    // Act
    abort.abort();

    // Assert
    await should(dial).be.rejectedWith('the WebRTC attempt was cancelled');
  });

  it('should open every later session as a new channel on the same connection, with no signalling', async () => {
    // Arrange
    const built = harness();
    await connected(built);

    // Act
    const second = built.subject.dial(new AbortController().signal);
    built.peers[0]?.channels[1]?.open();
    await second;

    // Assert
    should(built.peers).have.length(1);
    should(built.offers).have.length(1);
    should(built.peers[0]?.channels).have.length(2);
  });

  it('should keep a message that arrived in the same turn as its channel opened (measured in Chrome)', async () => {
    // Arrange — on a connected peer the daemon's `ready` can land in the very task that opens the channel.
    const built = harness();
    await connected(built);
    const second = built.subject.dial(new AbortController().signal);
    const channel = built.peers[0]?.channels[1] as FakeChannel;
    const ready = new Uint8Array([0xfe, 1]).buffer;

    // Act
    channel.open();
    channel.onmessage?.({ data: ready });
    const socket = await second;
    const events: string[] = [];
    socket.onOpen = () => events.push('open');
    socket.onBinary = bytes => events.push(`bytes ${[...bytes].join(',')}`);
    built.timers.advance(0);

    // Assert
    should(events).deepEqual(['open', 'bytes 254,1']);
  });

  it('should share one negotiation between dials that arrive together', async () => {
    // Arrange
    const built = harness();
    const first = built.subject.dial(new AbortController().signal);
    const second = built.subject.dial(new AbortController().signal);
    await settle();
    built.peers[0]?.gatherComplete();
    await settle();
    built.peers[0]?.connect();
    await settle();
    built.peers[0]?.channels[1]?.open();

    // Act
    await Promise.all([first, second]);

    // Assert
    should(built.peers).have.length(1);
    should(built.offers).have.length(1);
    should(built.peers[0]?.channels).have.length(2);
  });

  it('should drop a connection that cannot open a channel in time, so the next dial negotiates afresh', async () => {
    // Arrange — a phone that changed networks: the connection still reads connected, and is not.
    const built = harness();
    await connected(built);
    const stalled = built.subject.dial(new AbortController().signal);

    // Act
    built.timers.advance(WEBRTC_CHANNEL_OPEN_DEADLINE_MS);
    await should(stalled).be.rejectedWith('the peer-to-peer connection stopped answering');
    await connected(built);

    // Assert
    should(built.peers.map(peer => peer.closed)).deepEqual([true, false]);
    should(built.offers).have.length(2);
  });

  it.each(['failed', 'closed'])('should forget a connection that %s, and renegotiate on the next dial', async state => {
    // Arrange
    const built = harness();
    await connected(built);

    // Act
    built.peers[0]?.enter('disconnected');
    built.peers[0]?.enter(state);
    await connected(built);

    // Assert
    should(built.peers).have.length(2);
    should(built.peers[0]?.closed).be.true();
  });

  it('should announce the socket only after the dial resolved, holding what arrived before', async () => {
    // Arrange
    const built = harness();
    const socket = await connected(built);
    const channel = built.peers[0]?.channels[0] as FakeChannel;
    const events: string[] = [];
    channel.onmessage?.({ data: new Uint8Array([7]).buffer });
    channel.onmessage?.({ data: 'fy-ping' });
    socket.onOpen = () => events.push('open');
    socket.onBinary = bytes => events.push(`bytes ${[...bytes].join(',')}`);
    socket.onText = text => events.push(`text ${text}`);

    // Act
    built.timers.advance(0);
    channel.onmessage?.({ data: 'fy-pong' });

    // Assert
    should(events).deepEqual(['open', 'bytes 7', 'text fy-ping', 'text fy-pong']);
    should(channel.binaryType).equal('arraybuffer');
  });

  it('should send frames on their own buffer and text as text, and stop once closed', async () => {
    // Arrange
    const built = harness();
    const socket = await connected(built);
    const channel = built.peers[0]?.channels[0] as FakeChannel;
    const shared = new Uint8Array(new ArrayBuffer(8), 2, 3);

    // Act
    socket.send(shared);
    socket.sendText('fy-ping');
    socket.close(1000, 'done');
    socket.close(1000, 'again');
    socket.send(new Uint8Array(1));
    socket.sendText('after');

    // Assert
    should(channel.sent).have.length(2);
    should((channel.sent[0] as ArrayBuffer).byteLength).equal(3);
    should(channel.sent[1]).equal('fy-ping');
    should(channel.closed).be.true();
  });

  it('should report a channel the far side closed once, as an abnormal end with a readable reason', async () => {
    // Arrange
    const built = harness();
    const socket = await connected(built);
    const channel = built.peers[0]?.channels[0] as FakeChannel;
    const closes: Array<[number, string]> = [];
    socket.onClose = (code, reason) => closes.push([code, reason]);

    // Act
    channel.onclose?.();
    channel.onclose?.();

    // Assert
    should(closes).deepEqual([[1006, 'the peer-to-peer channel closed']]);
  });

  it('should close a channel that delivers a message of no type the protocol defines', async () => {
    // Arrange
    const built = harness();
    const socket = await connected(built);
    const channel = built.peers[0]?.channels[0] as FakeChannel;
    const closes: Array<[number, string]> = [];
    socket.onClose = (code, reason) => closes.push([code, reason]);
    built.timers.advance(0);

    // Act
    channel.onmessage?.({ data: new Blob(['x']) });
    channel.onclose?.();

    // Assert
    should(channel.closed).be.true();
    should(closes).deepEqual([[1006, 'the peer-to-peer channel delivered a message of an unknown type']]);
  });

  it('should not deliver held messages to a socket that closed before it was announced', async () => {
    // Arrange
    const built = harness();
    const socket = await connected(built);
    const channel = built.peers[0]?.channels[0] as FakeChannel;
    const texts: string[] = [];
    socket.onText = text => texts.push(text);
    channel.onmessage?.({ data: 'held' });

    // Act
    socket.close(1000, 'gone');
    built.timers.advance(0);

    // Assert
    should(texts).be.empty();
  });

  it('should measure the round trip of the nominated pair, else of any succeeded one, else nothing', async () => {
    // Arrange
    const built = harness();
    const none = await built.subject.rttMs();
    await connected(built);
    const peer = built.peers[0] as FakePeer;

    // Act
    peer.stats = [
      ['t', { type: 'transport' }],
      ['p1', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.0421 }],
    ];
    const anySucceeded = await built.subject.rttMs();
    peer.stats = [
      ['p0', { type: 'candidate-pair', state: 'in-progress', currentRoundTripTime: 0.5 }],
      ['p1', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.09 }],
      ['p2', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.0184 }],
    ];
    const nominated = await built.subject.rttMs();
    peer.stats = [];
    const unmeasured = await built.subject.rttMs();

    // Assert
    should([none, anySucceeded, nominated, unmeasured]).deepEqual([undefined, 42, 18, undefined]);
  });

  it('should close its connection when asked, and do nothing when it holds none', async () => {
    // Arrange
    const built = harness();
    built.subject.close();
    await connected(built);

    // Act
    built.subject.close();

    // Assert
    should(built.peers[0]?.closed).be.true();
  });
});

describe('the WebRTC signaller', () => {
  const respond = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('should post the offer through the introducer and read the daemon’s answer', async () => {
    // Arrange
    const sent: Array<{ path: string; init?: RequestInit }> = [];
    const subject = webrtcSignaller(async (path, init) => {
      sent.push({ path, ...(init === undefined ? {} : { init }) });
      return respond(200, { sdp: 'answer sdp' });
    });

    // Act
    const actual = await subject('offer sdp', new AbortController().signal);

    // Assert
    should(actual).deepEqual({ kind: 'answered', sdp: 'answer sdp' });
    should(sent[0]?.path).equal('/v1/webrtc/offer');
    should(sent[0]?.init).match({ method: 'POST', cache: 'no-store', body: JSON.stringify({ sdp: 'offer sdp' }) });
  });

  it.each<[string, number, unknown, string]>([
    [
      'an older daemon',
      404,
      { error: 'unknown route' },
      'this machine does not offer WebRTC yet — updating Ferretry on it adds it',
    ],
    [
      'a switched-off carrier',
      503,
      { error: 'peer-to-peer connections are switched off', code: 'webrtc_disabled' },
      'peer-to-peer connections are switched off',
    ],
    ['a refusal with no sentence', 429, { code: 'webrtc_busy' }, 'the machine refused WebRTC (429)'],
    ['a refusal with a blank sentence', 400, { error: '  ' }, 'the machine refused WebRTC (400)'],
    ['a body that is not JSON', 502, 'bad gateway', 'the machine refused WebRTC (502)'],
    [
      'an answer that is not one',
      200,
      { answer: 'x' },
      'the machine answered the WebRTC offer with something that is not an answer',
    ],
  ])('should turn %s into the sentence a person is shown', async (_name, status, body, expected) => {
    // Arrange
    const subject = webrtcSignaller(async () => respond(status, body));

    // Act
    const actual = await subject('offer', new AbortController().signal);

    // Assert
    should(actual).deepEqual({ kind: 'refused', reason: expected });
  });
});

describe('the WebRTC dialer', () => {
  function dialer() {
    const timers = new ManualTimers();
    const peers: FakePeer[] = [];
    const subject = new WebRtcDialer({
      createPeer: configuration => {
        const peer = new FakePeer(configuration.iceServers);
        peers.push(peer);
        return peer;
      },
      iceServers: [],
      timers,
    });
    const requests: string[] = [];
    const attempt = (daemonId: string, signal = new AbortController().signal) => ({
      daemon: { daemonId },
      signal,
      request: async (path: string) => {
        requests.push(`${daemonId} ${path}`);
        return new Response(JSON.stringify({ sdp: `answer for ${daemonId}` }), { status: 200 });
      },
    });
    /** Negotiate the newest peer to connected. */
    const connectNewest = async () => {
      await settle();
      peers.at(-1)?.gatherComplete();
      await settle();
      peers.at(-1)?.connect();
    };
    return { subject, peers, requests, attempt, connectNewest };
  }

  it('should keep one connection per daemon, signalling through that attempt’s introducer', async () => {
    // Arrange
    const { subject, peers, requests, attempt, connectNewest } = dialer();

    // Act
    const a = subject.dial(attempt('daemon-a'));
    await connectNewest();
    await a;
    const again = subject.dial(attempt('daemon-a'));
    peers[0]?.channels[1]?.open();
    await again;
    const b = subject.dial(attempt('daemon-b'));
    await connectNewest();
    await b;

    // Assert
    should(peers).have.length(2);
    should(requests).deepEqual(['daemon-a /v1/webrtc/offer', 'daemon-b /v1/webrtc/offer']);
    should(peers[0]?.remote).deepEqual(['answer for daemon-a']);
  });

  it('should close a daemon’s connection when the router abandons its attempt', async () => {
    // Arrange
    const { subject, peers, attempt, connectNewest } = dialer();
    const abort = new AbortController();
    const dialled = subject.dial(attempt('daemon-a', abort.signal));
    await connectNewest();
    await dialled;

    // Act
    abort.abort();
    const next = subject.dial(attempt('daemon-a'));
    await connectNewest();
    await next;

    // Assert
    should(peers.map(peer => peer.closed)).deepEqual([true, false]);
  });

  it('should not listen for an abort that already happened', async () => {
    // Arrange
    const { subject, attempt } = dialer();
    const abort = new AbortController();
    abort.abort();

    // Act + Assert
    await should(subject.dial(attempt('daemon-a', abort.signal))).be.rejectedWith('the WebRTC attempt was cancelled');
  });

  it('should drop every connection when the network changes, and report no round trip after', async () => {
    // Arrange
    const { subject, peers, attempt, connectNewest } = dialer();
    const dialled = subject.dial(attempt('daemon-a'));
    await connectNewest();
    await dialled;
    peers[0]?.stats.push([
      'p',
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.03 },
    ]);
    const before = await subject.rttMs('daemon-a');

    // Act
    subject.networkChanged();

    // Assert
    should(before).equal(30);
    should(peers[0]?.closed).be.true();
    should(await subject.rttMs('daemon-a')).be.undefined();
    should(await subject.rttMs('never-dialled')).be.undefined();
  });
});

describe('the browser’s own WebRTC dialer', () => {
  it('should be absent where the browser has no RTCPeerConnection', () => {
    // Act + Assert
    should(browserWebRtcDialer({})).be.undefined();
  });

  it('should dial with the browser’s RTCPeerConnection, asking the default STUN server', async () => {
    // Arrange
    const made: FakePeer[] = [];
    const subject = browserWebRtcDialer({
      RTCPeerConnection: class {
        constructor(configuration: { readonly iceServers: readonly { readonly urls: string }[] }) {
          const peer = new FakePeer(configuration.iceServers);
          made.push(peer);
          // biome-ignore lint/correctness/noConstructorReturn: the stand-in IS the scripted peer.
          return peer;
        }
      },
    });
    const abort = new AbortController();

    // Act
    const dial = subject?.dial({
      daemon: { daemonId: 'daemon-a' },
      signal: abort.signal,
      request: async () => new Response(JSON.stringify({ sdp: 'answer' })),
    });
    await settle();
    made[0]?.gatherComplete();
    await settle();
    made[0]?.connect();
    const socket = await dial;
    const opened = new Promise<void>(resolve => {
      if (socket !== undefined) socket.onOpen = resolve;
    });

    // Assert — announced on the real clock, after the dial resolved.
    await opened;
    should(made[0]?.iceServers).deepEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    abort.abort();
    should(made[0]?.closed).be.true();
  });
});
