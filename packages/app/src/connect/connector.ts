import type { DaemonTransport } from '../client/transport.ts';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import { RelayClientSession, type RelayPairingOutcome } from '../session/session-client.ts';
import { type CarrierDial, SessionTransport } from '../session/session-transport.ts';
import type { RelayCrypto } from '../session/wire/index.ts';
import type { CarrierDialer, DeviceClaims, PairDirectInput } from './provides.ts';

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
  if (carriers.length === 0) return direct(daemon);
  for (const carrier of carriers) {
    let dial: CarrierDial | undefined;
    try {
      dial = carrier.dial(daemon);
    } catch {
      dial = undefined;
    }
    if (dial !== undefined) return dial;
  }
  return undefined;
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
    const dial = chooseDial(daemon, options.carriers, options.direct);
    if (dial === undefined) return undefined;
    return new SessionTransport({ crypto: options.crypto, daemonId: daemon.daemon, device, dial });
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
      const outcome = await session.paired();
      // P28: a refused or unreachable attempt never asks Access to persist the fresh key.
      await input.key.save(outcome.response);
      return outcome;
    } finally {
      session.close('the pairing finished');
    }
  };
}
