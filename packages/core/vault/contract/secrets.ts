import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/**
 * Secrets: values ferrets use by name and never see (§2.2, docs/secrets.md). Today's `protocol/src/lib/secrets.ts`,
 * field for field. A value travels IN on `PutSecretBodySchema` and never travels back: there is no schema for a
 * value on its way out, and no getter on the port. `${secret:NAME}` is the ONE reference grammar.
 */

export const MAX_SECRET_NAME_LENGTH = 64;
export const MAX_SECRETS_PER_DAEMON = 256;
export const MIN_SECRET_VALUE_LENGTH = 8;
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

export const SECRET_REFERENCE_SOURCE = '\\$\\{secret:([A-Z][A-Z0-9_]{0,63})\\}';
export const secretReferencePattern = (): RegExp => new RegExp(SECRET_REFERENCE_SOURCE, 'gu');
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
