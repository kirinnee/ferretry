/**
 * THE BROWSER'S CARRIER CHOICE FOR EVERY PAIRED DAEMON (§15 "The choice") — today's `DaemonCarrierRouter` (PWA
 * `lib/relay-carrier.ts`), moved into Connections' app half as the shell's {@link CarrierDialer}.
 *
 * The shell owns the sealed session and the generated client; this owns which carrier each session's socket crosses:
 *
 * - **The walk** is the preference's order (`carrierOrder`): the daemon's own addresses of each kind in the daemon's
 *   order, WebRTC through its dialer, a published tunnel, and the hosted relay last — reached only by exhaustion, and
 *   only when the daemon authored no rendezvous, so the directory never delays a direct-first attempt.
 * - **The winner is remembered** per daemon once the daemon ACCEPTS a session over it, and tried first; when it stops
 *   carrying (before acceptance, or under an accepted session) it is forgotten and the walk runs again. The winner is the connection's fact: a later walk that happened to reach a
 *   relay does not turn timing into a relay preference.
 * - **Carrier control** (`GET`/`PUT /v1/tunnel`, R634) rides the introducers only — the daemon's direct address or a
 *   rendezvous, never the tunnel or WebRTC — and decides nothing: no winner is remembered from it.
 *
 * Every carrier is a socket below a session that proves the daemon against the fingerprint the pairing pinned, so a
 * carrier can delay or drop a session, never read one.
 */
import {
  type CarrierDial,
  type CarrierDialer,
  CONTROL_UNREACHABLE,
  DaemonIdSchema,
  type PairedDaemon,
  RELAY_CLOSE_CODES,
} from '@ferretry/app';
import { PublishedCarrierSchema } from '../../contract/index.ts';
import { type BrowserSocket, createBrowserRelayDial } from '../adapters/browser-relay-dial.ts';
import type { CarrierDropLog } from '../lib/carrier-drops.ts';
import {
  type CarrierPreference,
  CARRIER_PREFERENCE_LABEL,
  carrierOrder,
  DEFAULT_CARRIER_PREFERENCE,
} from '../lib/carrier-preference.ts';
import type { CarrierOutage } from '../lib/connection-health.ts';
import {
  carrierProbe,
  chooseConnection,
  type ConnectionChoice,
  type ConnectionMethod,
  ConnectionMethodSchema,
  type ConnectionProbe,
  type ConnectionSkip,
  describeConnectionMethod,
  publishedConnectionMethods,
} from '../lib/connection.ts';
import { noTunnelReason, type TunnelServiceState } from '../lib/tunnel-service.ts';
import {
  type CarrierSocketDependencies,
  DIRECT_SESSION_DEADLINE_MS,
  type LegFailure,
  RELAY_SESSION_DEADLINE_MS,
  type RetirableSocket,
  walkingDial,
  type WalkLeg,
  type WalkScope,
  type WalkStep,
} from './carrier-socket.ts';

/** Said when WebRTC is passed over because this build has no dialer for it. */
export const WEBRTC_UNAVAILABLE = 'WebRTC isn’t available in this build yet';
/** Said when a walk that wanted a relay found none. */
export const RELAY_UNAVAILABLE = 'there is no relay for this machine right now';
/** Said to every session a new preference closes (today's `PREFERENCE_CHANGED_REASON`). */
export const PREFERENCE_CHANGED_REASON = 'the connection preference for this machine changed';
/** Said to every session an unpair or a re-pair closes (today's `clearDaemon` sentence). */
export const PAIRING_CLEARED_REASON = 'this daemon was re-paired or unpaired';
/** The request paths that are carrier control (§15): they ride {@link CarrierRouter.control}. */
export const CONTROL_PATHS: readonly string[] = Object.freeze(['/v1/tunnel']);

const WEBRTC: ConnectionMethod = { kind: 'webrtc' };

/** The connection model's half of the health reporter (`connection-health.ts`). */
export interface CarrierHealthReporter {
  answered(daemonId: string): void;
  outage(daemonId: string, outage: CarrierOutage): void;
}

export interface CarrierRouterDependencies extends CarrierSocketDependencies {
  readonly openSocket: (url: string) => BrowserSocket;
  /** This browser's preference for one machine, read at the start of every walk. Absent: Relay (the default). */
  readonly preference?: (daemonId: string) => CarrierPreference;
  /** The one advertisement read this document performed (`hosted-relay.ts`): a last-resort address, never stored. */
  readonly hostedRelay: () => Promise<string | undefined>;
  /** The hosted tunnel service's one read, awaited only when "Tunnel only" finds no tunnel, to say why. */
  readonly tunnelService?: () => Promise<TunnelServiceState>;
  readonly health?: CarrierHealthReporter;
  readonly drops?: Pick<CarrierDropLog, 'dropped' | 'reconnected'>;
}

/** The session URL for one carrier, or `null` for a fingerprint no session can check (today's `connectionSocketUrl`). */
export function carrierSocketUrl(method: ConnectionMethod, daemonId: string): string | null {
  if (!DaemonIdSchema.safeParse(daemonId).success) return null;
  if (method.kind === 'webrtc') return null;
  const base =
    method.kind === 'direct' ? method.daemonUrl : method.kind === 'tunnel' ? method.tunnelUrl : method.relayUrl;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/v1/rendezvous/${encodeURIComponent(daemonId)}/client`;
  return url.toString();
}

/**
 * A paired daemon's published carriers, as carriers this browser will dial (`publishedConnectionMethods`). The shell
 * keeps the set opaque; one entry this build will not dial is dropped, not the set. A daemon that published nothing
 * is reached at the address it was paired over (today's `pairedDaemonConnection`). A fingerprint no session can check
 * gets its direct addresses only (today's `daemonCarriers`).
 */
export function daemonCarriers(daemon: PairedDaemon, hostedRelayUrl?: string): readonly ConnectionMethod[] {
  const entries = daemon.carriers.flatMap(entry => {
    const parsed = PublishedCarrierSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const published = publishedConnectionMethods(entries, hostedRelayUrl);
  const set = published.length === 0 ? [{ kind: 'direct' as const, daemonUrl: daemon.address }] : published;
  return DaemonIdSchema.safeParse(daemon.daemon).success ? set : set.filter(method => method.kind === 'direct');
}

/** The hosted rendezvous for a daemon that authored none — dialled, never stored (`hostedRelayFallbackCarrier`). */
export function hostedRelayFallback(
  daemon: PairedDaemon,
  hostedRelayUrl: string | undefined,
): ConnectionMethod | undefined {
  if (hostedRelayUrl === undefined) return undefined;
  if (!DaemonIdSchema.safeParse(daemon.daemon).success) return undefined;
  if (daemonCarriers(daemon).some(carrier => carrier.kind === 'relay')) return undefined;
  const parsed = ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl: hostedRelayUrl, operator: 'hosted' });
  return parsed.success ? parsed.data : undefined;
}

/** Is this the same published address, dialled the same way? */
export const sameCarrier = (left: ConnectionMethod, right: ConnectionMethod): boolean => {
  if (left.kind === 'direct') return right.kind === 'direct' && left.daemonUrl === right.daemonUrl;
  if (left.kind === 'webrtc') return right.kind === 'webrtc';
  if (left.kind === 'tunnel') return right.kind === 'tunnel' && left.tunnelUrl === right.tunnelUrl;
  return right.kind === 'relay' && left.relayUrl === right.relayUrl;
};

/** A winner the daemon's republished set can never name, and so is not withdrawn by omitting it. */
const outlivesRepublish = (method: ConnectionMethod): boolean => method.kind === 'direct' || method.kind === 'webrtc';

/** The carriers that may introduce: everything addressed except a tunnel. */
const introducer = (method: ConnectionMethod): boolean => method.kind === 'direct' || method.kind === 'relay';

const untriedProbe = (method: ConnectionMethod, detail: string): ConnectionProbe => ({
  method,
  reachable: false,
  detail,
  untried: true,
});

/** One walk's preference, and — when the preference leaves nothing to try — why. */
interface WalkPlan {
  readonly preference: CarrierPreference;
  why?: string;
}

const choiceFor = (probes: readonly ConnectionProbe[], plan: WalkPlan): ConnectionChoice => {
  const chosen = chooseConnection(probes);
  if (chosen.ok) return chosen;
  const nothingTried = probes.every(probe => probe.untried === true);
  if (plan.why === undefined || plan.preference === 'auto' || !nothingTried) return chosen;
  const passedOver: readonly ConnectionSkip[] = chosen.passedOver;
  return { ok: false, reason: `${CARRIER_PREFERENCE_LABEL[plan.preference]}: ${plan.why}.`, passedOver };
};

const HOSTED_ONLY_CODES: ReadonlySet<number> = new Set([
  RELAY_CLOSE_CODES.hostedDisabled,
  RELAY_CLOSE_CODES.hostedCapacity,
  RELAY_CLOSE_CODES.hostedBandwidth,
]);

/** What a walk observed, in the terms the connection model reads (today's `carrierOutage`). */
const carrierOutage = (seen: readonly LegFailure[]): CarrierOutage => {
  const relays = seen.filter(failure => failure.method.kind === 'relay');
  return {
    failures: seen.map(failure => ({
      label: describeConnectionMethod(
        failure.method.kind === 'relay' && HOSTED_ONLY_CODES.has(failure.code)
          ? { ...failure.method, operator: 'hosted' }
          : failure.method,
      ).label,
      detail: `${failure.reason} (${String(failure.code)})`,
    })),
    daemonAbsent: seen.some(failure => failure.code === RELAY_CLOSE_CODES.daemonAbsent),
    relaysNeverOpened: relays.length > 0 && relays.every(failure => !failure.opened),
  };
};

/**
 * One pairing under one preference: what every walk and session for it belongs to (today's entry `retired`
 * controller and its `sessions`). `rewalk` and `clearDaemon` retire it — every session it holds is closed, saying
 * why, and every walk still in flight stops before its next dial and decides nothing. A republish keeps it.
 */
class Generation {
  #retired: string | undefined;
  readonly #sockets = new Set<RetirableSocket>();

  scope(): WalkScope {
    return {
      retired: () => this.#retired,
      track: socket => {
        this.#sockets.add(socket);
        return () => this.#sockets.delete(socket);
      },
    };
  }

  retired(): boolean {
    return this.#retired !== undefined;
  }

  retire(reason: string): void {
    if (this.#retired !== undefined) return;
    this.#retired = reason;
    for (const socket of [...this.#sockets]) socket.retire(reason);
    this.#sockets.clear();
  }
}

interface CarrierEntry {
  /** The published set this entry was walked against, to tell a republish from the same set. */
  readonly published: string;
  choice: ConnectionChoice | undefined;
  readonly generation: Generation;
}

export class CarrierRouter {
  readonly #entries = new Map<string, CarrierEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #dial: (url: string) => ReturnType<ReturnType<typeof createBrowserRelayDial>>;

  /**
   * The hosted address once the directory answered, only to LABEL a published relay as Ferretry's: a daemon that
   * authored its own rendezvous is walked without ever waiting on the directory.
   */
  #hostedLabel: string | undefined;

  constructor(private readonly deps: CarrierRouterDependencies) {
    this.#dial = createBrowserRelayDial({ openSocket: deps.openSocket, after: deps.after });
    void deps.hostedRelay().then(
      url => {
        this.#hostedLabel = url;
      },
      () => undefined,
    );
  }

  /** The shell's carrier: every session to every daemon walks here; carrier control rides its own lane. */
  dialer(): CarrierDialer {
    return {
      id: 'connections',
      order: 0,
      dial: daemon => this.dial(daemon),
      control: { paths: CONTROL_PATHS, dial: daemon => this.control(daemon) },
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What the walks measured for this daemon, or `undefined` before anything has been carried. */
  choice(daemonId: string): ConnectionChoice | undefined {
    return this.#entries.get(daemonId)?.choice;
  }

  /**
   * THE PREFERENCE CHANGED: forget the winner the old one chose, so the next session walks the new order.
   *
   * The entry is REPLACED rather than edited (today's `rewalk`): every session on it is closed, saying why, so no
   * request goes on crossing a carrier the person may just have excluded, and a walk still in flight finds its
   * generation retired and stops rather than deciding a winner under the old preference.
   */
  rewalk(daemonId: string): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.set(daemonId, { published: entry.published, choice: undefined, generation: new Generation() });
    entry.generation.retire(PREFERENCE_CHANGED_REASON);
    this.#announce();
  }

  /** The pairing went away: nothing about it is kept, and everything it holds or is still dialling ends. */
  clearDaemon(daemonId: string): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.delete(daemonId);
    entry.generation.retire(PAIRING_CLEARED_REASON);
    this.#announce();
  }

  /** A dial for one session to this daemon, over the preference's walk. */
  dial(daemon: PairedDaemon): CarrierDial {
    return events => {
      // The preference is read once per session, so one walk never mixes two.
      const plan: WalkPlan = { preference: this.#preference(daemon.daemon) };
      const generation = this.#entry(daemon).generation;
      return walkingDial(
        this.deps,
        () => this.#steps(daemon, plan, generation),
        this.#observer(daemon, plan, true, generation),
        generation.scope(),
      )(events);
    };
  }

  /** A dial for a carrier-control session: the introducers only, and no winner remembered (R634). */
  control(daemon: PairedDaemon): CarrierDial {
    return events => {
      const plan: WalkPlan = { preference: this.#preference(daemon.daemon) };
      const generation = this.#entry(daemon).generation;
      return walkingDial(
        this.deps,
        () => this.#introducers(daemon),
        this.#observer(daemon, plan, false, generation),
        generation.scope(),
      )(events);
    };
  }

  #preference(daemonId: string): CarrierPreference {
    return this.deps.preference?.(daemonId) ?? DEFAULT_CARRIER_PREFERENCE;
  }

  #entry(daemon: PairedDaemon): CarrierEntry {
    const carriers = daemonCarriers(daemon);
    const published = JSON.stringify(carriers);
    const current = this.#entries.get(daemon.daemon);
    if (current !== undefined && current.published === published) return current;
    // A republish is not a re-pair: a winner the new set still names (or one no set can name) is kept.
    const chosen = current?.choice;
    const kept =
      chosen?.ok === true &&
      (carriers.some(method => sameCarrier(method, chosen.method)) || outlivesRepublish(chosen.method))
        ? chosen
        : undefined;
    const entry: CarrierEntry = { published, choice: kept, generation: current?.generation ?? new Generation() };
    this.#entries.set(daemon.daemon, entry);
    return entry;
  }

  #leg(daemon: PairedDaemon, method: ConnectionMethod): WalkStep {
    const url = carrierSocketUrl(method, daemon.daemon);
    if (url === null) return { kind: 'untried', method, detail: 'this daemon fingerprint cannot address a session' };
    const leg: WalkLeg = {
      method,
      open: () => this.#dial(url),
      deadlineMs: method.kind === 'relay' ? RELAY_SESSION_DEADLINE_MS : DIRECT_SESSION_DEADLINE_MS,
    };
    return { kind: 'leg', leg };
  }

  /** The walk: the remembered winner first, then the preference's order (today's `#candidates`). */
  async *#steps(daemon: PairedDaemon, plan: WalkPlan, generation: Generation): AsyncGenerator<WalkStep> {
    // A retired generation is never re-entered: reading `#entry` for it would recreate a cleared pairing.
    if (generation.retired()) return;
    const entry = this.#entry(daemon);
    const winner = entry.choice?.ok === true ? entry.choice.method : undefined;
    if (winner !== undefined) yield this.#leg(daemon, winner);
    const authored = daemonCarriers(daemon, this.#hostedLabel);
    for (const kind of carrierOrder(plan.preference)) {
      if (kind === 'webrtc') {
        plan.why = WEBRTC_UNAVAILABLE;
        yield { kind: 'untried', method: WEBRTC, detail: WEBRTC_UNAVAILABLE };
        continue;
      }
      const ofKind = authored.filter(method => method.kind === kind);
      for (const method of ofKind)
        if (winner === undefined || !sameCarrier(method, winner)) yield this.#leg(daemon, method);
      if (kind === 'tunnel') {
        if (plan.preference === 'tunnel' && ofKind.length === 0) {
          plan.why = noTunnelReason((await this.deps.tunnelService?.()) ?? 'unavailable');
        }
        continue;
      }
      if (ofKind.length > 0 || kind === 'direct') continue;
      const hosted = hostedRelayFallback(daemon, await this.deps.hostedRelay());
      if (hosted !== undefined) {
        if (winner === undefined || !sameCarrier(hosted, winner)) yield this.#leg(daemon, hosted);
      } else plan.why = RELAY_UNAVAILABLE;
    }
  }

  /** The carriers that introduce (today's `#introducers`): direct and relay, the hosted one when none is published. */
  async *#introducers(daemon: PairedDaemon): AsyncGenerator<WalkStep> {
    const authored = daemonCarriers(daemon).filter(introducer);
    for (const method of authored) yield this.#leg(daemon, method);
    if (authored.some(method => method.kind === 'relay')) return;
    const hosted = hostedRelayFallback(daemon, await this.deps.hostedRelay());
    if (hosted !== undefined) yield this.#leg(daemon, hosted);
  }

  /** This walk's entry while its generation is current; `undefined` once retired (never recreated from here). */
  #current(daemon: PairedDaemon, generation: Generation): CarrierEntry | undefined {
    if (generation.retired()) return undefined;
    const entry = this.#entries.get(daemon.daemon);
    return entry?.generation === generation ? entry : undefined;
  }

  #observer(daemon: PairedDaemon, plan: WalkPlan, decides: boolean, generation: Generation) {
    const probes: ConnectionProbe[] = [];
    const daemonId = daemon.daemon;
    /** The stopped carrier was the remembered winner: forget it, so this walk and the next start from the top. */
    const forget = (method: ConnectionMethod): void => {
      if (!decides) return;
      const entry = this.#current(daemon, generation);
      if (entry?.choice?.ok !== true || !sameCarrier(entry.choice.method, method)) return;
      entry.choice = undefined;
      this.#announce();
    };
    return {
      untried: (method: ConnectionMethod, detail: string) => probes.push(untriedProbe(method, detail)),
      failed: (failure: LegFailure) => {
        forget(failure.method);
        probes.push(
          carrierProbe(failure.method, {
            kind: 'transport-failure',
            detail: `${failure.reason} (${String(failure.code)})`,
            ...(failure.opened ? { connected: true as const } : {}),
          }),
        );
      },
      committed: (method: ConnectionMethod) => {
        const entry = this.#current(daemon, generation);
        if (entry === undefined) return;
        this.deps.health?.answered(daemonId);
        this.deps.drops?.reconnected(daemonId);
        if (!decides) return;
        // Initial sessions may walk concurrently; once one has a winner, that is the connection's fact.
        if (entry.choice?.ok === true) return;
        entry.choice = choiceFor([...probes, carrierProbe(method, { kind: 'answered', status: 101 })], plan);
        this.#announce();
      },
      exhausted: (failures: readonly LegFailure[]) => {
        if (!decides) {
          if (failures.length === 0) return { code: RELAY_CLOSE_CODES.daemonAbsent, reason: CONTROL_UNREACHABLE };
          const last = failures[failures.length - 1] as LegFailure;
          return { code: last.code, reason: last.reason };
        }
        const chosen = choiceFor(probes, plan);
        const entry = this.#current(daemon, generation);
        if (entry === undefined)
          return { code: failures.at(-1)?.code ?? RELAY_CLOSE_CODES.daemonAbsent, reason: chosen.reason };
        if (entry.choice?.ok !== true) {
          entry.choice = choiceFor(probes, plan);
          this.#announce();
        }
        if (failures.length > 0) this.deps.health?.outage(daemonId, carrierOutage(failures));
        const last = failures[failures.length - 1];
        return { code: last?.code ?? RELAY_CLOSE_CODES.daemonAbsent, reason: chosen.reason };
      },
      // A carrier that failed under an accepted session stopped carrying: the winner it was is forgotten and the change
      // announced, whatever the optional drop log does (today's `#walk`, before it reports the lost request).
      lost: (method: ConnectionMethod) => forget(method),
      dropped: (
        method: ConnectionMethod,
        end: Parameters<NonNullable<CarrierRouterDependencies['drops']>['dropped']>[3],
      ) => this.deps.drops?.dropped(daemonId, method.kind, 'requests', end),
    };
  }

  #announce(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // An observer cannot turn a carried session into a failure.
      }
    }
  }
}
