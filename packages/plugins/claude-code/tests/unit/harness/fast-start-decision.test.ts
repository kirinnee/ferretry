import { describe, expect, test } from 'bun:test';
import { StartDecide, type StartDecideInput } from '@ferretry/core-ferrets/contract';
import { fastStartDecision } from '../../../daemon/lib/harness/fast-mode.ts';
import manifest from '../../../manifest.ts';

/**
 * Claude Code takes Ferrets' `start.decide`: a start that asks for fast mode on a model without it is refused with the
 * code Ferrets maps to `409 unservable_model`, before anything is written. Today's `fastStartRefusal` at the start.
 */

const input = (more: Partial<StartDecideInput> = {}): StartDecideInput => ({
  ferret: 'f1' as StartDecideInput['ferret'],
  name: 'wren',
  role: 'lead',
  harness: 'claude-code',
  folder: '/work/a',
  by: 'owner',
  ...more,
});

describe('claude-code takes start.decide', () => {
  test('(no guarantees row) the manifest takes start.decide', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === StartDecide.name)).toBe(true);
  });

  test('(no guarantees row) a fast start on Haiku or Sonnet is refused unservable_model, naming the model', () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
      expect(fastStartDecision(input({ model, fast: true }))).toEqual({
        allow: false,
        reason: `${model} has no fast mode`,
        code: 'unservable_model',
      });
    }
  });

  test('(no guarantees row) a fast start on Opus (fast-capable) is not refused, selector or not', () => {
    expect(fastStartDecision(input({ model: 'claude-opus-5-5', fast: true }))).toEqual({ allow: true });
    expect(fastStartDecision(input({ model: 'claude-opus-5-5[1m]', fast: true }))).toEqual({ allow: true });
  });

  test('(no guarantees row) a start that did not ask for fast, or named no model, or is another harness, is not judged', () => {
    expect(fastStartDecision(input({ model: 'claude-haiku-5-5' }))).toEqual({ allow: true });
    expect(fastStartDecision(input({ model: 'claude-haiku-5-5', fast: false }))).toEqual({ allow: true });
    expect(fastStartDecision(input({ fast: true }))).toEqual({ allow: true });
    expect(fastStartDecision(input({ harness: 'codex', model: 'claude-haiku-5-5', fast: true }))).toEqual({
      allow: true,
    });
  });
});
