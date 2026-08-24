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
 */

import type { CredentialMaterial } from '../lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../lib/manifest.ts';
import { parseStoredUsageBody, type QuotaReading, usageEndpointHttpVerdict } from '../lib/quota.ts';
import type { FleetUsageProbe, FleetUsageProbeResult } from '../lib/usage.ts';

export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The provider label every row from this probe carries. */
export const ANTHROPIC_PROVIDER = 'anthropic';

const DEFAULT_TIMEOUT_MS = 20_000;
const FORBIDDEN_STATUS = 403;

/** The slice of an HTTP response this probe reads. Narrow so a test never needs a real one. */
export interface QuotaResponse {
  readonly status: number;
  readonly ok: boolean;
  header(name: string): string | null | undefined;
  json(): Promise<unknown>;
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
    // A 403 from the read-only endpoint is permanent for an inference-scoped token, so this account
    // will never report a number. IT IS REPORTED AS UNMEASURABLE, NOT PAID FOR. This used to fall back
    // to `POST /v1/messages` — a real billable turn — and the daemon's unattended refresh reaches this
    // probe on a fixed timer, so an account in that permanent-403 state billed on every tick forever.
    // Spending money to read a usage number is never worth it, and an unattended pass may not spend at
    // all. "Cannot be measured" is the honest answer and it costs nothing.
    return (
      stored ??
      failure('this token cannot read usage; it lacks the user:profile scope', {
        authOk: true,
      })
    );
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
}

/** A request failure's own message, never anything derived from the credential. */
function requestFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'the request timed out';
  return error instanceof Error && error.message.length > 0 ? error.message : 'the request failed';
}

/**
 * The shipped fetch, bounded by a deadline.
 *
 * The response body is only read when a caller asks for JSON, and the response object handed back
 * exposes nothing but the status and header lookup — so a caller cannot accidentally hold a stream
 * open. Nothing is ever SENT: there is no request body here because {@link QuotaRequest} has no
 * field for one.
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
