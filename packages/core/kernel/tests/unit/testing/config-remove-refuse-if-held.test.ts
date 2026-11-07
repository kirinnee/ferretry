import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { ConfigPort } from '../../../contract/ports.ts';
import { defineConfig } from '../../../contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

/** The testing host mirrors the real port's `remove(..., { refuseIfHeld: true })`: would_hold, nothing removed. */
const logins = defineConfig({
  collection: 'logins',
  name: /^[a-z0-9-]{1,40}$/,
  schema: z.strictObject({ budget: z.number().optional() }),
  axis: 'configure',
  loosens: (before, after) =>
    (after.budget ?? Number.POSITIVE_INFINITY) > (before?.budget ?? Number.POSITIVE_INFINITY)
      ? ['raises or removes the budget']
      : [],
});

const manifest = definePlugin({
  id: 'logins',
  title: 'Logins',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [logins] },
});

async function boot(verdict: 'apply' | 'hold') {
  let config: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half],
    config: { logins: { work: { budget: 5 } } },
    gate: { judgeConfigWrite: () => verdict } as never,
  });
  if (config === undefined) throw new Error('the half was not built');
  return { host, config };
}

test('a removal the judge would hold is refused would_hold and the item stays', async () => {
  const { host, config } = await boot('hold');
  expect(await config.remove(logins, 'work', { refuseIfHeld: true })).toEqual({
    kind: 'refused',
    reason: 'would_hold',
    issues: [],
    sentences: ['raises or removes the budget'],
  });
  expect(config.collection(logins).get('work')).toEqual({ budget: 5 });
  await host.stop();
});

test('without refuseIfHeld the same removal is held, and a confirming judge removes it', async () => {
  const holding = await boot('hold');
  expect((await holding.config.remove(logins, 'work')).kind).toBe('held');
  await holding.host.stop();
  const applying = await boot('apply');
  expect((await applying.config.remove(logins, 'work', { refuseIfHeld: true })).kind).toBe('written');
  expect(applying.config.collection(logins).has('work')).toBe(false);
  await applying.host.stop();
});
