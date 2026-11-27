/**
 * The model catalogs the goldens read: synthetic, small, and owned by this file (Logins' shipped catalogs change when its data is
 * refreshed, so a golden never reads them). A sign-in login reads `anthropic` / `openai`; an environment login made from the
 * `golden-gateway` preset reads `golden-gateway`, a catalog that takes custom ids.
 */
import { ModelCatalogFileSchema } from '@ferretry/plugin-logins/contract';
import type { ModelCatalogSources } from '../../../../daemon/lib/models/catalog.ts';
import type { ModelCatalog } from '../../../../daemon/lib/models/schema.ts';

const model = (
  id: string,
  label: string,
  tier: 'best' | 'fast' | 'balanced',
  options: Record<string, unknown> = {},
) => ({
  id,
  label,
  tier,
  context: 200_000,
  efforts: ['low', 'high'],
  defaultEffort: 'low',
  ...options,
});

const catalog = (id: string, file: Record<string, unknown>): ModelCatalog => ({
  ...ModelCatalogFileSchema.parse({ docs: 'https://models.example.test/docs', verified: '2026-11-01', ...file }),
  id,
  origin: 'built-in',
});

export const GOLDEN_CATALOGS: ModelCatalogSources = {
  catalogs: {
    anthropic: catalog('anthropic', {
      label: 'Golden Anthropic',
      claude: {
        tiers: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' },
        models: [
          model('claude-opus-5-5', 'Opus 5.5', 'best', { default: true }),
          model('claude-sonnet-5-5', 'Sonnet 5.5', 'balanced'),
          model('claude-haiku-5-5', 'Haiku 5.5', 'fast'),
        ],
      },
    }),
    openai: catalog('openai', {
      label: 'Golden OpenAI',
      codex: {
        models: [model('gpt-6', 'GPT-6', 'best', { default: true }), model('gpt-6-mini', 'GPT-6 mini', 'fast')],
      },
    }),
    'golden-gateway': catalog('golden-gateway', {
      label: 'Golden gateway',
      customIds: true,
      claude: {
        tiers: { opus: 'golden-large', sonnet: 'golden-large', haiku: 'golden-small' },
        models: [
          model('golden-large', 'Golden Large', 'best', { default: true }),
          model('golden-small', 'Golden Small', 'fast'),
        ],
      },
      codex: {
        models: [
          model('golden-large', 'Golden Large', 'best', { default: true }),
          model('golden-small', 'Golden Small', 'fast'),
        ],
      },
    }),
  },
  presets: [
    {
      id: 'golden-gateway',
      catalog: 'golden-gateway',
      halves: { claude: { env: { ANTHROPIC_BASE_URL: true } }, codex: { env: { GOLDEN_API_KEY: true } } },
    },
  ],
};
