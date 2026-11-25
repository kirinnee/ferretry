import type { ApiHeaders } from '../http.ts';
import type { CarrierKey } from '../ids.ts';

/** What a carrier listener serves: one declared socket route, and how its arrivals are told apart. */
export interface CarrierListenerSurface {
  /** The plugin's declared socket, spelled as its manifest spells it: `GET /v1/rendezvous/:daemonId/client`. */
  readonly socket: string;
  /** Also serve allow-listed public HTTP routes, stamped remote and credential-less; never a daemon API route. */
  readonly doors?: true;
  /**
   * The rate-limit identity of one arrival, from its headers (the tunnel keys by the address its edge saw). It names
   * a bucket and nothing else: it can never make an arrival local. Absent: one shared identity for the listener.
   */
  readonly peer?: (headers: ApiHeaders) => string;
  /**
   * The browser origins an upgrade may present (today's `corsOrigins`). An upgrade whose `Origin` names another site is
   * answered 404 before admission, like every path this listener does not serve; an absent `Origin`, or the listener's
   * own, is not a browser cross-origin and passes. Absent: no origin gate.
   */
  readonly origins?: readonly string[];
}

/** A bound carrier listener. */
export interface CarrierListenerHandle {
  /** The ephemeral loopback port (127.0.0.1) the carrier's forwarder is pointed at. */
  readonly port: number;
  /** Frees the port. Idempotent; a daemon stop closes every listener still open. */
  close(): Promise<void>;
}

/**
 * A second loopback listener for a carrier that arrives through a local forwarder (§15). A forwarder on this host
 * makes everything it carries come from a loopback peer, so pointing it at the API listener would make a phone beyond
 * the far edge indistinguishable from a browser at the machine. This listener is the other wall: it serves only the
 * declared route (404 to every other path and method; nothing else of the daemon is reachable) and stamps EVERY arrival
 * `{ kind: 'carried', carrier }`, never local (G15, G16): admission governs it as remote.
 */
export interface CarrierListenerPort {
  open(input: {
    readonly carrier: CarrierKey;
    readonly surface: CarrierListenerSurface;
  }): Promise<CarrierListenerHandle>;
}
