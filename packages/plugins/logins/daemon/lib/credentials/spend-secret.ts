import type { SecretName } from '@ferretry/core-vault/contract';
import type { LoginView, ProviderPresetCatalog, ProviderQuotaSource } from '../../../contract/index.ts';
import { isCredentialSafeUrl } from '../shared/environment.ts';
import { loginHosts } from '../provider-probe/plan.ts';

/**
 * The secret a login's key is held under, read from THAT LOGIN'S OWN record and never from a caller: the one secret the
 * named variable of an environment login is made from. `undefined` for a login that is not made from environment
 * variables, a variable that does not exist, is plain or hidden, or is made from more than one secret — the spend is then
 * refused, so a caller that guesses a variable name reaches nothing a login does not already hold.
 */
export function spendSecretOf(login: LoginView | undefined, variable: string): SecretName | undefined {
  if (login?.store !== 'environment') return undefined;
  const held = login.environment?.variables.find(candidate => candidate.name === variable);
  return held?.kind === 'secret' && held.secrets.length === 1 ? (held.secrets[0] as SecretName) : undefined;
}

/** The host each quota source is read from, as a built-in preset pairs it with its key (Usage's endpoints, same hosts). */
const BUILT_IN_QUOTA_HOSTS: Readonly<Partial<Record<ProviderQuotaSource, readonly string[]>>> = {
  'zai-coding-plan': ['api.z.ai'],
  'minimax-token-plan': ['www.minimax.io'],
  'deepseek-balance': ['api.deepseek.com'],
  'moonshot-balance': ['api.moonshot.ai', 'api.moonshot.cn'],
  'openrouter-key': ['openrouter.ai'],
  'vercel-credits': ['ai-gateway.vercel.sh'],
};

/**
 * The hosts a login's key may be put on, decided from THAT LOGIN'S OWN record and never from a caller — today's keyed Test
 * rule (`provider-probe/plan.ts`): a host the login itself sends to (every plain value of it that is a key-safe URL, and its
 * Codex provider's address), or, for a login made from a BUILT-IN preset, the host that preset pairs with its quota source.
 * A machine's own preset names no host of its own, so it can never widen this.
 */
export function spendHostsOf(login: LoginView | undefined, presets: ProviderPresetCatalog): ReadonlySet<string> {
  const environment = login?.store === 'environment' ? login.environment : undefined;
  if (environment === undefined) return new Set();
  const plain: Record<string, string> = {};
  for (const variable of environment.variables) if (variable.kind === 'plain') plain[variable.name] = variable.value;
  const hosts = new Set(loginHosts(plain));
  const codexBase = environment.codexProvider?.baseUrl;
  if (codexBase !== undefined && !codexBase.includes('$') && isCredentialSafeUrl(codexBase)) {
    hosts.add(new URL(codexBase).host.toLowerCase());
  }
  const builtIn = presets.presets.find(candidate => candidate.id === environment.preset?.id)?.origin === 'built-in';
  if (builtIn) for (const host of BUILT_IN_QUOTA_HOSTS[environment.quotaSource] ?? []) hosts.add(host);
  return hosts;
}

/** The entries of `hostAllowlist` that are both in the login's own allowance and reachable by the CALLER's manifest. */
export function spendableHosts(
  allowed: ReadonlySet<string>,
  hostAllowlist: readonly string[],
  callerMayReach: (hostname: string) => boolean,
): readonly string[] {
  return hostAllowlist.filter(entry => allowed.has(entry.toLowerCase()) && callerMayReach(hostnameOf(entry)));
}

/** `host:port` → `host`; a bracketed IPv6 literal keeps its brackets, as a URL's hostname does. */
function hostnameOf(entry: string): string {
  if (entry.startsWith('[')) return entry.slice(0, entry.indexOf(']') + 1);
  const colon = entry.lastIndexOf(':');
  return colon === -1 ? entry : entry.slice(0, colon);
}
