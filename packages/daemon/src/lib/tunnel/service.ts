/**
 * WHETHER FERRETRY'S HOSTED SERVICE CAN PROVISION A TUNNEL AT ALL — `docs/relay-protocol.md` §15.
 *
 * The daemon half of `GET <hosted origin>/v1/tunnel-service`. It is asked from the SAME origin the
 * relay advertisement is read from (`relay/discovery.ts`), so no tunnel address is compiled in either:
 * what a build carries is a discovery origin, and whether that service provisions tunnels today is a
 * runtime answer its operator can change without a release.
 *
 * TWO ANSWERS, NOT THREE. The relay advertisement distinguishes "switched off" from "could not find
 * out" because they need different remedies. Here the contract folds them on purpose — "`available:
 * false` is 'not set up by the operator', not an error, and a read that fails is treated the same way"
 * — and both turn the carrier off. What survives is the REASON, which the boot says once.
 */

import { SocketEndpointSchema, TUNNEL_SERVICE_PATH, TunnelServiceAdvertisementSchema } from '@ferretry/relay';

/** How long a boot waits before treating silence from the service as "not available". */
export const TUNNEL_SERVICE_TIMEOUT_MS = 4_000;

export type TunnelServiceAvailability =
  /** The service provisions tunnels, at this origin — the one a provision request is signed for. */
  | { readonly kind: 'available'; readonly origin: string }
  /** It does not, or this daemon could not find out. The carrier is off and this is why. */
  | { readonly kind: 'unavailable'; readonly reason: string };

/** The answer when a build carries no hosted origin to ask — a local build, a fork, `off`. */
export const NO_TUNNEL_SERVICE: TunnelServiceAvailability = Object.freeze({
  kind: 'unavailable' as const,
  reason: 'this build carries no hosted service to ask',
});

/** The answer when nobody asked, because this daemon's tunnel entry is switched off. */
export const TUNNEL_SERVICE_NOT_ASKED: TunnelServiceAvailability = Object.freeze({
  kind: 'unavailable' as const,
  reason: 'the tunnel carrier is switched off, so the hosted service was not asked',
});

/**
 * The origin a tunnel is provisioned from, or nothing.
 *
 * The protocol's endpoint rule first — secure anywhere, insecure only against loopback, no query and
 * no fragment — then HTTP only: provisioning is two JSON POSTs, and a `wss:` spelling of the directory
 * is an address `fetch` cannot ask. The trailing slash is dropped so `${origin}${path}` is one path.
 */
export function tunnelServiceOrigin(origin: string): string | undefined {
  const parsed = SocketEndpointSchema.safeParse(origin);
  if (!parsed.success) return undefined;
  const protocol = new URL(parsed.data).protocol;
  return protocol === 'https:' || protocol === 'http:' ? parsed.data : undefined;
}

/** The advertisement's address under a provisioning origin. */
export function tunnelServiceAddress(origin: string): string {
  return `${origin}${TUNNEL_SERVICE_PATH}`;
}

/**
 * The host a provision or release is SIGNED for: the discovered origin's own spelling (§15), so a
 * hostile service cannot take a live challenge from an honest one and spend the answer elsewhere.
 */
export function tunnelServiceHost(origin: string): string {
  return new URL(origin).host;
}

/** Parse, do not validate: anything that is not exactly a version-1 advertisement is "not available". */
export function parseTunnelServiceAdvertisement(origin: string, value: unknown): TunnelServiceAvailability {
  const parsed = TunnelServiceAdvertisementSchema.safeParse(value);
  if (!parsed.success)
    return { kind: 'unavailable', reason: 'the hosted service answered a document this daemon cannot read' };
  if (!parsed.data.available)
    return { kind: 'unavailable', reason: 'the hosted tunnel service is not set up by its operator' };
  return { kind: 'available', origin };
}

/** The read itself, as a port. It answers rather than throws: a service that is down is "unavailable". */
export interface TunnelServicePort {
  read(): Promise<TunnelServiceAvailability>;
}
