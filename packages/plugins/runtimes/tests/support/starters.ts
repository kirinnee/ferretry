/**
 * Fake starter models for tests: what the catalog defaults come to when Logins states catalogs whose halves each name one
 * default model. Runtimes names no model of its own, so a test says which one the catalog gave.
 */
import type { ModelCatalogSourcesView } from '@ferretry/plugin-logins/contract';
import type { StarterPins } from '../../daemon/adapters/runtimes-config-files.ts';
import type { StarterModels } from '../../daemon/lib/models/catalog.ts';

export const TEST_STARTERS: Required<StarterModels> = { claude: 'claude-test-starter', codex: 'codex-test-starter' };

const half = (id: string) => ({
  models: [{ id, label: id, tier: 'best', context: 200000, efforts: ['low'], defaultEffort: 'low', default: true }],
});

/** `LoginsApi.modelSources()` as a fake gives it: the two sign-in catalogs, each with these starters as its default. */
export const modelSourcesOf = (starters: Required<StarterModels>): ModelCatalogSourcesView =>
  ({
    catalogs: {
      anthropic: { label: 'Anthropic', docs: 'https://example.test/anthropic', claude: half(starters.claude) },
      openai: { label: 'OpenAI', docs: 'https://example.test/openai', codex: half(starters.codex) },
    },
    presets: [],
  }) as unknown as ModelCatalogSourcesView;

export const TEST_MODEL_SOURCES = modelSourcesOf(TEST_STARTERS);

/** The first-seen models kept in memory: what the state file holds, for a test of the adapter. */
export const memoryPins = (
  held: Map<string, string> = new Map(),
): StarterPins & { readonly held: Map<string, string> } => ({
  held,
  read: async () => new Map(held),
  add: async models => {
    for (const [name, model] of models) if (!held.has(name)) held.set(name, model);
  },
});
