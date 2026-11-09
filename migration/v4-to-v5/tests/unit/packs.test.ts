import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  PackInventorySchema,
  PackRunFileSchema,
  PacksFileSchema,
  ReplacedRoutingSchema,
  SwitchesSchema,
} from '@ferretry/plugin-packs/contract';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { STEPS } from '../../src/steps/index.ts';
import { packsStep } from '../../src/steps/packs.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const UUID_WORK = '22222222-2222-4222-8222-222222222222';
const UUID_CHEAP = '33333333-3333-4333-8333-333333333333';
const UUID_GONE = '44444444-4444-4444-8444-444444444444';
const RUN = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const LATER = '2026-11-02T00:00:00.000Z';

const raw = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, path), text, { mode: 0o600 });
};
const ids = () =>
  f.put('fleet/ids.json', {
    version: 1,
    runtimes: {
      'claude-work': { id: UUID_WORK, formerNames: ['claude-old'] },
      'codex-cheap': { id: UUID_CHEAP, formerNames: [] },
    },
  });
const written = async (path: string) => JSON.parse(await readFile(join(f.to, path), 'utf8')) as Record<string, unknown>;
const config = (name: string) => readFile(join(f.to, 'config', name), 'utf8');
const exists = async (path: string) => (await stat(join(f.to, path)).catch(() => undefined)) !== undefined;
const whats = (report: { notCarried: readonly { what: string }[] }) => report.notCarried.map(item => item.what);

test('pack.yaml and models-guide.yaml become one packs.yaml with routing nested, comments kept, v4-only keys listed', async () => {
  await ids();
  await raw(
    'config/pack.yaml',
    [
      '# yaml-language-server: $schema=../.schema/pack.json',
      '# Pack mode on this box',
      'enabled: true',
      'decision: jev # Jev picks',
      'limits:',
      '  autoChildren: 6',
      'routingPreferences: FAKE-OLD-PREFERENCES',
      '',
    ].join('\n'),
  );
  await raw(
    'config/models-guide.yaml',
    [
      '# yaml-language-server: $schema=../.schema/models-guide.json',
      '# the routing prompt',
      'prompt: planning → claude-opus-5-5 at max; chores → claude-haiku-5-5 low; keys as ${secret:FAKE_KEY}',
      'suggested:',
      '  by: claude-opus-5-5',
      '  via: claude-old',
      `  at: "${AT}"`,
      `  acceptedAt: "${LATER}"`,
      '  partial: true',
      'useCases: []',
      '',
    ].join('\n'),
  );
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([
    { what: 'packs.yaml settings (from pack.yaml)', count: 1 },
    { what: 'routing prompt (from models-guide.yaml)', count: 1 },
  ]);
  const text = await readFile(join(f.to, 'config/packs.yaml'), 'utf8');
  expect(text).not.toContain('yaml-language-server');
  expect(text).toContain('# Pack mode on this box');
  expect(text).toContain('# Jev picks');
  expect(text).toContain('# the routing prompt');
  const file: unknown = PacksFileSchema.parse(parse(text));
  expect(file).toEqual({
    enabled: true,
    decision: 'jev',
    limits: { autoChildren: 6 },
    routing: {
      prompt: 'planning → claude-opus-5-5 at max; chores → claude-haiku-5-5 low; keys as ${secret:FAKE_KEY}',
      // A former runtime name is the runtime's current name (M7).
      suggested: { by: 'claude-opus-5-5', via: 'claude-work', at: AT, acceptedAt: LATER },
    },
  });
  expect((await stat(join(f.to, 'config/packs.yaml'))).mode & 0o777).toBe(0o600);
  expect(whats(report)).toEqual(
    expect.arrayContaining([
      'config/pack.yaml routingPreferences',
      'config/models-guide.yaml useCases',
      'config/models-guide.yaml suggested.partial',
    ]),
  );
  expect(JSON.stringify(report)).not.toContain('FAKE-OLD-PREFERENCES');
});

test('only a routing prompt: packs.yaml holds routing alone; a home with neither file writes none', async () => {
  expect((await packsStep.run(f.ctx())).status).toBe('converted');
  expect(await exists('config/packs.yaml')).toBe(false);
  await raw('config/models-guide.yaml', 'prompt: reviews on the strongest model\n');
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(PacksFileSchema.parse(parse(await readFile(join(f.to, 'config/packs.yaml'), 'utf8')))).toEqual({
    routing: { prompt: 'reviews on the strongest model' },
  });
});

test('J-0052 the one-time routing conversion v4 ran at boot is this step: the old guide keys are named and not carried, the prompt a home already has is', async () => {
  // A home v4 had not yet folded: the old use-case guide and the old builder's preferences, and no prompt.
  await raw('config/pack.yaml', ['enabled: true', 'routingPreferences: FAKE-OLD-PREFERENCES', ''].join('\n'));
  await raw(
    'config/models-guide.yaml',
    ['useCases:', '  - FAKE-USE-CASE', 'routing: FAKE-OLD-ROUTING', 'models: [FAKE-MODEL]', ''].join('\n'),
  );
  let report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(whats(report)).toEqual(
    expect.arrayContaining([
      'config/pack.yaml routingPreferences',
      'config/models-guide.yaml useCases, routing, models',
    ]),
  );
  const unfolded = await config('packs.yaml');
  for (const old of ['FAKE-USE-CASE', 'FAKE-OLD-ROUTING', 'FAKE-MODEL', 'FAKE-OLD-PREFERENCES', 'useCases'])
    expect(unfolded).not.toContain(old);
  expect(JSON.stringify(report)).not.toContain('FAKE-');
  expect(PacksFileSchema.parse(parse(unfolded))).toEqual({ enabled: true });
  // A home v4 had already folded holds the one prompt in models-guide.yaml: that prompt is carried, whole.
  await raw('config/models-guide.yaml', 'prompt: the folded routing prompt\n');
  report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(PacksFileSchema.parse(parse(await config('packs.yaml')))).toMatchObject({
    routing: { prompt: 'the folded routing prompt' },
  });
});

test('a raw secret or a key v5 refuses fails the step naming the file and key, never the value', async () => {
  await raw('config/models-guide.yaml', 'prompt: use sk-ant-FAKEFAKEFAKEFAKE1234 for everything\n');
  let report = await packsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('config/models-guide.yaml: the value at prompt looks like a raw secret');
  expect(JSON.stringify(report)).not.toContain('FAKEFAKE');
  await raw('config/models-guide.yaml', 'prompt: fine\n');
  await raw('config/pack.yaml', 'limits:\n  maxDepth: 9\n');
  report = await packsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe(
    'config/pack.yaml + config/models-guide.yaml: v5 refuses it as config/packs.yaml: limits.maxDepth (too_big)',
  );
  expect(await exists('config/packs.yaml')).toBe(false);
  await raw('config/pack.yaml', 'routing: {}\n');
  expect((await packsStep.run(f.ctx())).note).toBe('config/pack.yaml: writes routing, which is not a v4 Pack setting');
});

test('the replaced guide keeps its one undo as the PROMPT the file held; a file with no prompt is a default', async () => {
  await f.put('state/pack-guide-replaced.json', {
    savedAt: AT,
    source: 'file',
    text: '# mine\nprompt: the owner’s old prompt\nsuggested:\n  by: m\n  via: r\n',
  });
  let report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  let document = await written('state/packs/replaced.json');
  expect(Object.keys(document)[0]).toBe('format');
  expect<unknown>(ReplacedRoutingSchema.parse(document)).toEqual({
    format: 1,
    savedAt: AT,
    source: 'file',
    text: 'the owner’s old prompt',
  });
  expect(report.note).toContain('an undo puts back the prompt only');
  for (const text of [null, 'useCases: []\n']) {
    await f.put('state/pack-guide-replaced.json', { savedAt: AT, source: 'default', text });
    report = await packsStep.run(f.ctx());
    document = await written('state/packs/replaced.json');
    expect<unknown>(ReplacedRoutingSchema.parse(document)).toEqual({
      format: 1,
      savedAt: AT,
      source: 'default',
      text: null,
    });
  }
});

test('a replaced guide v4 could not read, or one whose prompt is gone, is not carried and names only the file', async () => {
  await f.put('state/pack-guide-replaced.json', { savedAt: AT, source: 'file', text: 'useCases: []\n' });
  let report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(whats(report)).toContain('state/pack-guide-replaced.json');
  expect(await exists('state/packs/replaced.json')).toBe(false);
  await f.put('state/pack-guide-replaced.json', { savedAt: AT, source: 'file', text: 'FAKE', extra: 1 });
  report = await packsStep.run(f.ctx());
  expect(report.notCarried.find(item => item.what === 'state/pack-guide-replaced.json')?.why).toContain(
    'v4 offered no undo',
  );
  expect(JSON.stringify(report)).not.toContain('FAKE');
});

const inventory = {
  at: AT,
  runtimes: [
    {
      name: 'claude-old',
      harness: 'claude',
      login: 'work',
      ready: true,
      quota: { state: 'unknown', windows: [], summary: 'not measured' },
      models: ['claude-opus-5-5'],
    },
  ],
  models: [
    {
      provider: 'anthropic',
      harness: 'claude',
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      tier: 'best',
      efforts: ['high'],
      runtimes: [{ name: 'claude-old', ready: true }],
    },
  ],
  routing: { text: 'the prompt shown', source: 'default' },
};

test('a clean-up run becomes flat <id>.<file> names: run.json stamped and re-keyed, texts byte for byte', async () => {
  await ids();
  const folder = `state/pack-guide/${RUN}`;
  await f.put(`${folder}/run.json`, {
    job: {
      id: RUN,
      session: 'f9',
      name: 'Clean up',
      runtime: 'claude-old',
      startedAt: AT,
      status: 'suggested',
    },
    suggestion: {
      suggested: { by: 'claude-opus-5-5', via: 'claude-old', at: AT },
      before: 'rough words',
      after: 'clean words',
      notes: [{ kind: 'suggestion', message: 'add a login' }],
    },
  });
  await raw(`${folder}/rough.txt`, 'rough words\n');
  await raw(`${folder}/idea.txt`, '\n');
  await f.put(`${folder}/inventory.json`, inventory);
  await f.put(`${folder}/draft.json`, { prompt: 'FAKE-DRAFT' });
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'clean-up runs', count: 1 });
  const runs = join(f.to, 'state/packs/runs');
  expect((await readdir(runs)).sort()).toEqual(
    [`${RUN}.idea.txt`, `${RUN}.inventory.json`, `${RUN}.rough.txt`, `${RUN}.run.json`].sort(),
  );
  const run = JSON.parse(await readFile(join(runs, `${RUN}.run.json`), 'utf8')) as Record<string, unknown>;
  expect(Object.keys(run)[0]).toBe('format');
  const parsed = PackRunFileSchema.parse(run);
  expect<unknown>(parsed.job).toEqual({
    id: RUN,
    ferret: 'f9',
    name: 'Clean up',
    runtime: 'claude-work',
    startedAt: AT,
    status: 'suggested',
  });
  expect(parsed.suggestion?.suggested.via).toBe('claude-work');
  expect(await readFile(join(runs, `${RUN}.rough.txt`), 'utf8')).toBe('rough words\n');
  expect(await readFile(join(runs, `${RUN}.idea.txt`), 'utf8')).toBe('\n');
  const shown = PackInventorySchema.parse(JSON.parse(await readFile(join(runs, `${RUN}.inventory.json`), 'utf8')));
  expect(shown.runtimes[0]).toMatchObject({ name: 'claude-work', harness: 'claude-code' });
  expect(shown.models[0]).toMatchObject({ harness: 'claude-code', runtimes: [{ name: 'claude-work', ready: true }] });
  expect(whats(report)).toContain('state/pack-guide/*/draft.json (1)');
  expect(JSON.stringify(report)).not.toContain('FAKE-DRAFT');
  expect(JSON.stringify(report)).not.toContain('rough words');
});

test('a run v4 skipped, a run still running and an unreadable inventory are each reported by id', async () => {
  const good = 'aaaaaaaa-1111-4111-8111-111111111111';
  await f.put(`state/pack-guide/${good}/run.json`, {
    job: { id: good, session: 'f1', name: 'Clean up', runtime: 'codex-cheap', startedAt: AT, status: 'running' },
  });
  await f.put(`state/pack-guide/${good}/inventory.json`, { ...inventory, extra: 'FAKE-INVENTORY' });
  await f.put(`state/pack-guide/${RUN}/run.json`, { job: { id: 'other' } });
  await mkdir(join(f.from, 'state/pack-guide/not_a_run'), { recursive: true });
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'clean-up runs', count: 1 });
  expect(whats(report)).toEqual(
    expect.arrayContaining([
      `state/pack-guide/${RUN}`,
      'state/pack-guide/not_a_run',
      `state/pack-guide/${good}/inventory.json`,
    ]),
  );
  expect(report.note).toContain('1 clean-up run(s) were still running in v4');
  expect(await exists(`state/packs/runs/${good}.run.json`)).toBe(true);
  expect(await exists(`state/packs/runs/${good}.inventory.json`)).toBe(false);
  expect(await exists(`state/packs/runs/${RUN}.run.json`)).toBe(false);
  expect(JSON.stringify(report)).not.toContain('FAKE-INVENTORY');
});

test('a link in the runs folder is never followed: the step fails naming the folder', async () => {
  await mkdir(join(f.from, 'state/pack-guide'), { recursive: true });
  await symlink('/nonexistent-fake-target', join(f.from, 'state/pack-guide', RUN));
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/pack-guide: is not a folder of run folders (a link is never followed)');
});

test("each ferret's own switch becomes switches.json, dated by its config's updatedAt; none written means none", async () => {
  await f.session('f1');
  await f.session('f2', { pack: false, updatedAt: LATER });
  await f.session('f3', { pack: true });
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const document = await written('state/packs/switches.json');
  expect(Object.keys(document)[0]).toBe('format');
  expect(SwitchesSchema.parse(document)).toEqual({
    format: 1,
    ferrets: { f2: { enabled: false, at: LATER }, f3: { enabled: true, at: AT } },
  });
  expect(report.kept).toEqual(
    expect.arrayContaining([
      { what: 'ferret Pack switches', count: 2 },
      { what: 'ferrets with Pack mode switched off', count: 1 },
    ]),
  );
  await f.clean();
  f = await fixture();
  await f.session('f1');
  await packsStep.run(f.ctx());
  expect(await exists('state/packs/switches.json')).toBe(false);
});

test('routing.json is not carried: accounts are named by runtime NAME, never by uuid or value', async () => {
  await ids();
  const marker = 'FAKE-REASON-MARKER-7d1e';
  await f.put('config/routing.json', {
    models: [{ id: 'm1' }, { id: 'm2' }],
    accounts: [
      { accountId: UUID_WORK, preferredSpend: true },
      { accountId: UUID_CHEAP, excludedReason: marker },
      { accountId: UUID_GONE, excludedReason: marker },
    ],
    floors: {},
    costPenalty: {},
  });
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(whats(report)).toEqual(
    expect.arrayContaining([
      'config/routing.json (2 model(s), 3 account(s), 1 naming no v4 runtime)',
      'config/routing.json excluded runtimes: codex-cheap',
      'config/routing.json preferred-spend runtimes: claude-work',
    ]),
  );
  const shown = JSON.stringify(report);
  for (const hidden of [marker, UUID_WORK, UUID_CHEAP, UUID_GONE]) expect(shown).not.toContain(hidden);
  await raw('config/routing.json', '{"FAKE-TORN');
  const damaged = await packsStep.run(f.ctx());
  expect(damaged.status).toBe('converted');
  expect(whats(damaged)).toContain('config/routing.json');
  expect(JSON.stringify(damaged)).not.toContain('FAKE-TORN');
});

test("routing.json's excluded runtimes become one line at the end of the routing prompt, only when there is one", async () => {
  await ids();
  const marker = 'FAKE-REASON-MARKER-91ab';
  await f.put('config/routing.json', {
    models: [{ id: 'm1' }],
    accounts: [{ accountId: UUID_CHEAP, excludedReason: marker }],
  });
  await raw('config/models-guide.yaml', '# my guide\nprompt: reviews on the strongest model\n');
  const report = await packsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const text = await config('packs.yaml');
  expect(text).toContain('# my guide');
  expect(PacksFileSchema.parse(parse(text)).routing?.prompt).toBe(
    "reviews on the strongest model\n\nNever start a helper on these runtimes (v4's routing catalog excluded them): codex-cheap.",
  );
  expect(text).not.toContain(marker);
  expect(report.kept).toContainEqual({
    what: "routing prompt line naming the runtimes v4's routing.json excluded",
    count: 1,
  });
  expect(report.notCarried.find(item => item.what.endsWith('excluded runtimes: codex-cheap'))?.why).toContain(
    'one line naming them was added',
  );

  // No prompt of its own: v5 renders one, so nothing is added and the report says what to do instead.
  await f.clean();
  f = await fixture();
  await ids();
  await f.put('config/routing.json', {
    models: [{ id: 'm1' }],
    accounts: [{ accountId: UUID_CHEAP, excludedReason: marker }],
  });
  await raw('config/pack.yaml', 'enabled: false\n');
  const bare = await packsStep.run(f.ctx());
  expect(PacksFileSchema.parse(parse(await config('packs.yaml'))).routing?.prompt).toBeUndefined();
  expect(bare.kept.map(item => item.what)).not.toContain(
    "routing prompt line naming the runtimes v4's routing.json excluded",
  );
  expect(bare.notCarried.find(item => item.what.endsWith('excluded runtimes: codex-cheap'))?.why).toContain(
    'no routing prompt of its own',
  );
});

test("Jev's spend ledger and the routing-migration backups are named, never opened", async () => {
  await f.put('state/pack-jev-spend.json', { day: '2026-11-01', usd: 0.1 });
  await f.put('state/pack-routing-migration-2026-10-01T00-00-00-000Z.json', { guide: 'FAKE' });
  const report = await packsStep.run(f.ctx());
  expect(whats(report)).toEqual(
    expect.arrayContaining(['state/pack-jev-spend.json', 'state/pack-routing-migration-*.json (1)']),
  );
});

test('the Packs step owns pack.yaml, models-guide.yaml and routing.json: Settings and Daemon settings no longer wait', async () => {
  await raw('config/pack.yaml', 'enabled: false\n');
  await raw('config/models-guide.yaml', 'prompt: anything\n');
  await f.put('config/routing.json', { models: [{ id: 'm1' }] });
  await f.put('config/daemon.json', {});
  const settings = await settingsStep.run(f.ctx(true));
  expect(settings.status).toBe('converted');
  const daemon = await daemonSettingsStep.run(f.ctx(true));
  expect(daemon.status).toBe('converted');
  expect(daemon.note ?? '').not.toContain('routing');
  expect(STEPS.map(step => step.id).indexOf('packs')).toBeGreaterThan(
    STEPS.map(step => step.id).indexOf('daemon-settings'),
  );
  const dry = await packsStep.run(f.ctx(true));
  expect(dry.status).toBe('converted');
  expect(dry.note).toBe('dry run: nothing written');
  expect(await exists('config/packs.yaml')).toBe(false);
});
