/**
 * Asking Anthropic how much quota an account has spent.
 *
 * ONE endpoint, and it is read-only: **`GET /api/oauth/usage`** consumes no inference quota and
 * reports both windows as percentages.
 *
 * **There used to be a second.** A `403` from the read-only endpoint means the token lacks the
 * `user:profile` scope — permanent for an inference-scoped token — and this probe answered it by
 * sending `POST /v1/messages` with `max_tokens: 1` and reading the quota from its response headers.
 * That is a real billable turn. The daemon's unattended refresh reaches this probe on a fixed timer,
 * so an account in that permanent-403 state paid for a model call on every tick, forever, without
 * anybody asking. It is removed, not gated: **nothing on a timer may spend money**, and a usage number
 * is never worth buying. Such an account now reports that it cannot be measured, which is true and free.
 *
 * **And the seam can no longer express one.** {@link QuotaRequest} is a bodyless `GET`, so a completion
 * request is not merely absent from this file — it is unrepresentable in the type every implementation
 * of {@link QuotaFetch} is written against. Reviving inference-derived quota would take widening that
 * type in a reviewed diff, which is the point.
 *
 * The usage JSON reports utilization as a **percentage**. It is not interpreted here — it is handed to
 * the named readers in `lib/quota.ts`, which is the only place that conversion happens.
 *
 * **The bearer token never leaves this file.** It is read through the credential store, used as an
 * `Authorization` header, and never returned, logged, or put in an error message. This module is an
 * adapter precisely because a probe cannot be done with a classification — it needs the secret — and
 * the adapter layer is where secrets are allowed to exist.
 *
 * **A failed probe reports a failure, never a number.** `ok: false` with a reason is always preferable
 * to a fabricated zero, and the collector already refuses to let a failed probe mark an account at its
 * limit.
 *
 * **It also reports what the answer said about the CREDENTIAL, and that is a second field on purpose.**
 * `credentialSignal` is set on every return path here, and it is the only place in the repository that
 * turns an Anthropic response into a health classification. Health is not derivable from `ok` or from
 * `authOk`: a `200` with an unreadable body is a failed quota reading and an accepted credential, a
 * JSON `403` is accepted-but-unmeasurable while an HTML `403` can be an edge challenge, and a bare
 * control-plane `401` cannot distinguish the login from this HTTP client. Status, bounded header
 * metadata, body length/hash and JSON key/type/error-code shape therefore travel as a strict
 * secret-safe fingerprint. No body, token or authorization value has a field to survive in.
 * **No additional request is made for health**: this is the same single read-only GET, reported more
 * completely.
 */

import { createHash } from 'node:crypto';
import type { CredentialMaterial } from '../lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../lib/manifest.ts';
import {
  parseStoredUsageBody,
  type QuotaReading,
  usageEndpointCredentialSignal,
  usageEndpointHttpVerdict,
} from '../lib/quota.ts';
import {
  type FleetUsageProbe,
  type FleetUsageProbeResult,
  type ProviderAuthenticationShape,
  type ProviderResponseCode,
  ProviderResponseCodeSchema,
  type ProviderResponseContentType,
  type ProviderResponseFingerprint,
  ProviderResponseFingerprintSchema,
  ProviderResponseHeaderNameSchema,
  type ProviderResponseHeaderValues,
  type ProviderResponseJsonField,
  type ProviderResponseJsonShape,
  type ProviderResponseJsonType,
} from '../lib/usage.ts';

export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The provider label every row from this probe carries. */
export const ANTHROPIC_PROVIDER = 'anthropic';

const DEFAULT_TIMEOUT_MS = 20_000;
const FORBIDDEN_STATUS = 403;
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const MAX_HEADER_NAMES = 128;
const MAX_JSON_FIELDS = 64;
const REDACTED = '[redacted]';

const RETAINED_JSON_KEYS = new Set([
  'code',
  'error',
  'error_code',
  'five_hour',
  'message',
  'resets_at',
  'seven_day',
  'type',
  'utilization',
]);

const withoutControlCharacters = (value: string): string =>
  [...value].map(character => (character < ' ' || character === '\u007f' ? ' ' : character)).join('');

/** The slice of an HTTP response this probe reads. Narrow so a test never needs a real one. */
export interface QuotaResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Normalized names only. Values remain behind the closed lookup below. */
  readonly headerNames: readonly string[];
  header(name: string): string | null | undefined;
  /** A hard-capped prefix. `truncated` says the digest cannot describe the complete response. */
  readonly body: {
    readonly bytes: Uint8Array;
    readonly truncated: boolean;
  };
}

/**
 * One bounded read.
 *
 * `method` is the literal `'GET'` and there is no `body` field, so a request that spends inference
 * quota is unrepresentable rather than merely unwritten. This is the structural half of the fix
 * above: deleting `#viaInference` stopped the spend, and this stops the next one being a one-line
 * edit nobody notices.
 */
export interface QuotaRequest {
  readonly url: string;
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Performing one bounded HTTP request. The only thing here that touches a network. */
export type QuotaFetch = (request: QuotaRequest) => Promise<QuotaResponse>;

/** Reading one home's raw credential. Satisfied structurally by the platform credential store. */
export interface CredentialMaterialSource {
  material(kind: HarnessKind, home: string): Promise<CredentialMaterial>;
}

export interface AnthropicUsageProbeDeps {
  readonly fetch: QuotaFetch;
  readonly credentials: CredentialMaterialSource;
  readonly timeoutMs?: number;
}

const failure = (error: string, extra: Partial<FleetUsageProbeResult> = {}): FleetUsageProbeResult => ({
  provider: ANTHROPIC_PROVIDER,
  usageBased: true,
  ok: false,
  error,
  ...extra,
});

/** The access token out of a Claude credential blob, or nothing. Never returns the blob itself. */
function bearerToken(material: CredentialMaterial): string | undefined {
  if (material.outcome !== 'found') return undefined;
  try {
    const parsed = JSON.parse(material.blob) as Record<string, unknown>;
    const nested = parsed.claudeAiOauth;
    const credential = (nested !== null && typeof nested === 'object' ? nested : parsed) as Record<string, unknown>;
    const token = credential.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a successful reading into a row, or a signal-less one into an honest failure.
 *
 * Both carry `credentialSignal: 'accepted'`, and the failure branch is the reason that field exists
 * separately from `ok`. A `200` whose body held no percentage is a FAILED QUOTA READING and a
 * SUCCESSFUL credential check: the provider answered for this token. Deriving health from `ok` would
 * report an account as unproven purely because its usage JSON changed shape.
 */
function fromReading(
  reading: QuotaReading,
  source: string,
  responseFingerprint: ProviderResponseFingerprint,
): FleetUsageProbeResult {
  if (!reading.hasQuotaSignal) {
    return failure(`${source} carried no readable quota measurement`, {
      authOk: true,
      credentialSignal: 'accepted',
      responseFingerprint,
    });
  }
  return {
    provider: ANTHROPIC_PROVIDER,
    usageBased: true,
    ok: true,
    authOk: true,
    credentialSignal: 'accepted',
    responseFingerprint,
    ...(reading.shortWindow === undefined ? {} : { shortWindow: reading.shortWindow }),
    ...(reading.longWindow === undefined ? {} : { longWindow: reading.longWindow }),
    atLimit: reading.providerAtLimit,
  };
}

const jsonType = (value: unknown): ProviderResponseJsonType => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Remove an exact credential and familiar authorization assignments from a retained diagnostic value. */
function scrubDiagnosticValue(value: string | null | undefined, secrets: readonly string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  let scrubbed = value.trim();
  if (scrubbed.length === 0) return undefined;
  for (const secret of secrets) if (secret.length > 0) scrubbed = scrubbed.replaceAll(secret, REDACTED);
  scrubbed = scrubbed
    .replace(/\bBearer\s+(?!(?:error|realm|scope)\s*=)[^\s,;]+/giu, `Bearer ${REDACTED}`)
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|authorization|api[_-]?key)\s*[:=]\s*["']?[^\s,"']+/giu,
      match => `${match.slice(0, Math.max(match.indexOf(':'), match.indexOf('=')) + 1)}${REDACTED}`,
    )
    .trim();
  scrubbed = withoutControlCharacters(scrubbed).trim();
  return scrubbed.length === 0 ? undefined : scrubbed.slice(0, 256);
}

function authenticationShape(
  value: string | null | undefined,
  secrets: readonly string[],
): ProviderAuthenticationShape | undefined {
  const scrubbed = scrubDiagnosticValue(value, secrets);
  if (scrubbed === undefined) return undefined;
  const rawScheme = /^[A-Za-z][A-Za-z0-9+.-]*/u.exec(scrubbed)?.[0]?.toLowerCase();
  if (rawScheme === undefined) return undefined;
  const scheme = rawScheme === 'bearer' ? 'bearer' : 'other';
  const rawErrorCode = /\berror\s*=\s*"?([A-Za-z0-9._:-]+)/iu.exec(scrubbed)?.[1]?.toLowerCase();
  const errorCode =
    rawErrorCode === undefined
      ? undefined
      : rawErrorCode === 'insufficient_scope' || rawErrorCode === 'invalid_request' || rawErrorCode === 'invalid_token'
        ? rawErrorCode
        : 'other';
  return { scheme, ...(errorCode === undefined ? {} : { errorCode }) };
}

function responseHeaderValues(
  response: QuotaResponse,
  secrets: readonly string[],
): ProviderResponseHeaderValues | undefined {
  const value = (name: string): string | undefined =>
    scrubDiagnosticValue(response.header(name), secrets)?.toLowerCase();
  const cfMitigated = value('cf-mitigated');
  const retryAfter = value('retry-after');
  const retryAfterMs = value('retry-after-ms');
  const server = value('server');
  const retryAfterShape =
    retryAfter === undefined
      ? undefined
      : /^\d+$/u.test(retryAfter)
        ? 'seconds'
        : Number.isFinite(Date.parse(retryAfter))
          ? 'http-date'
          : 'other';
  const headers: ProviderResponseHeaderValues = {
    ...(cfMitigated === undefined ? {} : { cfMitigated: cfMitigated === 'challenge' ? 'challenge' : 'other' }),
    ...(retryAfterShape === undefined ? {} : { retryAfter: retryAfterShape }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs: /^\d+$/u.test(retryAfterMs) ? 'milliseconds' : 'other' }),
    ...(server === undefined
      ? {}
      : { server: server.includes('cloudflare') ? 'cloudflare' : server.includes('envoy') ? 'envoy' : 'other' }),
    ...(authenticationShape(response.header('www-authenticate'), secrets) === undefined
      ? {}
      : { wwwAuthenticate: authenticationShape(response.header('www-authenticate'), secrets) }),
  };
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function diagnosticJsonKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/(?:access|refresh)?[_-]?token|api[_-]?key|authorization|credential|secret/u.test(normalized)) {
    return 'credential';
  }
  return RETAINED_JSON_KEYS.has(normalized) ? normalized : 'other';
}

function jsonFields(value: unknown): {
  readonly fields: readonly ProviderResponseJsonField[];
  readonly truncated: boolean;
} {
  const fields: ProviderResponseJsonField[] = [];
  let truncated = false;
  const visit = (current: unknown, prefix: string, depth: number): void => {
    const record = asRecord(current);
    if (record === undefined || depth > 1) return;
    for (const key of Object.keys(record).sort()) {
      if (fields.length >= MAX_JSON_FIELDS) {
        truncated = true;
        return;
      }
      const safeKey = diagnosticJsonKey(key);
      const path = prefix.length === 0 ? safeKey : `${prefix}.${safeKey}`;
      const child = record[key];
      fields.push({ path, type: jsonType(child) });
      if (depth < 1) visit(child, path, depth + 1);
      if (truncated) return;
    }
  };
  visit(value, '', 0);
  return { fields, truncated };
}

function codeLike(value: unknown): ProviderResponseCode | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const retained = ProviderResponseCodeSchema.safeParse(normalized);
  return retained.success ? retained.data : 'other';
}

function jsonShape(value: unknown): ProviderResponseJsonShape {
  const { fields, truncated } = jsonFields(value);
  const root = asRecord(value);
  const error = asRecord(root?.error);
  const nestedType = codeLike(error?.type);
  const rootType = codeLike(root?.type);
  const errorCode = codeLike(error?.code) ?? codeLike(root?.error_code) ?? codeLike(root?.code);
  return {
    type: jsonType(value),
    fields: [...fields],
    ...(truncated ? { fieldsTruncated: true as const } : {}),
    ...(rootType === undefined ? {} : { envelopeType: rootType }),
    ...(nestedType === undefined ? {} : { errorType: nestedType }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function contentTypeShape(value: string | null | undefined): ProviderResponseContentType | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || mediaType.length === 0) return undefined;
  if (mediaType === 'application/json') return 'application/json';
  if (mediaType.startsWith('application/') && mediaType.endsWith('+json')) return 'application/*+json';
  if (mediaType === 'application/octet-stream') return 'application/octet-stream';
  if (mediaType === 'text/html') return 'text/html';
  if (mediaType === 'text/plain') return 'text/plain';
  return 'other';
}

interface InspectedQuotaResponse {
  readonly fingerprint: ProviderResponseFingerprint;
  readonly json?: unknown;
}

/** Read the response once, keeping only the evidence shape permitted by the public schema. */
async function inspectResponse(response: QuotaResponse, secrets: readonly string[]): Promise<InspectedQuotaResponse> {
  // Defend at both sides of the seam: the shipped fetch caps before returning, and inspection caps
  // again so a custom transport cannot make this diagnostic path retain an arbitrary response.
  const bodyTruncated = response.body.truncated || response.body.bytes.byteLength > MAX_RESPONSE_BODY_BYTES;
  const bytes =
    response.body.bytes.byteLength > MAX_RESPONSE_BODY_BYTES
      ? response.body.bytes.slice(0, MAX_RESPONSE_BODY_BYTES)
      : response.body.bytes;
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Invalid UTF-8 is not JSON. The raw-byte length/hash still survives below.
  }
  let parsed: unknown;
  let parsedJson = false;
  if (!bodyTruncated && text !== undefined) {
    try {
      parsed = JSON.parse(text) as unknown;
      parsedJson = true;
    } catch {
      // Invalid JSON is itself part of the fingerprint: the `json` outline is absent.
    }
  }

  const normalizedSecrets = secrets.map(secret => secret.toLowerCase()).filter(secret => secret.length > 0);
  const rawNames = [...new Set(response.headerNames.map(name => name.trim().toLowerCase()))]
    .filter(name => /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name))
    .filter(name => !normalizedSecrets.some(secret => name.includes(secret)));
  const normalizedNames = [
    ...new Set(rawNames.map(name => (ProviderResponseHeaderNameSchema.safeParse(name).success ? name : 'other'))),
  ].sort();
  const contentType = contentTypeShape(response.header('content-type'));
  const headers = responseHeaderValues(response, secrets);
  const fingerprint = ProviderResponseFingerprintSchema.parse({
    status: response.status,
    ...(contentType === undefined ? {} : { contentType }),
    headerNames: normalizedNames.slice(0, MAX_HEADER_NAMES),
    ...(rawNames.length > MAX_HEADER_NAMES ? { headerNamesTruncated: true } : {}),
    ...(headers === undefined ? {} : { headers }),
    bodyLength: bytes.byteLength,
    bodySha256: createHash('sha256').update(bytes).digest('hex'),
    ...(bodyTruncated ? { bodyTruncated: true as const } : {}),
    ...(parsedJson ? { json: jsonShape(parsed) } : {}),
  });
  return { fingerprint, ...(parsedJson ? { json: parsed } : {}) };
}

/** A 403 is accepted only for Anthropic's exact permission-error envelope, never an outline guess. */
function acceptedScopeFailure(response: ProviderResponseFingerprint, body: unknown): boolean {
  const jsonContent = response.contentType === 'application/json' || response.contentType?.endsWith('+json') === true;
  const root = asRecord(body);
  const error = asRecord(root?.error);
  return jsonContent && root?.type === 'error' && error?.type === 'permission_error';
}

export class AnthropicUsageProbe implements FleetUsageProbe {
  constructor(private readonly deps: AnthropicUsageProbeDeps) {}

  async probe(account: FleetManifestAccount): Promise<FleetUsageProbeResult> {
    if (account.kind !== 'claude') {
      // NO `credentialSignal`, deliberately. This probe has not looked at a Codex account and is not
      // entitled to classify one — an absent signal is how the health verdict reaches "liveness
      // unproven" instead of inventing a conclusion from a probe that declined to run.
      return failure(`no Anthropic quota probe applies to a ${account.kind} account`, { usageBased: false });
    }

    const token = bearerToken(await this.deps.credentials.material('claude', account.home));
    if (token === undefined) {
      // Not logged in, or a credential this build could not read. Either way there is nothing to ask
      // with, and saying so beats reporting 0% spent. `absent` rather than `rejected`: nothing was
      // asked, so nothing was refused, and the local classification is the better evidence about why.
      return failure('no readable access token for this account', { authOk: false, credentialSignal: 'absent' });
    }

    return await this.#stored(token);
  }

  /** The read-only usage endpoint. Every completed response keeps its secret-safe fingerprint. */
  async #stored(token: string): Promise<FleetUsageProbeResult> {
    let response: QuotaResponse;
    try {
      response = await this.deps.fetch({
        url: ANTHROPIC_USAGE_URL,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION },
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      // A request that never completed proves nothing about the credential, and the two ways it can
      // fail are two different sentences a reader acts on differently: "it timed out" versus "the
      // provider could not be reached". Neither is ever a rejection.
      return failure(requestFailure(error, [token]), {
        credentialSignal: abortedRequest(error) ? 'timeout' : 'inconclusive',
      });
    }

    let inspected: InspectedQuotaResponse;
    try {
      inspected = await inspectResponse(response, [token]);
    } catch (error) {
      return failure(`the usage endpoint response could not be inspected: ${requestFailure(error, [token])}`, {
        credentialSignal: 'inconclusive',
      });
    }

    if (response.status === FORBIDDEN_STATUS) {
      if (acceptedScopeFailure(inspected.fingerprint, inspected.json)) {
        return failure('this token cannot read usage; it lacks the user:profile scope', {
          authOk: true,
          credentialSignal: usageEndpointCredentialSignal(response.status, { scopeUnavailableConfirmed: true }),
          responseFingerprint: inspected.fingerprint,
        });
      }
      return failure(`the usage endpoint answered HTTP ${response.status}`, {
        credentialSignal: 'inconclusive',
        responseFingerprint: inspected.fingerprint,
      });
    }

    if (!response.ok) {
      const verdict = usageEndpointHttpVerdict(response.status);
      return failure(`the usage endpoint answered HTTP ${response.status}`, {
        ...(verdict.authOk === undefined ? {} : { authOk: verdict.authOk }),
        credentialSignal: usageEndpointCredentialSignal(response.status),
        responseFingerprint: inspected.fingerprint,
        ...(verdict.unavailable ? { unavailable: true, unavailableReason: 'this credential was rejected' } : {}),
      });
    }

    if (inspected.json === undefined) {
      // The provider answered FOR THIS TOKEN and then handed back bytes this build cannot read. That
      // is a lost quota number and an accepted credential, so health stays positive while usage does
      // not — the whole reason the two facts travel in separate fields.
      return failure('the usage endpoint answered unreadable JSON', {
        authOk: true,
        credentialSignal: 'accepted',
        responseFingerprint: inspected.fingerprint,
      });
    }
    return fromReading(parseStoredUsageBody(inspected.json), 'the usage endpoint', inspected.fingerprint);
  }
}

/** Whether this failure is the deadline firing rather than the network refusing. */
function abortedRequest(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** A request failure's own message, never anything derived from the credential. */
function requestFailure(error: unknown, secrets: readonly string[] = []): string {
  if (abortedRequest(error)) return 'the request timed out';
  if (!(error instanceof Error) || error.message.length === 0) return 'the request failed';
  return scrubDiagnosticValue(error.message, secrets) ?? 'the request failed';
}

/**
 * The shipped fetch, bounded by a deadline.
 *
 * Headers and at most {@link MAX_RESPONSE_BODY_BYTES} response bytes are read before this function
 * returns. The same deadline covers headers AND body, and an oversized body is cancelled with an
 * explicit truncation marker rather than buffered without limit. Nothing is ever SENT: there is no
 * request body here because {@link QuotaRequest} has no field for one.
 */
export const fetchQuota: QuotaFetch = async request => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      signal: controller.signal,
    });
    const body = await readBoundedBody(response.body);
    return {
      status: response.status,
      ok: response.ok,
      headerNames: [...response.headers.keys()].map(name => name.toLowerCase()).sort(),
      header: name => response.headers.get(name),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Consume a response without letting an edge challenge allocate or retain an arbitrary body. */
async function readBoundedBody(body: ReadableStream<Uint8Array> | null): Promise<QuotaResponse['body']> {
  if (body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    while (true) {
      const reading = await reader.read();
      if (reading.done) break;
      const chunk = reading.value;
      if (chunk.byteLength === 0) continue;
      const remaining = MAX_RESPONSE_BODY_BYTES - length;
      if (remaining <= 0) {
        truncated = true;
      } else if (chunk.byteLength > remaining) {
        chunks.push(chunk.slice(0, remaining));
        length += remaining;
        truncated = true;
      } else {
        chunks.push(chunk);
        length += chunk.byteLength;
      }
      if (!truncated) continue;
      try {
        await reader.cancel('response body exceeded the diagnostic limit');
      } catch {
        // Cancellation races the request deadline. Either way no further bytes are retained.
      }
      break;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
