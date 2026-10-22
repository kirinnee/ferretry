/**
 * WHETHER THE HOSTED TUNNEL SERVICE IS SET UP, ASKED ONCE PER DOCUMENT (`docs/relay-protocol.md` §15).
 *
 *     GET <directory origin>/v1/tunnel-service      Cache-Control: no-store
 *     { "version": 1, "available": true | false }
 *
 * The origin is the one the relay advertisement is read from (`hosted-relay.ts`), so no tunnel
 * address is compiled in either. `available: false` is "not set up by the operator", not an error —
 * and §15 says a read that FAILS is treated the same way, so every failure here is `unavailable` with
 * nothing thrown.
 *
 * WHAT THIS DECIDES IS ONLY A SENTENCE. A tunnel is dialled when the DAEMON published one, whatever
 * this says: the service provisions tunnels and does not carry them. This read exists so that "Tunnel
 * only" with no tunnel to dial can say WHY — the operator has not set the service up, or this machine
 * simply has not been given a tunnel yet.
 */

import { TUNNEL_SERVICE_PATH, TunnelServiceAdvertisementSchema } from '@ferretry/relay';
import { HOSTED_RELAY_TIMEOUT_MS, type HostedRelayFetch } from '../features/onboarding/hosted-relay.ts';
import { SocketEndpointSchema } from '@ferretry/relay';

/** What this document knows about the hosted tunnel service. */
export type TunnelServiceState = 'available' | 'unavailable';

export interface TunnelServiceDirectory {
  /** The relay directory's origin; `undefined` is a build with no directory, which is no service. */
  readonly directoryUrl?: string | undefined;
  readonly fetcher: HostedRelayFetch;
}

/** Asks the advertisement, and never throws. */
export const readTunnelService = async ({
  directoryUrl,
  fetcher,
}: TunnelServiceDirectory): Promise<TunnelServiceState> => {
  if (directoryUrl === undefined) return 'unavailable';
  const origin = SocketEndpointSchema.safeParse(directoryUrl);
  if (!origin.success) return 'unavailable';
  try {
    const response = await fetcher(`${origin.data}${TUNNEL_SERVICE_PATH}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(HOSTED_RELAY_TIMEOUT_MS),
    });
    if (!response.ok) return 'unavailable';
    const advertisement = TunnelServiceAdvertisementSchema.safeParse(await response.json());
    return advertisement.success && advertisement.data.available ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
};

/** Said when "Tunnel only" has nothing to dial because the operator has not set the service up. */
export const TUNNEL_NOT_SET_UP = 'not set up by the operator';

/** Said when the service is up but this machine published no tunnel. */
export const TUNNEL_NOT_YET = 'this machine has no tunnel yet';

/** Said when the machine itself says its tunnel is switched off — tunnels are opt-in per machine (§15). */
export const TUNNEL_SWITCHED_OFF = 'this machine’s tunnel is off (opt-in) — turn it on in Settings › Connection';

/** Why there is no tunnel to dial for a machine that published none. */
export const noTunnelReason = (service: TunnelServiceState): string =>
  service === 'available' ? TUNNEL_NOT_YET : TUNNEL_NOT_SET_UP;

/**
 * The note a selector shows under "Tunnel only" for one machine, as a sentence — or nothing when the
 * machine published a tunnel, or while the service has not answered yet (saying the wrong reason for
 * the moment it takes is worse than saying none).
 */
export const tunnelNote = (published: boolean, service: TunnelServiceState | undefined): string | undefined => {
  if (published || service === undefined) return undefined;
  const reason = noTunnelReason(service);
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
};
