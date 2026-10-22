/**
 * THE HOSTED TUNNEL CARRIER, END TO END ON THE DAEMON — `docs/relay-protocol.md` §15 "The daemon end".
 *
 * One object owns the whole life of this daemon's tunnel, in order:
 *
 * 1. **Plan.** The `{ kind: 'tunnel', source: 'discovery' }` entry switched off — written so, or implied
 *    so because the tunnel is opt-in — means release a held tunnel and stop. Otherwise `cloudflared` must be found (it is a dependency, never a download) and
 *    the hosted service must advertise `available: true`; either missing turns the carrier off, said
 *    once with the reason and the remedy.
 * 2. **Listen.** A second listener on `127.0.0.1:0` serving only this daemon's session route, every
 *    arrival on it remote (`listener.ts`). Its port is the `originPort` the tunnel forwards to.
 * 3. **Provision**, signed for the discovered host only (`provisioning.ts`), on boot and again every
 *    `renewAfterSeconds`. A failure that may clear is retried with a capped, jittered backoff, and every
 *    retry is stated; a refusal about this daemon itself turns the carrier off.
 * 4. **Supervise** `cloudflared` with the connector token in its environment (`supervisor.ts`). A
 *    renewal that answers a different token restarts the connector on it.
 * 5. **Publish** `{ kind: 'tunnel', url }` while — and only while — the connector reports a registered
 *    edge connection, and withdraw it when the connector is down, released or stopped.
 *
 * THE CONNECTOR TOKEN STAYS IN MEMORY. This object never holds it: a provision's token goes straight to
 * the supervisor, which hands it to the child's environment and nowhere else. What IS recorded on disk
 * is only the fact that this daemon holds a tunnel, and where from ({@link TunnelHolding}) — no secret —
 * so a daemon whose operator switches the carrier off knows there is something to release.
 *
 * NOTHING HERE THROWS INTO A BOOT. Every failure is a sentence and the carrier is simply off: direct and
 * relay sessions do not depend on it, and a daemon that would not start because a tunnel could not be
 * provisioned would be a worse product than one that says so and serves.
 */

import type { TunnelState } from '@ferretry/protocol';
import type { DaemonIdentity, RelayCrypto, TunnelProvision, TunnelRelease } from '@ferretry/relay';
import type { DaemonTunnelCarrierEntry } from '../runtime/carriers.ts';
import { type CloudflaredLocatorPort, cloudflaredRemedy } from './connector.ts';
import {
  type ProvisioningOutcome,
  provisionRetryDelayMs,
  type TunnelProvisionerPort,
  TunnelProvisioningClient,
} from './provisioning.ts';
import { type ScheduledAction, secondsPhrase, type TunnelScheduler } from './schedule.ts';
import type { TunnelServicePort } from './service.ts';
import { type ConnectorProcessPort, ConnectorSupervisor } from './supervisor.ts';

/** The tunnel's dedicated listener, once bound. */
export interface TunnelListenerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * THAT this daemon holds a tunnel, and from which service — never the connector token.
 *
 * Kept so switching the carrier off can release a tunnel provisioned by an earlier boot: the token died
 * with that boot's memory, but the release is signed by the identity key, which did not.
 */
export interface TunnelHolding {
  readonly origin: string;
  readonly tunnelUrl: string;
}

export interface TunnelHoldingPort {
  read(): Promise<TunnelHolding | undefined>;
  record(holding: TunnelHolding): Promise<void>;
  forget(): Promise<void>;
}

/** The identity provisioning signs with: the key pairing minted, or why there is none. */
export type TunnelIdentity =
  | { readonly ok: true; readonly identity: DaemonIdentity }
  | { readonly ok: false; readonly reason: string };

export interface TunnelCarrierNotices {
  /** A milestone: something now works. */
  step(what: string, detail?: string): void;
  /** Something the operator should read: the carrier is off, failing, or degraded, and why. */
  state(line: string): void;
}

/**
 * Where one carrier is right now, for `GET /v1/tunnel` — never anything a provision answered but the
 * hostname. `reason` is the last sentence that explains a state that is not `up`.
 */
export interface TunnelCarrierStatus {
  readonly state: TunnelState;
  readonly tunnelUrl: string | undefined;
  readonly reason: string | undefined;
}

export interface TunnelCarrierDependencies {
  readonly entry: DaemonTunnelCarrierEntry;
  /**
   * Whether the operator's document names the entry, rather than the opt-in default implying it. Only
   * the boot sentence differs: an implied-off carrier says how to turn the tunnel ON, because nobody
   * decided it was off.
   */
  readonly explicit: boolean;
  /** The hosted origin this build discovers from, normalised (`tunnelServiceOrigin`), or none. */
  readonly discoveryOrigin: string | undefined;
  readonly cloudflared: CloudflaredLocatorPort;
  readonly service: TunnelServicePort;
  readonly holding: TunnelHoldingPort;
  readonly identity: () => Promise<TunnelIdentity>;
  readonly crypto: RelayCrypto;
  /** The provisioner bound to one origin. Asked only with an origin this daemon discovered. */
  readonly provisioner: (origin: string) => TunnelProvisionerPort;
  readonly openListener: () => Promise<TunnelListenerHandle>;
  readonly processes: ConnectorProcessPort;
  readonly scheduler: TunnelScheduler;
  readonly random: () => number;
  /** Publishes the tunnel at a URL, or withdraws it with `undefined`. */
  readonly publish: (tunnelUrl: string | undefined) => void;
  readonly notices: TunnelCarrierNotices;
}

/** The label every boot line about this carrier starts with, so a reader can find all of them. */
const OFF = 'tunnel carrier off —';

/** How the opt-in default says it is off, and how to turn it on. */
const OPT_IN = 'tunnel carrier off (opt-in)';
const TURN_ON = 'turn on with `fy daemon tunnel on`';

export class TunnelCarrier {
  #stopped = false;
  #work: Promise<void> = Promise.resolve();
  #client: TunnelProvisioningClient | undefined;
  #origin: string | undefined;
  #listener: TunnelListenerHandle | undefined;
  #supervisor: ConnectorSupervisor | undefined;
  #timer: ScheduledAction | undefined;
  #attempts = 0;
  /** The provisioned hostname — the only part of a provision this object keeps. */
  #tunnelUrl: string | undefined;
  #published: string | undefined;
  #announced = false;
  #state: TunnelState;
  #reason: string | undefined;

  constructor(private readonly deps: TunnelCarrierDependencies) {
    this.#state = deps.entry.enabled ? 'provisioning' : 'off';
  }

  /** The address published right now, or nothing. */
  get published(): string | undefined {
    return this.#published;
  }

  /** Where this carrier is: off, unable to run, asking for a tunnel, waiting for the edge, or up. */
  get status(): TunnelCarrierStatus {
    const connected = this.#published === undefined ? 'connecting' : 'up';
    return {
      state: this.#state === 'connecting' ? connected : this.#state,
      tunnelUrl: this.#state === 'off' || this.#state === 'unavailable' ? undefined : this.#tunnelUrl,
      reason: this.#reason,
    };
  }

  /**
   * Begins. Local decisions are made before this returns; anything that talks to the hosted service
   * runs behind it, so a slow or absent service never holds a boot up. {@link idle} awaits that work.
   */
  start(): void {
    if (!this.deps.entry.enabled) {
      if (this.deps.explicit)
        this.deps.notices.step('tunnel carrier switched off', 'by its { "kind": "tunnel" } entry');
      else this.deps.notices.step(OPT_IN, TURN_ON);
      this.#track(this.#releaseHeld());
      return;
    }
    const location = this.deps.cloudflared.locate();
    if (location.kind === 'absent') {
      this.#unavailable(cloudflaredRemedy(location.reason));
      return;
    }
    this.#track(this.#bringUp(location.path));
  }

  /** Resolves once the work in flight right now has settled. */
  async idle(): Promise<void> {
    await this.#work;
  }

  /** Withdraws the tunnel, stops the connector and closes the listener. The held tunnel is kept. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelTimer();
    await this.#work;
    await this.#supervisor?.stop();
    this.#publishAs(undefined);
    await this.#listener?.close();
    this.#listener = undefined;
  }

  /**
   * Chains work so {@link idle} and {@link stop} can wait for it. A fault — a listener that cannot bind,
   * a holding record that cannot be written — becomes the carrier's off sentence, never a rejection.
   */
  #track(work: Promise<void>): void {
    const guarded = work.catch((error: unknown) => {
      this.#unavailable(error instanceof Error ? error.message : String(error));
    });
    this.#work = this.#work.then(() => guarded);
  }

  async #bringUp(executable: string): Promise<void> {
    const availability = await this.deps.service.read();
    if (this.#stopped) return;
    if (availability.kind === 'unavailable') {
      this.#unavailable(availability.reason);
      return;
    }
    const identity = await this.deps.identity();
    if (this.#stopped) return;
    if (!identity.ok) {
      this.#unavailable(identity.reason);
      return;
    }
    this.#origin = availability.origin;
    this.#client = new TunnelProvisioningClient({
      origin: availability.origin,
      provisioner: this.deps.provisioner(availability.origin),
      crypto: this.deps.crypto,
      identity: identity.identity,
    });
    const listener = await this.deps.openListener();
    if (this.#stopped) {
      await listener.close();
      return;
    }
    this.#listener = listener;
    this.deps.notices.step(
      'tunnel listener',
      `127.0.0.1:${String(listener.port)}, serving only this daemon’s session route to the tunnel`,
    );
    this.#supervisor = new ConnectorSupervisor({
      executable,
      processes: this.deps.processes,
      scheduler: this.deps.scheduler,
      random: this.deps.random,
      notice: line => {
        if (!this.#stopped) this.deps.notices.state(line);
      },
      registration: registered => this.#registration(registered),
    });
    await this.#provision();
  }

  /** One provision or renewal, and the timer for whichever comes next. */
  async #provision(): Promise<void> {
    // Both are set by `#bringUp` before the first provision, and this runs only after it.
    const client = this.#client as TunnelProvisioningClient;
    const listener = this.#listener as TunnelListenerHandle;
    const outcome = await client.provision(listener.port);
    if (this.#stopped) return;
    if (outcome.kind === 'done') {
      await this.#provisioned(outcome.value);
      return;
    }
    if (outcome.kind === 'retry') {
      const delay = provisionRetryDelayMs(this.#attempts, this.deps.random);
      this.#attempts += 1;
      this.#reason = `provisioning failed — ${outcome.reason}; retrying in ${secondsPhrase(delay)}`;
      this.deps.notices.state(`tunnel ${this.#reason}`);
      this.#schedule(delay);
      return;
    }
    this.#unavailable(outcome.reason);
    await this.#supervisor?.stop();
    this.#publishAs(undefined);
    await this.#listener?.close();
    this.#listener = undefined;
  }

  async #provisioned(provision: TunnelProvision): Promise<void> {
    this.#attempts = 0;
    // `#origin` was set beside the client this answer came through.
    await this.deps.holding.record({ origin: this.#origin as string, tunnelUrl: provision.tunnelUrl });
    if (this.#stopped) return;
    if (!this.#announced || this.#tunnelUrl !== provision.tunnelUrl)
      this.deps.notices.step(
        'tunnel provisioned',
        `${provision.tunnelUrl}, renewing every ${secondsPhrase(provision.renewAfterSeconds * 1_000)}`,
      );
    this.#announced = true;
    this.#tunnelUrl = provision.tunnelUrl;
    this.#state = 'connecting';
    this.#reason = undefined;
    // The token goes to the supervisor and is not kept here. A different token restarts the connector.
    (this.#supervisor as ConnectorSupervisor).run(provision.connectorToken);
    this.#publishCurrent();
    this.#schedule(provision.renewAfterSeconds * 1_000);
  }

  #schedule(delay: number): void {
    this.#cancelTimer();
    this.#timer = this.deps.scheduler.after(delay, () => {
      this.#timer = undefined;
      if (!this.#stopped) this.#track(this.#provision());
    });
  }

  #cancelTimer(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  #registration(registered: boolean): void {
    if (this.#stopped) return;
    if (registered) this.deps.notices.step('tunnel connector registered', this.#tunnelUrl);
    else this.deps.notices.state('tunnel withdrawn — cloudflared has no edge connection right now');
    this.#publishCurrent();
  }

  /** Published exactly while the connector is registered and a hostname is provisioned. */
  #publishCurrent(): void {
    this.#publishAs(this.#supervisor?.registered === true ? this.#tunnelUrl : undefined);
  }

  /** The carrier cannot run, said once with the reason, and reported as `unavailable` until replaced. */
  #unavailable(reason: string): void {
    this.#state = 'unavailable';
    this.#reason = reason;
    this.deps.notices.state(`${OFF} ${reason}`);
  }

  #publishAs(url: string | undefined): void {
    if (url === this.#published) return;
    this.#published = url;
    this.deps.publish(url);
  }

  /** The entry is switched off: release a tunnel an earlier boot provisioned, if there is one. */
  async #releaseHeld(): Promise<void> {
    const held = await this.deps.holding.read();
    if (held === undefined) return;
    // The release is signed for the host it is sent to, and this daemon signs only a host it discovers.
    if (this.deps.discoveryOrigin !== held.origin) {
      this.deps.notices.state(
        `tunnel carrier switched off — this daemon holds ${held.tunnelUrl} from ${held.origin}, which is not ` +
          'the service it discovers now, so it cannot release it; the service reclaims an unrenewed tunnel ' +
          'after 30 days, or its operator can delete it (docs/cloudflare-tunnel-pool.md)',
      );
      return;
    }
    const identity = await this.deps.identity();
    if (!identity.ok) {
      this.deps.notices.state(`tunnel release skipped — ${identity.reason}; the next boot tries again`);
      return;
    }
    const client = new TunnelProvisioningClient({
      origin: held.origin,
      provisioner: this.deps.provisioner(held.origin),
      crypto: this.deps.crypto,
      identity: identity.identity,
    });
    const outcome: ProvisioningOutcome<TunnelRelease> = await client.release();
    if (outcome.kind !== 'done') {
      // Nothing was answered, so nothing was released: the record stays and the next boot asks once more.
      this.deps.notices.state(`tunnel release failed — ${outcome.reason}; the next boot tries again`);
      return;
    }
    // Answered either way, so the record goes: `released: false` means the service held no tunnel for
    // this daemon (reclaimed, or released already), and an answered release is never repeated.
    await this.deps.holding.forget();
    if (!this.deps.explicit && outcome.value.released) {
      // The migration from the implied-on default: this daemon held a tunnel nobody turned on.
      this.deps.notices.state(`${OPT_IN} — released ${held.tunnelUrl}; ${TURN_ON}`);
      return;
    }
    this.deps.notices.step(
      'tunnel released',
      outcome.value.released
        ? `${held.tunnelUrl}, because the tunnel carrier is switched off`
        : `the hosted service held no tunnel for this daemon any more (${held.tunnelUrl})`,
    );
  }
}

/**
 * THE TUNNEL POSTURE, IN ONE LINE — for `fyd --check`, read through the same rules a boot follows.
 *
 * `availability` is asked only when the entry is on and `cloudflared` was found, exactly as a boot asks
 * it, so the command makes no request a boot would not.
 */
export function describeTunnelPosture(input: {
  readonly entry: DaemonTunnelCarrierEntry;
  /** Whether the document names the entry; an implied-off one is the opt-in default, not a decision. */
  readonly explicit: boolean;
  readonly configFile: string;
  readonly location: ReturnType<CloudflaredLocatorPort['locate']> | undefined;
  readonly availability: Awaited<ReturnType<TunnelServicePort['read']>> | undefined;
}): string {
  const label = 'tunnel      ';
  if (!input.entry.enabled)
    return input.explicit ? `${label} off — switched off in ${input.configFile}` : `${label} off (opt-in) — ${TURN_ON}`;
  if (input.location === undefined || input.location.kind === 'absent')
    return `${label} off — ${cloudflaredRemedy(input.location?.reason ?? 'cloudflared was not looked for')}`;
  if (input.availability === undefined || input.availability.kind === 'unavailable')
    return `${label} off — ${input.availability?.reason ?? 'the hosted service was not asked'}`;
  return (
    `${label} hosted — provisioned at boot from ${input.availability.origin}, ` +
    `run by cloudflared at ${input.location.path}`
  );
}
