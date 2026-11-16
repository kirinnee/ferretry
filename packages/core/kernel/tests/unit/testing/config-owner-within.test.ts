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

const itemsDef = defineConfig({
  collection: 'items',
  name: /^[a-z]+$/,
  schema: z.strictObject({ size: z.number().default(1) }),
  axis: 'configure',
  loosens: () => [],
});

const manifest = definePlugin({
  id: 'warden',
  title: 'Warden',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [wardenDef, itemsDef] },
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

test('BG-011 the testing host answers an undeclared def and a bad name before a bad within, as the real writer does', async () => {
  const { host, config } = await testing();
  const bad = 'sentinel-2c81d0-not-a-list' as unknown as readonly string[];
  const stranger = defineConfig({
    file: 'stranger.yaml',
    schema: z.strictObject({ size: z.number().default(1) }),
    axis: 'configure',
    loosens: () => [],
  });
  expect(await config.writeAsOwner(stranger as never, undefined, { patch: { size: 2 }, within: bad })).toEqual({
    kind: 'refused',
    reason: 'not_declared',
    issues: [],
  });
  expect(config.file(wardenDef)).toEqual(START);
  // a bad item name, or none, is answered bad_name before the bad within is looked at
  for (const name of ['Bad_Name', undefined]) {
    expect(await config.writeAsOwner(itemsDef as never, name, { patch: { size: 2 }, within: bad })).toEqual({
      kind: 'refused',
      reason: 'bad_name',
      issues: [],
    });
  }
  // a within refusal names no value
  const refused = await config.writeAsOwner(wardenDef, undefined, { patch: { caps: { daily: 3 } }, within: bad });
  expect(refused).toMatchObject({ kind: 'refused', reason: 'schema' });
  expect(JSON.stringify(refused)).not.toContain('sentinel');
  await host.stop();
});

test('the testing host refuses a within that is not a list, as the real writer does, and writes nothing', async () => {
  const { host, config } = await testing();
  const refused = await config.writeAsOwner(wardenDef, undefined, {
    patch: { caps: { daily: 3 } },
    within: 'caps' as unknown as readonly string[],
  });
  expect(refused).toMatchObject({ kind: 'refused', reason: 'schema' });
  expect(config.file(wardenDef)).toEqual(START);
  await host.stop();
});
