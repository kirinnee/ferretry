import { describe, expect, test } from 'bun:test';
import { StartDecide, type StartDecideInput } from '@ferretry/core-ferrets/contract';
import { fastStartDecision } from '../../daemon/lib/fast-mode.ts';
import type { RuntimeModelChoice } from '../../daemon/lib/models.ts';
import manifest from '../../manifest.ts';

/**
 * Codex takes Ferrets' `start.decide`: a start that asks for fast mode on a model the live catalog says has none is
 * refused with the code Ferrets maps to `409 unservable_model`. A catalog that cannot be read refuses nothing.
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
const catalog = async () => choices;

describe('codex takes start.decide', () => {
  test('(no guarantees row) the manifest takes start.decide', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === StartDecide.name)).toBe(true);
  });

  test('(no guarantees row) a fast start on a model whose choice says fast: false is refused, naming its label', async () => {
    expect(await fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), catalog)).toEqual({
      allow: false,
      reason: 'Daybreak Blue has no fast mode',
      code: 'unservable_model',
    });
  });

  test('(no guarantees row) a fast start on a model that has fast mode is not refused', async () => {
    expect(await fastStartDecision(input({ model: 'gpt-6-sol', fast: true }), catalog)).toEqual({ allow: true });
  });

  test('(no guarantees row) a start naming no model is judged on the catalog default', async () => {
    expect(await fastStartDecision(input({ fast: true }), catalog)).toEqual({ allow: true });
    const slowDefault = async () => [{ ...choices[1], isDefault: true as const }] as readonly RuntimeModelChoice[];
    expect(await fastStartDecision(input({ fast: true }), slowDefault)).toMatchObject({ allow: false });
  });

  test('(no guarantees row) a catalog read failure gives no choices and refuses nothing', async () => {
    const broken = async (): Promise<readonly RuntimeModelChoice[]> => {
      throw new Error('the Codex model catalog probe timed out');
    };
    expect(await fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), broken)).toEqual({ allow: true });
    expect(await fastStartDecision(input({ fast: true }), broken)).toEqual({ allow: true });
  });

  test('(no guarantees row) the catalog is read only for a start that asked for fast on Codex', async () => {
    let reads = 0;
    const counted = async () => {
      reads += 1;
      return choices;
    };
    await fastStartDecision(input({ model: 'gpt-daybreak' }), counted);
    await fastStartDecision(input({ harness: 'claude-code', model: 'gpt-daybreak', fast: true }), counted);
    expect(reads).toBe(0);
    await fastStartDecision(input({ model: 'gpt-daybreak', fast: true }), counted);
    expect(reads).toBe(1);
  });
});
