/**
 * WHAT THE WEBRTC ENGINE COSTS, measured against the WebSocket every other carrier runs on.
 *
 *   cd packages/pwa && bun harness/webrtc-engine-bench.ts [--rounds 300] [--stun stun:stun.cloudflare.com:3478]
 *
 * Manual, and never in CI: a benchmark's numbers mean something only on a quiet machine and only next
 * to another run on the same one. It needs a Chrome (`CHROME_PATH`, else `google-chrome`). Without
 * `--stun` it touches nothing beyond loopback; with it, both ends ask that STUN server for their public
 * address, which is the one network request the WebRTC carrier makes of a third party (§16).
 *
 * ── WHAT IS REAL ───────────────────────────────────────────────────────────────────────────────
 *
 *   - the daemon's engine: `node-datachannel` (libdatachannel), loaded exactly as `fyd` loads it,
 *     answering a real Chrome's offer — non-trickle, as the carrier signals (§16);
 *   - the browser: a real Chrome's `RTCPeerConnection` and `RTCDataChannel`, reliable and ordered;
 *   - the baseline: a Bun WebSocket in the same process, which is what the direct carrier is.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────────────────────────
 *
 *   - not a session: no handshake, no AES-GCM, no records. It isolates what the CARRIER adds, because
 *     the session above it is byte-for-byte the same on every carrier (§3) and costs the same on each;
 *   - not a network: loopback has no NAT, no loss and no distance. What a real path adds is its own
 *     round trip, which a peer-to-peer path pays once (phone ↔ home) where a relay pays two legs.
 *
 * ── WHAT IT REPORTS ───────────────────────────────────────────────────────────────────────────
 *
 * One JSON object: time from `new RTCPeerConnection` to an open channel (offer, gathering, signalling,
 * ICE, DTLS, SCTP), echo round trips (p50/p95, ms) of a 64-byte message over the data channel and over
 * the WebSocket, and echo throughput of 16 KB messages over each, paced by `bufferedAmount`.
 */

import { chromium } from 'playwright-core';
import { loadNodeDataChannel } from '../../daemon/src/adapters/webrtc/index.ts';

interface Options {
  readonly rounds: number;
  readonly stun: string | undefined;
}

function parse(argv: readonly string[]): Options {
  let rounds = 300;
  let stun: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--rounds') rounds = Number(value);
    else if (flag === '--stun') stun = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isInteger(rounds) || rounds < 20) throw new Error('--rounds must be an integer of at least 20');
  return { rounds, stun };
}

const options = parse(Bun.argv.slice(2));
const { PeerConnection, getLibraryVersion } = await loadNodeDataChannel();
const peers: InstanceType<typeof PeerConnection>[] = [];

/** Answer one offer, non-trickle: the answer leaves once this side has gathered every candidate. */
async function answer(offer: { readonly sdp: string; readonly type: string }): Promise<{ sdp: string; type: string }> {
  const peer = new PeerConnection('bench', { iceServers: options.stun === undefined ? [] : [options.stun] });
  peers.push(peer);
  peer.onDataChannel(channel =>
    channel.onMessage(message =>
      typeof message === 'string' ? channel.sendMessage(message) : channel.sendMessageBinary(message as Buffer),
    ),
  );
  const gathered = new Promise<void>(resolve =>
    peer.onGatheringStateChange(state => state === 'complete' && resolve()),
  );
  peer.setRemoteDescription(offer.sdp, offer.type as never);
  await gathered;
  const local = peer.localDescription();
  if (local === null) throw new Error('the engine produced no answer');
  return { sdp: local.sdp, type: local.type };
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request, socketServer) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') return socketServer.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
    if (path === '/offer') return Response.json(await answer((await request.json()) as { sdp: string; type: string }));
    return new Response('<!doctype html><title>webrtc engine bench</title>', {
      headers: { 'content-type': 'text/html' },
    });
  },
  websocket: { message: (socket, message) => void socket.send(message) },
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'google-chrome', headless: true });
try {
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.port}`;
  await page.goto(origin);
  const measured = await page.evaluate(
    async ({ origin, rounds, stun, gatherCapMs, reflexiveGraceMs }) => {
      const quantiles = (samples: number[]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        const at = (q: number) =>
          Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0).toFixed(3));
        return { p50: at(0.5), p95: at(0.95) };
      };
      interface Echo {
        send(bytes: Uint8Array<ArrayBuffer>): void;
        onReply(callback: () => void): void;
        buffered(): number;
      }
      const roundTrips = async (echo: Echo) => {
        const samples: number[] = [];
        const payload = new Uint8Array(64);
        for (let round = 0; round < rounds; round += 1) {
          const started = performance.now();
          await new Promise<void>(resolve => {
            echo.onReply(resolve);
            echo.send(payload);
          });
          samples.push(performance.now() - started);
        }
        return quantiles(samples.slice(10));
      };
      const throughput = async (echo: Echo) => {
        const message = new Uint8Array(16_000);
        const count = 1_000;
        let received = 0;
        let sent = 0;
        const started = performance.now();
        await new Promise<void>(resolve => {
          echo.onReply(() => {
            received += 1;
            if (received === count) resolve();
          });
          const pump = () => {
            while (sent < count && echo.buffered() < 4 << 20) {
              echo.send(message);
              sent += 1;
            }
            if (sent < count) setTimeout(pump, 1);
          };
          pump();
        });
        return Number(((count * 16_000 * 2) / 1e6 / ((performance.now() - started) / 1_000)).toFixed(1));
      };

      const opening = performance.now();
      const peer = new RTCPeerConnection({ iceServers: stun === undefined ? [] : [{ urls: stun }] });
      const channel = peer.createDataChannel('bench', { ordered: true });
      channel.binaryType = 'arraybuffer';
      await peer.setLocalDescription(await peer.createOffer());
      // The carrier's own gathering rule (§16): stop at "complete", or a short grace after the first
      // server-reflexive candidate, or the cap — Chrome holds "complete" until every STUN request on every
      // interface has timed out, which measured about forty seconds against a public STUN server.
      let firstReflexiveMs: number | null = null;
      await new Promise<void>(resolve => {
        const cap = setTimeout(resolve, gatherCapMs);
        const done = () => {
          clearTimeout(cap);
          resolve();
        };
        if (peer.iceGatheringState === 'complete') done();
        peer.onicegatheringstatechange = () => peer.iceGatheringState === 'complete' && done();
        peer.onicecandidate = event => {
          if (event.candidate?.type !== 'srflx' || firstReflexiveMs !== null) return;
          firstReflexiveMs = performance.now() - opening;
          setTimeout(done, reflexiveGraceMs);
        };
      });
      const gatheredMs = performance.now() - opening;
      const answered = await fetch(`${origin}/offer`, { method: 'POST', body: JSON.stringify(peer.localDescription) });
      await peer.setRemoteDescription(await answered.json());
      await new Promise<void>(resolve => {
        channel.onopen = () => resolve();
      });
      const openMs = performance.now() - opening;
      const overChannel: Echo = {
        send: bytes => channel.send(bytes),
        onReply: callback => {
          channel.onmessage = () => callback();
        },
        buffered: () => channel.bufferedAmount,
      };

      const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`);
      socket.binaryType = 'arraybuffer';
      await new Promise(resolve => {
        socket.onopen = resolve;
      });
      const overSocket: Echo = {
        send: bytes => socket.send(bytes),
        onReply: callback => {
          socket.onmessage = () => callback();
        },
        buffered: () => socket.bufferedAmount,
      };
      return {
        candidates: (peer.localDescription?.sdp.match(/a=candidate:\S+ \d \S+ \d+ \S+ \d+ typ \w+/gu) ?? []).map(line =>
          line.replace(/^.* typ /u, ''),
        ),
        firstReflexiveMs: firstReflexiveMs as number | null,
        gatheredMs: Number(gatheredMs.toFixed(1)),
        openMs: Number(openMs.toFixed(1)),
        echo: { webrtc: await roundTrips(overChannel), websocket: await roundTrips(overSocket) },
        throughputMBps: { webrtc: await throughput(overChannel), websocket: await throughput(overSocket) },
      };
    },
    { origin, rounds: options.rounds, stun: options.stun, gatherCapMs: 3_000, reflexiveGraceMs: 250 },
  );
  console.log(
    JSON.stringify(
      {
        engine: `libdatachannel ${getLibraryVersion()}`,
        chrome: browser.version(),
        rounds: options.rounds,
        stun: options.stun ?? null,
        ...measured,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  for (const peer of peers) peer.close();
  await server.stop(true);
}
process.exit(0);
