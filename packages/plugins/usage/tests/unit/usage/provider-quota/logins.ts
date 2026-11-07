/**
 * Logins as the quota reader receives them (`ProviderQuotaLogin`), built the way `providerQuotaLogins` builds them from what
 * Logins publishes. The presets here are the facts each built-in preset ships that the quota reader uses: where its quota is
 * read, which variable carries the key and what the preset suggests that secret be called.
 */
import type { ProviderQuotaSource } from '../../../../contract/index.ts';
import type { ProviderQuotaLogin } from '../../../../daemon/lib/usage/provider-quota/plan.ts';

export interface TestPreset {
  readonly id: string;
  readonly origin: 'built-in' | 'file';
  readonly quotaSource: ProviderQuotaSource;
  /** The variable the preset's Test sends the key from; absent: the preset names none. */
  readonly keyVariable?: string;
  readonly secretName?: string;
  readonly unverified: boolean;
  /** Set to `{ kind: 'none' }` to make the preset name no key variable. */
  readonly test?: { readonly kind: string; readonly reason?: string };
}

const PRESETS: readonly TestPreset[] = [
  { id: 'zai-glm', origin: 'built-in', quotaSource: 'zai-coding-plan', keyVariable: 'ANTHROPIC_AUTH_TOKEN', secretName: 'ZAI_API_KEY', unverified: true },
  { id: 'deepseek', origin: 'built-in', quotaSource: 'deepseek-balance', keyVariable: 'ANTHROPIC_AUTH_TOKEN', secretName: 'DEEPSEEK_API_KEY', unverified: false },
  { id: 'kimi', origin: 'built-in', quotaSource: 'moonshot-balance', keyVariable: 'ANTHROPIC_AUTH_TOKEN', secretName: 'MOONSHOT_API_KEY', unverified: false },
  { id: 'vercel-ai-gateway', origin: 'built-in', quotaSource: 'vercel-credits', keyVariable: 'ANTHROPIC_AUTH_TOKEN', secretName: 'AI_GATEWAY_API_KEY', unverified: true },
  { id: 'litellm', origin: 'built-in', quotaSource: 'litellm-key-info', keyVariable: 'ANTHROPIC_AUTH_TOKEN', secretName: 'LITELLM_API_KEY', unverified: true },
  { id: 'minimax', origin: 'built-in', quotaSource: 'minimax-token-plan', keyVariable: 'ANTHROPIC_API_KEY', secretName: 'MINIMAX_API_KEY', unverified: false },
  { id: 'openrouter', origin: 'built-in', quotaSource: 'openrouter-key', keyVariable: 'ANTHROPIC_AUTH_TOKEN', secretName: 'OPENROUTER_API_KEY', unverified: false },
  { id: 'anthropic-api-key', origin: 'built-in', quotaSource: 'transcript-pricing', keyVariable: 'ANTHROPIC_API_KEY', secretName: 'ANTHROPIC_API_KEY', unverified: false },
  { id: 'ollama-codex', origin: 'built-in', quotaSource: 'none', unverified: true },
];

export const preset = (id: string): TestPreset => PRESETS.find(entry => entry.id === id) as TestPreset;

interface HalfInput {
  readonly env?: Readonly<Record<string, string>>;
  readonly codexProvider?: { readonly id?: string; readonly name?: string; readonly keyVariable?: string; readonly baseUrl?: string };
}
export interface LoginInput extends HalfInput {
  readonly harness?: string;
  readonly claude?: HalfInput;
  readonly codex?: HalfInput;
}

/** A login as the reader gets it: its variables merged across halves, its Codex provider's address, and its preset's facts. */
export function login(id: string, input: LoginInput, from: TestPreset | undefined): ProviderQuotaLogin {
  const variables = { ...input.env, ...input.claude?.env, ...input.codex?.env };
  const codexBaseUrl = input.codexProvider?.baseUrl ?? input.codex?.codexProvider?.baseUrl;
  const keyed = from?.test?.kind === 'none' ? undefined : from?.keyVariable;
  return {
    id,
    source: from?.quotaSource ?? 'transcript-pricing',
    variables,
    ...(keyed === undefined ? {} : { keyVariable: keyed }),
    ...(from?.secretName === undefined ? {} : { presetSecretName: from.secretName }),
    ...(codexBaseUrl === undefined ? {} : { codexBaseUrl }),
    builtIn: from?.origin === 'built-in',
    unverified: from?.unverified ?? false,
    agent: `${id}-agent`,
  };
}
