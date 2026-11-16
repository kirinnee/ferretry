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
import {
  PublishedCarrierSchema,
  TUNNEL_PATH,
  TunnelStatusViewSchema,
  WEBRTC_CONNECT_DEADLINE_MS,
  WEBRTC_GATHER_CAP_MS,
} from '../../contract/index.ts';
import { type BrowserSocket, createBrowserRelayDial } from '../adapters/browser-relay-dial.ts';
import type { IntroducerRequest } from '../lib/introducers.ts';
import { keptTunnel, type TunnelCarrier } from '../lib/tunnel-switch.ts';
import type { WebRtcDialer } from '../lib/webrtc-carrier.ts';
import { deferredSocket } from './deferred-socket.ts';
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
import { noTunnelReason, TUNNEL_SWITCHED_OFF, type TunnelServiceState } from '../lib/tunnel-service.ts';
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
/**
 * Said on screen while the DEFAULT preference (Relay, which nobody chose) is carried by the direct address this device
 * paired over, because the relay could not be reached. It goes away when the relay answers again.
 */
export const RELAY_FALLBACK_LINE = 'Couldn’t reach it through the relay, using the direct connection.';
/** Said to every session a new preference closes (today's `PREFERENCE_CHANGED_REASON`). */
export const PREFERENCE_CHANGED_REASON = 'the connection preference for this machine changed';
/** Said to every session an unpair or a re-pair closes (today's `clearDaemon` sentence). */
export const PAIRING_CLEARED_REASON = 'this daemon was re-paired or unpaired';
/** Said to a walk whose entry a republish replaced while it was in flight (today's `STALE_WALK_REASON`). */
const STALE_WALK_REASON =
  'this daemon was re-paired, unpaired or republished, or its connection preference changed, while this request was in flight, so it was not carried to another carrier';
/** Said to a session on a carrier the daemon's republished set no longer names (today's `#refreshed` sentence). */
export const WITHDRAWN_CARRIER_REASON = 'this rendezvous is not named in the carriers this daemon publishes';
/**
 * The request paths that are carrier control (§15): they ride {@link CarrierRouter.control}, the introducers only.
 * `/v1/tunnel` is the tunnel's switch and where it is now (the tunnel lookup reads it); `/v1/webrtc/offer` is
 * WebRTC's signalling (§16) — an offer that rode the WebRTC or tunnel path it asks for would have nothing to ride.
 */
const CONTROL_PATHS: readonly string[] = Object.freeze(['/v1/tunnel', '/v1/webrtc/offer']);

/**
 * How long one tunnel lookup's answer stands before a walk may ask again (R636).
 *
 * Every panel of an open page walks on its own, and under "Tunnel only" with the tunnel down each of them would ask the
 * same question of the same machine at the same moment; one answer is shared for this long.
 */
export const TUNNEL_LOOKUP_REUSE_MS = 30_000;
/** How long a tunnel lookup may wait for the introducer's answer: a lookup that hangs is a lookup that found nothing. */
const TUNNEL_LOOKUP_TIMEOUT_MS = 10_000;
/**
 * A WebRTC leg's own deadline: the gathering cap, the ICE deadline from the answer, and the session's handshake. The
 * leg is abandoned (and the walk moves on to the relay) at the latest then; ICE's own 8 s sentence usually comes first.
 */
const WEBRTC_LEG_DEADLINE_MS = WEBRTC_GATHER_CAP_MS + WEBRTC_CONNECT_DEADLINE_MS + DIRECT_SESSION_DEADLINE_MS;
/** Said when WebRTC has no introducer to signal through. */
const NO_WEBRTC_INTRODUCER = 'no carrier can introduce WebRTC to this machine';

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
  /**
   * Whether the person CHOSE this machine's preference. Relay that nobody chose is the default, and a default that
   * cannot reach its relay may use the direct address the device paired over; a chosen "Relay only" never does.
   * Absent: every preference counts as chosen, so nothing falls back.
   */
  readonly chosen?: (daemonId: string) => boolean;
  /** The one advertisement read this document performed (`hosted-relay.ts`): a last-resort address, never stored. */
  readonly hostedRelay: () => Promise<string | undefined>;
  /** The hosted tunnel service's one read, awaited only when "Tunnel only" finds no tunnel, to say why. */
  readonly tunnelService?: () => Promise<TunnelServiceState>;
  readonly health?: CarrierHealthReporter;
  readonly drops?: Pick<CarrierDropLog, 'dropped' | 'reconnected'>;
  /**
   * This browser's WebRTC dialer (R677). Absent where the browser has no `RTCPeerConnection`: WebRTC is then passed
   * over untried, and the choice says so.
   */
  readonly webrtc?: Pick<WebRtcDialer, 'dial' | 'release'>;
  /**
   * One request about how this device reaches a machine, over the introducers (the control lane): the tunnel lookup
   * and WebRTC's signalling. `undefined` while no half of Connections holds a client for that machine.
   */
  readonly introduce?: (daemonId: string) => IntroducerRequest | undefined;
  /** Told a tunnel a lookup found, so the stored set keeps it for the next load (R635). */
  readonly learned?: (daemonId: string, tunnel: TunnelCarrier) => void;
  /** Whether the machine itself said its tunnel is switched off — the reason "Tunnel only" names first. */
  readonly tunnelSwitchedOff?: (daemonId: string) => boolean;
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

/**
 * The direct address this device paired over — what the pairing recorded for this daemon, nothing discovered or guessed
 * — as a carrier. Only a record carrying the POSITIVE mark (`pairedOver: 'direct'`, written by the pairing that crossed
 * it) has one: a record without it (every record made before the mark, relayed or not) only holds the link's address,
 * which this device never proved it reached, so it has none and behaves as Relay only did before. `undefined` too when
 * the address is not one this build will dial.
 */
function pairedDirect(daemon: PairedDaemon): ConnectionMethod | undefined {
  if (daemon.pairedOver !== 'direct') return undefined;
  const parsed = ConnectionMethodSchema.safeParse({ kind: 'direct', daemonUrl: daemon.address });
  return parsed.success ? parsed.data : undefined;
}

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
  /** The unchosen default: after the relay, the direct address this device paired over may carry the session. */
  readonly fallsBackToPairedDirect: boolean;
  why?: string;
}

/**
 * A carrier that won AFTER WebRTC was tried and failed carries WebRTC's own sentence as the reason a faster one is not
 * carrying (`docs/relay-protocol.md` §16, "What the browser shows") — "no direct path found in 8 s…", the daemon's
 * refusal, or a daemon too old to offer it. A WebRTC that was never tried (no dialer in this build, a preference that
 * left it out) is no fallback at all, and nothing outranked by WebRTC (direct, or WebRTC itself) has one to give.
 */
const withWebRtcFallbackReason = (chosen: ConnectionChoice & { readonly ok: true }): ConnectionChoice => {
  const missed = chosen.passedOver.find(skip => skip.method.kind === 'webrtc' && skip.untried !== true);
  if (missed === undefined || chosen.method.kind === 'direct' || chosen.method.kind === 'webrtc') return chosen;
  return { ...chosen, fallbackReason: missed.detail };
};

const choiceFor = (probes: readonly ConnectionProbe[], plan: WalkPlan): ConnectionChoice => {
  const chosen = chooseConnection(probes);
  if (chosen.ok) return withWebRtcFallbackReason(chosen);
  const nothingTried = probes.every(probe => probe.untried === true);
  if (plan.why === undefined || plan.preference === 'auto' || !nothingTried) return chosen;
  const passedOver: readonly ConnectionSkip[] = chosen.passedOver;
  // Nobody chose Relay here, so it is not called "Relay only": the sentence must not claim a choice that was not made.
  const label = plan.fallsBackToPairedDirect ? 'Relay' : CARRIER_PREFERENCE_LABEL[plan.preference];
  return { ok: false, reason: `${label} — ${plan.why}.`, passedOver };
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

/** One accepted session that is still alive: whether it stands in for the relay, and the choice it made. */
interface LiveSession {
  readonly standsIn: boolean;
  readonly choice: ConnectionChoice;
}

/** One tunnel lookup: when it was asked, and what it found — a tunnel, or nothing. */
interface TunnelLookup {
  readonly at: number;
  readonly answer: Promise<TunnelCarrier | undefined>;
}

interface CarrierEntry {
  /** The published set this entry was walked against, to tell a republish from the same set. */
  readonly published: string;
  choice: ConnectionChoice | undefined;
  /** The choice is the paired direct address standing in for an unreachable relay (never a remembered winner). */
  fellBack: boolean;
  /**
   * Every ACCEPTED session of this pairing that is still alive, request lanes and streams alike (shared across a
   * republish, which keeps the sessions). The fallback is told for as long as any of them stands in for the relay.
   */
  readonly live: Set<LiveSession>;
  readonly generation: Generation;
  /** The last tunnel lookup for this daemon, reused for {@link TUNNEL_LOOKUP_REUSE_MS}. */
  lookup: TunnelLookup | undefined;
}

export class CarrierRouter {
  readonly #entries = new Map<string, CarrierEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #dial: (url: string) => ReturnType<ReturnType<typeof createBrowserRelayDial>>;

  /**
   * The hosted address once the directory answered, only to LABEL a published relay as Ferretry's. The wire names no
   * operator, so this comparison is the only thing that says whose relay carries a session — and the words a walk's
   * choice is built from ("Connected over …") are fixed when it is made, so a relay dialled BEFORE the answer arrived
   * would be called "your own" for as long as it carried. A walk therefore waits for the one read ({@link #labelled})
   * before it dials a published relay, and not for anything else: direct, WebRTC and a tunnel never wait on it.
   */
  #hostedLabel: string | undefined;

  /** The directory read has answered (or failed): the label is as known as it will ever be, so nothing waits again. */
  #labelSettled = false;

  /** Settles once the directory read has; never rejects, and the read is itself bounded, so a walk waits at most that long. */
  readonly #labelled: Promise<void>;

  constructor(private readonly deps: CarrierRouterDependencies) {
    this.#dial = createBrowserRelayDial({ openSocket: deps.openSocket, after: deps.after });
    this.#labelled = deps.hostedRelay().then(
      url => {
        this.#hostedLabel = url;
        this.#labelSettled = true;
      },
      () => {
        this.#labelSettled = true;
      },
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
    this.#entries.set(daemonId, {
      published: entry.published,
      choice: undefined,
      fellBack: false,
      live: new Set(),
      generation: new Generation(),
      lookup: entry.lookup,
    });
    entry.generation.end(PREFERENCE_CHANGED_REASON);
    // A peer connection found under the old preference is not kept open for a person who may have just excluded it.
    this.deps.webrtc?.release(daemonId);
    this.#announce();
  }

  /** The pairing went away: nothing about it is kept, and everything it holds or is still dialling ends. */
  clearDaemon(daemonId: string): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.delete(daemonId);
    entry.generation.end(PAIRING_CLEARED_REASON);
    // Nothing keeps a peer-to-peer path open to a machine this browser no longer means to reach.
    this.deps.webrtc?.release(daemonId);
    this.#announce();
  }

  /** A dial for one session to this daemon, over the preference's walk. */
  dial(daemon: PairedDaemon): CarrierDial {
    return events => {
      // The preference is read once per session, so one walk never mixes two.
      const plan = this.#plan(daemon.daemon);
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
      const plan = this.#plan(daemon.daemon);
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

  #plan(daemonId: string): WalkPlan {
    const preference = this.#preference(daemonId);
    return {
      preference,
      fallsBackToPairedDirect: preference === 'relay' && this.deps.chosen?.(daemonId) === false,
    };
  }

  /**
   * The line a surface says while this daemon is carried by the paired direct address because the relay could not be
   * reached — for as long as ANY live session of it (a request lane, a bulk lane, a stream) stands in for the relay —
   * or `undefined` once none does (the relay carries it, or nothing has been carried).
   */
  relayFallback(daemonId: string): string | undefined {
    return this.#entries.get(daemonId)?.fellBack === true ? RELAY_FALLBACK_LINE : undefined;
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
      pairingEnded: () =>
        this.#holding(daemonId, entry.generation) === undefined
          ? (entry.generation.endedWith() ?? STALE_WALK_REASON)
          : undefined,
      track: socket => entry.generation.track(socket),
    };
  }

  #entry(daemon: PairedDaemon): CarrierEntry {
    const carriers = daemonCarriers(daemon);
    const published = JSON.stringify(carriers);
    const current = this.#entries.get(daemon.daemon);
    if (current !== undefined && current.published === published) return current;
    if (current === undefined) {
      const entry: CarrierEntry = {
        published,
        choice: undefined,
        fellBack: false,
        live: new Set(),
        generation: new Generation(),
        lookup: undefined,
      };
      this.#entries.set(daemon.daemon, entry);
      return entry;
    }
    // A REPUBLISH IS NOT A RE-PAIR (today's `#refreshed`): what the new set still names is kept — its sessions and a
    // winner on it — and a direct or WebRTC winner no set can name keeps itself and its sessions. Everything else is
    // closed, saying so, and a walk on the replaced entry stops before its next dial.
    const chosen = current.choice;
    const winner = chosen?.ok === true ? chosen.method : undefined;
    const named = (method: ConnectionMethod): boolean => carriers.some(listed => sameCarrier(listed, method));
    // The live set belongs to the pairing, not to the entry, and is the one source of truth for the fallback: while any
    // accepted session still stands in for the relay, a republish keeps the disclosure, the direct choice it shows AND
    // the stand-in itself, whether or not the remembered winner survived (a lost request lane forgets it; a lane is not
    // every lane). What is kept follows the live set, not the winner: the paired direct address is positively marked and
    // no publication can revoke it, so omitting it is not a withdrawal — unless the person has since CHOSEN a carrier
    // (the unchosen default is the only fallback), which withdraws what that choice excludes.
    const standingIn = [...current.live].filter(live => live.standsIn);
    const paired = this.#plan(daemon.daemon).fallsBackToPairedDirect ? pairedDirect(daemon) : undefined;
    const standsInFor = (method: ConnectionMethod): boolean =>
      standingIn.length > 0 && paired !== undefined && sameCarrier(method, paired);
    const outlives = (method: ConnectionMethod): boolean =>
      (winner !== undefined && outlivesRepublish(winner) && sameCarrier(method, winner)) || standsInFor(method);
    const kept = winner !== undefined && (named(winner) || outlivesRepublish(winner));
    const entry: CarrierEntry = {
      published,
      choice: kept ? chosen : standingIn.at(-1)?.choice,
      fellBack: (current.fellBack && kept) || standingIn.length > 0,
      live: current.live,
      generation: current.generation,
      lookup: current.lookup,
    };
    this.#entries.set(daemon.daemon, entry);
    current.generation.withdraw(method => named(method) || outlives(method), WITHDRAWN_CARRIER_REASON);
    this.#announce();
    return entry;
  }

  /**
   * WebRTC as a leg (R677): one data channel on the connection to this daemon, signalled through an introducer. The
   * channel is a socket like any other, so the same session runs over it; a dial that fails or finds no path in 8 s
   * ends the leg with the sentence the dial gave, and the walk goes on to the relay.
   */
  #webrtcLeg(daemon: PairedDaemon, dialer: NonNullable<CarrierRouterDependencies['webrtc']>): WalkLeg {
    return {
      method: WEBRTC,
      deadlineMs: WEBRTC_LEG_DEADLINE_MS,
      open: () => {
        const abort = new AbortController();
        const request: IntroducerRequest =
          this.deps.introduce?.(daemon.daemon) ??
          (async () => {
            throw new Error(NO_WEBRTC_INTRODUCER);
          });
        return deferredSocket(dialer.dial({ daemon: { daemonId: daemon.daemon }, request, signal: abort.signal }), () =>
          abort.abort(),
        );
      },
    };
  }

  #leg(daemon: PairedDaemon, method: ConnectionMethod): WalkStep {
    if (method.kind === 'webrtc') {
      const dialer = this.deps.webrtc;
      return dialer === undefined
        ? { kind: 'untried', method, detail: WEBRTC_UNAVAILABLE }
        : { kind: 'leg', leg: this.#webrtcLeg(daemon, dialer) };
    }
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
    // A direct address standing in for an unreachable relay is never the remembered winner: the relay is tried first
    // again, so the walk flips back the moment it answers.
    const winner = entry.choice?.ok === true && !entry.fellBack ? entry.choice.method : undefined;
    if (winner !== undefined) yield this.#leg(daemon, winner);
    const authored = daemonCarriers(daemon);
    for (const kind of carrierOrder(plan.preference)) {
      if (kind === 'webrtc') {
        if (this.deps.webrtc === undefined) plan.why = WEBRTC_UNAVAILABLE;
        if (winner === undefined || !sameCarrier(WEBRTC, winner)) yield this.#leg(daemon, WEBRTC);
        continue;
      }
      // A published relay is labelled from the directory's answer, so it is awaited here and only here (see #hostedLabel).
      if (kind === 'relay' && !this.#labelSettled && authored.some(method => method.kind === 'relay'))
        await this.#labelled;
      const ofKind = (kind === 'relay' ? daemonCarriers(daemon, this.#hostedLabel) : authored).filter(
        method => method.kind === kind,
      );
      for (const method of ofKind)
        if (winner === undefined || !sameCarrier(method, winner)) yield this.#leg(daemon, method);
      if (kind === 'tunnel') {
        if (plan.preference !== 'tunnel') continue;
        // A tunnel is TRIED when the daemon published one (the kept one first). Under "Tunnel only", when there is none
        // or the one kept did not carry (the walk only gets here once it did not), the daemon is ASKED before the walk
        // gives up: a hostname re-provisioned since, or a tunnel this browser never heard of, is dialled straight away.
        const tried = winner?.kind === 'tunnel' ? [...ofKind, winner] : ofKind;
        const learned = await this.#lookupTunnel(daemon, entry);
        if (learned !== undefined && !tried.some(method => sameCarrier(method, learned))) {
          this.deps.learned?.(daemon.daemon, learned);
          yield this.#leg(daemon, learned);
          continue;
        }
        if (tried.length === 0)
          plan.why = this.deps.tunnelSwitchedOff?.(daemon.daemon)
            ? TUNNEL_SWITCHED_OFF
            : noTunnelReason((await this.deps.tunnelService?.()) ?? 'unavailable');
        continue;
      }
      if (ofKind.length > 0 || kind === 'direct') continue;
      const hosted = hostedRelayFallback(daemon, await this.deps.hostedRelay());
      if (hosted !== undefined) {
        if (winner === undefined || !sameCarrier(hosted, winner)) yield this.#leg(daemon, hosted);
      } else plan.why = RELAY_UNAVAILABLE;
    }
    // The unchosen default, and the relay carried nothing: the direct address this device paired over (that exact one;
    // nothing discovered, published later or guessed) is the last leg. A device with no such address gets no leg.
    const paired = plan.fallsBackToPairedDirect ? pairedDirect(daemon) : undefined;
    if (paired !== undefined) yield this.#leg(daemon, paired);
  }

  /**
   * WHERE IS THIS DAEMON'S TUNNEL NOW? Asked of the daemon itself, over an introducer (R636, §15 "Tunnel only"): one
   * `GET /v1/tunnel` (carrier control, so it never rides the tunnel it asks about, whatever the preference), whose
   * answer says where the tunnel is when it is up. Under "Tunnel only" there is nothing else to ask: a tunnel this
   * browser lost, or one the daemon re-provisioned, is found here.
   *
   * Asked once per {@link TUNNEL_LOOKUP_REUSE_MS}, joined while in flight, and never thrown: a lookup that fails
   * answers nothing, and a tunnel this browser already keeps is not dropped because of it. With no client to ask
   * through yet nothing is asked and nothing is remembered, so the first walk after one arrives asks.
   */
  async #lookupTunnel(daemon: PairedDaemon, entry: CarrierEntry): Promise<TunnelCarrier | undefined> {
    const request = this.deps.introduce?.(daemon.daemon);
    if (request === undefined) return undefined;
    const now = this.deps.now();
    const held = entry.lookup;
    if (held !== undefined && now - held.at < TUNNEL_LOOKUP_REUSE_MS) return await held.answer;
    const answer = this.#readTunnel(request).catch(() => undefined);
    entry.lookup = { at: now, answer };
    return await answer;
  }

  async #readTunnel(request: IntroducerRequest): Promise<TunnelCarrier | undefined> {
    const timeout = new AbortController();
    this.deps.after(TUNNEL_LOOKUP_TIMEOUT_MS, () => timeout.abort());
    const response = await request(TUNNEL_PATH, { cache: 'no-store', signal: timeout.signal });
    if (!response.ok) return undefined;
    const view = TunnelStatusViewSchema.safeParse(await response.json().catch(() => undefined));
    // An answer that is not a tunnel status finds nothing, and keeps nothing.
    return view.success ? (keptTunnel(view.data) ?? undefined) : undefined;
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
      // A direct session that ended does not make the relay answer: the line stays until the relay carries a session or
      // a walk finds nothing at all to carry (`exhausted`), so it does not flicker with every session that closes.
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
        // The entry that holds the walk's pairing NOW: a session accepted after a republish, on a carrier the new set
        // still names, is counted on the new entry (the live set is shared); one of an ended pairing is counted nowhere.
        const entry = this.#holding(daemonId, walked.generation);
        if (entry === undefined) return undefined;
        this.deps.health?.answered(daemonId);
        this.deps.drops?.reconnected(daemonId);
        if (!decides) return undefined;
        // Under the unchosen default the only direct leg is the fallback: the relay did not carry this session.
        const standsIn = plan.fallsBackToPairedDirect && method.kind === 'direct';
        const chosen = choiceFor([...probes, carrierProbe(method, { kind: 'answered', status: 101 })], plan);
        const session: LiveSession = {
          standsIn: standsIn && chosen.ok,
          choice: standsIn && chosen.ok ? { ...chosen, reason: RELAY_FALLBACK_LINE } : chosen,
        };
        entry.live.add(session);
        if (session.standsIn) {
          // A session on the paired direct address is live: the connection says so, whatever else carries.
          entry.choice = session.choice;
          entry.fellBack = true;
          this.#announce();
        } else if (![...entry.live].some(live => live.standsIn)) {
          // Initial sessions may walk concurrently; once one has a winner, that is the connection's fact — except that
          // a relay answering again takes the place of a direct address that stood in for it and has since ended.
          if (!(entry.choice?.ok === true && !entry.fellBack)) {
            entry.choice = session.choice;
            entry.fellBack = false;
            this.#announce();
          }
        }
        // Otherwise a relay session came up while another lane still sends direct: the disclosure stays until that
        // lane (or stream) ends, because the connection is not fully back on the relay.
        return () => this.#sessionEnded(daemonId, walked.generation, entry.live, session);
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
          // Nothing carried at all, the paired direct address included: no carrier is standing in for the relay.
          entry.fellBack = [...entry.live].some(live => live.standsIn);
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

  /**
   * An accepted session ended. When it was the last one standing in for the relay, the fallback is over — provided a
   * session on the relay is still alive to take its place; with nothing live the line stays (it must not flicker with
   * every idle session that closes), and the next walk tries the relay first again.
   */
  #sessionEnded(daemonId: string, generation: Generation, live: Set<LiveSession>, session: LiveSession): void {
    live.delete(session);
    if (!session.standsIn) return;
    const entry = this.#holding(daemonId, generation);
    if (entry === undefined || [...live].some(other => other.standsIn)) return;
    const relayed = [...live].at(-1);
    if (relayed === undefined) return;
    entry.choice = relayed.choice;
    entry.fellBack = false;
    this.#announce();
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
