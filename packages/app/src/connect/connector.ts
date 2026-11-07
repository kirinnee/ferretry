import type { DaemonTransport, TransportAnswer, TransportRequest } from '../client/transport.ts';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import { RelayClientSession, RelayPairingRefusedError, type RelayPairingOutcome } from '../session/session-client.ts';
import { type CarrierDial, SessionTransport } from '../session/session-transport.ts';
import { HEARTBEAT_GRACE_SECONDS, RELAY_CLOSE_CODES, type RelayCrypto } from '../session/wire/index.ts';
import type {
  CarrierDialer,
  DeviceClaims,
  PairDirectInput,
  PairedOver,
  PairingCarriers,
  PairingLeg,
} from './provides.ts';

/**
 * PUTTING A SESSION TOGETHER: Access's claim + Connections' carrier + the shell's sealed session = the transport the
 * generated per-daemon client runs on. Nothing here sends: the client's bootstrap read is still the first call.
 */

/** The shell's direct carrier to one address: a WebSocket to the daemon's own listener (`session/direct-dial.ts`). */
export type DirectDial = (target: { readonly address: string; readonly daemon: string }) => CarrierDial;

export interface ConnectorOptions {
  readonly crypto: RelayCrypto;
  /** Access's claims, or `undefined` when Access is off or not built: then no daemon can be reached yet. */
  readonly claims: DeviceClaims | undefined;
  /** Connections' carriers, lowest `order` first. */
  readonly carriers: readonly CarrierDialer[];
  /**
   * The shell's own direct carrier (a WebSocket to the pairing's address). Used when NO carrier is registered
   * (Connections off or not built), so a device on the daemon's network still reaches it; once Connections registers
   * carriers the choice is wholly Connections'.
   */
  readonly direct: DirectDial;
}

/** The carrier for one daemon: the first registered one that can reach it, else the shell's direct one. */
export function chooseDial(
  daemon: PairedDaemon,
  carriers: readonly CarrierDialer[],
  direct: DirectDial,
): CarrierDial | undefined {
  return chooseCarrier(daemon, carriers, direct)?.dial;
}

/** {@link chooseDial} and the carrier that answered it (`undefined` for the shell's own direct one). */
function chooseCarrier(
  daemon: PairedDaemon,
  carriers: readonly CarrierDialer[],
  direct: DirectDial,
): { readonly dial: CarrierDial; readonly carrier: CarrierDialer | undefined } | undefined {
  if (carriers.length === 0) return { dial: direct(daemon), carrier: undefined };
  for (const carrier of carriers) {
    let dial: CarrierDial | undefined;
    try {
      dial = carrier.dial(daemon);
    } catch {
      dial = undefined;
    }
    if (dial !== undefined) return { dial, carrier };
  }
  return undefined;
}

/** Said when a carrier-control request has neither a direct address nor a relay to travel (today's sentence). */
export const CONTROL_UNREACHABLE =
  'neither this machine’s own address nor a relay reaches it, so its tunnel can only be switched at the machine';

/**
 * THE CARRIER-CONTROL LANE (R634): every request whose path the carrier names as control rides a session of its own,
 * opened through the carrier's introducer-only dial, so `GET`/`PUT /v1/tunnel` never ride the tunnel or WebRTC and the
 * walk that carried them decides nothing. Everything else — requests, the event stream, sockets — rides `main`.
 */
export class ControlLaneTransport implements DaemonTransport {
  #control: SessionTransport | undefined;

  constructor(
    private readonly main: SessionTransport,
    private readonly paths: ReadonlySet<string>,
    private readonly openControl: () => SessionTransport | undefined,
  ) {}

  async request(request: TransportRequest): Promise<TransportAnswer> {
    if (!this.paths.has(request.path)) return await this.main.request(request);
    this.#control ??= this.openControl();
    if (this.#control === undefined) throw new Error(CONTROL_UNREACHABLE);
    return await this.#control.request(request);
  }

  events: DaemonTransport['events'] = (listener, onClose) => this.main.events(listener, onClose);
  socket: DaemonTransport['socket'] = (path, listeners) => this.main.socket(path, listeners);
  onReconnect: DaemonTransport['onReconnect'] = listener => this.main.onReconnect(listener);

  close(): void {
    this.main.close();
    this.#control?.close();
    this.#control = undefined;
  }
}

/**
 * The shell runtime's `connect`: a transport for a paired daemon, or `undefined` when this device cannot open a
 * session to it yet (no claims provider, no key for it, or no carrier that reaches it). The shell then says so.
 */
export function connector(options: ConnectorOptions): (daemon: PairedDaemon) => Promise<DaemonTransport | undefined> {
  return async daemon => {
    if (options.claims === undefined) return undefined;
    const device = await options.claims.claim(daemon);
    if (device === undefined) return undefined;
    const chosen = chooseCarrier(daemon, options.carriers, options.direct);
    if (chosen === undefined) return undefined;
    const main = new SessionTransport({ crypto: options.crypto, daemonId: daemon.daemon, device, dial: chosen.dial });
    const control = chosen.carrier?.control;
    if (control === undefined || control.paths.length === 0) return main;
    return new ControlLaneTransport(main, new Set(control.paths), () => {
      let dial: CarrierDial | undefined;
      try {
        dial = control.dial(daemon);
      } catch {
        dial = undefined;
      }
      return dial === undefined
        ? undefined
        : new SessionTransport({ crypto: options.crypto, daemonId: daemon.daemon, device, dial });
    });
  };
}

/**
 * Opens one `pair` session over the shell's direct carrier and answers its sealed outcome. A refusal inside the
 * channel rejects with `RelayPairingRefusedError` (a result, not a transport failure); the session closes either way.
 */
export function pairOverDirect(
  crypto: RelayCrypto,
  direct: DirectDial,
): (input: PairDirectInput) => Promise<RelayPairingOutcome> {
  return async input => {
    let session: RelayClientSession | undefined;
    const socket = direct({ address: input.address, daemon: input.daemonId })({
      onBinary: bytes => void session?.receiveBinary(bytes),
      onText: text => session?.receiveText(text),
      onClose: (code, reason) => session?.carrierClosed(code, reason),
    });
    session = new RelayClientSession({
      crypto,
      daemonId: input.daemonId,
      mode: {
        kind: 'pair',
        code: input.code,
        deviceName: input.key.deviceName,
        publicKey: input.key.publicKey,
        key: input.key.key,
      },
      socket,
    });
    try {
      return await session.paired();
    } finally {
      session.close('the pairing finished');
    }
  };
}

/**
 * The `pair` record crossed, and the session ended before the daemon's sealed answer did.
 *
 * Not a transport failure in the usual sense: the daemon may have redeemed the code and registered this browser's key
 * with nobody left to hear the answer. The walk still tries the next carrier — the daemon may equally have received
 * nothing — but a refusal that follows THIS is not the whole story, and the caller says so. Copied from today's
 * `relay-pairing.ts`.
 */
export class PairingOutcomeUnknownError extends Error {
  constructor(override readonly cause: unknown) {
    super('the pairing code reached the daemon, but the session ended before its answer arrived');
    this.name = 'PairingOutcomeUnknownError';
  }
}

/**
 * ONE REDEMPTION ATTEMPT OVER ONE LEG (today's `redeemPairingInSession`), answered by the daemon's own sealed outcome.
 *
 * A session that has not settled within the leg's deadline is ended as a heartbeat timeout, so a direct address whose
 * packets are dropped (a private address from cellular) does not hold the walk for the full grace while the code's
 * two minutes run out. The daemon is proved against the QR's fingerprint inside the session before the code is sent,
 * on every leg.
 */
export function pairOnLeg(
  crypto: RelayCrypto,
  after: (delayMs: number, run: () => void) => void,
): (input: PairDirectInput, leg: PairingLeg) => Promise<RelayPairingOutcome> {
  return async (input, leg) => {
    let session: RelayClientSession | undefined;
    const socket = leg.dial({
      onBinary: bytes => void session?.receiveBinary(bytes),
      onText: text => session?.receiveText(text),
      onClose: (code, reason) => session?.carrierClosed(code, reason),
    });
    const opened = new RelayClientSession({
      crypto,
      daemonId: input.daemonId,
      mode: {
        kind: 'pair',
        code: input.code,
        deviceName: input.key.deviceName,
        publicKey: input.key.publicKey,
        key: input.key.key,
      },
      socket,
    });
    session = opened;
    let settled = false;
    after(leg.deadlineMs ?? HEARTBEAT_GRACE_SECONDS * 1_000, () => {
      if (settled) return;
      opened.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
      socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
    });
    try {
      const outcome = await opened.paired();
      settled = true;
      // The daemon ends the session itself (§14), but a socket this side is finished with is a socket this side
      // closes: one left open would hold one of the sessions a rendezvous serves for no reason at all.
      socket.close(1000, 'this pairing attempt is complete');
      return outcome;
    } catch (reason) {
      settled = true;
      socket.close(1000, 'this pairing attempt is over');
      if (reason instanceof RelayPairingRefusedError || !opened.credentialSent()) throw reason;
      throw new PairingOutcomeUnknownError(reason);
    }
  };
}

/**
 * The `pair` port: Connections' walk over {@link pairOnLeg} when it registered one, else one direct attempt over the
 * pairing's address. `walk` is read per call, because the providers are built after the ports they receive.
 */
export function pairOverCarriers(
  crypto: RelayCrypto,
  direct: DirectDial,
  after: (delayMs: number, run: () => void) => void,
  walk: () => PairingCarriers | undefined,
): (input: PairDirectInput) => Promise<PairedOver> {
  const attempt = pairOnLeg(crypto, after);
  return async input => {
    const carriers = walk();
    if (carriers !== undefined) return await carriers.pair(input, leg => attempt(input, leg));
    const outcome = await pairOverDirect(crypto, direct)(input);
    return { ...outcome, via: { kind: 'direct', address: input.address } };
  };
}
