/**
 * ASKING THE HOSTED SERVICE FOR THIS DAEMON'S TUNNEL — `docs/relay-protocol.md` §15 "Provisioning".
 *
 * Two calls per action: a challenge that mints a single-use nonce, then a provision (or release) that
 * signs it with the daemon's identity key — the key pairing minted, so the fingerprint the service
 * records is the one every paired device pins. The signed transcript and every shape on the wire are
 * `@ferretry/relay`'s `tunnel.ts`, shared with the Worker that answers, so the two cannot disagree.
 *
 * A DAEMON REFUSES TO SIGN A HOST IT DID NOT DISCOVER. The host is in the transcript so a hostile
 * service cannot spend an honest one's challenge elsewhere; that protection is only real if the
 * daemon signs exactly the host it read the advertisement from. The client is built with that origin
 * and refuses, before any key is used, a provisioner bound to any other.
 *
 * THE CONNECTOR TOKEN IS A CREDENTIAL. It comes back inside {@link TunnelProvision} and is held in
 * memory by whoever asked. Nothing in this module prints, logs or stores it, and no sentence below has
 * a slot one could be put into.
 */

import {
  type DaemonIdentity,
  fromBase64UrlFixed,
  NONCE_BYTES,
  type RelayCrypto,
  signTunnelRequest,
  type TunnelChallenge,
  type TunnelChallengeRequest,
  type TunnelProvision,
  type TunnelProvisionRequest,
  type TunnelRefusalCode,
  type TunnelRelease,
  type TunnelReleaseRequest,
} from '@ferretry/relay';
import { type BackoffPolicy, backoffDelayMs } from './schedule.ts';
import { tunnelServiceHost } from './service.ts';

/** What one call to the service came back with. */
export type ProvisionerAnswer<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The service refused, in its own words. */
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly code: TunnelRefusalCode | undefined;
      readonly message: string;
    }
  /** No answer this daemon could read: unreachable, timed out, or not a document. */
  | { readonly kind: 'failed'; readonly reason: string };

/** The hosted provisioner's three routes. One instance talks to ONE origin, and says which. */
export interface TunnelProvisionerPort {
  readonly origin: string;
  challenge(request: TunnelChallengeRequest): Promise<ProvisionerAnswer<TunnelChallenge>>;
  provision(request: TunnelProvisionRequest): Promise<ProvisionerAnswer<TunnelProvision>>;
  /** `released: false` is "this daemon held no tunnel" — an idempotent repeat, never an error. */
  release(request: TunnelReleaseRequest): Promise<ProvisionerAnswer<TunnelRelease>>;
}

export type ProvisioningOutcome<T> =
  | { readonly kind: 'done'; readonly value: T }
  /** Worth asking again later: an outage, capacity, the upstream API, a rate limit. */
  | { readonly kind: 'retry'; readonly reason: string }
  /** Not worth asking again this boot: the service rejected who this daemon is. */
  | { readonly kind: 'refused'; readonly reason: string };

/** Provisioning that fails for a reason that may clear waits 5 s, doubling to ten minutes, jittered. */
export const PROVISION_RETRY_BACKOFF: BackoffPolicy = Object.freeze({ baseMs: 5_000, capMs: 10 * 60_000 });

/** The wait before provisioning retry number `attempt`. */
export function provisionRetryDelayMs(attempt: number, random: () => number): number {
  return backoffDelayMs(PROVISION_RETRY_BACKOFF, attempt, random);
}

/**
 * Refusals that say nothing about this daemon — the service is out of room, rate-limiting, or its
 * Cloudflare API failed — so asking again later can succeed. `tunnel_claim_rejected` and
 * `tunnel_bad_request` are about the request itself and would fail identically every time.
 */
const RETRYABLE: ReadonlySet<TunnelRefusalCode> = new Set([
  'tunnel_unavailable',
  'tunnel_capacity',
  'tunnel_upstream_failed',
  'tunnel_rate_limited',
  'tunnel_challenge_expired',
]);

/** What a refusal or failure means for the next attempt, with the sentence the boot prints. */
export function classifyProvisionerAnswer(answer: Exclude<ProvisionerAnswer<unknown>, { kind: 'ok' }>): {
  readonly retry: boolean;
  readonly reason: string;
} {
  if (answer.kind === 'failed') return { retry: true, reason: answer.reason };
  const retry = answer.status >= 500 || (answer.code !== undefined && RETRYABLE.has(answer.code));
  const code = answer.code === undefined ? `${String(answer.status)}` : `${answer.code}, ${String(answer.status)}`;
  return { retry, reason: `the hosted service refused (${code}): ${answer.message}` };
}

export interface TunnelProvisioningClientDependencies {
  /** The origin the tunnel service was DISCOVERED at: the only host this client will sign. */
  readonly origin: string;
  readonly provisioner: TunnelProvisionerPort;
  readonly crypto: RelayCrypto;
  readonly identity: DaemonIdentity;
}

export class TunnelProvisioningClient {
  readonly #host: string;

  constructor(private readonly deps: TunnelProvisioningClientDependencies) {
    this.#host = tunnelServiceHost(deps.origin);
  }

  /** Creates or renews this daemon's tunnel, forwarding to `originPort` on loopback. */
  async provision(originPort: number): Promise<ProvisioningOutcome<TunnelProvision>> {
    const signed = await this.#signed('provision', originPort);
    if (signed.kind !== 'done') return signed;
    return settled(await this.deps.provisioner.provision({ ...signed.value, originPort }));
  }

  /**
   * Deletes this daemon's tunnel: its operator switched the carrier off. Asked ONCE: the service answers
   * without waiting on Cloudflare and finishes a failed upstream deletion itself, so an answered release
   * is never repeated (§15).
   */
  async release(): Promise<ProvisioningOutcome<TunnelRelease>> {
    const signed = await this.#signed('release', undefined);
    if (signed.kind !== 'done') return signed;
    return settled(await this.deps.provisioner.release(signed.value));
  }

  async #signed(
    action: 'provision' | 'release',
    originPort: number | undefined,
  ): Promise<ProvisioningOutcome<Awaited<ReturnType<typeof signTunnelRequest>>>> {
    const provisionerHost = tunnelServiceHost(this.deps.provisioner.origin);
    if (provisionerHost !== this.#host)
      return {
        kind: 'refused',
        reason: `this daemon refuses to sign for ${provisionerHost}, which is not the host it discovered (${this.#host})`,
      };
    const daemonId = this.deps.identity.daemonId;
    const challenge = await this.deps.provisioner.challenge({ daemonId });
    if (challenge.kind !== 'ok') return settled(challenge);
    // The schema already holds the nonce to 32 bytes of base64url; decoding cannot fail past it.
    const nonce = fromBase64UrlFixed(challenge.value.nonce, NONCE_BYTES) as Uint8Array;
    const value = await signTunnelRequest(this.deps.crypto, this.deps.identity, {
      action,
      daemonId,
      host: this.#host,
      nonce,
      ...(originPort === undefined ? {} : { originPort }),
    });
    return { kind: 'done', value };
  }
}

function settled<T>(answer: ProvisionerAnswer<T>): ProvisioningOutcome<T> {
  if (answer.kind === 'ok') return { kind: 'done', value: answer.value };
  const { retry, reason } = classifyProvisionerAnswer(answer);
  return retry ? { kind: 'retry', reason } : { kind: 'refused', reason };
}
