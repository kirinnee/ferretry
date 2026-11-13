/**
 * WHERE THE CARRIER COMES FROM WHEN NOBODY HAS CONFIGURED ONE.
 *
 * `carrier.ts` answers "dial, or not, and where" from a configuration block. This module answers the
 * question BEFORE it: what that block should be when the operator never wrote one. Until it existed
 * the answer was "nothing", which made a fresh install direct-only forever — the daemon binds
 * loopback and dials nowhere, so a browser that is not on this machine's own network cannot reach it
 * at all, and the person holding the phone reads that as pairing being broken.
 *
 * THE BROWSER ALREADY DOES THIS. `packages/pwa/src/features/onboarding/hosted-relay.ts` reads the
 * same advertisement, from the same path, with the same four answers. A session crosses a relay only
 * if BOTH ends are on it, so a client half without a daemon half carries nothing. This is the daemon
 * half, deliberately shaped like the browser's so the two cannot drift into different readings of
 * one document.
 *
 * NO ADDRESS IS COMPILED IN — not here and not anywhere this is used. What a build may carry is a
 * DISCOVERY ORIGIN: a service address that identifies the relay directory and never a daemon, a
 * person, or a carrier. The carrier itself is whatever that directory says today, which is the whole
 * point — `relayUrl: null` withdraws it without a release, and a cached answer is that switch not
 * working. Nothing here caches: an answer is held for the life of the boot, and a FAILED read that was
 * transient is asked again in the background (`directory-retry.ts`) until it is answered.
 *
 * AN EXPLICIT BLOCK WINS AND IS NEVER OVERWRITTEN. Somebody who wrote a `relay` block chose it, and
 * `enabled: false` is a decision rather than an omission — so a configured block short-circuits this
 * module entirely and discovery is not even asked. Being helpful in the other direction would turn
 * an emergency stop into a suggestion.
 *
 * FAIL CLOSED, AND SAY WHAT TO DO. Every failure narrows to "direct-only" and every direct-only
 * answer carries the sentence that explains the consequence to the person reading it. A daemon that
 * knows it is unreachable and prints a bare reason is the complaint this product has earned.
 */

import { DaemonOriginSchema, isLoopbackHost, PublishedCarriersSchema } from '../../../contract/index.ts';
import { z } from 'zod';
import { SocketEndpointSchema } from './endpoint.ts';
const HostedRelayAdvertisementSchema = z.strictObject({
  version: z.literal(1),
  relayUrl: SocketEndpointSchema.nullable(),
});
import { type DaemonRelayConfig, DaemonRelayConfigSchema } from '../runtime/relay-config.ts';
import { type DaemonRelayCarrierEntry, relayCarrierIsConfigured } from '../runtime/relay-config.ts';

/**
 * The public discovery path, from `docs/relay-protocol.md` §13.
 *
 * Spelled here rather than imported from the relay package's Worker adapter, because a domain module
 * does not reach into another package's adapter layer. `scripts/validate/relay-config.sh` asserts
 * this string equals the one the Worker serves, so the two cannot drift in silence.
 */
export const RELAY_ADVERTISEMENT_PATH = '/v1/default-relay';

/** How long the daemon waits before treating silence from the directory as "does not know". */
export const RELAY_DISCOVERY_TIMEOUT_MS = 4_000;

/**
 * What this daemon knows about a carrier it did not configure.
 *
 * Four states in three shapes, and the distinctions are load-bearing: an operator who switched the
 * hosted relay OFF and a daemon that could not REACH the directory need different things done about
 * them, and reporting either as the other sends the reader somewhere useless.
 */
export type RelayAdvertisement =
  /** A relay is advertised, at this address. */
  | { readonly kind: 'available'; readonly relayUrl: string }
  /** The operator has withdrawn it. `null` is disabled, not an empty address and not a guess. */
  | { readonly kind: 'disabled' }
  /**
   * This daemon could not find out. Treated as no carrier, and said as ignorance.
   *
   * `retry` is present exactly when the failure is TRANSIENT (see {@link classifyDirectoryOutcome}):
   * the daemon will ask again in the background. Its absence is a definitive answer — nobody asks twice.
   */
  | { readonly kind: 'undetermined'; readonly reason: string; readonly retry?: DirectoryRetryHint };

/** What a transient failure tells the retry: a server-sent wait, and (once scheduled) when the next try is. */
export interface DirectoryRetryHint {
  /** A sane `Retry-After` the directory sent, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The wall-clock time (`HH:MM:SSZ`) of the next try, filled in when one is scheduled. */
  readonly nextAt?: string;
}

/** Whether this answer is a failure worth asking about again (as opposed to an answer). */
export function isTransientAdvertisement(
  advertisement: RelayAdvertisement,
): advertisement is Extract<RelayAdvertisement, { kind: 'undetermined' }> & { readonly retry: DirectoryRetryHint } {
  return advertisement.kind === 'undetermined' && advertisement.retry !== undefined;
}

/** Every way a directory read can end, before it is sorted. The adapter reports these; it decides nothing. */
export type DirectoryOutcome =
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'refused-origin' }
  /** `fetch` threw: DNS, refused, reset, no network yet. */
  | { readonly kind: 'unreachable' }
  /** The read's own deadline ran out. */
  | { readonly kind: 'timeout' }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfter: string | null }
  /** The status was fine and the body broke mid-read (reset, abort). */
  | { readonly kind: 'body-interrupted' }
  /** The status was fine and the body is not JSON. */
  | { readonly kind: 'body-not-document' }
  | { readonly kind: 'document'; readonly value: unknown };

/** The most whole seconds a `Retry-After` is carried as; far above the retry's own cap, which is what bounds the wait. */
const MAX_RETRY_AFTER_SECONDS = 999_999_999;

/**
 * A `Retry-After` in whole seconds, in milliseconds; anything else (a date, a fraction, junk) is ignored.
 *
 * A valid number of any length is CLAMPED, never discarded: a server that says "come back in a million seconds" is
 * saying "not soon", and the retry's cap turns that into the longest wait it ever makes. Leading zeros are
 * not digits of the value, and the clamp is decided on the digits that remain so no input can overflow.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  const text = header?.trim();
  if (text === undefined || !/^\d+$/u.test(text)) return undefined;
  const digits = text.replace(/^0+(?=\d)/u, '');
  const seconds = digits.length > 9 ? MAX_RETRY_AFTER_SECONDS : Math.min(Number(digits), MAX_RETRY_AFTER_SECONDS);
  return seconds * 1_000;
}

/**
 * THE ONE SORTING RULE: is this ending an answer, or a reason to ask again?
 *
 * TRANSIENT (retried in the background): `fetch` threw (network, DNS, refused), the read timed out, HTTP
 * 5xx, HTTP 429 (a `Retry-After` in seconds is carried), a body that broke mid-read.
 * DEFINITIVE (the sentence, then silence): no origin, an origin this daemon may not ask, the directory
 * advertising `relayUrl: null` (disabled), a document the schema refuses, a body that is not JSON, and every
 * other HTTP status (a 404 or 403 will not change by being asked again). An explicit `relay` block never
 * reaches this function — it is not asked at all.
 */
export function classifyDirectoryOutcome(outcome: DirectoryOutcome): RelayAdvertisement {
  switch (outcome.kind) {
    case 'no-origin':
      return NO_RELAY_DIRECTORY;
    case 'refused-origin':
      return { kind: 'undetermined', reason: 'the configured relay directory is not an address this daemon may ask' };
    case 'unreachable':
    case 'timeout':
      return { kind: 'undetermined', reason: 'this daemon could not reach the relay directory', retry: {} };
    case 'body-interrupted':
      return { kind: 'undetermined', reason: 'the relay directory’s answer was cut off', retry: {} };
    case 'body-not-document':
      return { kind: 'undetermined', reason: 'the relay directory answered something that is not a document' };
    case 'status': {
      const reason = `the relay directory answered ${outcome.status}`;
      if (outcome.status < 500 && outcome.status !== 429) return { kind: 'undetermined', reason };
      const retryAfterMs = parseRetryAfterMs(outcome.retryAfter);
      return { kind: 'undetermined', reason, retry: retryAfterMs === undefined ? {} : { retryAfterMs } };
    }
    case 'document':
      return parseRelayAdvertisement(outcome.value);
  }
}

/**
 * The answer when a build carries no directory to ask.
 *
 * A real state rather than a failure to hide: a local `bun build`, a fork, or a deploy that never
 * configured the origin all land here, and the reader deserves that sentence instead of a network
 * error that never happened.
 */
export const NO_RELAY_DIRECTORY: RelayAdvertisement = Object.freeze({
  kind: 'undetermined' as const,
  reason: 'this build carries no relay directory to ask',
});

/** The answer used when discovery is deliberately not performed, because a block was configured. */
export const RELAY_DIRECTORY_NOT_ASKED: RelayAdvertisement = Object.freeze({
  kind: 'undetermined' as const,
  reason: 'this daemon has its own relay configured, so the directory was not asked',
});

/**
 * The advertisement's address, derived from a discovery origin, or nothing.
 *
 * The origin goes through the protocol's own endpoint rule — secure anywhere, insecure only against
 * loopback, no query and no fragment — so a misconfigured build is refused rather than dialled, and
 * refused by the same rule the carrier itself is held to.
 */
export function relayAdvertisementAddress(origin: string): string | undefined {
  const parsed = SocketEndpointSchema.safeParse(origin);
  return parsed.success ? `${parsed.data}${RELAY_ADVERTISEMENT_PATH}` : undefined;
}

/**
 * Parse, do not validate: anything that is not exactly a version-1 advertisement carrying either
 * `null` or one dialable endpoint is `undetermined`.
 */
export function parseRelayAdvertisement(value: unknown): RelayAdvertisement {
  const parsed = HostedRelayAdvertisementSchema.safeParse(value);
  if (!parsed.success) {
    return { kind: 'undetermined', reason: 'the relay directory answered a document this daemon cannot read' };
  }
  if (parsed.data.relayUrl === null) return { kind: 'disabled' };
  return { kind: 'available', relayUrl: parsed.data.relayUrl };
}

/**
 * Which carrier this daemon will hand to {@link decideRelayCarrier}, and where it came from.
 *
 * PROVENANCE IS PART OF THE ANSWER, not decoration. "A relay you configured" and "the one Ferretry
 * advertises" behave identically on the wire and are completely different facts to a person deciding
 * whether something is misconfigured, so the surfaces that report a carrier report which of the two
 * it is.
 */
export type RelayCarrierSource =
  /** The operator's own block, exactly as written — including a block they switched off. */
  | { readonly kind: 'configured'; readonly config: DaemonRelayConfig }
  /** Ferretry's advertised carrier, read this boot and held no longer than this boot. */
  | { readonly kind: 'discovered'; readonly config: DaemonRelayConfig }
  /** Nothing to dial, and the sentence saying why. */
  | { readonly kind: 'direct-only'; readonly reason: string; readonly retrying?: true };

/**
 * Choose the carrier, with the operator's own choice winning unconditionally.
 *
 * A CONFIGURED BLOCK IS RETURNED WHETHER OR NOT IT IS ENABLED. The refusal for a switched-off relay
 * belongs to `decideRelayCarrier`, which already names the address in it; answering `direct-only`
 * here would replace that specific sentence with a vaguer one and would put the "is it on" decision
 * in two places.
 */
export function chooseRelayCarrierSource(
  configured: DaemonRelayConfig | undefined,
  advertised: RelayAdvertisement,
): RelayCarrierSource {
  if (configured !== undefined) return { kind: 'configured', config: configured };
  if (advertised.kind === 'disabled') {
    return {
      kind: 'direct-only',
      reason: 'Ferretry’s relay is switched off right now, so there is no carrier to fall back to',
    };
  }
  if (advertised.kind === 'undetermined') {
    if (advertised.retry !== undefined) {
      const next = advertised.retry.nextAt === undefined ? '' : `, next try at ${advertised.retry.nextAt}`;
      return {
        kind: 'direct-only',
        reason: `no relay could be discovered: ${advertised.reason}; retrying in the background${next}`,
        retrying: true,
      };
    }
    return { kind: 'direct-only', reason: `no relay could be discovered: ${advertised.reason}` };
  }
  /**
   * The advertised address becomes a configuration block through the SAME schema an operator's
   * document goes through, so a discovered carrier gets the identical redial cadence and the
   * identical endpoint rule. A second set of defaults here is how the two would come to disagree.
   */
  const parsed = DaemonRelayConfigSchema.safeParse({ url: advertised.relayUrl });
  if (!parsed.success) {
    return { kind: 'direct-only', reason: 'the advertised relay address is not one this daemon may dial' };
  }
  return { kind: 'discovered', config: parsed.data };
}

/** Whether resolving this ordered set requires the runtime relay advertisement. */
export function relayCarriersNeedDiscovery(relays: readonly DaemonRelayCarrierEntry[]): boolean {
  return relays.some(relay => !relayCarrierIsConfigured(relay) && relay.enabled);
}

/**
 * Every relay this boot resolved, or the refusal that replaces the list entirely.
 *
 * IT IS A UNION SO THE REFUSAL CANNOT BE SKIPPED. A separate "and also check for duplicates" helper
 * would be a rule a caller has to remember, and the whole point of the refusal is that the case it
 * catches is invisible — both halves look healthy right up until two sockets race for one room.
 */
export type ResolvedRelayCarriers =
  | { readonly kind: 'resolved'; readonly sources: readonly RelayCarrierSource[] }
  /** Two entries resolved to one rendezvous. `url` is that address, named so a boot can print it. */
  | { readonly kind: 'refused'; readonly url: string; readonly reason: string };

/**
 * Resolves every configured relay entry without collapsing the list to one.
 *
 * A configured URL is already complete. A discovery entry receives the one
 * advertisement read performed for this boot, then keeps the entry's own enabled
 * and reconnect settings. The output order is the operator's order and is also the
 * order the daemon publishes to devices.
 *
 * ## A DUPLICATE IS ONLY VISIBLE ONCE DISCOVERY HAS ANSWERED
 *
 * The document schema already refuses a list that names one address twice, but it cannot see the
 * collision that matters: a rendezvous the operator wrote down AND the discovery entry, where today's
 * advertisement happens to be that same address. Two entries, both legal, one room. Dialled as-is,
 * this daemon opens two sockets to one rendezvous — which claims the slot from itself, since a
 * rendezvous holds the incumbent's place until a dead socket is swept — and publishes the address
 * twice to every device, so a browser walks the same failure twice before trying anything else.
 *
 * THE BOOT REFUSES RATHER THAN DEDUPLICATING. Silently dropping one entry would pick, on the
 * operator's behalf, between "I want Ferretry's hosted relay" and "I want mine" at a moment when
 * those two happen to be equal — and the choice would then flip by itself the day the advertisement
 * changes, with nothing said. The refusal names the address and both ways out.
 *
 * ONLY DIALLED ADDRESSES COLLIDE. An entry that is switched off opens no socket and publishes
 * nothing, so a configured relay kept in the file with `enabled: false` alongside the same discovered
 * address is not a duplicate — it is somebody who switched one of the two off, which is exactly the
 * remedy this refusal asks for.
 */
export function chooseRelayCarrierSources(
  relays: readonly DaemonRelayCarrierEntry[],
  advertised: RelayAdvertisement,
): ResolvedRelayCarriers {
  const sources = resolveEachRelayCarrier(relays, advertised);
  const dialled = new Set<string>();
  for (const source of sources) {
    const url = dialledRelayUrl(source);
    if (url === undefined) continue;
    if (dialled.has(url)) return { kind: 'refused', url, reason: duplicateRendezvousRefusal(url) };
    dialled.add(url);
  }
  return { kind: 'resolved', sources };
}

/** The sentence a boot prints when it refuses: the fault, the consequence, and both ways out. */
function duplicateRendezvousRefusal(url: string): string {
  return (
    `two relay carriers resolved to the same rendezvous ${url} — a relay written in this daemon’s ` +
    'configuration and the one the relay directory advertises are the same address, so this boot would ' +
    'open two sockets to one room and publish it to devices twice. Remove the configured entry to keep ' +
    'the hosted one, or switch the { "source": "discovery" } entry off in the top-level "relay" list to keep your own.'
  );
}

/** Each entry on its own terms, before the list is checked for a collision between them. */
function resolveEachRelayCarrier(
  relays: readonly DaemonRelayCarrierEntry[],
  advertised: RelayAdvertisement,
): readonly RelayCarrierSource[] {
  return relays.map(relay => {
    if (relayCarrierIsConfigured(relay)) {
      return {
        kind: 'configured' as const,
        config: DaemonRelayConfigSchema.parse({
          url: relay.url,
          enabled: relay.enabled,
          reconnectSeconds: relay.reconnectSeconds,
        }),
      };
    }
    if (!relay.enabled) {
      return {
        kind: 'direct-only' as const,
        reason: 'the discovery relay entry is switched off in this daemon’s configuration',
      };
    }
    const source = chooseRelayCarrierSource(undefined, advertised);
    if (source.kind !== 'discovered') return source;
    return {
      kind: 'discovered' as const,
      config: {
        ...source.config,
        reconnectSeconds: relay.reconnectSeconds,
      },
    };
  });
}

/**
 * Whether an operator's wider `publicUrl` can cross the device wire as a direct carrier.
 *
 * Configuration deliberately accepts more URL shapes than a device can use as a daemon origin: a
 * reverse-proxy path may be meaningful to another surface, and an operator's spelling remains their
 * fact. This seam applies the wire owner's narrower rule without turning that configuration into a
 * boot refusal, and carries the schema's own reason so every caller explains the same decision.
 */
export function publishableDirectCarrier(
  url: string,
): { readonly kind: 'ok'; readonly url: string } | { readonly kind: 'refused'; readonly reason: string } {
  const parsed = DaemonOriginSchema.safeParse(url);
  if (parsed.success) return { kind: 'ok', url: parsed.data };
  return {
    kind: 'refused',
    reason: parsed.error.issues.map(issue => issue.message).join('; ') || 'daemon address is not a publishable origin',
  };
}

/**
 * The publishable direct address, when there is one, the tunnel while its connector is registered, and
 * every relay this boot will actually dial — in that order (`docs/relay-protocol.md` §15).
 *
 * THE TUNNEL GOES AFTER DIRECT AND BEFORE THE RELAYS because that is the order of who is on the path:
 * direct has nobody, a tunnel has Cloudflare's edge, a relay has a rendezvous operator as well. A
 * browser's preference re-orders across kinds anyway; this is the daemon's own answer within them.
 *
 * `tunnelUrl` is a value a caller passes only while `cloudflared` reports a registered connection. An
 * address published while nothing serves it would send every device to dial a hostname that answers
 * Cloudflare's own error page, which is the stale-carrier failure the published set exists to end.
 */
export function publishedDaemonCarriers(
  directUrl: string | undefined,
  sources: readonly RelayCarrierSource[],
  tunnelUrl?: string,
): ReturnType<typeof PublishedCarriersSchema.parse> {
  return PublishedCarriersSchema.parse([
    ...(directUrl === undefined ? [] : [{ kind: 'direct' as const, url: directUrl }]),
    ...(tunnelUrl === undefined ? [] : [{ kind: 'tunnel' as const, url: tunnelUrl }]),
    ...sources.flatMap(source => {
      const url = dialledRelayUrl(source);
      return url === undefined ? [] : [{ kind: 'relay' as const, url }];
    }),
  ]);
}

/** The address this daemon will actually dial, or nothing. A switched-off block dials nothing. */
export function dialledRelayUrl(source: RelayCarrierSource): string | undefined {
  if (source.kind === 'direct-only') return undefined;
  return source.config.enabled ? source.config.url : undefined;
}

/**
 * THE CARRIER POSTURE, IN ONE LINE — the line the owner reaches for when something is wrong.
 *
 * Three answers, and naming WHICH is the whole value: "hosted" and "self-hosted" differ in who can
 * switch the carrier off, and "direct-only" is not a state anybody should have to infer from the
 * absence of a line.
 */
export function describeRelayCarrierPosture(source: RelayCarrierSource, configFile: string): string {
  const label = 'carrier     ';
  if (source.kind === 'discovered') {
    return `${label} hosted — ${source.config.url}, from Ferretry’s runtime advertisement`;
  }
  if (source.kind === 'configured') {
    return source.config.enabled
      ? `${label} self-hosted — ${source.config.url}, from ${configFile}`
      : `${label} direct-only — the relay ${source.config.url} is switched off in ${configFile}`;
  }
  return `${label} direct-only — ${source.reason}`;
}

export const PAIRING_REACH_NOTICE =
  'pairing tries this machine’s own address first, so a browser on the same network, a VPN, a tailnet ' +
  'or a public address pairs directly; a device that cannot reach it redeems the code through ' +
  'Ferretry’s hosted relay, and without that this address is the only way in — a rendezvous you run ' +
  'yourself cannot yet be found by a device that has never paired.';

/**
 * What a boot says when there is no carrier: the reason, the consequence, and what to do.
 *
 * THE CONSEQUENCE IS THE PART THAT WAS MISSING. The old notice printed one clause — "no relay is
 * configured, so this daemon is reachable only directly" — which is true, correct, and tells a
 * person with an unreachable phone nothing they can act on.
 *
 * The refusal a carrier reports for itself wins over this module's, because it is more specific: a
 * fingerprint that cannot address a rendezvous and a relay switched off in a document are both
 * conditions {@link decideRelayCarrier} names exactly.
 */
export function describeAbsentRelayCarrier(input: {
  readonly source: RelayCarrierSource;
  /** The carrier's own refusal, when it had one. */
  readonly carrierDetail: string | undefined;
  readonly configFile: string;
  /** The address this daemon binds. A loopback bind with no relay is a daemon nothing can pair with. */
  readonly host: string;
}): readonly string[] {
  const reason =
    input.source.kind === 'direct-only' ? input.source.reason : (input.carrierDetail ?? 'no reason reported');
  return [`no relay carrier — ${reason}`, ...relayCarrierRemedy(input.source, input.configFile, input.host)];
}

export function relayCarrierRemedy(source: RelayCarrierSource, configFile: string, host: string): readonly string[] {
  const relayEntry = `the top-level "relay" entry in config/${configFile}`;
  const relay =
    source.kind === 'configured'
      ? `this relay is explicitly configured, so correct or remove ${relayEntry} (it is what this daemon dials), then restart.`
      : source.kind === 'direct-only' && source.retrying === true
        ? `this daemon keeps asking the hosted relay directory in the background and dials the relay by itself once it answers; to stop depending on it, add ${relayEntry} naming a rendezvous you operate (docs/cloudflare-relay-self-hosting.md).`
        : `restart to ask the hosted relay directory again; to stop depending on it, add ${relayEntry} naming a rendezvous you ` +
          'operate (docs/cloudflare-relay-self-hosting.md).';
  return [
    'No relay is available, so another device cannot pair yet' +
      (isLoopbackHost(host)
        ? `; this daemon is bound to ${host}, and a browser on this machine can pair locally.`
        : `; this daemon is bound to ${host}, but it refuses direct connections from other machines.`),
    'Keep the daemon on a loopback listener ("fyd --host 127.0.0.1").',
    `${relay[0]!.toUpperCase()}${relay.slice(1)}`,
    '5.0 has no separate public-address setting, and widening the listener does not enable direct connections from other machines.',
  ];
}

/**
 * The read itself, as a port, because asking a remote service is not something a domain module does.
 *
 * It ANSWERS rather than throws: every failure a network read has is one of the `undetermined`
 * sentences above, so a directory that is down cannot take a boot with it.
 */
export interface RelayDirectoryPort {
  /** `signal` aborts a read in flight (the daemon is stopping); the answer to an aborted read is dropped by the caller. */
  read(signal?: AbortSignal): Promise<RelayAdvertisement>;
}
