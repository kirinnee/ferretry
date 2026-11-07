/**
 * Where one environment login's quota is read from, and with which key — decided before anything is
 * sent (docs/provider-quotas.md).
 *
 * The login's preset names a quota SOURCE from a closed set; the endpoint, the header and the reader of each
 * source are fixed here, in code. A preset file of this machine's own can therefore only pick one of
 * these, never name an address. The key still only goes where it belongs:
 *
 * - **to the login's own provider.** The endpoint's host must be a host the login already sends to
 *   (its base URL, its Codex provider), or share that host's parent domain (`www.minimax.io` beside
 *   `api.minimax.io`), unless the preset is a built-in one, whose pairing of source and key Ferretry
 *   ships and vouches for. A machine preset that pointed an OpenAI key at DeepSeek's balance is refused.
 * - **as one whole `${secret:NAME}`.** The value is put on the request by the Vault's `authorizeFetch`
 *   (docs/secrets.md); nothing here ever holds it.
 *
 * Pure.
 */
import type { CredentialPlacement, OutboundHttpRequest, SecretName } from '@ferretry/core-vault/contract';
import { SECRET_REFERENCE_SOURCE } from '@ferretry/core-vault/contract';
import type { ProviderQuotaSource } from '../../../../contract/index.ts';
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

/** `https://`, or plain `http://` only to this machine: where a key may be sent at all. */
export function isCredentialSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    const host = parsed.hostname;
    return parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  } catch {
    return false;
  }
}

/** The hosts the login itself sends to: every one of its plain values that is a key-safe URL. */
export function loginHosts(env: Readonly<Record<string, string>>): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const value of Object.values(env)) {
    if (value.includes('$') || !isCredentialSafeUrl(value)) continue;
    hosts.add(new URL(value).host.toLowerCase());
  }
  return hosts;
}

/**
 * One environment login, as the quota reader needs it, built from what Logins publishes about it (`LoginView.environment`
 * and its preset). Variables are the login's own: plain values as written, and a variable made from the secret store as
 * `${secret:NAME}` when it names exactly one secret.
 */
export interface ProviderQuotaLogin {
  readonly id: string;
  /** Where its preset says the quota is read from. */
  readonly source: ProviderQuotaSource;
  readonly variables: Readonly<Record<string, string>>;
  /** The variable that carries the key, when the preset's one secret variable names it. */
  readonly keyVariable?: string;
  /** The secret NAME the preset suggests for that variable (a one-CLI login of a two-CLI preset holds the same secret elsewhere). */
  readonly presetSecretName?: string;
  /** The base URL of the Codex model provider the login points Codex at, when it has one. */
  readonly codexBaseUrl?: string;
  /** Whether the preset ships with Ferretry, so its pairing of quota source and key is vouched for. */
  readonly builtIn: boolean;
  /** Whether the preset says its quota facts are not from the provider's own docs. */
  readonly unverified: boolean;
  /** The ferret-visible name a usage-feed row carries for it. */
  readonly agent: string;
}

/** One endpoint read, ready to send through the Vault. */
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

/** Whether a source is read from an endpoint at all. */
export const hasQuotaEndpoint = (source: ProviderQuotaSource): source is EndpointSource =>
  source in PROVIDER_QUOTA_ENDPOINTS;

/** Exactly one secret reference and nothing around it. */
const WHOLE_REFERENCE = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

/**
 * Which variable carries the login's key: the one its preset names, else the only variable that is a whole secret
 * reference.
 */
function keyVariableOf(login: ProviderQuotaLogin): string | undefined {
  if (login.keyVariable !== undefined) return login.keyVariable;
  const whole = Object.entries(login.variables).filter(([, value]) => WHOLE_REFERENCE.test(value));
  return whole.length === 1 ? (whole[0] as [string, string])[0] : undefined;
}

/**
 * The key a one-CLI login of a two-CLI preset carries under its own half's variable: the preset names the key by one half's
 * variable (`ANTHROPIC_AUTH_TOKEN`), a Codex-only login holds the same SECRET as `DEEPSEEK_API_KEY`. Only that exact
 * `${secret:NAME}` counts.
 */
function sameSecretElsewhere(login: ProviderQuotaLogin): string | undefined {
  const name = login.presetSecretName;
  return name === undefined ? undefined : Object.values(login.variables).find(value => value === `\${secret:${name}}`);
}

/** `api.minimax.io` → `minimax.io`; a host of two labels or fewer is its own parent. */
const parentDomain = (host: string): string => {
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
};

/** The hosts this login sends its key to on its own: its plain URLs and its Codex provider. */
function ownHosts(login: ProviderQuotaLogin): ReadonlySet<string> {
  const hosts = new Set(loginHosts(login.variables));
  const codexBase = login.codexBaseUrl;
  if (codexBase !== undefined && !codexBase.includes('{') && isCredentialSafeUrl(codexBase)) {
    hosts.add(new URL(codexBase).host.toLowerCase());
  }
  return hosts;
}

/** The one endpoint read for this login, or why there is none. */
export function planProviderQuota(login: ProviderQuotaLogin): ProviderQuotaPlan | ProviderQuotaNoPlan {
  const source = login.source;
  if (!hasQuotaEndpoint(source)) return { reason: 'This provider has no quota endpoint.' };
  const endpoint = PROVIDER_QUOTA_ENDPOINTS[source as EndpointSource];
  // Every half's variables: a login that drives both CLIs carries its one key in either half.
  const env = login.variables;
  const keyVariable = keyVariableOf(login);
  const reference = keyVariable === undefined ? undefined : (env[keyVariable] ?? sameSecretElsewhere(login));
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
  if (!related && !login.builtIn) {
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
