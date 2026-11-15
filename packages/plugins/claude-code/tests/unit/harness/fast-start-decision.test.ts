import { describe, expect, test } from 'bun:test';
import { StartDecide, type StartDecideInput } from '@ferretry/core-ferrets/contract';
import type { RuntimeId, RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { fastStartDecision, runtimeDefaultModel, type RuntimeDefaults } from '../../../daemon/lib/harness/fast-mode.ts';
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

/** A runtime as Runtimes' catalogue shows it: only the fields the decision reads (`models` is the login catalog's default, `set` the model set's; `null` is a set whose login can use none). */
const view = (id: string, has: { models?: string; set?: string | null }): RuntimeView =>
  ({
    id,
    models: has.models === undefined ? undefined : { default: has.models },
    modelSet:
      has.set === undefined
        ? { source: 'harness-default' }
        : { source: 'model-set', default: has.set === null ? undefined : has.set },
  }) as unknown as RuntimeView;

/** The two Runtimes reads a start makes, with a count of how often they were asked. */
const runtimes = (held: { default?: string; views?: readonly RuntimeView[] }) => {
  let asked = 0;
  const api: RuntimeDefaults = {
    default: async () => {
      asked += 1;
      return held.default as RuntimeId | undefined;
    },
    catalog: async () => {
      asked += 1;
      return held.views ?? [];
    },
  };
  return { api, calls: () => asked };
};

describe('claude-code takes start.decide', () => {
  test('(no guarantees row) the manifest takes start.decide', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === StartDecide.name)).toBe(true);
  });

  test('(no guarantees row) a fast start on Haiku or Sonnet is refused unservable_model, naming the model', async () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
      expect(await fastStartDecision(input({ model, fast: true }), () => undefined)).toEqual({
        allow: false,
        reason: `${model} has no fast mode`,
        code: 'unservable_model',
      });
    }
  });

  test('(no guarantees row) a fast start on Opus (fast-capable) is not refused, selector or not', async () => {
    expect(await fastStartDecision(input({ model: 'claude-opus-5-5', fast: true }), () => undefined)).toEqual({
      allow: true,
    });
    expect(await fastStartDecision(input({ model: 'claude-opus-5-5[1m]', fast: true }), () => undefined)).toEqual({
      allow: true,
    });
  });

  test('(no guarantees row) a start that did not ask for fast, or is another harness, is not judged, and Runtimes is not read', async () => {
    const reads = runtimes({});
    expect(await fastStartDecision(input({ model: 'claude-haiku-5-5' }), () => reads.api)).toEqual({ allow: true });
    expect(await fastStartDecision(input({ model: 'claude-haiku-5-5', fast: false }), () => reads.api)).toEqual({
      allow: true,
    });
    expect(await fastStartDecision(input({ harness: 'codex', fast: true }), () => reads.api)).toEqual({ allow: true });
    expect(reads.calls()).toBe(0);
  });

  test('(no guarantees row) a start that NAMED a model is judged on it, and Runtimes is not read', async () => {
    const reads = runtimes({ default: 'work', views: [view('work', { models: 'claude-opus-5-5' })] });
    expect(await fastStartDecision(input({ model: 'claude-haiku-5-5', fast: true }), () => reads.api)).toEqual({
      allow: false,
      reason: 'claude-haiku-5-5 has no fast mode',
      code: 'unservable_model',
    });
    expect(reads.calls()).toBe(0);
  });

  test('(no guarantees row) a fast start naming no model is refused when the runtime it names defaults to a model without fast mode', async () => {
    const reads = runtimes({ views: [view('work', { models: 'claude-sonnet-5-5' })] });
    expect(await fastStartDecision(input({ fast: true, runtime: 'work' }), () => reads.api)).toEqual({
      allow: false,
      reason: 'claude-sonnet-5-5 has no fast mode',
      code: 'unservable_model',
    });
  });

  test("(no guarantees row) a fast start naming no model and no runtime is judged on the machine's default runtime", async () => {
    const reads = runtimes({
      default: 'home',
      views: [view('work', { models: 'claude-opus-5-5' }), view('home', { models: 'claude-haiku-5-5' })],
    });
    expect(await fastStartDecision(input({ fast: true }), () => reads.api)).toEqual({
      allow: false,
      reason: 'claude-haiku-5-5 has no fast mode',
      code: 'unservable_model',
    });
  });

  test("(no guarantees row) a fast start naming no model is allowed when the runtime's default model has fast mode", async () => {
    const reads = runtimes({ views: [view('work', { models: 'claude-opus-5-5' })] });
    expect(await fastStartDecision(input({ fast: true, runtime: 'work' }), () => reads.api)).toEqual({ allow: true });
  });

  test("(no guarantees row) a fast start whose model Runtimes cannot say is allowed: Runtimes off, no default runtime, an unknown runtime, or the account's own default", async () => {
    expect(await fastStartDecision(input({ fast: true }), () => undefined)).toEqual({ allow: true });
    expect(await fastStartDecision(input({ fast: true }), () => runtimes({}).api)).toEqual({ allow: true });
    expect(await fastStartDecision(input({ fast: true, runtime: 'gone' }), () => runtimes({ views: [] }).api)).toEqual({
      allow: true,
    });
    expect(
      await fastStartDecision(
        input({ fast: true, runtime: 'work' }),
        () => runtimes({ views: [view('work', {})] }).api,
      ),
    ).toEqual({ allow: true });
  });

  test("(no guarantees row) a runtime's default model is its login catalog's, else its model set's, else none", () => {
    expect(runtimeDefaultModel(undefined)).toBeUndefined();
    expect(runtimeDefaultModel(view('a', { models: 'claude-opus-5-5', set: 'claude-haiku-5-5' }))).toBe(
      'claude-opus-5-5',
    );
    expect(runtimeDefaultModel(view('a', { set: 'claude-haiku-5-5' }))).toBe('claude-haiku-5-5');
    expect(runtimeDefaultModel(view('a', { set: null }))).toBeUndefined();
    expect(runtimeDefaultModel(view('a', {}))).toBeUndefined();
  });
});
