/**
 * EACH MACHINE'S TUNNEL SWITCH, AS THIS DEVICE KNOWS IT — `docs/relay-protocol.md` §15 "The daemon end".
 *
 * A machine runs a Cloudflare tunnel only when somebody turned one on for it (opt-in), so choosing
 * "Tunnel only" — or Auto, which includes the tunnel — for a machine whose tunnel is off is the moment to
 * offer it. This is the browser's half of `GET`/`PUT /v1/tunnel`: what the daemon last said about its
 * tunnel, and the one write that switches it.
 *
 * THESE REQUESTS ARE CARRIER CONTROL, so they ride `DaemonCarrierRouter.control` — the daemon's direct
 * address or a rendezvous, whatever this device's preference is. Under "Tunnel only" with the tunnel off
 * nothing else could carry the request that turns it on.
 *
 * ONE FAILED READ NEVER FORGETS AN ANSWER. A read that fails leaves the last known state where it was;
 * only the daemon saying something different replaces it.
 */

import {
  FY_REQUEST_ID_HEADER,
  TUNNEL_PATH,
  TunnelChangeSchema,
  type TunnelStatusView,
  TunnelStatusViewSchema,
} from '@ferretry/protocol';
import { type DaemonConnection, type DaemonId, daemonTunnelCarrier, type TunnelCarrier } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { DaemonResponseError } from './runtime-models.ts';

/** What this device knows about one machine's tunnel. */
export type TunnelSwitchState =
  /** Not asked yet, or never answered. */
  | { readonly kind: 'unknown' }
  /** A daemon older than the switch (`404`): its tunnel was never opt-in, so there is nothing to offer. */
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'known'; readonly view: TunnelStatusView };

const UNKNOWN: TunnelSwitchState = Object.freeze({ kind: 'unknown' });
const UNSUPPORTED: TunnelSwitchState = Object.freeze({ kind: 'unsupported' });

/** One carrier-control request, as `DaemonCarrierRouter.control` sends it. */
export type TunnelControl = (daemon: DaemonConnection, url: string, init: RequestInit) => Promise<Response>;

export interface TunnelSwitchStoreOptions {
  readonly control: TunnelControl;
  /** Told every view the daemon answered, so the paired record can keep its tunnel in step. */
  readonly observed?: (daemon: DaemonConnection, view: TunnelStatusView) => void;
}

/** The daemon's refusal, in its own words when it gave any. */
const refusal = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

export class TunnelSwitchStore {
  #states: Readonly<Record<string, TunnelSwitchState>> = {};
  readonly #listeners = new Set<() => void>();
  readonly #control: TunnelControl;
  readonly #observed: NonNullable<TunnelSwitchStoreOptions['observed']>;

  constructor(options: TunnelSwitchStoreOptions) {
    this.#control = options.control;
    this.#observed = options.observed ?? (() => undefined);
  }

  /** Every machine's state, replaced as a whole on each change — a `useSyncExternalStore` snapshot. */
  readonly snapshot = (): Readonly<Record<string, TunnelSwitchState>> => this.#states;

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  state(daemonId: DaemonId): TunnelSwitchState {
    return this.#states[daemonId] ?? UNKNOWN;
  }

  /** Asks the daemon. Never throws: a read that fails keeps whatever was known before it. */
  async refresh(daemon: DaemonConnection): Promise<TunnelSwitchState> {
    try {
      const request = daemonRequest(daemon, TUNNEL_PATH, { cache: 'no-store' });
      const response = await this.#control(daemon, request.url, request.init);
      if (response.status === 404) return this.#publish(daemon.daemonId, UNSUPPORTED);
      if (!response.ok) return this.state(daemon.daemonId);
      const view = TunnelStatusViewSchema.safeParse(await response.json().catch(() => undefined));
      if (!view.success) return this.state(daemon.daemonId);
      return this.#known(daemon, view.data);
    } catch {
      return this.state(daemon.daemonId);
    }
  }

  /** Switches the machine's tunnel. Rejects with the daemon's refusal — its own sentence — when it gives one. */
  async set(daemon: DaemonConnection, enabled: boolean): Promise<TunnelStatusView> {
    const request = daemonRequest(daemon, TUNNEL_PATH, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
      body: JSON.stringify(TunnelChangeSchema.parse({ enabled })),
    });
    const response = await this.#control(daemon, request.url, request.init);
    if (!response.ok) throw await refusal(response);
    const view = TunnelStatusViewSchema.safeParse(await response.json().catch(() => undefined));
    if (!view.success) throw new DaemonResponseError(502, 'the daemon answered the tunnel switch with no status');
    this.#known(daemon, view.data);
    return view.data;
  }

  #known(daemon: DaemonConnection, view: TunnelStatusView): TunnelSwitchState {
    this.#observed(daemon, view);
    return this.#publish(daemon.daemonId, { kind: 'known', view });
  }

  #publish(daemonId: DaemonId, state: TunnelSwitchState): TunnelSwitchState {
    this.#states = { ...this.#states, [daemonId]: state };
    for (const listener of this.#listeners) listener();
    return state;
  }
}

/**
 * What a daemon's answer means for the tunnel this device keeps: a tunnel to keep, `null` to forget it,
 * or `undefined` to leave it as it is. Off and unable-to-run are the two answers that mean "gone";
 * provisioning and connecting say a tunnel is coming or coming back, which is no reason to drop one.
 */
export const keptTunnel = (view: TunnelStatusView): TunnelCarrier | null | undefined => {
  if (view.state === 'off' || view.state === 'unavailable') return null;
  if (view.state !== 'up' || view.tunnelUrl === null) return undefined;
  return daemonTunnelCarrier({ kind: 'tunnel', tunnelUrl: view.tunnelUrl });
};
