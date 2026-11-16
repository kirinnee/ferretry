import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PausesFileSchema, PauseToldFileSchema, PricingFileSchema } from '@ferretry/plugin-usage/contract';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { usageStep, V5_USAGE_PAUSE_TOLD, V5_USAGE_PAUSES, V5_USAGE_PRICING } from '../../src/steps/usage.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  // A passive reading is made unreadable by one test; give it back so the folder can be removed.
  await chmod(join(f.from, 'fleet/credentials/claude-a/usage.json'), 0o600).catch(() => undefined);
  await f.clean();
});

const RESET = Date.parse('2026-11-02T00:00:00.000Z');
const hold = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  period: 'daily',
  level: 'over_hard',
  limitUsd: 20,
  resetsAtMs: RESET,
  timeZone: 'Europe/London',
  ...extra,
});

/** The document as written: `format` first, then the body v5's schema reads once the kernel strips it. */
async function stamped(path: string): Promise<{ keys: string[]; body: Record<string, unknown> }> {
  const value = JSON.parse(await readFile(join(f.to, path), 'utf8')) as Record<string, unknown>;
  const { format, ...body } = value;
  expect(format).toBe(1);
  return { keys: Object.keys(value), body };
}

const CANONICAL = {
  pricingKey: 'fake-model-1',
  modelId: 'fake-model-1',
  aliases: [],
  provider: 'anthropic',
  currency: 'USD',
  rates: {
    input: 3_000_000,
    output: 15_000_000,
    cachedInput: 300_000,
    cacheWrite: null,
    cacheWrite5m: 3_750_000,
    cacheWrite1h: 6_000_000,
    reasoning: null,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  validFrom: AT,
  validThrough: null,
  verifiedAt: AT,
  lastSyncedAt: null,
};
const LEGACY = {
  pricingKey: 'fake-model-2',
  modelId: 'fake-model-2',
  provider: 'openai',
  ratesUsdMicrosPerMillion: { input: 1_250_000, cachedRead: 125_000, output: 10_000_000 },
  verifiedAt: '2026-07-01',
  validFrom: '2026-07-01',
};
const SOURCE = { id: 'fake-feed', provider: 'anthropic' as const, url: 'https://prices.example.com/feed.json' };

test('budget holds become pauses and told keys carry unchanged, each stamped with format 1', async () => {
  await f.put('state/budget-holds.json', {
    'claude-a': hold(),
    'codex-b': hold({ period: 'weekly', level: 'over_trigger', limitUsd: 100 }),
  });
  const told = ['claude-a|daily|2026-11-01T00:00:00.000Z', 'codex-b|weekly|2026-10-26T00:00:00.000Z'];
  await f.put('state/budget-told.json', told);
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'budget pauses', count: 2 });
  expect(report.kept).toContainEqual({ what: 'budget notices already told', count: 2 });

  const pauses = await stamped(V5_USAGE_PAUSES);
  expect(pauses.keys[0]).toBe('format');
  expect(PausesFileSchema.parse(pauses.body)).toEqual({
    pauses: {
      'claude-a': hold(),
      'codex-b': hold({ period: 'weekly', level: 'over_trigger', limitUsd: 100 }),
    },
  } as never);
  const toldFile = await stamped(V5_USAGE_PAUSE_TOLD);
  expect(toldFile.keys[0]).toBe('format');
  expect(PauseToldFileSchema.parse(toldFile.body)).toEqual({ told });
  expect((await stat(join(f.to, V5_USAGE_PAUSES))).mode & 0o777).toBe(0o600);
});

test('a hold v5 refuses is dropped and counted; the rest are kept', async () => {
  await f.put('state/budget-holds.json', { 'claude-a': hold(), 'codex-b': hold({ resetsAtMs: -1 }) });
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toContain('1 budget hold(s) v5 refuses dropped');
  expect(Object.keys(PausesFileSchema.parse((await stamped(V5_USAGE_PAUSES)).body).pauses)).toEqual(['claude-a']);
});

test('garbled holds and told files are carried as none, as v4 read them, never quoted', async () => {
  await mkdir(join(f.from, 'state'), { recursive: true });
  await writeFile(join(f.from, 'state/budget-holds.json'), '{"FAKE-GARBLED');
  await f.put('state/budget-told.json', { not: 'a list' });
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toContain('state/budget-holds.json is garbled');
  expect(report.note).toContain('state/budget-told.json is garbled');
  expect(JSON.stringify(report)).not.toContain('FAKE-GARBLED');
  expect(PausesFileSchema.parse((await stamped(V5_USAGE_PAUSES)).body)).toEqual({ pauses: {} });
  expect(PauseToldFileSchema.parse((await stamped(V5_USAGE_PAUSE_TOLD)).body)).toEqual({ told: [] });
});

test('the rate catalog and feeds move out of daemon.json; an older-spelling row is converted as v4 converted it', async () => {
  await f.put('config/daemon.json', {
    port: 4100,
    analyticsPricing: [CANONICAL, LEGACY],
    analyticsPricingSources: [SOURCE],
  });
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'priced model rates', count: 2 });
  expect(report.kept).toContainEqual({ what: 'pricing feeds', count: 1 });
  const pricing = PricingFileSchema.parse((await stamped(V5_USAGE_PRICING)).body);
  expect(pricing.catalog[0]).toEqual(CANONICAL as never);
  expect(pricing.catalog[1]).toEqual({
    pricingKey: 'fake-model-2',
    modelId: 'fake-model-2',
    aliases: [],
    provider: 'openai',
    currency: 'USD',
    rates: {
      input: 1_250_000,
      output: 10_000_000,
      cachedInput: 125_000,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
      image: null,
      tool: null,
    },
    source: { kind: 'manual' },
    validFrom: '2026-07-01T00:00:00.000Z',
    validThrough: null,
    verifiedAt: '2026-07-01T00:00:00.000Z',
    lastSyncedAt: null,
  });
  expect(pricing.sources).toEqual([{ ...SOURCE, enabled: true, lastSyncedAt: null }]);
  expect(JSON.stringify(pricing)).not.toContain('4100');
});

test('a daemon.json without pricing writes no pricing.json (v5 starts from its own empty default)', async () => {
  await f.put('config/daemon.json', { port: 4100 });
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'priced model rates', count: 0 });
  expect(await stat(join(f.to, V5_USAGE_PRICING)).catch(() => undefined)).toBeUndefined();
});

test('a catalog v5 refuses fails the step naming the row, never its content', async () => {
  await f.put('config/daemon.json', {
    analyticsPricing: [CANONICAL, { ...CANONICAL, modelId: 'FAKE-DUPLICATE-KEY' }],
  });
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('config/daemon.json: pricing catalog entry 1 does not fit the v5 rate catalog');
  expect(JSON.stringify(report)).not.toContain('FAKE-DUPLICATE-KEY');
  expect(await stat(join(f.to, V5_USAGE_PRICING)).catch(() => undefined)).toBeUndefined();
});

test('passive readings in sign-in folders are counted with lstat only, never opened or written', async () => {
  const reading = join(f.from, 'fleet/credentials/claude-a/usage.json');
  await mkdir(join(reading, '..'), { recursive: true });
  await writeFile(reading, '{"FAKE-PASSIVE-READING":1}');
  // Unreadable: opening it would throw, so a converted step proves it was never opened.
  await chmod(reading, 0o000);
  const report = await usageStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toBe('1 passive usage reading(s) not carried (read again on the next turn)');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('a home with no usage files converts to nothing; a dry run writes nothing', async () => {
  expect((await usageStep.run(f.ctx())).status).toBe('converted');
  await f.put('state/budget-holds.json', { 'claude-a': hold() });
  await f.put('config/daemon.json', { analyticsPricing: [CANONICAL] });
  const report = await usageStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toStartWith('dry run: nothing written');
  expect(report.kept).toContainEqual({ what: 'budget pauses', count: 1 });
  expect(await readdir(f.to).catch(() => [])).toEqual([]);
});
