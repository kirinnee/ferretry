/**
 * WebRTC in the browser's carrier walk (`docs/relay-protocol.md` §16): the router dials it through a dialer, signals the
 * offer through an introducer, falls back to the relay with the dial's own sentence, passes it over untried where the
 * browser has no dialer, and never replays a write on a new path (R677, R685, R686).
 *
 * Ported from v4's `pwa/tests/unit/relay-carrier-preference.test.ts` ("the reason a faster carrier is not carrying"),
 * onto the 5.0 walk: the real shell `connector`, sealed sessions and the real kernel session layer. The dialer is scripted
 * at its own seam (`WebRtcDialer.dial`), and its channel is a socket to a scripted host that opens a real kernel link
 * on the `webrtc` carrier, so a session really runs over it.
 */
import { describe, expect, test } from 'bun:test';
import { createBrowserRelayDial, type RelayCarrierSocket } from '../../../app/adapters/browser-relay-dial.ts';
import type { WebRtcAttempt } from '../../../app/lib/webrtc-carrier.ts';
import type { BrowserNetwork, HandTimers, ScriptedHost } from '../../support/browser-network.ts';
import { carriedOver, rig } from '../../support/router-rig.ts';

const DIRECT_HOST = 'laptop.example.test';
const RELAY = 'wss://relay.example';
const RELAY_HOST = new URL(RELAY).host;
const PEER_HOST = 'webrtc-peer.example';
const NO_PATH = 'no direct path found in 8 s — this network may block peer-to-peer connections';

type Behaviour = 'carries' | 'fails' | 'needs-introducer';

/** A dialer scripted at its own seam; what it dialled and released is kept. */
function scriptedDialer(network: BrowserNetwork, timers: HandTimers, behaviour: Behaviour) {
  const attempts: WebRtcAttempt[] = [];
  const channels: RelayCarrierSocket[] = [];
  const released: string[] = [];
  const dial = async (attempt: WebRtcAttempt): Promise<RelayCarrierSocket> => {
    attempts.push(attempt);
    if (behaviour === 'fails') throw new Error(NO_PATH);
    if (behaviour === 'needs-introducer') await attempt.request('/v1/webrtc/offer', { method: 'POST' });
    const channel = createBrowserRelayDial({ openSocket: network.openSocket, after: timers.after })(
      `wss://${PEER_HOST}/v1/rendezvous/${attempt.daemon.daemonId}/client`,
    );
    channels.push(channel);
    return channel;
  };
  return {
    dialer: { dial, release: (daemonId: string) => void released.push(daemonId) },
    attempts,
    channels,
    released,
  };
}

interface Scenario {
  readonly hosts: Record<string, ScriptedHost>;
  readonly behaviour?: Behaviour;
  readonly preference?: 'auto' | 'webrtc' | 'relay';
  readonly published?: readonly unknown[];
  /** The introducer, or `false` for none; absent is a working one. */
  readonly introduce?: false | (() => Promise<Response>);
  readonly noDialer?: boolean;
}

async function webrtcWalk(scenario: Scenario) {
  const holder: { script?: ReturnType<typeof scriptedDialer> } = {};
  const request = scenario.introduce === false ? undefined : (scenario.introduce ?? (async () => new Response('{}')));
  const r = await rig(
    scenario.hosts,
    scenario.published ?? [],
    scenario.preference ?? 'webrtc',
    null,
    undefined,
    (_fx, network, timers) => {
      if (scenario.noDialer === true) return {};
      holder.script = scriptedDialer(network, timers, scenario.behaviour ?? 'carries');
      return {
        webrtc: holder.script.dialer,
        introduce: () => request,
      };
    },
  );
  const transport = await r.connect();
  if (transport === undefined) throw new Error('no transport');
  return { r, transport, script: holder.script, request };
}

describe('R677 WebRTC through the dialer', () => {
  test('R677 a session runs over the data channel the dialer opened, signalled through the introducer', async () => {
    const w = await webrtcWalk({ hosts: { [PEER_HOST]: { kind: 'carries', carrier: 'webrtc' } } });

    const answer = await w.transport.request({ method: 'GET', path: '/v1/projects' });

    expect(answer.status).toBe(200);
    expect(carriedOver(w.r.fx)).toEqual(['/v1/projects webrtc']);
    expect(w.script?.attempts).toHaveLength(1);
    expect(w.script?.attempts[0]?.daemon.daemonId).toBe(w.r.fx.daemonId);
    // Signalling rides what the router was given to introduce with, nothing else.
    expect(w.script?.attempts[0]?.request).toBe(w.request as unknown as WebRtcAttempt['request']);
    expect(w.r.router.choice(w.r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'webrtc' } });
    w.r.fx.layer.close();
  });

  test('R677 with no channel in time the walk falls back to the relay and keeps WebRTC’s own sentence', async () => {
    const w = await webrtcWalk({
      hosts: { [DIRECT_HOST]: { kind: 'dead' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      behaviour: 'fails',
      preference: 'auto',
      published: [{ kind: 'relay', url: RELAY }],
    });

    await w.transport.request({ method: 'GET', path: '/v1/projects' });

    const choice = w.r.router.choice(w.r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('the relay did not carry the request');
    const missed = choice.passedOver.find(skip => skip.method.kind === 'webrtc');
    expect(choice.method.kind).toBe('relay');
    expect(missed?.untried).toBeUndefined();
    expect(choice.fallbackReason).toBe(missed?.detail);
    expect(choice.fallbackReason).toContain('no direct path found in 8 s');
    w.r.fx.layer.close();
  });

  test('R677 a direct carrier that wins outranks WebRTC and has no fallback reason', async () => {
    const w = await webrtcWalk({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      behaviour: 'fails',
      preference: 'auto',
    });

    await w.transport.request({ method: 'GET', path: '/v1/projects' });

    const choice = w.r.router.choice(w.r.fx.daemonId);
    expect(choice).toMatchObject({ ok: true, method: { kind: 'direct' } });
    expect(choice?.ok === true ? choice.fallbackReason : 'not ok').toBeUndefined();
    expect(w.script?.attempts).toHaveLength(0);
    w.r.fx.layer.close();
  });

  test('R677 with no introducer holding the machine the dial fails with the sentence that says so', async () => {
    const w = await webrtcWalk({
      hosts: { [DIRECT_HOST]: { kind: 'dead' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      behaviour: 'needs-introducer',
      preference: 'auto',
      published: [{ kind: 'relay', url: RELAY }],
      introduce: false,
    });

    await w.transport.request({ method: 'GET', path: '/v1/projects' });

    const choice = w.r.router.choice(w.r.fx.daemonId);
    expect(choice?.ok === true ? choice.fallbackReason : undefined).toContain(
      'no carrier can introduce WebRTC to this machine',
    );
    w.r.fx.layer.close();
  });

  test('R677 an unpair or a new preference closes the daemon’s peer connection', async () => {
    const w = await webrtcWalk({ hosts: { [PEER_HOST]: { kind: 'carries', carrier: 'webrtc' } } });
    await w.transport.request({ method: 'GET', path: '/v1/projects' });

    w.r.router.rewalk(w.r.fx.daemonId);
    w.r.router.clearDaemon(w.r.fx.daemonId);

    expect(w.script?.released).toEqual([w.r.fx.daemonId, w.r.fx.daemonId]);
    w.r.fx.layer.close();
  });

  test('R677 the leg is abandoned, and the dial told to stop, when its deadline passes before a channel opens', async () => {
    // A dial that never resolves: the leg's own deadline ends it and aborts what the dial was waiting on.
    const w = await webrtcWalk({
      hosts: { [DIRECT_HOST]: { kind: 'dead' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      preference: 'auto',
      published: [{ kind: 'relay', url: RELAY }],
      introduce: () => new Promise<Response>(() => undefined),
      behaviour: 'needs-introducer',
    });

    const pending = w.transport.request({ method: 'GET', path: '/v1/projects' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(w.script?.attempts).toHaveLength(1);
    expect(w.script?.attempts[0]?.signal.aborted).toBe(false);
    // The deadline is the largest armed timer: gathering cap + ICE deadline + handshake.
    w.r.timers.fire(15_000);
    const answer = await pending;

    expect(answer.status).toBe(200);
    expect(w.script?.attempts[0]?.signal.aborted).toBe(true);
    expect(carriedOver(w.r.fx)).toEqual(['/v1/projects relay']);
    w.r.fx.layer.close();
  });
});

describe('R686 an untried WebRTC is no fallback reason', () => {
  test('R686 a build with no dialer passes WebRTC over untried, says so, and gives no reason to the relay that won', async () => {
    const w = await webrtcWalk({
      hosts: { [DIRECT_HOST]: { kind: 'dead' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      preference: 'auto',
      published: [{ kind: 'relay', url: RELAY }],
      noDialer: true,
    });

    await w.transport.request({ method: 'GET', path: '/v1/projects' });

    const choice = w.r.router.choice(w.r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('the relay did not carry the request');
    expect(choice.passedOver.some(skip => skip.method.kind === 'webrtc' && skip.untried === true)).toBe(true);
    expect(choice.fallbackReason).toBeUndefined();
    w.r.fx.layer.close();
  });

  test('R686 "WebRTC only" in a build with no dialer carries nothing and says why', async () => {
    const w = await webrtcWalk({ hosts: {}, noDialer: true });

    const failure = await w.transport.request({ method: 'GET', path: '/v1/projects' }).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('isn’t available in this build yet');
    w.r.fx.layer.close();
  });
});

describe('R685 no ICE restart: reads are re-sent, writes never blind', () => {
  test('R685 a channel that dies under a pending write is not replayed: the reader re-sends its read, over a path negotiated afresh', async () => {
    const w = await webrtcWalk({ hosts: { [PEER_HOST]: { kind: 'carries', carrier: 'webrtc' } } });
    await w.transport.request({ method: 'GET', path: '/v1/first' });
    const route = w.r.fx.route;
    w.r.fx.route = request =>
      request.method === 'PUT' || request.path === '/v1/lost-read' ? new Promise(() => undefined) : route(request);

    // The channel dies while a read and a write wait for the daemon's answer.
    const read = w.transport.request({ method: 'GET', path: '/v1/lost-read' }).catch((error: unknown) => error);
    const write = w.transport
      .request({ method: 'PUT', path: '/v1/example', body: { enabled: true } })
      .catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const channel of w.script?.channels ?? []) channel.close(1011, 'peer lost');
    const failures = await Promise.all([read, write]);
    w.r.fx.route = route;
    const lost = w.r.router.choice(w.r.fx.daemonId);

    // The reader sends its read again; nothing sends the write again.
    const again = await w.transport.request({ method: 'GET', path: '/v1/lost-read' });

    expect(failures[0]).toBeInstanceOf(Error);
    expect(failures[1]).toBeInstanceOf(Error);
    expect(lost?.ok).not.toBe(true);
    expect(again.status).toBe(200);
    expect(w.r.fx.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    expect(w.r.fx.requests.filter(request => request.path === '/v1/lost-read')).toHaveLength(2);
    // Every dial after the loss negotiated a connection of its own through the dialer: no path is restarted in place.
    expect(w.script?.attempts.length).toBeGreaterThanOrEqual(2);
    w.r.fx.layer.close();
  });

  test('R685 the WebRTC carrier never restarts ICE: a dead connection is dropped and the next dial negotiates afresh', async () => {
    const source = await Bun.file(new URL('../../../app/lib/webrtc-carrier.ts', import.meta.url)).text();
    const code = source
      .split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/restartIce|iceRestart/u);
  });
});
