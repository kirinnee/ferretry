/**
 * A REAL rendezvous, in a real process, speaking real WebSockets.
 *
 * The compiled `fyd` binary opens an outbound socket to this address and a real Chrome opens one
 * from the other side. Neither of them is being fooled: the frames on both sockets are the wire
 * frames of `docs/relay-protocol.md`, and the thing deciding what to do with them is
 * `packages/relay`'s own `relayFetch` front door and its own `RendezvousDurableObject` — imported by
 * relative path, exactly as `packages/pwa/tests/integration/relay-carrier-end-to-end.test.ts`
 * imports them, so a copy could not be substituted for the file that ships.
 *
 * ── WHAT IS REAL AND WHAT IS SUBSTITUTED, said plainly ────────────────────────────────────────
 *
 * REAL: the rendezvous state machine, the frame codec, the claim verification, the session
 * admission rules, the close codes, the heartbeat vocabulary, the daemon/client route shapes, and
 * every byte that crosses the wire in both directions.
 *
 * SUBSTITUTED: the Cloudflare Workers RUNTIME. `wrangler` IS on the devshell `PATH` and its
 * `workerd` does start — but that binary's newest supported compatibility date is older than the
 * one `packages/relay/wrangler.jsonc` pins, so `wrangler dev` refuses this Worker outright. Running
 * it anyway would mean overriding the compatibility date the deployment chose, which silently
 * changes runtime semantics, and it would cost the observation log below unless a recording proxy
 * went in front. So the Workers runtime is substituted rather than downgraded, and this paragraph
 * is the place to revisit when the pinned toolchain moves. What runs the real Durable Object here
 * is Bun, through the same
 * `RelayObjectState` / `RelayRuntime` / `RelaySocket` ports `packages/relay/src/adapters/worker.ts`
 * declares for exactly this reason. Concretely, this process substitutes:
 *
 *   - hibernation and its wake semantics — this object never sleeps;
 *   - `setWebSocketAutoResponse`, whose ping/pong the Workers runtime answers below the object.
 *     Answered here in {@link heartbeatAnswered}, in the same vocabulary (`fy-ping`/`fy-pong`), and
 *     the answer timestamp is what `getWebSocketAutoResponseTimestamp` reports, as in production;
 *   - durable storage, which is a `Map` here. A rendezvous whose object is evicted mid-session is
 *     therefore not exercised;
 *   - `storage.setAlarm`, which is a `setTimeout` here rather than a durable alarm;
 *   - the global uniqueness of a Durable Object id, which here is a `Map` in one process.
 *
 * None of those substitutions can make an unencrypted session look encrypted, admit a session the
 * state machine would refuse, or forge a frame — which is what this harness is asked to prove.
 * They do mean this process proves nothing about Cloudflare, and the protocol document already says
 * that claim is only ever made by a real deployment.
 *
 * ── THE OBSERVATION LOG ────────────────────────────────────────────────────────────────────────
 *
 * Every frame this process handles, in both directions, is appended to `--observations` as one
 * base64 JSONL record. That file is the evidence for the assertion that matters: a rendezvous
 * carried a first pairing and a live stream and could not read the code, the token, the device name
 * or the payload. It is written by the relay, about the relay, which is the only vantage point from
 * which that claim means anything.
 *
 * ── THE HARNESS CONTROL PLANE ──────────────────────────────────────────────────────────────────
 *
 * `/__harness/*` is NOT part of the relay contract and is served by this file, never by
 * `relayFetch`. It exists because a self-hosted deployment refuses a fingerprint its operator did
 * not list, and this run's fingerprint does not exist until the daemon has booted once — so the
 * allowlist has to be installable after this server is already listening. The prefix cannot collide
 * with a rendezvous path: `parseRendezvousPath` accepts exactly four segments starting `v1`.
 *
 * Usage — this process is spawned by `tests/e2e/support/relay-harness.ts`, never by a person:
 *
 *     bun scripts/test/rendezvous-process.ts --observations <path> [--port <n>]
 *
 * It prints one line of JSON (`{"ready":true,"port":n,"origin":"…"}`) on stdout when listening, and
 * exits on SIGTERM/SIGINT with every socket closed.
 */

import { appendFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import {
  type RelayEnvironment,
  type RelayObjectState,
  type RelayRuntime,
  type RelaySocket,
  type RelayStorage,
  relayFetch,
  RendezvousDurableObject,
  WebCryptoRelayCrypto,
} from '../../packages/relay/src/adapters/index.ts';
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  parseRendezvousPath,
  RELAY_PROTOCOL_ID,
} from '../../packages/relay/src/lib/index.ts';

/** What the harness control plane may address. Anything else is the relay's own surface. */
const HARNESS_PREFIX = '/__harness/';

/**
 * Every arrival this rendezvous has seen, by role and fingerprint, admitted or refused.
 *
 * DURABLE on purpose, and both halves of that matter.
 *
 * The DAEMON side is how the harness learns which daemon it just booted. Grepping the daemon's boot
 * trail for its "dialling the relay" line races: the trail is written after the HTTP listener opens,
 * so a readiness poll can return, and the daemon be stopped, before that line exists. On a loaded
 * machine that reads as "the daemon minted no relay identity" when it minted one and had not yet
 * said so.
 *
 * The CLIENT side is how the harness proves a pairing crossed this relay. A live-socket census
 * cannot: a §14 pairing session is one attempt and the daemon closes it with `4440` the instant the
 * sealed outcome is sent, so by the time anything polls, the socket a successful pairing used is
 * already gone. Asking "is a client connected" would therefore report the same emptiness for a
 * pairing that worked and one that never happened.
 *
 * A refused arrival counts. An unlisted fingerprint gets a 404 and never becomes a socket, but the
 * rendezvous still saw who asked — which is exactly the fact needed to then allow it.
 */
const arrivals: { readonly role: 'daemon' | 'client'; readonly daemonId: string }[] = [];

interface ObservedFrame {
  readonly at: number;
  readonly direction: 'to-rendezvous' | 'from-rendezvous';
  readonly role: 'daemon' | 'client' | 'unknown';
  readonly kind: 'binary' | 'text';
  readonly bytes: number;
  /** Base64 of the exact bytes. Text frames are the utf-8 encoding of the text. */
  readonly base64: string;
}

interface SocketData {
  readonly socket: BunRelaySocket;
  readonly role: 'daemon' | 'client';
  readonly daemonId: string;
}

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: bun rendezvous-process.ts --observations <path> [--port <n>]\n`);
  process.exit(2);
}

function parseArguments(argv: readonly string[]): { readonly observations: string; readonly port: number } {
  let observations: string | undefined;
  let port = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--observations') {
      if (value === undefined) usage('--observations needs a path');
      observations = value;
      index += 1;
    } else if (flag === '--port') {
      if (value === undefined) usage('--port needs a number');
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) usage('--port must be a TCP port');
      index += 1;
    } else {
      usage(`unknown argument: ${String(flag)}`);
    }
  }
  if (observations === undefined) usage('--observations is required');
  return { observations, port };
}

const options = parseArguments(process.argv.slice(2));

function record(frame: ObservedFrame): void {
  appendFileSync(options.observations, `${JSON.stringify(frame)}\n`, 'utf8');
}

function base64Of(data: ArrayBuffer | ArrayBufferView | string): string {
  if (typeof data === 'string') return Buffer.from(data, 'utf8').toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

function byteLengthOf(data: ArrayBuffer | ArrayBufferView | string): number {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  return data.byteLength;
}

/**
 * One accepted socket, from the object's side.
 *
 * The object is handed this BEFORE Bun has a live `ServerWebSocket` for it — `relayFetch` may send
 * a refusal frame and close during the upgrade itself, which is the whole reason
 * `refusalUpgrade` exists. So everything written before {@link attach} is buffered and flushed in
 * order, and a close that arrived first is applied after the flush rather than dropped.
 */
class BunRelaySocket implements RelaySocket {
  role: 'daemon' | 'client' | 'unknown' = 'unknown';
  /** The answer stamp of the last heartbeat, which is what the rendezvous sweep reads. */
  lastHeartbeat: Date | null = null;
  #live: ServerWebSocket<SocketData> | undefined;
  #buffered: (ArrayBuffer | string)[] = [];
  #closing: { readonly code?: number; readonly reason?: string } | undefined;
  #attachment: unknown = null;

  send(data: ArrayBuffer | string): void {
    record({
      at: Date.now(),
      direction: 'from-rendezvous',
      role: this.role,
      kind: typeof data === 'string' ? 'text' : 'binary',
      bytes: byteLengthOf(data),
      base64: base64Of(data),
    });
    const live = this.#live;
    if (live === undefined) {
      this.#buffered.push(data);
      return;
    }
    live.send(typeof data === 'string' ? data : new Uint8Array(data));
  }

  close(code?: number, reason?: string): void {
    const live = this.#live;
    if (live === undefined) {
      this.#closing ??= { code, reason };
      return;
    }
    // A WebSocket close reason is capped at 123 bytes; the relay's own reasons are short, but a
    // truncation here would corrupt evidence rather than a message, so it is explicit.
    live.close(code, reason === undefined ? undefined : reason.slice(0, 120));
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.#attachment;
  }

  attach(live: ServerWebSocket<SocketData>): void {
    this.#live = live;
    for (const data of this.#buffered) live.send(typeof data === 'string' ? data : new Uint8Array(data));
    this.#buffered = [];
    const closing = this.#closing;
    if (closing !== undefined) live.close(closing.code, closing.reason?.slice(0, 120));
  }
}

class MemoryStorage implements RelayStorage {
  readonly #values = new Map<string, unknown>();
  #alarm: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly fire: () => void) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.#values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, value);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    if (this.#alarm !== undefined) clearTimeout(this.#alarm);
    const delay = Math.max(0, scheduledTime - Date.now());
    this.#alarm = setTimeout(() => this.fire(), delay);
    this.#alarm.unref?.();
  }

  cancelAlarm(): void {
    if (this.#alarm !== undefined) clearTimeout(this.#alarm);
    this.#alarm = undefined;
  }
}

class BunObjectState implements RelayObjectState {
  readonly storage: MemoryStorage;
  readonly #sockets: BunRelaySocket[] = [];

  constructor(fireAlarm: () => void) {
    this.storage = new MemoryStorage(fireAlarm);
  }

  acceptWebSocket(socket: RelaySocket): void {
    this.#sockets.push(socket as BunRelaySocket);
  }

  getWebSockets(): RelaySocket[] {
    return [...this.#sockets];
  }

  /** Hibernation's ping/pong pair. Answered by {@link heartbeatAnswered} rather than by a runtime. */
  setWebSocketAutoResponse(): void {
    // Nothing to install: this process answers the heartbeat itself, in the same vocabulary.
  }

  getWebSocketAutoResponseTimestamp(socket: RelaySocket): Date | null {
    return (socket as BunRelaySocket).lastHeartbeat;
  }

  forget(socket: BunRelaySocket): void {
    const at = this.#sockets.indexOf(socket);
    if (at !== -1) this.#sockets.splice(at, 1);
  }
}

/** One rendezvous per daemon fingerprint, which is what a Durable Object id buys in production. */
interface Rendezvous {
  readonly object: RendezvousDurableObject;
  readonly state: BunObjectState;
}

const rendezvousByName = new Map<string, Rendezvous>();

/**
 * The socket the in-flight upgrade created.
 *
 * `createSocketPair` is called from inside `relayFetch`, several frames deep, and its `client` half
 * has no meaning outside the Workers runtime. Bun instead needs the SERVER half, so it is picked up
 * here. Safe because {@link serialise} admits one request at a time.
 */
const upgrading: BunRelaySocket[] = [];

const runtime: RelayRuntime = {
  crypto: new WebCryptoRelayCrypto(),
  now: () => Date.now(),
  createSocketPair: () => {
    const server = new BunRelaySocket();
    upgrading.push(server);
    return { client: server, server };
  },
  // Bun accepts the socket by completing the HTTP upgrade, which happens after `relayFetch` returns.
  acceptWebSocket: () => undefined,
  upgradeResponse: () => new Response(null, { status: 101 }),
  heartbeatPair: () => undefined,
};

/**
 * The daemon fingerprints this deployment carries.
 *
 * Mutable on purpose, and only through `/__harness/allow`: a self-hosted relay refuses a
 * fingerprint its operator never listed, and the fingerprint of a daemon whose state home was
 * created five seconds ago cannot have been listed before this process started.
 */
let allowedDaemonIds = '';

const environment: RelayEnvironment = {
  get RELAY_DAEMON_IDS() {
    return allowedDaemonIds;
  },
  RENDEZVOUS: {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let existing = rendezvousByName.get(name);
      if (existing === undefined) {
        const state = new BunObjectState(() => {
          void existing?.object.alarm();
        });
        existing = { object: new RendezvousDurableObject(state, environment, runtime), state };
        rendezvousByName.set(name, existing);
      }
      return existing.object;
    },
  },
};

function rendezvousFor(daemonId: string): Rendezvous {
  const name = `${RELAY_PROTOCOL_ID}:${daemonId}`;
  environment.RENDEZVOUS.get(environment.RENDEZVOUS.idFromName(name));
  const found = rendezvousByName.get(name);
  if (found === undefined) throw new Error('rendezvous was not created');
  return found;
}

/**
 * One request, one frame, one close at a time.
 *
 * A Durable Object is single-threaded and this process is not. Two upgrades interleaving would race
 * over {@link upgrading}, and two frames interleaving would hand the state machine a nonce out of
 * order — the exact failure `worker.ts`'s own promise chain exists to prevent, one layer up.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(error => {
    process.stderr.write(`rendezvous work failed: ${String(error)}\n`);
  });
  return next;
}

/** The heartbeat the Workers runtime answers below the object, answered here in its place. */
function heartbeatAnswered(live: ServerWebSocket<SocketData>, message: string): boolean {
  if (message !== HEARTBEAT_REQUEST) return false;
  live.data.socket.lastHeartbeat = new Date();
  live.send(HEARTBEAT_RESPONSE);
  return true;
}

function harnessResponse(pathname: string, request: Request): Promise<Response> | Response {
  if (pathname === `${HARNESS_PREFIX}health`) return Response.json({ ok: true });
  if (pathname === `${HARNESS_PREFIX}allow`) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    return request.text().then(body => {
      allowedDaemonIds = body.trim();
      return Response.json({ ok: true, allowed: allowedDaemonIds.split(/[\s,]+/u).filter(Boolean).length });
    });
  }
  if (pathname === `${HARNESS_PREFIX}arrivals`) return Response.json({ arrivals });
  if (pathname === `${HARNESS_PREFIX}sockets`) {
    const rows = [...rendezvousByName.entries()].map(([name, entry]) => ({
      rendezvous: name,
      sockets: entry.state.getWebSockets().length,
      roles: entry.state.getWebSockets().map(socket => (socket as BunRelaySocket).role),
    }));
    return Response.json({ rendezvous: rows });
  }
  return new Response('not found', { status: 404 });
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: options.port,
  idleTimeout: 0,
  fetch: async (request: Request, listener: { upgrade(request: Request, options: { data: SocketData }): boolean }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(HARNESS_PREFIX)) return harnessResponse(url.pathname, request);

    const route = parseRendezvousPath(url.pathname);
    if (route !== null) arrivals.push({ role: route.role, daemonId: route.daemonId });
    return serialise(async () => {
      upgrading.length = 0;
      const response = await relayFetch(request, environment, runtime);
      if (response.status !== 101) return response;
      // The LAST pair created wins: the front door may build a refusal socket, and the object
      // builds the real one. Only one of those paths runs for any single request.
      const socket = upgrading.at(-1);
      upgrading.length = 0;
      if (socket === undefined) return new Response('rendezvous produced no socket', { status: 500 });
      if (route !== null) socket.role = route.role;
      const upgraded = listener.upgrade(request, {
        data: { socket, role: route?.role ?? 'client', daemonId: route?.daemonId ?? '' },
      });
      return upgraded ? undefined : new Response('websocket upgrade failed', { status: 400 });
    });
  },
  websocket: {
    open: (live: ServerWebSocket<SocketData>) => {
      live.data.socket.attach(live);
    },
    message: (live: ServerWebSocket<SocketData>, message: string | Buffer) => {
      if (typeof message === 'string' && heartbeatAnswered(live, message)) return;
      record({
        at: Date.now(),
        direction: 'to-rendezvous',
        role: live.data.role,
        kind: typeof message === 'string' ? 'text' : 'binary',
        bytes: byteLengthOf(message),
        base64: base64Of(message),
      });
      const payload: ArrayBuffer | string =
        typeof message === 'string'
          ? message
          : (message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer);
      void serialise(async () => {
        if (live.data.daemonId === '') return;
        await rendezvousFor(live.data.daemonId).object.webSocketMessage(live.data.socket, payload);
      });
    },
    close: (live: ServerWebSocket<SocketData>) => {
      void serialise(async () => {
        if (live.data.daemonId === '') return;
        const rendezvous = rendezvousFor(live.data.daemonId);
        rendezvous.state.forget(live.data.socket);
        await rendezvous.object.webSocketClose(live.data.socket);
      });
    },
  },
});

process.stdout.write(
  `${JSON.stringify({ ready: true, port: server.port, origin: `http://127.0.0.1:${String(server.port)}` })}\n`,
);

const shutdown = (): void => {
  for (const entry of rendezvousByName.values()) {
    entry.state.storage.cancelAlarm();
    for (const socket of entry.state.getWebSockets()) (socket as BunRelaySocket).close(1_001, 'harness shutting down');
  }
  void server.stop(true).then(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
