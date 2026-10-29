/**
 * HOW LONG A KEYSTROKE TAKES TO COME BACK, direct and over the relay — measured, not argued.
 *
 *   cd packages/pwa && bun harness/relay-terminal-bench.ts [--out results.json] [--keys 30] [--quick]
 *
 * Manual, and never in CI: it is a benchmark, so its numbers are only meaningful on a quiet machine and
 * only comparable to another run on the same one. It needs tmux and a Chrome (`CHROME_PATH`, else
 * `google-chrome`). It touches no network beyond loopback and no state outside its own temp folder.
 *
 * ── WHAT IS REAL ───────────────────────────────────────────────────────────────────────────────
 *
 *   - the shell: a real tmux server on a private socket, driven by the daemon's own
 *     `TmuxTerminalRuntime`, `ManagedTerminalService` and `TerminalStreamBridge` — the objects `fyd`
 *     composes for a terminal stream;
 *   - the daemon's carriers: the real `BunRelayCarrier` dialling the rendezvous, and the real
 *     `DirectSession` behind a Bun WebSocket listener, both running the real `RelayLink`;
 *   - the relay: `scripts/test/rendezvous-process.ts`, the relay Worker's own `relayFetch` and
 *     `RendezvousDurableObject` behind real WebSockets (that file says what it substitutes);
 *   - the browser: a real Chrome running the PWA's own `openRelaySession`, `browserRelayDial`,
 *     WebCrypto and xterm.js, with echo timed to the frame xterm actually painted.
 *
 * ── WHAT IS MODELLED, said plainly ────────────────────────────────────────────────────────────
 *
 *   - THE NETWORK. Every leg runs through {@link ShapedProxy}, a TCP proxy that adds a one-way delay
 *     and a bandwidth cap per direction, so a run can be "a phone on 4G, a home daemon on a 10 Mbit/s
 *     uplink" on one machine. The numbers are chosen, and printed with every result.
 *   - CLOUDFLARE'S OUTPUT GATE. The rendezvous process can hold every send behind an unconfirmed
 *     storage write for a chosen time (`--output-gate-ms`), which is what the Workers runtime does to
 *     a Durable Object's outgoing messages. How long Cloudflare really takes is not measurable here.
 *   - THE DAEMON'S AUTHORITY. The stream's upgrade is accepted by a stub route table and the device
 *     directory is a map: authorization runs once per stream open, never per keystroke, so it is not
 *     on the path being timed.
 *
 * ── WHAT IT REPORTS ───────────────────────────────────────────────────────────────────────────
 *
 * Per scenario: keystroke-to-painted-echo (p50/p95), the hop each part of it was spent on, the bytes
 * one echo cost, and the time and bytes `seq 1 20000` took to finish painting. Every process stamps
 * its events with `performance.timeOrigin + performance.now()`, the one clock they share.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';
import { chromium } from 'playwright-core';
import { BunRelayCarrier } from '../../daemon/src/adapters/relay/bun-relay-carrier.ts';
import { ManagedTerminalService } from '../../daemon/src/adapters/terminal/service.ts';
import { TerminalStreamBridge, type TerminalStreamService } from '../../daemon/src/adapters/terminal/stream-bridge.ts';
import { TmuxTerminalRuntime } from '../../daemon/src/adapters/terminal/tmux-terminal-runtime.ts';
import { BunTmuxProcess } from '../../daemon/src/adapters/tmux/bun-tmux-process.ts';
import type { SocketDownstream, SocketHandler, SocketUpgradeDecision } from '../../daemon/src/lib/api/socket.ts';
import { NodeDataChannelEngine } from '../../daemon/src/adapters/webrtc/index.ts';
import { DirectSession } from '../../daemon/src/lib/relay/direct-carrier.ts';
import { WebRtcCarrier } from '../../daemon/src/lib/webrtc/index.ts';
import type { RelayLinkScheduler } from '../../daemon/src/lib/relay/link.ts';
import { WebCryptoRelayCrypto } from '../../relay/src/adapters/index.ts';
import { newDaemonIdentity } from '../../relay/tests/support/identities.ts';
import type { BenchPageResult, BenchRunConfig } from './relay-terminal-bench-page.ts';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(harnessDir, '../../..');
const preciseNow = (): number => performance.timeOrigin + performance.now();

/* ---------- arguments ---------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const QUICK = argv.includes('--quick');
const KEYS = Number(flag('--keys') ?? (QUICK ? 12 : 30));
const OUT = flag('--out');
/** Where to write the evidence screenshots: a used terminal, over the relay, at desktop and phone width. */
const SHOTS = flag('--shots');
const SHOTS_ONLY = argv.includes('--shots-only');
const LABEL = flag('--label') ?? 'run';
const SEQ_LINES = QUICK ? 5_000 : 20_000;
/**
 * History sizes: none, one that a full redraw still fits a record with, and one it does not (§14 caps a
 * record near 48 KiB, and these lines are about 125 bytes each with their colours).
 */
const HISTORIES = QUICK ? [0, 1_500] : [0, 300, 1_500];
const COLS = 120;
const ROWS = 32;

/* ---------- the network, modelled ---------------------------------------- */

/** One leg: a one-way delay both ways, and a cap per direction (absent = unshaped). */
interface LegProfile {
  readonly oneWayMs: number;
  /** Mbit/s from the dialler to the listener. */
  readonly upMbps?: number;
  /** Mbit/s from the listener back to the dialler. */
  readonly downMbps?: number;
}

const UNSHAPED: LegProfile = { oneWayMs: 0 };

/** The three legs a scenario shapes. Direct uses only `direct`; a relay uses the other two. */
interface NetworkProfile {
  readonly name: string;
  readonly description: string;
  readonly direct: LegProfile;
  readonly clientRelay: LegProfile;
  readonly daemonRelay: LegProfile;
}

const LOOPBACK: NetworkProfile = {
  name: 'loopback',
  description: 'no shaping: software cost only',
  direct: UNSHAPED,
  clientRelay: UNSHAPED,
  daemonRelay: UNSHAPED,
};

/**
 * A phone away from home reaching a home daemon. Both paths have the SAME 60 ms round trip, so what
 * separates them is what the relay itself adds: direct is one 30 ms leg; the relay is a 20 ms leg
 * (phone↔edge) plus a 10 ms leg (edge↔home). The home uplink is 10 Mbit/s either way.
 */
const WAN: NetworkProfile = {
  name: 'wan',
  description: '60 ms RTT on both paths; daemon uplink 10 Mbit/s, phone 10 up / 50 down',
  direct: { oneWayMs: 30, upMbps: 10, downMbps: 10 },
  clientRelay: { oneWayMs: 20, upMbps: 10, downMbps: 50 },
  daemonRelay: { oneWayMs: 10, upMbps: 10, downMbps: 100 },
};

/**
 * A TCP proxy that delays and rate-limits, per direction.
 *
 * Bytes are serialised at the cap (a chunk occupies the link for `bytes × 8 / rate`) and delivered
 * one one-way delay after they finish — the store-and-forward a real link does. With a zero delay and
 * no cap a chunk is written straight through, so the loopback profile adds no timer of its own.
 */
class ShapedProxy {
  profile: LegProfile = UNSHAPED;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();

  private constructor(server: Server) {
    this.#server = server;
  }

  static async listen(targetPort: number): Promise<{ proxy: ShapedProxy; port: number }> {
    let proxy: ShapedProxy | undefined;
    const server = createServer(client => proxy?.connection(client, targetPort));
    proxy = new ShapedProxy(server);
    const port = await new Promise<number>(settle =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        settle(typeof address === 'object' && address !== null ? address.port : 0);
      }),
    );
    return { proxy, port };
  }

  connection(client: Socket, targetPort: number): void {
    client.setNoDelay(true);
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    upstream.setNoDelay(true);
    this.#sockets.add(client);
    this.#sockets.add(upstream);
    shapedPipe(client, upstream, () => ({ delay: this.profile.oneWayMs, mbps: this.profile.upMbps }));
    shapedPipe(upstream, client, () => ({ delay: this.profile.oneWayMs, mbps: this.profile.downMbps }));
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      this.#sockets.delete(client);
      this.#sockets.delete(upstream);
    };
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>(settle => this.#server.close(() => settle()));
  }
}

function shapedPipe(
  from: Socket,
  to: Socket,
  shape: () => { readonly delay: number; readonly mbps: number | undefined },
): void {
  let serialisedUntil = 0;
  const queue: { readonly due: number; readonly chunk: Buffer }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    const now = preciseNow();
    while (queue.length > 0 && (queue[0]?.due ?? Number.POSITIVE_INFINITY) <= now + 0.25) {
      const head = queue.shift();
      if (head !== undefined && !to.destroyed) to.write(head.chunk);
    }
    arm();
  };
  const arm = (): void => {
    const head = queue[0];
    if (timer !== undefined || head === undefined) return;
    timer = setTimeout(flush, Math.max(0, head.due - preciseNow()));
  };
  from.on('data', (chunk: Buffer) => {
    const { delay, mbps } = shape();
    if (delay === 0 && mbps === undefined && queue.length === 0) {
      to.write(chunk);
      return;
    }
    const now = preciseNow();
    const start = Math.max(now, serialisedUntil);
    serialisedUntil = start + (mbps === undefined ? 0 : (chunk.byteLength * 8) / (mbps * 1_000));
    queue.push({ due: serialisedUntil + delay, chunk });
    arm();
  });
  from.on('end', () => {
    const finish = (): void => {
      if (queue.length === 0) to.end();
      else setTimeout(finish, 5);
    };
    finish();
  });
}

/* ---------- the daemon's half, instrumented -------------------------------- */

type DaemonEventKind = 'from-client' | 'write-start' | 'write-end' | 'capture-start' | 'capture-end' | 'send';

interface DaemonEvent {
  readonly at: number;
  readonly kind: DaemonEventKind;
  readonly bytes?: number;
  /** For `send`: what the transport answered — `0` is a dropped frame. */
  readonly result?: number;
}

const daemonEvents: DaemonEvent[] = [];
const mark = (kind: DaemonEventKind, extra: Omit<DaemonEvent, 'at' | 'kind'> = {}): void => {
  daemonEvents.push({ at: preciseNow(), kind, ...extra });
};

const runtimeScheduler: RelayLinkScheduler = {
  after: (milliseconds, action) => {
    const handle = setTimeout(action, milliseconds);
    return { cancel: () => clearTimeout(handle) };
  },
};

const terminalScheduler = {
  schedule: (callback: () => void, milliseconds: number) => {
    const handle = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(handle) };
  },
};

/**
 * A used terminal's history: coloured log lines about a hundred columns wide, which is what a shell
 * that has run a build or tailed a log for a while holds. Short `seq` lines would make a full redraw
 * look ten times cheaper than the redraw of a terminal anybody actually uses.
 */
const historyCommand = (lines: number): string =>
  `i=0; while [ $i -lt ${String(lines)} ]; do i=$((i+1)); printf '\\033[2m2026-10-20T12:00:00Z\\033[0m \\033[32mINFO\\033[0m request %06d path=/v1/sessions/fy_s_0001/terminals duration=12ms status=200\\n' $i; done\r`;

const DEVICE_ID = 'fy_device_id_benchmarkTheRelayHop01';
const SESSION_ID = 'fy_s_benchrelaylatency00000001';

/* ---------- the page ----------------------------------------------------- */

async function pageScript(): Promise<string> {
  const bundle = await Bun.build({
    entrypoints: [join(harnessDir, 'relay-terminal-bench-page.ts')],
    target: 'browser',
    define: { 'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production' }) },
  });
  const [script] = bundle.outputs;
  if (!bundle.success || script === undefined) throw new Error(bundle.logs.join('\n'));
  return await script.text();
}

/* ---------- one scenario's numbers ---------------------------------------- */

interface ObservedFrame {
  readonly at: number;
  readonly direction: 'to-rendezvous' | 'from-rendezvous';
  readonly role: 'daemon' | 'client' | 'unknown';
  readonly kind: 'binary' | 'text';
  readonly bytes: number;
}

interface Hops {
  readonly total: number;
  readonly up: number;
  readonly relayUp?: number;
  readonly tmuxWrite: number;
  readonly untilCapture: number;
  readonly capture: number;
  readonly encode: number;
  readonly down: number;
  readonly relayDown?: number;
  readonly render: number;
  readonly echoBytes: number;
}

const first = <T extends { at: number }>(
  items: readonly T[],
  from: number,
  test: (item: T) => boolean,
): T | undefined => items.find(item => item.at >= from && test(item));
const last = <T extends { at: number }>(
  items: readonly T[],
  until: number,
  test: (item: T) => boolean,
): T | undefined => items.findLast(item => item.at <= until && test(item));

/** A credit frame is a 28-byte header and a 4-byte count; anything carrying data is larger. */
const CREDIT_FRAME_BYTES = 32;

function hopsFor(result: BenchPageResult, observed: readonly ObservedFrame[]): Hops[] {
  return result.keys.flatMap((key): Hops[] => {
    const arrived = first(daemonEvents, key.sentAt, event => event.kind === 'from-client');
    const writeStart = arrived && first(daemonEvents, arrived.at, event => event.kind === 'write-start');
    const writeEnd = writeStart && first(daemonEvents, writeStart.at, event => event.kind === 'write-end');
    const sent = last(
      daemonEvents,
      key.receivedAt,
      event => event.kind === 'send' && (event.result ?? 0) > 0 && event.at >= key.sentAt,
    );
    const captureEnd = sent && last(daemonEvents, sent.at, event => event.kind === 'capture-end');
    const captureStart = captureEnd && last(daemonEvents, captureEnd.at, event => event.kind === 'capture-start');
    if (!arrived || !writeStart || !writeEnd || !sent || !captureEnd || !captureStart) return [];
    const upIn = first(observed, key.sentAt, frame => frame.direction === 'to-rendezvous' && frame.role === 'client');
    const upOut =
      upIn && first(observed, upIn.at, frame => frame.direction === 'from-rendezvous' && frame.role === 'daemon');
    const downIn = first(
      observed,
      sent.at,
      frame => frame.direction === 'to-rendezvous' && frame.role === 'daemon' && frame.bytes > CREDIT_FRAME_BYTES,
    );
    const downOut =
      downIn &&
      first(
        observed,
        downIn.at,
        frame => frame.direction === 'from-rendezvous' && frame.role === 'client' && frame.bytes === downIn.bytes,
      );
    return [
      {
        total: key.paintedAt - key.sentAt,
        up: arrived.at - key.sentAt,
        ...(upIn && upOut && upOut.at <= arrived.at ? { relayUp: upOut.at - upIn.at } : {}),
        tmuxWrite: writeEnd.at - writeStart.at,
        untilCapture: captureStart.at - writeEnd.at,
        capture: captureEnd.at - captureStart.at,
        encode: sent.at - captureEnd.at,
        down: key.receivedAt - sent.at,
        ...(downIn && downOut && downOut.at <= key.receivedAt ? { relayDown: downOut.at - downIn.at } : {}),
        render: key.paintedAt - key.receivedAt,
        echoBytes: sent.bytes ?? 0,
      },
    ];
  });
}

const quantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] ?? Number.NaN;
};

interface ScenarioResult {
  readonly name: string;
  readonly carrier: 'direct' | 'relay' | 'webrtc';
  readonly network: string;
  readonly networkDescription: string;
  readonly scrollback: number;
  readonly outputGateMs: number;
  readonly pathRttMs: number;
  readonly keys: number;
  readonly echo: { readonly p50: number; readonly p95: number; readonly overRttP50: number };
  readonly hopsP50: Record<string, number>;
  readonly echoBytesP50: number;
  readonly throughput?: { readonly ms: number; readonly bytes: number; readonly frames: number };
  /** Set when the terminal never got as far as the measurement: the finding, not a crash. */
  readonly error?: string;
  readonly received: { readonly bytes: number; readonly frames: number };
}

function summarise(scenario: Scenario, result: BenchPageResult, observed: readonly ObservedFrame[]): ScenarioResult {
  const hops = hopsFor(result, observed);
  const totals = result.keys.map(key => key.paintedAt - key.sentAt);
  // WebRTC is UDP, which the shaping proxy (TCP) cannot touch, so it is run on loopback only: its path
  // adds nothing, and on a real network it pays ONE leg, phone to home — the direct path's round trip.
  const pathRttMs =
    scenario.carrier === 'webrtc'
      ? 0
      : scenario.carrier === 'direct'
        ? 2 * scenario.network.direct.oneWayMs
        : 2 * (scenario.network.clientRelay.oneWayMs + scenario.network.daemonRelay.oneWayMs);
  const median = (pick: (hop: Hops) => number | undefined): number =>
    quantile(
      hops.map(pick).filter((value): value is number => value !== undefined),
      0.5,
    );
  const hopsP50: Record<string, number> = {
    up: median(hop => hop.up),
    tmuxWrite: median(hop => hop.tmuxWrite),
    untilCapture: median(hop => hop.untilCapture),
    capture: median(hop => hop.capture),
    encode: median(hop => hop.encode),
    down: median(hop => hop.down),
    render: median(hop => hop.render),
  };
  if (scenario.carrier === 'relay') {
    hopsP50.relayUp = median(hop => hop.relayUp);
    hopsP50.relayDown = median(hop => hop.relayDown);
  }
  const p50 = quantile(totals, 0.5);
  return {
    name: scenario.name,
    carrier: scenario.carrier,
    network: scenario.network.name,
    networkDescription: scenario.network.description,
    scrollback: scenario.scrollback,
    outputGateMs: scenario.outputGateMs,
    pathRttMs,
    keys: totals.length,
    echo: { p50, p95: quantile(totals, 0.95), overRttP50: p50 - pathRttMs },
    hopsP50,
    echoBytesP50: median(hop => hop.echoBytes),
    ...(result.throughput === undefined ? {} : { throughput: result.throughput }),
    ...(result.error === undefined ? {} : { error: result.error }),
    received: result.received,
  };
}

/* ---------- scenarios ------------------------------------------------------ */

interface Scenario {
  readonly name: string;
  readonly carrier: 'direct' | 'relay' | 'webrtc';
  readonly network: NetworkProfile;
  readonly scrollback: number;
  readonly outputGateMs: number;
  readonly throughput: boolean;
}

const scenario = (
  carrier: Scenario['carrier'],
  network: NetworkProfile,
  scrollback: number,
  outputGateMs: number,
  throughput: boolean,
): Scenario => ({
  name: `${carrier}${carrier === 'relay' ? `(gate ${String(outputGateMs)}ms)` : ''} · ${network.name} · ${scrollback === 0 ? 'fresh' : `${String(scrollback)} lines of history`}`,
  carrier,
  network,
  scrollback,
  outputGateMs,
  throughput,
});

/** The output-gate values a relay is run at. 0 is the substituted runtime; 10 ms is a chosen model. */
const GATES = QUICK ? [0] : [0, 10];

const SCENARIOS: readonly Scenario[] = SHOTS_ONLY
  ? []
  : [
      ...HISTORIES.map(history => scenario('direct', LOOPBACK, history, 0, false)),
      ...HISTORIES.map(history => scenario('direct', WAN, history, 0, true)),
      ...HISTORIES.map(history => scenario('webrtc', LOOPBACK, history, 0, true)),
      ...GATES.flatMap(gate => [
        ...HISTORIES.map(history => scenario('relay', LOOPBACK, history, gate, false)),
        ...HISTORIES.map(history => scenario('relay', WAN, history, gate, true)),
      ]),
    ];

/** The two widths the evidence is taken at, each with the emulator size a viewer of that width would use. */
const SHOT_VIEWS = [
  { name: 'desktop', width: 1_440, height: 900, cols: 110, rows: 32 },
  { name: 'phone', width: 390, height: 844, cols: 36, rows: 30 },
] as const;

/* ---------- the rendezvous process ---------------------------------------- */

interface Rendezvous {
  readonly port: number;
  readonly observations: string;
  stop(): Promise<void>;
}

async function startRendezvous(root: string, daemonId: string, outputGateMs: number): Promise<Rendezvous> {
  const observations = join(root, `rendezvous-${String(outputGateMs)}.jsonl`);
  await writeFile(observations, '', 'utf8');
  const child = spawn(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'test', 'rendezvous-process.ts'),
      '--observations',
      observations,
      '--allow',
      daemonId,
      '--timing-only',
      '--output-gate-ms',
      String(outputGateMs),
    ],
    { cwd: repositoryRoot, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const port = await new Promise<number>((settle, fail) => {
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      const line = stdout.split('\n').find(candidate => candidate.startsWith('{'));
      if (line !== undefined) settle((JSON.parse(line) as { port: number }).port);
    });
    child.once('close', code => fail(new Error(`rendezvous exited (${String(code)}): ${stderr}`)));
  });
  return {
    port,
    observations,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise(settle => child.once('close', settle));
    },
  };
}

async function readObservations(path: string): Promise<ObservedFrame[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as ObservedFrame);
}

/* ---------- the run -------------------------------------------------------- */

const root = await mkdtemp(join(tmpdir(), 'fy-relay-bench-'));
const tmuxSocket = join(root, 'tmux.sock');
const tmuxExecutable = Bun.which('tmux');
if (tmuxExecutable === null) throw new Error('tmux is not on PATH');
const tmux = new BunTmuxProcess(tmuxExecutable, tmuxSocket);
const service = new ManagedTerminalService(
  new TmuxTerminalRuntime(tmux, () => Date.now(), { shell: async () => '/bin/sh' }),
  { resolve: async reference => (reference === SESSION_ID ? { id: SESSION_ID, cwd: root } : undefined) },
  { now: () => Date.now() },
  { next: () => crypto.randomUUID().replaceAll('-', '').slice(0, 12) },
  { maximumPerSession: 64, maximumGlobal: 64 },
);

/** The service as the bridge sees it, stamping each call so the hop it spent can be told apart. */
const instrumented: TerminalStreamService = {
  write: async (sessionId, terminalId, bytes) => {
    mark('write-start', { bytes: bytes.byteLength });
    await service.write(sessionId, terminalId, bytes);
    mark('write-end');
  },
  resize: async (sessionId, terminalId, cols, rows) => await service.resize(sessionId, terminalId, cols, rows),
  capture: async (sessionId, terminalId, historyLines) => {
    mark('capture-start');
    const snapshot = await service.capture(sessionId, terminalId, historyLines);
    mark('capture-end');
    return snapshot;
  },
};

let currentTerminal = '';
const relayCrypto = new WebCryptoRelayCrypto();
const identity = await newDaemonIdentity();
const deviceKeys = new Map<string, string>();

/** The route table, reduced to the one route being timed: the terminal stream, already authorized. */
const sockets = {
  reauthorize: () => true,
  upgrade: async (request: { readonly path: string }): Promise<SocketUpgradeDecision> => {
    const expected = `/v1/sessions/${SESSION_ID}/terminals/${currentTerminal}/stream`;
    if (request.path !== expected) return { outcome: 'unclaimed' };
    return {
      outcome: 'accepted',
      attach: async (downstream: SocketDownstream): Promise<SocketHandler> => {
        const timed: SocketDownstream = {
          send: frame => {
            const result = downstream.send(frame);
            mark('send', { bytes: typeof frame === 'string' ? frame.length : frame.byteLength, result: result ?? 1 });
            return result;
          },
          close: (code, reason) => downstream.close(code, reason),
          bufferedBytes: () => downstream.bufferedBytes(),
        };
        const bridge = new TerminalStreamBridge(instrumented, SESSION_ID, currentTerminal, timed, terminalScheduler);
        return {
          open: async () => await bridge.open(),
          fromClient: frame => {
            mark('from-client');
            bridge.fromClient(frame);
          },
          close: () => bridge.close(),
        };
      },
    };
  },
};

const linkDependencies = {
  crypto: relayCrypto,
  identity,
  dispatch: async () => ({ status: 404, headers: new Headers(), body: '{}' }),
  sockets,
  devices: { deviceKey: async (deviceId: string) => deviceKeys.get(deviceId), seen: () => undefined },
  pairing: { redeemInSession: async () => ({ kind: 'refused' as const }) },
  connections: { track: () => () => undefined },
  scheduler: runtimeScheduler,
  clock: { now: () => Date.now() },
};

/** The daemon's own listener, carrying direct sessions exactly as `fyd` mounts them. */
interface DirectSocketData {
  handler?: SocketHandler;
}
const directListener = Bun.serve<DirectSocketData>({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request, server) => {
    const path = new URL(request.url).pathname;
    if (path !== `/v1/rendezvous/${identity.daemonId}/client`) return new Response('not found', { status: 404 });
    return server.upgrade(request, { data: {} }) ? undefined : new Response('upgrade failed', { status: 400 });
  },
  websocket: {
    open: (socket: ServerWebSocket<DirectSocketData>) => {
      const downstream: SocketDownstream = {
        send: frame => socket.send(frame),
        close: (code, reason) => socket.close(code, reason),
        bufferedBytes: () => socket.getBufferedAmount(),
      };
      const handler = new DirectSession(
        linkDependencies as never,
        { loopback: false, privilegedLoopback: false },
        downstream,
        () => undefined,
      );
      socket.data.handler = handler;
      void handler.open();
    },
    message: (socket: ServerWebSocket<DirectSocketData>, message: string | Buffer) => {
      socket.data.handler?.fromClient(typeof message === 'string' ? message : new Uint8Array(message));
    },
    close: (socket: ServerWebSocket<DirectSocketData>) => socket.data.handler?.close(),
  },
});

const direct = await ShapedProxy.listen(directListener.port ?? 0);

/** The daemon's peer-to-peer carrier: the real `WebRtcCarrier` and engine, its sessions direct sessions. */
const webrtcCarrier = new WebRtcCarrier({
  availability: { kind: 'ready' },
  engine: new NodeDataChannelEngine(),
  iceServers: [],
  sessions: (arrival, downstream, release) =>
    new DirectSession(linkDependencies as never, arrival, downstream, release),
  scheduler: runtimeScheduler,
  peerId: () => crypto.randomUUID(),
});

const pageHtml = `<!doctype html><meta charset="utf-8"><style>${await readFile(
  join(harnessDir, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  'utf8',
).catch(() => '')}</style><style>body{margin:16px}</style><body><script type="module" src="/__bench.js"></script>`;
const script = await pageScript();
const pageServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(pageHtml, { headers: { 'content-type': 'text/html' } });
    if (path === '/__bench.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    return new Response('not found', { status: 404 });
  },
});

const progress = (step: string): void => {
  if (process.env.FY_BENCH_VERBOSE === '1') process.stderr.write(`· ${step}\n`);
};
progress('launching chrome');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? Bun.which('google-chrome') ?? Bun.which('chromium') ?? 'google-chrome',
  headless: true,
});
const results: ScenarioResult[] = [];
let failure: unknown;
try {
  const tab = await (await browser.newContext({ viewport: { width: 1_440, height: 900 } })).newPage();
  tab.on('pageerror', error => console.log(`[page error] ${error.message}`));
  await tab.exposeFunction('__benchOffer', async (sdp: string) => {
    const answered = await webrtcCarrier.offer(sdp, { deviceId: DEVICE_ID, appSession: 'bench' });
    if (answered.kind !== 'answered') throw new Error(answered.reason);
    return answered.sdp;
  });
  tab.on('console', message => progress(`page: ${message.text()}`));
  progress('loading the page');
  await tab.goto(`http://127.0.0.1:${String(pageServer.port)}/`);
  await tab.waitForFunction(() => typeof (globalThis as { __bench?: unknown }).__bench === 'object');
  const publicKey = await tab.evaluate(
    async deviceId =>
      await (globalThis as unknown as { __bench: { device(id: string): Promise<string> } }).__bench.device(deviceId),
    DEVICE_ID,
  );
  deviceKeys.set(DEVICE_ID, publicKey);
  progress('device minted');

  const byGate = new Map<number, Scenario[]>();
  for (const entry of SCENARIOS) {
    const key = entry.carrier === 'relay' ? entry.outputGateMs : -1;
    byGate.set(key, [...(byGate.get(key) ?? []), entry]);
  }
  if (SHOTS !== undefined && !byGate.has(0)) byGate.set(0, []);
  for (const [gate, group] of byGate) {
    let rendezvous: Rendezvous | undefined;
    let carrier: BunRelayCarrier | undefined;
    let clientRelay: Awaited<ReturnType<typeof ShapedProxy.listen>> | undefined;
    let daemonRelay: Awaited<ReturnType<typeof ShapedProxy.listen>> | undefined;
    if (gate >= 0) {
      rendezvous = await startRendezvous(root, identity.daemonId, gate);
      clientRelay = await ShapedProxy.listen(rendezvous.port);
      daemonRelay = await ShapedProxy.listen(rendezvous.port);
      carrier = new BunRelayCarrier({
        ...linkDependencies,
        config: { url: `ws://127.0.0.1:${String(daemonRelay.port)}`, enabled: true, reconnectSeconds: 1 },
        log: () => undefined,
      } as never);
      progress(`starting the relay carrier (gate ${String(gate)} ms)`);
      carrier.start();
      const deadline = Date.now() + 15_000;
      while (carrier.status().phase !== 'carrying' && Date.now() < deadline) await Bun.sleep(50);
      if (carrier.status().phase !== 'carrying')
        throw new Error(`the daemon never claimed the rendezvous: ${JSON.stringify(carrier.status())}`);
      await Bun.sleep(300);
    }
    for (const entry of group) {
      direct.proxy.profile = entry.network.direct;
      if (clientRelay !== undefined) clientRelay.proxy.profile = entry.network.clientRelay;
      if (daemonRelay !== undefined) daemonRelay.proxy.profile = entry.network.daemonRelay;
      const created = await service.create(SESSION_ID, { title: 'bench', cols: COLS, rows: ROWS });
      currentTerminal = created.id;
      // A known prompt, so the page can tell its echo from everything else on the screen.
      await service.write(SESSION_ID, created.id, new TextEncoder().encode("PS1='bench$ '; clear\r"));
      if (entry.scrollback > 0)
        await service.write(SESSION_ID, created.id, new TextEncoder().encode(historyCommand(entry.scrollback)));
      await Bun.sleep(entry.scrollback > 0 ? 2_000 : 600);
      daemonEvents.length = 0;
      const config: BenchRunConfig = {
        daemonId: identity.daemonId,
        deviceId: DEVICE_ID,
        method:
          entry.carrier === 'webrtc'
            ? { kind: 'webrtc' }
            : entry.carrier === 'direct'
              ? { kind: 'direct', daemonUrl: `http://127.0.0.1:${String(direct.port)}` }
              : { kind: 'relay', relayUrl: `ws://127.0.0.1:${String(clientRelay?.port ?? 0)}` },
        path: `/v1/sessions/${SESSION_ID}/terminals/${created.id}/stream`,
        cols: COLS,
        rows: ROWS,
        prompt: 'bench$ ',
        keys: KEYS,
        ...(entry.throughput ? { throughputLines: SEQ_LINES } : {}),
      };
      const started = preciseNow();
      progress(`running ${entry.name}`);
      const result = await tab.evaluate(
        async run =>
          await (
            globalThis as unknown as { __bench: { run(c: BenchRunConfig): Promise<BenchPageResult> } }
          ).__bench.run(run),
        config,
      );
      const observed =
        rendezvous === undefined
          ? []
          : (await readObservations(rendezvous.observations)).filter(frame => frame.at >= started);
      const summary = summarise(entry, result, observed);
      results.push(summary);
      if (summary.error !== undefined)
        console.log(
          `${summary.name.padEnd(58)} FAILED after ${String(summary.received.frames)} frames / ${String(summary.received.bytes)} B: ${summary.error}`,
        );
      else
        console.log(
          `${summary.name.padEnd(58)} echo p50 ${summary.echo.p50.toFixed(1).padStart(6)} ms  p95 ${summary.echo.p95.toFixed(1).padStart(6)} ms  ` +
            `(path RTT ${String(summary.pathRttMs)} ms)  echo frame ${String(Math.round(summary.echoBytesP50))} B` +
            (summary.throughput === undefined
              ? ''
              : `  seq ${String(SEQ_LINES)}: ${summary.throughput.ms.toFixed(0)} ms, ${String(Math.round(summary.throughput.bytes / 1024))} KiB in ${String(summary.throughput.frames)} frames`),
        );
      await service.close(SESSION_ID, created.id);
    }
    if (gate === 0 && SHOTS !== undefined && clientRelay !== undefined && daemonRelay !== undefined) {
      // The evidence: a terminal that has been USED — 1500 lines of history — painted over the relay, on
      // the modelled phone-to-home link, with eight keystrokes echoed on its prompt.
      clientRelay.proxy.profile = WAN.clientRelay;
      daemonRelay.proxy.profile = WAN.daemonRelay;
      for (const view of SHOT_VIEWS) {
        await tab.setViewportSize({ width: view.width, height: view.height });
        const created = await service.create(SESSION_ID, { title: 'bench', cols: view.cols, rows: view.rows });
        currentTerminal = created.id;
        await service.write(SESSION_ID, created.id, new TextEncoder().encode("PS1='bench$ '; clear\r"));
        await service.write(SESSION_ID, created.id, new TextEncoder().encode(historyCommand(1_500)));
        await Bun.sleep(2_000);
        const result = await tab.evaluate(
          async run =>
            await (
              globalThis as unknown as { __bench: { run(c: BenchRunConfig): Promise<BenchPageResult> } }
            ).__bench.run(run),
          {
            daemonId: identity.daemonId,
            deviceId: DEVICE_ID,
            method: { kind: 'relay', relayUrl: `ws://127.0.0.1:${String(clientRelay.port)}` },
            path: `/v1/sessions/${SESSION_ID}/terminals/${created.id}/stream`,
            cols: view.cols,
            rows: view.rows,
            prompt: 'bench$ ',
            keys: 8,
            hold: true,
          } satisfies BenchRunConfig,
        );
        for (const scheme of ['light', 'dark'] as const) {
          await tab.emulateMedia({ colorScheme: scheme });
          await tab.evaluate(() => (globalThis as unknown as { __bench: { theme(): void } }).__bench.theme());
          await Bun.sleep(200);
          const path = join(resolve(SHOTS), `relay-terminal-${LABEL}-${view.name}-${scheme}.png`);
          await tab.screenshot({ path });
          console.log(`screenshot ${path}${result.error === undefined ? '' : ` (the run stopped: ${result.error})`}`);
        }
        await tab.evaluate(() => (globalThis as unknown as { __bench: { release(): void } }).__bench.release());
        await service.close(SESSION_ID, created.id);
      }
    }
    carrier?.stop();
    await clientRelay?.proxy.close();
    await daemonRelay?.proxy.close();
    await rendezvous?.stop();
  }
} catch (error) {
  failure = error;
} finally {
  // Bounded, every step: a benchmark that hangs in teardown hides the error that ended it.
  const bounded = async (step: () => Promise<unknown>): Promise<void> => {
    await Promise.race([step().catch(() => undefined), Bun.sleep(5_000)]);
  };
  await bounded(async () => await browser.close());
  await bounded(async () => await pageServer.stop(true));
  await bounded(async () => await directListener.stop(true));
  await bounded(async () => await direct.proxy.close());
  await bounded(async () => await tmux.execute(['kill-server']));
  await bounded(async () => await rm(root, { recursive: true, force: true }));
}
if (failure !== undefined) {
  console.error(failure);
  process.exit(1);
}

console.log('\nper-hop medians (ms):');
for (const result of results) {
  const hops = Object.entries(result.hopsP50)
    .map(([name, value]) => `${name} ${Number.isNaN(value) ? '–' : value.toFixed(1)}`)
    .join(' · ');
  console.log(`  ${result.name}\n    ${hops}`);
}

if (OUT !== undefined) {
  await writeFile(
    resolve(OUT),
    `${JSON.stringify({ label: LABEL, at: new Date().toISOString(), keys: KEYS, seqLines: SEQ_LINES, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nwrote ${resolve(OUT)}`);
}
process.exit(0);
