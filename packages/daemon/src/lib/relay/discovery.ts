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
 * working. Nothing here caches; the read happens once per boot, which is the shortest life a value
 * a daemon holds can have.
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

import { isLoopbackHost, PublishedCarriersSchema, WILDCARD_BIND_HOST } from '@ferretry/protocol';
import { HostedRelayAdvertisementSchema, SocketEndpointSchema } from '@ferretry/relay';
import { type DaemonRelayConfig, DaemonRelayConfigSchema } from '../runtime/config.ts';
import { type DaemonRelayCarrierEntry, relayCarrierIsConfigured } from '../runtime/carriers.ts';

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
  /** This daemon could not find out. Treated as no carrier, and said as ignorance. */
  | { readonly kind: 'undetermined'; readonly reason: string };

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
  | { readonly kind: 'direct-only'; readonly reason: string };

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
    'the hosted one, or switch the { "kind": "relay", "source": "discovery" } entry off to keep your own.'
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

/** The publishable direct address, when there is one, and every relay this boot will actually dial. */
export function publishedDaemonCarriers(
  directUrl: string | undefined,
  sources: readonly RelayCarrierSource[],
): ReturnType<typeof PublishedCarriersSchema.parse> {
  return PublishedCarriersSchema.parse([
    ...(directUrl === undefined ? [] : [{ kind: 'direct' as const, url: directUrl }]),
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

/**
 * WHAT PAIRING COSTS EVEN WHEN A RELAY IS DIALLED, said wherever a carrier is reported.
 *
 * A relayed session is opened with the device grant the pairing exchange has not issued yet
 * (`docs/relay-protocol.md` §13), so the FIRST contact with a daemon is always direct no matter what
 * carries the ones after it. Somebody who cannot pair is otherwise told a relay is up and left to
 * conclude the product is broken, which is exactly the week this text exists because of.
 */
export const PAIRING_IS_ALWAYS_DIRECT =
  'pairing itself always goes straight to the daemon, so a browser has to reach this machine ' +
  'directly once — same network, a VPN, a tailnet, or a public address.';

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

/**
 * The consequence and the remedy, without the reason — the lines every surface owes a reader whose
 * daemon dials nothing, whatever it already said about why.
 *
 * Separate from the sentence above it because `--check` states the posture in its own line and would
 * otherwise say the same thing twice, and because this is the part a person acts on.
 *
 * A LOOPBACK BIND WITH NO CARRIER IS THE WORST CASE AND GETS ITS OWN PATH. Naming only the relay
 * would leave the reader exactly as stuck as before: pairing is ALWAYS direct, so a daemon on
 * `127.0.0.1` that dials nothing cannot be paired with from another device at all, no matter what
 * happens to the relay afterwards. The order is what makes it actionable — bind every interface so
 * the network and loopback both keep working, advertise the one URL another device can dial, then
 * let a carrier keep it reachable after that device leaves the network.
 */
export function relayCarrierRemedy(source: RelayCarrierSource, configFile: string, host: string): readonly string[] {
  const relay =
    source.kind === 'configured'
      ? `the "relay" block of ${configFile} is what this daemon dials — correct it or remove it, then restart.`
      : 'a restart asks the relay directory again; to stop depending on it, point the "relay" block of ' +
        `${configFile} at a rendezvous you operate (docs/cloudflare-relay-self-hosting.md).`;
  if (!isLoopbackHost(host)) {
    return ['this daemon is reachable only from this machine’s own network: nothing off it can connect.', relay];
  }
  return [
    `this daemon is bound to ${host} and dials no relay, so NO other device can reach it — and because ` +
      'pairing is always direct, nothing can pair with it either.',
    `to pair: set "host" in ${configFile} to "${WILDCARD_BIND_HOST}" and set "publicUrl" to this ` +
      'machine’s URL on the local network, restart, and pair from a browser on that same network.',
    `to stay reachable once that browser leaves the network, a carrier is still needed — ${relay}`,
  ];
}

/**
 * The read itself, as a port, because asking a remote service is not something a domain module does.
 *
 * It ANSWERS rather than throws: every failure a network read has is one of the `undetermined`
 * sentences above, so a directory that is down cannot take a boot with it.
 */
export interface RelayDirectoryPort {
  read(): Promise<RelayAdvertisement>;
}
