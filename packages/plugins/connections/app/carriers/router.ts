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
import { hostedAllowanceSentence } from '../lib/relay-allowance.ts';
import { noTunnelReason, type TunnelServiceState } from '../lib/tunnel-service.ts';
import {
  type CarrierSocketDependencies,
  DIRECT_SESSION_DEADLINE_MS,
  type LegFailure,
  RELAY_SESSION_DEADLINE_MS,
  type ScopedSocket,
  walkingDial,
  type WalkLeg,
  type WalkScope,
  type WalkStep,
} from './carrier-socket.ts';

/** Said when WebRTC is passed over because this build has no dialer for it. */
const WEBRTC_UNAVAILABLE = 'WebRTC isn’t available in this build yet';
/** Said when a walk that wanted a relay found none. */
const RELAY_UNAVAILABLE = 'there is no relay for this machine right now';
/** Said to every session a new preference closes (today's `PREFERENCE_CHANGED_REASON`). */
export const PREFERENCE_CHANGED_REASON = 'the connection preference for this machine changed';
/** Said to every session an unpair or a re-pair closes (today's `clearDaemon` sentence). */
export const PAIRING_CLEARED_REASON = 'this daemon was re-paired or unpaired';
/** Said to a walk whose entry a republish replaced while it was in flight (today's `STALE_WALK_REASON`). */
const STALE_WALK_REASON =
  'this daemon was re-paired, unpaired or republished, or its connection preference changed, while this request was in flight, so it was not carried to another carrier';
/** Said to a session on a carrier the daemon's republished set no longer names (today's `#refreshed` sentence). */
export const WITHDRAWN_CARRIER_REASON = 'this rendezvous is not named in the carriers this daemon publishes';
/** The request paths that are carrier control (§15): they ride {@link CarrierRouter.control}. */
const CONTROL_PATHS: readonly string[] = Object.freeze(['/v1/tunnel']);

const WEBRTC: ConnectionMethod = { kind: 'webrtc' };

/** The connection model's half of the health reporter (`connection-health.ts`). */
interface CarrierHealthReporter {
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
function hostedRelayFallback(daemon: PairedDaemon, hostedRelayUrl: string | undefined): ConnectionMethod | undefined {
  if (hostedRelayUrl === undefined) return undefined;
  if (!DaemonIdSchema.safeParse(daemon.daemon).success) return undefined;
  if (daemonCarriers(daemon).some(carrier => carrier.kind === 'relay')) return undefined;
  const parsed = ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl: hostedRelayUrl, operator: 'hosted' });
  return parsed.success ? parsed.data : undefined;
}

/** Is this the same published address, dialled the same way? */
const sameCarrier = (left: ConnectionMethod, right: ConnectionMethod): boolean => {
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

/**
 * The line one failed leg is reported as. A spent hosted data allowance is said in the person's words, with its reset
 * in this device's local time (R159); every other failure keeps the words the carrier gave, and its close code.
 */
const legDetail = (failure: LegFailure): string =>
  (failure.code === RELAY_CLOSE_CODES.hostedBandwidth ? hostedAllowanceSentence(failure.reason) : undefined) ??
  `${failure.reason} (${String(failure.code)})`;

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
      detail: legDetail(failure),
    })),
    daemonAbsent: seen.some(failure => failure.code === RELAY_CLOSE_CODES.daemonAbsent),
    relaysNeverOpened: relays.length > 0 && relays.every(failure => !failure.opened),
  };
};

/**
 * One pairing under one preference: what every session for it belongs to (today's entry abort controller and its
 * `sessions`). `rewalk` and `clearDaemon` end it — every session it holds is closed, saying why, and every walk still
 * in flight stops before its next dial and decides nothing. A republish keeps it, closing only the sessions on a
 * carrier the new set no longer names ({@link Generation.withdraw}).
 */
class Generation {
  #endedWith: string | undefined;
  readonly #sockets = new Set<ScopedSocket>();

  track(socket: ScopedSocket): () => void {
    this.#sockets.add(socket);
    return () => this.#sockets.delete(socket);
  }

  /** Why this generation ended, or `undefined` while it is the pairing's. */
  endedWith(): string | undefined {
    return this.#endedWith;
  }

  end(reason: string): void {
    if (this.#endedWith !== undefined) return;
    this.#endedWith = reason;
    for (const socket of [...this.#sockets]) socket.cancel(reason);
    this.#sockets.clear();
  }

  /** Every session this generation holds proves it is alive now (the browser's foreground, online or network-change signal). */
  checkLiveness(): void {
    for (const socket of [...this.#sockets]) socket.checkLiveness();
  }

  /** A republish: close every session dialling or bound to a carrier `kept` refuses, saying why (today's `#refreshed`). */
  withdraw(kept: (method: ConnectionMethod) => boolean, reason: string): void {
    for (const socket of [...this.#sockets]) {
      const carrier = socket.carrier();
      if (carrier !== undefined && !kept(carrier)) socket.cancel(reason);
    }
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

  /**
   * PROVE EVERY HELD SESSION IS ALIVE, NOW (today's `DaemonCarrierRouter.checkLiveness`): a ping on each, a 4 s
   * deadline. For the moments the browser says the network may have changed under it; a dead session ends the way any
   * other dead session does (4408), and the next request redials.
   */
  checkLiveness(): void {
    for (const entry of this.#entries.values()) entry.generation.checkLiveness();
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
   * generation ended and stops rather than deciding a winner under the old preference.
   */
  rewalk(daemonId: string): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.set(daemonId, { published: entry.published, choice: undefined, generation: new Generation() });
    entry.generation.end(PREFERENCE_CHANGED_REASON);
    this.#announce();
  }

  /** The pairing went away: nothing about it is kept, and everything it holds or is still dialling ends. */
  clearDaemon(daemonId: string): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.delete(daemonId);
    entry.generation.end(PAIRING_CLEARED_REASON);
    this.#announce();
  }

  /** A dial for one session to this daemon, over the preference's walk. */
  dial(daemon: PairedDaemon): CarrierDial {
    return events => {
      // The preference is read once per session, so one walk never mixes two.
      const plan: WalkPlan = { preference: this.#preference(daemon.daemon) };
      const entry = this.#entry(daemon);
      return walkingDial(
        this.deps,
        () => this.#steps(daemon, plan, entry),
        this.#observer(daemon, plan, true, entry),
        this.#scope(daemon.daemon, entry),
      )(events);
    };
  }

  /** A dial for a carrier-control session: the introducers only, and no winner remembered (R634). */
  control(daemon: PairedDaemon): CarrierDial {
    return events => {
      const plan: WalkPlan = { preference: this.#preference(daemon.daemon) };
      const entry = this.#entry(daemon);
      return walkingDial(
        this.deps,
        () => this.#introducers(daemon),
        this.#observer(daemon, plan, false, entry),
        this.#scope(daemon.daemon, entry),
      )(events);
    };
  }

  #preference(daemonId: string): CarrierPreference {
    return this.deps.preference?.(daemonId) ?? DEFAULT_CARRIER_PREFERENCE;
  }

  /**
   * Where one walk belongs: the ENTRY it started on (today's `#assertCurrent(entry)`). An unpair, a re-pair, a new
   * preference or a republish replaces that entry, and from then on the walk dials nothing more and decides nothing:
   * it carries the set the daemon has since corrected. Its sessions belong to the generation, so a republish leaves
   * those on a still-published carrier open.
   */
  #scope(daemonId: string, entry: CarrierEntry): WalkScope {
    return {
      stale: () =>
        entry.generation.endedWith() ?? (this.#entries.get(daemonId) === entry ? undefined : STALE_WALK_REASON),
      track: socket => entry.generation.track(socket),
    };
  }

  #entry(daemon: PairedDaemon): CarrierEntry {
    const carriers = daemonCarriers(daemon);
    const published = JSON.stringify(carriers);
    const current = this.#entries.get(daemon.daemon);
    if (current !== undefined && current.published === published) return current;
    if (current === undefined) {
      const entry: CarrierEntry = { published, choice: undefined, generation: new Generation() };
      this.#entries.set(daemon.daemon, entry);
      return entry;
    }
    // A REPUBLISH IS NOT A RE-PAIR (today's `#refreshed`): what the new set still names is kept — its sessions and a
    // winner on it — and a direct or WebRTC winner no set can name keeps itself and its sessions. Everything else is
    // closed, saying so, and a walk on the replaced entry stops before its next dial.
    const chosen = current.choice;
    const winner = chosen?.ok === true ? chosen.method : undefined;
    const named = (method: ConnectionMethod): boolean => carriers.some(listed => sameCarrier(listed, method));
    const outlives = (method: ConnectionMethod): boolean =>
      winner !== undefined && outlivesRepublish(winner) && sameCarrier(method, winner);
    const entry: CarrierEntry = {
      published,
      choice: winner !== undefined && (named(winner) || outlivesRepublish(winner)) ? chosen : undefined,
      generation: current.generation,
    };
    this.#entries.set(daemon.daemon, entry);
    current.generation.withdraw(method => named(method) || outlives(method), WITHDRAWN_CARRIER_REASON);
    this.#announce();
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
  async *#steps(daemon: PairedDaemon, plan: WalkPlan, entry: CarrierEntry): AsyncGenerator<WalkStep> {
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

  /** The walk's own entry while it is still the pairing's (today's `#assertCurrent`); `undefined` once replaced. */
  #current(daemonId: string, entry: CarrierEntry): CarrierEntry | undefined {
    if (entry.generation.endedWith() !== undefined) return undefined;
    return this.#entries.get(daemonId) === entry ? entry : undefined;
  }

  /**
   * The pairing's entry while `generation` is still its generation. An accepted session outlives a republish that
   * still names its carrier, so what it reports lands on the entry that holds it now, never on the replaced one.
   */
  #holding(daemonId: string, generation: Generation): CarrierEntry | undefined {
    if (generation.endedWith() !== undefined) return undefined;
    const entry = this.#entries.get(daemonId);
    return entry?.generation === generation ? entry : undefined;
  }

  #observer(daemon: PairedDaemon, plan: WalkPlan, decides: boolean, walked: CarrierEntry) {
    const probes: ConnectionProbe[] = [];
    const daemonId = daemon.daemon;
    /** The stopped carrier was the remembered winner: forget it, so this walk and the next start from the top. */
    const forget = (entry: CarrierEntry | undefined, method: ConnectionMethod): void => {
      if (!decides) return;
      if (entry?.choice?.ok !== true || !sameCarrier(entry.choice.method, method)) return;
      entry.choice = undefined;
      this.#announce();
    };
    return {
      untried: (method: ConnectionMethod, detail: string) => probes.push(untriedProbe(method, detail)),
      failed: (failure: LegFailure) => {
        forget(this.#current(daemonId, walked), failure.method);
        probes.push(
          carrierProbe(failure.method, {
            kind: 'transport-failure',
            detail: legDetail(failure),
            ...(failure.opened ? { connected: true as const } : {}),
          }),
        );
      },
      committed: (method: ConnectionMethod) => {
        const entry = this.#current(daemonId, walked);
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
        const entry = this.#current(daemonId, walked);
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
      // A request was lost with the carrier under an accepted session: it stopped carrying, so the winner it was is
      // forgotten and the change announced (today's request path). An idle drop never reaches here.
      lost: (method: ConnectionMethod) => forget(this.#holding(daemonId, walked.generation), method),
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
