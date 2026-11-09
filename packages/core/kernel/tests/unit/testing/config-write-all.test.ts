import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { ConfigEdit, ConfigPort, ConfigWriteAllDocument, ConfigWriteAllOutcome } from '../../../contract/ports.ts';
import { defineConfig } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';
import { captureLog, HOME, manualClock } from '../host-config/support.ts';

/**
 * The testing host's `ConfigPort.writeAll` stays in step with the real writer: the same set rule
 * (`host/config/write-all.ts`) decides both, so a plugin's unit test sees the refusal, the conflict, the held set and
 * its sentence production gives.
 */
const limitsDef = defineConfig({
  file: 'limits.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10) }),
  axis: 'configure',
  loosens: (before, after) => (after.limit > (before?.limit ?? 10) ? ['raises the limit'] : []),
});
const itemsDef = defineConfig({
  collection: 'items',
  name: /^[a-z]{1,10}$/,
  schema: z.strictObject({ budget: z.number().optional(), model: z.string().optional() }),
  axis: 'configure',
  loosens: (before, after) =>
    (after.budget ?? Number.POSITIVE_INFINITY) > (before?.budget ?? Number.POSITIVE_INFINITY)
      ? ['raises or removes the budget']
      : [],
});
const strangerDef = defineConfig({
  file: 'stranger.yaml',
  schema: z.strictObject({}),
  axis: 'configure',
  loosens: () => [],
});

const manifest = definePlugin({
  id: 'runtimes',
  title: 'Runtimes',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [limitsDef, itemsDef] },
});

const START_LIMITS = 'limit: 5\n';
const START_ITEM = 'budget: 5\n';

async function testing(verdict: boolean) {
  let config: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ctx => {
      config = ctx.kernel.config;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half],
    config: { 'limits.yaml': { limit: 5 }, items: { a: { budget: 5 } } },
    gate: { judgeConfigWrite: () => (verdict ? 'apply' : 'hold') } as never,
  });
  if (config === undefined) throw new Error('the half was not built');
  return { config, stop: () => host.stop() };
}

async function real(verdict: boolean) {
  const files = createConfigFiles({
    home: HOME,
    fs: createMemoryHostFs(),
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: limitsDef },
      { plugin: 'runtimes', def: itemsDef },
    ],
    judge: () => verdict,
  });
  await files.reload();
  const port = files.port('runtimes');
  // the same world the testing host starts from, in effect (tightenings from nothing: written)
  expect((await port.write(limitsDef, undefined, START_LIMITS)).kind).toBe('written');
  expect((await port.write(itemsDef, 'a', START_ITEM)).kind).toBe('written');
  return { config: port, stop: async () => undefined };
}

/** What both hosts must agree on: everything but the etags (each host has its own). */
function comparable(outcome: ConfigWriteAllOutcome): unknown {
  if (outcome.kind === 'written')
    return { kind: 'written', documents: outcome.documents.map(({ etag: _etag, ...rest }) => rest) };
  if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason, document: outcome.document };
  return outcome;
}

const CASES: readonly {
  readonly label: string;
  readonly kind: ConfigWriteAllOutcome['kind'];
  readonly verdict: boolean;
  /** Edits written one by one BEFORE the set (a loosening under a `false` verdict is held for the owner). */
  readonly before?: readonly { readonly def: ConfigWriteAllDocument['def']; readonly edit: ConfigEdit }[];
  readonly set: readonly ConfigWriteAllDocument[];
}[] = [
  {
    label: 'a file with an edit already held for the owner refuses the set (already_held), and the held edit stays',
    kind: 'refused',
    verdict: false,
    before: [{ def: limitsDef, edit: 'limit: 50\n' }],
    set: [
      { def: itemsDef, name: 'a', edit: 'budget: 1\n' },
      { def: limitsDef, edit: 'limit: 1\n' },
    ],
  },
  {
    label: 'a tightening set is written whole',
    kind: 'written',
    verdict: false,
    set: [
      { def: limitsDef, edit: { patch: { limit: 3 } } },
      { def: itemsDef, name: 'a', edit: 'budget: 2\n' },
      { def: itemsDef, name: 'b', edit: 'budget: 1\n' },
    ],
  },
  {
    label: 'one held document holds the set, named, with the same sentence',
    kind: 'held',
    verdict: false,
    set: [
      { def: itemsDef, name: 'a', edit: 'budget: 1\n' },
      { def: limitsDef, edit: 'limit: 50\n' },
    ],
  },
  {
    label: 'the judge lets a loosening through: written, the loosening said',
    kind: 'written',
    verdict: true,
    set: [
      { def: limitsDef, edit: 'limit: 50\n' },
      { def: itemsDef, name: 'a', edit: { remove: true } },
    ],
  },
  {
    label: 'a held removal holds the set',
    kind: 'held',
    verdict: false,
    set: [
      { def: limitsDef, edit: 'limit: 1\n' },
      { def: itemsDef, name: 'a', edit: { remove: true } },
    ],
  },
  {
    label: 'an added secret reference holds the set whatever the judge says',
    kind: 'held',
    verdict: true,
    set: [
      { def: limitsDef, edit: 'limit: 1\n' },
      { def: itemsDef, name: 'c', edit: 'model: ${secret:X}\n' },
    ],
  },
  {
    label: 'a schema refusal names its document',
    kind: 'refused',
    verdict: true,
    set: [
      { def: limitsDef, edit: 'limit: 1\n' },
      { def: itemsDef, name: 'a', edit: 'budget: lots\n' },
    ],
  },
  {
    label: 'another plugin’s def is refused not_declared',
    kind: 'refused',
    verdict: true,
    set: [
      { def: limitsDef, edit: 'limit: 1\n' },
      { def: strangerDef, edit: '{}\n' },
    ],
  },
  {
    label: 'a bad name is refused',
    kind: 'refused',
    verdict: true,
    set: [{ def: itemsDef, name: 'NOT OK', edit: 'budget: 1\n' }],
  },
  {
    label: 'the same file twice is refused',
    kind: 'refused',
    verdict: true,
    set: [
      { def: itemsDef, name: 'a', edit: 'budget: 1\n' },
      { def: itemsDef, name: 'a', edit: 'budget: 2\n' },
    ],
  },
  {
    label: 'a stale ifMatch is a conflict naming its document',
    kind: 'conflict',
    verdict: true,
    set: [
      { def: limitsDef, edit: 'limit: 1\n' },
      { def: itemsDef, name: 'a', edit: 'budget: 1\n', ifMatch: 'stale' },
    ],
  },
];

test('parity: the testing host answers every writeAll case as the real writer does, with the same value in effect after', async () => {
  for (const { label, kind, verdict, before = [], set } of CASES) {
    const production = await real(verdict);
    const stand = await testing(verdict);
    for (const { def, edit } of before) {
      const prior = await production.config.write(def, undefined, edit);
      const standIn = await stand.config.write(def, undefined, edit);
      expect({ label, prior: prior.kind }).toEqual({ label, prior: standIn.kind });
      expect({ label, prior: prior.kind }).toEqual({ label, prior: 'held' });
    }
    const realOutcome = await production.config.writeAll(set);
    const testOutcome = await stand.config.writeAll(set);
    expect({ label, kind: realOutcome.kind }).toEqual({ label, kind });
    expect({ label, outcome: comparable(testOutcome) }).toEqual({ label, outcome: comparable(realOutcome) });
    expect({ label, limits: stand.config.file(limitsDef) }).toEqual({
      label,
      limits: production.config.file(limitsDef),
    });
    expect({ label, items: [...stand.config.collection(itemsDef)] }).toEqual({
      label,
      items: [...production.config.collection(itemsDef)],
    });
    await stand.stop();
    await production.stop();
  }
});

test('the testing host tells each written file’s listeners once, and a held set tells nobody', async () => {
  const held = await testing(false);
  let heard = 0;
  held.config.watch(limitsDef, () => (heard += 1));
  expect((await held.config.writeAll([{ def: limitsDef, edit: 'limit: 50\n' }])).kind).toBe('held');
  expect(heard).toBe(0);
  expect((await held.config.writeAll([{ def: limitsDef, edit: 'limit: 1\n' }])).kind).toBe('written');
  expect(heard).toBe(1);
  await held.stop();
});
