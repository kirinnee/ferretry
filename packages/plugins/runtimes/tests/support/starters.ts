/**
 * Fake starter models for tests: what the catalog defaults come to when Logins states catalogs whose halves each name one
 * default model. Runtimes names no model of its own, so a test says which one the catalog gave.
 */
import type { ModelCatalogSourcesView } from '@ferretry/plugin-logins/contract';
import type { StarterModels } from '../../daemon/lib/models/catalog.ts';

export const TEST_STARTERS: Required<StarterModels> = { claude: 'claude-test-starter', codex: 'codex-test-starter' };

const half = (id: string) => ({
  models: [{ id, label: id, tier: 'best', context: 200000, efforts: ['low'], defaultEffort: 'low', default: true }],
});

/** `LoginsApi.modelSources()` as a fake gives it: the two sign-in catalogs, each with the test starter as its default. */
export const TEST_MODEL_SOURCES = {
  catalogs: {
    anthropic: { label: 'Anthropic', docs: 'https://example.test/anthropic', claude: half(TEST_STARTERS.claude) },
    openai: { label: 'OpenAI', docs: 'https://example.test/openai', codex: half(TEST_STARTERS.codex) },
  },
  presets: [],
} as unknown as ModelCatalogSourcesView;
