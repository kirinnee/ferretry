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
  bytesEqual,
  decodeClaim,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  type HostedRelayDecision,
  initialRendezvousState,
  NONCE_BYTES,
  parseRelayTenancy,
  parseRendezvousPath,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayCrypto,
  type RendezvousEvent,
  type RendezvousState,
  type RendezvousStep,
  reduceRendezvous,
  SESSION_ID_BYTES,
  servesDaemon,
  sessionIdFromBytes,
  toBase64Url,
  utf8Bytes,
  verifyRendezvousClaim,
} from '../lib/index.ts';
import {
  HOSTED_RELAY_OPERATOR_CONFIG_PATH,
  HOSTED_RELAY_OPERATOR_METRICS_PATH,
  HOSTED_RELAY_PUBLIC_PATH,
  type HostedRelayControlNamespace,
  hostedRelayControlStub,
  releaseHostedRelayReservation,
  requestHostedRelayDecision,
} from './hosted-control.ts';
import { WebCryptoRelayCrypto } from './webcrypto-relay-crypto.ts';

export { HostedRelayControlDurableObject } from './hosted-control.ts';

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
  /** Present only in the centrally operated deployment. Missing keeps the BYO path byte-for-byte. */
  readonly RELAY_MODE?: string;
  /** The singleton runtime configuration, global meter and admission controller. */
  readonly RELAY_CONTROL?: HostedRelayControlNamespace;
  /** Secret binding provisioned by the hosted deployment workflow; never committed or bundled. */
  readonly RELAY_OPERATOR_TOKEN?: string;
}

/** The platform pieces that cannot be reached without the Workers runtime, so they are injected. */
export interface RelayRuntime {
  readonly crypto: RelayCrypto;
  now(): number;
  createSocketPair(): { readonly client: RelaySocket; readonly server: RelaySocket };
  /** Accept the server half in a stateless Worker so a refusal can be explained before close. */
  acceptWebSocket(socket: RelaySocket): void;
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
  acceptWebSocket: socket => (socket as RelaySocket & { accept(): void }).accept(),
  upgradeResponse: (client: RelaySocket) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
  heartbeatPair: () => new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
};

// ─── the stateless front door ─────────────────────────────────────────────────────────────────

const STATE_KEY = 'rendezvous';
const NOT_FOUND = 'not found';
const RESERVATION_HEADER = 'x-ferretry-relay-reservation';

/**
 * Route a socket to its rendezvous, or refuse it cheaply.
 *
 * An unknown fingerprint and a malformed path get the same 404. Distinguishing them would tell a
 * scanner which fingerprints this deployment carries, and the honest answer to "is this daemon
 * here" is one only the daemon's own operator is owed.
 */
export async function relayFetch(
  request: Request,
  environment: RelayEnvironment,
  runtime: RelayRuntime = workersRuntime,
): Promise<Response> {
  const url = new URL(request.url);
  const mode = relayMode(environment);
  if (mode === 'invalid') return jsonError('relay deployment mode is invalid', 503);
  if (mode === 'hosted' && url.pathname === HOSTED_RELAY_PUBLIC_PATH) {
    return hostedPublicConfiguration(request, environment);
  }
  if (
    mode === 'hosted' &&
    (url.pathname === HOSTED_RELAY_OPERATOR_CONFIG_PATH || url.pathname === HOSTED_RELAY_OPERATOR_METRICS_PATH)
  ) {
    return hostedOperatorRequest(request, environment);
  }

  const route = parseRendezvousPath(url.pathname);
  if (route === null) return new Response(NOT_FOUND, { status: 404 });
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426 });
  }
  if (mode === 'hosted') {
    const control = environment.RELAY_CONTROL;
    if (control === undefined) {
      return refusalUpgrade(runtime, internalDecision('hosted relay accounting is unavailable'));
    }
    const reservationId = toBase64Url(runtime.crypto.randomBytes(16));
    const decision = await requestHostedRelayDecision(control, 'reserve', { daemonId: route.daemonId, reservationId });
    if (decision === null) return refusalUpgrade(runtime, internalDecision('hosted relay accounting is unavailable'));
    if (!decision.ok) return refusalUpgrade(runtime, decision);

    const headers = new Headers(request.headers);
    headers.set(RESERVATION_HEADER, reservationId);
    try {
      const response = await environment.RENDEZVOUS.get(
        environment.RENDEZVOUS.idFromName(`${RELAY_PROTOCOL_ID}:${route.daemonId}`),
      ).fetch(new Request(request, { headers }));
      if (response.status === 101) return response;
    } catch {
      // The reservation is released below. The caller still gets an application close frame.
    }
    await releaseHostedRelayReservation(control, reservationId);
    return refusalUpgrade(runtime, internalDecision('hosted relay rendezvous is unavailable'));
  }
  if (!servesDaemon(parseRelayTenancy(environment.RELAY_DAEMON_IDS), route.daemonId)) {
    return new Response(NOT_FOUND, { status: 404 });
  }
  const namespace = environment.RENDEZVOUS;
  return namespace.get(namespace.idFromName(`${RELAY_PROTOCOL_ID}:${route.daemonId}`)).fetch(request);
}

export default { fetch: relayFetch };

type RelayMode = 'self-hosted' | 'hosted' | 'invalid';

function relayMode(environment: RelayEnvironment): RelayMode {
  if (environment.RELAY_MODE === undefined || environment.RELAY_MODE === 'self-hosted') return 'self-hosted';
  return environment.RELAY_MODE === 'hosted' ? 'hosted' : 'invalid';
}

async function hostedPublicConfiguration(request: Request, environment: RelayEnvironment): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  }
  if (request.method !== 'GET') return jsonError('method not allowed', 405, true);
  const control = environment.RELAY_CONTROL;
  if (control === undefined) return jsonError('hosted relay configuration is unavailable', 503, true);
  try {
    return await hostedRelayControlStub(control).fetch(
      new Request('https://relay-control.invalid/public/configuration'),
    );
  } catch {
    return jsonError('hosted relay configuration is unavailable', 503, true);
  }
}

async function hostedOperatorRequest(request: Request, environment: RelayEnvironment): Promise<Response> {
  const token = environment.RELAY_OPERATOR_TOKEN;
  if (token === undefined || token === '') return jsonError('relay operator authentication is not configured', 503);
  const authorization = request.headers.get('Authorization') ?? '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!bytesEqual(utf8Bytes(supplied), utf8Bytes(token))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'WWW-Authenticate': 'Bearer',
      },
    });
  }
  const control = environment.RELAY_CONTROL;
  if (control === undefined) return jsonError('hosted relay control is unavailable', 503);
  const sourcePath = new URL(request.url).pathname;
  const targetPath = sourcePath === HOSTED_RELAY_OPERATOR_CONFIG_PATH ? '/operator/configuration' : '/operator/metrics';
  if (
    (targetPath === '/operator/configuration' && request.method !== 'GET' && request.method !== 'PUT') ||
    (targetPath === '/operator/metrics' && request.method !== 'GET')
  ) {
    return jsonError('method not allowed', 405);
  }
  try {
    return await hostedRelayControlStub(control).fetch(
      new Request(`https://relay-control.invalid${targetPath}`, {
        method: request.method,
        headers: { 'Content-Type': request.headers.get('Content-Type') ?? 'application/json' },
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
      }),
    );
  } catch {
    return jsonError('hosted relay control is unavailable', 503);
  }
}

/** A browser cannot read an HTTP WebSocket rejection, so accept, explain, then close. */
function refusalUpgrade(runtime: RelayRuntime, decision: Exclude<HostedRelayDecision, { ok: true }>): Response {
  const pair = runtime.createSocketPair();
  runtime.acceptWebSocket(pair.server);
  pair.server.send(
    toArrayBuffer(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({ t: 'error', code: decision.code, reason: decision.reason }),
      }),
    ),
  );
  pair.server.close(decision.code, decision.reason);
  return runtime.upgradeResponse(pair.client);
}

function internalDecision(reason: string): Exclude<HostedRelayDecision, { ok: true }> {
  return { ok: false, code: RELAY_CLOSE_CODES.relayInternal, reason };
}

function jsonError(error: string, status: number, publicResponse = false): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...(publicResponse ? { 'Access-Control-Allow-Origin': '*' } : {}),
    },
  });
}

// ─── the durable half ─────────────────────────────────────────────────────────────────────────

interface SocketAttachment {
  readonly socketId: string;
  readonly reservationId?: string;
}

export class RendezvousDurableObject {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly objectState: RelayObjectState,
    private readonly environment: RelayEnvironment,
    private readonly runtime: RelayRuntime = workersRuntime,
  ) {
    // Heartbeats are answered by the runtime itself, so a live-but-idle rendezvous is never woken
    // and never billed for the waiting. Hibernation only pays off if nothing routine wakes it.
    this.objectState.setWebSocketAutoResponse(this.runtime.heartbeatPair());
  }

  async fetch(request: Request): Promise<Response> {
    const route = parseRendezvousPath(new URL(request.url).pathname);
    if (route === null) return new Response(NOT_FOUND, { status: 404 });
    const reservationId = request.headers.get(RESERVATION_HEADER) ?? undefined;
    if (this.isHosted() && reservationId === undefined) {
      return new Response('hosted relay reservation is required', { status: 403 });
    }

    const hadSocketsBefore = this.objectState.getWebSockets().length !== 0;
    const { client, server } = this.runtime.createSocketPair();
    const socketId = toBase64Url(this.runtime.crypto.randomBytes(8));
    server.serializeAttachment({
      socketId,
      ...(reservationId === undefined ? {} : { reservationId }),
    } satisfies SocketAttachment);
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
      const loaded = await this.load();
      if (loaded === null && hadSocketsBefore) {
        await this.refuseSocketClearly(server, RELAY_CLOSE_CODES.relayInternal, 'rendezvous state is lost');
        return;
      }
      const state = loaded ?? initialRendezvousState(route.daemonId);
      if (state.daemonId !== route.daemonId) {
        await this.refuseSocketClearly(server, RELAY_CLOSE_CODES.relayInternal, 'rendezvous belongs to another daemon');
        return;
      }
      await this.applyStep(reduceRendezvous(state, event));
    });
    await this.queue;
    return this.runtime.upgradeResponse(client);
  }

  async webSocketMessage(socket: RelaySocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = attachmentOf(socket);
    if (attachment === null) return this.orphan(socket);
    if (typeof message === 'string') {
      // The auto-responder handles the heartbeat without ever reaching here; anything else in text
      // is a peer speaking a protocol this one does not have.
      return this.closeSocket(socket, RELAY_CLOSE_CODES.protocolError, 'this rendezvous carries binary frames');
    }
    const decoded = decodeFrame(new Uint8Array(message));
    if (!decoded.ok) return this.closeSocket(socket, decoded.code, decoded.reason);
    this.enqueue(async () => {
      const state = await this.load();
      if (state === null) return this.closeSocket(socket, RELAY_CLOSE_CODES.relayInternal, 'rendezvous state is lost');
      const step = reduceRendezvous(state, {
        kind: 'frame',
        socketId: attachment.socketId,
        frame: decoded.frame,
        at: this.runtime.now(),
      });
      const relayedBytes = step.effects.some(effect => effect.kind === 'send' && effect.frame === decoded.frame)
        ? message.byteLength
        : 0;
      const decision = await this.hostedDecision('meter', { daemonId: state.daemonId, bytes: relayedBytes });
      if (!decision.ok) return this.refuseSocketClearly(socket, decision.code, decision.reason);
      await this.applyStep(step);
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
      const decision = await this.hostedDecision('inspect', { daemonId: state.daemonId });
      if (!decision.ok) {
        for (const socket of this.objectState.getWebSockets()) {
          await this.refuseSocketClearly(socket, decision.code, decision.reason);
        }
        return;
      }
      const lastSeen: Record<string, number> = {};
      for (const socket of this.objectState.getWebSockets()) {
        const attachment = attachmentOf(socket);
        if (attachment === null) continue;
        const stamp = this.objectState.getWebSocketAutoResponseTimestamp(socket);
        if (stamp !== null) lastSeen[attachment.socketId] = stamp.getTime();
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
    const attachment = attachmentOf(socket);
    if (attachment === null) return;
    this.enqueue(async () => {
      const state = await this.load();
      if (state === null) return;
      await this.applyStep(
        reduceRendezvous(state, { kind: 'socket-closed', socketId: attachment.socketId, at: this.runtime.now() }),
      );
    });
    await this.queue;
    await this.releaseReservation(attachment.reservationId);
  }

  /** A socket with no attachment is not one this rendezvous ever accepted. It does not get to stay. */
  private async orphan(socket: RelaySocket): Promise<void> {
    await this.closeSocket(socket, RELAY_CLOSE_CODES.relayInternal, 'socket is not attached to this rendezvous');
  }

  /**
   * Close one socket and hand back whatever hosted capacity it was holding.
   *
   * Every close this side initiates goes through here. A hosted reservation is only ever given up by
   * telling the control object, so a refusal that closes a socket and says nothing spends a slot for
   * the lifetime of the deployment — sixteen of those and the daemon they belonged to can never
   * reach the hosted relay again. The attachment is read before the close because the reservation is
   * the only evidence of what to release, and release is idempotent, so a later `webSocketClose` or
   * `webSocketError` callback describing the same socket costs nothing.
   *
   * The release is in a `finally` because a socket the runtime has already torn down can throw on
   * close, and a slot that leaks because the socket was *extra* dead is the same permanent leak.
   */
  private async closeSocket(socket: RelaySocket, code: number, reason: string): Promise<void> {
    const reservationId = attachmentOf(socket)?.reservationId;
    try {
      socket.close(code, reason);
    } finally {
      await this.releaseReservation(reservationId);
    }
  }

  /**
   * Capacity and control-plane refusals are data before they are a close, so a phone can explain them.
   *
   * The explanation is best effort and the close is not. A socket too far gone to hear why it is
   * being closed still has to be closed, and still has to give its reservation back.
   */
  private async refuseSocketClearly(socket: RelaySocket, code: number, reason: string): Promise<void> {
    try {
      socket.send(
        toArrayBuffer(
          encodeFrame({
            kind: FRAME_KINDS.control,
            sessionId: RENDEZVOUS_SESSION_ID,
            sequence: 0,
            payload: encodeControlMessage({ t: 'error', code, reason }),
          }),
        ),
      );
    } catch {
      // Undeliverable is not the same as unaccounted. The close and the release happen either way.
    }
    await this.closeSocket(socket, code, reason);
  }

  private isHosted(): boolean {
    return this.environment.RELAY_MODE === 'hosted';
  }

  private async hostedDecision(path: 'meter' | 'inspect', input: unknown): Promise<HostedRelayDecision> {
    if (!this.isHosted()) return { ok: true };
    const control = this.environment.RELAY_CONTROL;
    if (control === undefined) return internalDecision('hosted relay accounting is unavailable');
    return (
      (await requestHostedRelayDecision(control, path, input)) ??
      internalDecision('hosted relay accounting is unavailable')
    );
  }

  private async releaseReservation(reservationId: string | undefined): Promise<void> {
    if (!this.isHosted() || reservationId === undefined) return;
    const control = this.environment.RELAY_CONTROL;
    if (control !== undefined) await releaseHostedRelayReservation(control, reservationId);
  }

  private socketsById(): Map<string, RelaySocket> {
    const sockets = new Map<string, RelaySocket>();
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment !== null) sockets.set(attachment.socketId, socket);
    }
    return sockets;
  }

  /**
   * Carry out one transition, attempting every effect before reporting any failure.
   *
   * A refusal is two effects — say why, then close — and the close is the one that gives a hosted
   * reservation back. Letting a throwing effect abandon the rest of the list meant a socket too far
   * gone to be told why it was being refused kept its slot forever. So each effect is attempted on
   * its own and the first failure is raised once the others have had their turn: nothing is
   * swallowed, and a genuine forwarding failure is still an error, just not one that also costs the
   * caller its accounting.
   */
  private async applyStep(step: RendezvousStep): Promise<void> {
    await this.objectState.storage.put(STATE_KEY, step.state);
    const sockets = this.socketsById();
    const failures: unknown[] = [];
    for (const effect of step.effects) {
      try {
        switch (effect.kind) {
          case 'send':
            sockets.get(effect.socketId)?.send(toArrayBuffer(encodeFrame(effect.frame)));
            break;
          case 'close': {
            // A state-machine refusal is still a socket this side closed, so it releases like any other.
            const closing = sockets.get(effect.socketId);
            if (closing !== undefined) await this.closeSocket(closing, effect.code, effect.reason);
            break;
          }
          case 'schedule-alarm':
            await this.objectState.storage.setAlarm(effect.at);
            break;
          case 'verify-claim':
            await this.applyStep(reduceRendezvous(step.state, await this.judgeClaim(step.state, effect)));
            break;
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length !== 0) throw failures[0];
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

function attachmentOf(socket: RelaySocket): SocketAttachment | null {
  const attachment = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
  if (typeof attachment?.socketId !== 'string') return null;
  if (attachment.reservationId !== undefined && typeof attachment.reservationId !== 'string') return null;
  return {
    socketId: attachment.socketId,
    ...(attachment.reservationId === undefined ? {} : { reservationId: attachment.reservationId }),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
