/**
 * A plugin's OWN secret, resolved for its own daemon-side use (lead decision J: today's Browsers proxy credentials
 * into the Chrome launch). The kernel resolves one only when (1) the name is in the plugin's manifest
 * `permissions.secrets`, (2) the plugin's OWN configuration, as the owner wrote it and as it is in effect, names it as
 * a `${secret:NAME}` reference, and (3) the Vault knows it. The value never leaves through a log, a JSON body or a
 * string conversion: each of those shows `[secret:NAME]`; only {@link OwnSecret.reveal} gives the value.
 *
 * {@link SecretsPort.send} is the narrower way for a secret that only ever rides on an HTTP request (Warden's Jev key):
 * the kernel places it, and the plugin never holds it at all.
 */
import { SECRET_REFERENCE_SOURCE } from '@ferretry/std/secret-reference';
import { z } from 'zod';

/** The `${secret:NAME}` grammar: declared once in `@ferretry/std`, re-exported so this contract's callers keep one import. */
export { SECRET_REFERENCE_SOURCE };

/** Why a resolve answered no value. */
export type OwnSecretRefusal = 'not_declared' | 'not_configured' | 'unknown';

const values = new WeakMap<OwnSecret, string>();
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** An opaque secret value: masked in every printed or serialised form, revealed only on purpose. */
export class OwnSecret {
  readonly name: string;

  /** The kernel's to mint (`kernel.secrets.resolve`); a value built here by a plugin is only ever its own. */
  constructor(name: string, value: string) {
    this.name = name;
    values.set(this, value);
    Object.freeze(this);
  }

  /** The value, for the one place it is used (a launch argument, a header). Never log or return it. */
  reveal(): string {
    return values.get(this) ?? '';
  }

  toString(): string {
    return `[secret:${this.name}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](): string {
    return this.toString();
  }

  [INSPECT](): string {
    return this.toString();
  }
}

// ─── send: the kernel places the credential ──────────────────────────────────────────────────────────────────────

/** One outbound HTTP request a plugin asks the kernel to put one of its OWN secrets on (today's `OutboundHttpRequest`). */
export interface OutboundSecretRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** Request headers WITHOUT any credential: the kernel adds the one it was asked to. */
  readonly headers: Readonly<Record<string, string>>;
  /** A body for a POST; absent for a GET. */
  readonly body?: string;
  readonly timeoutMs: number;
  /** The most the kernel buffers of the reply before it answers `too_large`. */
  readonly maxResponseBytes: number;
}

/** Where the value goes: one header, with an optional scheme (`Bearer`). Default `authorization: Bearer <value>`. */
export interface CredentialPlacement {
  readonly header: string;
  readonly scheme?: string;
}

/**
 * The request as DATA (S162). The kernel parses what the plugin passed ONCE with this schema and checks and sends only
 * the parsed copy: every field is a plain string, number or record of strings, so neither a getter nor an object whose
 * `toString` answers differently the second time can show the check one host and the send another.
 */
export const OutboundSecretRequestSchema = z.strictObject({
  method: z.enum(['GET', 'POST']),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
});

/** {@link CredentialPlacement} as data, parsed once like {@link OutboundSecretRequestSchema}. */
export const CredentialPlacementSchema = z.strictObject({
  header: z.string().min(1),
  scheme: z.string().optional(),
});

/**
 * Why nothing was sent. The three {@link OwnSecretRefusal}s are `resolve`'s rule, in its order. `destination`: the
 * request did not parse, or its URL is not `https:` (or `http:` to this machine) to a host the manifest's
 * `permissions.network` names exactly. `placement`: the placement did not parse, or the request already carries the
 * placement header itself.
 */
export type OutboundSecretRefusal = OwnSecretRefusal | 'destination' | 'placement';

/**
 * What came back: facts only, and never the value, the request, a digest or an error message. `completion` is a 2xx
 * reply whose body parsed as JSON; `status` is any other reply, whose body is never read (a redirect included: it is
 * answered, never followed with the key); `network` is a request that never got a reply; `unreadable` is a reply that
 * did not parse, or one that ECHOES the value anywhere in it.
 */
export type OutboundSecretOutcome =
  | { readonly kind: 'completion'; readonly status: number; readonly payload: unknown }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'refused'; readonly refused: OutboundSecretRefusal }
  /** The Vault could not be opened. Never reported as `unknown`: a damaged store is not an absent key. */
  | { readonly kind: 'vault_damaged' };

/**
 * Today's `allowedDestination`: `https:` to an exactly listed host (port included when written), or plain `http:` to
 * an exactly listed host on this machine; never userinfo. Pure, so both hosts and a plugin's own narrowing agree.
 */
export function allowedDestination(url: string, hostAllowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return hostAllowlist.includes(parsed.host.toLowerCase());
}

/** `kernel.secrets`: daemon halves only. */
export interface SecretsPort {
  resolve(name: string): Promise<OwnSecret | { readonly refused: OwnSecretRefusal }>;
  /**
   * ONE request with the named OWN secret placed on it BY THE KERNEL: the plugin never holds the value (today's
   * `OutboundProviderAuthorizer.send`). The name passes `resolve`'s rule (declared, named by this plugin's own config
   * in effect, known to the Vault); the destination must be `https:` (or `http:` to this machine) to a host this
   * plugin's `permissions.network` names EXACTLY (a wildcard, an installed item or a resolver entry lets no key out),
   * and the request goes through this plugin's own `kernel.fetch` guard, so a redirect is answered, never followed. A
   * request that already carries the placement header is refused. The Vault is asked last, after every other check.
   * The kernel logs the name and the host only.
   */
  send(name: string, request: OutboundSecretRequest, placement?: CredentialPlacement): Promise<OutboundSecretOutcome>;
}
