import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { ConfigPort } from '../../../contract/ports.ts';
import { defineConfig } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';
import { captureLog, HOME, manualClock } from '../host-config/support.ts';

/** The testing host's `writeAsOwner(..., { within })` stays in step with the real writer's one-level merge. */
const DEFAULT_CAPS = { daily: 10, price: 2 };
const wardenDef = defineConfig({
  file: 'warden.yaml',
  schema: z.strictObject({
    enabled: z.boolean().default(true),
    caps: z
      .strictObject({ daily: z.number().default(10), price: z.number().default(2), weekly: z.number().optional() })
      .default(DEFAULT_CAPS),
  }),
  axis: 'configure',
  loosens: (before, after) => (after.caps.daily > (before?.caps.daily ?? 10) ? ['raises the daily cap'] : []),
});

const manifest = definePlugin({
  id: 'warden',
  title: 'Warden',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [wardenDef] },
});

const START = { enabled: true, caps: { daily: 5, price: 0.042, weekly: 40 } };

async function testing() {
  let config: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half],
    config: { 'warden.yaml': structuredClone(START) },
    gate: { judgeConfigWrite: () => 'apply' } as never,
  });
  if (config === undefined) throw new Error('the half was not built');
  return { host, config };
}

async function real() {
  const files = createConfigFiles({
    home: HOME,
    fs: createMemoryHostFs(),
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'warden', def: wardenDef }],
    judge: () => true,
  });
  await files.reload();
  const port = files.port('warden');
  expect(
    (await port.write(wardenDef, undefined, 'enabled: true\ncaps:\n  daily: 5\n  price: 0.042\n  weekly: 40\n')).kind,
  ).toBe('written');
  return port;
}

const CASES: readonly { readonly patch: Record<string, unknown>; readonly within?: readonly string[] }[] = [
  { patch: { caps: { daily: 3 } }, within: ['caps'] },
  { patch: { caps: { weekly: undefined } }, within: ['caps'] },
  { patch: { caps: { daily: 3 } } },
  { patch: { caps: { daily: 3 }, enabled: false }, within: ['enabled', 'caps'] },
  { patch: { enabled: false }, within: ['caps'] },
  { patch: { caps: undefined }, within: ['caps'] },
  { patch: { caps: { daily: 20 } }, within: ['caps'] },
];

test('the testing host answers every within case as the real writer does: the same value in effect after', async () => {
  for (const edit of CASES) {
    const port = await real();
    const { host, config } = await testing();
    const realOutcome = await port.writeAsOwner(wardenDef, undefined, edit);
    const testOutcome = await config.writeAsOwner(wardenDef, undefined, edit);
    expect({ edit, kind: testOutcome.kind }).toEqual({ edit, kind: realOutcome.kind });
    expect({ edit, value: config.file(wardenDef) }).toEqual({ edit, value: port.file(wardenDef) });
    await host.stop();
  }
});

test('the testing host keeps the sub-keys a within save does not name, and refuses a merged result the schema refuses', async () => {
  const { host, config } = await testing();
  expect(
    (await config.writeAsOwner(wardenDef, undefined, { patch: { caps: { daily: 3 } }, within: ['caps'] })).kind,
  ).toBe('written');
  expect(config.file(wardenDef)).toEqual({ enabled: true, caps: { daily: 3, price: 0.042, weekly: 40 } });
  const refused = await config.writeAsOwner(wardenDef, undefined, { patch: { caps: { extra: 1 } }, within: ['caps'] });
  expect(refused).toMatchObject({ kind: 'refused', reason: 'schema' });
  expect(config.file(wardenDef)).toEqual({ enabled: true, caps: { daily: 3, price: 0.042, weekly: 40 } });
  // a plain write never merges, even handed a within
  const edit = { patch: { caps: { daily: 4 } }, within: ['caps'] };
  expect((await config.write(wardenDef, undefined, edit)).kind).toBe('written');
  expect(config.file(wardenDef)).toEqual({ enabled: true, caps: { daily: 4, price: 2 } });
  await host.stop();
});
