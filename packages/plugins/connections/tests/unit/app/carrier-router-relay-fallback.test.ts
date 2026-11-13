/**
 * THE DEFAULT PREFERENCE FALLS BACK TO THE DIRECT ADDRESS THE DEVICE PAIRED OVER (`docs/relay-protocol.md` §15).
 *
 * Relay is the owner's default and asks nothing. When nobody CHOSE a preference and the relay cannot carry a session —
 * none discovered, or one that does not answer — the direct address recorded at pairing (that exact one) carries it, and
 * the router says so. A "Relay only" the person chose stays strict. Through the real kernel session layer, scripted network.
 */
import { describe, expect, test } from 'bun:test';
import type { PairedDaemon } from '@ferretry/app';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';
import { RELAY_FALLBACK_LINE } from '../../../app/carriers/router.ts';
import type { ScriptedHost } from '../../support/browser-network.ts';
import { carriedOver, rig } from '../../support/router-rig.ts';

const DIRECT = 'https://laptop.example.test';
const HOSTED = 'wss://hosted.example';
const PUBLISHED = [{ kind: 'direct', url: DIRECT }];

const hostsOf = (hosted: ScriptedHost): Record<string, ScriptedHost> => ({
  [new URL(DIRECT).host]: { kind: 'carries', carrier: 'direct' },
  'hosted.example': hosted,
});

/** The record as every pairing made before the mark existed stored it: the address, and no word that it was crossed. */
const unmarked = ({ pairedOver: _mark, ...legacy }: PairedDaemon): PairedDaemon => legacy;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const hostsDialled = (urls: readonly string[]): string[] => urls.map(url => new URL(url).host);

describe('the unchosen default (Relay) with a relay that cannot carry', () => {
  test('no relay discovered: the paired direct address carries, and the router says it stands in for the relay', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'relay', null, undefined, { chosen: () => false });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers direct']);
    expect(hostsDialled(r.network.dialled)).toEqual([new URL(DIRECT).host]);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({
      ok: true,
      method: { kind: 'direct', daemonUrl: DIRECT },
      reason: RELAY_FALLBACK_LINE,
    });
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);
    r.fx.layer.close();
  });

  test('a relay that does not answer is dialled FIRST, then the paired direct address carries', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'relay', HOSTED, undefined, { chosen: () => false });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(hostsDialled(r.network.dialled)).toEqual(['hosted.example', new URL(DIRECT).host]);
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers direct']);
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);
    const choice = r.router.choice(r.fx.daemonId);
    expect(choice?.ok === true ? choice.passedOver.map(skip => skip.method.kind) : []).toEqual(['relay']);
    r.fx.layer.close();
  });

  test('the relay answering again takes the session back, and the line goes away', async () => {
    const hosts = hostsOf({ kind: 'dead' });
    const r = await rig(hosts, PUBLISHED, 'relay', HOSTED, undefined, { chosen: () => false });
    const first = await r.connect();
    if (first === undefined) throw new Error('no transport');
    await first.request({ method: 'GET', path: '/v1/carriers' });
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);

    // The relay comes back and the last session that stood in for it ends. The next session tries the relay first (the
    // direct stand-in is never a remembered winner).
    hosts['hosted.example'] = { kind: 'carries', carrier: 'relay' };
    first.close?.();
    const second = await r.connect();
    if (second === undefined) throw new Error('no transport');
    await second.request({ method: 'GET', path: '/v1/carriers' });

    expect(carriedOver(r.fx).at(-1)).toBe('/v1/carriers relay');
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    r.fx.layer.close();
  });

  test('when the paired direct address cannot carry either, nothing stands in for the relay and no line is said', async () => {
    const hosts = hostsOf({ kind: 'dead' });
    const r = await rig(hosts, PUBLISHED, 'relay', HOSTED, undefined, { chosen: () => false });
    const first = await r.connect();
    if (first === undefined) throw new Error('no transport');
    await first.request({ method: 'GET', path: '/v1/carriers' });
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);

    // The direct address stops carrying too: a walk that finds nothing at all says no carrier stands in for the relay.
    // (The first session ended: while it lives it still sends direct, which the notice rightly keeps saying.)
    first.close?.();
    hosts[new URL(DIRECT).host] = { kind: 'dead' };
    const second = await r.connect();
    if (second === undefined) throw new Error('no transport');
    await expect(second.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: false });
    r.fx.layer.close();
  });

  test('an unchosen Relay with nothing to try is named Relay, not "Relay only": nobody chose that', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), [], 'relay', null, undefined, { chosen: () => false });
    const transport = await r.connect(unmarked(r.daemon));
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    const choice = r.router.choice(r.fx.daemonId);
    expect(choice?.ok === false ? choice.reason : '').toBe('Relay — there is no relay for this machine right now.');
    r.fx.layer.close();
  });

  test('a relay that carries is simply used: no fallback line, no direct dial', async () => {
    const r = await rig(hostsOf({ kind: 'carries', carrier: 'relay' }), PUBLISHED, 'relay', HOSTED, undefined, {
      chosen: () => false,
    });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers relay']);
    expect(hostsDialled(r.network.dialled)).toEqual(['hosted.example']);
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    r.fx.layer.close();
  });

  test('a record without the "paired over direct" mark (older, or relayed) gets no fallback, whatever its address answers', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), [], 'relay', null, undefined, { chosen: () => false });
    // The link's address is recorded, but nothing proves this device crossed it: v4 parity, Relay and nothing else.
    const transport = await r.connect(unmarked(r.daemon));
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(r.network.dialled).toEqual([]);
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    r.fx.layer.close();
  });

  test('only the address recorded at pairing is used, never one the daemon published later', async () => {
    // Paired at DIRECT, which does not carry now; the daemon's later publication names a host that does.
    const r = await rig(
      {
        [new URL(DIRECT).host]: { kind: 'dead' },
        'hosted.example': { kind: 'dead' },
        'elsewhere.example.test': { kind: 'carries', carrier: 'direct' },
      },
      [{ kind: 'direct', url: 'https://elsewhere.example.test' }],
      'relay',
      null,
      undefined,
      { chosen: () => false },
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(hostsDialled(r.network.dialled)).toEqual([new URL(DIRECT).host]);
    r.fx.layer.close();
  });
});

describe('the notice tells the truth while ANY lane or stream of the machine still sends direct', () => {
  const upHosts = (): Record<string, ScriptedHost> => hostsOf({ kind: 'dead' });

  test('one transport: a relay bulk lane does not hide the fallback while the request lane still sends direct', async () => {
    const hosts = upHosts();
    const r = await rig(hosts, [], 'relay', HOSTED, undefined, { chosen: () => false });
    const first = await r.connect();
    if (first === undefined) throw new Error('no transport');
    await first.request({ method: 'GET', path: '/v1/carriers' });
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);

    // The relay comes back and the large body opens the separate bulk lane, which the relay carries.
    hosts['hosted.example'] = { kind: 'carries', carrier: 'relay' };
    await first.request({ method: 'POST', path: '/v1/bulk', body: 'x'.repeat(40_000) });
    await first.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers direct', '/v1/bulk relay', '/v1/carriers direct']);

    // Still direct on one lane: the notice stays, and the connection never claims to be on the relay.
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({
      ok: true,
      method: { kind: 'direct' },
      reason: RELAY_FALLBACK_LINE,
    });
    r.fx.layer.close();
  });

  test('one transport: once the direct lane ends and the relay lane is live, the connection is on the relay and the line goes', async () => {
    const hosts = upHosts();
    const r = await rig(hosts, [], 'relay', HOSTED, undefined, { chosen: () => false });
    const first = await r.connect();
    if (first === undefined) throw new Error('no transport');
    await first.request({ method: 'GET', path: '/v1/carriers' });
    hosts['hosted.example'] = { kind: 'carries', carrier: 'relay' };
    await first.request({ method: 'POST', path: '/v1/bulk', body: 'x'.repeat(40_000) });
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);

    // The whole transport goes away: both lanes end, and nothing is live. A fresh transport reaches the relay first.
    first.close?.();
    const second = await r.connect();
    if (second === undefined) throw new Error('no transport');
    await second.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx).at(-1)).toBe('/v1/carriers relay');
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    r.fx.layer.close();
  });

  test('a stream on the fallback keeps the notice while a request session on the relay answers, and clears it when the stream ends', async () => {
    const hosts = upHosts();
    const r = await rig(hosts, [], 'relay', HOSTED, undefined, { chosen: () => false });
    const streaming = await r.connect();
    if (streaming === undefined) throw new Error('no transport');
    // The stream's own session is accepted over the paired direct address while the relay is down.
    r.fx.acceptStreams();
    const closes: string[] = [];
    const stream = streaming.socket('/v1/example/stream', {
      onFrame: () => undefined,
      onClose: reason => closes.push(reason),
    });
    for (let waited = 0; waited < 1_000 && r.router.relayFallback(r.fx.daemonId) === undefined; waited += 10)
      await sleep(10);
    expect(closes).toEqual([]);
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);

    hosts['hosted.example'] = { kind: 'carries', carrier: 'relay' };
    const requesting = await r.connect();
    if (requesting === undefined) throw new Error('no transport');
    await requesting.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx).at(-1)).toBe('/v1/carriers relay');
    // A relay request answered, yet the stream still sends direct: the machine is not fully back on the relay.
    expect(r.router.relayFallback(r.fx.daemonId)).toBe(RELAY_FALLBACK_LINE);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'direct' } });

    stream.close();
    for (let waited = 0; waited < 1_000 && r.router.relayFallback(r.fx.daemonId) !== undefined; waited += 10)
      await sleep(10);
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    r.fx.layer.close();
  });
});

describe('a Relay only the person CHOSE', () => {
  test('stays strict: the relay does not answer, the paired direct address is never dialled, and no line is said', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'relay', HOSTED, undefined, { chosen: () => true });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(hostsDialled(r.network.dialled)).toEqual(['hosted.example']);
    expect(r.router.relayFallback(r.fx.daemonId)).toBeUndefined();
    r.fx.layer.close();
  });

  test('with no relay at all it says Relay only has nothing to try, and dials nothing', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'relay', null, undefined, { chosen: () => true });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(r.network.dialled).toEqual([]);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: false, reason: expect.stringContaining('Relay only') });
    r.fx.layer.close();
  });

  test('a router built with no word on it counts every preference as chosen (nothing falls back)', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'relay', null);
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(r.network.dialled).toEqual([]);
    r.fx.layer.close();
  });
});

describe('other preferences never fall back', () => {
  test('Auto already walks direct; a chosen tunnel never borrows the paired address', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'tunnel', null, undefined, { chosen: () => false });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await expect(transport.request({ method: 'GET', path: '/v1/carriers' })).rejects.toBeDefined();
    expect(hostsDialled(r.network.dialled)).not.toContain(new URL(DIRECT).host);
    r.fx.layer.close();
  });
});

describe('a carrier republish while a lane still sends direct', () => {
  const RELAY_BACK = [
    { kind: 'direct', url: DIRECT },
    { kind: 'relay', url: HOSTED },
  ];

  test('a lost request lane then a republish cannot hide a still-live fallback stream', async () => {
    const directSockets: { close: (code?: number, reason?: string) => void }[] = [];
    const hosts = hostsOf({ kind: 'dead' }) as Record<string, ScriptedHost>;
    const r = await rig(
      hosts,
      PUBLISHED,
      'relay',
      HOSTED,
      network => url => {
        const socket = network.openSocket(url);
        if (new URL(url).host === new URL(DIRECT).host) directSockets.push(socket);
        return socket;
      },
      { chosen: () => false },
    );
    try {
      const frames: string[] = [];
      r.fx.upgrade = async () => ({
        outcome: 'accepted',
        attach: async () => ({
          open: async () => undefined,
          fromClient: frame => {
            frames.push(typeof frame === 'string' ? frame : 'bytes');
          },
          close: () => undefined,
        }),
      });
      const transport = await r.connect();
      if (transport === undefined) throw new Error('no transport');
      const closed: string[] = [];
      const stream = transport.socket('/v1/stream', { onFrame: () => undefined, onClose: why => closed.push(why) });
      for (let i = 0; i < 50 && directSockets.length < 1; i++) await sleep(20);
      await sleep(20);
      await transport.request({ method: 'GET', path: '/v1/first' });
      expect(directSockets).toHaveLength(2);
      // The request lane is lost under a POST that waits for its answer: the winner it was is forgotten...
      const answered = r.fx.route;
      r.fx.route = async () => new Promise(() => undefined);
      const write = transport.request({ method: 'POST', path: '/v1/slow' }).catch((error: unknown) => error);
      await sleep(20);
      directSockets[1]?.close(1011, 'lost request');
      expect(await write).toBeInstanceOf(Error);
      expect(r.router.choice(r.daemon.daemon)).toBeUndefined();
      expect(r.router.relayFallback(r.daemon.daemon)).toBe(RELAY_FALLBACK_LINE);
      // ...but the stream is still direct, so a republish that names a recovered relay keeps the notice and the label.
      hosts['hosted.example'] = { kind: 'carries', carrier: 'relay' };
      r.fx.route = answered;
      const republished = await r.connect({ ...r.daemon, carriers: RELAY_BACK });
      if (republished === undefined) throw new Error('no transport');
      await republished.request({ method: 'GET', path: '/v1/after' });
      await sleep(20);
      stream.send('still direct');
      await sleep(20);
      expect(frames).toEqual(['still direct']);
      expect(closed).toEqual([]);
      expect(carriedOver(r.fx).at(-1)).toBe('/v1/after relay');
      expect(r.router.relayFallback(r.daemon.daemon)).toBe(RELAY_FALLBACK_LINE);
      expect(r.router.choice(r.daemon.daemon)).toMatchObject({ ok: true, method: { kind: 'direct' } });
      stream.close();
    } finally {
      r.fx.layer.close();
    }
  });

  test('a stream accepted AFTER a republish is still a live fallback: closing the earlier lane keeps the notice', async () => {
    const hosts = hostsOf({ kind: 'dead' }) as Record<string, ScriptedHost>;
    const directSockets: unknown[] = [];
    const held: { data: unknown }[] = [];
    let holding = true;
    let delayed: BrowserSocket | undefined;
    const r = await rig(
      hosts,
      PUBLISHED,
      'relay',
      HOSTED,
      network => url => {
        const real = network.openSocket(url);
        if (new URL(url).host !== new URL(DIRECT).host) return real;
        directSockets.push(real);
        if (directSockets.length !== 2) return real;
        // The second direct socket (the stream) has its incoming handshake frames held back, so it is accepted late.
        const socket: BrowserSocket = {
          binaryType: 'blob',
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send: data => real.send(data),
          close: (code, reason) => real.close(code, reason),
        };
        real.onopen = () => socket.onopen?.();
        real.onclose = event => socket.onclose?.(event);
        real.onerror = () => socket.onerror?.();
        real.onmessage = event => {
          if (holding) held.push(event);
          else socket.onmessage?.(event);
        };
        delayed = socket;
        return socket;
      },
      { chosen: () => false },
    );
    try {
      const frames: string[] = [];
      r.fx.upgrade = async () => ({
        outcome: 'accepted',
        attach: async () => ({
          open: async () => undefined,
          fromClient: frame => {
            frames.push(typeof frame === 'string' ? frame : 'bytes');
          },
          close: () => undefined,
        }),
      });
      const first = await r.connect();
      if (first === undefined) throw new Error('no transport');
      await first.request({ method: 'GET', path: '/v1/first' });
      const streaming = await r.connect();
      if (streaming === undefined) throw new Error('no transport');
      const closed: string[] = [];
      const stream = streaming.socket('/v1/stream', { onFrame: () => undefined, onClose: why => closed.push(why) });
      for (let i = 0; i < 50 && held.length === 0; i++) await sleep(20);
      expect(held.length).toBeGreaterThan(0);
      // The republish names the recovered relay and a request goes over it, THEN the stream's handshake is let through.
      hosts['hosted.example'] = { kind: 'carries', carrier: 'relay' };
      const relayed = await r.connect({ ...r.daemon, carriers: RELAY_BACK });
      if (relayed === undefined) throw new Error('no transport');
      await relayed.request({ method: 'GET', path: '/v1/relay' });
      holding = false;
      for (const event of held.splice(0)) delayed?.onmessage?.(event);
      await sleep(40);
      stream.send('before close');
      await sleep(20);
      expect(frames).toEqual(['before close']);
      expect(r.router.relayFallback(r.daemon.daemon)).toBe(RELAY_FALLBACK_LINE);
      // The earlier tracked direct lane ends: the late stream still sends direct, so the card does not flip to relay.
      first.close?.();
      await sleep(40);
      stream.send('after close');
      await sleep(20);
      expect(frames).toEqual(['before close', 'after close']);
      expect(closed).toEqual([]);
      expect(r.router.relayFallback(r.daemon.daemon)).toBe(RELAY_FALLBACK_LINE);
      expect(r.router.choice(r.daemon.daemon)).toMatchObject({ ok: true, method: { kind: 'direct' } });
      // Ending the stream was its last stand-in: the relay lane is live, so the notice clears — exactly once.
      stream.close();
      await sleep(40);
      expect(r.router.relayFallback(r.daemon.daemon)).toBeUndefined();
      expect(r.router.choice(r.daemon.daemon)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    } finally {
      r.fx.layer.close();
    }
  });

  test('forgetting the pairing ends the count: a stand-in closing afterwards leaves nothing behind', async () => {
    const r = await rig(hostsOf({ kind: 'dead' }), PUBLISHED, 'relay', HOSTED, undefined, { chosen: () => false });
    try {
      r.fx.upgrade = async () => ({
        outcome: 'accepted',
        attach: async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined }),
      });
      const transport = await r.connect();
      if (transport === undefined) throw new Error('no transport');
      const closed: string[] = [];
      const stream = transport.socket('/v1/stream', { onFrame: () => undefined, onClose: why => closed.push(why) });
      await transport.request({ method: 'GET', path: '/v1/first' });
      await sleep(20);
      expect(r.router.relayFallback(r.daemon.daemon)).toBe(RELAY_FALLBACK_LINE);
      r.router.clearDaemon(r.daemon.daemon);
      expect(r.router.relayFallback(r.daemon.daemon)).toBeUndefined();
      stream.close();
      await sleep(20);
      expect(r.router.relayFallback(r.daemon.daemon)).toBeUndefined();
      expect(r.router.choice(r.daemon.daemon)).toBeUndefined();
    } finally {
      r.fx.layer.close();
    }
  });
});
