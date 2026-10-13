/**
 * Asking ChatGPT how much of a Codex credential's two windows is spent — the ACTIVE fallback of design
 * §8.2.3, used only when no passive rollout reading is fresh.
 *
 * ONE read, and it is free: **`GET https://chatgpt.com/backend-api/wham/usage`** with the credential's
 * bearer token and its `ChatGPT-Account-Id`, and NOTHING else. In particular it sends no `originator`,
 * no `OpenAI-Beta` and no client name: this is Ferretry reading a person's own usage, and it never
 * presents itself as the Codex client. The request type is a bodyless `GET` (the same
 * {@link QuotaRequest} the Anthropic probe uses), so a request that could spend is unrepresentable.
 *
 * **This answer is NOT login evidence, and the result says so by omission.** The endpoint serves a
 * usage body for a token that is already stale, so a `200` here proves nothing about whether the login
 * still works. Every result therefore leaves `credentialSignal` ABSENT, which is exactly how the health
 * table and the credential status (`lib/account/credential-status.ts`) know to judge nothing from it.
 *
 * **The token never leaves this file**: it is read from the canonical `auth.json`, used as a header and
 * dropped. A failure message is built from statuses and fixed sentences, never from material or from
 * the provider's body.
 */
import type { CodexStoreResolution, StoredCredentialResolution } from '../lib/account/credentials.ts';
import type { CredentialMaterial } from '../lib/identity.ts';
import { parseCodexUsageBody } from '../lib/quota.ts';
import type { FleetUsageProbeResult } from '../lib/usage.ts';
import type { QuotaFetch, StoredMaterialSource } from './anthropic-usage-probe.ts';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** The provider label every row from this probe carries. */
export const CODEX_USAGE_PROVIDER = 'openai';

const DEFAULT_TIMEOUT_MS = 20_000;

export interface CodexUsageProbeDeps {
  readonly fetch: QuotaFetch;
  readonly stored: StoredMaterialSource;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

const failure = (error: string): FleetUsageProbeResult => ({
  provider: CODEX_USAGE_PROVIDER,
  usageBased: true,
  ok: false,
  error,
});

/** The bearer token and account id out of `auth.json`, or nothing. Never returns the blob. */
function codexBearer(material: CredentialMaterial): { readonly token: string; readonly accountId: string } | undefined {
  if (material.outcome !== 'found') return undefined;
  try {
    const tokens = (JSON.parse(material.blob) as { tokens?: Record<string, unknown> }).tokens;
    const token = tokens?.access_token;
    const accountId = tokens?.account_id;
    return typeof token === 'string' && token.length > 0 && typeof accountId === 'string' && accountId.length > 0
      ? { token, accountId }
      : undefined;
  } catch {
    return undefined;
  }
}

export class CodexUsageProbe {
  constructor(private readonly deps: CodexUsageProbeDeps) {}

  async probeCredential(resolution: StoredCredentialResolution): Promise<FleetUsageProbeResult> {
    if (resolution.harness !== 'codex') {
      return { ...failure('no Codex usage read applies to a claude credential'), usageBased: false };
    }
    return await this.#read(resolution);
  }

  async #read(resolution: CodexStoreResolution): Promise<FleetUsageProbeResult> {
    const bearer = codexBearer(await this.deps.stored.storedMaterial(resolution));
    if (bearer === undefined) return failure('no readable ChatGPT access token and account id for this credential');
    let status: number;
    let body: unknown;
    try {
      const response = await this.deps.fetch({
        url: CODEX_USAGE_URL,
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer.token}`, 'ChatGPT-Account-Id': bearer.accountId },
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      status = response.status;
      if (!response.ok) return failure(`the Codex usage endpoint answered HTTP ${status}`);
      if (response.body.truncated) return failure('the Codex usage endpoint answered more than this read keeps');
      body = JSON.parse(new TextDecoder().decode(response.body.bytes)) as unknown;
    } catch (error) {
      return failure(
        error instanceof Error && error.name === 'AbortError'
          ? 'the Codex usage read timed out'
          : 'the Codex usage read failed',
      );
    }
    const reading = parseCodexUsageBody(body, this.deps.now());
    if (!reading.hasQuotaSignal) return failure('the Codex usage endpoint carried no readable usage');
    return {
      provider: CODEX_USAGE_PROVIDER,
      usageBased: true,
      ok: true,
      ...(reading.shortWindow === undefined ? {} : { shortWindow: reading.shortWindow }),
      ...(reading.longWindow === undefined ? {} : { longWindow: reading.longWindow }),
      atLimit: reading.providerAtLimit,
    };
  }
}
