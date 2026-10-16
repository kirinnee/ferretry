import type { SecretName } from '@ferretry/protocol';

/**
 * Every boundary the speed-up keys cross.
 *
 * READ `docs/secrets.md` FIRST. The vault has a closed set of holders, and the whole "no route returns
 * a secret" property depends on that set staying closed. This subsystem adds exactly one holder —
 * {@link OutboundProviderAuthorizer} in `authorizer.ts` — and every other piece here (the dictation
 * clean-up, the Jev guard, the Test button) asks THAT holder to make a call on its behalf. None of them
 * is ever handed a value.
 */

/** One outbound HTTP call, fully described so the transport decides nothing. */
export interface OutboundHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** Request headers WITHOUT any credential. The authorizer adds the one it was asked to. */
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON body for a POST; absent for a GET. */
  readonly body?: string;
  readonly timeoutMs: number;
  /** Hard ceiling on the reply the transport may buffer before giving up. */
  readonly maxResponseBytes: number;
}

/**
 * What the transport observed. FACTS ONLY: whether the reply came, its status, its parsed JSON.
 * What a 401 or a timeout MEANS belongs to the caller — the enhancer and the guard read them
 * differently, and an adapter that decided would decide for both.
 */
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

/**
 * The opening half of the vault, exactly as narrow as the authorizer needs. `SecretVault` satisfies it;
 * so does a test double, which is the only reason it is an interface rather than the class.
 */
export interface SecretValueSource {
  values(): Promise<ReadonlyMap<SecretName, string>>;
}

/** How the credential rides on the request: `authorization: Bearer <value>` unless a provider says otherwise. */
export interface CredentialPlacement {
  /** A lower-case header name. */
  readonly header: string;
  /** Prefixed with one space, or absent for a bare value. */
  readonly scheme?: string;
}

/**
 * What the authorizer answers: everything the transport could observe, plus the three refusals it
 * makes itself before anything leaves the machine. None of them carries the value or the request.
 */
export type AuthorizedOutcome =
  | OutboundOutcome
  /** The store holds no value under that name, or only whitespace. */
  | { readonly kind: 'secret_missing' }
  /** The store could not be opened. NEVER reported as missing: see `SecretStoreError`. */
  | { readonly kind: 'vault_damaged' }
  /**
   * Nothing was sent: the URL is not HTTPS, its host is not one this secret may reach, or the caller
   * tried to place the credential header itself.
   */
  | { readonly kind: 'refused' };

/** One authenticated outbound call, as every speed-up consumer sees it. */
export interface OutboundAuthorizerPort {
  send(
    secretName: SecretName,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome>;
}

/** Names and change instants of what the store holds — `SecretDirectory.list()` satisfies it. */
export interface SecretNameSource {
  list(): Promise<readonly { readonly name: SecretName; readonly updatedAt: string }[]>;
}

/**
 * The last Test of each provider, as it rests. `read` hands back raw parsed JSON (or `undefined`), and
 * the domain decides what a damaged document means — here, simply "never tested".
 */
export interface SpeedupTestLedgerPort {
  read(): Promise<unknown>;
  write(document: unknown): Promise<void>;
}

/** Monotonic milliseconds for latency, and the wall-clock instant a result is stamped with. */
export interface SpeedupClockPort {
  monotonicMs(): number;
  now(): string;
}
