import { describe, expect, test } from 'bun:test';
import { defineHook } from '../../../contract/define.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * The test host's `decide` follows the real host's rule (`host/hooks.ts`) exactly: anything but an object with
 * `allow: true` is a refusal; a string `reason` is kept, else "<plugin> refused."; a string `code` passes through, any
 * other type is dropped.
 */

const Ask = defineHook('t.ask', { mode: 'decide' });
const base = { version: '5.0.0', api: 5, core: false, kinds: [] } as const;

async function decide(answer: unknown) {
  let ask: (() => Promise<unknown>) | undefined;
  const offerer = implementDaemon(
    definePlugin({ ...base, id: 'ferrets', title: 'Ferrets', hooks: { offers: [{ hook: Ask }] } }),
    {
      build: ctx => {
        ask = async () => await ctx.hooks.decide(Ask, {});
        return {};
      },
    },
  );
  const taker = implementDaemon(
    definePlugin({ ...base, id: 'codex', title: 'Codex', hooks: { takes: [{ hook: Ask }] } }),
    {
      build: () => ({ hooks: { 't.ask': () => answer as never } }),
    },
  );
  const host = await testHost({ plugins: [offerer, taker] });
  try {
    return await ask?.();
  } finally {
    await host.stop();
  }
}

describe('the test host decides as the real host does', () => {
  test('(no guarantees row) a string code passes through; a code of any other type is dropped', async () => {
    expect(await decide({ allow: false, reason: 'no', code: 'unservable_model' })).toEqual({
      allow: false,
      reason: 'no',
      code: 'unservable_model',
    });
    const dropped = await decide({ allow: false, reason: 'no', code: { x: 1 } });
    expect(dropped).toEqual({ allow: false, reason: 'no' });
    expect(dropped).not.toHaveProperty('code');
  });

  test('(no guarantees row) a reason that is not a string is replaced, never passed on', async () => {
    expect(await decide({ allow: false, reason: { leak: 'x' }, code: 'unservable_model' })).toEqual({
      allow: false,
      reason: 'codex refused.',
      code: 'unservable_model',
    });
    expect(await decide({ allow: false })).toEqual({ allow: false, reason: 'codex refused.' });
  });

  test('(no guarantees row) an answer that is not allow:true is a refusal, and carries no code', async () => {
    expect(await decide({ allow: 'yes', code: 'unservable_model' })).toEqual({
      allow: false,
      reason: 'codex refused.',
    });
    expect(await decide(null)).toEqual({ allow: false, reason: 'codex refused.' });
    expect(await decide({ allow: true })).toEqual({ allow: true });
  });
});
