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
  type AttachedSocket,
  decodeClaim,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  HEARTBEAT_SECONDS,
  type HostedRelayDecision,
  initialRendezvousState,
  isClaimProbe,
  HANDOVER_TOKEN_BYTES,
  NONCE_BYTES,
  parseRelayTenancy,
  parseRendezvousPath,
  RELAY_CLOSE_CODES,
  RELAY_FEATURES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayCrypto,
  type RelayFeature,
  type RendezvousEvent,
  type RendezvousState,
  type RendezvousStep,
  reconcileRendezvous,
  reduceRendezvous,
  requestedRelayFeatures,
  SESSION_ID_BYTES,
  servesDaemon,
  sessionIdFromBytes,
  toBase64Url,
  verifyRendezvousClaim,
} from '../lib/index.ts';
import {
  HOSTED_RELAY_OPERATOR_CONFIG_PATH,
  HOSTED_RELAY_OPERATOR_METRICS_PATH,
  HOSTED_RELAY_PUBLIC_PATH,
  type HostedRelayControlNamespace,
  hostedRelayControlStub,
  reconcileHostedRelayReservations,
  releaseHostedRelayReservation,
  requestHostedRelayDecision,
} from './hosted-control.ts';
import { hostedTunnelFetch, isHostedTunnelPath } from './hosted-tunnel-routes.ts';
import { operatorRefusal } from './operator-auth.ts';
import { WebCryptoRelayCrypto } from './webcrypto-relay-crypto.ts';

export { HostedRelayControlDurableObject } from './hosted-control.ts';
export { HostedTunnelControlDurableObject } from './hosted-tunnel-control.ts';

// ─── the slice of the Workers runtime this adapter uses ───────────────────────────────────────

export interface RelaySocket {
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The one write option this adapter uses — the Workers runtime's own name for it. */
export interface RelayStoragePutOptions {
  /**
   * Let outgoing messages leave before this write is confirmed durable. Without it the runtime's
   * OUTPUT GATE holds every message the object sends after the write until the write is confirmed.
   */
  readonly allowUnconfirmed?: boolean;
}

export interface RelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T, options?: RelayStoragePutOptions): Promise<void>;
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
  /**
   * The hosted tunnel provisioner (§15): one control object holding every tunnel row, separate from the
   * relay meter. Absent, the tunnel service advertises `available: false` and refuses the rest.
   */
  readonly TUNNEL_CONTROL?: HostedRelayControlNamespace;
  /**
   * The tunnel pool, a Worker SECRET installed from the GitHub secret `HOSTED_TUNNEL_ACCOUNTS`. Only the
   * tunnel control object reads it; it is listed here so the shape of the environment is stated once.
   */
  readonly TUNNEL_ACCOUNTS?: string;
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
 * How long live sessions outlast a hosted control object that cannot be REACHED.
 *
 * Unreachable is not a refusal. The control object is one global Durable Object, and a call to it can
 * fail for reasons that say nothing about any ceiling — it restarted, it was briefly overloaded, the
 * request was lost between colos. Treating every such blip as "refuse" closed every socket on the
 * rendezvous, the daemon's and every phone's, at a random moment with no deploy and no ceiling
 * crossed: exactly the "keeps disconnecting" the owner reported. So a live rendezvous keeps carrying
 * while the meter is unreachable, re-queues the bytes it could not report, and asks again at the next
 * frame or sweep. A definitive answer — the kill switch, a ceiling — still closes at once, and an
 * outage longer than this still fails closed, so nothing degrades into an unmetered path for long:
 * at most this window of traffic, which the credit window already bounds per session.
 *
 * In memory, deliberately: an evicted object forgets an outage it was tolerating and starts the window
 * again, which can only extend tolerance by one window per eviction, and a hibernating object carries
 * no traffic to meter.
 */
export const HOSTED_CONTROL_OUTAGE_GRACE_MS = 120_000;

/**
 * How often a live rendezvous tells the control object which reservations its sockets still carry.
 *
 * That report is what keeps a reservation leased (§13, "Reservations are leases"): the control object
 * reclaims one nobody renewed for `HOSTED_RELAY_RESERVATION_LEASE_MILLISECONDS`, and reclaims at once
 * any of this daemon's that the report shows no socket holds. The heartbeat sweep runs every
 * `HEARTBEAT_SECONDS`; renewing on every sweep would put a full reservation listing on the one global
 * object twice a minute per rendezvous, so it is spaced out here — ten renewals fit inside one lease.
 * In memory: an evicted object renews on its first sweep, which only makes the lease fresher.
 */
export const HOSTED_RESERVATION_RENEW_MS = 60_000;

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
  if (mode === 'hosted' && isHostedTunnelPath(url.pathname)) return hostedTunnelFetch(request, environment);

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
    /**
     * Reserve, and treat a missing answer as unknown rather than as a refusal.
     *
     * A Durable Object call that fails after the callee committed looks identical to one that never
     * landed, and the identifier minted here is the only thing that could ever release the slot the
     * first attempt may have taken. Nothing else can: the rendezvous never saw the header, so no close,
     * error or alarm covers it, and no reaper expires it. So ask again with the *same* identifier —
     * an existing reservation for this daemon is the control object's own proof that the first attempt
     * was admitted, and it answers yes without counting anything twice.
     */
    const reservationId = toBase64Url(runtime.crypto.randomBytes(16));
    const reserve = () => requestHostedRelayDecision(control, 'reserve', { daemonId: route.daemonId, reservationId });
    const decision = (await reserve()) ?? (await reserve());
    if (decision === null) {
      // Still unknown after the retry. Hand back whatever either attempt may have committed before
      // refusing, since release is a no-op on a reservation that was never written.
      await releaseHostedRelayReservation(control, reservationId);
      return refusalUpgrade(runtime, internalDecision('hosted relay accounting is unavailable'));
    }
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

/**
 * THE WORKERS ENTRY, AND THE ONLY PLACE THE PLATFORM'S ARGUMENTS MEET OURS.
 *
 * Workers calls `fetch(request, env, ctx)`. Exporting `relayFetch` itself handed `ctx` — an
 * `ExecutionContext` — to the `runtime` parameter, so every hosted upgrade read
 * `ctx.crypto.randomBytes` and threw before doing any work: 1101 on every rendezvous, for daemon and
 * browser alike, while discovery kept answering 200 and advertising a relay nobody could reach. The
 * suites called the export with two arguments and never saw it. So the entry takes exactly the two
 * values it means and nothing positional the platform adds can reach `runtime`.
 *
 * And it FAILS SAFE: an exception that escapes the router is answered with a typed, no-store JSON
 * error and logged, rather than surfacing as Cloudflare's bare 1101 page that tells an operator
 * nothing and a client less.
 */
async function relayWorkerFetch(request: Request, environment: RelayEnvironment): Promise<Response> {
  try {
    return await relayFetch(request, environment);
  } catch (reason) {
    console.error('relay worker failed unexpectedly', reason);
    return jsonError('relay worker failed unexpectedly', 500);
  }
}

export default { fetch: relayWorkerFetch };

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
  const refused = operatorRefusal(request, environment.RELAY_OPERATOR_TOKEN);
  if (refused !== null) return refused;
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
  /**
   * THE CLAIM, WRITTEN ON THE SOCKET THAT HOLDS IT.
   *
   * Present exactly while this socket is the proved daemon: set when the slot is handed to it and
   * erased before this side closes it or hears it has gone. An attachment lives with the socket through
   * hibernation and eviction, so it is the evidence {@link reconcileRendezvous} restores a claim from
   * when the stored state no longer names one.
   */
  readonly claim?: { readonly features?: readonly RelayFeature[]; readonly handover?: string };
}

/** Frames this rendezvous forwarded that the hosted meter has not been told about yet. */
interface UnmeteredBatch {
  daemonId: string;
  bytes: number;
  events: number;
}

export class RendezvousDurableObject {
  private queue: Promise<void> = Promise.resolve();
  /**
   * THE HOSTED METER IS NEVER ON A FRAME'S PATH.
   *
   * It used to be: every frame waited for a transactional round trip to the ONE global control object
   * before it was forwarded, and the per-rendezvous queue made every later frame wait behind it. The
   * control object lives wherever it was first created, so a rendezvous in Tokyo paid a Pacific round
   * trip per frame, serially — a page load's hundred frames became seconds, and a terminal redrawing
   * ten times a second outran the queue for good.
   *
   * Now a frame is forwarded first and counted here; at most ONE report is in flight per rendezvous,
   * and everything forwarded while it travels goes in the next one. So the meter costs a round trip
   * per round trip instead of per frame, and a refusal lands within one report's round trip of the
   * bytes that crossed a ceiling (§13 states that overshoot). A pending report is outstanding I/O, so
   * the object is not hibernated with bytes still uncounted.
   */
  private unmetered: UnmeteredBatch | undefined;
  private metering: Promise<void> | undefined;
  /** When the hosted control object first stopped answering, or nothing while it answers. */
  private controlUnreachableSince: number | undefined;
  /** When this rendezvous last reported its live reservations, or nothing since it was loaded. */
  private reservationsRenewedAt: number | undefined;

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
    const url = new URL(request.url);
    const route = parseRendezvousPath(url.pathname);
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
    const features = route.role === 'daemon' ? requestedRelayFeatures(url.searchParams) : [];
    const event: RendezvousEvent =
      route.role === 'daemon'
        ? {
            kind: 'daemon-arrived',
            socketId,
            challenge: this.runtime.crypto.randomBytes(NONCE_BYTES),
            host: url.host,
            features,
            ...(features.includes('claim-handover')
              ? { handover: toBase64Url(this.runtime.crypto.randomBytes(HANDOVER_TOKEN_BYTES)) }
              : {}),
            at,
          }
        : { kind: 'client-arrived', socketId, sessionId: this.newSessionId(), at };

    this.enqueue(async () => {
      const loaded = await this.load();
      if (loaded === null && hadSocketsBefore) {
        await this.refuseSocketClearly(server, RELAY_CLOSE_CODES.relayInternal, 'rendezvous state is lost');
        return;
      }
      const stored = loaded ?? initialRendezvousState(route.daemonId);
      if (stored.daemonId !== route.daemonId) {
        await this.refuseSocketClearly(server, RELAY_CLOSE_CODES.relayInternal, 'rendezvous belongs to another daemon');
        return;
      }
      // Before the arrival is judged: a phone must never be told `4404` by a document that forgot a
      // daemon whose socket is right here.
      const state = await this.reconciled(stored);
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
      const stored = await this.load();
      if (stored === null) return this.closeSocket(socket, RELAY_CLOSE_CODES.relayInternal, 'rendezvous state is lost');
      const state = await this.reconciled(stored);
      const step = reduceRendezvous(state, {
        kind: 'frame',
        socketId: attachment.socketId,
        frame: decoded.frame,
        at: this.runtime.now(),
      });
      const relayedBytes = step.effects.some(effect => effect.kind === 'send' && effect.frame === decoded.frame)
        ? message.byteLength
        : 0;
      await this.applyStep(step, state);
      // A probe is the rendezvous talking to itself about the slot; it carries nobody's traffic.
      if (!isClaimProbe(decoded.frame)) this.meter(state.daemonId, relayedBytes);
    });
    await this.queue;
  }

  /** Settles once every frame forwarded so far has been reported to the hosted meter. */
  async metered(): Promise<void> {
    while (this.metering !== undefined) await this.metering;
  }

  private meter(daemonId: string, bytes: number): void {
    if (!this.isHosted()) return;
    const batch = this.unmetered ?? { daemonId, bytes: 0, events: 0 };
    batch.bytes += bytes;
    batch.events += 1;
    this.unmetered = batch;
    this.startMeterReport();
  }

  /**
   * One report in flight at most; a batch that arrived as the last one settled starts the next. A report
   * the meter could not take is NOT restarted from here — that would ask an unreachable object in a
   * tight loop — but by the next forwarded frame or the next sweep.
   */
  private startMeterReport(): void {
    if (this.metering !== undefined || this.unmetered === undefined) return;
    this.metering = this.reportMeter().then(reported => {
      this.metering = undefined;
      if (reported) this.startMeterReport();
    });
  }

  /**
   * Report batches until nothing is left unreported. A refusal — a ceiling crossed, the switch off, or a
   * meter unreachable for longer than {@link HOSTED_CONTROL_OUTAGE_GRACE_MS} — closes every socket this
   * rendezvous holds, each told why first: a ceiling is per daemon and this object serves exactly one.
   * A meter that is merely unreachable gets the batch back, folded into whatever arrives next, and is
   * asked again by the next frame or sweep rather than in a loop. It never throws; a failure here has
   * no caller left to hear it.
   */
  private async reportMeter(): Promise<boolean> {
    for (let batch = this.unmetered; batch !== undefined; batch = this.unmetered) {
      this.unmetered = undefined;
      const decision = await this.hostedVerdict('meter', {
        daemonId: batch.daemonId,
        bytes: batch.bytes,
        ...(batch.events === 1 ? {} : { events: batch.events }),
      });
      if (decision === 'tolerated') {
        const later = this.unmetered as UnmeteredBatch | undefined;
        this.unmetered = {
          daemonId: batch.daemonId,
          bytes: batch.bytes + (later?.bytes ?? 0),
          events: batch.events + (later?.events ?? 0),
        };
        return false;
      }
      if (decision.ok) continue;
      this.unmetered = undefined;
      this.enqueue(async () => {
        for (const socket of this.objectState.getWebSockets()) {
          // One socket too far gone to close must not shield the rest; its reservation is already back
          // (`closeSocket` releases in a `finally`), and the failure is still said out loud.
          await this.refuseSocketClearly(socket, decision.code, decision.reason).catch((error: unknown) => {
            console.error('relay meter refusal could not close a socket', error);
          });
        }
      });
      await this.queue.catch(() => undefined);
      return false;
    }
    return true;
  }

  async webSocketClose(socket: RelaySocket): Promise<void> {
    await this.departed(socket);
  }

  async webSocketError(socket: RelaySocket): Promise<void> {
    await this.departed(socket);
  }

  async alarm(): Promise<void> {
    this.enqueue(async () => {
      const stored = await this.load();
      if (stored === null) return;
      const state = await this.reconciled(stored);
      // A batch the meter could not take is offered again on every sweep, so an idle rendezvous that
      // stopped forwarding still settles its count — or reaches the outage bound — on schedule.
      this.startMeterReport();
      const decision = await this.hostedVerdict('inspect', { daemonId: state.daemonId });
      // Unreachable inside the grace window: no verdict to apply, so the heartbeat sweep below runs as
      // if the control object had answered yes. Skipping it would let dead sockets outlive the outage.
      if (decision !== 'tolerated' && !decision.ok) {
        const failures: unknown[] = [];
        for (const socket of this.objectState.getWebSockets()) {
          try {
            await this.refuseSocketClearly(socket, decision.code, decision.reason);
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          // A socket the runtime already tore down may reject close. Keep the sweep alive so one
          // such socket cannot shield every idle socket after it from the kill switch forever.
          await this.objectState.storage.setAlarm(this.runtime.now() + HEARTBEAT_SECONDS * 1_000);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length !== 0) throw failures[0];
        return;
      }
      const lastSeen: Record<string, number> = {};
      for (const socket of this.objectState.getWebSockets()) {
        const attachment = attachmentOf(socket);
        if (attachment === null) continue;
        const stamp = this.objectState.getWebSocketAutoResponseTimestamp(socket);
        if (stamp !== null) lastSeen[attachment.socketId] = stamp.getTime();
      }
      try {
        await this.applyStep(reduceRendezvous(state, { kind: 'alarm', at: this.runtime.now(), lastSeen }));
      } finally {
        // After the sweep, so the sockets it evicted have already given their reservations back, and in a
        // `finally` because a sweep whose peer effect threw still holds whatever sockets it holds.
        await this.renewReservations(state.daemonId);
      }
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
    // The runtime may still list a socket whose close or error it is reporting, and a claim left on it
    // would be restored by the next reconciliation: a departed daemon reinstated as a ghost.
    markClaim(socket, attachment, undefined);
    this.enqueue(async () => {
      const state = await this.load();
      if (state === null) return;
      await this.applyStep(
        reduceRendezvous(state, { kind: 'socket-closed', socketId: attachment.socketId, at: this.runtime.now() }),
      );
    });
    try {
      await this.queue;
    } finally {
      // The transition tells the peer and that effect can throw when both ends died together. The
      // departing socket's own reservation is independent evidence and must go back either way.
      await this.releaseReservation(attachment.reservationId);
    }
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
    const attachment = attachmentOf(socket);
    const reservationId = attachment?.reservationId;
    // A socket this side is closing holds nothing from now on, whatever the close handshake still owes.
    if (attachment?.claim !== undefined) markClaim(socket, attachment, undefined);
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

  /**
   * The control object's verdict on a live rendezvous, or `tolerated` while it cannot be reached.
   *
   * A missing or unusable answer is asked for once more, as §13 does for every control operation, and
   * only then counts as unreachable. Unreachable is tolerated for {@link HOSTED_CONTROL_OUTAGE_GRACE_MS}
   * from the first failure and becomes a refusal after it; any real answer ends the outage. A missing
   * binding is not an outage — it is a deployment that can never meter — so it refuses at once.
   */
  private async hostedVerdict(path: 'meter' | 'inspect', input: unknown): Promise<HostedRelayDecision | 'tolerated'> {
    if (!this.isHosted()) return { ok: true };
    const control = this.environment.RELAY_CONTROL;
    if (control === undefined) return internalDecision('hosted relay accounting is unavailable');
    const answer =
      (await requestHostedRelayDecision(control, path, input)) ??
      (await requestHostedRelayDecision(control, path, input));
    if (answer !== null) {
      this.controlUnreachableSince = undefined;
      return answer;
    }
    const now = this.runtime.now();
    this.controlUnreachableSince ??= now;
    if (now - this.controlUnreachableSince < HOSTED_CONTROL_OUTAGE_GRACE_MS) return 'tolerated';
    return internalDecision('hosted relay accounting is unavailable');
  }

  /**
   * Report the reservations this rendezvous's sockets carry, at most once per {@link HOSTED_RESERVATION_RENEW_MS}.
   *
   * The runtime's socket list is the only evidence anywhere of which reservations are still held: it
   * includes hibernating sockets, and it drops sockets the runtime lost without ever calling
   * `webSocketClose` — the case that leaked a daemon's whole per-daemon ceiling in 2026-10. Never
   * throws: a report the control object did not take is retried on a later sweep, and the lease
   * outlasts many missed ones.
   */
  private async renewReservations(daemonId: string): Promise<void> {
    if (!this.isHosted()) return;
    const control = this.environment.RELAY_CONTROL;
    if (control === undefined) return;
    const now = this.runtime.now();
    if (this.reservationsRenewedAt !== undefined && now - this.reservationsRenewedAt < HOSTED_RESERVATION_RENEW_MS) {
      return;
    }
    const live: string[] = [];
    for (const socket of this.objectState.getWebSockets()) {
      const reservationId = attachmentOf(socket)?.reservationId;
      if (reservationId !== undefined) live.push(reservationId);
    }
    const answer = await reconcileHostedRelayReservations(control, daemonId, live);
    if (answer === null) {
      console.warn('relay rendezvous could not renew its reservations; retrying on a later sweep');
      return;
    }
    this.reservationsRenewedAt = now;
  }

  private async releaseReservation(reservationId: string | undefined): Promise<void> {
    if (!this.isHosted() || reservationId === undefined) return;
    const control = this.environment.RELAY_CONTROL;
    if (control !== undefined) await releaseHostedRelayReservation(control, reservationId);
  }

  /** Write the claim onto the socket the stored state names as holder, once, as soon as it is named. */
  private markHolder(state: RendezvousState, sockets: Map<string, RelaySocket>): void {
    if (state.daemon === null) return;
    const holder = sockets.get(state.daemon.socketId);
    const attachment = holder === undefined ? null : attachmentOf(holder);
    if (holder === undefined || attachment === null || attachment.claim !== undefined) return;
    markClaim(holder, attachment, {
      ...(state.daemon.features === undefined ? {} : { features: state.daemon.features }),
      ...(state.daemon.handover === undefined ? {} : { handover: state.daemon.handover }),
    });
  }

  /**
   * The stored state, corrected against the sockets the runtime actually holds — and stored again, with
   * its effects carried out, whenever the two disagreed. See {@link reconcileRendezvous}.
   */
  private async reconciled(state: RendezvousState): Promise<RendezvousState> {
    const attached: AttachedSocket[] = [];
    for (const socket of this.objectState.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment === null) continue;
      attached.push({
        socketId: attachment.socketId,
        ...(attachment.claim === undefined ? {} : { claim: attachment.claim }),
      });
    }
    const step = reconcileRendezvous(state, attached, this.runtime.now());
    if (step === null) return state;
    if (step.state.daemon?.restored === true && state.daemon?.socketId !== step.state.daemon.socketId) {
      console.warn('relay rendezvous restored a daemon claim its stored state had lost');
    }
    await this.applyStep(step);
    return step.state;
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
   *
   * THE WRITE IS WHAT A RELAYED FRAME WAITED FOR. Every forwarded frame moves a credit window, and the
   * Workers runtime holds a message an object sends after a storage write until that write is confirmed
   * durable — so every keystroke and every redraw used to cross the rendezvous only after a durable
   * write had been confirmed. A step that changed nothing but a window (`windowOnly`) is therefore
   * written `allowUnconfirmed`: the frame leaves at once and the counter is persisted behind it. What
   * that gives up is stated in `docs/relay-protocol.md` §9 ("Forwarding does not wait for the
   * write"): if the runtime fails to confirm such a write it resets the object, and a session that
   * outlives the reset holding counters older than its traffic is ended (`4430`) by the first frame
   * the restored window disagrees with. Nothing about the end-to-end channel depends on the counters.
   * Every step that admits, ends or reshapes anything is still written confirmed, and a step that
   * changed nothing at all — `unchangedFrom` is the state it was reduced from — is not written.
   */
  private async applyStep(step: RendezvousStep, unchangedFrom?: RendezvousState): Promise<void> {
    if (step.windowOnly === true) await this.objectState.storage.put(STATE_KEY, step.state, { allowUnconfirmed: true });
    else if (step.state !== unchangedFrom) await this.objectState.storage.put(STATE_KEY, step.state);
    const sockets = this.socketsById();
    this.markHolder(step.state, sockets);
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
    ...(attachment.claim === undefined ? {} : { claim: claimOf(attachment.claim) }),
  };
}

/** A claim marker read back from storage the runtime owns: only features this version speaks survive. */
function claimOf(value: unknown): NonNullable<SocketAttachment['claim']> {
  const { features, handover } = (value ?? {}) as { features?: unknown; handover?: unknown };
  const known = Array.isArray(features) ? RELAY_FEATURES.filter(feature => features.includes(feature)) : [];
  const token = typeof handover === 'string' && HANDOVER_TOKEN_PATTERN.test(handover) ? handover : undefined;
  return {
    ...(known.length === 0 ? {} : { features: known }),
    ...(token === undefined ? {} : { handover: token }),
  };
}

/** The shape of a token this relay minted; anything else in a stored marker is dropped, not trusted. */
const HANDOVER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Rewrite one socket's claim marker. A socket the runtime already tore down may refuse; it holds nothing. */
function markClaim(socket: RelaySocket, attachment: SocketAttachment, claim: SocketAttachment['claim']): void {
  const { claim: _previous, ...rest } = attachment;
  try {
    socket.serializeAttachment(claim === undefined ? rest : { ...rest, claim });
  } catch {
    // Nothing to mark on a socket that is gone, and reconciliation only reads sockets that are not.
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
