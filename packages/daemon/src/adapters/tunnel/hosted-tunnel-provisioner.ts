/**
 * THE HOSTED PROVISIONER'S THREE ROUTES, OVER HTTPS — `docs/relay-protocol.md` §15 "Provisioning".
 *
 * Bound to ONE origin, which it states, so the domain can refuse to sign for any host but the one it
 * discovered before a request is even built. Every answer is parsed through `@ferretry/relay`'s shared
 * schemas: a 2xx that is not exactly the documented shape is a failure, not a partial success, and a
 * refusal is read as the service's `{ error: { code, message } }` when it is one.
 *
 * THE PROVISION ANSWER CARRIES THE CONNECTOR TOKEN. It is returned to the caller and nothing here keeps,
 * logs or prints it; no sentence below quotes a response body.
 */

import {
  TUNNEL_CHALLENGE_PATH,
  TUNNEL_PROVISION_PATH,
  TUNNEL_RELEASE_PATH,
  TunnelChallengeSchema,
  TunnelProvisionSchema,
  TunnelRefusalSchema,
  TunnelReleaseSchema,
} from '@ferretry/relay';
import type { z } from 'zod';
import type { ProvisionerAnswer, TunnelProvisionerPort } from '../../lib/tunnel/index.ts';

/** How long one provisioning call may take before it is a failure to retry. */
export const TUNNEL_PROVISION_TIMEOUT_MS = 15_000;

export type TunnelProvisionerFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostedTunnelProvisionerOptions {
  readonly fetcher?: TunnelProvisionerFetch;
  readonly timeoutMs?: number;
}

export class HostedTunnelProvisioner implements TunnelProvisionerPort {
  private readonly fetcher: TunnelProvisionerFetch;
  private readonly timeoutMs: number;

  constructor(
    readonly origin: string,
    options: HostedTunnelProvisionerOptions = {},
  ) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? TUNNEL_PROVISION_TIMEOUT_MS;
  }

  challenge(request: object) {
    return this.post(TUNNEL_CHALLENGE_PATH, request, TunnelChallengeSchema);
  }

  provision(request: object) {
    return this.post(TUNNEL_PROVISION_PATH, request, TunnelProvisionSchema);
  }

  release(request: object) {
    return this.post(TUNNEL_RELEASE_PATH, request, TunnelReleaseSchema);
  }

  private async post<S extends z.ZodType>(
    path: string,
    body: object,
    schema: S,
  ): Promise<ProvisionerAnswer<z.output<S>>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        // A redirect would hand the signed body, and the answer carrying the connector token, to a host
        // this daemon never discovered.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'failed', reason: 'this daemon could not reach the hosted tunnel service' };
    }
    const document = await response.json().catch(() => undefined);
    if (response.ok) {
      const parsed = schema.safeParse(document);
      return parsed.success
        ? { kind: 'ok', value: parsed.data }
        : {
            kind: 'failed',
            reason: `the hosted tunnel service answered ${path} with a document this daemon cannot read`,
          };
    }
    const refusal = TunnelRefusalSchema.safeParse(document);
    return refusal.success
      ? { kind: 'refused', status: response.status, code: refusal.data.error.code, message: refusal.data.error.message }
      : {
          kind: 'refused',
          status: response.status,
          code: undefined,
          message: `${path} answered ${String(response.status)}`,
        };
  }
}
