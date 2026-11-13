/**
 * How a phone reaches a daemon. Four carriers, one security model (`docs/relay-protocol.md` §15).
 *
 * 1. **Direct** — the socket goes straight to the daemon: a laptop on the same network, a tailnet
 *    address, a VPN, a public host. Fewest hops, fewest parties, lowest latency. It is the first
 *    carrier tried whenever it is configured, not a fallback, and nobody has to opt out of anything
 *    to get it.
 * 2. **WebRTC** — a peer-to-peer data channel. Another session only INTRODUCES the two ends; it never
 *    carries the session's bytes. It has no address of its own, so it is a kind without a URL.
 * 3. **Tunnel** — a Cloudflare Tunnel hostname the hosted service provisioned for the daemon. It is
 *    dialled exactly like a direct address (the daemon serves the same session route behind it), but
 *    Cloudflare's edge is on the path, so it is disclosed like a relay.
 * 4. **Relay** — the Workers rendezvous in this package. Ferretry's metered hosted service is the
 *    automatic fallback after the others; running the same carrier in your own Cloudflare account
 *    remains an expert override. Who operates and pays for the relay changes, but the wire protocol
 *    and security model do not.
 *
 * A hosted relay anyone can reach is abusable precisely because its operator cannot read what it
 * carries. Ferretry accepts that risk for its hosted deployment and bounds the bill with runtime
 * metering and fail-safe caps. The address is still configuration: a remotely served advertisement
 * can be changed or set to null without releasing this package, while a self-hosted address remains
 * a value its owner supplies directly.
 *
 * The end-to-end layer is identical on every carrier. A direct socket is not "trusted because it is
 * direct": it runs the same handshake, pins the same fingerprint and authenticates every record the
 * same way. Choosing a carrier changes latency, dependency and what an onlooker can observe — it
 * never changes what protects the traffic.
 *
 * WHICH OF THEM A BROWSER WALKS, AND IN WHAT ORDER, IS A PER-DEVICE, PER-MACHINE PREFERENCE (§15
 * "The choice") that lives in the PWA and is never sent to the daemon. This module owns the default
 * order ({@link connectionPreferenceOrder}) and the disclosure for each carrier; the preference only
 * narrows which kinds are walked.
 */

import {
  type PublishedCarrier as DaemonCarrier,
  DaemonOriginSchema,
  TunnelOriginSchema,
} from '../../contract/index.ts';
import { z } from 'zod';

/**
 * Loopback AS THE PUBLISHED SITE'S CONTENT-SECURITY-POLICY READS IT — a third input domain, not a
 * third answer to what loopback is.
 *
 * `isLoopbackHost` in the protocol owns the spellings an operator may WRITE and `isLoopbackPeer`
 * owns what a transport REPORTS. Neither answers this question, which is not about the machine at
 * all: it is what a deployed `connect-src` lets a browser open WITHOUT TLS. That set is fixed by a
 * header file, so it is decided here, named for the header it mirrors, and deliberately narrower
 * than either of them — `127.0.0.2`, `fy.localhost` and every spelling of `::1` are all genuinely
 * loopback and all still blocked in the shipped app.
 *
 * The two lists are held together by `scripts/validate/cli-contracts.sh loopback-single-source`,
 * which fails if this set and the header stop agreeing.
 */
const PUBLISHED_CSP_INSECURE_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Exact match is total here because the caller passes `URL.hostname`, which has already lowercased
 * an ASCII name and would have carried brackets only for an address this set does not hold.
 */
function isLoopbackUnderPublishedCsp(hostname: string): boolean {
  return PUBLISHED_CSP_INSECURE_HOSTS.has(hostname);
}

/**
 * A socket address this protocol will dial.
 *
 * Secure schemes anywhere; insecure schemes only against the two hosts the published site's
 * content-security-policy will actually let a browser dial. Accepting a wider loopback here would
 * store a carrier the browser then refuses to open, and refuses BEFORE the request exists, so the
 * person holding the phone gets a dead connection with nothing to read.
 */
const SocketEndpointSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint is not a URL' });
      return z.NEVER;
    }
    const dialableInsecure = isLoopbackUnderPublishedCsp(url.hostname);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !(insecure && dialableInsecure)) {
      context.addIssue({
        code: 'custom',
        message: 'endpoint must be wss/https, or ws/http on localhost or the loopback address',
      });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint carries a query or fragment' });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });

export const ConnectionMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), daemonUrl: DaemonOriginSchema }),
  z.strictObject({ kind: z.literal('webrtc') }),
  z.strictObject({ kind: z.literal('tunnel'), tunnelUrl: TunnelOriginSchema }),
  z.strictObject({
    kind: z.literal('relay'),
    relayUrl: SocketEndpointSchema,
    operator: z.enum(['configured', 'hosted']).optional(),
  }),
]);
export type ConnectionMethod = z.infer<typeof ConnectionMethodSchema>;

/** Every carrier kind, in the order the protocol walks them by default (§15 "The choice", Auto). */
const CONNECTION_KINDS = ['direct', 'webrtc', 'tunnel', 'relay'] as const satisfies readonly ConnectionMethod['kind'][];

/**
 * The socket URL for one role.
 *
 * Every addressed carrier spells the path the same way, so a daemon serving direct clients, the
 * daemon's tunnel listener behind Cloudflare, and a rendezvous serving relayed ones all answer the
 * same route. The daemon role exists only on a relay: on a direct carrier and a tunnel the daemon is
 * the server, so asking for it is a mistake and returns null rather than a URL that would quietly
 * connect to the wrong thing. WebRTC has no socket URL, so it is null for both roles.
 */
/** What a carrier costs, in the terms a person choosing one actually cares about. */
export interface ConnectionDisclosure {
  readonly label: string;
  /**
   * The carrier as it reads INSIDE a sentence — "Connected over {noun}". Its own field because a
   * lowercased label is right for "direct" and wrong for "Cloudflare tunnel" and "WebRTC".
   */
  readonly noun: string;
  readonly summary: string;
  /** Every party on the path, and what that party can observe. Content is never on this list. */
  readonly observers: readonly string[];
  readonly requires: readonly string[];
}

const DIRECT_DISCLOSURE: ConnectionDisclosure = {
  label: 'Direct',
  noun: 'direct',
  summary: 'Your browser connects straight to the daemon. No third party carries the traffic.',
  observers: [
    'Whoever runs the network between you and the daemon sees that a connection exists, its size and its timing.',
    'Nobody else is on the path: there is no operator to trust and no service to be down.',
  ],
  requires: [
    'The daemon address has to be reachable from wherever the browser is — same network, a VPN, a tailnet or a public host.',
    'The address must serve TLS unless it is localhost or 127.0.0.1, the only two hosts the published web app may dial without it.',
  ],
};

/**
 * WebRTC, as §15's table states it: the networks in between, and the STUN server, which learns both
 * addresses. The introduction is a session of its own and is said as such, so nobody reads "the relay
 * is used" as "the relay carries the session".
 */
const WEBRTC_DISCLOSURE: ConnectionDisclosure = {
  label: 'WebRTC',
  noun: 'WebRTC',
  summary:
    'A peer-to-peer data channel between your browser and the daemon. Another connection only introduces the two ends; it never carries the session’s bytes.',
  observers: [
    'Whoever runs the networks in between sees that a connection exists, its size and its timing.',
    'The STUN server both ends ask learns both IP addresses.',
    'Whatever introduced the two ends sees that an introduction happened, and when — not what followed.',
    'Nobody on the path can read, alter or insert into the session: every record is authenticated under a key derived on your two devices.',
  ],
  requires: [
    'The two ends must be able to reach each other peer to peer. There is no server to carry the traffic when they cannot.',
    'A carrier that can introduce them — the daemon’s own address or a relay.',
  ],
};

/** The hosted Cloudflare Tunnel, as §15 "What a tunnel operator can see, honestly" states it. */
const TUNNEL_DISCLOSURE: ConnectionDisclosure = {
  label: 'Cloudflare tunnel',
  noun: 'Cloudflare tunnel',
  summary:
    'Cloudflare’s edge carries the session to a connector the daemon runs, through a tunnel Ferretry provisioned for this machine. It works behind NAT without making you deploy infrastructure.',
  observers: [
    'Ferretry, which provisioned the tunnel, and Cloudflare, which carries it, know its hostname and which daemon it belongs to.',
    'They see both IP addresses, when each session opens and closes, and that the daemon keeps renewing its tunnel.',
    'They see how many frames go each way, how big each one is and exactly when it was sent.',
    'Cloudflare ends the outer TLS, so it sees the connection’s path and headers — but every byte above that is end-to-end ciphertext it cannot read, alter or insert into.',
    'Someone holding a stolen connector token could drop sessions, not impersonate the daemon: only the daemon’s identity key completes the handshake.',
  ],
  requires: [
    'The hosted tunnel service must be set up by its operator; it can be withdrawn without an app release.',
    'The daemon must be running cloudflared and have registered its tunnel.',
  ],
};

const HOSTED_RELAY_DISCLOSURE: ConnectionDisclosure = {
  label: 'Hosted relay',
  noun: 'hosted relay',
  summary:
    'Ferretry’s Cloudflare Worker passes ciphertext between you and the daemon. It works behind NAT without making you deploy infrastructure.',
  observers: [
    'Ferretry and Cloudflare see the daemon fingerprint in the URL, because that is what addresses the rendezvous.',
    'They see both IP addresses, when each side connects and for how long.',
    'They see request counts, frame sizes and timing, and how many connections the daemon has.',
    'They cannot read frame payloads, device tokens, session content, commands, output or names.',
  ],
  requires: [
    'The hosted relay’s runtime advertisement must be enabled; the operator can disable it without an app release.',
    'Traffic and connection use must remain below both the daemon’s ceilings and the hosted service’s global ceilings.',
    'The same relay address must be configured on the daemon and this browser.',
  ],
};

/**
 * A relay this machine is set up to use, whose operator this device cannot tell. The daemon's own list holds its
 * address, which proves it was ENTERED — not who runs it: it can be Ferretry's hosted relay (while the directory is
 * down), a friend's, or a Worker in the owner's account. So the disclosure says what is true of EVERY relay and makes
 * the one thing that depends on who runs it conditional.
 */
const CONFIGURED_RELAY_DISCLOSURE: ConnectionDisclosure = {
  label: 'Configured relay',
  noun: 'the relay this machine is set up to use',
  summary:
    'A relay passes ciphertext between you and the daemon. This machine is set up to use this one, but this app cannot tell who runs it, so it makes no claim about that.',
  observers: [
    'Whoever runs the relay, and whoever hosts it, can see the daemon fingerprint in the URL, because that is what addresses the rendezvous.',
    'They can see both IP addresses, when each side connects and for how long.',
    'They can see how many frames go each way, how big each one is and exactly when it was sent.',
    'They cannot read a frame, alter one or insert one: every record is authenticated under a key derived on your two devices.',
    'If you run this relay yourself, only you and your hosting provider are on the path.',
  ],
  requires: [
    'The relay address configured on the daemon, and reachable from this browser.',
    'The daemon fingerprint allowed by whoever runs the relay.',
  ],
};

/**
 * A relay whose operator this device cannot tell: the directory did not name it, or did not answer, and the daemon
 * does not list it as configured. It claims nothing about who runs the rendezvous or the infrastructure under
 * it; it says what is true of EVERY relay.
 */
const UNKNOWN_RELAY_DISCLOSURE: ConnectionDisclosure = {
  label: 'Relay',
  noun: 'a relay',
  summary:
    'A relay passes ciphertext between you and the daemon. This app cannot tell who runs this one, so it makes no claim about that.',
  observers: [
    'Whoever runs the relay, and whoever hosts it, can see the daemon fingerprint in the URL, because that is what addresses the rendezvous.',
    'They can see both IP addresses, when each side connects and for how long.',
    'They can see how many frames go each way, how big each one is and exactly when it was sent.',
    'They cannot read a frame, alter one or insert one: every record is authenticated under a key derived on your two devices.',
  ],
  requires: [
    'The relay address configured on the daemon, and reachable from this browser.',
    'The daemon fingerprint allowed by whoever runs the relay.',
  ],
};

export function describeConnectionMethod(method: ConnectionMethod): ConnectionDisclosure {
  if (method.kind === 'direct') return DIRECT_DISCLOSURE;
  if (method.kind === 'webrtc') return WEBRTC_DISCLOSURE;
  if (method.kind === 'tunnel') return TUNNEL_DISCLOSURE;
  if (method.operator === 'hosted') return HOSTED_RELAY_DISCLOSURE;
  return method.operator === 'configured' ? CONFIGURED_RELAY_DISCLOSURE : UNKNOWN_RELAY_DISCLOSURE;
}

/** The result of trying one carrier, in preference order. */
export interface ConnectionProbe {
  readonly method: ConnectionMethod;
  readonly reachable: boolean;
  /** Why it was not reachable. Required when it was not, so a refusal is never unexplained. */
  readonly detail?: string;
  /**
   * The carrier was passed over WITHOUT being tried — no dialer in this build, say — rather than tried
   * and found unreachable. The two are different facts and are said differently.
   */
  readonly untried?: true;
  /**
   * The carrier CONNECTED, and the session on it then failed under the request. It was reachable, so
   * saying it was not would send somebody to debug a tunnel that was fine — the owner's `4400`, which
   * read "Cloudflare tunnel was not reachable" while the tunnel carried every frame it was given.
   */
  readonly connected?: true;
}

export interface ConnectionSkip {
  readonly method: ConnectionMethod;
  readonly detail: string;
  /** See {@link ConnectionProbe.untried}. */
  readonly untried?: true;
  /** See {@link ConnectionProbe.connected}. */
  readonly connected?: true;
}

export type ConnectionChoice =
  | {
      readonly ok: true;
      readonly method: ConnectionMethod;
      /** Plain-language sentence a surface can show verbatim. */
      readonly reason: string;
      readonly passedOver: readonly ConnectionSkip[];
      /** The live carrier's measured round trip, when the carrier measures one (WebRTC does). */
      readonly rttMs?: number;
      /**
       * Why this carrier is carrying rather than a better one, in the carrier's own words, when it knows
       * more than the passed-over list says — "ICE did not connect within 8 s", for instance.
       */
      readonly fallbackReason?: string;
    }
  | { readonly ok: false; readonly reason: string; readonly passedOver: readonly ConnectionSkip[] };

const kindRank = (method: ConnectionMethod): number => CONNECTION_KINDS.indexOf(method.kind);

/**
 * Order carriers by preference: direct, then WebRTC, then a tunnel, then a relay (§15, Auto).
 *
 * Direct stays first because it has the fewest parties; a relay is last because it is the one every
 * other carrier falls back to. The sort is stable, so within a kind the given order is kept.
 *
 * Ordering is separate from choosing so a caller cannot accidentally probe a relay before the
 * direct address it already has.
 */
function connectionPreferenceOrder(methods: readonly ConnectionMethod[]): readonly ConnectionMethod[] {
  return [...methods].sort((left, right) => kindRank(left) - kindRank(right));
}

/**
 * Whose relay a published relay is, for the SENTENCE a person reads and nothing else. Only positive evidence picks an
 * ownership-specific answer: the address this browser discovered itself is Ferretry's hosted relay, and an entry the
 * daemon lists as configured (`source: 'configured'`) is only CONFIGURED: an address that was entered says nothing about who runs
 * it. Anything else is NO `operator` at all — unknown. Neither is ever worded as ownership, because a directory that failed
 * to answer is an ordinary state and proves nothing.
 */
function relayOperator(
  carrier: { readonly url: string; readonly source?: 'configured' },
  hostedRelayUrl: string | undefined,
): { readonly operator?: 'hosted' | 'configured' } {
  if (carrier.url === hostedRelayUrl) return { operator: 'hosted' };
  return carrier.source === 'configured' ? { operator: 'configured' } : {};
}

/**
 * A daemon's PUBLISHED carrier set, as carriers this browser will dial, in the order it will try them.
 *
 * The order is `connectionPreferenceOrder`'s and nothing else's — every `direct` entry in the order the
 * daemon published them, then its tunnel, then every `relay` in the order the daemon published them.
 * WITHIN A KIND THE DAEMON'S ORDER IS THE ANSWER, because it is where the operator wrote their
 * preference down, and a client that re-sorted it would be substituting its own. There is deliberately
 * no latency race: a race makes the winner nondeterministic, and a surface that reports which carrier
 * is live has to be able to say WHY that one won.
 *
 * A CARRIER THE PROTOCOL WILL NOT DIAL IS DROPPED RATHER THAN CARRIED FORWARD, AND THAT IS PER ENTRY
 * FOR EVERY KIND. The published set already passed the wire schema on the way across, so a failure
 * here means the two ends disagree about what is dialable, and dialling anyway is how a client ends up
 * trusting a carrier its own protocol refuses. Dropping ONE entry rather than refusing the set is the
 * other half of the rule: this runs inside a pairing redemption and inside every carrier refresh, and
 * a daemon that published one address this build will not dial must still be reachable on the others.
 * A throw here would turn a single bad member into a device that cannot pair at all.
 *
 * `operator` IS DERIVED HERE AND IS DISCLOSURE ONLY. Who runs a rendezvous is not a wire fact and the
 * published set carries no claim about it beyond a configured relay's `source` — a daemon's self-report, not something a
 * device can check. What a device CAN check is whether the address equals the hosted one it discovered for itself, so
 * that comparison comes first; an entry the daemon lists as `configured` is only CONFIGURED (an entered address is not proof of who runs it), and
 * EVERYTHING ELSE IS UNKNOWN (`operator` absent). Neither is worded as ownership; a directory that failed to answer is not proof of it.
 * Nothing about the path changes either way; only the sentence a person reads.
 *
 * A TUNNEL is mapped to its own kind (§15): dialled like a direct address, disclosed as Cloudflare's.
 */
export function publishedConnectionMethods(
  carriers: readonly DaemonCarrier[],
  hostedRelayUrl?: string,
): readonly ConnectionMethod[] {
  const methods: ConnectionMethod[] = [];
  for (const carrier of carriers) {
    const parsed = ConnectionMethodSchema.safeParse(
      carrier.kind === 'direct'
        ? { kind: 'direct', daemonUrl: carrier.url }
        : carrier.kind === 'tunnel'
          ? { kind: 'tunnel', tunnelUrl: carrier.url }
          : {
              kind: 'relay',
              relayUrl: carrier.url,
              ...relayOperator(carrier, hostedRelayUrl),
            },
    );
    if (parsed.success) methods.push(parsed.data);
  }
  return connectionPreferenceOrder(methods);
}

/**
 * What happened when one carrier was tried.
 *
 * TWO OUTCOMES, AND THE DISTINCTION IS THE WHOLE RULE. `answered` means something served the request —
 * any status, `503` included. `transport-failure` means nothing did: the socket never opened, the name
 * did not resolve, the attempt timed out, TLS was refused.
 */
export type CarrierAttempt =
  | { readonly kind: 'answered'; readonly status: number }
  | {
      readonly kind: 'transport-failure';
      readonly detail: string;
      /** The carrier connected and the session on it failed afterwards: see {@link ConnectionProbe.connected}. */
      readonly connected?: true;
    };

/**
 * Does a walk over the carrier set advance past this attempt?
 *
 * ONLY A TRANSPORT FAILURE ADVANCES. A status code is an ANSWER, and an answer means this carrier
 * works — so `503` STOPS the walk rather than sending the client to the next address. Advancing on it
 * would be a client deciding a busy or refusing daemon is an absent one, and the next carrier reaches
 * the very same daemon: the walk would exhaust every address to arrive at the answer it already had,
 * and report "nothing was reachable" for a daemon that replied every single time.
 */
function carrierWalkAdvances(
  attempt: CarrierAttempt,
): attempt is Extract<CarrierAttempt, { kind: 'transport-failure' }> {
  return attempt.kind === 'transport-failure';
}

/**
 * One attempt, as {@link chooseConnection} reads it.
 *
 * The bridge exists so "reachable" has ONE definition. `chooseConnection` picks the first reachable
 * carrier and records what it passed over; whether an attempt counts as reachable is
 * {@link carrierWalkAdvances}'s answer, inverted, and no caller gets to decide it separately.
 */
export function carrierProbe(method: ConnectionMethod, attempt: CarrierAttempt): ConnectionProbe {
  return carrierWalkAdvances(attempt)
    ? { method, reachable: false, detail: attempt.detail, ...(attempt.connected === true ? { connected: true } : {}) }
    : { method, reachable: true };
}

/**
 * Pick a carrier from what was actually tried.
 *
 * The choice carries everything it passed over and why. A session that ends up on a relay because
 * the direct address timed out is a session whose owner should be told so — degrading silently is
 * how a person spends an evening blaming their phone for a firewall rule.
 */
export function chooseConnection(probes: readonly ConnectionProbe[]): ConnectionChoice {
  const passedOver: ConnectionSkip[] = [];
  for (const probe of probes) {
    if (!probe.reachable) {
      passedOver.push({
        method: probe.method,
        detail: probe.detail ?? 'unreachable, with no reason reported',
        ...(probe.untried === true ? { untried: true as const } : {}),
        ...(probe.connected === true ? { connected: true as const } : {}),
      });
      continue;
    }
    const noun = describeConnectionMethod(probe.method).noun;
    const reason =
      passedOver.length === 0
        ? `Connected over ${noun}.`
        : `Connected over ${noun} because ${passedOver.map(describeSkip).join('; ')}.`;
    return { ok: true, method: probe.method, reason, passedOver };
  }
  return {
    ok: false,
    reason:
      probes.length === 0
        ? 'No connection method is configured for this daemon.'
        : `No configured connection worked: ${passedOver.map(describeSkip).join('; ')}.`,
    passedOver,
  };
}

/**
 * One passed-over carrier, as a clause: never tried, connected and then lost, or unreachable — and why.
 */
function describeSkip(skip: ConnectionSkip): string {
  const noun = describeConnectionMethod(skip.method).noun;
  if (skip.untried === true) return `${noun} was not tried (${skip.detail})`;
  if (skip.connected === true) return `${noun} connected, but the session on it failed (${skip.detail})`;
  return `${noun} was not reachable (${skip.detail})`;
}
