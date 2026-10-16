import { isLoopbackHost, type SecretName } from '@ferretry/protocol';
import { SecretStoreError } from '../secrets/types.ts';
import type {
  AuthorizedOutcome,
  CredentialPlacement,
  OutboundAuthorizerPort,
  OutboundHttpRequest,
  OutboundTransport,
  SecretValueSource,
} from './ports.ts';

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
export class OutboundProviderAuthorizer implements OutboundAuthorizerPort {
  constructor(
    private readonly vault: SecretValueSource,
    private readonly transport: OutboundTransport,
  ) {}

  async send(
    secretName: SecretName,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement: CredentialPlacement = DEFAULT_PLACEMENT,
  ): Promise<AuthorizedOutcome> {
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
    return outcome;
  }
}

const DEFAULT_PLACEMENT: CredentialPlacement = { header: 'authorization', scheme: 'Bearer' };

/**
 * `https:` to an exactly-listed host (port included when one is written) — or plain `http:` to an
 * exactly-listed host on THIS machine, where a key never crosses a network (a LiteLLM proxy on
 * localhost, docs/provider-presets.md). Nothing else.
 */
export function allowedDestination(url: string, hostAllowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return hostAllowlist.includes(parsed.host.toLowerCase());
}

function carriesHeader(headers: Readonly<Record<string, string>>, header: string): boolean {
  return Object.keys(headers).some(name => name.toLowerCase() === header.toLowerCase());
}

/** Whether a parsed reply contains the credential anywhere in its serialisation. */
function echoes(payload: unknown, value: string): boolean {
  return JSON.stringify(payload ?? null).includes(value);
}
