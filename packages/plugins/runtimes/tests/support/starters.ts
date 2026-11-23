/**
 * Fake starter models for tests: what the catalog defaults come to when Logins states catalogs whose halves each name one
 * default model. Runtimes names no model of its own, so a test says which one the catalog gave.
 */
import type { ModelCatalogSourcesView } from '@ferretry/plugin-logins/contract';
import { expect } from 'bun:test';
import { RUNTIMES_PINS } from '../../contract/index.ts';
import { statePins } from '../../daemon/adapters/starter-pins.ts';
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

type Held = { models: Record<string, string> } | undefined;

/** The plugin's state port over one in-memory file: missing, held, or damaged (it exists and cannot be parsed). */
export const fakePinState = (initial: Held, damaged = false) => {
  const box: { value: Held } = { value: initial };
  const writes: Held[] = [];
  const state = {
    read: async (file: unknown) => {
      expect(file).toBe(RUNTIMES_PINS);
      return damaged
        ? { ok: false as const, error: { file: 'starter-pins.json', reason: 'unparsable' as const, sentence: 'x' } }
        : { ok: true as const, value: box.value };
    },
    update: async (_file: unknown, fn: (current: Held) => Held) => {
      box.value = fn(box.value);
      writes.push(box.value);
      return { ok: true as const, value: box.value };
    },
  };
  return { box, writes, state: state as never };
};

/** The pins kept in memory over the real adapter, keyed `<harness>:<login>`: what the state file holds, for a test of the evaluator. */
export const memoryPins = (
  held: Record<string, string> = {},
  damaged = false,
): StarterPins & { readonly file: ReturnType<typeof fakePinState> } => {
  const file = fakePinState({ models: held }, damaged);
  return { ...statePins(file.state, () => {}), file };
};
