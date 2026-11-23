import { describe, expect, test } from 'bun:test';
import { StartDecide, type StartDecideInput } from '@ferretry/core-ferrets/contract';
import {
  CATALOG_LOADING,
  CODEX_NOT_FOUND,
  FAST_NOT_CONFIRMED,
  fastStartDecision,
  openaiFallbackChoices,
} from '../../daemon/lib/fast-mode.ts';
import type { RuntimeModelChoice } from '../../daemon/lib/models.ts';
import manifest from '../../manifest.ts';

/**
 * Codex takes Ferrets' `start.decide`: a start that asks for fast mode on a model the live catalog says has none is
 * refused with the code Ferrets maps to `409 unservable_model`. With no catalog held at all, a fast start is refused at once (#35).
 */

const input = (more: Partial<StartDecideInput> = {}): StartDecideInput => ({
  ferret: 'f1' as StartDecideInput['ferret'],
  name: 'wren',
  role: 'lead',
  harness: 'codex',
  folder: '/work/a',
  by: 'owner',
  ...more,
});

const choices: readonly RuntimeModelChoice[] = [
  { value: 'gpt-6-sol', label: 'GPT-6-Sol', reasoningEfforts: [], fast: true, isDefault: true },
  { value: 'gpt-daybreak', label: 'Daybreak Blue', reasoningEfforts: [], fast: false },
];
const catalog = () => choices;

describe('codex takes start.decide', () => {
  test('(no guarantees row) the manifest takes start.decide', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === StartDecide.name)).toBe(true);
  });

  test('(no guarantees row) a fast start on a model whose choice says fast: false is refused, naming its label', () => {
    expect(fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), catalog)).toEqual({
      allow: false,
      reason: 'Daybreak Blue has no fast mode',
      code: 'unservable_model',
    });
  });

  test('(no guarantees row) a fast start on a model that has fast mode is not refused', () => {
    expect(fastStartDecision(input({ model: 'gpt-6-sol', fast: true }), catalog)).toEqual({ allow: true });
  });

  test('(no guarantees row) a start naming no model is judged on the catalog default', () => {
    expect(fastStartDecision(input({ fast: true }), catalog)).toEqual({ allow: true });
    const slowDefault = () => [{ ...choices[1], isDefault: true as const }] as readonly RuntimeModelChoice[];
    expect(fastStartDecision(input({ fast: true }), slowDefault)).toMatchObject({ allow: false });
  });

  test('U0 with nothing held, a model the openai catalog lists is refused as "not confirmed" and an unlisted one as "loading"; never allowed', () => {
    const none = (): undefined => undefined;
    const known = (): readonly RuntimeModelChoice[] => [
      { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: [], isDefault: true },
    ];
    const listed = fastStartDecision(input({ model: 'gpt-6.1-sol', fast: true }), none, () => false, known);
    expect(listed).toEqual({ allow: false, reason: FAST_NOT_CONFIRMED('GPT-6.1 Sol'), code: 'unservable_model' });
    // With a read waiting out its backoff, the refusal says when.
    const waiting = fastStartDecision(
      input({ model: 'gpt-6.1-sol', fast: true }),
      none,
      () => false,
      known,
      () => 61_000,
    );
    expect(waiting).toMatchObject({ allow: false });
    expect((waiting as { reason: string }).reason).toContain('about 2 min');
    // No model named: the catalog's default is the one judged.
    expect(fastStartDecision(input({ fast: true }), none, () => false, known)).toEqual(listed);
    // A model in neither catalog keeps today's sentence.
    expect(fastStartDecision(input({ model: 'gpt-unknown', fast: true }), none, () => false, known)).toMatchObject({
      allow: false,
      reason: CATALOG_LOADING,
    });
    // A start that did not ask for fast is never held up.
    expect(fastStartDecision(input({ model: 'gpt-6.1-sol' }), none, () => false, known)).toEqual({ allow: true });
  });

  test('U0 the openai catalog restated as fallback choices: codex half only, no fast flag, default marked', () => {
    const view = {
      catalogs: [
        { id: 'anthropic' },
        {
          id: 'openai',
          codex: [
            { id: 'a', label: 'A', tier: 'best' as const, efforts: ['low', 'high'], default: false, context: 1000 },
            { id: 'b', label: 'B', tier: 'balanced' as const, efforts: [], default: true },
          ],
        },
      ],
    };
    const choices = openaiFallbackChoices(view);
    expect(choices?.map(choice => choice.value)).toEqual(['a', 'b']);
    expect(choices?.every(choice => choice.fast === undefined)).toBe(true);
    expect(choices?.find(choice => choice.isDefault === true)?.value).toBe('b');
    expect(choices?.[0]?.reasoningEfforts).toEqual([{ value: 'low' }, { value: 'high' }]);
    expect(openaiFallbackChoices({ catalogs: [{ id: 'openai' }] })).toBeUndefined();
    expect(openaiFallbackChoices({ catalogs: [] })).toBeUndefined();
  });

  test('(no guarantees row) #35 a fast start with NO catalog held is refused at once, with the loading sentence and the existing code', () => {
    const none = (): undefined => undefined;
    const refused = {
      allow: false,
      reason: "Codex's model list is still loading; try again in a few seconds",
      code: 'unservable_model',
    };
    expect(CATALOG_LOADING).toBe(refused.reason);
    expect(fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), none)).toEqual(refused);
    expect(fastStartDecision(input({ model: 'gpt-6-sol', fast: true }), none)).toEqual(refused);
    expect(fastStartDecision(input({ fast: true }), none)).toEqual(refused);
  });

  test('(no guarantees row) r3 LOW-C no catalog held and no Codex binary found is refused with a true sentence and the same closed code, never "still loading"', () => {
    const none = (): undefined => undefined;
    const refused = fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), none, () => true);
    expect(refused).toEqual({
      allow: false,
      reason: 'Codex could not be found, so its fast mode cannot be checked',
      code: 'unservable_model',
    });
    expect(CODEX_NOT_FOUND).toBe((refused as { reason: string }).reason);
    expect(fastStartDecision(input({ fast: true }), none, () => false)).toMatchObject({ reason: CATALOG_LOADING });
    // A held catalog decides; a missing binary does not undo it.
    expect(fastStartDecision(input({ model: 'gpt-6-sol', fast: true }), catalog, () => true)).toEqual({ allow: true });
    // Not asking for fast is never held up by it.
    expect(fastStartDecision(input({ model: 'gpt-daybreak' }), none, () => true)).toEqual({ allow: true });
  });

  test('(no guarantees row) #35 a start that did not ask for fast, or is not Codex, is never held up by a missing catalog', () => {
    const none = (): undefined => undefined;
    expect(fastStartDecision(input({ model: 'gpt-daybreak' }), none)).toEqual({ allow: true });
    expect(fastStartDecision(input({ model: 'gpt-daybreak', fast: false }), none)).toEqual({ allow: true });
    expect(fastStartDecision(input({ harness: 'claude-code', model: 'x', fast: true }), none)).toEqual({ allow: true });
  });

  test('(no guarantees row) a held catalog that does not list the named model refuses nothing', () => {
    expect(fastStartDecision(input({ model: 'gpt-unlisted', fast: true }), catalog)).toEqual({ allow: true });
  });

  test('(no guarantees row) the catalog is consulted only for a start that asked for fast on Codex', () => {
    let reads = 0;
    const counted = () => {
      reads += 1;
      return choices;
    };
    fastStartDecision(input({ model: 'gpt-daybreak' }), counted);
    fastStartDecision(input({ harness: 'claude-code', model: 'gpt-daybreak', fast: true }), counted);
    expect(reads).toBe(0);
    fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), counted);
    expect(reads).toBe(1);
  });

  test('(no guarantees row) the decision never waits: it returns a decision, not a promise', () => {
    expect(fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), catalog)).not.toBeInstanceOf(Promise);
  });
});
