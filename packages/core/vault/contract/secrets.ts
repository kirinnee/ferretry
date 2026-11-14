import { InstantSchema } from '@ferretry/std';
import {
  MIN_SECRET_VALUE_LENGTH,
  SECRET_REFERENCE_SOURCE,
  secretReferencePattern,
} from '@ferretry/std/secret-reference';
import { z } from 'zod';

/** The pointer grammar and the shortest value the store keeps: declared once in `@ferretry/std`, re-exported here. */
export { MIN_SECRET_VALUE_LENGTH, SECRET_REFERENCE_SOURCE, secretReferencePattern };

/**
 * Secrets: values ferrets use by name and never see (§2.2, docs/secrets.md). Today's `protocol/src/lib/secrets.ts`,
 * field for field. A value travels IN on `PutSecretBodySchema` and never travels back: there is no schema for a
 * value on its way out, and no getter on the port. `${secret:NAME}` is the ONE reference grammar.
 */

export const MAX_SECRET_NAME_LENGTH = 64;
export const MAX_SECRETS_PER_DAEMON = 256;
export const MAX_SECRET_VALUE_LENGTH = 16 * 1024;

export const SecretNameSchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_NAME_LENGTH)
  .regex(/^[A-Z][A-Z0-9_]*$/u, 'a secret name is uppercase letters, digits and underscores');
export type SecretName = z.infer<typeof SecretNameSchema>;

/** A value on its way IN. Not trimmed: whitespace can be load-bearing in a key. */
export const SecretValueSchema = z.string().min(MIN_SECRET_VALUE_LENGTH).max(MAX_SECRET_VALUE_LENGTH);

/** What a listing says about one secret: its name and times, never a value or a digest of one. */
export const SecretSummarySchema = z.strictObject({
  name: SecretNameSchema,
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

export const secretReference = (name: SecretName): string => `\${secret:${name}}`;

export function secretReferencesIn(value: string): readonly SecretName[] {
  const seen: SecretName[] = [];
  for (const match of value.matchAll(secretReferencePattern())) {
    const name = match[1];
    if (name !== undefined && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** The first `${secret:…}` that is not a well-formed reference, so it is refused rather than left unresolved. */
export function malformedSecretReference(value: string): string | undefined {
  const remainder = value.replace(secretReferencePattern(), '');
  return /\$\{secret:[^}]*\}?/u.exec(remainder)?.[0];
}

/**
 * AN OPTIONAL REFERENCE, for a ferret child's environment only. A variable whose WHOLE value is `${secret?:NAME}` is
 * set to the secret when the Vault holds it, and left UNSET when it does not; `${secret:NAME}` refuses the launch
 * instead (S64), and every other reference keeps that rule.
 *
 * It exists for MCP's sign-in variables. MCP names a token it saw HELD, but the Vault opens the references only once
 * every launch part has answered; a sign-out landing in between must not refuse the launch (today the launch read the
 * value once into its environment and never refused). It names nothing `${secret:NAME}` could not, and it carries a
 * name, never a value. Only `childEnvironment` reads it, and only as a whole value: anywhere else, or inside a longer
 * value, it is plain text.
 */
export const OPTIONAL_SECRET_REFERENCE_SOURCE = '^\\$\\{secret\\?:([A-Z][A-Z0-9_]{0,63})\\}$';
export const optionalSecretReference = (name: SecretName): string => `\${secret?:${name}}`;

/** The secret a variable's whole value optionally names (`${secret?:NAME}`), else `undefined`. */
export function optionalSecretReferenceOf(value: string): SecretName | undefined {
  return new RegExp(OPTIONAL_SECRET_REFERENCE_SOURCE, 'u').exec(value)?.[1];
}

/** What a masked value reads as. */
export const secretMask = (name: SecretName): string => `[redacted:${name}]`;

// ─── use ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_SECRET_USE_ARGV = 64;
export const MAX_SECRET_USE_ARGUMENT_LENGTH = 8 * 1024;
export const MAX_SECRET_USE_OUTPUT_BYTES = 256 * 1024;
export const SECRET_USE_DEFAULT_TIMEOUT_MS = 60_000;
export const SECRET_USE_MAX_TIMEOUT_MS = 600_000;

/** Run a command with secrets in ITS environment and in nothing else's (today's `SecretUseRequestSchema`). */
export const SecretUseRequestSchema = z.strictObject({
  command: z.array(z.string().min(1).max(MAX_SECRET_USE_ARGUMENT_LENGTH)).min(1).max(MAX_SECRET_USE_ARGV).readonly(),
  /** Absolute; a relative one is refused rather than resolved. */
  cwd: z.string().min(1),
  secrets: z.array(SecretNameSchema).max(MAX_SECRETS_PER_DAEMON).readonly().default([]),
  /** Extra environment; values may contain `${secret:NAME}`. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).default({}),
  timeoutMs: z.number().int().positive().max(SECRET_USE_MAX_TIMEOUT_MS).default(SECRET_USE_DEFAULT_TIMEOUT_MS),
});
export type SecretUseRequest = z.input<typeof SecretUseRequestSchema>;
export type SecretUseCommand = z.output<typeof SecretUseRequestSchema>;

export const SecretUseOutcomeSchema = z.enum(['exited', 'timeout', 'spawn_failed']);
export type SecretUseOutcome = z.infer<typeof SecretUseOutcomeSchema>;

/** What a use produced, AFTER masking (S14). `used` is names only: the audit trail. */
export const SecretUseResultSchema = z.strictObject({
  outcome: SecretUseOutcomeSchema,
  exitCode: z.number().int().optional(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  used: z.array(SecretNameSchema).readonly(),
});
export type SecretUseResult = z.infer<typeof SecretUseResultSchema>;

/** `masks_unavailable`: a declared mask provider could not open, so nothing was run (a child must never spawn unmaskable). */
export type SecretUseRefusal = 'invalid_cwd' | 'unknown_secret' | 'masks_unavailable';

// ─── authorized fetch ─────────────────────────────────────────────────────────────────────────────────────────────

/** One outbound HTTP request a plugin wants a secret placed on (today's `OutboundHttpRequest`). */
export interface OutboundHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

/** Where the value goes: a header, with an optional scheme (`Bearer`). Default `authorization: Bearer`. */
export interface CredentialPlacement {
  readonly header: string;
  readonly scheme?: string;
}

/**
 * The request as DATA (S162). A boundary that checks a request and then sends it parses it ONCE with this schema and
 * checks and sends only the parsed copy: every field is a plain string, number or record of strings, so neither a getter
 * nor an object whose `toString` changes between the check and the use can show one host to the check and another to the
 * send. Bounds are today's callers' (positive whole numbers, string headers).
 */
export const OutboundHttpRequestSchema = z.strictObject({
  method: z.enum(['GET', 'POST']),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
});

/** {@link CredentialPlacement} as data, parsed once like {@link OutboundHttpRequestSchema}. */
export const CredentialPlacementSchema = z.strictObject({
  header: z.string().min(1),
  scheme: z.string().optional(),
});

/**
 * What came back (today's `AuthorizedOutcome`). No branch carries the request it built; a reply that echoes the value
 * is `unreadable`.
 */
export type AuthorizedOutcome =
  | { readonly kind: 'completion'; readonly payload: unknown }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'secret_missing' }
  | { readonly kind: 'vault_damaged' }
  | { readonly kind: 'refused' };

/**
 * Today's `allowedDestination`: `https:` to an exactly listed host (port included when written), or plain `http:` to
 * an exactly listed host on this machine; never userinfo. Pure, so a fake and the real port agree.
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

// ─── a credentialed exchange for a secret the caller MINTED ───────────────────────────────────────────────────────

/**
 * One request a plugin wants sent with a secret IT minted placed on it, answered as the reply itself (an MCP server's
 * event stream cannot be reduced to one parsed document, which is why {@link OutboundHttpRequest} will not do). The
 * value is placed by the Vault inside the call and appears in nothing it returns. The abort `signal` is the caller's.
 */
export interface MintedExchangeRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** The most of the reply body to keep ({@link MINTED_DEFAULT_BODY_BYTES} when absent); a larger one is dropped. */
  readonly maxBodyBytes?: number;
}

/**
 * The most a caller may ask a minted exchange to keep of one reply body, and what it gets when it does not say: a
 * reply larger than this is DROPPED, never clipped (a clip could split the credential and leave half of it unmasked).
 */
export const MINTED_DEFAULT_BODY_BYTES = 1024 * 1024;
export const MINTED_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The reply headers a minted exchange passes on, by name. Everything else the server sent stays inside the Vault: a
 * header is a place a credential can be echoed that nobody thinks to look, so the answer is a short list, not a mask.
 * The values of these are masked too.
 */
export const MINTED_REPLY_HEADERS: readonly string[] = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'www-authenticate',
  'retry-after',
];

/**
 * A reply's body as the Vault sanitized it, never the stranger's own bytes. Only a body the Vault can PARSE is
 * returned: `text` is one JSON document, parsed in the Vault with every string checked (a string any decoded form of which
 * holds the value is replaced whole) and written back; `events` is an event stream as COMPLETE rebuilt events, one string
 * each (an event ends with its blank line), whose `data` is parsed and checked the same way, which the caller reads until it
 * has what it needs and then cancels. `dropped` is the fail-closed answer: the body is not JSON (HTML, XML, plain text,
 * binary, compressed or undecodable bytes) or passed a size or depth bound, so the Vault keeps it and says why in a
 * sentence of its own.
 */
export type MintedBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'events'; readonly events: ReadableStream<string> }
  | { readonly kind: 'dropped'; readonly why: string };

/**
 * What a minted exchange answered. A `response` is REQUEST-SCOPED DATA built inside the Vault, the holder of the
 * credential that was sent: the status, a masked `statusText`, the allowlisted headers ({@link MINTED_REPLY_HEADERS}) with
 * values checked, and a {@link MintedBody} parsed and checked against the value AS SENT: each string is read in every
 * form the Vault can decode (URI, HTML entity, backslash, hex, base64 and base64url) and replaced whole if any holds the
 * value. A value a server split across two strings is out of scope. It is still a stranger's text, so a caller scrubs it
 * as it scrubs any server's words. No branch carries the request it
 * built. `unreachable.certificate` says the failure was a certificate or TLS refusal.
 */
export type MintedExchangeOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly statusText: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: MintedBody;
    }
  | { readonly kind: 'refused' }
  | { readonly kind: 'secret_missing' }
  | { readonly kind: 'vault_damaged' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unreachable'; readonly certificate: boolean };

/** The mask a minted exchange puts where the credential would have been echoed. */
export const MINTED_ECHO_MASK = '[redacted]';

/** {@link MintedExchangeRequest} as data, parsed once like {@link OutboundHttpRequestSchema} (the signal is the caller's own). */
export const MintedExchangeRequestSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'DELETE']),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  maxBodyBytes: z.number().int().positive().max(MINTED_MAX_BODY_BYTES).optional(),
});
