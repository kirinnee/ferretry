/**
 * What a published runtime serves, as a move, a handover or a live model switch plans against it (`runtime.start`
 * `catalog?`): its servable models with the context window each one gets (the launch gate's own `launchContextWindow`,
 * so there is no second spelling of a window), the default, the harness and the model catalog it came from. ONE mapper
 * from Runtimes' `RuntimeView` to the contract's `RuntimeModelCatalog`. Values-free: model ids, labels and numbers, never
 * a credential, a profile, a path or a note.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeModelCatalogSchema } from '@ferretry/core-ferrets/contract';
import type { RuntimeModelChoice, RuntimeView } from '../../../contract/wire/index.ts';
import { runtimeModelCatalog } from '../../../daemon/lib/runtime-model-catalog.ts';

const choice = (id: string, extra: Partial<RuntimeModelChoice> = {}): RuntimeModelChoice => ({
  id,
  label: id.toUpperCase(),
  efforts: [],
  available: true,
  ...extra,
});

const catalogMeta = { id: 'anthropic', label: 'Anthropic', origin: 'built-in', customIds: true, docs: 'docs' } as const;

const view = (extra: Record<string, unknown> = {}): RuntimeView =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'work',
    wrapper: 'SECRET-WRAPPER',
    harness: 'claude-code',
    credential: { id: 'SECRET-CREDENTIAL-ID', store: 'host', label: 'SECRET-LABEL' },
    profile: 'SECRET-PROFILE-NAME',
    modelSet: { source: 'harness-default' },
    ...extra,
  }) as unknown as RuntimeView;

const withModels = (choices: RuntimeModelChoice[], rest: Record<string, unknown> = {}): RuntimeView =>
  view({ models: { catalog: catalogMeta, choices, ...rest } });

describe('runtimeModelCatalog › a runtime whose login reads a model catalog', () => {
  test('answers its servable models, the default marked, with efforts, tier, fast and the window each gets', () => {
    const answer = runtimeModelCatalog(
      withModels(
        [
          choice('opus', {
            label: 'Opus',
            tier: 'best',
            context: 500_000,
            efforts: ['low', 'high'],
            defaultEffort: 'high',
            fast: true,
          }),
          choice('haiku', { label: 'Haiku', tier: 'fast', fast: false }),
        ],
        { default: 'opus' },
      ),
    );

    expect(answer).toEqual({
      harness: 'claude',
      source: 'wrapper-inventory',
      choices: [
        {
          value: 'opus',
          label: 'Opus',
          tier: 'best',
          context: 500_000,
          isDefault: true,
          reasoningEfforts: [{ value: 'low' }, { value: 'high' }],
          defaultReasoningEffort: 'high',
          fast: true,
        },
        // No window declared anywhere: v4's 200k.
        { value: 'haiku', label: 'Haiku', tier: 'fast', context: 200_000, reasoningEfforts: [], fast: false },
      ],
      catalog: { id: 'anthropic', label: 'Anthropic', customIds: true },
    });
  });

  test('a model the login cannot use is not servable, so it is not offered and its reason is not carried', () => {
    const answer = runtimeModelCatalog(
      withModels([choice('opus'), choice('gone', { available: false, note: 'not on this plan' })], { default: 'opus' }),
    );

    expect(answer.choices.map(entry => entry.value)).toEqual(['opus']);
    expect(JSON.stringify(answer)).not.toContain('not on this plan');
  });

  test("a `[1m]` selector states 1M, as the launch gate's window does", () => {
    const answer = runtimeModelCatalog(withModels([choice('opus[1m]'), choice('opus')], { default: 'opus[1m]' }));

    expect(answer.choices.map(entry => [entry.value, entry.context])).toEqual([
      ['opus[1m]', 1_000_000],
      ['opus', 200_000],
    ]);
  });

  test('a default that is not servable marks nothing', () => {
    const answer = runtimeModelCatalog(withModels([choice('opus')], { default: 'gone' }));

    expect(answer.choices.some(entry => entry.isDefault === true)).toBe(false);
  });

  test('a Codex runtime answers the harness Codex; a login whose catalog takes no custom ids says so', () => {
    const answer = runtimeModelCatalog(
      view({
        harness: 'codex',
        models: { catalog: { ...catalogMeta, customIds: false }, choices: [choice('gpt')], default: 'gpt' },
      }),
    );

    expect(answer.harness).toBe('codex');
    expect(answer.catalog?.customIds).toBe(false);
  });

  test('the answer is the one RuntimeModelCatalog the runtime control reads', () => {
    const answer = runtimeModelCatalog(withModels([choice('opus', { efforts: ['low'] })], { default: 'opus' }));

    expect(RuntimeModelCatalogSchema.safeParse(answer).success).toBe(true);
  });
});

describe('runtimeModelCatalog › a runtime with no model catalog', () => {
  test("a profile's model set serves the available models it lists, its launch default marked, no catalog meta", () => {
    const answer = runtimeModelCatalog(
      view({
        modelSet: {
          source: 'model-set',
          name: 'set',
          models: [
            { id: 'sonnet', available: true },
            { id: 'old', available: false },
          ],
          declaredDefault: 'old',
          default: 'sonnet',
          note: 'the declared default moved',
        },
      }),
    );

    expect(answer).toEqual({
      harness: 'claude',
      source: 'wrapper-inventory',
      choices: [{ value: 'sonnet', label: 'sonnet', context: 200_000, isDefault: true, reasoningEfforts: [] }],
    });
  });

  test("the harness's own default model set names no model, so it offers none", () => {
    expect(runtimeModelCatalog(view()).choices).toEqual([]);
  });
});

describe('runtimeModelCatalog › values-free', () => {
  test('no credential, profile, wrapper, label or note reaches the answer', () => {
    const text = JSON.stringify(
      runtimeModelCatalog(withModels([choice('opus', { note: 'SECRET-NOTE' })], { default: 'opus', local: undefined })),
    );

    for (const leak of [
      'SECRET-CREDENTIAL-ID',
      'SECRET-LABEL',
      'SECRET-PROFILE-NAME',
      'SECRET-WRAPPER',
      'SECRET-NOTE',
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});
