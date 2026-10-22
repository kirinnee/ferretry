/**
 * TURNING THE TUNNEL ON AND OFF WHILE THE DAEMON RUNS — `docs/relay-protocol.md` §15 "The daemon end".
 *
 * The tunnel is opt-in, so the switch is how it ever gets turned on: `fy daemon tunnel on` at the
 * machine, or a paired device's `PUT /v1/tunnel`. Both land here, and neither needs a restart.
 *
 * ONE OWNER HOLDS THE CURRENT CARRIER. A {@link TunnelCarrier} is built for one entry and runs it to
 * the end; switching is replacing it. Switching ON writes the entry and starts a new carrier.
 * Switching OFF writes the entry, stops the running carrier — the published tunnel withdrawn,
 * `cloudflared` stopped, the dedicated listener closed — and starts an OFF carrier, which is exactly
 * what releases a held tunnel at boot: the signed release, and `state/tunnel.json` forgotten once the
 * service answers. The answer waits for that release, so "off" means the tunnel is back in the pool.
 *
 * THE DOCUMENT IS WRITTEN FIRST. A switch that ran the carrier and then failed to record it would
 * be undone by the next boot without a word; written first, a failed write is an error the caller
 * sees and the running carrier is untouched.
 *
 * CHANGES ARE SERIALISED. Two devices toggling at once would otherwise race a stop against a start
 * and leave a carrier running that the document says is off.
 *
 * IT CAN BE ASKED BEFORE THE BOOT STARTS IT. Routes are served before the boot reaches the tunnel,
 * which runs after the bind and the relays; a change in that window is written and recorded, and
 * {@link start} then starts whatever the document says by then. The carrier factory arrives with
 * {@link start} because the carrier's listener serves the dispatcher the boot builds later.
 */

import { TUNNEL_OFF_SENTENCE, type TunnelStatusView, TunnelStatusViewSchema } from '@ferretry/protocol';
import type { DaemonTunnelCarrierEntry } from '../runtime/carriers.ts';
import type { TunnelCarrierStatus } from './carrier.ts';

/** The part of a running carrier the switch drives. {@link TunnelCarrier} is one. */
export interface TunnelCarrierHandle {
  readonly status: TunnelCarrierStatus;
  start(): void;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/** Builds the carrier for one entry. `explicit` says whether the document names it. */
export type TunnelCarrierFactory = (entry: DaemonTunnelCarrierEntry, explicit: boolean) => TunnelCarrierHandle;

/** Where the switch writes its decision: exactly the one tunnel entry, in the operator's document. */
export interface TunnelEntryStorePort {
  write(entry: DaemonTunnelCarrierEntry): Promise<void>;
}

/** What the `/v1/tunnel` routes ask. */
export interface TunnelSwitchPort {
  view(): TunnelStatusView;
  change(enabled: boolean): Promise<TunnelStatusView>;
}

export interface TunnelCarrierSwitchDependencies {
  /** The entry this boot read, and whether the document named it. */
  readonly entry: DaemonTunnelCarrierEntry;
  readonly explicit: boolean;
  readonly store: TunnelEntryStorePort;
}

export class TunnelCarrierSwitch implements TunnelSwitchPort {
  #entry: DaemonTunnelCarrierEntry;
  #explicit: boolean;
  #create: TunnelCarrierFactory | undefined;
  #carrier: TunnelCarrierHandle | undefined;
  #stopped = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TunnelCarrierSwitchDependencies) {
    this.#entry = deps.entry;
    this.#explicit = deps.explicit;
  }

  /** Starts the carrier the document asks for. Called once, by the boot, when it reaches the tunnel. */
  start(create: TunnelCarrierFactory): void {
    if (this.#create !== undefined || this.#stopped) return;
    this.#create = create;
    this.#replace();
  }

  view(): TunnelStatusView {
    const status: TunnelCarrierStatus = this.#carrier?.status ?? {
      state: this.#entry.enabled ? 'provisioning' : 'off',
      tunnelUrl: undefined,
      reason: undefined,
    };
    return describeTunnelStatus({ entry: this.#entry, explicit: this.#explicit, status });
  }

  /**
   * Switches the tunnel on or off, writing the entry first. ON when already on keeps the running
   * carrier, so asking twice never drops a working tunnel — unless that carrier is `unavailable`, when
   * asking again is how somebody who has just installed `cloudflared` retries. OFF always replaces it
   * with an off carrier and waits for that one's release, so asking again retries a release that found
   * no answer.
   */
  async change(enabled: boolean): Promise<TunnelStatusView> {
    return await this.#serially(async () => {
      const entry: DaemonTunnelCarrierEntry = { kind: 'tunnel', source: 'discovery', enabled };
      await this.deps.store.write(entry);
      const wasOn = this.#entry.enabled;
      this.#entry = entry;
      this.#explicit = true;
      if (this.#create === undefined || this.#stopped) return this.view();
      const running = this.#carrier?.status.state;
      if (enabled && wasOn && running !== undefined && running !== 'unavailable') return this.view();
      await this.#carrier?.stop();
      this.#replace();
      // An off carrier's whole work is the release; it is bounded by the provisioner's own timeout.
      if (!enabled) await this.#carrier?.idle();
      return this.view();
    });
  }

  /** Stops the running carrier for good. The held tunnel is kept, exactly as a daemon shutdown keeps it. */
  async stop(): Promise<void> {
    await this.#serially(async () => {
      this.#stopped = true;
      await this.#carrier?.stop();
    });
  }

  #replace(): void {
    // Only reached once `start` has supplied the factory.
    const carrier = (this.#create as TunnelCarrierFactory)(this.#entry, this.#explicit);
    this.#carrier = carrier;
    carrier.start();
  }

  async #serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return await run;
  }
}

/**
 * The tunnel as one view: the entry, whether it was written down, where the carrier is, and the one
 * line a person reads. The off sentence is the protocol's, so the CLI and the app say the same words.
 */
export function describeTunnelStatus(input: {
  readonly entry: DaemonTunnelCarrierEntry;
  readonly explicit: boolean;
  readonly status: TunnelCarrierStatus;
}): TunnelStatusView {
  const { state, tunnelUrl, reason } = input.status;
  return TunnelStatusViewSchema.parse({
    enabled: input.entry.enabled,
    explicit: input.explicit,
    state,
    tunnelUrl: tunnelUrl ?? null,
    sentence: tunnelSentence(state, input.explicit, tunnelUrl, reason),
  });
}

function tunnelSentence(
  state: TunnelStatusView['state'],
  explicit: boolean,
  tunnelUrl: string | undefined,
  reason: string | undefined,
): string {
  const because = reason === undefined ? '' : ` — ${reason}`;
  switch (state) {
    case 'off':
      return explicit
        ? 'Tunnel: off — switched off for this machine; turn on with fy daemon tunnel on or Settings › Connection'
        : TUNNEL_OFF_SENTENCE;
    case 'unavailable':
      return `Tunnel: on, but unavailable${because}`;
    case 'provisioning':
      return `Tunnel: on — asking the hosted service for a tunnel${because}`;
    case 'connecting':
      return `Tunnel: on — ${tunnelUrl ?? 'provisioned'}, waiting for cloudflared to reach Cloudflare’s edge`;
    case 'up':
      return `Tunnel: up — ${tunnelUrl ?? 'published'}`;
  }
}
