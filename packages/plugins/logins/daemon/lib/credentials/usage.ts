import { z } from 'zod';
import { shellQuote } from '../shared/shell-quote.ts';

const finiteNumber = z.number().refine(Number.isFinite, 'expected a finite number');
const percentage = finiteNumber.min(0).max(100);
const epochMilliseconds = finiteNumber.int().nonnegative();

/**
 * WHAT THE FREE PROVIDER READ SAID ABOUT THE CREDENTIAL, as a closed classification.
 *
 * This exists because `authOk` cannot carry it. `authOk` answers one question — is this credential
 * repudiated — and it collapses three answers that mean different things into `true`: a `200` that
 * accepted the token, a `403` that accepted it and refused to show usage, and a `503` that said
 * nothing at all. Quota does not care which of those happened; a health verdict is nothing but that
 * distinction, and a build that turned the third into `healthy` would report a working account for
 * every provider outage.
 *
 * IT IS A CLASSIFICATION, NEVER MATERIAL. Every member is a fixed word chosen from an HTTP status,
 * so a row carrying one cannot carry a token, a header or a provider body. The reason the status is
 * mapped at the adapter rather than travelling as a number is that a consumer holding a number
 * writes its own table, and two tables are how `403` becomes a re-login for somebody.
 */
const FleetCredentialSignalSchema = z.enum([
  /** The provider answered for this token: it is currently accepted. */
  'accepted',
  /**
   * Anthropic-shaped JSON `403` from the read-only usage endpoint. The token is ACCEPTED and merely
   * lacks `user:profile`, which is permanent for an inference-scoped token. An HTML/WAF `403` is
   * inconclusive instead; the response fingerprint is what keeps those equal statuses apart.
   */
  'scope_unavailable',
  /** An explicit credential rejection. A bare control-plane `401` is not enough to produce this. */
  'rejected',
  /** `401` whose response cannot distinguish credential rejection from refusal of this HTTP client. */
  'rejection_unconfirmed',
  /** The request did not finish inside its deadline. Inconclusive, never a rejection. */
  'timeout',
  /** Reached, and said nothing usable: a 5xx, a 429, another 4xx, a transport failure. */
  'inconclusive',
  /** There was no readable token to ask with, so no request was made. */
  'absent',
]);

export type FleetCredentialSignal = z.infer<typeof FleetCredentialSignalSchema>;

/** JSON value kinds retained in a response fingerprint. Values themselves never travel. */
const ProviderResponseJsonTypeSchema = z.enum(['null', 'boolean', 'number', 'string', 'array', 'object']);
export type ProviderResponseJsonType = z.infer<typeof ProviderResponseJsonTypeSchema>;

export const ProviderResponseHeaderNameSchema = z.enum([
  'age',
  'anthropic-organization-id',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-5h-status',
  'anthropic-ratelimit-unified-5h-utilization',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-7d-status',
  'anthropic-ratelimit-unified-7d-utilization',
  'anthropic-request-id',
  'authorization',
  'cache-control',
  'cf-cache-status',
  'cf-mitigated',
  'cf-ray',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'date',
  'etag',
  'expires',
  'other',
  'pragma',
  'request-id',
  'retry-after',
  'retry-after-ms',
  'server',
  'set-cookie',
  'transfer-encoding',
  'vary',
  'via',
  'www-authenticate',
  'x-cache',
  'x-envoy-upstream-service-time',
  'x-request-id',
]);

const ProviderResponseContentTypeSchema = z.enum([
  'application/json',
  'application/*+json',
  'application/octet-stream',
  'text/html',
  'text/plain',
  'other',
]);
export type ProviderResponseContentType = z.infer<typeof ProviderResponseContentTypeSchema>;

export const ProviderResponseCodeSchema = z.enum([
  'api_error',
  'authentication_error',
  'error',
  'insufficient_scope',
  'invalid_request',
  'invalid_request_error',
  'invalid_token',
  'not_found_error',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'other',
]);
export type ProviderResponseCode = z.infer<typeof ProviderResponseCodeSchema>;

const responseJsonPathSegment =
  '(?:code|credential|error|error_code|five_hour|message|other|resets_at|seven_day|type|utilization)';
const responseJsonPath = z
  .string()
  .regex(new RegExp(`^${responseJsonPathSegment}(?:\\.${responseJsonPathSegment})?$`, 'u'));

/** A header's authentication challenge, reduced to non-secret protocol words. */
const ProviderAuthenticationShapeSchema = z.strictObject({
  scheme: z.enum(['bearer', 'other']),
  errorCode: z.enum(['insufficient_scope', 'invalid_request', 'invalid_token', 'other']).optional(),
});
export type ProviderAuthenticationShape = z.infer<typeof ProviderAuthenticationShapeSchema>;

/** The only response header VALUES permitted to survive. Every other header contributes its name only. */
const ProviderResponseHeaderValuesSchema = z.strictObject({
  cfMitigated: z.enum(['challenge', 'other']).optional(),
  retryAfter: z.enum(['seconds', 'http-date', 'other']).optional(),
  retryAfterMs: z.enum(['milliseconds', 'other']).optional(),
  server: z.enum(['cloudflare', 'envoy', 'other']).optional(),
  wwwAuthenticate: ProviderAuthenticationShapeSchema.optional(),
});
export type ProviderResponseHeaderValues = z.infer<typeof ProviderResponseHeaderValuesSchema>;

/** One key path and only the kind of value behind it — never the value. */
const ProviderResponseJsonFieldSchema = z.strictObject({
  path: responseJsonPath,
  type: ProviderResponseJsonTypeSchema,
});
export type ProviderResponseJsonField = z.infer<typeof ProviderResponseJsonFieldSchema>;

/** A bounded JSON outline plus the provider's code-like error labels, when present. */
const ProviderResponseJsonShapeSchema = z.strictObject({
  type: ProviderResponseJsonTypeSchema,
  fields: z.array(ProviderResponseJsonFieldSchema).max(64),
  fieldsTruncated: z.literal(true).optional(),
  envelopeType: ProviderResponseCodeSchema.optional(),
  errorType: ProviderResponseCodeSchema.optional(),
  errorCode: ProviderResponseCodeSchema.optional(),
});
export type ProviderResponseJsonShape = z.infer<typeof ProviderResponseJsonShapeSchema>;

/**
 * A secret-safe description of one provider response.
 *
 * The body contributes only its byte length, SHA-256 digest, categorized key/type outline and fixed
 * error labels. A normal response is described in full; `bodyTruncated` says an oversized response
 * was cancelled and the length/digest cover only the hard-capped prefix. Header names and values are
 * reduced to the closed categories above, including `other` for anything unrecognized. There is
 * deliberately no free-form string or provider body field for a token to travel in.
 */
export const ProviderResponseFingerprintSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  contentType: ProviderResponseContentTypeSchema.optional(),
  headerNames: z.array(ProviderResponseHeaderNameSchema).max(128),
  headerNamesTruncated: z.literal(true).optional(),
  headers: ProviderResponseHeaderValuesSchema.optional(),
  bodyLength: z.number().int().nonnegative().refine(Number.isFinite, 'expected a finite body length'),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/u, 'expected a SHA-256 digest'),
  bodyTruncated: z.literal(true).optional(),
  json: ProviderResponseJsonShapeSchema.optional(),
});
export type ProviderResponseFingerprint = z.infer<typeof ProviderResponseFingerprintSchema>;

/** A normalized quota window. Percentages always mean consumed capacity. */
export const FleetUsageWindowSchema = z.strictObject({
  usedPercent: percentage.optional(),
  resetAt: epochMilliseconds.optional(),
});

export type FleetUsageWindow = z.infer<typeof FleetUsageWindowSchema>;

/** The complete, account-scoped result returned by a usage adapter. */
export interface FleetUsageProbeResult {
  provider?: string | undefined;
  usageBased: boolean;
  ok: boolean;
  unavailable?: boolean | undefined;
  unavailableReason?: string | undefined;
  authOk?: boolean | undefined;
  /**
   * What the free provider read established about the credential, when a probe was in a position to
   * establish anything. Absent means this probe does not speak for this account at all — which is
   * how a Codex account reaches a health verdict of "unproven" rather than one invented from a
   * probe that declined to run.
   */
  credentialSignal?: FleetCredentialSignal | undefined;
  /** Secret-safe evidence from the HTTP response that produced `credentialSignal`. */
  responseFingerprint?: ProviderResponseFingerprint | undefined;
  error?: string | undefined;
  shortWindow?: FleetUsageWindow | undefined;
  longWindow?: FleetUsageWindow | undefined;
  atLimit?: boolean | undefined;
}

/** Clamp a provider percentage into the public 0–100 usage range. */
export function clampUsagePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

/** Normalize ISO timestamps, epoch seconds, and epoch milliseconds to milliseconds. */
export function normalizeResetAt(value: unknown): number | undefined {
  let milliseconds: number | undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) milliseconds = parsed;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds are currently ten digits; epoch milliseconds are thirteen.
    milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.trunc(milliseconds);
}

/** A quota is exhausted when either known window reaches the configured threshold. */
export function isAtLimit(
  shortWindow: FleetUsageWindow | undefined,
  longWindow: FleetUsageWindow | undefined,
  threshold = 100,
): boolean {
  const limit = clampUsagePercent(threshold) ?? 100;
  return (shortWindow?.usedPercent ?? -Infinity) >= limit || (longWindow?.usedPercent ?? -Infinity) >= limit;
}

// ── The account model: usage per credential (docs/design/account-model.md §8.1.3, §8.2.3) ───────

/** The subcommand Claude's `statusLine.command` runs, and the option naming the person's own command. */
const STATUSLINE_SUBCOMMAND = 'statusline';
const STATUSLINE_THEN_OPTION = '--then';

/**
 * The `statusLine.command` every Claude runtime is materialised with (a plumbing key, §8.3).
 *
 * THE ONE SPELLING. Materialisation calls this and never writes the string itself, because the
 * command line is a contract with `fy statusline`'s parser and two spellings would drift. When the
 * person's own settings named a statusLine command, it is CHAINED, never replaced: `fy statusline`
 * records the reading and then runs theirs with the same stdin, and what they see is what it prints.
 *
 * `binary` is the derived binary name (the `bin` key of the CLI package), never a literal here.
 */
export function claudeStatuslineCommand(binary: string, ownCommand?: string): string {
  const own = ownCommand?.trim() ?? '';
  const base = `${shellQuote(binary)} ${STATUSLINE_SUBCOMMAND}`;
  return own.length === 0 ? base : `${base} ${STATUSLINE_THEN_OPTION} ${shellQuote(own)}`;
}

/** Where a passive reading came from. Each is free: nothing was requested to produce it. */
const PassiveUsageSourceSchema = z.enum(['claude-statusline', 'codex-rollout']);

/**
 * One passive reading of one credential's two windows, exactly as `usage.json` holds it.
 *
 * A window is ABSENT when the source did not say, and an absent window is "unknown" on every surface,
 * never 0%: zero is a claim that nothing was spent.
 */
export const PassiveUsageRecordSchema = z.strictObject({
  version: z.literal(1),
  source: PassiveUsageSourceSchema,
  /** When the reading was taken. */
  at: epochMilliseconds,
  fiveHour: FleetUsageWindowSchema.optional(),
  weekly: FleetUsageWindowSchema.optional(),
});
export type PassiveUsageRecord = z.infer<typeof PassiveUsageRecordSchema>;
