/**
 * WHETHER A FALLBACK CARRIER IS ADVERTISED, ASKED AT RUNTIME.
 *
 * The arrangement is that a browser dials the daemon DIRECTLY when it can, and
 * Ferretry's hosted relay carries the ciphertext when it cannot. Which of those
 * is available is asked at runtime rather than assumed: the relay's operator can
 * withdraw it without an app release, and a page that treated a shipped origin as
 * a live service would keep offering a carrier that had already been switched off.
 *
 * THE DISCOVERY CONTRACT IS `docs/relay-protocol.md` §13, and it is not ours:
 *
 *     GET <hosted-relay-origin>/v1/default-relay      Cache-Control: no-store
 *     { "version": 1, "relayUrl": "https://…" }   or  { "version": 1, "relayUrl": null }
 *
 * `null` IS THE KILL SWITCH — "disabled", not an empty address and not permission
 * to guess. That is the relay package's own wording, and the reason `disabled` is
 * a state of its own here rather than a missing field.
 *
 * WHERE THE DIRECTORY'S ORIGIN COMES FROM: A BUILD CONSTANT, AND NOT A GUESS.
 *
 * The PWA is served from Cloudflare Pages and the hosted relay is a SEPARATE
 * Worker origin. Pages stays static — no Functions, no proxy — so a relative
 * `/v1/default-relay` would NOT reach the Worker: an unrouted path is rewritten
 * to this app's own HTML, a 200 that is not an advertisement. The relay therefore
 * gets its own hostname, and that one shared, non-user-identifying origin is
 * baked in at build time by `vite.config.ts` from `FY_RELAY_DIRECTORY_ORIGIN`.
 *
 * The constant is an ORIGIN, not an address anyone has to trust: the kill switch
 * still lives behind it, so `null` withdraws the relay without an app release,
 * and nothing user-identifying is in the bundle. If the variable is unset — a
 * local build, a fork, a deploy that has not configured it — there is NO
 * directory, this module makes no request, and the answer is `undetermined`. It
 * never invents a hostname.
 *
 * ONE THING IS STILL HONESTLY MISSING, and this module refuses to paper over it:
 * NO CLIENT SPEAKS THE RELAY PROTOCOL YET. `packages/relay` is complete and
 * tested, and neither `packages/daemon` nor `packages/pwa` mounts it, so even an
 * advertised address is not dialled by anything today. `TRANSPORT_NOT_WIRED_NOTE`
 * says exactly that, on the glass, rather than implying a fallback that would not
 * happen. This module is the discovery half, proved; the transport half is a
 * separate unit and the screen does not pretend otherwise.
 */

/** The public discovery path from `docs/relay-protocol.md` §13, joined onto the configured origin. */
export const HOSTED_RELAY_PATH = '/v1/default-relay';

/** The only advertisement version this page understands. */
export const HOSTED_RELAY_ADVERTISEMENT_VERSION = 1;

/** How long the page waits before treating silence as "does not know". */
export const HOSTED_RELAY_TIMEOUT_MS = 4_000;

/**
 * What this page knows about the fallback carrier.
 *
 * Four states, because there are four genuinely different things to say, and
 * three of them are wrong to say as any of the others.
 */
export type HostedRelayFallback =
  /** The answer has not arrived yet. */
  | { readonly kind: 'checking' }
  /** A relay is advertised, at this address. */
  | { readonly kind: 'available'; readonly relayUrl: string }
  /** The operator has switched the advertisement off. Direct is the only carrier. */
  | { readonly kind: 'disabled' }
  /** This page could not find out. Treated as no fallback, and said as ignorance. */
  | { readonly kind: 'undetermined'; readonly reason: string };

export const CHECKING_HOSTED_RELAY: HostedRelayFallback = Object.freeze({ kind: 'checking' as const });

const undetermined = (reason: string): HostedRelayFallback => ({ kind: 'undetermined', reason });

/**
 * The answer when this build has no directory to ask.
 *
 * Exported because it is a state a real deployment can be in — an unset build
 * variable, a fork, a local `vite build` — and a reader deserves the real reason
 * rather than a network error that never happened.
 */
export const NO_RELAY_DIRECTORY: HostedRelayFallback = Object.freeze(
  undetermined('this build has no relay directory to ask'),
);

/**
 * The origin baked in at build time, or nothing.
 *
 * `vite.config.ts` replaces this identifier with a string literal from
 * `FY_RELAY_DIRECTORY_ORIGIN`, which the Pages workflow takes from the same
 * repository variable the hosted relay's own deploy uses. Read through `typeof`
 * because every other consumer of this module — the unit suite, the review
 * harness, a `bun build` of either — has no such define, and a free identifier
 * would throw rather than degrade.
 *
 * An empty string is the unset case and is deliberately NOT a URL: there is no
 * fallback literal here, and an origin that fails the endpoint rule is refused
 * downstream rather than dialled.
 */
declare const __FY_RELAY_DIRECTORY__: string | undefined;

export const bundledRelayDirectory = (): string | undefined => {
  const configured = typeof __FY_RELAY_DIRECTORY__ === 'string' ? __FY_RELAY_DIRECTORY__ : '';
  return configured === '' ? undefined : configured;
};

/**
 * A dialable endpoint, by the same rule the relay protocol draws.
 *
 * Secure schemes anywhere, insecure only against loopback — the line the
 * published site's content-security-policy draws too, so drawing it differently
 * here would make one of the two a lie. A query or fragment on a socket address
 * is a sign the value is not what its sender thought it was.
 */
const dialableEndpoint = (value: string): string | undefined => {
  if (value.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
  if (!secure && !(insecure && loopback)) return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  return url.toString().replace(/\/$/u, '');
};

/**
 * Parse, do not validate: anything that is not exactly a version-1 advertisement
 * carrying either `null` or one dialable endpoint is `undetermined`.
 */
export const parseHostedRelayAdvertisement = (value: unknown): HostedRelayFallback => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undetermined('the answer was not a document');
  const fields = value as Record<string, unknown>;
  if (fields.version !== HOSTED_RELAY_ADVERTISEMENT_VERSION) {
    return undetermined('the answer used a version this page does not understand');
  }
  const { relayUrl } = fields;
  /* Null is the operator's switch, and the one value that means something definite. */
  if (relayUrl === null) return { kind: 'disabled' };
  if (typeof relayUrl !== 'string') return undetermined('the answer carried no address');
  const endpoint = dialableEndpoint(relayUrl);
  if (endpoint === undefined) return undetermined('the advertised address is not one this browser may dial');
  return { kind: 'available', relayUrl: endpoint };
};

/** The narrow slice of `fetch` this read needs, injected so no suite dials out. */
export type HostedRelayFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostedRelayDirectory {
  /**
   * The origin the advertisement is served from, supplied at runtime.
   *
   * `undefined` is the state this build ships in and is not a failure to hide:
   * with no origin there is nothing to ask, so nothing is asked. A default here
   * would be the compiled address the whole design exists to avoid.
   */
  readonly directoryUrl?: string | undefined;
  readonly fetcher: HostedRelayFetch;
}

/**
 * Asks the advertisement, and never throws.
 *
 * Every failure is an answer — `undetermined` — because a rejected promise here
 * would take a setup screen down over a carrier the reader may not even need.
 * `no-store` is sent because the switch is meant to be immediate; a cached
 * advertisement is the kill switch not working.
 */
export const readHostedRelayFallback = async ({
  directoryUrl,
  fetcher,
}: HostedRelayDirectory): Promise<HostedRelayFallback> => {
  if (directoryUrl === undefined) return NO_RELAY_DIRECTORY;
  const origin = dialableEndpoint(directoryUrl);
  if (origin === undefined)
    return undetermined('the configured relay directory is not an address this browser may ask');
  let response: Response;
  try {
    response = await fetcher(`${origin}${HOSTED_RELAY_PATH}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(HOSTED_RELAY_TIMEOUT_MS),
    });
  } catch {
    return undetermined('this page could not reach the relay directory');
  }
  if (!response.ok) return undetermined(`the relay directory answered ${response.status}`);
  try {
    return parseHostedRelayAdvertisement(await response.json());
  } catch {
    return undetermined('the relay directory answered something that is not a document');
  }
};

/* ---------- what the screen says about all this --------------------------- */

/**
 * What the DEFAULT relay row on the connection chooser says about itself.
 *
 * The chooser in `onboarding-connection-chooser.tsx` offers three carriers; this
 * is the live fact the recommended one cannot state from a constant, because its
 * operator can withdraw it between a release and a reader arriving.
 */
export const HOSTED_RELAY_ROW_NOTE =
  'Ferretry runs this one. Direct is still used whenever the daemon is reachable; the relay carries the ' +
  'connection when it is not.';

/**
 * WHICH CARRIER IS ACTUALLY IN USE — the honest version.
 *
 * This line used to be the literal string `'Direct'`, passed in by the
 * composition root whenever anything was paired. That was a claim nothing had
 * measured, and it was the same claim whichever carrier the reader had chosen.
 *
 * What is true today: the only carrier the app dials IS direct, because nothing
 * mounts `packages/relay`. So a reader who chose a relay is told both — the
 * carrier in use, and that their choice is not the thing carrying it yet. When a
 * transport lands, this function is where the measured answer replaces the
 * derived one, and its callers do not change.
 */
export const activeCarrierStatus = (chosen: 'default-relay' | 'own-relay' | 'direct' | undefined): string => {
  if (chosen === 'default-relay') return 'Direct — the default relay is chosen, but nothing dials a relay yet.';
  if (chosen === 'own-relay') return 'Direct — your own relay is chosen, but nothing dials a relay yet.';
  return 'Direct — the only carrier this build dials.';
};

/**
 * The gap, said on the screen rather than only in a review.
 *
 * `packages/relay` is complete and tested and NOTHING mounts it: neither the
 * daemon nor this browser speaks the relay protocol yet. A step that showed a
 * relay address without saying this would be advertising a fallback that cannot
 * happen, which is worse than saying there is only one carrier.
 */
export const TRANSPORT_NOT_WIRED_NOTE =
  'Today only the direct path exists in the app: the relay protocol is implemented and deployed, but neither the ' +
  'daemon nor this browser dials it yet. So the daemon has to be reachable from here — same network, a VPN, a ' +
  'tailnet, or a public address — and this step will name the carrier in use once that connection can choose one.';

/**
 * The hosted carrier's cost, in the terms somebody actually cares about.
 *
 * Three lines rather than the full disclosure, because this is a setup step and
 * not the protocol document. `docs/relay-protocol.md` §13 is the authority and
 * `packages/relay`'s own `describeConnectionMethod` is the code that will own
 * this text once it is reachable from here; a third copy would be a third thing
 * to keep true.
 */
export const HOSTED_RELAY_DISCLOSURE = [
  'Ferretry and Cloudflare would see your daemon’s fingerprint, both IP addresses, and when and how much you connect.',
  'They could not read a byte of it: frames, device tokens, commands, output and names are encrypted end to end.',
  'The hosted relay is metered and capped per daemon, and its operator can switch it off without an app release.',
] as const;

/** Said when the switch is off, because "direct only" is a real constraint on the reader. */
export const HOSTED_RELAY_DISABLED_NOTE =
  'The hosted relay is switched off right now, so direct is the only carrier: this browser has to be able to ' +
  'reach the daemon itself — same network, a VPN, a tailnet or a public address.';

/** Said when the page does not know, which is neither of the other two. */
export const HOSTED_RELAY_UNDETERMINED_NOTE =
  'Treat the fallback as unavailable until this page can confirm it. Direct still works whenever the daemon is ' +
  'reachable, and pairing does not depend on the answer.';
