/**
 * The Cloudflare half: a stateless Worker in front of one Durable Object per daemon.
 *
 * A Worker alone cannot do this. Any instance may serve any request, so no instance reliably holds
 * the socket the other party needs to reach. A Durable Object with a given id is a single instance
 * globally, which is exactly the one property a rendezvous needs, and hibernation means an idle one
 * costs nothing while it waits.
 *
 * Two jobs are split deliberately between the two halves.
 *
 * **The Worker refuses strangers before anything is allocated.** A deployment serves the daemon
 * fingerprints its operator listed and nothing else, and that check happens in the stateless
 * Worker. A probe for an unknown fingerprint gets a 404 without a Durable Object ever being
 * created, so scanning this deployment costs the operator a request rather than an instance.
 *
 * **The Durable Object decides everything else**, by handing each event to the state machine in
 * `src/lib/rendezvous.ts`. Nothing in this file knows what a session means. It moves bytes,
 * reads clocks, and applies effects.
 *
 * Handlers are serialised through one promise chain. A Durable Object is single-threaded, but an
 * `await` inside a handler still yields, and two frames interleaving halfway through a state
 * transition is how a rendezvous ends up with two daemons.
 */

import {
  decodeFrame,
  encodeFrame,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  initialRendezvousState,
  parseRendezvousPath,
  parseRelayTenancy,
  reduceRendezvous,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type RelayCrypto,
  type RendezvousEvent,
  type RendezvousState,
  type RendezvousStep,
  NONCE_BYTES,
  SESSION_ID_BYTES,
  sessionIdFromBytes,
  servesDaemon,
  toBase64Url,
  verifyRendezvousClaim,
  decodeClaim,
} from '../lib/index.ts';
import { WebCryptoRelayCrypto } from './webcrypto-relay-crypto.ts';

// ─── the slice of the Workers runtime this adapter uses ───────────────────────────────────────

export interface RelaySocket {
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface RelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface RelayObjectState {
  readonly storage: RelayStorage;
  acceptWebSocket(socket: RelaySocket): void;
  getWebSockets(): RelaySocket[];
  setWebSocketAutoResponse(pair: unknown): void;
  getWebSocketAutoResponseTimestamp(socket: RelaySocket): Date | null;
}

export interface RendezvousNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface RelayEnvironment {
  readonly RENDEZVOUS: RendezvousNamespace;
  /**
   * Whitespace or comma separated daemon fingerprints this deployment carries.
   *
   * Configuration, not a secret: a fingerprint is public and is printed in a pairing QR. Unset
   * means this relay serves nobody, which is the only safe reading of a relay nobody configured.
   */
  readonly RELAY_DAEMON_IDS?: string;
}

/** The platform pieces that cannot be reached without the Workers runtime, so they are injected. */
export interface RelayRuntime {
  readonly crypto: RelayCrypto;
  now(): number;
  createSocketPair(): { readonly client: RelaySocket; readonly server: RelaySocket };
  upgradeResponse(client: RelaySocket): Response;
  heartbeatPair(): unknown;
}

declare const WebSocketPair: { new (): { readonly 0: RelaySocket; readonly 1: RelaySocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

export const workersRuntime: RelayRuntime = {
  crypto: new WebCryptoRelayCrypto(),
  now: () => Date.now(),
  createSocketPair: () => {
    const pair = new WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  upgradeResponse: (client: RelaySocket) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
  heartbeatPair: () => new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
};

// ─── the stateless front door ─────────────────────────────────────────────────────────────────

const STATE_KEY = 'rendezvous';
const NOT_FOUND = 'not found';

/**
 * Route a socket to its rendezvous, or refuse it cheaply.
 *
 * An unknown fingerprint and a malformed path get the same 404. Distinguishing them would tell a
 * scanner which fingerprints this deployment carries, and the honest answer to "is this daemon
 * here" is one only the daemon's own operator is owed.
 */
export async function relayFetch(request: Request, environment: RelayEnvironment): Promise<Response> {
  const route = parseRendezvousPath(new URL(request.url).pathname);
  if (route === null) return new Response(NOT_FOUND, { status: 404 });
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426 });
  }
  if (!servesDaemon(parseRelayTenancy(environment.RELAY_DAEMON_IDS), route.daemonId)) {
    return new Response(NOT_FOUND, { status: 404 });
  }
  const namespace = environment.RENDEZVOUS;
  return namespace.get(namespace.idFromName(`${RELAY_PROTOCOL_ID}:${route.daemonId}`)).fetch(request);
}

export default { fetch: relayFetch };

// ─── the durable half ─────────────────────────────────────────────────────────────────────────

interface SocketAttachment {
  readonly socketId: string;
}

export class RendezvousDurableObject {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly objectState: RelayObjectState,
    _environment: RelayEnvironment,
    private readonly runtime: RelayRuntime = workersRuntime,
  ) {
    // Heartbeats are answered by the runtime itself, so a live-but-idle rendezvous is never woken
    // and never billed for the waiting. Hibernation only pays off if nothing routine wakes it.
    this.objectState.setWebSocketAutoResponse(this.runtime.heartbeatPair());
  }

  async fetch(request: Request): Promise<Response> {
    const route = parseRendezvousPath(new URL(request.url).pathname);
    if (route === null) return new Response(NOT_FOUND, { status: 404 });

    const { client, server } = this.runtime.createSocketPair();
    const socketId = toBase64Url(this.runtime.crypto.randomBytes(8));
    server.serializeAttachment({ socketId } satisfies SocketAttachment);
    this.objectState.acceptWebSocket(server);

    const at = this.runtime.now();
    const event: RendezvousEvent =
      route.role === 'daemon'
        ? {
            kind: 'daemon-arrived',
            socketId,
            challenge: this.runtime.crypto.randomBytes(NONCE_BYTES),
            host: new URL(request.url).host,
            at,
          }
        : { kind: 'client-arrived', socketId, sessionId: this.newSessionId(), at };

    this.enqueue(async () => {
      const state = (await this.load()) ?? initialRendezvousState(route.daemonId);
      await this.applyStep(reduceRendezvous(state, event));
    });
    await this.queue;
    return this.runtime.upgradeResponse(client);
  }

  async webSocketMessage(socket: RelaySocket, message: ArrayBuffer | string): Promise<void> {
    const socketId = attachmentOf(socket);
    if (socketId === null) return this.orphan(socket);
    if (typeof message === 'string') {
      // The auto-responder handles the heartbeat without ever reaching here; anything else in text
      // is a peer speaking a protocol this one does not have.
      return this.refuseSocket(socket, RELAY_CLOSE_CODES.protocolError, 'this rendezvous carries binary frames');
    }
    const decoded = decodeFrame(new Uint8Array(message));
    if (!decoded.ok) return this.refuseSocket(socket, decoded.code, decoded.reason);
    this.enqueue(async () => {
      const state = await this.load();
      if (state === null) return this.refuseSocket(socket, RELAY_CLOSE_CODES.relayInternal, 'rendezvous state is lost');
      await this.applyStep(
        reduceRendezvous(state, { kind: 'frame', socketId, frame: decoded.frame, at: this.runtime.now() }),
      );
    });
    await this.queue;
  }

  async webSocketClose(socket: RelaySocket): Promise<void> {
    await this.departed(socket);
  }

  async webSocketError(socket: RelaySocket): Promise<void> {
    await this.departed(socket);
  }

  async alarm(): Promise<void> {
    this.enqueue(async () => {
      const state = await this.load();
      if (state === null) return;
      const lastSeen: Record<string, number> = {};
      for (const socket of this.objectState.getWebSockets()) {
        const socketId = attachmentOf(socket);
        if (socketId === null) continue;
        const stamp = this.objectState.getWebSocketAutoResponseTimestamp(socket);
        if (stamp !== null) lastSeen[socketId] = stamp.getTime();
      }
      await this.applyStep(reduceRendezvous(state, { kind: 'alarm', at: this.runtime.now(), lastSeen }));
    });
    await this.queue;
  }

  // ─── plumbing ───────────────────────────────────────────────────────────────────────────────

  private newSessionId() {
    const sessionId = sessionIdFromBytes(this.runtime.crypto.randomBytes(SESSION_ID_BYTES));
    if (sessionId === null) throw new Error('session identifier generator produced the wrong length');
    return sessionId;
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(step, step);
  }

  private async load(): Promise<RendezvousState | null> {
    return (await this.objectState.storage.get<RendezvousState>(STATE_KEY)) ?? null;
  }

  private async departed(socket: RelaySocket): Promise<void> {
    const socketId = attachmentOf(socket);
    if (socketId === null) return;
    this.enqueue(async () => {
      const state = await this.load();
      if (state === null) return;
      await this.applyStep(reduceRendezvous(state, { kind: 'socket-closed', socketId, at: this.runtime.now() }));
    });
    await this.queue;
  }

  /** A socket with no attachment is not one this rendezvous ever accepted. It does not get to stay. */
  private orphan(socket: RelaySocket): void {
    socket.close(RELAY_CLOSE_CODES.relayInternal, 'socket is not attached to this rendezvous');
  }

  private refuseSocket(socket: RelaySocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private socketsById(): Map<string, RelaySocket> {
    const sockets = new Map<string, RelaySocket>();
    for (const socket of this.objectState.getWebSockets()) {
      const socketId = attachmentOf(socket);
      if (socketId !== null) sockets.set(socketId, socket);
    }
    return sockets;
  }

  private async applyStep(step: RendezvousStep): Promise<void> {
    await this.objectState.storage.put(STATE_KEY, step.state);
    const sockets = this.socketsById();
    for (const effect of step.effects) {
      switch (effect.kind) {
        case 'send':
          sockets.get(effect.socketId)?.send(toArrayBuffer(encodeFrame(effect.frame)));
          break;
        case 'close':
          sockets.get(effect.socketId)?.close(effect.code, effect.reason);
          break;
        case 'schedule-alarm':
          await this.objectState.storage.setAlarm(effect.at);
          break;
        case 'verify-claim':
          await this.applyStep(reduceRendezvous(step.state, await this.judgeClaim(step.state, effect)));
          break;
      }
    }
  }

  private async judgeClaim(
    state: RendezvousState,
    effect: Extract<RendezvousStep['effects'][number], { kind: 'verify-claim' }>,
  ): Promise<RendezvousEvent> {
    const at = this.runtime.now();
    const claim = decodeClaim(effect.publicKey, effect.signature);
    if (claim === null) {
      return {
        kind: 'claim-verdict',
        socketId: effect.socketId,
        verdict: { ok: false, reason: 'malformed claim' },
        at,
      };
    }
    const verdict = await verifyRendezvousClaim(
      this.runtime.crypto,
      { daemonId: state.daemonId, relayHost: effect.host, challenge: effect.challenge },
      claim,
    );
    return { kind: 'claim-verdict', socketId: effect.socketId, verdict, at };
  }
}

function attachmentOf(socket: RelaySocket): string | null {
  const attachment = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
  return typeof attachment?.socketId === 'string' ? attachment.socketId : null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
