/**
 * Asking Anthropic how much quota an account has spent.
 *
 * Two endpoints, tried in that order, because they cost different things and not every token can use
 * the cheap one:
 *
 * 1. **`GET /api/oauth/usage`** — read-only, consumes no inference quota, and reports both windows as
 *    percentages. This is the right answer whenever the token can make the call.
 * 2. **`POST /v1/messages` with `max_tokens: 1`** — the fallback, used only when the first returns
 *    `403`. A `403` there means the token lacks the `user:profile` scope, which is permanent for an
 *    inference-scoped token, so retrying the usage endpoint will never help. The smallest possible
 *    inference request is made instead and the quota is read from its response **headers**.
 *
 * Those headers report utilization as a **fraction of one** while the usage JSON reports a
 * **percentage** — the same field name, 100× apart. Neither scale is interpreted here: both are handed
 * to the named readers in `lib/quota.ts`, which is the only place either conversion happens.
 *
 * **The bearer token never leaves this file.** It is read through the credential store, used as an
 * `Authorization` header, and never returned, logged, or put in an error message. This module is an
 * adapter precisely because a probe cannot be done with a classification — it needs the secret — and
 * the adapter layer is where secrets are allowed to exist.
 *
 * **A failed probe reports a failure, never a number.** `ok: false` with a reason is always preferable
 * to a fabricated zero, and the collector already refuses to let a failed probe mark an account at its
 * limit.
 */

import type { CredentialMaterial } from '../lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../lib/manifest.ts';
import {
  inferenceHttpVerdict,
  parseQuotaHeaders,
  parseStoredUsageBody,
  type QuotaReading,
  TOO_MANY_REQUESTS,
  usageEndpointHttpVerdict,
} from '../lib/quota.ts';
import type { FleetUsageProbe, FleetUsageProbeResult } from '../lib/usage.ts';

export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/** The provider label every row from this probe carries. */
export const ANTHROPIC_PROVIDER = 'anthropic';

const DEFAULT_TIMEOUT_MS = 20_000;
const FORBIDDEN_STATUS = 403;

/**
 * The smallest request that still produces quota headers.
 *
 * A one-token completion is not free, so it is only ever sent when the read-only endpoint has already
 * refused. The model is a deliberately cheap one.
 */
export const ANTHROPIC_PROBE_MODEL = 'claude-haiku-4-5-20251001';
const PROBE_BODY = JSON.stringify({
  model: ANTHROPIC_PROBE_MODEL,
  max_tokens: 1,
  messages: [{ role: 'user', content: '.' }],
});

/** The slice of an HTTP response this probe reads. Narrow so a test never needs a real one. */
export interface QuotaResponse {
  readonly status: number;
  readonly ok: boolean;
  header(name: string): string | null | undefined;
  json(): Promise<unknown>;
}

export interface QuotaRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
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

/** Turn a successful reading into a row, or a signal-less one into an honest failure. */
function fromReading(reading: QuotaReading, source: string): FleetUsageProbeResult {
  if (!reading.hasQuotaSignal) {
    return failure(`${source} carried no readable quota measurement`, { authOk: true });
  }
  return {
    provider: ANTHROPIC_PROVIDER,
    usageBased: true,
    ok: true,
    authOk: true,
    ...(reading.shortWindow === undefined ? {} : { shortWindow: reading.shortWindow }),
    ...(reading.longWindow === undefined ? {} : { longWindow: reading.longWindow }),
    atLimit: reading.providerAtLimit,
  };
}

export class AnthropicUsageProbe implements FleetUsageProbe {
  constructor(private readonly deps: AnthropicUsageProbeDeps) {}

  async probe(account: FleetManifestAccount): Promise<FleetUsageProbeResult> {
    if (account.kind !== 'claude') {
      return failure(`no Anthropic quota probe applies to a ${account.kind} account`, { usageBased: false });
    }

    const token = bearerToken(await this.deps.credentials.material('claude', account.home));
    if (token === undefined) {
      // Not logged in, or a credential this build could not read. Either way there is nothing to ask
      // with, and saying so beats reporting 0% spent.
      return failure('no readable access token for this account', { authOk: false });
    }

    const stored = await this.#stored(token);
    // A 403 from the read-only endpoint is permanent for an inference-scoped token, so the fallback is
    // the only way this account will ever report a number.
    return stored ?? (await this.#viaInference(token));
  }

  /** The read-only usage endpoint. Returns nothing when the caller should fall back. */
  async #stored(token: string): Promise<FleetUsageProbeResult | undefined> {
    let response: QuotaResponse;
    try {
      response = await this.deps.fetch({
        url: ANTHROPIC_USAGE_URL,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION },
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      return failure(requestFailure(error));
    }

    if (response.status === FORBIDDEN_STATUS) return undefined;

    if (!response.ok) {
      const verdict = usageEndpointHttpVerdict(response.status);
      return failure(`the usage endpoint answered HTTP ${response.status}`, {
        ...(verdict.authOk === undefined ? {} : { authOk: verdict.authOk }),
        ...(verdict.unavailable ? { unavailable: true, unavailableReason: 'this credential was rejected' } : {}),
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return failure(`the usage endpoint answered unreadable JSON: ${requestFailure(error)}`, { authOk: true });
    }
    return fromReading(parseStoredUsageBody(body), 'the usage endpoint');
  }

  /**
   * The one-token inference request, read for its quota headers.
   *
   * A `429` is a **success** here: the response still carries valid headers, and treating a
   * rate-limited account as a failed probe is how a fleet loses sight of the accounts it most needs to
   * route around.
   */
  async #viaInference(token: string): Promise<FleetUsageProbeResult> {
    let response: QuotaResponse;
    try {
      response = await this.deps.fetch({
        url: ANTHROPIC_MESSAGES_URL,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
          'content-type': 'application/json',
        },
        body: PROBE_BODY,
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      return failure(requestFailure(error));
    }

    if (!response.ok && response.status !== TOO_MANY_REQUESTS) {
      const verdict = inferenceHttpVerdict(response.status);
      return failure(`the inference probe answered HTTP ${response.status}`, {
        ...(verdict.authOk === undefined ? {} : { authOk: verdict.authOk }),
        ...(verdict.unavailable
          ? { unavailable: true, unavailableReason: `this account cannot serve work (HTTP ${response.status})` }
          : {}),
      });
    }

    const reading = parseQuotaHeaders(name => response.header(name));
    if (!reading.hasQuotaSignal && !response.ok) {
      return failure(`the inference probe answered HTTP ${response.status} with no quota headers`, { authOk: true });
    }
    return fromReading(reading, 'the inference probe');
  }
}

/** A request failure's own message, never anything derived from the credential. */
function requestFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'the request timed out';
  return error instanceof Error && error.message.length > 0 ? error.message : 'the request failed';
}

/**
 * The shipped fetch, bounded by a deadline.
 *
 * The body is only read when a caller asks for JSON, and the response object handed back exposes
 * nothing but the status and header lookup — so a caller cannot accidentally hold a stream open.
 */
export const fetchQuota: QuotaFetch = async request => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
    });
    return {
      status: response.status,
      ok: response.ok,
      header: name => response.headers.get(name),
      json: async () => await response.json(),
    };
  } finally {
    clearTimeout(timer);
  }
};
