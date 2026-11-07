import {
  allowedDestination,
  type AuthorizedOutcome,
  type CredentialPlacement,
  type OutboundHttpRequest,
  type SecretName,
} from '../../../contract/index.ts';
import { SecretStoreError } from './types.ts';

/** What the transport could observe (today's `speedups/ports.ts` `OutboundOutcome`). */
export type OutboundOutcome =
  | { readonly kind: 'completion'; readonly payload: unknown }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly cause?: unknown };

/** The network capability. The ONLY thing allowed to hold one with a credential in it is the authorizer. */
export interface OutboundTransport {
  send(request: OutboundHttpRequest): Promise<OutboundOutcome>;
}

/** The opening half of the vault, exactly as narrow as the authorizer needs. `SecretVault` satisfies it. */
export interface SecretValueSource {
  values(): Promise<ReadonlyMap<SecretName, string>>;
}

/**
 * THE FIFTH VAULT HOLDER. Read `docs/secrets.md` before changing anything here.
 *
 * The daemon's other four holders — the redactor, the use executor, the fleet launch environment and
 * the MCP sign-in service — each open the vault for one job and return nothing they read. This one has
 * one job too: put ONE named secret on ONE outbound HTTPS request to a host that secret is allowed to
 * reach, and hand back only what came back.
 *
 * WHAT IT GUARANTEES, and how:
 *
 * - **The value never leaves through a return.** {@link send} answers an {@link AuthorizedOutcome}: a
 *   status, a parsed reply, or a refusal kind. No branch carries the request it built.
 * - **The value only reaches an allowlisted host.** The caller names the hosts; the URL must be
 *   `https:` (or `http:` to this machine) and its host must be one of them, compared exactly, or nothing is sent. A caller that
 *   built a URL from configuration cannot point a Groq key at somebody else's server by accident.
 * - **A reply that echoes the value is not a reply.** A provider that reflected the credential back
 *   (a debugging proxy, a misconfigured gateway) would otherwise hand it to a caller that may log or
 *   render the payload. Such a reply is reported `unreadable`, as if it had never parsed.
 * - **The caller cannot place a credential itself.** A request that already carries the credential
 *   header is refused, so the only credential on the wire is the one this class put there.
 *
 * WHAT IT DOES NOT DO: decide what a 401 means, retry, or budget. Those are the caller's.
 */
export class OutboundProviderAuthorizer {
  constructor(
    private readonly vault: SecretValueSource,
    private readonly transport: OutboundTransport,
  ) {}

  async send(
    secretName: SecretName,
    allowlist: readonly string[],
    asked: OutboundHttpRequest,
    credentialPlacement: CredentialPlacement = DEFAULT_PLACEMENT,
  ): Promise<AuthorizedOutcome> {
    // What the caller passed is read ONCE into data of our own: the URL checked is the URL sent, whatever a getter on
    // the caller's object would answer the second time.
    const request = { ...asked, headers: { ...asked.headers } };
    const hostAllowlist = [...allowlist];
    const placement = { ...credentialPlacement };
    if (!allowedDestination(request.url, hostAllowlist)) return { kind: 'refused' };
    if (carriesHeader(request.headers, placement.header)) return { kind: 'refused' };

    let value: string | undefined;
    try {
      value = (await this.vault.values()).get(secretName)?.trim();
    } catch (error) {
      if (error instanceof SecretStoreError) return { kind: 'vault_damaged' };
      throw error;
    }
    if (value === undefined || value.length === 0) return { kind: 'secret_missing' };

    const credential = placement.scheme === undefined ? value : `${placement.scheme} ${value}`;
    const outcome = await this.transport.send({
      ...request,
      headers: { ...request.headers, [placement.header]: credential },
    });
    if (outcome.kind === 'completion' && echoes(outcome.payload, value)) return { kind: 'unreadable' };
    return outcome.kind === 'unreachable' ? { kind: 'unreachable' } : outcome;
  }
}

const DEFAULT_PLACEMENT: CredentialPlacement = { header: 'authorization', scheme: 'Bearer' };

function carriesHeader(headers: Readonly<Record<string, string>>, header: string): boolean {
  return Object.keys(headers).some(name => name.toLowerCase() === header.toLowerCase());
}

/** Whether a parsed reply contains the credential anywhere in its serialisation. */
function echoes(payload: unknown, value: string): boolean {
  return JSON.stringify(payload ?? null).includes(value);
}
