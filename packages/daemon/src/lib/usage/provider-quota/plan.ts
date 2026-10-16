/**
 * Where one environment login's quota is read from, and with which key — decided before anything is
 * sent (docs/provider-quotas.md).
 *
 * The preset names a quota SOURCE from a closed set; the endpoint, the header and the reader of each
 * source are fixed here, in code. A preset file of this machine's own can therefore only pick one of
 * these, never name an address. The key still only goes where it belongs:
 *
 * - **to the login's own provider.** The endpoint's host must be a host the login already sends to
 *   (its base URL, its Codex provider), or share that host's parent domain (`www.minimax.io` beside
 *   `api.minimax.io`), unless the preset is a built-in one, whose pairing of source and key Ferretry
 *   ships and vouches for. A machine preset that pointed an OpenAI key at DeepSeek's balance is refused.
 * - **as one whole `${secret:NAME}`.** The value is put on the request by the outbound holder
 *   (docs/secrets.md); nothing here ever holds it.
 *
 * Pure.
 */
import { type Credential, isCredentialSafeUrl, type ProviderPreset } from '@ferretry/fleet';
import { type ProviderQuotaSource, SECRET_REFERENCE_SOURCE, type SecretName } from '@ferretry/protocol';
import { loginHosts } from '../../provider-probe/plan.ts';
import type { CredentialPlacement, OutboundHttpRequest } from '../../speedups/ports.ts';
import {
  type ProviderQuotaParse,
  parseDeepseekBalance,
  parseLitellmKeyInfo,
  parseMinimaxRemains,
  parseMoonshotBalance,
  parseOpenRouterKey,
  parseVercelCredits,
  parseZaiQuota,
} from './parse.ts';

/** How long a quota read waits for the provider. Shorter than a Test: somebody is looking at a screen. */
export const PROVIDER_QUOTA_TIMEOUT_MS = 8_000;

/** A quota or balance reply is a few hundred bytes. */
export const PROVIDER_QUOTA_MAX_BYTES = 128 * 1_024;

/** One environment login, as the quota reader needs it. */
export interface ProviderQuotaLogin {
  readonly id: string;
  readonly credential: Credential;
  /** The preset it was made from, when this machine still has it. */
  readonly preset: ProviderPreset | undefined;
  /** The runtime executables on this login, which is how a usage-feed row names it. */
  readonly agents: readonly string[];
}

/** One endpoint read, ready to send through the outbound holder. */
export interface ProviderQuotaPlan {
  readonly secretName: SecretName;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement: CredentialPlacement;
  /** Reads the reply. */
  readonly parse: (payload: unknown, nowMs: number) => ProviderQuotaParse;
  /** Known from community sources rather than the provider's own documentation. */
  readonly unverified: boolean;
}

/** Why there is no endpoint read, in a sentence a person reads under "usage unknown". */
export interface ProviderQuotaNoPlan {
  readonly reason: string;
}

type EndpointSource = Exclude<ProviderQuotaSource, 'transcript-pricing' | 'none'>;

interface QuotaEndpoint {
  /** The address, from the login's plain values where the provider has more than one. */
  readonly url: (env: Readonly<Record<string, string>>) => string | ProviderQuotaNoPlan;
  readonly placement: CredentialPlacement;
  readonly parse: (payload: unknown, nowMs: number, host: string) => ProviderQuotaParse;
  readonly unverified: boolean;
}

const BEARER: CredentialPlacement = { header: 'authorization', scheme: 'Bearer' };
const MOONSHOT_MAINLAND = 'api.moonshot.cn';

/** The host of the login's `ANTHROPIC_BASE_URL`, when it is a plain key-safe address. */
function baseUrlOf(env: Readonly<Record<string, string>>): URL | undefined {
  const value = env.ANTHROPIC_BASE_URL;
  if (value === undefined || value.includes('$') || !isCredentialSafeUrl(value)) return undefined;
  const parsed = new URL(value);
  return parsed.username === '' && parsed.password === '' ? parsed : undefined;
}

const moonshotHost = (env: Readonly<Record<string, string>>): string =>
  baseUrlOf(env)?.host === MOONSHOT_MAINLAND || loginHosts(env).has(MOONSHOT_MAINLAND)
    ? MOONSHOT_MAINLAND
    : 'api.moonshot.ai';

/** Every source that has an endpoint, and how it is read. */
export const PROVIDER_QUOTA_ENDPOINTS: Readonly<Record<EndpointSource, QuotaEndpoint>> = {
  'zai-coding-plan': {
    url: () => 'https://api.z.ai/api/monitor/usage/quota/limit',
    // The community tools that found this endpoint send the bare key, with no `Bearer`.
    placement: { header: 'authorization' },
    parse: payload => parseZaiQuota(payload),
    unverified: true,
  },
  'minimax-token-plan': {
    url: () => 'https://www.minimax.io/v1/token_plan/remains',
    placement: BEARER,
    parse: (payload, nowMs) => parseMinimaxRemains(payload, nowMs),
    unverified: true,
  },
  'deepseek-balance': {
    url: () => 'https://api.deepseek.com/user/balance',
    placement: BEARER,
    parse: payload => parseDeepseekBalance(payload),
    unverified: false,
  },
  'moonshot-balance': {
    url: env => `https://${moonshotHost(env)}/v1/users/me/balance`,
    placement: BEARER,
    parse: (payload, _nowMs, host) => parseMoonshotBalance(payload, host === MOONSHOT_MAINLAND ? 'CNY' : 'USD'),
    unverified: false,
  },
  'openrouter-key': {
    url: () => 'https://openrouter.ai/api/v1/key',
    placement: BEARER,
    parse: payload => parseOpenRouterKey(payload),
    unverified: false,
  },
  'litellm-key-info': {
    url: env => {
      const base = baseUrlOf(env);
      if (base === undefined) return { reason: 'This login has no plain ANTHROPIC_BASE_URL to ask its proxy at.' };
      return `${base.origin}/key/info`;
    },
    placement: BEARER,
    parse: payload => parseLitellmKeyInfo(payload),
    unverified: true,
  },
  'vercel-credits': {
    url: () => 'https://ai-gateway.vercel.sh/v1/credits',
    placement: BEARER,
    parse: payload => parseVercelCredits(payload),
    unverified: true,
  },
};

/**
 * THE ONE PLACE this reader looks inside a preset. Preset files are changing shape (one preset per
 * provider, with `claude:` and `codex:` halves), so every read of a preset goes through these and a
 * shape change is a fix here, not across the module.
 */
export const presetQuotaSource = (preset: ProviderPreset | undefined): ProviderQuotaSource =>
  preset?.quota.source ?? 'transcript-pricing';

/** The variable a preset's Test sends its key in, when its Test sends one. */
const presetKeyVariable = (preset: ProviderPreset | undefined): string | undefined =>
  preset?.test.kind === 'request' || preset?.test.kind === 'inference' ? preset.test.keyVariable : undefined;

/** Whether a preset ships with Ferretry, so its pairing of quota source and key is vouched for. */
const presetIsBuiltIn = (preset: ProviderPreset | undefined): boolean => preset?.origin === 'built-in';

/** Whether the preset says its quota or spend facts are not from the provider's own docs. */
export const presetQuotaUnverified = (preset: ProviderPreset | undefined): boolean =>
  preset?.unverified.some(fact => /quota|usage|balance|spend/iu.test(fact)) ?? false;

/** Whether a source is read from an endpoint at all. */
export const hasQuotaEndpoint = (source: ProviderQuotaSource): source is EndpointSource =>
  source in PROVIDER_QUOTA_ENDPOINTS;

/** Exactly one secret reference and nothing around it. */
const WHOLE_REFERENCE = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

/**
 * Which variable carries the login's key: the one its preset's Test sends, else its Codex provider's,
 * else the only variable that is a whole secret reference.
 */
function keyVariableOf(login: ProviderQuotaLogin): string | undefined {
  const tested = presetKeyVariable(login.preset);
  if (tested !== undefined) return tested;
  const codex = login.credential.codexProvider?.keyVariable;
  if (codex !== undefined) return codex;
  const whole = Object.entries(login.credential.env ?? {}).filter(([, value]) => WHOLE_REFERENCE.test(value));
  return whole.length === 1 ? (whole[0] as [string, string])[0] : undefined;
}

/** `api.minimax.io` → `minimax.io`; a host of two labels or fewer is its own parent. */
const parentDomain = (host: string): string => {
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
};

/** The hosts this login sends its key to on its own: its plain URLs and its Codex provider. */
function ownHosts(login: ProviderQuotaLogin): ReadonlySet<string> {
  const hosts = new Set(loginHosts(login.credential.env ?? {}));
  const codexBase = login.credential.codexProvider?.baseUrl;
  if (codexBase !== undefined && !codexBase.includes('{') && isCredentialSafeUrl(codexBase)) {
    hosts.add(new URL(codexBase).host.toLowerCase());
  }
  return hosts;
}

/** The one endpoint read for this login, or why there is none. */
export function planProviderQuota(login: ProviderQuotaLogin): ProviderQuotaPlan | ProviderQuotaNoPlan {
  const source = presetQuotaSource(login.preset);
  if (!hasQuotaEndpoint(source)) return { reason: 'This provider has no quota endpoint.' };
  const endpoint = PROVIDER_QUOTA_ENDPOINTS[source];
  const env = login.credential.env ?? {};
  const keyVariable = keyVariableOf(login);
  const reference = keyVariable === undefined ? undefined : env[keyVariable];
  const whole = reference === undefined ? null : WHOLE_REFERENCE.exec(reference);
  if (whole === null) {
    return {
      reason: 'This login’s key is not a single ${secret:NAME}, so Ferretry cannot tell which key to ask with.',
    };
  }
  const url = endpoint.url(env);
  if (typeof url !== 'string') return url;
  const host = new URL(url).host.toLowerCase();
  const own = ownHosts(login);
  const related = own.has(host) || [...own].some(candidate => parentDomain(candidate) === parentDomain(host));
  if (!related && !presetIsBuiltIn(login.preset)) {
    return {
      reason: `Reading this quota would send the key to ${host}, which is not where this login sends it, so it is not read.`,
    };
  }
  return {
    secretName: whole[1] as SecretName,
    hosts: [host],
    placement: endpoint.placement,
    parse: (payload, nowMs) => endpoint.parse(payload, nowMs, host),
    unverified: endpoint.unverified,
    request: {
      method: 'GET',
      url,
      headers: { accept: 'application/json' },
      timeoutMs: PROVIDER_QUOTA_TIMEOUT_MS,
      maxResponseBytes: PROVIDER_QUOTA_MAX_BYTES,
    },
  };
}
