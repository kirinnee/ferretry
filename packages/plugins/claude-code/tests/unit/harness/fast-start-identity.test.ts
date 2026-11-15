import { describe, expect, test } from 'bun:test';
import type { StartDecideInput } from '@ferretry/core-ferrets/contract';
import type { RuntimesApi, RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { fastStartDecision } from '../../../daemon/lib/harness/fast-mode.ts';

/**
 * Which runtime a fast start is judged on is the one it NAMES: a runtime NAME (what Ferrets passes to `start.decide`, and
 * what `RuntimesApi.default()` returns), never the catalog row's persistent `id`. And a start that named a harness
 * or a login carries no runtime on purpose (Ferrets skips the machine default for it), so it is never judged on that default.
 */

const input = (extra: Partial<StartDecideInput> = {}): StartDecideInput => ({
  ferret: 'review' as StartDecideInput['ferret'],
  name: 'review',
  role: 'lead',
  harness: 'claude-code',
  folder: '/tmp/project',
  by: 'owner',
  fast: true,
  ...extra,
});

/** A catalog row whose persistent id differs from its name, as `runtimeCatalog` emits it. */
const view = (id: string, name: string, model: string): RuntimeView =>
  ({
    id,
    name,
    wrapper: name,
    harness: 'claude-code',
    models: { default: model },
    modelSet: { source: 'harness-default' },
  }) as unknown as RuntimeView;

/** What the real `RuntimesApi.default()` answers (runtimes-api.ts: the config NAME of the default runtime, never a row's id). */
const real: Pick<RuntimesApi, 'default'> = {
  default: async () => 'work' as Awaited<ReturnType<RuntimesApi['default']>>,
};

const SONNET_REFUSAL = { allow: false, reason: 'claude-sonnet-5-5 has no fast mode', code: 'unservable_model' };

describe('a fast start is judged on the runtime it names, by name', () => {
  test('a named runtime matches the catalog row by NAME when its persistent id differs', async () => {
    const catalog = async () => [view('rt-persistent', 'work', 'claude-sonnet-5-5')];
    expect(await fastStartDecision(input({ runtime: 'work' }), () => ({ catalog }))).toEqual(SONNET_REFUSAL);
  });

  test("a machine-default start carries the real default's NAME and is refused on a Sonnet default", async () => {
    // Ferrets passes `defaultRuntimeFor` (the real `RuntimesApi.default()`) as `runtime`: a config NAME, not the row's id.
    const name = String(await real.default());
    expect(name).toBe('work');
    const catalog = async () => [view('rt-persistent', 'work', 'claude-sonnet-5-5')];
    expect(await fastStartDecision(input({ runtime: name }), () => ({ catalog }))).toEqual(SONNET_REFUSAL);
  });

  test('a start that named a login carries no runtime, so an unrelated Sonnet machine default does not refuse it', async () => {
    const catalog = async () => [view('rt-persistent', 'work', 'claude-sonnet-5-5')];
    expect(await fastStartDecision(input({ login: 'direct-opus-account' }), () => ({ catalog }))).toEqual({
      allow: true,
    });
  });

  test('a start that named a harness (no runtime, no login) stays allowed whatever the machine default model is', async () => {
    for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
      const catalog = async () => [view('rt-persistent', 'work', model)];
      expect(await fastStartDecision(input(), () => ({ catalog }))).toEqual({ allow: true });
    }
  });
});
