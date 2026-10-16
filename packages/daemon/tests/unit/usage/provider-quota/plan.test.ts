import { describe, it } from 'bun:test';
import { builtInPresets, type Credential, CredentialSchema, type ProviderPreset } from '@ferretry/fleet';
import should from 'should';
import {
  hasQuotaEndpoint,
  PROVIDER_QUOTA_MAX_BYTES,
  PROVIDER_QUOTA_TIMEOUT_MS,
  type ProviderQuotaLogin,
  type ProviderQuotaPlan,
  planProviderQuota,
} from '../../../../src/lib/usage/provider-quota/plan.ts';
import { MOONSHOT_BALANCE, NOW_MS, ZAI_QUOTA } from './fixtures.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;
const credential = (input: Record<string, unknown>): Credential =>
  CredentialSchema.parse({ store: 'environment', ...input });
const login = (id: string, input: Record<string, unknown>, from: ProviderPreset | undefined): ProviderQuotaLogin => ({
  id,
  credential: credential({ preset: from?.id, ...input }),
  preset: from,
  agents: [`${id}-agent`],
});
const plan = (value: ReturnType<typeof planProviderQuota>): ProviderQuotaPlan => {
  if ('reason' in value) throw new Error(`expected a plan, got: ${value.reason}`);
  return value;
};

const GLM = login(
  'glm',
  {
    harness: 'claude',
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
  },
  preset('zai-glm'),
);

describe('planProviderQuota', () => {
  it('should read Z.ai with the bare key from its Test variable, to Z.ai only, flagged unverified', () => {
    // Act
    const actual = plan(planProviderQuota(GLM));

    // Assert
    should(actual.secretName).equal('ZAI_API_KEY');
    should(actual.hosts).deepEqual(['api.z.ai']);
    should(actual.placement).deepEqual({ header: 'authorization' });
    should(actual.request).deepEqual({
      method: 'GET',
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      headers: { accept: 'application/json' },
      timeoutMs: PROVIDER_QUOTA_TIMEOUT_MS,
      maxResponseBytes: PROVIDER_QUOTA_MAX_BYTES,
    });
    should(actual.unverified).be.true();
    should(actual.parse(ZAI_QUOTA, NOW_MS).kind).equal('quota');
  });

  it('should read each other provider at its own fixed address with a Bearer key', () => {
    // Arrange
    const cases: readonly [string, Record<string, unknown>, string, string][] = [
      [
        'minimax',
        {
          harness: 'claude',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
            ANTHROPIC_API_KEY: '${secret:MINIMAX_API_KEY}',
          },
        },
        'https://www.minimax.io/v1/token_plan/remains',
        'MINIMAX_API_KEY',
      ],
      [
        'deepseek',
        {
          harness: 'claude',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
            ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
          },
        },
        'https://api.deepseek.com/user/balance',
        'DEEPSEEK_API_KEY',
      ],
      [
        'kimi',
        {
          harness: 'claude',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
            ANTHROPIC_AUTH_TOKEN: '${secret:MOONSHOT_API_KEY}',
          },
        },
        'https://api.moonshot.ai/v1/users/me/balance',
        'MOONSHOT_API_KEY',
      ],
      [
        'openrouter',
        {
          harness: 'claude',
          env: {
            ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
            ANTHROPIC_AUTH_TOKEN: '${secret:OPENROUTER_API_KEY}',
            ANTHROPIC_API_KEY: '',
          },
        },
        'https://openrouter.ai/api/v1/key',
        'OPENROUTER_API_KEY',
      ],
      [
        'vercel-ai-gateway',
        {
          harness: 'claude',
          env: {
            ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
            ANTHROPIC_AUTH_TOKEN: '${secret:AI_GATEWAY_API_KEY}',
            ANTHROPIC_API_KEY: '',
          },
        },
        'https://ai-gateway.vercel.sh/v1/credits',
        'AI_GATEWAY_API_KEY',
      ],
      [
        'litellm',
        {
          harness: 'claude',
          env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_AUTH_TOKEN: '${secret:LITELLM_API_KEY}' },
        },
        'http://localhost:4000/key/info',
        'LITELLM_API_KEY',
      ],
    ];

    for (const [id, input, url, secret] of cases) {
      // Act
      const actual = plan(planProviderQuota(login(id, input, preset(id))));

      // Assert
      should(actual.request.url).equal(url);
      should(actual.secretName).equal(secret);
      should(actual.placement).deepEqual({ header: 'authorization', scheme: 'Bearer' });
    }
  });

  it('should take a Codex login key from its Codex provider and send it to that provider', () => {
    // Arrange
    const deepseek = login(
      'ds',
      {
        harness: 'codex',
        env: { DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}' },
        codexProvider: {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/',
          keyVariable: 'DEEPSEEK_API_KEY',
        },
      },
      { ...preset('deepseek-codex'), test: { kind: 'none', reason: 'none' } },
    );

    // Act
    const actual = plan(planProviderQuota(deepseek));

    // Assert
    should(actual.secretName).equal('DEEPSEEK_API_KEY');
    should(actual.hosts).deepEqual(['api.deepseek.com']);
  });

  it('should ask the mainland Moonshot platform in yuan for a login that sends its key there', () => {
    // Arrange
    const mainland = login(
      'kimi-cn',
      {
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic', ANTHROPIC_AUTH_TOKEN: '${secret:KIMI_KEY}' },
      },
      { ...preset('kimi'), origin: 'file' },
    );

    // Act
    const actual = plan(planProviderQuota(mainland));

    // Assert
    should(actual.request.url).equal('https://api.moonshot.cn/v1/users/me/balance');
    should(actual.parse(MOONSHOT_BALANCE, NOW_MS)).containDeep({ quota: { balance: { currency: 'CNY' } } });
  });

  it('should find the key as the only whole secret reference when nothing else names it', () => {
    // Arrange
    const odd = login(
      'odd',
      { harness: 'claude', env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', TOKEN: '${secret:OR_KEY}' } },
      { ...preset('openrouter'), test: { kind: 'none', reason: 'none' } },
    );

    // Act & Assert
    should(plan(planProviderQuota(odd)).secretName).equal('OR_KEY');
  });

  it('should let a machine preset read a sibling host of the login, and nothing further away', () => {
    // Arrange
    const minimax = { ...preset('minimax'), origin: 'file' as const };
    const sibling = login(
      'mm',
      {
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_API_KEY: '${secret:MM}' },
      },
      minimax,
    );
    const stranger = login(
      'oa',
      {
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.openai.com/v1', ANTHROPIC_API_KEY: '${secret:OPENAI}' },
      },
      { ...preset('deepseek'), origin: 'file', test: { kind: 'none', reason: 'none' } },
    );

    // Act
    const allowed = planProviderQuota(sibling);
    const refused = planProviderQuota(stranger);

    // Assert
    should(plan(allowed).hosts).deepEqual(['www.minimax.io']);
    should(refused).deepEqual({
      reason:
        'Reading this quota would send the key to api.deepseek.com, which is not where this login sends it, so it is not read.',
    });
  });

  it('should say why there is no read: no endpoint, no single key, or no proxy address', () => {
    // Arrange
    const anthropic = login(
      'api',
      { harness: 'claude', env: { ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' } },
      preset('anthropic-api-key'),
    );
    const templated = login(
      'glm2',
      { harness: 'claude', env: { ANTHROPIC_AUTH_TOKEN: 'Bearer ${secret:ZAI_API_KEY}' } },
      preset('zai-glm'),
    );
    const noKey = login(
      'none',
      { harness: 'claude', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } },
      {
        ...preset('zai-glm'),
        test: { kind: 'none', reason: 'none' },
      },
    );
    const proxy = login(
      'proxy',
      {
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: '${secret:URL}', ANTHROPIC_AUTH_TOKEN: '${secret:LITELLM_API_KEY}' },
      },
      preset('litellm'),
    );
    const unpreset = login('bare', { harness: 'claude', env: { ANTHROPIC_API_KEY: '${secret:K}' } }, undefined);

    // Act & Assert
    should(planProviderQuota(anthropic)).deepEqual({ reason: 'This provider has no quota endpoint.' });
    should(planProviderQuota(unpreset)).deepEqual({ reason: 'This provider has no quota endpoint.' });
    for (const keyless of [templated, noKey]) {
      should(planProviderQuota(keyless)).deepEqual({
        reason: 'This login’s key is not a single ${secret:NAME}, so Ferretry cannot tell which key to ask with.',
      });
    }
    should(planProviderQuota(proxy)).deepEqual({
      reason: 'This login has no plain ANTHROPIC_BASE_URL to ask its proxy at.',
    });
  });

  it('should know which sources have an endpoint', () => {
    // Act & Assert
    should(hasQuotaEndpoint('deepseek-balance')).be.true();
    should(hasQuotaEndpoint('transcript-pricing')).be.false();
    should(hasQuotaEndpoint('none')).be.false();
  });
});
